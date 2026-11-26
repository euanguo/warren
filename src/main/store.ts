/**
 * 环境 / 分组 / 事件 / 运行态。
 *
 * 落在 `<coreDir>/warren.db`（见 `db.ts`，schema 也在那里）。
 * 老的 `environments.json` / `running.json` 在**第一次打开空库时一次性导入**，
 * 导完改名成 `*.migrated` 留着当备份（迁移失败还能人工捞回来，直接删是不可逆的）。
 *
 * 为什么从 JSON 换过来：JSON 是「整份读写」——一次写要序列化全部环境，崩在中间只能靠 tmp + rename 兜底；
 * 事件更是压根没落盘（重启即清空）。SQLite 给的是**按行写 + 事务**，顺带让事件有了历史。
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
  SiteNote,
  SpaceId,
  UrlHistoryEntry,
  ViewportPresetId,
} from '../shared/types';
import { MIGRATED_SUFFIX, openDatabase, tx } from './db.ts';
// 运行时导入必须带 .ts 扩展名：node --test 直接加载源文件，不走打包。
// 见 AGENTS.md「Node ESM 的扩展名陷阱」。
import {
  assertEnvironmentId,
  clampEnvironmentName,
  createEnvironmentConfig,
  safeEnvKey,
  toEnvironment,
  type EnvironmentPatch,
} from './domain/environment.ts';
import { isApprovalMode, toAppSettings } from './domain/approval.ts';
import {
  createGroup,
  detachGroupEnvironments,
  moveToGroup,
  nextOrder,
  renameGroup,
  reorderBy,
  setGroupCollapsed,
} from './domain/group.ts';

export interface StoreShape {
  environments: EnvironmentConfig[];
  groups: Group[];
}

/**
 * 「上一次这个应用退出时，哪些环境是运行中的」。
 *
 * 只给崩溃恢复用：**正常退出会把它写成空的**（`shutdown()` 逐个 `stop()`），
 * 所以下次启动只有「上次是被杀掉 / 崩掉」才会自动把环境拉回来。
 */
export interface RunningSnapshot {
  running: string[];
  selected?: string;
  /** 休眠中的环境；崩溃恢复不当成 running 拉起，被用到时透明唤醒。 */
  dormant?: string[];
}

/** 一个环境上次开着的标签（只记 Space、URL 与激活位）。 */
export interface RememberedTab {
  space: SpaceId;
  url: string;
  active: boolean;
}

/**
 * 事件表保留的最大条数，超了删最老的。
 *
 * 清理是**按批**做的（每 100 条插入才数一次表，COUNT 是 O(n)，不能每条都做），
 * 所以实际最多会到 `EVENT_LIMIT + 99` 条——上限是个水位，不是硬边界。
 */
export const EVENT_LIMIT = 5000;
const URL_HISTORY_LIMIT = 5000;

const SECRET_NOTE_PATTERNS: RegExp[] = [
  /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{4,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
];

/** 规范化站点记忆键：支持完整 URL 或域名（可选路径前缀），统一小写并去尾斜杠。 */
export function normalizeSiteKey(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw Object.assign(new Error('site is required'), { code: 'BAD_REQUEST' });
  let normalized = trimmed;
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw Object.assign(new Error(`仅支持 http/https 站点或域名：${raw}`), { code: 'BAD_REQUEST' });
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    normalized = `${parsed.host.toLowerCase()}${cleanPath}`;
  } else {
    normalized = trimmed.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  }
  if (!normalized || normalized.length > 256 || /\s/.test(normalized)) {
    throw Object.assign(new Error(`无效的站点键：${raw}`), { code: 'BAD_REQUEST' });
  }
  return normalized;
}

function assertNoteSafe(content: string): string {
  const cleaned = String(content ?? '').trim();
  if (!cleaned) throw Object.assign(new Error('note content is empty'), { code: 'BAD_REQUEST' });
  if (cleaned.length > 8192) {
    throw Object.assign(new Error('note content exceeds 8192 characters'), { code: 'BAD_REQUEST' });
  }
  if (SECRET_NOTE_PATTERNS.some((re) => re.test(cleaned))) {
    throw Object.assign(new Error('site_notes 严禁存放密码或令牌明文，请使用 warren vault add'), {
      code: 'BAD_REQUEST',
    });
  }
  return cleaned;
}

