/**
 * 插件生命周期管理：启停、热重载、激活/销毁、崩溃状态与指数退避重连、事件订阅强清理。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EnvironmentManager } from '../environments';
import type { Store } from '../store';
import type { VaultStore } from '../vault/store';
import { pluginAutoApproves } from '../domain/approval.ts';
import { createHandlers, dispatchHostCall, type HostHandler } from './api/index.ts';
import { currentEnvironmentId, currentLeaseId, runWithPluginContext } from './call-context.ts';
import type { PluginEventBus } from './event-bus.ts';
import { hashPluginDir, pluginError } from './installer.ts';
import { tierOf, type Permission, type PluginPackage } from './package.ts';
import type { PluginState } from './registry.ts';
import {
  HOST_BOOTSTRAP,
  HostRuntime,
  SANDBOX_BOOTSTRAP,
  SandboxRuntime,
  type LogLevel,
  type PluginCrashInfo,
  type PluginRuntimeAdapter,
} from './runtime.ts';
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

const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const CRASH_RESET_WINDOW_MS = 60_000;

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
  #disposed = false;

  constructor(deps: LifecycleDeps) {
    this.#deps = deps;
    this.#hostBootstrapPath = path.join(deps.root, '.runtime', 'host-bootstrap.mjs');
    this.#sandboxBootstrapPath = path.join(deps.root, '.runtime', 'sandbox-bootstrap.mjs');
  }

  async ensureBootstraps(): Promise<void> {
    await mkdir(path.dirname(this.#hostBootstrapPath), { recursive: true });
    await writeFile(this.#hostBootstrapPath, HOST_BOOTSTRAP);
    await writeFile(this.#sandboxBootstrapPath, SANDBOX_BOOTSTRAP);
  }

  async activateAll(enabledIds: string[]): Promise<void> {
    // 开机时把「已启用」的插件重新激活一次：状态要反映现实，不能停在「已启用但没跑」
    for (const id of [...enabledIds]) {
      try {
        await this.activate(await this.#deps.readPackage(id));
      } catch (error) {
        this.#status.set(id, { status: 'error', detail: (error as Error).message });
      }
    }
  }

  activeOf(id: string): ActivePlugin | undefined {
    return this.#active.get(id);
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
    this.#clearReconnectTimer(id);
    this.#crashed.delete(id);
    this.#crashHistory.delete(id);
    const pkg = await this.#deps.readPackage(id);
    const state = this.#deps.getState();
    if (!state.enabled.includes(id)) state.enabled.push(id);
    await this.#deps.saveState();
    await this.activate(pkg);
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
    this.#clearReconnectTimer(id);
    this.#crashed.delete(id);
    this.#crashHistory.delete(id);
    this.#deps.eventBus.unsubscribePlugin(id);
    await this.deactivate(id);
    const state = this.#deps.getState();
    state.enabled = state.enabled.filter((entry) => entry !== id);
    await this.#deps.saveState();
    if (this.#status.has(id)) this.#status.set(id, { status: 'disabled' });
    this.#deps.onChange();
  }

  /** 重载：候选先起，成功再替换；失败保留旧实例，同时保证旧实例全部事件订阅被彻底回收。 */
  async reload(id: string): Promise<InstalledPlugin> {
    this.#clearReconnectTimer(id);
    const pkg = await this.#deps.readPackage(id);
    const previous = this.#active.get(id);
    const candidateInstanceId = crypto.randomUUID();
    let candidate: ActivePlugin;
    try {
      candidate = await this.#createActive(pkg, candidateInstanceId);
    } catch (error) {
      this.#deps.eventBus.unsubscribeInstance(id, candidateInstanceId);
      const err = error as Error & { code?: string };
      this.#status.set(id, {
        status: previous ? 'running' : isNeedsConfiguration(error) ? 'needs-configuration' : 'error',
        detail: previous ? `重载失败，保留旧实例: ${err.message}` : err.message,
      });
      await this.#deps.log(id, 'error', `reload 失败${previous ? '，保留旧实例' : ''}: ${err.message}`);
      this.#deps.onChange();
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
    this.#clearReconnectTimer(id);
    this.#crashed.delete(id);
    this.#crashHistory.delete(id);
    const pkg = await this.#deps.readPackage(id);
    if (!this.#deps.getState().enabled.includes(id)) {
      pluginError('PLUGIN_DISABLED', `插件 ${id} 未启用`);
    }
    await this.deactivate(id);
    await this.activate(pkg);
    this.#deps.onChange();
    return this.#deps.decorate(pkg, this.#deps.dirFor(id));
  }

  async activate(pkg: PluginPackage): Promise<void> {
    const id = pkg.id;
    const instanceId = crypto.randomUUID();
    try {
      const active = await this.#createActive(pkg, instanceId);
      this.#crashed.delete(id);
      this.#active.set(id, active);
      this.#status.set(id, { status: 'running' });
      await this.#deps.log(id, 'info', `activated (runtime ${pkg.runtime})`);
    } catch (error) {
      this.#deps.eventBus.unsubscribeInstance(id, instanceId);
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
    for (const timer of this.#reconnectTimers.values()) clearTimeout(timer);
    this.#reconnectTimers.clear();
    const ids = [...this.#active.keys()];
    await Promise.allSettled(ids.map((id) => this.deactivate(id)));
  }

  async #createActive(pkg: PluginPackage, instanceId: string): Promise<ActivePlugin> {
    const id = pkg.id;
    const dir = this.#deps.dirFor(id);
    let storageToClose: PluginStorage | undefined;
    try {
      const recorded = this.#deps.getState().installs[id]?.digest;
      const actual = await hashPluginDir(dir);
      if (recorded && recorded !== actual) {
        throw Object.assign(new Error('插件目录内容与安装时不一致（摘要不符），请重新安装'), {
          code: 'PLUGIN_DIGEST_MISMATCH',
        });
      }

      const storage = new PluginStorage({ dir, pluginId: id, db: this.#deps.db });
      storageToClose = storage;
      await storage.load();
      const settings = await this.#deps.settingsFor(id, pkg);

      const handlers = createHandlers({
        pluginId: id,
        currentEnvironmentId,
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
            runWithPluginContext({ pluginId: id, environmentId: context.environmentId, leaseId: context.leaseId }, () =>
              dispatchHostCall(handlers, callPath, args),
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
            runWithPluginContext({ pluginId: id, environmentId: context.environmentId, leaseId: context.leaseId }, () =>
              dispatchHostCall(handlers, callPath, args),
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

      await adapter.start();
      return activeRef;
    } catch (error) {
      storageToClose?.close();
      throw error;
    }
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
    const pkg = await this.#deps.readPackage(id);
    if (!this.#deps.getState().enabled.includes(id)) return;
    await this.deactivate(id);
    await this.activate(pkg);
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
