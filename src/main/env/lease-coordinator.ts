import { controlModeFor } from '../domain/approval.ts';
import { diagnoseLease, leaseDenialError, renewLease, revokedReason } from '../domain/environment.ts';
import type { InputShield } from '../input-shield.ts';
import type { TabManager } from '../tabs.ts';
import type {
  ControlOwner,
  ControlPolicy,
  Environment,
  EnvironmentConfig,
  PluginBusEventType,
  SpaceId,
  TabRef,
  ViewportRect,
} from '../../shared/types.ts';

const DEFAULT_LEASE_TTL_MS = 60_000;
const MAX_LEASE_TTL_MS = 10 * 60_000;

/**
 * Lease TTL 可由 `WARREN_LEASE_TTL_MS` 调整（30s..10m）。
 * 长脚本仍应以 `env renew` / CLI 续租器为主；这个开关只是给不同环境调参。
 */
export function leaseTtlMs(): number {
  const raw = Number(process.env.WARREN_LEASE_TTL_MS);
  if (!Number.isFinite(raw) || raw < 30_000) return DEFAULT_LEASE_TTL_MS;
  return Math.min(Math.floor(raw), MAX_LEASE_TTL_MS);
}

export interface LeaseHandle {
  environmentId: string;
  space: SpaceId;
  owner: ControlOwner;
  label?: string;
  leaseId: string;
  expiresAt: number;
}

export type TabManagerLike = Pick<
  TabManager,
  'showing' | 'viewVisible' | 'activeId' | 'attachBelow' | 'detachBelow' | 'resolveRef' | 'controller' | 'active'
>;

export type ShieldLike = Pick<InputShield, 'attached' | 'setCallerLabel' | 'setVisible' | 'setBounds' | 'destroy'>;

export interface LeaseCoordinatorDeps {
  getEnvironment: (id: string) => Environment | undefined;
  getConfig: (id: string) => EnvironmentConfig | undefined;
  getControlPolicy: () => ControlPolicy;
  getSpaceManager: (id: string, space?: SpaceId) => TabManagerLike | undefined;
  getSelectedId: () => string | undefined;
  getActiveSpace: (id: string) => SpaceId;
  getViewVisible: () => boolean;
  getPageBounds: () => ViewportRect;
  getViewportSize: () => { width: number; height: number };
  selectSpaceView: (id: string, space: SpaceId) => void;
  restoreDisplayedFocus: (selected: TabManagerLike | undefined) => void;
  touch: (id: string) => void;
  recordEvent: (type: string, message: string, actor: 'system' | 'agent' | 'human', envId?: string) => void;
  onChange: () => void;
  emitBusEvent: (type: PluginBusEventType, environmentId: string, payload: Record<string, unknown>) => void;
  createShield: (id: string, onTakeover: () => void) => ShieldLike;
  attachAndRaiseShield: (shield: ShieldLike, bounds: ViewportRect) => void;
  detachShield: (shield: ShieldLike) => void;
  leaseTtlMs?: () => number;
  now?: () => number;
}

/**
 * 控制权租约与输入就绪协作者：
 * 负责 `acquire` / `release` / `takeover` / `renew` / `assertWritable` /
 * `assertInputOnScreen` / `ensureOperable` / `detachOperable` /
 * `prepareBackgroundInput` / `clearBackgroundInput` 与 `InputShield` 同步。
 *
 * 对 Electron 只使用 `import type`，可在 `node --test` 中无 Electron 依赖地完整单测。
 */
export class LeaseCoordinator {
  #deps: LeaseCoordinatorDeps;
  #leases = new Map<string, LeaseHandle>();
  #shields = new Map<string, ShieldLike>();

  constructor(deps: LeaseCoordinatorDeps) {
    this.#deps = deps;
  }

  rawLease(id: string): LeaseHandle | undefined {
    return this.#leases.get(id);
  }

