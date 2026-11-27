import { rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Session } from 'electron';
import type { X509Certificate } from 'node:crypto';
import { clearDownloads } from '../browser/downloads.ts';
import { clearCachedSnapshots } from '../browser/ops/diff.ts';
import { EnvPending } from '../browser/pending.ts';
import {
  makeEvent,
  pickDormant,
  pickEvictions,
  safeEnvKey,
  toEnvironment,
  type EnvironmentPatch,
} from '../domain/environment.ts';
import type { Store } from '../store.ts';
import type { Tab, TabManager } from '../tabs.ts';
import type {
  Creator,
  EnvMemoryProtectionReason,
  Environment,
  EnvironmentConfig,
  LruEvictAction,
  PluginBusEventType,
  SpaceId,
} from '../../shared/types.ts';

/** 同时运行的环境上限。超了按 LRU 回收（见 `evictFor`）。`WARREN_MAX_RUNNING=0` 关掉回收。 */
const DEFAULT_MAX_RUNNING = 8;

/** 闲置多久进入休眠。`WARREN_IDLE_MS=0` 关掉自动休眠。 */
const DEFAULT_IDLE_MS = 10 * 60_000;

/** 扫描间隔：只是掂一下 lastActive，别太勤。 */
const DORMANT_SWEEP_MS = 30_000;

function idleMsFromEnv(): number {
  const raw = Number(process.env.WARREN_IDLE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_IDLE_MS;
  return Math.floor(raw);
}

function maxRunningFromEnv(): number {
  const raw = Number(process.env.WARREN_MAX_RUNNING);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_RUNNING;
  return Math.floor(raw);
}

/**
 * 等第一个标签加载完。和原来 `controller.navigate()` 的等待语义一致。
 *
 * **只有主框架失败才算加载失败**：iframe 和子资源失败不该让它提前返回。
 * 失败原因记在标签自己的 `state.error` 上（见 `tabs.ts`），环境从激活标签派生。
 */
function waitForLoad(tab: Tab, timeoutMs: number): Promise<void> {
  const wc = tab.webContents;
  if (!wc || wc.isDestroyed() || !wc.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.off('did-stop-loading', onStop);
      wc.off('did-fail-load', onFail);
      resolve();
    };
    const onStop = () => finish();
    const onFail = (_event: unknown, _code: number, _desc: string, _url: string, isMainFrame: boolean) => {
      if (isMainFrame) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    wc.once('did-stop-loading', onStop);
    wc.on('did-fail-load', onFail);
  });
}

export interface EnvironmentSpaces {
  person: TabManager;
  agent: TabManager;
  active: SpaceId;
}

export const SPACE_IDS: readonly SpaceId[] = ['person', 'agent'];

export interface LifecycleDeps {
  store: Pick<
    Store,
    'create' | 'remove' | 'update' | 'configFor' | 'runningSnapshot' | 'saveRunning' | 'tabsFor' | 'saveTabs' | 'record'
  >;
  prepareSession: (
    id: string,
    config: EnvironmentConfig,
  ) => Promise<{ session: Session; trustedCa: X509Certificate | undefined }>;
  prepareWakeSession: (
    id: string,
    config: EnvironmentConfig,
  ) => { session: Session; trustedCa: X509Certificate | undefined };
  syncSessionNetwork?: (id: string, config: EnvironmentConfig) => Promise<void>;
  clearStorageData: (id: string) => Promise<void>;
  dropNet: (id: string) => void;
  ensureDirectory?: (dir: string) => Promise<void>;
  removeDirectory?: (dir: string) => Promise<void>;
  wireDownloads: (ses: Session, envId: string, pendingFor: (envId: string) => EnvPending | undefined) => void;
  attachSessionTelemetry: (ses: Session) => void;
  detachNet: (id: string) => void;
  detachTelemetry: (id: string) => void;
  clearTelemetry?: (id: string) => void;
  isNetBusy: (id: string) => boolean;
  createSpaceManager: (
    id: string,
    space: SpaceId,
    ses: Session,
    trustedCa: X509Certificate | undefined,
    pending: EnvPending,
  ) => TabManager;
  newTabUrl: (id: string) => string;
  decorate: (env: Environment) => Environment;
  selectEnv: (id: string) => void;
  clearSelectedIf: (id: string) => void;
  getSelectedId: () => string | undefined;
  hasLiveLease: (id: string) => boolean;
  clearLeaseAndShield: (id: string) => void;
  closeEnvDevTools: (spaces: EnvironmentSpaces) => void;
  destroyAllDevTools: () => void;
  onChange: () => void;
  emitBusEvent: (type: PluginBusEventType, environmentId: string, payload: Record<string, unknown>) => void;
  maxRunning?: number;
  idleMs?: number;
  tabSleepMs?: number;
  lazyRestoreTabs?: boolean;
  throttleBackgroundTabs?: boolean;
  lruEvictAction?: LruEvictAction;
  pinnedEnvIds?: string[];
  now?: () => number;
  waitForInitialLoad?: (tab: Tab, timeoutMs: number) => Promise<void>;
}

