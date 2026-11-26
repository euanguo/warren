/**
 * 插件注册表与插件日志：`warren.db` 的 `plugins` / `plugin_logs` 两张表。
 */
import type { DatabaseSync } from 'node:sqlite';
import { tx } from '../db.ts';
import type { Permission } from './package.ts';
import type { LogLevel } from './runtime.ts';

export interface PluginInstallRecord {
  installedAt: string;
  digest: string;
  version: string;
  packageName: string;
  source: string;
  resolved: string;
}

export interface PluginState {
  enabled: string[];
  granted: Record<string, Permission[]>;
  installs: Record<string, PluginInstallRecord>;
  /** 按插件控制是否自动注入 Skill（默认 true，显式 false 时不向 Agent 暴露）。 */
  skillExposed?: Record<string, boolean>;
}

/** 每个插件保留的日志条数（以前是「文件超过 512KB 截到 200 行」，现在是条数水位）。 */
const LOG_LIMIT_PER_PLUGIN = 500;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[];

function normalizeLogLevel(value: unknown): LogLevel {
  const level = String(value);
  return (LOG_LEVELS as readonly string[]).includes(level) ? (level as LogLevel) : 'info';
}

type Row = Record<string, unknown>;

function emptyState(): PluginState {
  return { enabled: [], granted: {}, installs: {} };
}

function parseList(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 读注册表。插件状态只有一个来源：`warren.db`。 */
export async function loadPluginState(db: DatabaseSync): Promise<PluginState> {
  const rows = db.prepare('SELECT * FROM plugins').all() as Row[];
  const state = emptyState();
  for (const row of rows) {
    const id = String(row.id);
    if (row.enabled === 1 || row.enabled === true) state.enabled.push(id);
    const granted = parseList(row.granted) as Permission[];
    if (granted.length) state.granted[id] = granted;
    state.installs[id] = {
      installedAt: String(row.installed_at ?? ''),
      digest: String(row.digest ?? ''),
      version: String(row.version ?? ''),
      packageName: String(row.package_name ?? ''),
      source: String(row.source ?? ''),
      resolved: String(row.resolved ?? ''),
    };
    const exposed = row.skill_exposed === undefined || row.skill_exposed === null ? true : Boolean(row.skill_exposed);
    if (!exposed) {
      state.skillExposed ??= {};
      state.skillExposed[id] = false;
    }
  }
  return state;
}

/** 整表重写（注册表是个位数量级的插件，不值得做增量）。 */
export function savePluginState(db: DatabaseSync, state: PluginState): void {
  const now = new Date().toISOString();
  tx(db, () => {
    db.exec('DELETE FROM plugins');
    const insert = db.prepare(
      `INSERT OR REPLACE INTO plugins
         (id, enabled, granted, digest, version, package_name, source, resolved, skill_exposed, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [id, install] of Object.entries(state.installs)) {
      const exposed = state.skillExposed?.[id] === false ? 0 : 1;
      insert.run(
        id,
        state.enabled.includes(id) ? 1 : 0,
        JSON.stringify(state.granted[id] ?? []),
        install.digest ?? '',
        install.version ?? '',
        install.packageName ?? '',
        install.source ?? '',
        install.resolved ?? '',
        exposed,
        install.installedAt ?? now,
        now,
      );
    }
  });
}

export function appendPluginLog(db: DatabaseSync, pluginId: string, level: LogLevel, message: string): void {
  try {
    db.prepare('INSERT INTO plugin_logs (plugin_id, at, level, message) VALUES (?, ?, ?, ?)').run(
      pluginId,
      new Date().toISOString(),
      level,
      message,
    );
    // 按插件留最近 N 条。攒着按批清理没有意义——插件日志本身就不频繁。
    db.prepare(
      `DELETE FROM plugin_logs WHERE plugin_id = ? AND rowid NOT IN (
         SELECT rowid FROM plugin_logs WHERE plugin_id = ? ORDER BY rowid DESC LIMIT ?
       )`,
    ).run(pluginId, pluginId, LOG_LIMIT_PER_PLUGIN);
  } catch {
    // 日志写不进去不能影响插件本身
  }
}

export function readPluginLogs(
  db: DatabaseSync,
  pluginId: string,
  limit = 200,
): Array<{ at: string; level: LogLevel; message: string }> {
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  const rows = db
    .prepare('SELECT at, level, message FROM plugin_logs WHERE plugin_id = ? ORDER BY rowid DESC LIMIT ?')
    .all(pluginId, size) as Row[];
  return rows
    .map((row) => ({
      at: String(row.at),
      level: normalizeLogLevel(row.level),
      message: String(row.message),
    }))
    .reverse();
}
