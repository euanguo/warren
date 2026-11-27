/**
 * 插件自己的存储。
 *
 * 两档（对标 bb 的 storage.kv / storage.database）：
 * - `kv`：小状态、游标、链接。单键 ≤64KB，整库 ≤2MB，超了**报错**而不是静默截断。
 *   落在 `warren.db` 的 `plugin_values`（scope='kv'）。
 * - `db()`：插件自己的 SQLite（Electron 44 内置 Node 24 的 `node:sqlite`，零依赖）。
 *   **故意留在 `<coreDir>/plugins/<id>/data.db`**：那是插件拥有的 schema（插件 API 给的是裸 SQL），
 *   分开放才能保证「卸载 = 删目录」和插件之间互不可见。这是隔离，不是没统一。
 *
 * 卸载时插件目录整目录删掉；库里的行按 plugin_id 删（`host.uninstall` 里做）。
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const KV_MAX_VALUE_BYTES = 64 * 1024;
export const KV_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface PluginStorageOptions {
  dir: string;
  /** 独立于插件代码目录的 SQLite 数据目录（默认落于 `<coreDir>/plugin-data/<id>`），防止被静态协议暴露。 */
  dataDir?: string;
  pluginId: string;
  /** 共享连接（`warren.db`）。 */
  db: DatabaseSync;
}