  /** 读取未过期租约；若已过期顺带清理并返回 undefined（供状态装饰用）。 */
  pruneAndGetLiveLease(id: string): LeaseHandle | undefined {
    const lease = this.#leases.get(id);
    if (!lease) return undefined;
    if (lease.expiresAt <= this.#now()) {
      this.#leases.delete(id);
      return undefined;
    }
    return lease;
  }

  hasLiveLease(id: string): boolean {
    const lease = this.#leases.get(id);
    return Boolean(lease && lease.expiresAt > this.#now());
  }

  hasActiveAgentLease(): boolean {
    const now = this.#now();
    return [...this.#leases.values()].some(
      (lease) => lease.space === 'agent' && lease.owner === 'agent' && lease.expiresAt > now,
    );
  }

  spaceOwner(id: string, space: SpaceId): ControlOwner {
    if (space === 'person') return 'human';
    const lease = this.#leases.get(id);
    return lease && lease.expiresAt > this.#now() && lease.space === 'agent' ? lease.owner : 'none';
  }

  canHumanNavigate(id: string, space: SpaceId): boolean {
    if (space === 'person') return true;
    const lease = this.#leases.get(id);
    return Boolean(lease && lease.space === 'agent' && lease.owner === 'human' && lease.expiresAt > this.#now());
  }

  isAgentControlling(id: string): boolean {
    const lease = this.#leases.get(id);
    return Boolean(lease && lease.space === 'agent' && lease.owner === 'agent' && lease.expiresAt > this.#now());
  }

  assertHumanAgentWritable(id: string): void {
    const lease = this.#leases.get(id);
    if (!lease || lease.expiresAt <= this.#now() || lease.space !== 'agent') {
      throw Object.assign(new Error(`Agent Space ${id} is not leased`), { code: 'ENV_NOT_LEASED' });
    }
    if (lease.owner !== 'human') {
      throw Object.assign(new Error(`Agent Space ${id} is controlled by ${lease.owner}`), { code: 'ENV_BUSY' });
    }
  }

  shieldAttached(id: string): boolean {
    return Boolean(this.#shields.get(id)?.attached);
  }

  repositionShield(id: string, bounds: ViewportRect): void {
    const shield = this.#shields.get(id);
    if (shield?.attached) shield.setBounds(bounds);
  }

  setShieldVisible(id: string, visible: boolean): void {
    this.#shields.get(id)?.setVisible(visible);
  }

  detachShieldOnly(id: string): void {
    const shield = this.#shields.get(id);
    if (shield) this.#deps.detachShield(shield);
  }

  clearEnv(id: string): void {
    this.#leases.delete(id);
    const shield = this.#shields.get(id);
    if (shield) {
      this.#deps.detachShield(shield);
      shield.destroy();
      this.#shields.delete(id);
    }
  }

  /**
   * 遮罩只跟 lease 走：agent 持有写权限时盖上，人接管/释放时撤掉。
   * 遮罩是原生 View，必须在环境视图之后 addChildView 才能盖在它上面。
   */
  syncShield(id: string, options: { createIfMissing?: boolean } = {}): void {
    let shield = this.#shields.get(id);
    if (!shield && options.createIfMissing) {
      shield = this.#deps.createShield(id, () => {
        try {
          this.takeover(id, 'human', 'agent');
        } catch {
          // ignore
        }
      });
      this.#shields.set(id, shield);
    }
    if (!shield) return;
    const lease = this.#leases.get(id);
    // 遮罩只盖**正在显示的那个**环境：agent 持着别的环境的 lease 时，
    // 不该把当前显示的页面盖住（人看到的是「AI 在操作」，但 AI 在别处）。
    const humanOwnsAgent = Boolean(
      lease && lease.space === 'agent' && lease.owner === 'human' && lease.expiresAt > this.#now(),
    );
    const active = this.#deps.getSelectedId() === id && this.#deps.getActiveSpace(id) === 'agent' && !humanOwnsAgent;
    if (active) {
      const caller = lease && lease.space === 'agent' && lease.owner === 'agent' ? lease.label : undefined;
      shield.setCallerLabel(caller);
      shield.setVisible(this.#deps.getViewVisible());
      this.#deps.attachAndRaiseShield(shield, this.#deps.getPageBounds());
    } else {
      this.#deps.detachShield(shield);
    }
  }

  acquire(id: string, owner: 'agent' | 'human', label?: string, space: SpaceId = 'agent'): LeaseHandle {
    const env = this.#deps.getEnvironment(id);
    if (!env) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    if (space !== 'agent') {
      throw Object.assign(new Error('Person Space 不需要 lease'), { code: 'BAD_REQUEST' });
    }
    this.#deps.touch(id);
    const now = this.#now();
    const ttl = this.#ttl();
    const current = this.#leases.get(id);
    if (current && current.expiresAt > now) {
      // 同一 owner 再来一次 = 续租（CLI 的长脚本靠这条续命），leaseId 不变。
      // 换了 owner（人正在用 / 别的 agent 持着）仍然是 ENV_BUSY。
      if (current.owner === owner) {
        // 传的是 Environment（字段叫 leaseExpiresAt），不是 LeaseHandle（字段叫 expiresAt）——
        // 传错了 renewLease 会直接抛 ENV_NOT_LEASED，续租就只剩 catch 兜底在生效。
        current.expiresAt = renewLease(env, current.leaseId, ttl, now).leaseExpiresAt ?? now + ttl;
        if (label) current.label = label;
        this.syncShield(id);
        this.#deps.onChange();
        return current;
      }
      /*
       * 换了 owner：默认仍然 ENV_BUSY（人点过接管，agent 就该等）。
       *
       * 但审批策略放行时，**agent** 可以直接从人手里接管 —— 这是「AI 自主性」那一档，
       * 默认关。只放行 agent 这一个方向：人抢 agent 是 `takeover()` 的特权，不走这里。
       * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3。
       */
      if (owner !== 'agent' || this.#controlMode(id) !== 'auto') {
        throw Object.assign(new Error(`environment ${id} is controlled by ${current.owner}`), {
          code: 'ENV_BUSY',
        });
      }
      this.#deps.recordEvent('control.autoTakeover', `agent 按审批策略从 ${current.owner} 接管 ${id}`, 'agent', id);
    }
    const lease: LeaseHandle = {
      environmentId: id,
      space,
      owner,
      label,
      leaseId: crypto.randomUUID(),
      expiresAt: now + ttl,
    };
    this.#leases.set(id, lease);
    this.#deps.recordEvent('control.acquired', `${owner} acquired ${id}${label ? ` (${label})` : ''}`, owner, id);
    this.#deps.emitBusEvent('lease.changed', id, {
      owner,
      space,
      leaseId: lease.leaseId,
      ...(label ? { label } : {}),
    });
    this.syncShield(id);
    this.#deps.onChange();
    return lease;
  }

  release(id: string, leaseId: string, actor: 'agent' | 'human' = 'agent'): void {
    const current = this.#leases.get(id);
    if (!current) return;
    if (current.leaseId !== leaseId) {
      // 释放不看过期（过期租约也要能清掉），只说清「为什么这个 leaseId 不是一个 lease」
      throw Object.assign(new Error('CONTROL_REVOKED'), {
        code: 'CONTROL_REVOKED',
        reason: revokedReason(current.owner),
      });
    }
    this.#leases.delete(id);
    this.#deps.recordEvent('control.released', `${actor} released ${id}`, actor, id);
    this.#deps.emitBusEvent('lease.changed', id, {
      owner: 'none',
      space: current.space,
    });
    this.syncShield(id);
    if (actor === 'human' && this.#deps.getSelectedId() === id && this.#deps.getActiveSpace(id) === 'agent') {
      this.#deps.selectSpaceView(id, 'person');
    }
    this.#deps.onChange();
  }

  takeover(id: string, label = 'human', space: SpaceId = 'agent'): LeaseHandle {
    if (space !== 'agent') {
      throw Object.assign(new Error('只有 Agent Space 需要接管'), { code: 'BAD_REQUEST' });
    }
    const current = this.#leases.get(id);
    if (current) {
      this.#leases.delete(id);
      this.#deps.recordEvent('control.takeover', `human took over ${id} from ${current.owner}`, 'human', id);
      // 立刻撤掉遮罩，别让人接管完还得再点一次
      this.syncShield(id);
    }
    const lease = this.acquire(id, 'human', label, space);
    if (this.#deps.getSelectedId() === id) this.#deps.selectSpaceView(id, space);
    return lease;
  }

  /** 显式续租：只推到期时间，leaseId 不变。 */
  renew(id: string, leaseId: string): LeaseHandle {
    const env = this.#deps.getEnvironment(id);
    if (!env) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    const now = this.#now();
    const current = this.#leases.get(id);
    const denial = diagnoseLease({
      environmentId: id,
      lease: current,
      providedLeaseId: leaseId,
      space: current?.space ?? 'agent',
      now,
    });
    if (denial) throw leaseDenialError(denial);
    const lease = current as LeaseHandle;
    const ttl = this.#ttl();
    lease.expiresAt = renewLease(env, leaseId, ttl, now).leaseExpiresAt ?? now + ttl;
    this.#deps.touch(id);
    this.syncShield(id);
    this.#deps.onChange();
    return lease;
  }

  assertWritable(id: string, leaseId?: string, space: SpaceId = 'agent'): LeaseHandle {
    const lease = this.#leases.get(id);
    // 「没租过 / 过期 / 被顶掉 / 被人接管 / space 不对」由 domain 判定并给出下一步命令，
    // 错误码不变（ENV_NOT_LEASED / CONTROL_REVOKED），额外带 reason 与 expiredAt
    const denial = diagnoseLease({ environmentId: id, lease, providedLeaseId: leaseId, space, now: this.#now() });
    if (denial) throw leaseDenialError(denial);
    return lease as LeaseHandle;
  }

  /**
   * 输入类操作只能落在**当前激活的标签**上。
   *
   * 输入走 CDP 的 Input 域，作用于「正在显示的那个 webContents」——对非激活标签
   * 发点击，Chromium 会把它送给激活标签，静默点错地方。所以显式拒绝，先 `tab.select`。
   */
  assertActiveTab(id: string, ref?: TabRef, space: SpaceId = 'agent'): void {
    if (ref === undefined) return; // 缺省就是激活标签
    const tabs = this.#deps.getSpaceManager(id, space);
    if (!tabs) {
      throw Object.assign(new Error(`environment ${id} is not running`), {
        code: 'ENV_NOT_RUNNING',
      });
    }
    const resolved = tabs.resolveRef(ref);
    if (!resolved || resolved !== tabs.activeId) {
      throw Object.assign(
        new Error(`tab ${String(ref)} 不是当前激活标签，输入会落到激活标签上；先 tab.select 再操作`),
        {
          code: 'TAB_NOT_VISIBLE',
        },
      );
    }
  }

  /**
   * 输入类操作必须要求「页面真的画在屏幕上」。
   *
   * 视图挂在窗口上、但被界面**让开**（浮层 / 插件页占了内容区，渲染层调了 `setViewVisible(false)`）
   * 时，Chromium 一样把 CDP 输入丢掉——而这一次不是报错，是**挂到 RPC 60s 超时**。
   */
  assertInputOnScreen(id: string, space: SpaceId = 'agent'): void {
    const tabs = this.#deps.getSpaceManager(id, space);
    if (!tabs) {
      throw Object.assign(new Error(`environment ${id} is not running`), {
        code: 'ENV_NOT_RUNNING',
      });
    }
    // 后台环境不看这个标志：它的含义是「**显示中的那个**被让开了」，
    // 后台环境的这个值可能是它当初被让开时留下的（切走时不会复位）
    if (!tabs.showing) return;
    if (!tabs.viewVisible) {
      throw Object.assign(
        new Error(
          `environment ${id} 的页面视图此刻被界面让开（浮层或插件页挡着），输入会被丢弃；先关掉浮层 / 切回环境页再操作`,
        ),
        { code: 'ENV_NOT_VISIBLE' },
      );
    }
  }

  /**
   * 让这个环境**此刻收得到输入**。返回 `true` = 是临时挂上去的，调用方用完要 `detachOperable`。
   *
   * 两条不能忘：
   * 1. 附上去会**抢走 webContents 焦点**，必须立刻把焦点还给显示中的那个；
   * 2. 上面那个视图此刻**被让开**（`viewVisible=false`）时**不许挂**。
   */
  ensureOperable(id: string, space: SpaceId = 'agent'): boolean {
    const tabs = this.#deps.getSpaceManager(id, space);
    if (!tabs) {
      throw Object.assign(new Error(`environment ${id} is not running`), {
        code: 'ENV_NOT_RUNNING',
      });
    }
    if (tabs.showing) return false; // 正常路径：它的视图就是显示中的那个

    const selectedId = this.#deps.getSelectedId();
    const selected = selectedId ? this.#deps.getSpaceManager(selectedId) : undefined;
    if (selected && !selected.viewVisible) {
      throw Object.assign(new Error(`界面上有浮层挡着页面区域，这时不能把后台环境挂上来操作；先关掉浮层`), {
        code: 'ENV_NOT_VISIBLE',
      });
    }
    if (!tabs.attachBelow()) return false;
    // 焦点必须马上还给显示中的那个环境。窗口不在前台时用焦点仿真，不能把应用拉上来。
    this.#deps.restoreDisplayedFocus(selected);
    this.#deps.recordEvent('input.backgroundAttach', `${id} 临时挂到最底层以便接收输入`, 'system', id);
    return true;
  }

  /** 摘掉 `ensureOperable` 临时挂上去的视图。 */
  detachOperable(id: string, space: SpaceId = 'agent'): void {
    this.#deps.getSpaceManager(id, space)?.detachBelow();
  }

  /**
   * 后台视图刚附到底层时，renderer 可能还没拿到布局尺寸（innerWidth/Height = 0）。
   * 给一次临时视口，动作完成后调用方负责清掉。
   */
  async prepareBackgroundInput(id: string, space: SpaceId = 'agent'): Promise<boolean> {
    const controller = this.#deps.getSpaceManager(id, space)?.controller();
    if (!controller) return false;
    const size = (await controller.evaluate('({ width: innerWidth, height: innerHeight })').catch(() => null)) as {
      width?: number;
      height?: number;
    } | null;
    if ((size?.width ?? 0) > 0 && (size?.height ?? 0) > 0) return false;
    const viewport = this.#deps.getViewportSize();
    await controller.emulateViewport(Math.max(1, viewport.width), Math.max(1, viewport.height)).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    return true;
  }

  async clearBackgroundInput(id: string, space: SpaceId = 'agent'): Promise<void> {
    await this.#deps
      .getSpaceManager(id, space)
      ?.controller()
      ?.clearEmulatedViewport()
      .catch(() => {});
  }

  /** 这个环境此刻的控制权策略（环境级 > 全局）。判定是纯函数，见 domain/approval.ts。 */
  #controlMode(id: string): 'ask' | 'auto' {
    const config = this.#deps.getConfig(id);
    return controlModeFor({
      policy: this.#deps.getControlPolicy(),
      envApproval: config?.approval,
      createdBy: config?.createdBy ?? 'human',
    });
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  #ttl(): number {
    return this.#deps.leaseTtlMs ? this.#deps.leaseTtlMs() : leaseTtlMs();
  }
}
