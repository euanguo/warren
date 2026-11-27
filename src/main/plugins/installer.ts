/**
 * 插件包安装、更新、卸载、目录摘要与权限/设置配置。
 */
import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store';
import type { VaultStore } from '../vault/store';
import {
  diffPermissions,
  needsUserConfirmation,
  satisfiesEngines,
  validatePluginPackage,
  type PluginPackage,
} from './package.ts';
import { tierOf, type Permission } from '../../shared/permissions.ts';
import { pluginAutoApproves } from '../domain/approval.ts';
import type { PluginState } from './registry.ts';
import { PluginSettings } from './settings.ts';
import { cleanupPreparedPlugin, movePreparedPlugin, preparePluginSource } from './source.ts';
import { loadPluginSkillEntry, type PluginSkillEntry } from '../skills/composer.ts';
import type {
  InstalledPlugin,
  PluginSettingDescriptor,
  PluginSkillDocument,
  PluginStatus,
} from '../../shared/types.ts';

/** 插件目录里的运行时数据：算摘要、卸载清理时按这个区分「代码」和「数据」 */
export const RUNTIME_FILES = new Set(['data.db', 'data.db-wal', 'data.db-shm']);

export function isRuntimeFile(name: string): boolean {
  return RUNTIME_FILES.has(name);
}

export function pluginError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

const HASH_READ_CONCURRENCY = 16;

export async function hashPluginDir(dir: string): Promise<string> {
  const files: Array<{ relative: string; fullPath: string }> = [];
  const collect = async (current: string, prefix: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await collect(path.join(current, entry.name), relative);
        continue;
      }
      if (isRuntimeFile(entry.name)) continue;
      files.push({ relative, fullPath: path.join(current, entry.name) });
    }
  };
  await collect(dir, '');

  const buffers: Buffer[] = Array.from({ length: files.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(HASH_READ_CONCURRENCY, files.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) break;
      buffers[index] = await readFile(files[index]!.fullPath);
    }
  });
  await Promise.all(workers);

  const hash = createHash('sha256');
  for (let index = 0; index < files.length; index += 1) {
    hash.update(files[index]!.relative);
    hash.update(buffers[index]!);
  }
  return hash.digest('hex');
}

export interface InstallerDeps {
  root: string;
  vault: VaultStore;
  store: Store;
  db: DatabaseSync;
  saveVault: () => Promise<void>;
  appVersion: string;
  getState: () => PluginState;
  saveState: () => Promise<void>;
  statusOf: (id: string) => { status: PluginStatus; detail?: string };
  setStatus: (id: string, status: { status: PluginStatus; detail?: string }) => void;
  deleteStatus: (id: string) => void;
  disable: (id: string) => Promise<void>;
  activate: (pkg: PluginPackage) => Promise<void>;
  reload: (id: string) => Promise<InstalledPlugin>;
  onChange: () => void;
}

export class PluginInstaller {
  #deps: InstallerDeps;
  #skillCache = new Map<string, PluginSkillEntry>();

  constructor(deps: InstallerDeps) {
    this.#deps = deps;
  }

