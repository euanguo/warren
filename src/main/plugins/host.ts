/**
 * 插件宿主：安装、启停、重载、状态、日志、RPC、信号。
 *
 * 每个插件在 `<coreDir>/plugins/<id>/` 下是一份完整的 npm 包（package.json / 入口 / 资源）；
 * 它的 `data.db`（插件自己的 SQLite）也在那里。
 *
 * 状态全在 `warren.db`：
 * - 注册表（enabled / granted / installs）→ `plugins`
 * - kv → `plugin_values` scope='kv'
 * - 设置 → `plugin_values` scope='setting'
 * - 日志 → `plugin_logs`
 */
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EnvironmentManager } from '../environments';
import type { Store } from '../store';
import type { VaultStore } from '../vault/store';
import {
  diffPermissions,
  needsUserConfirmation,
  satisfiesEngines,
  tierOf,
  validatePluginPackage,
  type Permission,
  type PluginPackage,
} from './package.ts';
import { PluginSettings } from './settings.ts';
import { PluginStorage } from './storage.ts';
import { pluginAutoApproves } from '../domain/approval.ts';
import { appendPluginLog, loadPluginState, readPluginLogs, savePluginState, type PluginState } from './registry.ts';
import { buildHostApi, createHandlers, dispatchHostCall, type HostHandler } from './api.ts';
import { currentEnvironmentId, currentLeaseId, runWithPluginContext } from './call-context.ts';
import { dispatchHostRead } from './host-read.ts';
import { HOST_BOOTSTRAP, HostRuntime, SandboxRuntime, type LogLevel, type PluginRuntimeAdapter } from './runtime.ts';
import { cleanupPreparedPlugin, movePreparedPlugin, preparePluginSource } from './source.ts';
import type {
  InstalledPlugin,
  PluginLogEntry,
  PluginRpcCaller,
  PluginRpcResponse,
  PluginSettingDescriptor,
  PluginStatus,
} from '../../shared/types.ts';

export type { InstalledPlugin };

/** 插件目录里的运行时数据：算摘要、卸载清理时按这个区分「代码」和「数据」 */
const RUNTIME_FILES = new Set(['data.db', 'data.db-wal', 'data.db-shm']);

function isRuntimeFile(name: string): boolean {
  return RUNTIME_FILES.has(name);
}

interface ActivePlugin {
  adapter: PluginRuntimeAdapter;
  storage: PluginStorage;
  settings: PluginSettings;
  handlers: Record<string, HostHandler>;
}

export interface RunResult {
  pluginId: string;
  command: string;
  result: unknown;
}

function pluginError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function isNeedsConfiguration(error: unknown): boolean {
  return (error as { name?: string })?.name === 'NeedsConfigurationError';
}

async function hashPluginDir(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(path.join(current, entry.name), relative);
        continue;
      }
      if (isRuntimeFile(entry.name)) continue;
      hash.update(relative);
      hash.update(await readFile(path.join(current, entry.name)));
    }
  };
  await walk(dir, '');
  return hash.digest('hex');
}

