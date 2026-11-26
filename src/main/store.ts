/**
 * 核心持久层门面：委托 `EnvironmentRepository` 与 `SiteMemoryRepository` 操作同一 `warren.db` 连接，
 * 负责遗留 JSON 一次性导入、运行期事件审计流水及兼容调用入口。
 */
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AppSettings,
  Creator,
  DomainPref,
  Environment,
  EnvironmentConfig,
  EventRecord,
  Group,
  SavedFlowRecord,
  SavedFlowSpec,
  SiteNote,
  UrlHistoryEntry,
  ViewportPresetId,
} from '../shared/types';
import { MIGRATED_SUFFIX, openDatabase, tx } from './db.ts';
import type { EnvironmentPatch } from './domain/environment.ts';
import {
  EVENT_LIMIT,
  migrateLegacyShape,
  normalizeRunning,
  normalizeSiteKey,
  rowToEvent,
  warnStore,
  type RememberedTab,
  type Row,
  type RunningSnapshot,
  type StoreShape,
} from './store/common.ts';
import { EnvironmentRepository } from './store/environments.ts';
import { SiteMemoryRepository } from './store/memory.ts';

export { EVENT_LIMIT, normalizeSiteKey, type RememberedTab, type RunningSnapshot, type StoreShape };

export class Store {
  #dir: string;
  #dbFile: string;
  #legacyFile: string;
  #legacyTempFile: string;
  #runningFile: string;
  #runningTempFile: string;
  #db?: DatabaseSync;
  #recorded = 0;
  #envs: EnvironmentRepository;
  #memory: SiteMemoryRepository;

  constructor(dir: string) {
    this.#dir = dir;
    this.#dbFile = path.join(dir, 'warren.db');
    this.#legacyFile = path.join(dir, 'environments.json');
    this.#legacyTempFile = path.join(dir, 'environments.json.tmp');
    this.#runningFile = path.join(dir, 'running.json');
    this.#runningTempFile = path.join(dir, 'running.json.tmp');
    const getDb = () => this.database;
    this.#envs = new EnvironmentRepository(dir, getDb);
    this.#memory = new SiteMemoryRepository(getDb);
  }

  get file(): string {
    return this.#dbFile;
  }

  get database(): DatabaseSync {
    if (!this.#db) throw new Error('store.load() 必须先调用');
    return this.#db;
  }

  async load(): Promise<void> {
    this.#db = openDatabase(this.#dbFile);
    await this.#importLegacy();
    this.#reconcileStoragePaths();
    this.#pruneEvents();
  }

  #reconcileStoragePaths(): void {
    for (const config of this.list()) {
      const expected = this.storagePathFor(config.id);
      if (config.storagePath === expected) continue;
      const trustedCa =
        config.trustedCa && config.trustedCa.startsWith(config.storagePath + path.sep)
          ? path.join(expected, path.relative(config.storagePath, config.trustedCa))
          : config.trustedCa;
      this.#envs.insertConfig({ ...config, storagePath: expected, trustedCa });
    }
  }

  async #importLegacy(): Promise<void> {
    if (this.#count('environments') > 0 || this.#count('groups') > 0) return;
    const raw = await this.#readFirstIntact([this.#legacyTempFile, this.#legacyFile]);
    const running = normalizeRunning(await this.#readFirstIntact([this.#runningTempFile, this.#runningFile]));
    if (raw === null && running.running.length === 0) return;

    const shape = raw === null ? { environments: [], groups: [] } : migrateLegacyShape(raw, this.#dir);
    tx(this.database, () => {
      for (const group of shape.groups) this.#envs.insertGroup(group);
      for (const config of shape.environments) this.#envs.insertConfig(config);
    });
    this.saveRunning(running);

    for (const file of [this.#legacyFile, this.#legacyTempFile, this.#runningFile, this.#runningTempFile]) {
      try {
        await rename(file, `${file}${MIGRATED_SUFFIX}`);
      } catch {
        // 文件不存在则跳过
      }
    }
    this.record({
      id: crypto.randomUUID(),
      type: 'store.migrated',
      actor: 'system',
      message: `已从 environments.json 迁移 ${shape.environments.length} 个环境 / ${shape.groups.length} 个分组到 SQLite`,
      createdAt: new Date().toISOString(),
    });
  }

  async #readFirstIntact(paths: string[]): Promise<unknown | null> {
    for (const file of paths) {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT')
          warnStore(`importLegacy:${path.basename(file)}`, error);
      }
    }
    return null;
  }

  #count(table: 'environments' | 'groups' | 'events'): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row | undefined;
    return Number(row?.n ?? 0);
  }

  // ── 环境 / 分组 / 运行态 / 标签快照 ─────────────────────────────

  storagePathFor = (id: string): string => this.#envs.storagePathFor(id);
  list = (): Environment[] => this.#envs.list();
  get = (id: string): Environment | undefined => this.#envs.get(id);
  configFor = (id: string): EnvironmentConfig | undefined => this.#envs.configFor(id);
  create = (input: {
    id: string;
    name?: string;
    proxy?: string;
    startUrl?: string;
    headed?: boolean;
    groupId?: string;
    createdBy?: Creator;
  }): Environment => this.#envs.create(input);
  update = (id: string, patch: EnvironmentPatch): Environment => this.#envs.update(id, patch);
  remove = (id: string): void => this.#envs.remove(id);
  moveToGroup = (id: string, groupId: string | undefined): Environment => this.#envs.moveToGroup(id, groupId);
  reorderEnvironments = (groupId: string | undefined, orderedIds: string[]): void =>
    this.#envs.reorderEnvironments(groupId, orderedIds);