/**
 * 环境生命周期协作者：
 * 负责 `create` / `remove` / `update`、`start` / `stop` / `hibernate` / `wake` /
 * LRU 回收与闲置扫描、`restoreRunning` 及标签快照持久化。
 *
 * 注意：对 Electron 只用 `import type`，运行态资源通过 `LifecycleDeps` 注入，
 * 以便 `node --test` 直接加载本模块做纯逻辑与生命周期状态机单测。
 */
export class EnvLifecycle {
  #deps: LifecycleDeps;
  #spaces = new Map<string, EnvironmentSpaces>();
  /** 休眠中的环境：页面已销毁，配置 / session / 标签快照都还在。 */
  #dormant = new Set<string>();
  /** 每个运行中环境的待处理队列（popup / download）与下载句柄表。 */
  #pending = new Map<string, EnvPending>();
  /** 每个环境最后一次被用到（选中 / 取租约 / agent 操作）。LRU 回收按它排序。 */
  #lastActive = new Map<string, number>();
  /**
   * 上次写进库的标签快照（`*` 前缀表示激活的那个）。
   *
   * 标签的 `onChanged` 会被标题 / 图标 / 加载态**频繁**触发，不去重就变成一路写库；
   * 而标签表只记 URL 与激活位，所以这串字符串一样就没必要写。
   */
  #tabSnapshot = new Map<string, string>();
  /** 唤醒瞬间新标签 URL 还是空的，这期间不许 rememberTabs 把快照覆盖成空。 */
  #waking = new Set<string>();
  /** hibernate 销毁标签时 onSpaceEmpty 不该把「休眠」改写成「主动停止」。 */
  #hibernating = new Set<string>();
  #starting = new Map<string, Promise<Environment>>();
  #epoch = new Map<string, number>();
  #maxRunning: number;
  #idleMs: number;
  #tabSleepMs: number;
  #lazyRestoreTabs: boolean;
  #throttleBackgroundTabs: boolean;
  #lruEvictAction: LruEvictAction;
  #pinned = new Set<string>();
  #sweepTimer?: ReturnType<typeof setInterval>;

  constructor(deps: LifecycleDeps) {
    this.#deps = deps;
    this.#maxRunning = deps.maxRunning ?? maxRunningFromEnv();
    this.#idleMs = deps.idleMs ?? idleMsFromEnv();
    this.#tabSleepMs = deps.tabSleepMs ?? 0;
    this.#lazyRestoreTabs = deps.lazyRestoreTabs ?? true;
    this.#throttleBackgroundTabs = deps.throttleBackgroundTabs ?? true;
    this.#lruEvictAction = deps.lruEvictAction ?? 'stop';
    if (deps.pinnedEnvIds) {
      for (const id of deps.pinnedEnvIds) this.#pinned.add(id);
    }
    for (const id of deps.store.runningSnapshot().dormant ?? []) {
      if (deps.store.configFor(id)) this.#dormant.add(id);
    }
    this.#syncSweepTimer();
  }

  get maxRunning(): number {
    return this.#maxRunning;
  }

  isTabThrottlingEnabled(): boolean {
    return this.#throttleBackgroundTabs;
  }

  isPinned(id: string): boolean {
    return this.#pinned.has(id);
  }

  lastActiveAt(id: string): number {
    return this.#lastActive.get(id) ?? 0;
  }

  /** 将 Agent Lease 状态同步到两个 Space 的 TabManager，控制后台降频开关。 */
  setLeaseActive(id: string, active: boolean): void {
    const spaces = this.#spaces.get(id);
    if (!spaces) return;
    spaces.person.setLeaseActive?.(active);
    spaces.agent.setLeaseActive?.(active);
  }