export class PluginHost {
  #root: string;
  #manager: EnvironmentManager;
  #vault: VaultStore;
  #store: Store;
  #db: DatabaseSync;
  #saveVault: () => Promise<void>;
  #state: PluginState = { enabled: [], granted: {}, installs: {} };
  #bootstrapPath: string;
  #active = new Map<string, ActivePlugin>();
  #status = new Map<string, { status: PluginStatus; detail?: string }>();
  #appVersion: string;
  #onSignal: (pluginId: string, channel: string, payload: unknown) => void;
  #onChange: () => void;

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
  }) {
    this.#root = options.root;
    this.#manager = options.manager;
    this.#vault = options.vault;
    this.#store = options.store;
    this.#db = options.db;
    this.#saveVault = options.saveVault;
    this.#appVersion = options.appVersion ?? '0.1.0';
    this.#onSignal = options.onSignal ?? (() => {});
    this.#onChange = options.onChange ?? (() => {});
    this.#bootstrapPath = path.join(options.root, '.runtime', 'host-bootstrap.mjs');
  }

  async load(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await mkdir(path.dirname(this.#bootstrapPath), { recursive: true });
    await writeFile(this.#bootstrapPath, HOST_BOOTSTRAP);
    this.#state = await loadPluginState(this.#db);
    // 开机时把「已启用」的插件重新激活一次：状态要反映现实，不能停在「已启用但没跑」
    for (const id of [...this.#state.enabled]) {
      try {
        await this.#activate(await this.#readPackage(id));
      } catch (error) {
        this.#status.set(id, { status: 'error', detail: (error as Error).message });
      }
    }
  }

  async #save(): Promise<void> {
    savePluginState(this.#db, this.#state);
  }

  #dirFor(id: string): string {
    return path.join(this.#root, id);
  }

  async #readPackage(id: string): Promise<PluginPackage> {
    const file = path.join(this.#dirFor(id), 'package.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      pluginError('PLUGIN_PACKAGE_MISSING', `读取 ${file} 失败`);
    }
    const validation = validatePluginPackage(raw);
    if (!validation.ok || !validation.package) {
      pluginError('PLUGIN_PACKAGE_INVALID', validation.errors.join('; '));
    }
    return validation.package;
  }

  async #log(id: string, level: LogLevel, message: string): Promise<void> {
    appendPluginLog(this.#db, id, level, message);
  }

  async logs(id: string, limit = 200): Promise<PluginLogEntry[]> {
    return readPluginLogs(this.#db, id, Math.max(1, Math.min(limit, 1000)));
  }

  async #settingsFor(id: string, pkg?: PluginPackage): Promise<PluginSettings> {
    const settings = new PluginSettings({
      dir: this.#dirFor(id),
      pluginId: id,
      vault: this.#vault,
      saveVault: this.#saveVault,
      db: this.#db,
    });
    await settings.load();
    if (pkg) await settings.seedDefaults(pkg.contributes.settings);
    return settings;
  }

  async #decorate(pkg: PluginPackage, dir: string): Promise<InstalledPlugin> {
    const install = this.#state.installs[pkg.id];
    const installedAt = install?.installedAt ?? (await stat(dir)).mtime.toISOString();
    const digest = install?.digest ?? '';
    const granted = this.#state.granted[pkg.id] ?? [];
    const settings = await this.#settingsFor(pkg.id, pkg);
    const status = this.#status.get(pkg.id);
    return {
      id: pkg.id,
      packageName: pkg.packageName,
      name: pkg.name,
      version: pkg.version,
      apiVersion: pkg.apiVersion,
      description: pkg.description,
      server: pkg.server,
      runtime: pkg.runtime,
      host: pkg.host,
      app: pkg.app,
      icon: pkg.icon,
      permissions: pkg.permissions,
      granted,
      // 策略 auto 时「没有待确认的」——界面上的「全部批准」按钮也就跟着消失
      needsConfirmation: pluginAutoApproves(this.#store.appSettings())
        ? []
        : needsUserConfirmation(pkg.permissions).filter((p) => !granted.includes(p)),
      enabled: this.#state.enabled.includes(pkg.id),
      status: status?.status ?? 'disabled',
      statusDetail: status?.detail,
      contributes: pkg.contributes,
      settings: settings.list(pkg.contributes.settings),
      dir,
      installedAt,
      digest,
      source: install?.source ?? '',
      resolved: install?.resolved ?? '',
    };
  }

  async list(): Promise<InstalledPlugin[]> {
    let entries: string[] = [];
    try {
      entries = (await readdir(this.#root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }

    const plugins: InstalledPlugin[] = [];
    for (const id of entries) {
      try {
        const pkg = await this.#readPackage(id);
        plugins.push(await this.#decorate(pkg, this.#dirFor(id)));
      } catch {
        // 目录存在但 pkg 坏了：跳过，不阻塞其它插件
      }
    }
    return plugins;
  }

  async #one(id: string): Promise<InstalledPlugin> {
    const pkg = await this.#readPackage(id);
    return this.#decorate(pkg, this.#dirFor(id));
  }

  /** 安装一个 path / npm / git 包。默认 disabled，必须显式 enable。 */
  async install(source: string): Promise<InstalledPlugin> {
    return this.#installFromSource(source, { keepEnabled: false });
  }

  /** 按安装时记录的来源重新解析、安装；启用中的插件失败会回滚到旧版本。 */
  async update(id: string): Promise<InstalledPlugin> {
    const install = this.#state.installs[id];
    if (!install?.source) {
      pluginError('PLUGIN_SOURCE_MISSING', `插件 ${id} 没有可更新的安装源`);
    }
    return this.#installFromSource(install.source, { keepEnabled: true, expectedId: id });
  }

  async #copyRuntimeData(from: string, to: string): Promise<void> {
    for (const name of RUNTIME_FILES) {
      await cp(path.join(from, name), path.join(to, name), { force: true, recursive: false }).catch(() => undefined);
    }
  }

  async #installFromSource(
    source: string,
    options: { keepEnabled: boolean; expectedId?: string },
  ): Promise<InstalledPlugin> {
    const prepared = await preparePluginSource(source, path.join(this.#root, '.staging'));
    try {
      const pkg = prepared.package;
      if (options.expectedId && pkg.id !== options.expectedId) {
        pluginError('PLUGIN_ID_MISMATCH', `更新源是 ${pkg.id}，不是 ${options.expectedId}`);
      }
      if (pkg.engines?.warren && !satisfiesEngines(pkg.engines.warren, this.#appVersion)) {
        pluginError('PLUGIN_ENGINE_MISMATCH', `插件要求 warren ${pkg.engines.warren}，当前 ${this.#appVersion}`);
      }

      const id = pkg.id;
      const target = this.#dirFor(id);
      const previousInstall = this.#state.installs[id];
      const previousGranted = [...(this.#state.granted[id] ?? [])];
      const previousEnabled = this.#state.enabled.includes(id);
      const added = diffPermissions(previousGranted, pkg.permissions).added;
      const backupRoot = path.join(this.#root, '.backup');
      const backup = path.join(backupRoot, `${id}-${Date.now()}`);
      const existed = Boolean(await stat(target).catch(() => null));

      await this.disable(id).catch(() => undefined);
      await mkdir(backupRoot, { recursive: true });
      if (existed) await rename(target, backup);

      try {
        await movePreparedPlugin(prepared, target);
        if (existed) await this.#copyRuntimeData(backup, target);

        this.#state.granted[id] = pkg.permissions.filter(
          (permission) => tierOf(permission) === 'granted' || previousGranted.includes(permission),
        );
        const keepEnabled = options.keepEnabled && previousEnabled;
        this.#state.enabled = this.#state.enabled.filter((entry) => entry !== id);
        if (keepEnabled) this.#state.enabled.push(id);
        this.#state.installs[id] = {
          installedAt: new Date().toISOString(),
          digest: await hashPluginDir(target),
          version: pkg.version,
          packageName: pkg.packageName,
          source: prepared.source,
          resolved: prepared.resolved,
        };
        await this.#save();
        this.#status.set(id, { status: 'disabled' });

        if (keepEnabled) {
          await this.#activate(pkg);
          if (this.#status.get(id)?.status !== 'running') {
            throw this.#status.get(id)?.detail
              ? new Error(this.#status.get(id)!.detail)
              : new Error(`插件 ${id} 更新后无法激活`);
          }
        }

        if (existed) await rm(backup, { recursive: true, force: true });
        this.#onChange();
        this.#store.record({
          id: crypto.randomUUID(),
          type: previousInstall ? 'plugin.updated' : 'plugin.installed',
          actor: 'human',
          message: `plugin ${id}@${pkg.version} ${previousInstall ? 'updated' : 'installed'}`,
          createdAt: new Date().toISOString(),
        });
        if (added.length) {
          this.#store.record({
            id: crypto.randomUUID(),
            type: 'plugin.permissions.added',
            actor: 'system',
            message: `[${id}] 新增权限: ${added.join(', ')}（confirm 层要用户在设置里批准）`,
            createdAt: new Date().toISOString(),
          });
        }
        return this.#one(id);
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        if (existed) await rename(backup, target);
        if (previousInstall) this.#state.installs[id] = previousInstall;
        else delete this.#state.installs[id];
        if (previousGranted.length) this.#state.granted[id] = previousGranted;
        else delete this.#state.granted[id];
        this.#state.enabled = this.#state.enabled.filter((entry) => entry !== id);
        if (previousEnabled) this.#state.enabled.push(id);
        await this.#save();
        if (previousEnabled) {
          await this.#activate(await this.#readPackage(id)).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      await cleanupPreparedPlugin(prepared);
    }
  }

  async uninstall(id: string): Promise<void> {
    await this.disable(id).catch(() => undefined);
    try {
      const pkg = await this.#readPackage(id);
      await (await this.#settingsFor(id, pkg)).purge(pkg.contributes.settings);
    } catch {
      // pkg 坏了也要能卸载
    }
    await rm(this.#dirFor(id), { recursive: true, force: true });
    // 库里的行也要带走：卸载 = 删数据（kv / 设置 / 日志），不然重装会带着上一份状态复活
    try {
      this.#db.prepare('DELETE FROM plugin_values WHERE plugin_id = ?').run(id);
      this.#db.prepare('DELETE FROM plugin_logs WHERE plugin_id = ?').run(id);
    } catch {
      // 清不掉不影响卸载本身
    }
    this.#state.enabled = this.#state.enabled.filter((entry) => entry !== id);
    delete this.#state.granted[id];
    delete this.#state.installs[id];
    this.#status.delete(id);
    await this.#save();
    this.#onChange();
    this.#store.record({
      id: crypto.randomUUID(),
      type: 'plugin.uninstalled',
      actor: 'human',
      message: `plugin ${id} uninstalled`,
      createdAt: new Date().toISOString(),
    });
  }

  async enable(id: string): Promise<InstalledPlugin> {
    const pkg = await this.#readPackage(id);
    if (!this.#state.enabled.includes(id)) this.#state.enabled.push(id);
    await this.#save();
    await this.#activate(pkg);
    this.#onChange();
    this.#store.record({
      id: crypto.randomUUID(),
      type: 'plugin.enabled',
      actor: 'human',
      message: `plugin ${id} enabled (${pkg.permissions.length} permissions, runtime ${pkg.runtime})`,
      createdAt: new Date().toISOString(),
    });
    return this.#one(id);
  }

  async disable(id: string): Promise<void> {
    await this.#deactivate(id);
    this.#state.enabled = this.#state.enabled.filter((entry) => entry !== id);
    await this.#save();
    if (this.#status.has(id)) this.#status.set(id, { status: 'disabled' });
    this.#onChange();
  }

  /** 重载：候选先起，成功再替换；失败保留旧实例。 */
  async reload(id: string): Promise<InstalledPlugin> {
    const pkg = await this.#readPackage(id);
    const previous = this.#active.get(id);
    let candidate: ActivePlugin;
    try {
      candidate = await this.#createActive(pkg);
    } catch (error) {
      const err = error as Error & { code?: string };
      this.#status.set(id, {
        status: previous ? 'running' : isNeedsConfiguration(error) ? 'needs-configuration' : 'error',
        detail: previous ? `重载失败，保留旧实例: ${err.message}` : err.message,
      });
      await this.#log(id, 'error', `reload 失败${previous ? '，保留旧实例' : ''}: ${err.message}`);
      this.#onChange();
      return this.#one(id);
    }

    this.#active.set(id, candidate);
    this.#status.set(id, { status: 'running' });
    if (previous) await this.#disposeActive(id, previous);
    await this.#log(id, 'info', `reloaded (runtime ${pkg.runtime})`);
    this.#onChange();
    return this.#one(id);
  }

  /** 只构造并启动候选实例，不碰 #active / #status。 */
  async #createActive(pkg: PluginPackage): Promise<ActivePlugin> {
    const id = pkg.id;
    const dir = this.#dirFor(id);
    let storageToClose: PluginStorage | undefined;
    try {
      const recorded = this.#state.installs[id]?.digest;
      const actual = await hashPluginDir(dir);
      if (recorded && recorded !== actual) {
        throw Object.assign(new Error('插件目录内容与安装时不一致（摘要不符），请重新安装'), {
          code: 'PLUGIN_DIGEST_MISMATCH',
        });
      }

      const storage = new PluginStorage({ dir, pluginId: id, db: this.#db });
      storageToClose = storage;
      await storage.load();
      const settings = await this.#settingsFor(id, pkg);

      const handlers = createHandlers({
        pluginId: id,
        currentEnvironmentId,
        require: (permission) => this.#require(id, permission),
        manager: this.#manager,
        vault: this.#vault,
        storage,
        settings,
        descriptors: pkg.contributes.settings,
        record: (type, message) => {
          this.#store.record({
            id: crypto.randomUUID(),
            type,
            actor: 'agent',
            message: `[${id}] ${message}`,
            createdAt: new Date().toISOString(),
          });
        },
        log: (level, message) => void this.#log(id, level, message),
        signal: (channel, payload) => this.#onSignal(id, channel, payload),
        withLease: (envId, fn) => this.#withLease(id, envId, fn, currentLeaseId()),
      });

      const log = (level: LogLevel, message: string) => void this.#log(id, level, message);

      let adapter: PluginRuntimeAdapter;
      if (pkg.runtime === 'host') {
        if (!pkg.host) pluginError('PLUGIN_PACKAGE_INVALID', 'runtime=host 的插件必须声明 host 入口');
        adapter = new HostRuntime({
          pluginId: id,
          entryPath: path.join(dir, pkg.host),
          bootstrapPath: this.#bootstrapPath,
          log,
          onHostCall: (callPath, args, context) =>
            runWithPluginContext({ pluginId: id, environmentId: context.environmentId, leaseId: context.leaseId }, () =>
              dispatchHostCall(handlers, callPath, args),
            ),
        });
      } else {
        if (!pkg.server) pluginError('PLUGIN_PACKAGE_INVALID', 'runtime=sandbox 的插件必须声明 server 入口');
        const entryPath = path.join(dir, pkg.server);
        const code = await readFile(entryPath, 'utf8');
        adapter = new SandboxRuntime({
          pluginId: id,
          entryPath,
          code,
          log,
          host: buildHostApi(handlers),
        });
      }

      await adapter.start();
      return { adapter, storage, settings, handlers };
    } catch (error) {
      storageToClose?.close();
      throw error;
    }
  }

  async #activate(pkg: PluginPackage): Promise<void> {
    const id = pkg.id;
    try {
      const active = await this.#createActive(pkg);
      this.#active.set(id, active);
      this.#status.set(id, { status: 'running' });
      await this.#log(id, 'info', `activated (runtime ${pkg.runtime})`);
    } catch (error) {
      const err = error as Error & { code?: string };
      const needsConfiguration = isNeedsConfiguration(error);
      this.#status.set(id, {
        status: needsConfiguration ? 'needs-configuration' : 'error',
        detail: err.message,
      });
      await this.#log(id, needsConfiguration ? 'warn' : 'error', `激活失败: ${err.message}`);
      this.#store.record({
        id: crypto.randomUUID(),
        type: 'plugin.failed',
        actor: 'system',
        message: `[${id}] 激活失败: ${err.message}`,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async #deactivate(id: string): Promise<void> {
    const active = this.#active.get(id);
    if (!active) return;
    this.#active.delete(id);
    await this.#disposeActive(id, active);
  }

  async #disposeActive(id: string, active: ActivePlugin): Promise<void> {
    try {
      await active.adapter.dispose();
    } catch (error) {
      await this.#log(id, 'warn', `dispose 失败: ${(error as Error).message}`);
    }
    active.storage.close();
  }

  /** 用户批准 confirm 级权限 */
  async grant(id: string, permissions: Permission[]): Promise<InstalledPlugin> {
    const pkg = await this.#readPackage(id);
    const allowed = new Set(pkg.permissions.filter((p) => tierOf(p) !== 'denied'));
    const granted = new Set(this.#state.granted[id] ?? []);
    for (const permission of permissions) {
      if (!allowed.has(permission)) {
        pluginError('PLUGIN_PERMISSION_DENIED', `插件未声明或该权限被禁止: ${permission}`);
      }
      granted.add(permission);
    }
    this.#state.granted[id] = [...granted];
    await this.#save();
    this.#onChange();
    return this.#one(id);
  }

  async setSetting(id: string, key: string, value: string): Promise<InstalledPlugin> {
    const pkg = await this.#readPackage(id);
    const settings = await this.#settingsFor(id, pkg);
    await settings.set(pkg.contributes.settings, key, value);
    // 设置变了要重载，插件才会用上新值（reload 自己会 onChange）
    if (this.#state.enabled.includes(id)) return this.reload(id);
    this.#onChange();
    return this.#one(id);
  }

  async settingDescriptors(id: string): Promise<PluginSettingDescriptor[]> {
    return (await this.#readPackage(id)).contributes.settings;
  }

  /**
   * 这个能力此刻算不算已授予。
   *
   * 审批策略是 `auto` 时，`confirm` 层**当场**放行 —— 不落库，所以切回 `ask`
   * 立刻恢复拦截（落库会留下「曾经批准过」的痕迹，反向清理最容易漂）。
   * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3.2。
   */
  #has(id: string, permission: Permission): boolean {
    if ((this.#state.granted[id] ?? []).includes(permission)) return true;
    return pluginAutoApproves(this.#store.appSettings()) && tierOf(permission) === 'confirm';
  }

  #require(id: string, permission: Permission): void {
    if (!this.#has(id, permission)) {
      pluginError('PLUGIN_PERMISSION_DENIED', `插件 ${id} 没有 ${permission} 权限`);
    }
  }

  /** 写操作惰性取 lease：只读命令不再把控制权从人手里抢走。 */
  async #withLease<T>(
    id: string,
    envId: string,
    fn: (leaseId: string) => Promise<T>,
    existingLeaseId?: string,
  ): Promise<T> {
    if (existingLeaseId) {
      this.#manager.assertWritable(envId, existingLeaseId);
      return fn(existingLeaseId);
    }
    const lease = this.#manager.acquire(envId, 'agent', `plugin:${id}`);
    try {
      return await fn(lease.leaseId);
    } finally {
      try {
        this.#manager.release(envId, lease.leaseId, 'agent');
      } catch {
        // lease 可能已被 human 接管撤销
      }
    }
  }

  /** 命令：一次性调用（v1 兼容）。 */
  async run(
    id: string,
    command: string,
    options: { environmentId: string; input?: unknown; leaseId?: string },
  ): Promise<RunResult> {
    if (!this.#state.enabled.includes(id)) pluginError('PLUGIN_DISABLED', `插件 ${id} 未启用`);
    await this.#readPackage(id); // 顺带校验清单还在、没被改坏
    const active = this.#active.get(id);
    if (!active)
      pluginError('PLUGIN_NOT_ACTIVE', `插件 ${id} 没有激活（状态 ${this.#status.get(id)?.status ?? 'disabled'}）`);

    // `input` 是命令的参数（CLI 的 `--input='{"from":"ck1"}'`）：插件侧拿 ctx.input
    const ctx = {
      pluginId: id,
      environmentId: options.environmentId,
      command,
      input: options.input,
      leaseId: options.leaseId,
    };
    /*
     * 环境**可以不传**：像「列实例」「起一个新实例」这种命令本来就和环境无关，
     * 逼调用方编一个环境 id 是假的。真需要环境的能力仍然会报 PLUGIN_NO_ENVIRONMENT
     * （`api.ts` 的 `env()` 抛），错在真正用到它的那一刻，而不是入口。
     */
    const environmentId = options.environmentId || undefined;
    try {
      const result = await runWithPluginContext({ pluginId: id, environmentId, leaseId: options.leaseId }, () =>
        active.adapter.command(command, ctx),
      );
      this.#store.record({
        id: crypto.randomUUID(),
        // 用归一过的 id：不带环境的命令不该在事件里留一个空串
        environmentId,
        type: 'plugin.ran',
        actor: 'agent',
        message: `[${id}] ${command} ok`,
        createdAt: new Date().toISOString(),
      });
      return { pluginId: id, command, result };
    } catch (error) {
      const err = error as Error & { code?: string };
      await this.#log(id, 'error', `${command} 失败: ${err.message}`);
      this.#store.record({
        id: crypto.randomUUID(),
        environmentId,
        type: 'plugin.failed',
        actor: 'agent',
        message: `[${id}] ${command} failed: ${err.message}`,
        createdAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * 插件前端调自己后端的方法。
   *
   * 只保证「合法 JSON + 在清单白名单里 + 体积可控」；字段校验是插件自己的事。
   *
   * `options.caller` 标明谁在调：渲染层的插件界面是 `ui`，CLI / agent 是 `agent`（默认）。
   * 插件用它关掉「只给人看」的通道——账号插件的 `reveal` 只对 `ui` 开放。
   */
  async rpc(
    id: string,
    method: string,
    input: unknown,
    options: { leaseId?: string; environmentId?: string; caller?: PluginRpcCaller } = {},
  ): Promise<PluginRpcResponse> {
    const caller: PluginRpcCaller = options.caller === 'ui' ? 'ui' : 'agent';
    const leaseId = options.leaseId;
    const pkg = await this.#readPackage(id);
    if (!this.#state.enabled.includes(id)) {
      return { ok: false, code: 'PLUGIN_DISABLED', message: `插件 ${id} 未启用` };
    }
    if (!pkg.contributes.rpc.includes(method)) {
      return {
        ok: false,
        code: 'PLUGIN_RPC_UNKNOWN',
        message: `${method} 不在清单声明的 rpc 白名单里`,
      };
    }
    const active = this.#active.get(id);
    if (!active) {
      return {
        ok: false,
        code: 'PLUGIN_NOT_ACTIVE',
        message: `插件 ${id} 没有激活（状态 ${this.#status.get(id)?.status ?? 'disabled'}）`,
      };
    }
    const environmentId =
      options.environmentId ??
      (typeof (input as { environmentId?: unknown })?.environmentId === 'string'
        ? (input as { environmentId: string }).environmentId
        : undefined);
    return runWithPluginContext({ pluginId: id, environmentId, leaseId, caller }, async () => {
      try {
        const result = await active.adapter.rpc(method, input ?? null, { pluginId: id, input, leaseId, caller });
        return { ok: true, result: toJson(result) };
      } catch (error) {
        const err = error as Error & { code?: string };
        await this.#log(id, 'error', `rpc ${method} 失败: ${err.message}`);
        if (isNeedsConfiguration(error)) {
          this.#status.set(id, { status: 'needs-configuration', detail: err.message });
        }
        return { ok: false, code: err.code ?? 'PLUGIN_RPC_HANDLER_ERROR', message: err.message };
      }
    });
  }

  /**
   * 插件前端直连宿主只读能力。
   *
   * 只放 `shared/plugin-host-api.ts` 白名单里的方法；返回值过 `toJson`。
   * 这里不经过 `contributes.rpc`——那条白名单管的是插件自己的后端方法。
   */
  async hostRead(
    id: string,
    method: string,
    environmentId: string | undefined,
    args: unknown[],
  ): Promise<PluginRpcResponse> {
    await this.#readPackage(id); // 清单还在、没被改坏
    if (!this.#state.enabled.includes(id)) {
      return { ok: false, code: 'PLUGIN_DISABLED', message: `插件 ${id} 未启用` };
    }
    if (!this.#active.has(id)) {
      return {
        ok: false,
        code: 'PLUGIN_NOT_ACTIVE',
        message: `插件 ${id} 没有激活（状态 ${this.#status.get(id)?.status ?? 'disabled'}）`,
      };
    }
    try {
      const result = await dispatchHostRead(
        { manager: this.#manager, require: (permission) => this.#require(id, permission) },
        method,
        environmentId,
        args,
      );
      return { ok: true, result: toJson(result) };
    } catch (error) {
      const err = error as Error & { code?: string };
      await this.#log(id, 'error', `hostRead ${method} 失败: ${err.message}`);
      return { ok: false, code: err.code ?? 'PLUGIN_HOST_READ_ERROR', message: err.message };
    }
  }

  statusOf(id: string): { status: PluginStatus; detail?: string } {
    return this.#status.get(id) ?? { status: 'disabled' };
  }
}

/** 结果必须是严格 JSON：循环引用 / bigint / 函数一律拒绝，不静默丢弃。 */
function toJson(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node))
        throw Object.assign(new Error('插件返回值里有非法数字'), { code: 'PLUGIN_RPC_NON_JSON' });
      return node;
    }
    if (typeof node === 'bigint' || typeof node === 'function' || typeof node === 'symbol') {
      throw Object.assign(new Error(`插件返回值里有 ${typeof node}，不能过 JSON`), {
        code: 'PLUGIN_RPC_NON_JSON',
      });
    }
    if (typeof node === 'undefined') {
      throw Object.assign(new Error('插件返回值里有 undefined，不能过 JSON'), {
        code: 'PLUGIN_RPC_NON_JSON',
      });
    }
    if (depth > 32) throw Object.assign(new Error('插件返回值嵌套过深'), { code: 'PLUGIN_RPC_NON_JSON' });
    const object = node as object;
    if (seen.has(object)) throw Object.assign(new Error('插件返回值里有循环引用'), { code: 'PLUGIN_RPC_NON_JSON' });
    seen.add(object);
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    // 不能比原型对象本身：sandbox 里造出来的对象来自另一个 realm，原型天然不同。
    // 用构造器名判断「普通对象」，跨 realm 也成立。
    const proto = Object.getPrototypeOf(object) as { constructor?: { name?: string } } | null;
    const constructorName = proto === null ? 'Object' : proto.constructor?.name;
    if (constructorName !== 'Object') {
      throw Object.assign(new Error(`插件返回值里有 ${constructorName ?? '未知类型'} 实例，不能过 JSON`), {
        code: 'PLUGIN_RPC_NON_JSON',
      });
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object as Record<string, unknown>)) {
      result[key] = walk(item, depth + 1);
    }
    return result;
  };
  const json = walk(value ?? null, 0);
  const encoded = JSON.stringify(json);
  if (encoded && encoded.length > 1024 * 1024) {
    throw Object.assign(new Error('插件返回值超过 1MB'), { code: 'PLUGIN_RPC_TOO_LARGE' });
  }
  return json;
}
