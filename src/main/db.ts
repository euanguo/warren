/**
 * 应用自己的那**一个** SQLite 连接（`<coreDir>/warren.db`）。
 *
 * 所有落盘的结构化状态都在这一个库里：
 * 环境 / 分组 / 事件 / 运行态（`store.ts`）、凭据（`vault/`）、
 * 插件注册表 / 插件 kv 与设置 / 插件日志（`plugins/`）、console 与 network 摘要（`telemetry.ts`）。
 *
 * **一个文件一个连接**：`openDatabase()` 第二次传同一个路径拿到的是同一个句柄。
 * 一个进程里开好几条连接去写同一个库，只会自己跟自己抢写锁（WAL 允许并发读，写仍然只有一个）。
 *
 * 唯一**不在**这个库里的持久化是插件自己的 `data.db`：那是插件拥有的 schema
 * （插件 API 给的是裸 SQL，插件可以 `DROP TABLE`），分开放才能保证
 * 「卸载 = 删目录」和「插件之间互不可见」。这是隔离问题，不是 JSON/SQLite 问题。
 */
import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 全库 schema。
 *
 * 只用 `CREATE TABLE IF NOT EXISTS`，所以「加表」是纯追加、可以随版本往前走；
 * 改列（重命名 / 改类型）要另开迁移——现在还没有这种改动，别提前造版本号机制。
 */
export const SCHEMA = `
-- ── 环境 / 分组 / 事件 / 运行态 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  proxy TEXT,
  trusted_ca TEXT,
  created_by TEXT,
  approval TEXT,
  start_url TEXT,
  headed INTEGER NOT NULL DEFAULT 1,
  group_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS environments_group ON environments (group_id, sort_order);

-- ── 应用级设置（审批策略等；只有界面能写，见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3.4）
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  environment_id TEXT,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_created ON events (created_at);
CREATE INDEX IF NOT EXISTS events_environment ON events (environment_id, created_at);

-- 「上次退出时谁在跑」。selected 只在运行中的环境上有意义，所以它就是这张表里的一个标记位。
CREATE TABLE IF NOT EXISTS running_state (
  env_id TEXT PRIMARY KEY,
  selected INTEGER NOT NULL DEFAULT 0
);

-- 休眠中的环境：页面已销毁，但配置和标签快照都在，下次被用到时透明唤醒。
CREATE TABLE IF NOT EXISTS dormant_state (
  env_id TEXT PRIMARY KEY,
  slept_at TEXT NOT NULL
);

-- 每个环境上次开着的标签（环境停掉 / 应用退出都留着，下次 start 原样开回来）。
-- 只记 URL 与「哪个是激活的」：标题、图标、滚动位置都跟着页面重新加载，不存。
-- **POST 过的页面恢复不了**（浏览器本来就这样），恢复出来的是那个地址的干净页面。
CREATE TABLE IF NOT EXISTS env_tabs (
  env_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  space TEXT NOT NULL DEFAULT 'person',
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (env_id, position)
);

-- 跨环境共用的地址历史。只记 http/https，重复访问原地累计。
CREATE TABLE IF NOT EXISTS url_history (
  url TEXT PRIMARY KEY,
  visit_count INTEGER NOT NULL DEFAULT 1,
  last_visited_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS url_history_recent ON url_history (last_visited_at DESC);

-- ── 凭据（密文；明文永不落盘，也没有 reveal 通道）────────────────────
CREATE TABLE IF NOT EXISTS vault (
  ref TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  username_hint TEXT NOT NULL DEFAULT '',
  cipher TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── 插件注册表（以前是 plugins/state.json）──────────────────────────
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  granted TEXT NOT NULL DEFAULT '[]',
  digest TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  package_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  resolved TEXT NOT NULL DEFAULT '',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── 插件自己的键值（以前是 kv.json 与 settings.json）────────────────
CREATE TABLE IF NOT EXISTS plugin_values (
  plugin_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, scope, key)
);

-- ── 插件日志（以前是 plugin.log）────────────────────────────────────
CREATE TABLE IF NOT EXISTS plugin_logs (
  plugin_id TEXT NOT NULL,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plugin_logs_plugin ON plugin_logs (plugin_id, at);

-- ── 遥测（以前是主进程内存里的环形缓冲，重启即清空）────────────────
CREATE TABLE IF NOT EXISTS console_entries (
  id INTEGER PRIMARY KEY,
  env_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  line INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS console_entries_env ON console_entries (env_id, id);

CREATE TABLE IF NOT EXISTS network_entries (
  id INTEGER PRIMARY KEY,
  env_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER NOT NULL,
  resource_type TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS network_entries_env ON network_entries (env_id, id);

CREATE TABLE IF NOT EXISTS domain_prefs (
  env_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  zoom_factor REAL NOT NULL DEFAULT 1.0,
  viewport_preset TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (env_id, origin)
);

-- 站点记忆（按域名或路径前缀沉淀非凭据备忘；绝不存放密码或 token）
CREATE TABLE IF NOT EXISTS site_notes (
  site TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'human',
  updated_at TEXT NOT NULL
);
`;