  #invalidateSkillCache(id?: string): void {
    if (!id) {
      this.#skillCache.clear();
      return;
    }
    const prefix = `${id}\0`;
    for (const key of this.#skillCache.keys()) {
      if (key.startsWith(prefix)) this.#skillCache.delete(key);
    }
  }

  async #loadSkillEntryCached(
    dir: string,
    pkg: PluginPackage,
    options: { enabled: boolean; digest: string; skillExposed: boolean },
  ): Promise<PluginSkillEntry> {
    if (!options.digest) return loadPluginSkillEntry(dir, pkg, options);
    const key = `${pkg.id}\0${options.digest}\0${options.enabled ? 1 : 0}\0${options.skillExposed ? 1 : 0}`;
    const cached = this.#skillCache.get(key);
    if (cached) return cached;
    const entry = await loadPluginSkillEntry(dir, pkg, options);
    this.#skillCache.set(key, entry);
    return entry;
  }

  dirFor(id: string): string {
    return path.join(this.#deps.root, id);
  }

  async readPackage(id: string): Promise<PluginPackage> {
    const file = path.join(this.dirFor(id), 'package.json');
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

  async settingsFor(id: string, pkg?: PluginPackage): Promise<PluginSettings> {
    const settings = new PluginSettings({
      dir: this.dirFor(id),
      pluginId: id,
      vault: this.#deps.vault,
      saveVault: this.#deps.saveVault,
      db: this.#deps.db,
    });
    await settings.load();
    if (pkg) await settings.seedDefaults(pkg.contributes.settings);
    return settings;
  }

  async decorate(pkg: PluginPackage, dir: string): Promise<InstalledPlugin> {
    const state = this.#deps.getState();
    const install = state.installs[pkg.id];
    const installedAt = install?.installedAt ?? (await stat(dir)).mtime.toISOString();
    const digest = install?.digest ?? '';
    const granted = state.granted[pkg.id] ?? [];
    const settings = await this.settingsFor(pkg.id, pkg);
    const status = this.#deps.statusOf(pkg.id);
    const enabled = state.enabled.includes(pkg.id);
    const skillExposed = state.skillExposed?.[pkg.id] !== false;
    const skillEntry = await this.#loadSkillEntryCached(dir, pkg, { enabled, digest, skillExposed });
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
      needsConfirmation: pluginAutoApproves(this.#deps.store.appSettings())
        ? []
        : needsUserConfirmation(pkg.permissions).filter((p) => !granted.includes(p)),
      enabled,
      skillExposed,
      skill: {
        ...(skillEntry.entry ? { entry: skillEntry.entry } : {}),
        summary: skillEntry.summary,
        triggers: skillEntry.triggers,
        references: skillEntry.references.map((item) => item.relativePath),
        hasExplicitSkill: skillEntry.hasExplicitSkill,
        exposed: skillExposed,
        bytes: skillEntry.bytes,
        sha256: skillEntry.skillSha,
      },
      status: status.status,
      statusDetail: status.detail,
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
      entries = (await readdir(this.#deps.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }

    const items = await Promise.all(
      entries.map(async (id): Promise<InstalledPlugin | null> => {
        try {
          const pkg = await this.readPackage(id);
          return await this.decorate(pkg, this.dirFor(id));
        } catch {
          // 目录存在但 pkg 坏了：跳过，不阻塞其它插件
          return null;
        }
      }),
    );
    return items.filter((item): item is InstalledPlugin => item !== null);
  }

  async one(id: string): Promise<InstalledPlugin> {
    const pkg = await this.readPackage(id);
    return this.decorate(pkg, this.dirFor(id));
  }

  /** 安装一个 path / npm / git 包。默认 disabled，必须显式 enable。 */
  async install(source: string): Promise<InstalledPlugin> {
    return this.#installFromSource(source, { keepEnabled: false });
  }

  /** 按安装时记录的来源重新解析、安装；启用中的插件失败会回滚到旧版本。 */
  async update(id: string): Promise<InstalledPlugin> {
    const install = this.#deps.getState().installs[id];
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
    const prepared = await preparePluginSource(source, path.join(this.#deps.root, '.staging'));
    try {
      const pkg = prepared.package;
      if (options.expectedId && pkg.id !== options.expectedId) {
        pluginError('PLUGIN_ID_MISMATCH', `更新源是 ${pkg.id}，不是 ${options.expectedId}`);
      }
      if (pkg.engines?.warren && !satisfiesEngines(pkg.engines.warren, this.#deps.appVersion)) {
        pluginError('PLUGIN_ENGINE_MISMATCH', `插件要求 warren ${pkg.engines.warren}，当前 ${this.#deps.appVersion}`);
      }

      const id = pkg.id;
      const target = this.dirFor(id);
      const state = this.#deps.getState();
      const previousInstall = state.installs[id];
      const previousGranted = [...(state.granted[id] ?? [])];
      const previousEnabled = state.enabled.includes(id);
      const added = diffPermissions(previousGranted, pkg.permissions).added;
      const backupRoot = path.join(this.#deps.root, '.backup');
      const backup = path.join(backupRoot, `${id}-${Date.now()}`);
      const existed = Boolean(await stat(target).catch(() => null));

      await this.#deps.disable(id).catch(() => undefined);
      await mkdir(backupRoot, { recursive: true });
      if (existed) await rename(target, backup);

      try {
        await movePreparedPlugin(prepared, target);
        if (existed) await this.#copyRuntimeData(backup, target);

        state.granted[id] = pkg.permissions.filter(
          (permission) => tierOf(permission) === 'granted' || previousGranted.includes(permission),
        );
        const keepEnabled = options.keepEnabled && previousEnabled;
        state.enabled = state.enabled.filter((entry) => entry !== id);
        if (keepEnabled) state.enabled.push(id);
        state.installs[id] = {
          installedAt: new Date().toISOString(),
          digest: await hashPluginDir(target),
          version: pkg.version,
          packageName: pkg.packageName,
          source: prepared.source,
          resolved: prepared.resolved,
        };
        await this.#deps.saveState();
        this.#deps.setStatus(id, { status: 'disabled' });

        if (keepEnabled) {
          await this.#deps.activate(pkg);
          const current = this.#deps.statusOf(id);
          if (current.status !== 'running') {
            throw current.detail ? new Error(current.detail) : new Error(`插件 ${id} 更新后无法激活`);
          }
        }

        if (existed) await rm(backup, { recursive: true, force: true });
        this.#invalidateSkillCache(id);
        this.#deps.onChange();
        this.#deps.store.record({
          id: crypto.randomUUID(),
          type: previousInstall ? 'plugin.updated' : 'plugin.installed',
          actor: 'human',
          message: `plugin ${id}@${pkg.version} ${previousInstall ? 'updated' : 'installed'}`,
          createdAt: new Date().toISOString(),
        });
        if (added.length) {
          this.#deps.store.record({
            id: crypto.randomUUID(),
            type: 'plugin.permissions.added',
            actor: 'system',
            message: `[${id}] 新增权限: ${added.join(', ')}（confirm 层要用户在设置里批准）`,
            createdAt: new Date().toISOString(),
          });
        }
        return this.one(id);
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        if (existed) await rename(backup, target);
        if (previousInstall) state.installs[id] = previousInstall;
        else delete state.installs[id];
        if (previousGranted.length) state.granted[id] = previousGranted;
        else delete state.granted[id];
        state.enabled = state.enabled.filter((entry) => entry !== id);
        if (previousEnabled) state.enabled.push(id);
        await this.#deps.saveState();
        this.#invalidateSkillCache(id);
        if (previousEnabled) {
          await this.#deps.activate(await this.readPackage(id)).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      await cleanupPreparedPlugin(prepared);
    }
  }

  async uninstall(id: string): Promise<void> {
    await this.#deps.disable(id).catch(() => undefined);
    try {
      const pkg = await this.readPackage(id);
      await (await this.settingsFor(id, pkg)).purge(pkg.contributes.settings);
    } catch {
      // pkg 坏了也要能卸载
    }
    await rm(this.dirFor(id), { recursive: true, force: true });
    // 库里的行也要带走：卸载 = 删数据（kv / 设置 / 日志），不然重装会带着上一份状态复活
    try {
      this.#deps.db.prepare('DELETE FROM plugin_values WHERE plugin_id = ?').run(id);
      this.#deps.db.prepare('DELETE FROM plugin_logs WHERE plugin_id = ?').run(id);
    } catch {
      // 清不掉不影响卸载本身
    }
    const state = this.#deps.getState();
    state.enabled = state.enabled.filter((entry) => entry !== id);
    delete state.granted[id];
    delete state.installs[id];
    if (state.skillExposed) delete state.skillExposed[id];
    this.#deps.deleteStatus(id);
    this.#invalidateSkillCache(id);
    await this.#deps.saveState();
    this.#deps.onChange();
    this.#deps.store.record({
      id: crypto.randomUUID(),
      type: 'plugin.uninstalled',
      actor: 'human',
      message: `plugin ${id} uninstalled`,
      createdAt: new Date().toISOString(),
    });
  }

  /** 用户批准 confirm 级权限 */
  async grant(id: string, permissions: Permission[]): Promise<InstalledPlugin> {
    const pkg = await this.readPackage(id);
    const allowed = new Set(pkg.permissions.filter((p) => tierOf(p) !== 'denied'));
    const state = this.#deps.getState();
    const granted = new Set(state.granted[id] ?? []);
    for (const permission of permissions) {
      if (!allowed.has(permission)) {
        pluginError('PLUGIN_PERMISSION_DENIED', `插件未声明或该权限被禁止: ${permission}`);
      }
      granted.add(permission);
    }
    state.granted[id] = [...granted];
    await this.#deps.saveState();
    this.#deps.onChange();
    return this.one(id);
  }

  async setSetting(id: string, key: string, value: string): Promise<InstalledPlugin> {
    const pkg = await this.readPackage(id);
    const settings = await this.settingsFor(id, pkg);
    await settings.set(pkg.contributes.settings, key, value);
    // 设置变了要重载，插件才会用上新值（reload 自己会 onChange）
    if (this.#deps.getState().enabled.includes(id)) return this.#deps.reload(id);
    this.#deps.onChange();
    return this.one(id);
  }

  async settingDescriptors(id: string): Promise<PluginSettingDescriptor[]> {
    return (await this.readPackage(id)).contributes.settings;
  }

  async setSkillExposed(id: string, exposed: boolean): Promise<InstalledPlugin> {
    await this.readPackage(id);
    const state = this.#deps.getState();
    state.skillExposed ??= {};
    state.skillExposed[id] = Boolean(exposed);
    this.#invalidateSkillCache(id);
    await this.#deps.saveState();
    this.#deps.onChange();
    return this.one(id);
  }

  async readSkill(id: string): Promise<PluginSkillDocument> {
    const pkg = await this.readPackage(id);
    const state = this.#deps.getState();
    const dir = this.dirFor(id);
    const enabled = state.enabled.includes(id);
    const skillExposed = state.skillExposed?.[id] !== false;
    const digest = state.installs[id]?.digest ?? '';
    const entry = await this.#loadSkillEntryCached(dir, pkg, { enabled, digest, skillExposed });
    return {
      pluginId: pkg.id,
      pluginName: pkg.name,
      version: pkg.version,
      ...(entry.entry ? { entry: entry.entry } : {}),
      summary: entry.summary,
      triggers: entry.triggers,
      references: entry.references.map((item) => item.relativePath),
      hasExplicitSkill: entry.hasExplicitSkill,
      exposed: skillExposed,
      bytes: entry.bytes,
      sha256: entry.skillSha,
      markdown: entry.markdown,
    };
  }

  async listSkillEntries(): Promise<PluginSkillEntry[]> {
    let entries: string[] = [];
    try {
      entries = (await readdir(this.#deps.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
    const state = this.#deps.getState();
    const items = await Promise.all(
      entries.map(async (id): Promise<PluginSkillEntry | null> => {
        try {
          const pkg = await this.readPackage(id);
          const enabled = state.enabled.includes(id);
          const skillExposed = state.skillExposed?.[id] !== false;
          const digest = state.installs[id]?.digest ?? '';
          return await this.#loadSkillEntryCached(this.dirFor(id), pkg, { enabled, digest, skillExposed });
        } catch {
          // 损坏目录跳过，不影响其它插件 Skill 合成
          return null;
        }
      }),
    );
    return items.filter((item): item is PluginSkillEntry => item !== null);
  }
}
