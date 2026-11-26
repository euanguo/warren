import { createHash } from 'node:crypto';
import type {
  ApprovalMode,
  Creator,
  Environment,
  EnvironmentConfig,
  EventRecord,
  LeaseDenialReason,
} from '../../shared/types';

/** 和 GROUP_NAME_MAX 一致。名字会进侧栏 DOM 和 CLI 输出，不封顶会撑破布局。 */
export const ENVIRONMENT_NAME_MAX = 40;

/**
 * 环境 id 会进 `sessions/<id>`、`warren-downloads/<id>` 这些路径。
 * 只允许小写字母/数字开头，后接小写字母/数字/`.`/`_`/`-`；`..` 和绝对路径一律拒绝。
 */
const ENVIRONMENT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function isEnvironmentId(id: string): boolean {
  return ENVIRONMENT_ID_RE.test(id) && id !== '.' && id !== '..';
}

export function assertEnvironmentId(id: string): void {
  if (isEnvironmentId(id)) return;
  throw Object.assign(new Error(`invalid environment id: ${JSON.stringify(id)}`), { code: 'BAD_REQUEST' });
}

/**
 * 路径用的安全 key：正常 id 原样保留；历史坏 id 哈希成固定长度 key，
 * 让旧库里的脏数据也走不到 `..`。新增 id 由 `Store.create` 的校验挡在前面。
 */
export function safeEnvKey(id: string): string {
  return isEnvironmentId(id) ? id : createHash('sha256').update(id).digest('hex');
}

/**
 * 截断而不是报错。
 *
 * 环境创建是 CLI 脚本驱动的（`warren env create`），一个超长名字不该中断整批脚本；
 * 分组名可以报错是因为它只从 UI 来。超长部分用省略号收尾，让用户看得出被截了。
 */
export function clampEnvironmentName(name: string): string {
  const trimmed = name.trim() || '未命名';
  if (trimmed.length <= ENVIRONMENT_NAME_MAX) return trimmed;
  return `${trimmed.slice(0, ENVIRONMENT_NAME_MAX - 1)}…`;
}