/** 剥离 SQL 字符串字面量、注释与引号标识符，避免关键词检查误伤业务数据。 */
function stripSqlLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' _ ';
      continue;
    }
    if (ch === '[') {
      i += 1;
      while (i < sql.length && sql[i] !== ']') i += 1;
      i += 1;
      out += ' _ ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const READONLY_PRAGMA_RE =
  /^PRAGMA\s+(?:main\.)?(?:table_info|table_xinfo|index_list|index_info|foreign_key_list)\s*\([^;]*\)$/i;
const FORBIDDEN_SQL_RE = /\b(ATTACH|DETACH|LOAD_EXTENSION)\b|\bVACUUM\s+INTO\b/i;
const READONLY_START_RE = /^(SELECT|WITH|EXPLAIN|VALUES)\b/i;
const WRITE_KEYWORD_RE =
  /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|REINDEX|VACUUM|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/**
 * 校验插件 SQL 边界：
 * - 全通道禁止 `ATTACH` / `DETACH` / `VACUUM INTO` / `LOAD_EXTENSION` 与危险 `PRAGMA`（防跨库读写）；
 * - `readOnly: true`（`storage.sql.query`）只允许单条只读查询或表结构自省 `PRAGMA table_info(...)`。
 */
export function assertSafePluginSql(sql: string, options: { readOnly?: boolean } = {}): void {
  const stripped = stripSqlLiteralsAndComments(sql)
    .trim()
    .replace(/;+\s*$/, '');
  if (!stripped) {
    throw Object.assign(new Error('SQL 语句不能为空'), { code: 'PLUGIN_SQL_FORBIDDEN' });
  }
  if (FORBIDDEN_SQL_RE.test(stripped)) {
    throw Object.assign(new Error('插件 SQL 禁止执行 ATTACH / DETACH / VACUUM INTO / LOAD_EXTENSION'), {
      code: 'PLUGIN_SQL_FORBIDDEN',
    });
  }
  const statements = stripped
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    if (/^PRAGMA\b/i.test(stmt) && !READONLY_PRAGMA_RE.test(stmt)) {
      throw Object.assign(new Error(`插件 SQL 禁止执行该 PRAGMA: ${stmt.slice(0, 64)}`), {
        code: 'PLUGIN_SQL_FORBIDDEN',
      });
    }
  }
  if (options.readOnly) {
    if (statements.length !== 1) {
      throw Object.assign(new Error('storage.sql.query 只允许单条只读语句'), { code: 'PLUGIN_SQL_FORBIDDEN' });
    }
    const stmt = statements[0]!;
    if (READONLY_PRAGMA_RE.test(stmt)) return;
    if (!READONLY_START_RE.test(stmt) || WRITE_KEYWORD_RE.test(stmt)) {
      throw Object.assign(new Error('storage.sql.query 只允许只读 SELECT / WITH / EXPLAIN / PRAGMA table_info'), {
        code: 'PLUGIN_SQL_FORBIDDEN',
      });
    }
  }
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

export class PluginStorage {
  #dir: string;
  #dataDir: string;
  #pluginId: string;
  #db: DatabaseSync;
  #kv: Record<string, unknown> = {};
  #pluginDb?: DatabaseSync;
  #dbFile: string;

  constructor(options: PluginStorageOptions) {
    this.#dir = options.dir;
    this.#dataDir = options.dataDir ?? options.dir;
    this.#pluginId = options.pluginId;
    this.#db = options.db;
    this.#dbFile = path.join(this.#dataDir, 'data.db');
  }

  get dir(): string {
    return this.#dir;
  }

  get dataDir(): string {
    return this.#dataDir;
  }

  async load(): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true });
    await this.#migrateLegacyDbIfNeeded();
    this.#kv = this.#readKv();
  }

  /** 从 SQLite 重新同步 KV 内存视图（用于热重载旧实例 dispose 落盘后的缓存一致）。 */
  refreshKv(): void {
    this.#kv = this.#readKv();
  }

  async #migrateLegacyDbIfNeeded(): Promise<void> {
    if (path.resolve(this.#dataDir) === path.resolve(this.#dir)) return;
    const legacyDb = path.join(this.#dir, 'data.db');
    if (!existsSync(legacyDb) || existsSync(this.#dbFile)) return;
    for (const suffix of ['', '-wal', '-shm']) {
      const from = `${legacyDb}${suffix}`;
      const to = `${this.#dbFile}${suffix}`;
      if (!existsSync(from)) continue;
      await copyFile(from, to);
    }
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${legacyDb}${suffix}`, { force: true }).catch(() => undefined);
    }
  }

  #readKv(): Record<string, unknown> {
    const rows = this.#db
      .prepare("SELECT key, value FROM plugin_values WHERE plugin_id = ? AND scope = 'kv'")
      .all(this.#pluginId) as Array<{ key: string; value: string }>;
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        // 坏值当没设过，别让一条垃圾把整个 kv 带崩
      }
    }
    return out;
  }

  #putKvKey(key: string, value: unknown): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO plugin_values (plugin_id, scope, key, value) VALUES (?, ?, ?, ?)')
      .run(this.#pluginId, 'kv', key, JSON.stringify(value ?? null));
  }

  #deleteKvKey(key: string): void {
    this.#db
      .prepare("DELETE FROM plugin_values WHERE plugin_id = ? AND scope = 'kv' AND key = ?")
      .run(this.#pluginId, key);
  }

  #total(): number {
    return Object.values(this.#kv).reduce<number>((sum, value) => sum + sizeOf(value), 0);
  }

  get(key: string): unknown {
    return this.#kv[key] ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    if (typeof key !== 'string' || !key || key.length > 256) {
      throw Object.assign(new Error('storage.kv key 必须是 1-256 字符的字符串'), {
        code: 'PLUGIN_STORAGE_BAD_KEY',
      });
    }
    const next = sizeOf(value);
    if (next > KV_MAX_VALUE_BYTES) {
      throw Object.assign(new Error(`storage.kv 单键上限 ${KV_MAX_VALUE_BYTES} 字节，收到 ${next}`), {
        code: 'PLUGIN_STORAGE_TOO_LARGE',
      });
    }
    const previous = sizeOf(this.#kv[key]);
    if (this.#total() - previous + next > KV_MAX_TOTAL_BYTES) {
      throw Object.assign(new Error(`storage.kv 总量上限 ${KV_MAX_TOTAL_BYTES} 字节，超了请用 storage.db`), {
        code: 'PLUGIN_STORAGE_TOO_LARGE',
      });
    }
    this.#kv[key] = value;
    this.#putKvKey(key, value);
  }

  async delete(key: string): Promise<boolean> {
    if (!(key in this.#kv)) return false;
    delete this.#kv[key];
    this.#deleteKvKey(key);
    return true;
  }

  list(prefix = ''): Array<{ key: string; value: unknown }> {
    return Object.entries(this.#kv)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }

  /** 打开（或复用）插件的 SQLite。句柄由核心托管，卸载/重载时关闭。 */
  db(): DatabaseSync {
    if (this.#pluginDb) return this.#pluginDb;
    const db = new DatabaseSync(this.#dbFile);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA busy_timeout = 5000');
    this.#pluginDb = db;
    return db;
  }

  /**
   * 迁移：语句下标就是版本号，只跑没跑过的。
   * **只允许追加**——改已发布的语句等于跳过别人的迁移。
   */
  migrate(statements: string[]): number {
    for (const statement of statements) assertSafePluginSql(statement);
    const db = this.db();
    db.exec('CREATE TABLE IF NOT EXISTS _warren_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(
      (db.prepare('SELECT id FROM _warren_migrations').all() as Array<{ id: number }>).map((row) => row.id),
    );
    let count = 0;
    for (let index = 0; index < statements.length; index += 1) {
      if (applied.has(index)) continue;
      db.exec('BEGIN');
      try {
        db.exec(statements[index]);
        db.prepare('INSERT INTO _warren_migrations (id, applied_at) VALUES (?, ?)').run(
          index,
          new Date().toISOString(),
        );
        db.exec('COMMIT');
        count += 1;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return count;
  }

  close(): void {
    try {
      this.#pluginDb?.close();
    } catch {
      // 已经关了
    }
    this.#pluginDb = undefined;
  }
}