  listGroups = (): Group[] => this.#envs.listGroups();
  groupFor = (id: string): Group | undefined => this.#envs.groupFor(id);
  createGroup = (input: { id?: string; name: string }): Group => this.#envs.createGroup(input);
  renameGroup = (id: string, name: string): Group => this.#envs.renameGroup(id, name);
  setGroupCollapsed = (id: string, collapsed: boolean): Group => this.#envs.setGroupCollapsed(id, collapsed);
  removeGroup = (id: string): { detached: number } => this.#envs.removeGroup(id);
  reorderGroups = (orderedIds: string[]): void => this.#envs.reorderGroups(orderedIds);

  runningSnapshot = (): RunningSnapshot => this.#envs.runningSnapshot();
  saveRunning = (snapshot: RunningSnapshot): void => this.#envs.saveRunning(snapshot);
  tabsFor = (envId: string): RememberedTab[] => this.#envs.tabsFor(envId);
  saveTabs = (envId: string, tabs: RememberedTab[]): void => this.#envs.saveTabs(envId, tabs);

  // ── 应用设置 / 地址历史 / 按域偏好 / 站点记忆 / Saved Flows ──────

  appSettings = (): AppSettings => this.#memory.appSettings();
  setAppSettings = (patch: Partial<AppSettings>): AppSettings => this.#memory.setAppSettings(patch);
  recordUrlHistory = (rawUrl: string): void => this.#memory.recordUrlHistory(rawUrl);
  searchUrlHistory = (query: string, limit = 8): UrlHistoryEntry[] => this.#memory.searchUrlHistory(query, limit);
  clearUrlHistory = (): number => this.#memory.clearUrlHistory();
  domainPref = (envId: string, origin: string): DomainPref | undefined => this.#memory.domainPref(envId, origin);
  listDomainPrefs = (envId?: string): DomainPref[] => this.#memory.listDomainPrefs(envId);
  setDomainPref = (
    envId: string,
    origin: string,
    patch: { zoomFactor?: number; viewportPreset?: ViewportPresetId | null },
  ): DomainPref => this.#memory.setDomainPref(envId, origin, patch);
  removeDomainPref = (envId: string, origin: string): boolean => this.#memory.removeDomainPref(envId, origin);

  getSiteNote = (site: string): SiteNote | undefined => this.#memory.getSiteNote(site);
  listSiteNotes = (): SiteNote[] => this.#memory.listSiteNotes();
  matchSiteNotesForUrl = (rawUrl: string): SiteNote[] => this.#memory.matchSiteNotesForUrl(rawUrl);
  setSiteNote = (site: string, content: string, updatedBy = 'human'): SiteNote =>
    this.#memory.setSiteNote(site, content, updatedBy);
  appendSiteNote = (site: string, text: string, updatedBy = 'human'): SiteNote =>
    this.#memory.appendSiteNote(site, text, updatedBy);
  removeSiteNote = (site: string): boolean => this.#memory.removeSiteNote(site);

  getSavedFlow = (name: string): SavedFlowRecord | undefined => this.#memory.getSavedFlow(name);
  listSavedFlows = (): SavedFlowRecord[] => this.#memory.listSavedFlows();
  saveFlow = (name: string, site: string, spec: SavedFlowSpec, updatedBy = 'agent'): SavedFlowRecord =>
    this.#memory.saveFlow(name, site, spec, updatedBy);
  removeSavedFlow = (name: string): boolean => this.#memory.removeSavedFlow(name);

  // ── 事件流水 ────────────────────────────────────────────────────

  record(event: EventRecord): EventRecord {
    this.database
      .prepare(
        'INSERT OR REPLACE INTO events (id, environment_id, type, actor, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(event.id, event.environmentId ?? null, event.type, event.actor, event.message, event.createdAt);
    this.#recorded += 1;
    if (this.#recorded % 100 === 0 && this.#count('events') > EVENT_LIMIT) this.#pruneEvents();
    return event;
  }

  events(environmentId?: string, limit = 100): EventRecord[] {
    const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
    const rows =
      environmentId === undefined
        ? this.database.prepare('SELECT * FROM events ORDER BY created_at DESC, rowid DESC LIMIT ?').all(size)
        : this.database
            .prepare('SELECT * FROM events WHERE environment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
            .all(environmentId, size);
    return (rows as Row[]).map(rowToEvent).reverse();
  }

  eventsSince(
    options: { environmentId?: string; afterId?: string; since?: string; limit?: number } = {},
  ): EventRecord[] {
    const size =
      Number.isFinite(options.limit) && (options.limit ?? 0) > 0 ? Math.min(500, Math.floor(options.limit!)) : 100;
    let afterRowId = 0;
    if (options.afterId) {
      const anchor = this.database.prepare('SELECT rowid FROM events WHERE id = ?').get(options.afterId) as
        { rowid?: number } | undefined;
      if (anchor && typeof anchor.rowid === 'number') afterRowId = anchor.rowid;
    }
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (options.environmentId) {
      where.push('environment_id = ?');
      args.push(options.environmentId);
    }
    if (afterRowId > 0) {
      where.push('rowid > ?');
      args.push(afterRowId);
    } else if (options.since) {
      where.push('created_at > ?');
      args.push(options.since);
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid ASC LIMIT ?`;
    args.push(size);
    return (this.database.prepare(sql).all(...args) as Row[]).map(rowToEvent);
  }

  #pruneEvents(): void {
    this.database
      .prepare(
        `DELETE FROM events WHERE id IN (
           SELECT id FROM events ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(EVENT_LIMIT);
  }
}
