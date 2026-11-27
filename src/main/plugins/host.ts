/**
 * 插件宿主门面：组合安装器、生命周期、调用调度与只读事件总线。
 *
 * 外部调用方（`main.ts`、`rpc-dispatch.ts`、测试）只依赖本门面。
 */
import { mkdir } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { EnvironmentManager } from '../environments';
import type { Store } from '../store';
import type { VaultStore } from '../vault/store';
import { PluginEventBus } from './event-bus.ts';
import { PluginInstaller } from './installer.ts';
import { PluginInvoker, type RunResult } from './invoker.ts';
import { PluginLifecycle } from './lifecycle.ts';
import type { Permission } from '../../shared/permissions.ts';
import { loadPluginState, savePluginState, type PluginState } from './registry.ts';
import type { PluginSkillEntry } from '../skills/composer.ts';
import type {
  InstalledPlugin,
  PluginLogEntry,
  PluginRpcCaller,
  PluginRpcResponse,
  PluginSettingDescriptor,
  PluginSkillDocument,
  PluginStatus,
} from '../../shared/types.ts';

export type { InstalledPlugin, RunResult };

export class PluginHost {
  #root: string;
  #db: DatabaseSync;
  #state: PluginState = { enabled: [], granted: {}, installs: {} };
  #eventBus: PluginEventBus;
  #lifecycle: PluginLifecycle;
  #installer: PluginInstaller;
  #invoker: PluginInvoker;

  constructor(options: {
    root: string;
    manager: EnvironmentManager;
    vault: VaultStore;
    store: Store;
    /** 共享连接（`warren.db`）：注册表 / kv / 设置 / 日志都在这一个库上 */
    db: DatabaseSync;
    saveVault: () => Promise<void>;
    appVersion?: string;
    onSignal?: (pluginId: string, channel: string, payload: unknown) => void;
    /** 插件集合或状态变了：渲染层要重取清单（CLI 改的也要通知到界面） */
    onChange?: () => void;
    reconnectBaseMs?: number;
    maxReconnectAttempts?: number;
  }) {
    this.#root = options.root;
    this.#db = options.db;
    const onSignal = options.onSignal ?? (() => {});
    const onChange = options.onChange ?? (() => {});
    const getState = () => this.#state;
    const saveState = async () => {
      savePluginState(this.#db, this.#state);
    };

    this.#eventBus = new PluginEventBus((pluginId, subscriptionId, event) => {
      const active = this.#lifecycle.activeOf(pluginId);
      if (!active || active.disposed) return;
      active.adapter.notifyEvent?.(subscriptionId, event);
    });