  #syncSweepTimer(): void {
    const needTimer = this.#idleMs > 0 || this.#tabSleepMs > 0;
    if (needTimer && !this.#sweepTimer) {
      this.#sweepTimer = setInterval(() => this.sweepIdle(), DORMANT_SWEEP_MS);
      this.#sweepTimer.unref?.();
    } else if (!needTimer && this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
  }

  setLimits(limits: {
    maxRunning?: number;
    idleMinutes?: number;
    tabSleepMinutes?: number;
    lazyRestoreTabs?: boolean;
    throttleBackgroundTabs?: boolean;
    lruEvictAction?: LruEvictAction;
    pinnedEnvIds?: string[];
  }): void {
    if (limits.maxRunning !== undefined && Number.isFinite(limits.maxRunning)) {
      this.#maxRunning = Math.max(0, Math.min(32, Math.floor(limits.maxRunning)));
    }
    if (limits.idleMinutes !== undefined && Number.isFinite(limits.idleMinutes)) {
      this.#idleMs = Math.max(0, Math.min(240, Math.floor(limits.idleMinutes))) * 60_000;
    }
    if (limits.tabSleepMinutes !== undefined && Number.isFinite(limits.tabSleepMinutes)) {
      this.#tabSleepMs = Math.max(0, Math.min(240, Math.floor(limits.tabSleepMinutes))) * 60_000;
    }
    if (typeof limits.lazyRestoreTabs === 'boolean') {
      this.#lazyRestoreTabs = limits.lazyRestoreTabs;
    }
    if (typeof limits.throttleBackgroundTabs === 'boolean') {
      this.#throttleBackgroundTabs = limits.throttleBackgroundTabs;
      for (const spaces of this.#spaces.values()) {
        spaces.person.setThrottleBackgroundTabs?.(limits.throttleBackgroundTabs);
        spaces.agent.setThrottleBackgroundTabs?.(limits.throttleBackgroundTabs);
      }
    }
    if (limits.lruEvictAction === 'hibernate' || limits.lruEvictAction === 'stop') {
      this.#lruEvictAction = limits.lruEvictAction;
    }
    if (Array.isArray(limits.pinnedEnvIds)) {
      this.#pinned = new Set(limits.pinnedEnvIds);
    }
    this.#syncSweepTimer();
  }

  get runningCount(): number {
    return this.#spaces.size;
  }

  hasRunningEnvironments(): boolean {
    return this.#spaces.size > 0;
  }

  isRunning(id: string): boolean {
    return this.#spaces.has(id);
  }

  isDormant(id: string): boolean {
    return this.#dormant.has(id);
  }

  spacesFor(id: string): EnvironmentSpaces | undefined {
    return this.#spaces.get(id);
  }

  allSpacesEntries(): Array<[string, EnvironmentSpaces]> {
    return [...this.#spaces.entries()];
  }

  activeSpaceOf(id: string): SpaceId {
    return this.#spaces.get(id)?.active ?? 'person';
  }

  spaceManager(id: string, space?: SpaceId): TabManager | undefined {
    const spaces = this.#spaces.get(id);
    if (!spaces) return undefined;
    return spaces[space ?? spaces.active];
  }

  pendingFor(id: string): EnvPending | undefined {
    return this.#pending.get(id);
  }

  touch(id: string): void {
    this.#lastActive.set(id, this.#now());
  }

  create(input: {
    id: string;
    name?: string;
    proxy?: string;
    startUrl?: string;
    headed?: boolean;
    createdBy?: Creator;
  }): Environment {
    const createdBy: Creator = input.createdBy ?? 'human';
    const created = this.#deps.store.create({ ...input, createdBy });
    this.#deps.store.record(
      makeEvent('environment.created', `environment ${created.id} created`, createdBy, created.id),
    );
    this.#deps.onChange();
    return this.#deps.decorate(created);
  }

  #bumpEpoch(id: string): number {
    const next = (this.#epoch.get(id) ?? 0) + 1;
    this.#epoch.set(id, next);
    return next;
  }