/** 一个文件一条连接。 */
const connections = new Map<string, DatabaseSync>();

/**
 * 打开（或复用）这个库。
 *
 * 坏库不让应用起不来：挪成 `<file>.corrupt-<ts>` 再开一个新的，
 * 用户至少能进界面，坏的那份可以人工用 `sqlite3` 抢救。
 */
export function openDatabase(file: string): DatabaseSync {
  const existing = connections.get(file);
  if (existing) return existing;
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  let db: DatabaseSync;
  try {
    db = create(file);
  } catch (error) {
    const aside = `${file}.corrupt-${Date.now()}`;
    console.error('[db] 打不开数据库，挪到', aside, error);
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        renameSync(`${file}${suffix}`, `${aside}${suffix}`);
      } catch {
        // 不存在就算了
      }
    }
    db = create(file);
  }
  connections.set(file, db);
  return db;
}

function create(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  // WAL：读写不互斥；busy_timeout：别的进程（比如人工开的 sqlite3）持锁时等一会儿再报错
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 后来加的列。`SCHEMA` 是 `CREATE TABLE IF NOT EXISTS`，对老库那句 CREATE 直接被跳过。 */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, type: string]> = [
  ['environments', 'trusted_ca', 'TEXT'],
  ['environments', 'created_by', 'TEXT'],
  ['environments', 'approval', 'TEXT'],
  ['plugins', 'package_name', "TEXT NOT NULL DEFAULT ''"],
  ['plugins', 'source', "TEXT NOT NULL DEFAULT ''"],
  ['plugins', 'resolved', "TEXT NOT NULL DEFAULT ''"],
  ['env_tabs', 'space', "TEXT NOT NULL DEFAULT 'person'"],
];

/**
 * 加列迁移：列不在就补一句 ALTER。
 *
 * 只做加列（SQLite 的 `ADD COLUMN` 是纯追加、不动已有行），不做重命名/改类型 ——
 * 那两种要重建表，等真的需要时再单独设计。
 */
function migrate(db: DatabaseSync): void {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

/** 退出时关库（顺带 checkpoint 掉 WAL）。 */
export function closeDatabases(): void {
  for (const [file, db] of connections) {
    try {
      db.close();
    } catch {
      // 已经关了
    }
    connections.delete(file);
  }
}

/**
 * 事务助手：抛错就回滚。
 *
 * SQLite 的 `BEGIN` **不能嵌套**，所以别在 `fn` 里再调一次 `tx`。
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 老 JSON 迁完留档用的后缀（所有模块同一套约定：改名不删，迁错了还能捞回来）。 */
export const MIGRATED_SUFFIX = '.migrated';