type Row = Record<string, unknown>;

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function rowToConfig(row: Row): EnvironmentConfig {
  return {
    id: String(row.id),
    name: String(row.name),
    storagePath: String(row.storage_path),
    proxy: optionalText(row.proxy),
    trustedCa: optionalText(row.trusted_ca),
    createdBy: row.created_by === 'agent' ? 'agent' : 'human',
    approval: isApprovalMode(row.approval) ? row.approval : undefined,
    startUrl: optionalText(row.start_url),
    headed: row.headed === 1 || row.headed === true,
    groupId: optionalText(row.group_id),
    order: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToGroup(row: Row): Group {
  return {
    id: String(row.id),
    name: String(row.name),
    order: Number(row.sort_order ?? 0),
    collapsed: row.collapsed === 1 || row.collapsed === true,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToEvent(row: Row): EventRecord {
  return {
    id: String(row.id),
    environmentId: optionalText(row.environment_id),
    type: String(row.type),
    actor: String(row.actor) as EventRecord['actor'],
    message: String(row.message),
    createdAt: String(row.created_at),
  };
}

function rowToUrlHistory(row: Row): UrlHistoryEntry {
  return {
    url: String(row.url),
    visitCount: Number(row.visit_count ?? 1),
    lastVisitedAt: String(row.last_visited_at),
  };
}

/**
 * 读进来的旧数据补齐新字段。
 *
 * 1. 早期版本的 environments.json 没有 `groups`，环境也没有 `order` / `groupId`。
 *    直接当新格式用会让 `order` 变 undefined，排序就静默失效。
 * 2. `storagePath` 是持久化的**绝对路径**。应用改名后 `app.getPath('userData')`
 *    从 environment-browser 变成 Warren，旧路径就悬空了——而 Chromium 会照着
 *    悬空路径把旧目录重新建出来，于是数据悄悄写到错误的位置。
 *    所以路径不在当前 store 目录下时一律重算。
 *
 * 现在只有一条调用路径：**导入老 JSON**（见 `#importLegacy`）。
 */
function migrate(raw: unknown, dir: string): StoreShape {
  const shape = (raw ?? {}) as Partial<StoreShape>;
  const environments = Array.isArray(shape.environments) ? shape.environments : [];
  const groups = Array.isArray(shape.groups) ? shape.groups : [];

  const sessionsRoot = path.join(dir, 'sessions');
  const normalized = environments.map((config, index) => {
    const order = typeof config.order === 'number' ? config.order : index;
    const inPlace =
      typeof config.storagePath === 'string' &&
      (config.storagePath === path.join(sessionsRoot, config.id) ||
        config.storagePath.startsWith(sessionsRoot + path.sep));
    return {
      ...config,
      order,
      groupId: config.groupId ?? undefined,
      // 老数据没有这一列：一律当人建的（审批策略里更保守的那一侧）
      createdBy: config.createdBy ?? 'human',
      storagePath: inPlace ? config.storagePath : path.join(sessionsRoot, config.id),
    } satisfies EnvironmentConfig;
  });

  // 环境指向一个不存在的分组时，把它挪回未分组——否则它在侧栏里不显示
  const groupIds = new Set(groups.map((group) => group.id));
  for (const config of normalized) {
    if (config.groupId && !groupIds.has(config.groupId)) config.groupId = undefined;
  }

  return {
    environments: normalized,
    groups: groups.map((group, index) => ({
      ...group,
      order: typeof group.order === 'number' ? group.order : index,
      collapsed: Boolean(group.collapsed),
    })),
  };
}

/** `running.json` 归一：坏内容一律当「没有要恢复的」，不让一个坏文件挡住启动。 */
function normalizeRunning(raw: unknown): RunningSnapshot {
  const shape = (raw ?? {}) as Partial<RunningSnapshot>;
  const running = Array.isArray(shape.running)
    ? shape.running.filter((id): id is string => typeof id === 'string' && Boolean(id))
    : [];
  return {
    running,
    selected: typeof shape.selected === 'string' ? shape.selected : undefined,
    dormant: Array.isArray(shape.dormant)
      ? shape.dormant.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : [],
  };
}

export class Store {
  #dir: string;
  #dbFile: string;
  #legacyFile: string;
  #legacyTempFile: string;
  #runningFile: string;
  #runningTempFile: string;
  #db?: DatabaseSync;
  /** 事件插入计数：攒够一批再清理一次，别每条都 COUNT。 */
  #recorded = 0;

  constructor(dir: string) {
    this.#dir = dir;
    this.#dbFile = path.join(dir, 'warren.db');
    this.#legacyFile = path.join(dir, 'environments.json');
    this.#legacyTempFile = path.join(dir, 'environments.json.tmp');
    this.#runningFile = path.join(dir, 'running.json');
    this.#runningTempFile = path.join(dir, 'running.json.tmp');
  }

  /** 数据库文件路径（诊断用）。 */
  get file(): string {
    return this.#dbFile;
  }

  /** 共享连接：vault / 插件 / 遥测都往这一个库上写（见 `db.ts`）。 */
  get database(): DatabaseSync {
    if (!this.#db) throw new Error('store.load() 必须先调用');
    return this.#db;
  }

  // ------------------------------------------------------------- 应用级设置

  /**
   * 审批策略等应用级设置。
   *
   * **写只有界面这一条路**（`setAppSettings` 只被 `main.ts` 的 IPC 调）——
   * agent 能给自己放行的话，审批这道门就等于不存在。
   * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3.4。
   */
  appSettings(): AppSettings {
    const rows = this.#database.prepare('SELECT key, value FROM app_settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const raw: Record<string, string> = {};
    for (const row of rows) raw[row.key] = row.value;
    return toAppSettings(raw);
  }

  setAppSettings(patch: Partial<AppSettings>): AppSettings {
    const now = new Date().toISOString();
    const statement = this.#database.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    );
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      statement.run(key, String(value), now);
    }
    return this.appSettings();
  }

  async load(): Promise<void> {
    // 打开 + 建表 + 坏库兜底都在 openDatabase 里（一个文件一条连接）
    this.#db = openDatabase(this.#dbFile);
    await this.#importLegacy();
    this.#reconcileStoragePaths();
    this.#pruneEvents();
  }

  /**
   * `storagePath` 是**派生的**（`<storeDir>/sessions/<id>`），但库里存的是绝对路径。
   *
   * 数据根一挪（换机器 / 改 `WARREN_HOME`），旧路径就悬空 —— 而 Chromium 会照着悬空路径
   * 把旧目录重新建出来，于是数据悄悄写到错误的位置。以前这段逻辑只在「导入老 JSON」
   * 那条路上有，现在每次 load 都对一遍（已经对的就跳过，是幂等的）。
   *
   * `trustedCa` 指向 `<storagePath>/…` 时跟着一起改写；指向别处的原样留着。
   */
  #reconcileStoragePaths(): void {
    for (const config of this.list()) {
      const expected = this.storagePathFor(config.id);
      if (config.storagePath === expected) continue;
      const trustedCa =
        config.trustedCa && config.trustedCa.startsWith(config.storagePath + path.sep)
          ? path.join(expected, path.relative(config.storagePath, config.trustedCa))
          : config.trustedCa;
      this.#insertConfig({ ...config, storagePath: expected, trustedCa });
    }
  }

  get #database(): DatabaseSync {
    return this.database;
  }

  /**
   * 一次性把老的 JSON 导入 SQLite。
   *
   * 只在**库里一个环境都没有**时做（不然每次启动都会把老文件再倒一遍）。
   * 老文件优先读 tmp：上次写崩在 rename 之前时，tmp 才是更新的那一份。
   */
  async #importLegacy(): Promise<void> {
    if (this.#count('environments') > 0 || this.#count('groups') > 0) return;
    const raw = await this.#readFirstIntact([this.#legacyTempFile, this.#legacyFile]);
    const running = normalizeRunning(await this.#readFirstIntact([this.#runningTempFile, this.#runningFile]));
    if (raw === null && running.running.length === 0) return;

    const shape = raw === null ? { environments: [], groups: [] } : migrate(raw, this.#dir);
    tx(this.#database, () => {
      for (const group of shape.groups) this.#insertGroup(group);
      for (const config of shape.environments) this.#insertConfig(config);
    });
    this.saveRunning(running);

    // 留档而不是删除：迁移错了还能人工捞回来
    for (const file of [this.#legacyFile, this.#legacyTempFile, this.#runningFile, this.#runningTempFile]) {
      try {
        await rename(file, `${file}${MIGRATED_SUFFIX}`);
      } catch {
        // 文件不存在就算了
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

  /** 按顺序读，第一个能解析成 JSON 的胜出。全都坏了才返回 null（退回空 store）。 */
  async #readFirstIntact(paths: string[]): Promise<unknown | null> {
    for (const file of paths) {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch {
        // 缺失或损坏，试下一个
      }
    }
    return null;
  }

  #count(table: 'environments' | 'groups' | 'events'): number {
    const row = this.#database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row | undefined;
    return Number(row?.n ?? 0);
  }

  /** 整行 upsert：环境和分组的字段都是定长的一小撮，按行覆盖比逐字段 UPDATE 好维护。 */
  #insertConfig(config: EnvironmentConfig): void {
    this.#database
      .prepare(
        `INSERT OR REPLACE INTO environments
           (id, name, storage_path, proxy, trusted_ca, created_by, approval, start_url, headed, group_id, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        config.id,
        config.name,
        config.storagePath,
        config.proxy ?? null,
        config.trustedCa ?? null,
        config.createdBy,
        config.approval ?? null,
        config.startUrl ?? null,
        config.headed ? 1 : 0,
        config.groupId ?? null,
        config.order,
        config.createdAt,
        config.updatedAt,
      );
  }

  #insertGroup(group: Group): void {
    this.#database
      .prepare(
        `INSERT OR REPLACE INTO groups (id, name, sort_order, collapsed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(group.id, group.name, group.order, group.collapsed ? 1 : 0, group.createdAt, group.updatedAt);
  }

  #configsInGroup(groupId?: string): EnvironmentConfig[] {
    const rows =
      groupId === undefined
        ? this.#database.prepare('SELECT * FROM environments WHERE group_id IS NULL').all()
        : this.#database.prepare('SELECT * FROM environments WHERE group_id = ?').all(groupId);
    return (rows as Row[]).map(rowToConfig);
  }

  /** storage path 由 Core 决定，调用方不能指定任意绝对路径 */
  storagePathFor(id: string): string {
    return path.join(this.#dir, 'sessions', safeEnvKey(id));
  }

  // ---------------------------------------------------------------- 环境

  list(): Environment[] {
    const rows = this.#database.prepare('SELECT * FROM environments ORDER BY sort_order, rowid').all() as Row[];
    return rows.map((row) => toEnvironment(rowToConfig(row)));
  }

  get(id: string): Environment | undefined {
    const config = this.configFor(id);
    return config ? toEnvironment(config) : undefined;
  }

  configFor(id: string): EnvironmentConfig | undefined {
    const row = this.#database.prepare('SELECT * FROM environments WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToConfig(row) : undefined;
  }

  async create(input: {
    id: string;
    name?: string;
    proxy?: string;
    startUrl?: string;
    headed?: boolean;
    groupId?: string;
    createdBy?: Creator;
  }): Promise<Environment> {
    assertEnvironmentId(input.id);
    if (this.configFor(input.id)) {
      throw Object.assign(new Error(`environment ${input.id} already exists`), {
        code: 'ENV_EXISTS',
      });
    }
    if (input.groupId && !this.groupFor(input.groupId)) {
      throw Object.assign(new Error(`unknown group ${input.groupId}`), { code: 'GROUP_NOT_FOUND' });
    }
    const config = createEnvironmentConfig({
      id: input.id,
      name: input.name,
      storagePath: this.storagePathFor(input.id),
      proxy: input.proxy,
      startUrl: input.startUrl,
      headed: input.headed,
      groupId: input.groupId,
      createdBy: input.createdBy,
      order: nextOrder(this.#configsInGroup(input.groupId)),
    });
    this.#insertConfig(config);
    return toEnvironment(config);
  }

  async update(id: string, patch: EnvironmentPatch): Promise<Environment> {
    const config = this.configFor(id);
    if (!config) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    // 名字走同一条截断路径：create 和 update 不能一个报错一个截断
    const next: EnvironmentConfig = {
      ...config,
      ...(patch.name === undefined ? {} : { name: clampEnvironmentName(patch.name) }),
      // `null` 是「清掉这个字段」的显式信号：`undefined` 表示「这次不改它」。
      // 没有它，`proxy` / `trustedCa` 只能设不能清（解绑代理就没法做）。
      ...(patch.proxy === undefined ? {} : { proxy: patch.proxy ?? undefined }),
      ...(patch.trustedCa === undefined ? {} : { trustedCa: patch.trustedCa ?? undefined }),
      ...(patch.approval === undefined ? {} : { approval: patch.approval ?? undefined }),
      ...(patch.startUrl === undefined ? {} : { startUrl: patch.startUrl }),
      ...(patch.headed === undefined ? {} : { headed: patch.headed }),
      updatedAt: new Date().toISOString(),
    };
    this.#insertConfig(next);
    return toEnvironment(next);
  }

  async remove(id: string): Promise<void> {
    this.#database.prepare('DELETE FROM environments WHERE id = ?').run(id);
    this.#database.prepare('DELETE FROM dormant_state WHERE env_id = ?').run(id);
    // 运行态里也不该留下这个 id，否则下次启动会去恢复一个不存在的环境（白记一条 restoreFailed）
    this.#database.prepare('DELETE FROM running_state WHERE env_id = ?').run(id);
    // 标签同理：留着的话，id 被复用时会把别人的标签开回来
    this.#database.prepare('DELETE FROM env_tabs WHERE env_id = ?').run(id);
    this.#database.prepare('DELETE FROM domain_prefs WHERE env_id = ?').run(id);
  }

  async moveToGroup(id: string, groupId: string | undefined): Promise<Environment> {
    const config = this.configFor(id);
    if (!config) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    const moved = moveToGroup(config, groupId, this.listGroups(), this.list());
    this.#insertConfig(moved);
    return toEnvironment(moved);
  }

  /** 组内重排。只接受同一分组内的 id，跨组混排会被忽略。 */
  async reorderEnvironments(groupId: string | undefined, orderedIds: string[]): Promise<void> {
    const inGroup = this.#configsInGroup(groupId);
    const orderById = new Map(reorderBy(inGroup, orderedIds).map((item, index) => [item.id, index]));
    const now = new Date().toISOString();
    for (const [id, order] of orderById) {
      this.#database.prepare('UPDATE environments SET sort_order = ?, updated_at = ? WHERE id = ?').run(order, now, id);
    }
  }

  // ---------------------------------------------------------------- 分组

  listGroups(): Group[] {
    const rows = this.#database.prepare('SELECT * FROM groups ORDER BY sort_order, rowid').all() as Row[];
    return rows.map(rowToGroup);
  }

  groupFor(id: string): Group | undefined {
    const row = this.#database.prepare('SELECT * FROM groups WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToGroup(row) : undefined;
  }

  async createGroup(input: { id?: string; name: string }): Promise<Group> {
    const group = createGroup({ ...input, order: nextOrder(this.listGroups()) });
    if (this.groupFor(group.id)) {
      throw Object.assign(new Error(`group ${group.id} already exists`), { code: 'GROUP_EXISTS' });
    }
    this.#insertGroup(group);
    return group;
  }

  async renameGroup(id: string, name: string): Promise<Group> {
    const group = this.groupFor(id);
    if (!group) throw Object.assign(new Error(`unknown group ${id}`), { code: 'GROUP_NOT_FOUND' });
    const renamed = renameGroup(group, name);
    this.#insertGroup(renamed);
    return renamed;
  }

  async setGroupCollapsed(id: string, collapsed: boolean): Promise<Group> {
    const group = this.groupFor(id);
    if (!group) throw Object.assign(new Error(`unknown group ${id}`), { code: 'GROUP_NOT_FOUND' });
    const next = setGroupCollapsed(group, collapsed);
    this.#insertGroup(next);
    return next;
  }

  /**
   * 删除分组。**默认保留组内环境**，把它们移出分组。
   * 删组顺手删环境是数据丢失，不能做默认行为。
   */
  async removeGroup(id: string): Promise<{ detached: number }> {
    if (!this.groupFor(id)) throw Object.assign(new Error(`unknown group ${id}`), { code: 'GROUP_NOT_FOUND' });
    const detached = this.#configsInGroup(id).length;
    const next = detachGroupEnvironments(this.list(), id);
    tx(this.#database, () => {
      for (const config of next) this.#insertConfig(config);
      this.#database.prepare('DELETE FROM groups WHERE id = ?').run(id);
    });
    return { detached };
  }

  async reorderGroups(orderedIds: string[]): Promise<void> {
    const orderById = new Map(reorderBy(this.listGroups(), orderedIds).map((group, index) => [group.id, index]));
    const now = new Date().toISOString();
    for (const [id, order] of orderById) {
      this.#database.prepare('UPDATE groups SET sort_order = ?, updated_at = ? WHERE id = ?').run(order, now, id);
    }
  }

  // ---------------------------------------------------------------- 运行态

  /**
   * 上次运行中的环境（启动时读一次）。
   *
   * 写是**同步**的：它只发生在 start / stop / select 这种人手尺度的事件上，
   * 而退出路径（`shutdown()` → 逐个 `stop()`）必须是同步的——
   * `before-quit` 里发出去的异步写根本来不及落盘，进程就没了。
   */
  runningSnapshot(): RunningSnapshot {
    const rows = this.#database.prepare('SELECT env_id, selected FROM running_state').all() as Row[];
    const selected = rows.find((row) => row.selected === 1)?.env_id;
    const dormant = (this.#database.prepare('SELECT env_id FROM dormant_state').all() as Row[]).map((row) =>
      String(row.env_id),
    );
    return {
      running: rows.map((row) => String(row.env_id)),
      selected: selected === undefined ? undefined : String(selected),
      dormant,
    };
  }

  saveRunning(snapshot: RunningSnapshot): void {
    try {
      const db = this.#database;
      tx(db, () => {
        db.exec('DELETE FROM running_state');
        const insert = db.prepare('INSERT OR REPLACE INTO running_state (env_id, selected) VALUES (?, ?)');
        for (const id of snapshot.running) insert.run(id, snapshot.selected === id ? 1 : 0);
        db.exec('DELETE FROM dormant_state');
        const insertDormant = db.prepare('INSERT OR REPLACE INTO dormant_state (env_id, slept_at) VALUES (?, ?)');
        for (const id of snapshot.dormant ?? []) insertDormant.run(id, new Date().toISOString());
      });
    } catch {
      // 记不住运行态不该影响任何一次 start / stop
    }
  }

  // ---------------------------------------------------------------- 标签

  /**
   * 上次开着的标签，按位置排序。
   *
   * 停环境不清（`env stop` 之后 `env start` 应当把那一组标签开回来）；
   * 删环境清（`remove()` 里连带删）——否则 id 被复用时会把别人的标签带回来。
   */
  tabsFor(envId: string): RememberedTab[] {
    const rows = this.#database
      .prepare('SELECT space, url, active FROM env_tabs WHERE env_id = ? ORDER BY position')
      .all(envId) as Row[];
    return rows.map((row) => ({
      space: row.space === 'agent' ? 'agent' : 'person',
      url: String(row.url),
      active: row.active === 1,
    }));
  }

  /** 整组覆盖写（标签就几个，不值得做 diff）。同步写：调用方是标签变化那条路，频率人手级别。 */
  saveTabs(envId: string, tabs: RememberedTab[]): void {
    try {
      const db = this.#database;
      tx(db, () => {
        db.prepare('DELETE FROM env_tabs WHERE env_id = ?').run(envId);
        const insert = db.prepare(
          'INSERT OR REPLACE INTO env_tabs (env_id, position, space, url, active) VALUES (?, ?, ?, ?, ?)',
        );
        tabs.forEach((tab, index) => insert.run(envId, index, tab.space, tab.url, tab.active ? 1 : 0));
      });
    } catch {
      // 记不住标签不影响任何一次操作
    }
  }

  // ---------------------------------------------------------------- 地址历史

  /**
   * 记录一次实际导航。只接受 http/https；跨环境共用，重复 URL 只累计次数。
   * 5000 条是提示列表的实用上限，不保留完整浏览历史。
   */
  recordUrlHistory(rawUrl: string): void {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || rawUrl.length > 8192) return;
    const now = new Date().toISOString();
    const db = this.#database;
    try {
      tx(db, () => {
        db.prepare(
          `INSERT INTO url_history (url, visit_count, last_visited_at) VALUES (?, 1, ?)
           ON CONFLICT(url) DO UPDATE SET
             visit_count = url_history.visit_count + 1,
             last_visited_at = excluded.last_visited_at`,
        ).run(rawUrl, now);
        db.prepare(
          `DELETE FROM url_history WHERE url NOT IN (
             SELECT url FROM url_history ORDER BY last_visited_at DESC LIMIT ?
           )`,
        ).run(URL_HISTORY_LIMIT);
      });
    } catch {
      // 历史记录不能影响页面导航
    }
  }

  /** 前缀/子串匹配；命中位置越靠前越优先，同位置按最近访问排序。 */
  searchUrlHistory(query: string, limit = 8): UrlHistoryEntry[] {
    const q = query.trim().slice(0, 256);
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 8;
    const rows = this.#database
      .prepare(
        `SELECT url, visit_count, last_visited_at
         FROM url_history
         WHERE ? = '' OR instr(lower(url), lower(?)) > 0
         ORDER BY CASE WHEN ? = '' THEN 0 ELSE instr(lower(url), lower(?)) END,
                  last_visited_at DESC
         LIMIT ?`,
      )
      .all(q, q, q, q, size) as Row[];
    return rows.map(rowToUrlHistory);
  }

  /** 清空跨环境地址输入历史。 */
  clearUrlHistory(): number {
    const result = this.#database.prepare('DELETE FROM url_history').run();
    return Number(result.changes ?? 0);
  }

  // ---------------------------------------------------------------- 按域偏好

  domainPref(envId: string, origin: string): DomainPref | undefined {
    const row = this.#database
      .prepare(
        'SELECT env_id, origin, zoom_factor, viewport_preset, updated_at FROM domain_prefs WHERE env_id = ? AND origin = ?',
      )
      .get(envId, origin) as Row | undefined;
    if (!row) return undefined;
    const preset = optionalText(row.viewport_preset) as ViewportPresetId | undefined;
    return {
      envId: String(row.env_id),
      origin: String(row.origin),
      zoomFactor: Number(row.zoom_factor ?? 1),
      viewportPreset: preset,
      updatedAt: String(row.updated_at),
    };
  }

  listDomainPrefs(envId?: string): DomainPref[] {
    const rows = (
      envId === undefined
        ? this.#database
            .prepare(
              'SELECT env_id, origin, zoom_factor, viewport_preset, updated_at FROM domain_prefs ORDER BY updated_at DESC',
            )
            .all()
        : this.#database
            .prepare(
              'SELECT env_id, origin, zoom_factor, viewport_preset, updated_at FROM domain_prefs WHERE env_id = ? ORDER BY updated_at DESC',
            )
            .all(envId)
    ) as Row[];
    return rows.map((row) => ({
      envId: String(row.env_id),
      origin: String(row.origin),
      zoomFactor: Number(row.zoom_factor ?? 1),
      viewportPreset: optionalText(row.viewport_preset) as ViewportPresetId | undefined,
      updatedAt: String(row.updated_at),
    }));
  }

  setDomainPref(
    envId: string,
    origin: string,
    patch: { zoomFactor?: number; viewportPreset?: ViewportPresetId | null },
  ): DomainPref {
    const current = this.domainPref(envId, origin);
    const nextZoom =
      patch.zoomFactor !== undefined && Number.isFinite(patch.zoomFactor)
        ? Math.max(0.25, Math.min(5, Math.round(patch.zoomFactor * 100) / 100))
        : (current?.zoomFactor ?? 1);
    const nextPreset =
      patch.viewportPreset === null
        ? undefined
        : patch.viewportPreset !== undefined
          ? patch.viewportPreset
          : current?.viewportPreset;
    const updatedAt = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO domain_prefs (env_id, origin, zoom_factor, viewport_preset, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(env_id, origin) DO UPDATE SET
           zoom_factor = excluded.zoom_factor,
           viewport_preset = excluded.viewport_preset,
           updated_at = excluded.updated_at`,
      )
      .run(envId, origin, nextZoom, nextPreset ?? null, updatedAt);
    return {
      envId,
      origin,
      zoomFactor: nextZoom,
      viewportPreset: nextPreset,
      updatedAt,
    };
  }

  removeDomainPref(envId: string, origin: string): boolean {
    const result = this.#database
      .prepare('DELETE FROM domain_prefs WHERE env_id = ? AND origin = ?')
      .run(envId, origin);
    return Number(result.changes ?? 0) > 0;
  }

  // ---------------------------------------------------------------- 事件

  record(event: EventRecord): EventRecord {
    this.#database
      .prepare(
        'INSERT OR REPLACE INTO events (id, environment_id, type, actor, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(event.id, event.environmentId ?? null, event.type, event.actor, event.message, event.createdAt);
    this.#recorded += 1;
    if (this.#recorded % 100 === 0 && this.#count('events') > EVENT_LIMIT) this.#pruneEvents();
    return event;
  }

  /** 最近的 `limit` 条，按时间**升序**返回（和以前的内存缓冲一致：调用方从末尾看最新的）。 */
  events(environmentId?: string, limit = 100): EventRecord[] {
    const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
    const rows =
      environmentId === undefined
        ? this.#database.prepare('SELECT * FROM events ORDER BY created_at DESC, rowid DESC LIMIT ?').all(size)
        : this.#database
            .prepare('SELECT * FROM events WHERE environment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
            .all(environmentId, size);
    return (rows as Row[]).map(rowToEvent).reverse();
  }

  /** 按游标 `afterId` 或时间戳 `since` 增量读取事件（按入库顺序升序），供 `warren events --follow` 使用。 */
  eventsSince(
    options: { environmentId?: string; afterId?: string; since?: string; limit?: number } = {},
  ): EventRecord[] {
    const size =
      Number.isFinite(options.limit) && (options.limit ?? 0) > 0 ? Math.min(500, Math.floor(options.limit!)) : 100;
    let afterRowId = 0;
    if (options.afterId) {
      const anchor = this.#database.prepare('SELECT rowid FROM events WHERE id = ?').get(options.afterId) as
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
    return (this.#database.prepare(sql).all(...args) as Row[]).map(rowToEvent);
  }

  // ---------------------------------------------------------------- 站点记忆

  getSiteNote(site: string): SiteNote | undefined {
    const key = normalizeSiteKey(site);
    const row = this.#database
      .prepare('SELECT site, content, updated_by, updated_at FROM site_notes WHERE site = ?')
      .get(key) as Row | undefined;
    if (!row) return undefined;
    return {
      site: String(row.site),
      content: String(row.content),
      updatedBy: String(row.updated_by ?? 'human'),
      updatedAt: String(row.updated_at),
    };
  }

  listSiteNotes(): SiteNote[] {
    const rows = this.#database
      .prepare('SELECT site, content, updated_by, updated_at FROM site_notes ORDER BY updated_at DESC')
      .all() as Row[];
    return rows.map((row) => ({
      site: String(row.site),
      content: String(row.content),
      updatedBy: String(row.updated_by ?? 'human'),
      updatedAt: String(row.updated_at),
    }));
  }

  /** 按域名与路径前缀匹配当前页面命中的站点记忆（最长前缀优先，严格不返回空）。 */
  matchSiteNotesForUrl(rawUrl: string): SiteNote[] {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return [];
    }
    if (!/^https?:$/i.test(parsed.protocol)) return [];
    const host = parsed.host.toLowerCase();
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    const full = `${host}${cleanPath}`;
    return this.listSiteNotes()
      .filter((note) => {
        if (note.site === host || note.site === full) return true;
        if (note.site.startsWith(`${host}/`)) {
          return full === note.site || full.startsWith(`${note.site}/`);
        }
        return host.endsWith(`.${note.site}`);
      })
      .sort((a, b) => b.site.length - a.site.length);
  }

  setSiteNote(site: string, content: string, updatedBy = 'human'): SiteNote {
    const key = normalizeSiteKey(site);
    const safeContent = assertNoteSafe(content);
    const updatedAt = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO site_notes (site, content, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(site) DO UPDATE SET
           content = excluded.content,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(key, safeContent, updatedBy, updatedAt);
    return { site: key, content: safeContent, updatedBy, updatedAt };
  }

  appendSiteNote(site: string, text: string, updatedBy = 'human'): SiteNote {
    const key = normalizeSiteKey(site);
    const addition = assertNoteSafe(text);
    const existing = this.getSiteNote(key);
    const merged = existing ? `${existing.content}\n${addition}` : addition;
    return this.setSiteNote(key, merged, updatedBy);
  }

  removeSiteNote(site: string): boolean {
    const key = normalizeSiteKey(site);
    const result = this.#database.prepare('DELETE FROM site_notes WHERE site = ?').run(key);
    return Number(result.changes ?? 0) > 0;
  }

  #pruneEvents(): void {
    this.#database
      .prepare(
        `DELETE FROM events WHERE id IN (
           SELECT id FROM events ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(EVENT_LIMIT);
  }
}
