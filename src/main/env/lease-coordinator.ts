import { controlModeFor } from '../domain/approval.ts';
import { acquireLease, diagnoseLease, leaseDenialError, releaseLease, renewLease } from '../domain/environment.ts';
import type { InputShield, ShieldMode, ShieldPhase, ShieldTheme, ShieldVisualAction } from '../input-shield.ts';
import type { TabManager } from '../tabs.ts';
import type {
  AgentSessionState,
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
> & {
  attachedBelow?: boolean;
  peekActive?: TabManager['peekActive'];
  peekController?: TabManager['peekController'];
};

export type ShieldLike = Pick<InputShield, 'attached' | 'setCallerLabel' | 'setVisible' | 'setBounds' | 'destroy'> & {
  setShowControlPill?: (show: boolean) => void;
  setMode?: (mode: ShieldMode) => void;
  setTheme?: (theme: ShieldTheme) => void;
  setSession?: (session: {
    phase: ShieldPhase;
    startedAt: number;
    lastActivityAt: number;
    lastAction?: string;
    actionCount: number;
  }) => void;
  showAction?: (action: ShieldVisualAction) => void;
  osProcessId?: number;
};

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
  createShield: (id: string, onTakeover: () => void, onFinish?: () => void) => ShieldLike;
  attachAndRaiseShield: (shield: ShieldLike, bounds: ViewportRect) => void;
  detachShield: (shield: ShieldLike) => void;
  focusForInput?: (id: string, space: SpaceId) => Promise<void>;
  ensureRenderFocus?: (id: string, space: SpaceId) => Promise<void>;
  /** 是否启用了独立的永久隐藏宿主窗（`BackgroundHostWindow`）：启用后后台/被浮层让开的视图挂载到隐藏宿主窗，不再触发 `ENV_NOT_VISIBLE`。 */
  hasBackgroundHost?: () => boolean;
  onLeaseStateChanged?: (id: string, active: boolean) => void;
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
  /** 上层 Agent 空间托管会话态（与底层瞬时写锁解耦，AI 首次写入进入，仅显式结束或人工干预退出）。 */
  #agentSessions = new Map<string, AgentSessionState>();
  /** 全局单实例透明护盾，同一时刻仅挂载到当前可见的 Agent Space，消除多环境 N 份 WebGL 视图内存开销。 */
  #sharedShield?: ShieldLike;
  #shieldOwnerEnvId?: string;
  #shieldDetachedAt = 0;
  #ttlOverrideMs?: number;
  #showControlPill = true;
  #shieldTheme: ShieldTheme = 'dark';

  constructor(deps: LeaseCoordinatorDeps) {
    this.#deps = deps;
  }

  setLeaseTtlMs(ms?: number): void {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
      this.#ttlOverrideMs = Math.max(30_000, Math.min(Math.floor(ms), MAX_LEASE_TTL_MS));
      return;
    }
    this.#ttlOverrideMs = undefined;
  }

  setShowControlPill(show: boolean): void {
    this.#showControlPill = show;
    this.#sharedShield?.setShowControlPill?.(show);
  }

  setShieldTheme(theme: ShieldTheme): void {
    this.#shieldTheme = theme;
    this.#sharedShield?.setTheme?.(theme);
  }

  rawLease(id: string): LeaseHandle | undefined {
    return this.#leases.get(id);
  }

  /** 纯只读读取未过期租约，不触发任何副作用（供状态装饰使用）。 */
  liveLease(id: string): LeaseHandle | undefined {
    const lease = this.#leases.get(id);
    if (!lease || lease.expiresAt <= this.#now()) return undefined;
    return lease;
  }

  /** 读取当前环境的 Agent 托管会话态（若处于托管态返回浅拷贝，否则 undefined）。 */
  agentSession(id: string): AgentSessionState | undefined {
    const session = this.#agentSessions.get(id);
    return session?.active ? { ...session } : undefined;
  }

  /** Agent 是否正处于托管操作态（持有效写锁 或 上层托管会话活跃）。 */
  isAgentOperating(id: string): boolean {
    return this.isAgentControlling(id) || Boolean(this.#agentSessions.get(id)?.active);
  }

  /** 刷新已激活的 Agent 托管会话活跃时间（只读观测如 snapshot/read 时保活，不创建新会话）。 */
  touchAgentSession(id: string, actionText?: string): void {
    const session = this.#agentSessions.get(id);
    if (!session?.active) return;
    session.lastActivityAt = this.#now();
    if (actionText) session.lastAction = actionText;
    if (this.#shieldOwnerEnvId === id && this.#sharedShield) {
      this.#sharedShield.setSession?.({
        phase: session.phase,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        lastAction: session.lastAction,
        actionCount: session.actionCount,
      });
    }
  }

  /** 显式结束 Agent 空间托管会话态（AI 调 `env.finish` 或人点「结束」），同时清理残留 Agent 写锁并撤除蒙层。 */
  finishAgentSession(id: string, actor: 'agent' | 'human' = 'agent'): { finished: boolean } {
    const hadSession = this.#agentSessions.delete(id);
    const current = this.#leases.get(id);
    let releasedAgentLease = false;
    if (current && current.space === 'agent' && current.owner === 'agent') {
      this.#leases.delete(id);
      releasedAgentLease = true;
      this.#deps.emitBusEvent('lease.changed', id, {
        owner: 'none',
        space: current.space,
      });
    }
    if (!hadSession && !releasedAgentLease) {
      return { finished: false };
    }
    this.#deps.onLeaseStateChanged?.(id, false);
    this.#deps.recordEvent('agent.session.finished', `${actor} 结束了 ${id} 的 Agent 托管操作`, actor, id);
    this.syncShield(id);
    this.#deps.onChange();
    return { finished: true };
  }

  /** 显式清理所有已过期租约并同步护盾/降频状态（由定时清扫或写路径调用，不放在读路径里）。 */
  pruneExpiredLeases(): number {
    const now = this.#now();
    let pruned = 0;
    for (const [id, lease] of this.#leases) {
      if (lease.expiresAt <= now) {
        this.#leases.delete(id);
        const session = this.#agentSessions.get(id);
        if (lease.owner === 'agent' && session?.active) {
          // 底层写锁自然到期时不强撤上层托管会话，平滑切入 thinking 避免长思考间隙闪烁消失
          session.phase = 'thinking';
        }
        this.#deps.onLeaseStateChanged?.(id, Boolean(session?.active));
        this.syncShield(id);
        pruned += 1;
      }
    }
    return pruned;
  }

  /** 读取未过期租约；若已过期顺带清理并返回 undefined。 */
  pruneAndGetLiveLease(id: string): LeaseHandle | undefined {
    const lease = this.#leases.get(id);
    if (!lease) return undefined;
    if (lease.expiresAt <= this.#now()) {
      this.#leases.delete(id);
      const session = this.#agentSessions.get(id);
      if (lease.owner === 'agent' && session?.active) {
        session.phase = 'thinking';
      }
      this.#deps.onLeaseStateChanged?.(id, Boolean(session?.active));
      this.syncShield(id);
      return undefined;
    }
    return lease;
  }

  hasLiveLease(id: string): boolean {
    const lease = this.#leases.get(id);
    return Boolean((lease && lease.expiresAt > this.#now()) || this.#agentSessions.get(id)?.active);
  }

  hasActiveAgentLease(): boolean {
    const now = this.#now();
    if ([...this.#agentSessions.values()].some((session) => session.active)) return true;
    return [...this.#leases.values()].some(
      (lease) => lease.space === 'agent' && lease.owner === 'agent' && lease.expiresAt > now,
    );
  }

  spaceOwner(id: string, space: SpaceId): ControlOwner {
    if (space === 'person') return 'human';
    const lease = this.#leases.get(id);
    return lease && lease.expiresAt > this.#now() && lease.space === 'agent' ? lease.owner : 'none';
  }

  /**
   * 人机协作 2.0：我的空间永远可写；Agent Space 在 Agent 持权或托管会话活跃期间锁定防误点，
   * 空闲态（无锁且无托管会话）与人工接管态（owner === 'human'）允许人工直接交互和导航。
   */
  canHumanNavigate(id: string, space: SpaceId): boolean {
    if (space === 'person') return true;
    return !this.isAgentOperating(id);
  }

  isAgentControlling(id: string): boolean {
    const lease = this.#leases.get(id);
    return Boolean(lease && lease.space === 'agent' && lease.owner === 'agent' && lease.expiresAt > this.#now());
  }

  assertHumanAgentWritable(id: string): void {
    const lease = this.#leases.get(id);
    if (lease && lease.expiresAt > this.#now() && lease.space === 'agent' && lease.owner === 'agent') {
      throw Object.assign(new Error(`Agent Space ${id} is controlled by ${lease.owner}`), { code: 'ENV_BUSY' });
    }
    if (this.#agentSessions.get(id)?.active) {
      throw Object.assign(new Error(`Agent Space ${id} is in active agent operating session`), { code: 'ENV_BUSY' });
    }
  }

  shieldAttached(id: string): boolean {
    return Boolean(this.#sharedShield?.attached && this.#shieldOwnerEnvId === id);
  }

  repositionShield(id: string, bounds: ViewportRect): void {
    if (this.#sharedShield?.attached && this.#shieldOwnerEnvId === id) {
      this.#sharedShield.setBounds(bounds);
    }
  }

  setShieldVisible(id: string, visible: boolean): void {
    if (this.#shieldOwnerEnvId === id) {
      this.#sharedShield?.setVisible(visible);
    }
  }

  detachShieldOnly(id: string): void {
    if (this.#sharedShield && this.#shieldOwnerEnvId === id) {
      this.#deps.detachShield(this.#sharedShield);
      this.#shieldOwnerEnvId = undefined;
      this.#shieldDetachedAt = this.#now();
    }
  }

  clearEnv(id: string): void {
    this.#leases.delete(id);
    this.#agentSessions.delete(id);
    this.#deps.onLeaseStateChanged?.(id, false);
    if (this.#sharedShield && this.#shieldOwnerEnvId === id) {
      this.#deps.detachShield(this.#sharedShield);
      this.#shieldOwnerEnvId = undefined;
      this.#shieldDetachedAt = this.#now();
    }
  }

  /** 回收长时间脱离屏幕的闲置输入护盾视图（`idleMs = 0` 立即回收未挂载护盾）。 */
  reclaimIdleShield(idleMs = 0): number {
    if (!this.#sharedShield || this.#shieldOwnerEnvId || this.#sharedShield.attached) return 0;
    if (idleMs > 0 && (this.#shieldDetachedAt <= 0 || this.#now() - this.#shieldDetachedAt < idleMs)) return 0;
    this.destroyShield();
    return 1;
  }

  /** 应用退出前彻底销毁全局共享输入护盾视图。 */
  destroyShield(): void {
    if (!this.#sharedShield) return;
    this.#deps.detachShield(this.#sharedShield);
    this.#sharedShield.destroy();
    this.#sharedShield = undefined;
    this.#shieldOwnerEnvId = undefined;
    this.#shieldDetachedAt = 0;
  }

  /** 返回当前共享护盾进程的归因信息（未创建或已销毁时返回空数组）。 */
  shieldProcessInfos(): Array<{ pid: number; label: string }> {
    const pid = this.#sharedShield?.osProcessId;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      return [{ pid, label: 'Agent 输入护盾' }];
    }
    return [];
  }

  /**
   * 护盾只跟当前选中且处于 Agent 托管运行态的 Agent Space 走：
   * 空闲态与人工接管态绝不挂载遮罩，零误拦、零多余进程。
   */
  syncShield(id: string, options: { createIfMissing?: boolean } = {}): void {
    const createIfMissing = options.createIfMissing ?? true;
    const lease = this.#leases.get(id);
    const agentControlling = Boolean(
      lease && lease.space === 'agent' && lease.owner === 'agent' && lease.expiresAt > this.#now(),
    );
    const session = this.#agentSessions.get(id);
    const agentOperating = agentControlling || Boolean(session?.active);
    const active = this.#deps.getSelectedId() === id && this.#deps.getActiveSpace(id) === 'agent' && agentOperating;
    if (!active) {
      if (this.#sharedShield && this.#shieldOwnerEnvId === id) {
        this.#sharedShield.setMode?.('idle');
        this.#deps.detachShield(this.#sharedShield);
        this.#shieldOwnerEnvId = undefined;
        this.#shieldDetachedAt = this.#now();
      }
      return;
    }
    if (!this.#sharedShield && createIfMissing) {
      this.#sharedShield = this.#deps.createShield(
        id,
        () => {
          const ownerId = this.#shieldOwnerEnvId;
          if (!ownerId) return;
          try {
            this.takeover(ownerId, 'human', 'agent');
          } catch {
            // ignore
          }
        },
        () => {
          const ownerId = this.#shieldOwnerEnvId;
          if (!ownerId) return;
          try {
            this.finishAgentSession(ownerId, 'human');
          } catch {
            // ignore
          }
        },
      );
    }
    if (!this.#sharedShield) return;
    this.#shieldOwnerEnvId = id;
    this.#shieldDetachedAt = 0;
    this.#sharedShield.setShowControlPill?.(this.#showControlPill);
    this.#sharedShield.setTheme?.(this.#shieldTheme);
    this.#sharedShield.setMode?.('agent');
    this.#sharedShield.setCallerLabel(lease?.label ?? session?.label);
    const now = this.#now();
    this.#sharedShield.setSession?.({
      phase: agentControlling ? 'acting' : (session?.phase ?? 'thinking'),
      startedAt: session?.startedAt ?? now,
      lastActivityAt: session?.lastActivityAt ?? now,
      lastAction: session?.lastAction,
      actionCount: session?.actionCount ?? 1,
    });
    this.#sharedShield.setVisible(this.#deps.getViewVisible());
    this.#deps.attachAndRaiseShield(this.#sharedShield, this.#deps.getPageBounds());
  }

  /** 将 AI 正在执行的视口坐标/控件矩形同步给当前可见的透明遮罩层绘制轨迹动画。 */
  showVisualAction(id: string, action: ShieldVisualAction): void {
    const session = this.#agentSessions.get(id);
    if (session?.active) {
      session.lastActivityAt = this.#now();
      if (action.label) session.lastAction = action.label;
    }
    if (this.#deps.getSelectedId() !== id) return;
    if (this.#deps.getActiveSpace(id) !== 'agent') return;
    if (!this.#deps.getViewVisible() || !this.isAgentOperating(id)) return;
    if (this.#shieldOwnerEnvId !== id) return;
    this.#sharedShield?.showAction?.(action);
  }

  acquire(
    id: string,
    owner: 'agent' | 'human',
    label?: string,
    space: SpaceId = 'agent',
    existingLeaseId?: string,
  ): LeaseHandle {
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
      // 同一 owner 续租：agent 必须出示匹配 leaseId，防止多 Agent 互相拿到同一 leaseId 并提前误释放
      if (current.owner === owner) {
        if (owner === 'agent' && existingLeaseId !== current.leaseId) {
          throw Object.assign(
            new Error(
              `environment ${id} is currently held by another agent${current.label ? ` (${current.label})` : ''}`,
            ),
            { code: 'ENV_BUSY' },
          );
        }
        current.expiresAt = renewLease(env, current.leaseId, ttl, now).leaseExpiresAt ?? now + ttl;
        if (label) current.label = label;
        this.syncShield(id, { createIfMissing: owner === 'agent' });
        this.#deps.onChange();
        return current;
      }
      // 仅当审批策略为 auto 且 agent 接入时可自动接管；其余走 domain acquireLease 判忙碌拒绝
      if (owner !== 'agent' || this.#controlMode(id) !== 'auto') {
        acquireLease(
          { ...env, owner: current.owner, leaseId: current.leaseId, leaseExpiresAt: current.expiresAt },
          owner,
          current.leaseId,
          ttl,
          now,
        );
      }
      this.#deps.recordEvent('control.autoTakeover', `agent 按审批策略从 ${current.owner} 接管 ${id}`, 'agent', id);
    }
    const acquired = acquireLease(
      { ...env, owner: 'none', leaseId: undefined, leaseExpiresAt: undefined },
      owner,
      crypto.randomUUID(),
      ttl,
      now,
    );
    const lease: LeaseHandle = {
      environmentId: id,
      space,
      owner: acquired.owner,
      label,
      leaseId: acquired.leaseId!,
      expiresAt: acquired.leaseExpiresAt!,
    };
    this.#leases.set(id, lease);
    if (owner === 'agent') {
      const existingSession = this.#agentSessions.get(id);
      if (existingSession?.active) {
        existingSession.phase = 'acting';
        existingSession.lastActivityAt = now;
        existingSession.actionCount += 1;
        if (label) {
          existingSession.label = label;
          existingSession.lastAction = label;
        }
      } else {
        this.#agentSessions.set(id, {
          active: true,
          phase: 'acting',
          label: label?.trim() || 'Agent',
          startedAt: now,
          lastActivityAt: now,
          lastAction: label?.trim() || undefined,
          actionCount: 1,
        });
      }
    } else {
      this.#agentSessions.delete(id);
    }
    this.#deps.onLeaseStateChanged?.(id, owner === 'agent');
    this.#deps.recordEvent('control.acquired', `${owner} acquired ${id}${label ? ` (${label})` : ''}`, owner, id);
    this.#deps.emitBusEvent('lease.changed', id, {
      owner,
      space,
      leaseId: lease.leaseId,
      ...(label ? { label } : {}),
    });
    this.syncShield(id, { createIfMissing: owner === 'agent' });
    this.#deps.onChange();
    return lease;
  }

  release(
    id: string,
    leaseId: string,
    actor: 'agent' | 'human' = 'agent',
    options: { keepSession?: boolean } = {},
  ): void {
    const current = this.#leases.get(id);
    if (!current) return;
    const baseEnv = this.#deps.getEnvironment(id) ?? {
      id,
      name: id,
      storagePath: '',
      createdBy: 'human' as const,
      status: 'stopped' as const,
      headed: true,
      order: 0,
      createdAt: '',
      updatedAt: '',
      owner: 'none' as const,
      activeSpaceId: 'person' as const,
      spaces: [],
    };
    const now = this.#now();
    releaseLease(
      {
        ...baseEnv,
        owner: current.owner,
        leaseId: current.leaseId,
        leaseExpiresAt: current.expiresAt,
      },
      leaseId,
      now,
    );
    this.#leases.delete(id);
    const keepSession = Boolean(options.keepSession && current.owner === 'agent' && actor === 'agent');
    const session = this.#agentSessions.get(id);
    if (keepSession && session?.active) {
      session.phase = 'thinking';
      session.lastActivityAt = now;
    } else {
      this.#agentSessions.delete(id);
    }
    this.#deps.onLeaseStateChanged?.(id, Boolean(keepSession && session?.active));
    this.#deps.recordEvent('control.released', `${actor} released ${id}`, actor, id);
    this.#deps.emitBusEvent('lease.changed', id, {
      owner: 'none',
      space: current.space,
    });
    this.syncShield(id);
    this.#deps.onChange();
  }

  takeover(id: string, label = 'human', space: SpaceId = 'agent'): LeaseHandle {
    if (space !== 'agent') {
      throw Object.assign(new Error('只有 Agent Space 需要接管'), { code: 'BAD_REQUEST' });
    }
    const hadSession = this.#agentSessions.delete(id);
    const current = this.#leases.get(id);
    if (current || hadSession) {
      if (current) this.#leases.delete(id);
      this.#deps.recordEvent(
        'control.takeover',
        `human took over ${id} from ${current?.owner ?? 'agent'}`,
        'human',
        id,
      );
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
    this.syncShield(id, { createIfMissing: lease.owner === 'agent' });
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
    // 后台环境或当前已借挂到永久隐藏宿主窗（attachedBelow）时，视图落在真实合成器表面上，放行输入
    if (!tabs.showing || tabs.attachedBelow) return;
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
   * - 启用永久隐藏宿主窗（`hasBackgroundHost()`）时：后台视图与被浮层/插件页让开的前台视图都挂到隐藏宿主窗，
   *   不碰主窗口内容区、不抢焦点、不再因设置页/插件全屏页/隐藏态浮层报 `ENV_NOT_VISIBLE`。
   * - 未启用隐藏宿主窗（单测桩 / 旧主窗 `'below'` 槽模式）时：保持原双护栏语义。
   */
  ensureOperable(id: string, space: SpaceId = 'agent'): boolean {
    const tabs = this.#deps.getSpaceManager(id, space);
    if (!tabs) {
      throw Object.assign(new Error(`environment ${id} is not running`), {
        code: 'ENV_NOT_RUNNING',
      });
    }
    const usesBackgroundHost = Boolean(this.#deps.hasBackgroundHost?.());
    if (tabs.showing) {
      if (!usesBackgroundHost || tabs.viewVisible) return false;
      // 主窗口当前页正被浮层/设置页/插件全屏页让开：临时借挂到隐藏宿主窗执行，不惊动主窗口
      if (!tabs.attachBelow()) return false;
      this.#deps.recordEvent('input.backgroundAttach', `${id} 临时借挂到隐藏宿主窗以绕过界面让开`, 'system', id);
      return true;
    }

    if (usesBackgroundHost) {
      if (!tabs.attachBelow()) return false;
      this.#deps.recordEvent('input.backgroundAttach', `${id} 临时挂到隐藏宿主窗以便接收输入`, 'system', id);
      return true;
    }

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

  /**
   * 统一输入上下文协作者：后台临时挂载 → 校验在屏/激活标签 → 仿真焦点 → 必要时补齐后台视口 → 执行并确保回收。
   */
  async withInputContext<T>(
    id: string,
    space: SpaceId,
    tab: TabRef | undefined,
    fn: () => Promise<T>,
    options: { focusForInput?: () => Promise<void> } = {},
  ): Promise<T> {
    const temporary = this.ensureOperable(id, space);
    let emulatedViewport = false;
    try {
      this.assertInputOnScreen(id, space);
      this.assertActiveTab(id, tab, space);
      if (options.focusForInput) await options.focusForInput();
      else if (this.#deps.focusForInput) await this.#deps.focusForInput(id, space);
      if (temporary) emulatedViewport = await this.prepareBackgroundInput(id, space);
      return await fn();
    } finally {
      if (emulatedViewport) await this.clearBackgroundInput(id, space);
      if (temporary) this.detachOperable(id, space);
    }
  }

  /**
   * 统一截图上下文协作者（供 RPC screenshot / batch / evidence / 插件 browser.screenshot 复用）：
   * 后台或隐藏态临时挂载 → 唤醒焦点仿真合成器 → 必要时补齐临时视口 → 截图并确保回收。
   */
  async withScreenshotContext<T>(id: string, space: SpaceId = 'agent', fn: () => Promise<T>): Promise<T> {
    const temporary = this.ensureOperable(id, space);
    let emulatedViewport = false;
    try {
      await this.#deps.ensureRenderFocus?.(id, space);
      if (temporary) emulatedViewport = await this.prepareBackgroundInput(id, space);
      return await fn();
    } finally {
      if (emulatedViewport) await this.clearBackgroundInput(id, space);
      if (temporary) this.detachOperable(id, space);
    }
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
    if (this.#ttlOverrideMs !== undefined) return this.#ttlOverrideMs;
    return this.#deps.leaseTtlMs ? this.#deps.leaseTtlMs() : leaseTtlMs();
  }
}
