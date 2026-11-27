/**
 * 插件生命周期管理：启停、热重载、激活/销毁、崩溃状态与指数退避重连、事件订阅强清理。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EnvironmentManager } from '../environments';
import type { Store } from '../store';
import type { VaultStore } from '../vault/store';
import { pluginAutoApproves } from '../domain/approval.ts';
import { createHandlers, dispatchHostCall } from './api/index.ts';
import type { HostHandler } from './api/types.ts';
import { currentCaller, currentEnvironmentId, currentLeaseId, runWithPluginContext } from './call-context.ts';
import type { PluginEventBus } from './event-bus.ts';
import { hashPluginDir, pluginError } from './installer.ts';
import { tierOf, type Permission } from '../../shared/permissions.ts';
import type { PluginPackage } from './package.ts';
import type { PluginState } from './registry.ts';
import type { LogLevel, PluginCrashInfo, PluginRuntimeAdapter } from './runtime-base.ts';
import { HOST_BOOTSTRAP, HostRuntime } from './runtime-host.ts';
import { SANDBOX_BOOTSTRAP, SandboxRuntime } from './runtime-sandbox.ts';
import type { PluginSettings } from './settings.ts';
import { PluginStorage } from './storage.ts';
import type { InstalledPlugin, PluginStatus } from '../../shared/types.ts';

export interface ActivePlugin {
  instanceId: string;
  adapter: PluginRuntimeAdapter;
  storage: PluginStorage;
  settings: PluginSettings;
  handlers: Record<string, HostHandler>;
  startedAt: number;
  disposed: boolean;
}

export interface CrashRecord {
  count: number;
  lastAt: number;
  reason: 'timeout' | 'exit';
  message: string;
}

export function isNeedsConfiguration(error: unknown): boolean {
  return (error as { name?: string })?.name === 'NeedsConfigurationError';
}

class CancelledActivationError extends Error {
  constructor() {
    super('activation cancelled');
    this.name = 'CancelledActivationError';
  }
}

const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const CRASH_RESET_WINDOW_MS = 60_000;
const DEFAULT_ACTIVATE_CONCURRENCY = 4;
const BATCH_NOTIFY_DEBOUNCE_MS = 80;

export interface LifecycleDeps {
  root: string;
  manager: EnvironmentManager;
  vault: VaultStore;
  store: Store;
  db: DatabaseSync;
  eventBus: PluginEventBus;
  getState: () => PluginState;
  saveState: () => Promise<void>;
  readPackage: (id: string) => Promise<PluginPackage>;
  settingsFor: (id: string, pkg?: PluginPackage) => Promise<PluginSettings>;
  decorate: (pkg: PluginPackage, dir: string) => Promise<InstalledPlugin>;
  dirFor: (id: string) => string;
  log: (id: string, level: LogLevel, message: string) => Promise<void>;
  onSignal: (pluginId: string, channel: string, payload: unknown) => void;
  onChange: () => void;
  reconnectBaseMs?: number;
  maxReconnectAttempts?: number;
}

export class PluginLifecycle {
  #deps: LifecycleDeps;
  #hostBootstrapPath: string;
  #sandboxBootstrapPath: string;
  #active = new Map<string, ActivePlugin>();
  #status = new Map<string, { status: PluginStatus; detail?: string }>();
  #crashed = new Map<string, CrashRecord>();
  #crashHistory = new Map<string, { count: number; lastAt: number }>();
  #reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #bootstrapsPromise?: Promise<void>;
  #epoch = new Map<string, number>();
  #activating = new Map<string, Promise<void>>();
  #pendingQueue: string[] = [];
  #pendingSet = new Set<string>();
  #batchRunner?: (id: string) => Promise<void>;
  #notifyTimer?: ReturnType<typeof setTimeout>;
  #notifyDirty = false;
  #disposed = false;

  constructor(deps: LifecycleDeps) {
    this.#deps = deps;
    this.#hostBootstrapPath = path.join(deps.root, '.runtime', 'host-bootstrap.mjs');
    this.#sandboxBootstrapPath = path.join(deps.root, '.runtime', 'sandbox-bootstrap.mjs');
  }

  /** 进程内幂等写入两份 worker bootstrap，避免每个插件激活反复覆盖写盘。 */
  async ensureBootstraps(): Promise<void> {
    if (!this.#bootstrapsPromise) {
      this.#bootstrapsPromise = (async () => {
        await mkdir(path.dirname(this.#hostBootstrapPath), { recursive: true });
        await Promise.all([
          writeFile(this.#hostBootstrapPath, HOST_BOOTSTRAP),
          writeFile(this.#sandboxBootstrapPath, SANDBOX_BOOTSTRAP),
        ]);
      })().catch((error) => {
        this.#bootstrapsPromise = undefined;
        throw error;
      });
    }
    return this.#bootstrapsPromise;
  }

  /** 注册表读完后先把已启用插件标为 starting，避免在后台激活完成前误显示为 disabled。 */
  markStarting(enabledIds: string[]): void {
    for (const id of enabledIds) {
      if (!this.#active.has(id)) {
        this.#status.set(id, { status: 'starting' });
      }
    }
  }

  async activateAll(enabledIds: string[], options: { concurrency?: number; notify?: boolean } = {}): Promise<void> {
    const enabledSet = new Set(this.#deps.getState().enabled);
    const ids = [...new Set(enabledIds)].filter((id) => enabledSet.has(id) && !this.#active.has(id));
    if (ids.length === 0 || this.#disposed) return;

    this.markStarting(ids);
    const notify = options.notify === true;
    const cpuCount = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length || 4;
    const requested = options.concurrency ?? DEFAULT_ACTIVATE_CONCURRENCY;
    const concurrency = Math.max(1, Math.min(requested, cpuCount, ids.length));

    for (const id of ids) {
      if (!this.#activating.has(id) && !this.#pendingSet.has(id)) {
        this.#pendingSet.add(id);
        this.#pendingQueue.push(id);
      }
    }

    const runOne = (id: string): Promise<void> => {
      const existing = this.#activating.get(id);
      if (existing) return existing;
      this.#removeFromQueue(id);
      if (this.#disposed || this.#active.has(id) || !this.#deps.getState().enabled.includes(id)) {
        return Promise.resolve();
      }
      const epoch = this.#currentEpoch(id);
      let task: Promise<void> | undefined;
      task = (async () => {
        try {
          const pkg = await this.#deps.readPackage(id);
          if (this.#disposed || this.#currentEpoch(id) !== epoch || !this.#deps.getState().enabled.includes(id)) {
            return;
          }
          await this.#activateWithEpoch(pkg, epoch);
        } catch (error) {
          if (error instanceof CancelledActivationError) return;
          if (!this.#disposed && this.#currentEpoch(id) === epoch && this.#deps.getState().enabled.includes(id)) {
            this.#status.set(id, { status: 'error', detail: (error as Error).message });
          }
        } finally {
          if (this.#activating.get(id) === task) this.#activating.delete(id);
          if (notify && !this.#disposed && this.#deps.getState().enabled.includes(id)) {
            this.#scheduleBatchNotify();
          }
        }
      })();
      this.#activating.set(id, task);
      return task;
    };

    this.#batchRunner = runOne;
    try {
      const workers = Array.from({ length: concurrency }, async () => {
        while (!this.#disposed) {
          const nextId = this.#pendingQueue.shift();
          if (!nextId) break;
          this.#pendingSet.delete(nextId);
          await runOne(nextId);
        }
      });
      await Promise.allSettled(workers);
      // 兜底等待被 waitReady() 提前插队拉起的同批次任务全部收尾
      const remaining = ids.map((id) => this.#activating.get(id)).filter((p): p is Promise<void> => Boolean(p));
      if (remaining.length > 0) await Promise.allSettled(remaining);
    } finally {
      if (this.#batchRunner === runOne) this.#batchRunner = undefined;
      if (notify) this.#flushBatchNotify();
    }
  }

  /** 若插件正在后台排队或激活中，等待其就绪；仍在队列里时立即插队拉起。 */
  async waitReady(id: string): Promise<void> {
    if (this.#disposed || this.#active.has(id)) return;
    const inflight = this.#activating.get(id);
    if (inflight) {
      await inflight;
      return;
    }
    if (this.#pendingSet.has(id) && this.#batchRunner) {
      this.#removeFromQueue(id);
      await this.#batchRunner(id);
      return;
    }
    // 处于 loadState() 与 activateEnabled() 之间的极窄窗口：按需直接激活并登记到 #activating
    if (this.#deps.getState().enabled.includes(id) && this.#status.get(id)?.status === 'starting') {
      const epoch = this.#currentEpoch(id);
      let task: Promise<void> | undefined;
      task = (async () => {
        try {
          await this.ensureBootstraps();
          const pkg = await this.#deps.readPackage(id);
          if (this.#disposed || this.#currentEpoch(id) !== epoch || !this.#deps.getState().enabled.includes(id)) {
            return;
          }
          await this.#activateWithEpoch(pkg, epoch);
        } catch (error) {
          if (error instanceof CancelledActivationError) return;
          if (!this.#disposed && this.#currentEpoch(id) === epoch && this.#deps.getState().enabled.includes(id)) {
            this.#status.set(id, { status: 'error', detail: (error as Error).message });
          }
        } finally {
          if (this.#activating.get(id) === task) this.#activating.delete(id);
        }
      })();
      this.#activating.set(id, task);
      await task;
    }
  }

  activeOf(id: string): ActivePlugin | undefined {
    return this.#active.get(id);
  }

  /** 返回指定已激活插件的工作进程 OS PID（用于内存归因）。 */
  pidOf(id: string): number | undefined {
    return this.#active.get(id)?.adapter.pid;
  }

  statusOf(id: string): { status: PluginStatus; detail?: string } {
    return this.#status.get(id) ?? { status: 'disabled' };
  }

  setStatus(id: string, status: { status: PluginStatus; detail?: string }): void {
    this.#status.set(id, status);
  }

  deleteStatus(id: string): void {
    this.#status.delete(id);
    this.#crashed.delete(id);
    this.#crashHistory.delete(id);
  }

  isCrashed(id: string): boolean {
    return this.#crashed.has(id);
  }

  crashOf(id: string): CrashRecord | undefined {
    return this.#crashed.get(id);
  }

  async enable(id: string): Promise<InstalledPlugin> {
    const epoch = this.#bumpEpoch(id);
    this.#removeFromQueue(id);
    this.#clearReconnectTimer(id);
    this.#crashed.delete(id);
    this.#crashHistory.delete(id);
    const inflight = this.#activating.get(id);
    if (inflight) await inflight.catch(() => undefined);
    await this.deactivate(id);
    const pkg = await this.#deps.readPackage(id);
    const state = this.#deps.getState();
    if (!state.enabled.includes(id)) state.enabled.push(id);
    await this.#deps.saveState();
    this.#status.set(id, { status: 'starting' });
    await this.#activateWithEpoch(pkg, epoch);
    this.#deps.onChange();
    this.#deps.store.record({
      id: crypto.randomUUID(),
      type: 'plugin.enabled',
      actor: 'human',
      message: `plugin ${id} enabled (${pkg.permissions.length} permissions, runtime ${pkg.runtime})`,
      createdAt: new Date().toISOString(),
    });
    return this.#deps.decorate(pkg, this.#deps.dirFor(id));
  }

  async disable(id: string): Promise<void> {
    this.#bumpEpoch(id);
    this.#removeFromQueue(id);
    this.#clearReconnectTimer(id);
    this.#crashed.delete(id);
    this.#crashHistory.delete(id);
    this.#deps.eventBus.unsubscribePlugin(id);
    const state = this.#deps.getState();
    state.enabled = state.enabled.filter((entry) => entry !== id);
    await this.#deps.saveState();
    const inflight = this.#activating.get(id);
    if (inflight) await inflight.catch(() => undefined);
    await this.deactivate(id);
    if (this.#status.has(id)) this.#status.set(id, { status: 'disabled' });
    this.#deps.onChange();
  }

  /** 重载：候选先起，成功再替换；失败保留旧实例，同时保证旧实例全部事件订阅被彻底回收。 */
  async reload(id: string): Promise<InstalledPlugin> {
    this.#clearReconnectTimer(id);
    const inflight = this.#activating.get(id);
    if (inflight) await inflight.catch(() => undefined);
    const epoch = this.#bumpEpoch(id);
    this.#removeFromQueue(id);
    const pkg = await this.#deps.readPackage(id);
    const previous = this.#active.get(id);
    const candidateInstanceId = crypto.randomUUID();
    let candidate: ActivePlugin;
    try {
      candidate = await this.#createActive(pkg, candidateInstanceId, epoch);
    } catch (error) {
      this.#deps.eventBus.unsubscribeInstance(id, candidateInstanceId);
      if (error instanceof CancelledActivationError) {
        return this.#deps.decorate(pkg, this.#deps.dirFor(id));
      }
      const err = error as Error & { code?: string };
      this.#status.set(id, {
        status: previous ? 'running' : isNeedsConfiguration(error) ? 'needs-configuration' : 'error',
        detail: previous ? `重载失败，保留旧实例: ${err.message}` : err.message,
      });
      await this.#deps.log(id, 'error', `reload 失败${previous ? '，保留旧实例' : ''}: ${err.message}`);
      this.#deps.onChange();
      return this.#deps.decorate(pkg, this.#deps.dirFor(id));
    }

    if (this.#disposed || this.#currentEpoch(id) !== epoch || !this.#deps.getState().enabled.includes(id)) {
      this.#deps.eventBus.unsubscribeInstance(id, candidateInstanceId);
      await this.#disposeActive(id, candidate);
      return this.#deps.decorate(pkg, this.#deps.dirFor(id));
    }

    this.#crashed.delete(id);
    this.#crashHistory.delete(id);
    this.#active.set(id, candidate);
    this.#status.set(id, { status: 'running' });
    // 强不变量：清除旧实例/历史遗留的全部订阅，仅保留本次重载成功后的新实例订阅
    this.#deps.eventBus.clearExceptInstance(id, candidate.instanceId);
    if (previous) await this.#disposeActive(id, previous);
    await this.#deps.log(id, 'info', `reloaded (runtime ${pkg.runtime})`);
    this.#deps.onChange();
    return this.#deps.decorate(pkg, this.#deps.dirFor(id));
  }

  /** 手动或退避重连已崩溃的插件。 */
  async reconnect(id: string): Promise<InstalledPlugin> {
    const epoch = this.#bumpEpoch(id);
    this.#removeFromQueue(id);
    this.#clearReconnectTimer(id);
    this.#crashed.delete(id);
    this.#crashHistory.delete(id);
    const inflight = this.#activating.get(id);
    if (inflight) await inflight.catch(() => undefined);
    const pkg = await this.#deps.readPackage(id);
    if (!this.#deps.getState().enabled.includes(id)) {
      pluginError('PLUGIN_DISABLED', `插件 ${id} 未启用`);
    }
    await this.deactivate(id);
    this.#status.set(id, { status: 'starting' });
    await this.#activateWithEpoch(pkg, epoch);
    this.#deps.onChange();
    return this.#deps.decorate(pkg, this.#deps.dirFor(id));
  }

  async activate(pkg: PluginPackage): Promise<void> {
    await this.#activateWithEpoch(pkg, this.#currentEpoch(pkg.id));
  }

  async #activateWithEpoch(pkg: PluginPackage, expectedEpoch: number): Promise<void> {
    const id = pkg.id;
    if (this.#disposed || this.#currentEpoch(id) !== expectedEpoch || !this.#deps.getState().enabled.includes(id)) {
      return;
    }
    const instanceId = crypto.randomUUID();
    try {
      const active = await this.#createActive(pkg, instanceId, expectedEpoch);
      if (this.#disposed || this.#currentEpoch(id) !== expectedEpoch || !this.#deps.getState().enabled.includes(id)) {
        this.#deps.eventBus.unsubscribeInstance(id, instanceId);
        await this.#disposeActive(id, active);
        return;
      }
      const previous = this.#active.get(id);
      this.#crashed.delete(id);
      this.#active.set(id, active);
      this.#status.set(id, { status: 'running' });
      if (previous && previous !== active) await this.#disposeActive(id, previous);
      await this.#deps.log(id, 'info', `activated (runtime ${pkg.runtime})`);
    } catch (error) {
      this.#deps.eventBus.unsubscribeInstance(id, instanceId);
      if (error instanceof CancelledActivationError) return;
      if (this.#disposed || this.#currentEpoch(id) !== expectedEpoch || !this.#deps.getState().enabled.includes(id)) {
        return;
      }
      const err = error as Error & { code?: string };
      const needsConfiguration = isNeedsConfiguration(error);
      this.#status.set(id, {
        status: needsConfiguration ? 'needs-configuration' : 'error',
        detail: err.message,
      });
      await this.#deps.log(id, needsConfiguration ? 'warn' : 'error', `激活失败: ${err.message}`);
      this.#deps.store.record({
        id: crypto.randomUUID(),
        type: 'plugin.failed',
        actor: 'system',
        message: `[${id}] 激活失败: ${err.message}`,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async deactivate(id: string): Promise<void> {
    this.#clearReconnectTimer(id);
    this.#deps.eventBus.unsubscribePlugin(id);
    const active = this.#active.get(id);
    if (!active) return;
    this.#active.delete(id);
    await this.#disposeActive(id, active);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#clearNotifyTimer();
    this.#pendingQueue.length = 0;
    this.#pendingSet.clear();
    for (const timer of this.#reconnectTimers.values()) clearTimeout(timer);
    this.#reconnectTimers.clear();
    // 等待所有进行中的后台激活检测到 disposed 并销毁其刚起的子进程，杜绝孤儿进程泄漏
    const inflight = [...this.#activating.values()];
    if (inflight.length > 0) await Promise.allSettled(inflight);
    const ids = [...this.#active.keys()];
    await Promise.allSettled(ids.map((id) => this.deactivate(id)));
  }

  async #createActive(pkg: PluginPackage, instanceId: string, expectedEpoch: number): Promise<ActivePlugin> {
    const id = pkg.id;
    const dir = this.#deps.dirFor(id);
    let storageToClose: PluginStorage | undefined;
    let adapterToDispose: PluginRuntimeAdapter | undefined;
    const assertAlive = (): void => {
      if (this.#disposed || this.#currentEpoch(id) !== expectedEpoch || !this.#deps.getState().enabled.includes(id)) {
        throw new CancelledActivationError();
      }
    };
    try {
      assertAlive();
      const recorded = this.#deps.getState().installs[id]?.digest;
      const actual = await hashPluginDir(dir);
      assertAlive();
      if (recorded && recorded !== actual) {
        throw Object.assign(new Error('插件目录内容与安装时不一致（摘要不符），请重新安装'), {
          code: 'PLUGIN_DIGEST_MISMATCH',
        });
      }

      const storage = new PluginStorage({ dir, pluginId: id, db: this.#deps.db });
      storageToClose = storage;
      await storage.load();
      const settings = await this.#deps.settingsFor(id, pkg);
      assertAlive();

      const handlers = createHandlers({
        pluginId: id,
        currentEnvironmentId,
        currentCaller,
        require: (permission) => this.requirePermission(id, permission),
        manager: this.#deps.manager,
        vault: this.#deps.vault,
        storage,
        settings,
        descriptors: pkg.contributes.settings,
        record: (type, message) => {
          this.#deps.store.record({
            id: crypto.randomUUID(),
            type,
            actor: 'agent',
            message: `[${id}] ${message}`,
            createdAt: new Date().toISOString(),
          });
        },
        log: (level, message) => void this.#deps.log(id, level, message),
        signal: (channel, payload) => this.#deps.onSignal(id, channel, payload),
        withLease: (envId, fn) => this.withLease(id, envId, fn, currentLeaseId()),
        subscribeEvents: (rawFilter) => this.#deps.eventBus.subscribe(id, rawFilter, instanceId),
        unsubscribeEvents: (subscriptionId) => {
          this.#deps.eventBus.unsubscribe(id, subscriptionId);
        },
      });

      const log = (level: LogLevel, message: string) => void this.#deps.log(id, level, message);
      let activeRef: ActivePlugin | undefined;
      const onCrash = (info: PluginCrashInfo) => {
        if (activeRef) this.#handleCrash(id, activeRef, info);
      };

      let adapter: PluginRuntimeAdapter;
      if (pkg.runtime === 'host') {
        if (!pkg.host) pluginError('PLUGIN_PACKAGE_INVALID', 'runtime=host 的插件必须声明 host 入口');
        await this.ensureBootstraps();
        adapter = new HostRuntime({
          pluginId: id,
          entryPath: path.join(dir, pkg.host),
          bootstrapPath: this.#hostBootstrapPath,
          log,
          onCrash,
          onHostCall: (callPath, args, context) =>
            runWithPluginContext(
              { pluginId: id, environmentId: context.environmentId, leaseId: context.leaseId, caller: context.caller },
              () => dispatchHostCall(handlers, callPath, args),
            ),
        });
      } else {
        if (!pkg.server) pluginError('PLUGIN_PACKAGE_INVALID', 'runtime=sandbox 的插件必须声明 server 入口');
        await this.ensureBootstraps();
        const entryPath = path.join(dir, pkg.server);
        const code = await readFile(entryPath, 'utf8');
        adapter = new SandboxRuntime({
          pluginId: id,
          entryPath,
          code,
          bootstrapPath: this.#sandboxBootstrapPath,
          log,
          onCrash,
          onHostCall: (callPath, args, context) =>
            runWithPluginContext(
              { pluginId: id, environmentId: context.environmentId, leaseId: context.leaseId, caller: context.caller },
              () => dispatchHostCall(handlers, callPath, args),
            ),
        });
      }

      activeRef = {
        instanceId,
        adapter,
        storage,
        settings,
        handlers,
        startedAt: Date.now(),
        disposed: false,
      };

      assertAlive();
      adapterToDispose = adapter;
      await adapter.start();
      assertAlive();
      adapterToDispose = undefined;
      return activeRef;
    } catch (error) {
      if (adapterToDispose) {
        await adapterToDispose.dispose().catch(() => undefined);
      }
      storageToClose?.close();
      throw error;
    }
  }

  #currentEpoch(id: string): number {
    return this.#epoch.get(id) ?? 0;
  }

  #bumpEpoch(id: string): number {
    const next = this.#currentEpoch(id) + 1;
    this.#epoch.set(id, next);
    return next;
  }

  #removeFromQueue(id: string): void {
    if (!this.#pendingSet.delete(id)) return;
    const index = this.#pendingQueue.indexOf(id);
    if (index >= 0) this.#pendingQueue.splice(index, 1);
  }

  #scheduleBatchNotify(): void {
    this.#notifyDirty = true;
    if (this.#notifyTimer) return;
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = undefined;
      this.#flushBatchNotify();
    }, BATCH_NOTIFY_DEBOUNCE_MS);
    this.#notifyTimer.unref();
  }

  #clearNotifyTimer(): void {
    if (this.#notifyTimer) {
      clearTimeout(this.#notifyTimer);
      this.#notifyTimer = undefined;
    }
    this.#notifyDirty = false;
  }

  #flushBatchNotify(): void {
    if (this.#notifyTimer) {
      clearTimeout(this.#notifyTimer);
      this.#notifyTimer = undefined;
    }
    if (!this.#notifyDirty || this.#disposed) return;
    this.#notifyDirty = false;
    this.#deps.onChange();
  }

  #handleCrash(id: string, instance: ActivePlugin, info: PluginCrashInfo): void {
    if (this.#disposed || this.#active.get(id) !== instance) return;
    instance.disposed = true;
    this.#active.delete(id);
    this.#deps.eventBus.unsubscribePlugin(id);
    instance.storage.close();

    const now = Date.now();
    const prev = this.#crashHistory.get(id);
    const ranHealthy = now - instance.startedAt >= CRASH_RESET_WINDOW_MS;
    const count = !prev || ranHealthy ? 1 : prev.count + 1;
    this.#crashHistory.set(id, { count, lastAt: now });
    this.#crashed.set(id, { count, lastAt: now, reason: info.reason, message: info.message });
    this.#status.set(id, { status: 'error', detail: info.message });

    void this.#deps.log(id, 'error', `插件进程崩溃（${info.reason}）: ${info.message}`);
    this.#deps.store.record({
      id: crypto.randomUUID(),
      type: 'plugin.failed',
      actor: 'system',
      message: `[${id}] 进程异常退出: ${info.message}`,
      createdAt: new Date().toISOString(),
    });
    this.#deps.onChange();

    const maxAttempts = this.#deps.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const baseMs = this.#deps.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    if (!this.#disposed && this.#deps.getState().enabled.includes(id) && count <= maxAttempts && baseMs > 0) {
      const delayMs = baseMs * 2 ** (count - 1);
      this.#clearReconnectTimer(id);
      const timer = setTimeout(() => {
        this.#reconnectTimers.delete(id);
        if (this.#disposed || !this.#deps.getState().enabled.includes(id)) return;
        void this.#autoReconnect(id).catch(() => undefined);
      }, delayMs);
      timer.unref();
      this.#reconnectTimers.set(id, timer);
    }
  }

  async #autoReconnect(id: string): Promise<void> {
    const epoch = this.#bumpEpoch(id);
    const pkg = await this.#deps.readPackage(id);
    if (!this.#deps.getState().enabled.includes(id)) return;
    await this.deactivate(id);
    this.#status.set(id, { status: 'starting' });
    await this.#activateWithEpoch(pkg, epoch);
    this.#deps.onChange();
  }

  #clearReconnectTimer(id: string): void {
    const timer = this.#reconnectTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.#reconnectTimers.delete(id);
  }

  async #disposeActive(id: string, active: ActivePlugin): Promise<void> {
    active.disposed = true;
    try {
      await active.adapter.dispose();
    } catch (error) {
      await this.#deps.log(id, 'warn', `dispose 失败: ${(error as Error).message}`);
    }
    active.storage.close();
  }

  /**
   * 这个能力此刻算不算已授予。
   * 审批策略是 `auto` 时，`confirm` 层当场放行 —— 不落库，切回 `ask` 立刻恢复拦截。
   */
  hasPermission(id: string, permission: Permission): boolean {
    if ((this.#deps.getState().granted[id] ?? []).includes(permission)) return true;
    return pluginAutoApproves(this.#deps.store.appSettings()) && tierOf(permission) === 'confirm';
  }

  requirePermission(id: string, permission: Permission): void {
    if (!this.hasPermission(id, permission)) {
      pluginError('PLUGIN_PERMISSION_DENIED', `插件 ${id} 没有 ${permission} 权限`);
    }
  }

  /** 写操作惰性取 lease：只读命令不再把控制权从人手里抢走。 */
  async withLease<T>(
    id: string,
    envId: string,
    fn: (leaseId: string) => Promise<T>,
    existingLeaseId?: string,
  ): Promise<T> {
    if (existingLeaseId) {
      this.#deps.manager.assertWritable(envId, existingLeaseId);
      return fn(existingLeaseId);
    }
    const lease = this.#deps.manager.acquire(envId, 'agent', `plugin:${id}`);
    try {
      return await fn(lease.leaseId);
    } finally {
      try {
        this.#deps.manager.release(envId, lease.leaseId, 'agent');
      } catch {
        // lease 可能已被 human 接管撤销
      }
    }
  }
}
