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
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tx } from '../db.ts';

export const KV_MAX_VALUE_BYTES = 64 * 1024;
export const KV_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface PluginStorageOptions {
  dir: string;
  pluginId: string;
  /** 共享连接（`warren.db`）。 */
  db: DatabaseSync;
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

export class PluginStorage {
  #dir: string;
  #pluginId: string;
  #db: DatabaseSync;
  #kv: Record<string, unknown> = {};
  #pluginDb?: DatabaseSync;
  #dbFile: string;

  constructor(options: PluginStorageOptions) {
    this.#dir = options.dir;
    this.#pluginId = options.pluginId;
    this.#db = options.db;
    this.#dbFile = path.join(options.dir, 'data.db');
  }

  get dir(): string {
    return this.#dir;
  }

  async load(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    this.#kv = this.#readKv();
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

  #writeKv(): void {
    tx(this.#db, () => {
      this.#db.prepare("DELETE FROM plugin_values WHERE plugin_id = ? AND scope = 'kv'").run(this.#pluginId);
      const insert = this.#db.prepare(
        'INSERT OR REPLACE INTO plugin_values (plugin_id, scope, key, value) VALUES (?, ?, ?, ?)',
      );
      for (const [key, value] of Object.entries(this.#kv)) {
        insert.run(this.#pluginId, 'kv', key, JSON.stringify(value ?? null));
      }
    });
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
    this.#writeKv();
  }

  async delete(key: string): Promise<boolean> {
    if (!(key in this.#kv)) return false;
    delete this.#kv[key];
    this.#writeKv();
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
    db.exec('PRAGMA busy_timeout = 5000');
    this.#pluginDb = db;
    return db;
  }

  /**
   * 迁移：语句下标就是版本号，只跑没跑过的。
   * **只允许追加**——改已发布的语句等于跳过别人的迁移。
   */
  migrate(statements: string[]): number {
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