export function createEnvironmentConfig(input: {
  id: string;
  name?: string;
  storagePath: string;
  proxy?: string;
  trustedCa?: string;
  createdBy?: Creator;
  approval?: ApprovalMode;
  startUrl?: string;
  headed?: boolean;
  groupId?: string;
  order?: number;
  now?: string;
}): EnvironmentConfig {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    name: clampEnvironmentName(input.name ?? input.id),
    storagePath: input.storagePath,
    proxy: input.proxy,
    trustedCa: input.trustedCa,
    // 老库里没有这一列：读回来是 null，一律当人建的（更保守的那一侧）
    createdBy: input.createdBy ?? 'human',
    approval: input.approval,
    startUrl: input.startUrl,
    headed: input.headed ?? true,
    groupId: input.groupId,
    order: input.order ?? 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 环境配置的可改字段。
 *
 * `proxy` / `trustedCa` 收 `null` 作为「**清掉**这个字段」的显式信号 ——
 * `undefined` 一律表示「这次不改它」。没有这个区分，解绑代理就没法表达
 * （`{...config, ...patch}` 里 `undefined` 会把旧值原样留下）。
 */
export interface EnvironmentPatch {
  name?: string;
  proxy?: string | null;
  trustedCa?: string | null;
  /** `null` = 恢复「跟随全局」。**只有界面能带这个字段**（见计划 §3.4）。 */
  approval?: ApprovalMode | null;
  startUrl?: string;
  headed?: boolean;
}

export function toEnvironment(config: EnvironmentConfig, patch: Partial<Environment> = {}): Environment {
  return {
    ...config,
    status: 'stopped',
    owner: 'none',
    activeSpaceId: 'person',
    spaces: [],
    ...patch,
  };
}

export function canMutate(environment: Environment, actor: 'agent' | 'human', leaseId?: string): boolean {
  return environment.owner === actor && Boolean(leaseId) && environment.leaseId === leaseId;
}

/**
 * `ENV_NOT_LEASED` / `CONTROL_REVOKED` 到底是什么意思。
 *
 * 这两个码以前同时盖住五种情况（没租过 / 过期 / 被新 lease 顶掉 / 被人接管 / space 不对），
 * agent 只能靠猜，还经常猜成「Warren 有 bug」。**错误码保持不变**（老调用方在用），
 * 只额外带一个 `reason`，让 CLI 能直接说「下一步敲什么」。reason 的联合类型在 shared（RPC 边界）。
 */
export interface LeaseDenial {
  code: 'ENV_NOT_LEASED' | 'CONTROL_REVOKED';
  reason: LeaseDenialReason;
  /** 只有 `expired` 带：过期时刻（epoch ms）。 */
  expiredAt?: number;
  /** 已含「下一步敲哪条命令」，CLI 原样打给 agent。 */
  message: string;
}

/** 判定 lease 为什么不能用。`undefined` = 可以用。 */
export function diagnoseLease(input: {
  environmentId: string;
  lease?: { leaseId?: string; owner?: 'agent' | 'human' | 'none'; space?: 'agent' | 'person'; expiresAt?: number };
  providedLeaseId?: string;
  space: 'agent' | 'person';
  now?: number;
}): LeaseDenial | undefined {
  const now = input.now ?? Date.now();
  const id = input.environmentId;
  const lease = input.lease;
  const acquireHint = `重新取控制权：warren env acquire ${id}`;
  if (!lease || !lease.leaseId) {
    return {
      code: 'ENV_NOT_LEASED',
      reason: 'never_leased',
      message: `${id} 还没有 lease（没取过控制权）；${acquireHint}`,
    };
  }
  if (lease.expiresAt !== undefined && lease.expiresAt <= now) {
    return {
      code: 'ENV_NOT_LEASED',
      reason: 'expired',
      expiredAt: lease.expiresAt,
      message:
        `${id} 的 lease 已于 ${new Date(lease.expiresAt).toISOString()} 过期` +
        `（现在 ${new Date(now).toISOString()}）；${acquireHint}`,
    };
  }
  if (!input.providedLeaseId || lease.leaseId !== input.providedLeaseId) {
    const reason = revokedReason(lease.owner);
    return {
      code: 'CONTROL_REVOKED',
      reason,
      message:
        reason === 'user_takeover'
          ? `${id} 的控制权已被人工接管（当前 owner=human）；等用户交还后${acquireHint}`
          : `${id} 的 lease 已被新的 lease 取代（当前 lease=${String(lease.leaseId).slice(-8)}）；${acquireHint}`,
    };
  }
  if (lease.space !== undefined && lease.space !== input.space) {
    return {
      code: 'CONTROL_REVOKED',
      reason: 'wrong_space',
      message: `lease 属于 ${lease.space} space，不是 ${input.space}；Person Space 不需要 lease，只有 Agent Space 的写操作要`,
    };
  }
  return undefined;
}

/** 把诊断结果变成带 `code` / `reason` / `expiredAt` 的 Error（RPC 会原样转发这三个字段）。 */
export function leaseDenialError(denial: LeaseDenial): Error & {
  code: string;
  reason: LeaseDenialReason;
  expiredAt?: number;
} {
  return Object.assign(new Error(denial.message), {
    code: denial.code,
    reason: denial.reason,
    ...(denial.expiredAt === undefined ? {} : { expiredAt: denial.expiredAt }),
  });
}

export function acquireLease(
  environment: Environment,
  actor: 'agent' | 'human',
  leaseId: string,
  ttlMs: number,
  now = Date.now(),
): Environment {
  if (environment.owner !== 'none' && environment.leaseExpiresAt && environment.leaseExpiresAt > now) {
    throw Object.assign(new Error(`ENV_BUSY: environment ${environment.id} is controlled by ${environment.owner}`), {
      code: 'ENV_BUSY',
    });
  }
  return {
    ...environment,
    owner: actor,
    leaseId,
    leaseExpiresAt: now + ttlMs,
    updatedAt: new Date(now).toISOString(),
  };
}

export function releaseLease(environment: Environment, leaseId: string, now = Date.now()): Environment {
  if (environment.leaseId !== leaseId) {
    throw Object.assign(new Error('CONTROL_REVOKED'), {
      code: 'CONTROL_REVOKED',
      reason: environment.leaseId ? revokedReason(environment.owner) : 'never_leased',
    });
  }
  return {
    ...environment,
    owner: 'none',
    leaseId: undefined,
    leaseExpiresAt: undefined,
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * 租约「被谁收回」的原因。判定只看 owner，不看时间：
 * `human` = 人点了接管（agent 该等），`agent` = 另一个 agent 重新 acquire 过（旧的被顶掉）。
 */
export function revokedReason(owner?: 'agent' | 'human' | 'none'): LeaseDenialReason {
  if (owner === 'human') return 'user_takeover';
  if (owner === 'agent') return 'superseded';
  return 'never_leased';
}

/**
 * 续租：只把到期时间往后推，**leaseId 和 owner 都不动**。
 *
 * 存在的理由：CLI 一次 `exec` 可能跑很久，而 TTL 只有 60s。没有续租通道的话，
 * 长脚本从第 60 秒起每个写操作都会报 ENV_NOT_LEASED，而 acquire 又会报 ENV_BUSY。
 */
export function renewLease<T extends { leaseId?: string; leaseExpiresAt?: number; updatedAt?: string }>(
  environment: T,
  leaseId: string,
  ttlMs: number,
  now = Date.now(),
): T {
  if (!environment.leaseId || environment.leaseId !== leaseId) {
    throw Object.assign(new Error('CONTROL_REVOKED'), {
      code: 'CONTROL_REVOKED',
      reason: environment.leaseId
        ? revokedReason((environment as { owner?: 'agent' | 'human' }).owner)
        : 'never_leased',
    });
  }
  if (!environment.leaseExpiresAt || environment.leaseExpiresAt <= now) {
    throw Object.assign(new Error('ENV_NOT_LEASED'), {
      code: 'ENV_NOT_LEASED',
      reason: 'expired',
      ...(environment.leaseExpiresAt === undefined ? {} : { expiredAt: environment.leaseExpiresAt }),
    });
  }
  return { ...environment, leaseExpiresAt: now + ttlMs, updatedAt: new Date(now).toISOString() };
}

export function makeEvent(
  type: string,
  message: string,
  actor: EventRecord['actor'] = 'system',
  environmentId?: string,
): EventRecord {
  return {
    id: crypto.randomUUID(),
    environmentId,
    type,
    actor,
    message,
    createdAt: new Date().toISOString(),
  };
}

/** 一个**已经在跑**的环境在 LRU 眼里的样子。 */
export interface EvictionCandidate {
  id: string;
  /** 最后一次被用到（选中 / 取租约 / agent 操作）。从没用过是 0。 */
  lastActiveAt: number;
  /** 此刻正显示在右侧区域。 */
  selected: boolean;
  /** 有人持着未过期的租约（agent 或人）。 */
  leased: boolean;
}

/**
 * 挑出该被 LRU 回收的环境，让「即将启动一个」之后仍然不超过 `limit`。
 *
 * 两条硬排除：**当前选中的**（屏幕上正显示它的页面）和**还持着租约的**（有人正在用）。
 * 回收一个正在被 agent 操作的环境会直接打断它那一轮，比内存吃紧严重得多。
 * 可回收的挑不够就超限——宁可多开一个，也不动正在用的。
 */
export function pickEvictions(candidates: EvictionCandidate[], limit: number): string[] {
  if (limit <= 0) return [];
  // +1：即将启动的那个
  const over = candidates.length + 1 - limit;
  if (over <= 0) return [];
  return candidates
    .filter((candidate) => !candidate.selected && !candidate.leased)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    .slice(0, over)
    .map((candidate) => candidate.id);
}

/** 一个**已经在跑**的环境在闲置休眠眼里的样子。 */
export interface DormantCandidate {
  id: string;
  /** 最后一次被用到（选中 / 取租约 / agent 操作）。从没用过是 0。 */
  lastActiveAt: number;
  /** 此刻正显示在右侧区域。 */
  selected: boolean;
  /** 有人持着未过期的租约（agent 或人）。 */
  leased: boolean;
  /** 页面正在加载、有声音、或正在录制 / 回放网络。 */
  busy: boolean;
}

/**
 * 挑出该进入休眠的环境。
 *
 * 和 `pickEvictions` 一样有两条硬排除（选中的 / 持租约的），再加一条 `busy`：
 * 正在加载、播声音、录 HAR 或回放的环境休眠会直接打断那一轮。
 * 只挑 `lastActiveAt` 已经超过 `idleMs` 的；`idleMs <= 0` 表示关掉自动休眠。
 */
export function pickDormant(candidates: DormantCandidate[], now: number, idleMs: number): string[] {
  if (idleMs <= 0) return [];
  return candidates
    .filter(
      (candidate) =>
        !candidate.selected && !candidate.leased && !candidate.busy && now - candidate.lastActiveAt >= idleMs,
    )
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    .map((candidate) => candidate.id);
}