    this.#installer = new PluginInstaller({
      root: options.root,
      vault: options.vault,
      store: options.store,
      db: options.db,
      saveVault: options.saveVault,
      appVersion: options.appVersion ?? '0.1.0',
      getState,
      saveState,
      statusOf: (id) => this.#lifecycle.statusOf(id),
      setStatus: (id, status) => this.#lifecycle.setStatus(id, status),
      deleteStatus: (id) => this.#lifecycle.deleteStatus(id),
      disable: (id) => this.disable(id),
      activate: (pkg) => this.#lifecycle.activate(pkg),
      reload: (id) => this.reload(id),
      onChange,
    });

    this.#lifecycle = new PluginLifecycle({
      root: options.root,
      manager: options.manager,
      vault: options.vault,
      store: options.store,
      db: options.db,
      eventBus: this.#eventBus,
      getState,
      saveState,
      readPackage: (id) => this.#installer.readPackage(id),
      settingsFor: (id, pkg) => this.#installer.settingsFor(id, pkg),
      decorate: (pkg, dir) => this.#installer.decorate(pkg, dir),
      dirFor: (id) => this.#installer.dirFor(id),
      log: (id, level, message) => this.#invoker.log(id, level, message),
      onSignal,
      onChange,
      reconnectBaseMs: options.reconnectBaseMs,
      maxReconnectAttempts: options.maxReconnectAttempts,
    });

    this.#invoker = new PluginInvoker({
      db: options.db,
      manager: options.manager,
      store: options.store,
      getState,
      readPackage: (id) => this.#installer.readPackage(id),
      activeOf: (id) => this.#lifecycle.activeOf(id),
      statusOf: (id) => this.#lifecycle.statusOf(id),
      setStatus: (id, status) => this.#lifecycle.setStatus(id, status),
      requirePermission: (id, permission) => this.#lifecycle.requirePermission(id, permission),
      waitReady: (id) => this.#lifecycle.waitReady(id),
    });
  }

  /** 第一阶段（毫秒级）：准备目录、读注册表并把已启用插件标为 starting，不阻塞窗口或 IPC。 */
  async loadState(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    this.#state = await loadPluginState(this.#db);
    this.#lifecycle.markStarting(this.#state.enabled);
  }

  /** 第二阶段：后台有界并发激活全部已启用插件。 */
  async activateEnabled(options?: { concurrency?: number; notify?: boolean }): Promise<void> {
    await this.#lifecycle.ensureBootstraps();
    await this.#lifecycle.activateAll(this.#state.enabled, options);
  }

  /** 兼容同步入口（单测/CLI 测试）：两阶段串联完成全部已启用插件激活。 */
  async load(): Promise<void> {
    await this.loadState();
    await this.activateEnabled({ notify: false });
  }

  /** 若指定插件正在后台激活中，等待（并在队列中优先插队）其激活完成。 */
  async waitReady(id: string): Promise<void> {
    await this.#lifecycle.waitReady(id);
  }

  async logs(id: string, limit = 200): Promise<PluginLogEntry[]> {
    return this.#invoker.logs(id, limit);
  }

  async list(): Promise<InstalledPlugin[]> {
    return this.#installer.list();
  }

  /** 安装一个 path / npm / git 包。默认 disabled，必须显式 enable。 */
  async install(source: string): Promise<InstalledPlugin> {
    return this.#installer.install(source);
  }

  /** 按安装时记录的来源重新解析、安装；启用中的插件失败会回滚到旧版本。 */
  async update(id: string): Promise<InstalledPlugin> {
    return this.#installer.update(id);
  }

  async uninstall(id: string): Promise<void> {
    return this.#installer.uninstall(id);
  }

  async enable(id: string): Promise<InstalledPlugin> {
    return this.#lifecycle.enable(id);
  }

  async disable(id: string): Promise<void> {
    return this.#lifecycle.disable(id);
  }

  /** 重载：候选先起，成功再替换；失败保留旧实例。 */
  async reload(id: string): Promise<InstalledPlugin> {
    return this.#lifecycle.reload(id);
  }

  async reconnect(id: string): Promise<InstalledPlugin> {
    return this.#lifecycle.reconnect(id);
  }

  async dispose(): Promise<void> {
    return this.#lifecycle.dispose();
  }

  /** 用户批准 confirm 级权限 */
  async grant(id: string, permissions: Permission[]): Promise<InstalledPlugin> {
    return this.#installer.grant(id, permissions);
  }

  async setSetting(id: string, key: string, value: string): Promise<InstalledPlugin> {
    return this.#installer.setSetting(id, key, value);
  }

  async settingDescriptors(id: string): Promise<PluginSettingDescriptor[]> {
    return this.#installer.settingDescriptors(id);
  }

  async setSkillExposed(id: string, exposed: boolean): Promise<InstalledPlugin> {
    return this.#installer.setSkillExposed(id, exposed);
  }

  async readSkill(id: string): Promise<PluginSkillDocument> {
    return this.#installer.readSkill(id);
  }

  async skillEntries(): Promise<PluginSkillEntry[]> {
    return this.#installer.listSkillEntries();
  }

  /** 命令：一次性调用（v1 兼容）。 */
  async run(
    id: string,
    command: string,
    options: { environmentId?: string; input?: unknown; leaseId?: string; caller?: PluginRpcCaller },
  ): Promise<RunResult> {
    return this.#invoker.run(id, command, options);
  }

  async rpc(
    id: string,
    method: string,
    input: unknown,
    options: { leaseId?: string; environmentId?: string; caller?: PluginRpcCaller } = {},
  ): Promise<PluginRpcResponse> {
    return this.#invoker.rpc(id, method, input, options);
  }

  async hostRead(
    id: string,
    method: string,
    environmentId: string | undefined,
    args: unknown[],
  ): Promise<PluginRpcResponse> {
    return this.#invoker.hostRead(id, method, environmentId, args);
  }

  statusOf(id: string): { status: PluginStatus; detail?: string } {
    return this.#lifecycle.statusOf(id);
  }

  isCrashed(id: string): boolean {
    return this.#lifecycle.isCrashed(id);
  }

  dispatchEvent(event: { type: string; environmentId: string; at: string; payload: Record<string, unknown> }): void {
    this.#eventBus.dispatchEvent(event);
  }

  subscriptionCount(pluginId?: string): number {
    return this.#eventBus.subscriptionCount(pluginId);
  }
}