  async remove(id: string): Promise<void> {
    this.#bumpEpoch(id);
    const config = this.#deps.store.configFor(id);
    this.stop(id);
    this.#dormant.delete(id);
    this.#deps.clearSelectedIf(id);
    this.#deps.dropNet(id);
    this.#deps.clearTelemetry?.(id);
    clearDownloads(id);
    clearCachedSnapshots(id);
    this.#tabSnapshot.delete(id);
    await this.#deps.clearStorageData(id);
    this.#deps.store.remove(id);
    if (config) {
      try {
        if (this.#deps.removeDirectory) await this.#deps.removeDirectory(config.storagePath);
        else await rm(config.storagePath, { recursive: true, force: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#deps.store.record(
          makeEvent('environment.removeFailed', `environment ${id} remove failed: ${message}`, 'system', id),
        );
        throw Object.assign(
          new Error(`environment ${id} removed, but failed to delete ${config.storagePath}: ${message}`),
          { code: 'ENV_REMOVE_FAILED' },
        );
      }
    }
    this.#deps.store.record(makeEvent('environment.removed', `environment ${id} removed`, 'human', id));
    this.#deps.onChange();
  }

  async update(id: string, patch: EnvironmentPatch): Promise<Environment> {
    const updated = this.#deps.store.update(id, patch);
    await this.#deps.syncSessionNetwork?.(id, updated);
    this.#deps.store.record(makeEvent('environment.updated', `environment ${id} updated`, 'human', id));
    this.#deps.onChange();
    return this.#deps.decorate(updated);
  }

  onSpaceEmpty(id: string, space: SpaceId): void {
    if (this.#hibernating.has(id)) return;
    const spaces = this.#spaces.get(id);
    if (!spaces) return;
    if (spaces.person.size === 0 && spaces.agent.size === 0) {
      this.stop(id);
      return;
    }
    if (spaces.active === space) this.#deps.onChange();
  }

  async start(id: string): Promise<Environment> {
    const inflight = this.#starting.get(id);
    if (inflight) return inflight;
    const task = this.#startImpl(id).finally(() => {
      if (this.#starting.get(id) === task) this.#starting.delete(id);
    });
    this.#starting.set(id, task);
    return task;
  }

  async #startImpl(id: string): Promise<Environment> {
    const config = this.#deps.store.configFor(id);
    if (!config) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    if (this.#spaces.has(id)) return this.#deps.decorate(toEnvironment(config));
    const epoch = this.#epoch.get(id) ?? 0;
    const aborted = (): boolean => (this.#epoch.get(id) ?? 0) !== epoch || !this.#deps.store.configFor(id);
    this.#dormant.delete(id);

    this.evictFor(id);
    if (this.#deps.ensureDirectory) await this.#deps.ensureDirectory(config.storagePath);
    else await mkdir(config.storagePath, { recursive: true });
    if (aborted()) return this.#handleAbortedStart(id, config);

    const { session, trustedCa } = await this.#deps.prepareSession(id, config);
    if (aborted()) return this.#handleAbortedStart(id, config);
    if (this.#spaces.has(id)) return this.#deps.decorate(toEnvironment(config));

    const first = this.#materialize(id, config, session, trustedCa);
    if (first) await (this.#deps.waitForInitialLoad ?? waitForLoad)(first, 30_000);
    if (aborted()) {
      const partial = this.#spaces.get(id);
      if (partial) this.#teardownSpaces(id, partial, { hibernating: false });
      return this.#handleAbortedStart(id, config);
    }

    const latestConfig = this.#deps.store.configFor(id);
    if (!latestConfig) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    this.#deps.store.record(makeEvent('environment.started', `environment ${id} started`, 'human', id));
    this.#deps.emitBusEvent('env.status', id, { status: 'running', reason: 'start' });
    // headed=false：起了但不把人正在看的页面切走（批量拉起环境时界面不该被刷来刷去）
    if (latestConfig.headed) this.#deps.selectEnv(id);
    this.rememberRunning();
    this.#deps.onChange();
    return this.#deps.decorate(toEnvironment(latestConfig));
  }

  #handleAbortedStart(id: string, fallbackConfig: EnvironmentConfig): Environment {
    const latest = this.#deps.store.configFor(id);
    if (!latest) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    return this.#deps.decorate(toEnvironment(latest ?? fallbackConfig));
  }

  stop(id: string, reason = 'stop'): void {
    this.#bumpEpoch(id);
    const wasDormant = this.#dormant.delete(id);
    const spaces = this.#spaces.get(id);
    if (!spaces) {
      if (wasDormant) {
        this.#deps.emitBusEvent('env.status', id, { status: 'stopped', reason });
      }
      this.rememberRunning();
      this.#deps.onChange();
      return;
    }

    this.#teardownSpaces(id, spaces, { hibernating: false });

    this.#deps.store.record(makeEvent('environment.stopped', `environment ${id} stopped`, 'human', id));
    this.#deps.emitBusEvent('env.status', id, { status: 'stopped', reason });
    // 停掉 = 不再「运行中」。正常退出走的就是这条路（`shutdown()` 逐个 stop），
    // 所以下次启动不会把用户主动关掉的环境又拉起来。
    this.rememberRunning();
    this.#deps.onChange();
  }

  /**
   * 休眠：把页面与 renderer 进程放掉，但保留 session（登录态 / 代理 / CA）、配置、
   * 标签快照与运行态。下次任何一次「用到这个环境」都由 `wake()` 透明复活。
   *
   * 这里**不调 `stop()`**：stop 是人的语义（主动停、不再自动拉起），休眠不是。
   */
  hibernate(id: string, reason = 'manual'): boolean {
    const spaces = this.#spaces.get(id);
    if (!spaces || this.#dormant.has(id)) return false;
    if (this.#deps.getSelectedId() === id) return false;
    if (this.#deps.hasLiveLease(id)) return false;
    this.#bumpEpoch(id);

    this.#teardownSpaces(id, spaces, { hibernating: true });

    this.#dormant.add(id);
    this.#deps.store.record(makeEvent('env.dormant', `${id} 进入休眠（${reason}）`, 'system', id));
    this.#deps.emitBusEvent('env.status', id, { status: 'dormant', reason });
    this.rememberRunning();
    this.#deps.onChange();
    return true;
  }

  /**
   * 透明唤醒：同步按标签快照把视图建回来。session / 代理 / 扩展在休眠前后都没动过，
   * 所以不需要再 await 一遍；页面会重新加载，JS 状态与未提交表单不保留。
   */
  wake(id: string): boolean {
    if (!this.#dormant.has(id) || this.#spaces.has(id)) return false;
    const config = this.#deps.store.configFor(id);
    if (!config) {
      this.#dormant.delete(id);
      return false;
    }
    const { session, trustedCa } = this.#deps.prepareWakeSession(id, config);
    this.#waking.add(id);
    this.#materialize(id, config, session, trustedCa);
    this.#waking.delete(id);
    this.#tabSnapshot.delete(id);
    this.#dormant.delete(id);
    this.touch(id);
    this.#deps.store.record(makeEvent('env.woken', `${id} 从休眠唤醒`, 'system', id));
    this.#deps.emitBusEvent('env.status', id, { status: 'running', reason: 'wake' });
    this.rememberRunning();
    this.#deps.onChange();
    return true;
  }

  /** 返回该运行中环境为何受保护免自动休眠/回收；返回 undefined 表示可安全回收。 */
  protectionReasonOf(id: string): EnvMemoryProtectionReason | undefined {
    if (!this.#spaces.has(id)) return undefined;
    if (this.#deps.getSelectedId() === id) return 'selected';
    if (this.#deps.hasLiveLease(id)) return 'leased';
    if (this.#pinned.has(id)) return 'pinned';
    const spaces = this.#spaces.get(id)!;
    const tabs = SPACE_IDS.flatMap((space) => spaces[space].list());
    if (tabs.some((tab) => tab.audible)) return 'audible';
    if (tabs.some((tab) => tab.loading) || this.#deps.isNetBusy(id)) return 'busy';
    return undefined;
  }

  /** 一键休眠所有可安全回收的后台运行中环境，返回本次进入休眠的环境 ID 列表。 */
  hibernateBackground(reason = 'manual-batch'): string[] {
    const hibernated: string[] = [];
    for (const id of [...this.#spaces.keys()]) {
      if (this.protectionReasonOf(id)) continue;
      if (this.hibernate(id, reason)) hibernated.push(id);
    }
    return hibernated;
  }

  /** 立即休眠指定环境（或全部非持权运行中环境）内的所有非激活可安全休眠标签。 */
  sleepIdleTabs(envId?: string): number {
    let slept = 0;
    const targets = envId ? [envId] : [...this.#spaces.keys()];
    for (const id of targets) {
      const spaces = this.#spaces.get(id);
      if (!spaces) continue;
      if (!envId && this.#deps.hasLiveLease(id)) continue;
      for (const space of SPACE_IDS) {
        slept += spaces[space].sleepAllInactive?.() ?? 0;
      }
    }
    return slept;
  }

  /** 定时扫描：闲置到点且没在被用的环境进休眠，同时休眠超时的后台非激活标签。 */
  sweepIdle(): void {
    const now = this.#now();
    if (this.#idleMs > 0) {
      const candidates = [...this.#spaces.keys()].map((id) => ({
        id,
        lastActiveAt: this.#lastActive.get(id) ?? 0,
        selected: this.#deps.getSelectedId() === id,
        leased: this.#deps.hasLiveLease(id),
        busy: this.#isBusy(id),
        pinned: this.#pinned.has(id),
      }));
      for (const id of pickDormant(candidates, now, this.#idleMs)) {
        this.hibernate(id, `闲置 ${Math.round((now - (this.#lastActive.get(id) ?? 0)) / 1000)}s`);
      }
    }
    if (this.#tabSleepMs > 0) {
      for (const [id, spaces] of this.#spaces.entries()) {
        if (this.#deps.hasLiveLease(id)) continue;
        for (const space of SPACE_IDS) {
          spaces[space].sleepIdle?.(this.#tabSleepMs, now);
        }
      }
    }
  }

  /**
   * 起新环境之前腾位置：按「最后一次被用到」回收最久没用的那几个。
   *
   * 排除项见 `pickEvictions`（选中的 / 持租约的 / Pin 固定的绝不回收）。
   * 按 `lruEvictAction` 决定优先 `hibernate`（默认，保留无缝唤醒）还是直接 `stop`。
   */
  evictFor(keep: string): void {
    if (this.#maxRunning <= 0) return;
    const candidates = [...this.#spaces.keys()]
      .filter((id) => id !== keep)
      .map((id) => ({
        id,
        lastActiveAt: this.#lastActive.get(id) ?? 0,
        selected: this.#deps.getSelectedId() === id,
        leased: this.#deps.hasLiveLease(id),
        pinned: this.#pinned.has(id),
      }));
    for (const id of pickEvictions(candidates, this.#maxRunning)) {
      if (this.#lruEvictAction === 'hibernate') {
        this.#deps.store.record(
          makeEvent('env.evicted', `${id} 达到并发上限 ${this.#maxRunning}，自动休眠释放内存`, 'system', id),
        );
        if (!this.hibernate(id, `LRU 并发上限 ${this.#maxRunning}`)) {
          this.stop(id, 'evicted');
        }
      } else {
        this.#deps.store.record(
          makeEvent('env.evicted', `${id} 被 LRU 回收（同时运行上限 ${this.#maxRunning}）`, 'system', id),
        );
        this.stop(id, 'evicted');
      }
    }
  }

  /** 记下「现在哪些环境在跑」，供崩溃恢复用（同步写，退出路径也靠它）。 */
  rememberRunning(): void {
    this.#deps.store.saveRunning({
      running: [...this.#spaces.keys()],
      selected: this.#deps.getSelectedId(),
      dormant: [...this.#dormant],
    });
  }

  /** 把当前标签组写进库（同一组只写一次；`force` 用于停环境/退出前补最后一笔）。 */
  rememberTabs(id: string, options: { force?: boolean } = {}): void {
    if (this.#waking.has(id)) return;
    const spaces = this.#spaces.get(id);
    if (!spaces) return;
    const list = SPACE_IDS.flatMap((space) => spaces[space].list().filter((tab) => tab.url));
    const snapshot = list.map((tab) => `${tab.space}:${tab.active ? '*' : ''}${tab.url}`).join('\n');
    if (!options.force && this.#tabSnapshot.get(id) === snapshot) return;
    this.#tabSnapshot.set(id, snapshot);
    this.#deps.store.saveTabs(
      id,
      list.map((tab) => ({ space: tab.space, url: tab.url, active: tab.active })),
    );
  }

  /**
   * 崩溃恢复：把上次退出时还在跑的环境重新拉起来。
   *
   * 起不来的（配置没了 / 代理挂了）只记一条事件就跳过，绝不挡住启动。
   */
  async restoreRunning(ids: string[], selected?: string): Promise<string[]> {
    const restored: string[] = [];
    for (const id of ids) {
      // 休眠中的环境不在这里拉起：它会在第一次被用到时由 wake() 透明复活
      if (this.#dormant.has(id)) continue;
      if (!this.#deps.store.configFor(id) || this.#spaces.has(id)) continue;
      try {
        await this.start(id);
        restored.push(id);
      } catch (error) {
        this.#deps.store.record(
          makeEvent('env.restoreFailed', `${id} 恢复失败：${(error as Error).message}`, 'system', id),
        );
      }
    }
    if (selected && this.#spaces.has(selected)) this.#deps.selectEnv(selected);
    return restored;
  }

  shutdown(): void {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
    this.#deps.destroyAllDevTools();
    for (const id of [...this.#spaces.keys()]) this.stop(id, 'shutdown');
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  /** 正在加载 / 有声音 / 录 HAR / 回放的环境不能休眠。 */
  #isBusy(id: string): boolean {
    const spaces = this.#spaces.get(id);
    if (!spaces) return false;
    const tabs = SPACE_IDS.flatMap((space) => spaces[space].list());
    if (tabs.some((tab) => tab.loading || tab.audible)) return true;
    return this.#deps.isNetBusy(id);
  }

  /**
   * 按标签快照建出真正的 WebContentsView。同步：透明唤醒要塞进所有同步 RPC 入口，
   * 不能把 120 个 case 都改成 await。session / 代理 / 扩展由调用方先准备好。
   */
  #materialize(
    id: string,
    config: EnvironmentConfig,
    ses: Session,
    trustedCa: X509Certificate | undefined,
  ): Tab | undefined {
    const pending = new EnvPending();
    this.#pending.set(id, pending);
    this.#deps.wireDownloads(ses, id, (envId) => this.#pending.get(envId));

    const spaces: EnvironmentSpaces = {
      person: this.#deps.createSpaceManager(id, 'person', ses, trustedCa, pending),
      agent: this.#deps.createSpaceManager(id, 'agent', ses, trustedCa, pending),
      active: 'person',
    };
    this.#spaces.set(id, spaces);
    this.#deps.attachSessionTelemetry(ses);

    const remembered = this.#deps.store.tabsFor(id).filter((tab) => tab.url);
    let first: Tab | undefined;
    for (const space of SPACE_IDS) {
      const list = remembered.filter((tab) => tab.space === space);
      if (!list.length) continue;
      const activeIndex = Math.max(
        0,
        list.findIndex((tab) => tab.active),
      );
      for (let index = 0; index < list.length; index += 1) {
        const isActive = index === activeIndex;
        const canLazy = this.#lazyRestoreTabs && typeof spaces[space].createSleeping === 'function';
        if (canLazy && (space !== spaces.active || !isActive)) {
          // 惰性恢复：后台标签与未显示 Space 的历史标签仅占位不建渲染进程，切换或操作时透明加载
          spaces[space].createSleeping({
            url: list[index].url,
            activate: isActive,
            materializeIfActive: false,
          });
        } else {
          const tab = spaces[space].create({ url: list[index].url, activate: isActive });
          first ??= tab;
        }
      }
    }
    // Person Space 始终至少有一个入口；Agent Space 则等 agent 第一次操作时再懒建。
    if (spaces.person.size === 0) {
      first = spaces.person.create({ url: config.startUrl ?? this.#deps.newTabUrl(id) });
    }
    return first;
  }

  /** stop 与 hibernate 共用的运行时销毁段。 */
  #teardownSpaces(id: string, spaces: EnvironmentSpaces, options: { hibernating: boolean }): void {
    // 停之前记最后一笔：`env stop` / `hibernate` → 再拉起时要把这一组标签开回来
    this.rememberTabs(id, { force: true });
    this.#tabSnapshot.delete(id);

    // 先摘网络拦截：session 之后可能被复用，留着 handler 会继续拦真实请求
    this.#deps.detachNet(id);

    if (options.hibernating) this.#hibernating.add(id);
    if (this.#deps.getSelectedId() === id) {
      spaces[spaces.active].detach();
    }
    spaces.person.destroy();
    spaces.agent.destroy();
    this.#deps.closeEnvDevTools(spaces);
    if (options.hibernating) this.#hibernating.delete(id);

    this.#spaces.delete(id);
    this.#deps.clearLeaseAndShield(id);

    // 临时下载区只活到环境停止或休眠（`saveAs` 必须在本脚本内调用）
    this.#pending.delete(id);
    rmSync(path.join(os.tmpdir(), 'warren-downloads', safeEnvKey(id)), { recursive: true, force: true });

    this.#deps.detachTelemetry(id);
  }
}
