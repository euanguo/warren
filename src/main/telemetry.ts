import type { Session, WebContents } from 'electron';
import type { DatabaseSync } from 'node:sqlite';

export interface ConsoleEntry {
  id?: number;
  level: string;
  message: string;
  line: number;
  source: string;
  at: string;
  /** 哪条标签记的（加法，老数据没有）。 */
  tabId?: string;
}

export interface NetworkEntry {
  id?: number;
  method: string;
  url: string;
  status: number;
  resourceType: string;
  at: string;
  /** 哪条标签记的（加法，老数据没有）。 */
  tabId?: string;
  error?: string;
}

export interface NavigationErrorRecord {
  url: string;
  error: string;
  at: string;
}

/** 每条标签保留的摘要条数（读的时候也按这个数取）。 */
const LIMIT = 300;

/** 攒够这么多条才清一次旧数据（每条都 COUNT 太贵）。 */
const PRUNE_EVERY = 50;

/** 超过此毫秒仍未结束的在途请求视为长轮询/流式请求，不再阻塞 networkidle。 */
const STALE_INFLIGHT_MS = 1500;

/** 不计入 networkidle 在途计数的非页面就绪类资源。 */
const IGNORED_INFLIGHT_TYPES = new Set(['webSocket', 'media', 'ping', 'cspReport', 'other']);

/**
 * 每个标签的 console 与 network 摘要，读取时按 Environment 聚合。
 *
 * 用 Electron 原生 `session.webRequest`（`onBeforeRequest` / `onCompleted` / `onErrorOccurred`）
 * 与 `webContents` 事件，**绝不开启 CDP `Runtime.enable` / `Network.enable`**，保持零检测面。
 */
export class Telemetry {
  #db: DatabaseSync;
  #counts = new Map<string, number>();
  #envTabs = new Map<string, Set<string>>();
  #tabToEnv = new Map<string, string>();
  #webContentsToTab = new Map<number, string>();
  #sessions = new Set<Session>();
  #lastActivity = new Map<string, number>();
  /** per-tab 在途请求表：`tabId -> Map<requestId, startedAt>`。 */
  #inFlight = new Map<string, Map<number, number>>();
  /** per-tab 最近一次主文档导航失败记录（用于诊断 `chrome-error://` 页）。 */
  #lastNavError = new Map<string, NavigationErrorRecord>();
  #writes = 0;
  #writeMs = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get writeStats(): { writes: number; ms: number } {
    return { writes: this.#writes, ms: Math.round(this.#writeMs * 100) / 100 };
  }

  #timed(write: () => void): void {
    const started = performance.now();
    try {
      write();
    } finally {
      this.#writes += 1;
      this.#writeMs += performance.now() - started;
    }
  }

  consoleEntries(envId: string): ConsoleEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT id, at, level, message, line, source, tab_id FROM console_entries
         WHERE env_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(envId, LIMIT) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
        id: Number(row.id),
        level: String(row.level),
        message: String(row.message),
        line: Number(row.line ?? 0),
        source: String(row.source ?? ''),
        at: String(row.at),
        tabId: String(row.tab_id),
      }))
      .reverse();
  }

  networkEntries(envId: string): NetworkEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT id, at, method, url, status, resource_type, tab_id FROM network_entries
         WHERE env_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(envId, LIMIT) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
        id: Number(row.id),
        method: String(row.method),
        url: String(row.url),
        status: Number(row.status ?? 0),
        resourceType: String(row.resource_type ?? ''),
        at: String(row.at),
        tabId: String(row.tab_id),
      }))
      .reverse();
  }

  /** 按自增游标增量读取某环境在 `afterId` 之后的网络请求（彻底规避 300 条上限 slice 错位）。 */
  networkEntriesSince(envId: string, afterId: number, limit = LIMIT): NetworkEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT id, at, method, url, status, resource_type, tab_id FROM network_entries
         WHERE env_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(envId, afterId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      method: String(row.method),
      url: String(row.url),
      status: Number(row.status ?? 0),
      resourceType: String(row.resource_type ?? ''),
      at: String(row.at),
      tabId: String(row.tab_id),
    }));
  }

  /** 该 tab 最后一次网络活动；从未活动返回 0（调用方按 idle 处理）。 */
  lastActivityAt(tabId: string): number {
    return this.#lastActivity.get(tabId) ?? 0;
  }

  /** 该 tab 当前活跃的非长轮询在途请求数（超过 1.5s 的挂起流自动忽略）。 */
  inFlightCount(tabId: string): number {
    const map = this.#inFlight.get(tabId);
    if (!map || map.size === 0) return 0;
    const now = Date.now();
    for (const [reqId, startedAt] of [...map.entries()]) {
      if (now - startedAt > STALE_INFLIGHT_MS) map.delete(reqId);
    }
    return map.size;
  }

  /** 该 tab 最近一次主文档导航失败原因（`chrome-error://` 诊断）。 */
  lastNavigationError(tabId: string): NavigationErrorRecord | null {
    return this.#lastNavError.get(tabId) ?? null;
  }

  /** 仅清理内存中的在途/tab 临时映射，保留数据库里的遥测历史供停机/休眠后排查。 */
  forgetEnv(envId: string): void {
    for (const tabId of this.#envTabs.get(envId) ?? []) {
      this.#lastActivity.delete(tabId);
      this.#inFlight.delete(tabId);
      this.#lastNavError.delete(tabId);
      this.#counts.delete(tabId);
      this.#tabToEnv.delete(tabId);
    }
    this.#envTabs.delete(envId);
  }

  /** 删除环境时彻底清空内存与 SQLite 遥测历史。 */
  clear(envId: string): void {
    this.forgetEnv(envId);
    try {
      this.#db.prepare('DELETE FROM console_entries WHERE env_id = ?').run(envId);
      this.#db.prepare('DELETE FROM network_entries WHERE env_id = ?').run(envId);
    } catch {
      // 遥测永远不能影响页面本身
    }
  }

  attachSession(session: Session): void {
    if (this.#sessions.has(session)) return;
    this.#sessions.add(session);
    try {
      session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        try {
          const tabId =
            details.webContentsId === undefined ? undefined : this.#webContentsToTab.get(details.webContentsId);
          if (tabId) {
            const type = String(details.resourceType ?? '');
            const isFavicon = /\/favicon\.ico(\?|$)/i.test(details.url);
            if (!IGNORED_INFLIGHT_TYPES.has(type) && !isFavicon) {
              let map = this.#inFlight.get(tabId);
              if (!map) {
                map = new Map<number, number>();
                this.#inFlight.set(tabId, map);
              }
              map.set(details.id, Date.now());
              this.#lastActivity.set(tabId, Date.now());
            }
            if (type === 'mainFrame') {
              this.#lastNavError.delete(tabId);
            }
          }
        } catch {
          // 遥测永远不能阻断请求
        }
        callback({});
      });

      session.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
        try {
          const tabId =
            details.webContentsId === undefined ? undefined : this.#webContentsToTab.get(details.webContentsId);
          if (!tabId) return;
          this.#inFlight.get(tabId)?.delete(details.id);
          const entry: NetworkEntry = {
            method: details.method,
            url: details.url,
            status: details.statusCode,
            resourceType: String(details.resourceType ?? ''),
            at: new Date().toISOString(),
            tabId,
          };
          this.#writeNetwork(this.#tabToEnv.get(tabId) ?? '', entry);
          this.#lastActivity.set(tabId, Date.now());
        } catch {
          // 遥测永远不能影响页面本身
        }
      });

      session.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (details) => {
        try {
          const tabId =
            details.webContentsId === undefined ? undefined : this.#webContentsToTab.get(details.webContentsId);
          if (!tabId) return;
          this.#inFlight.get(tabId)?.delete(details.id);
          const nowIso = new Date().toISOString();
          if (String(details.resourceType ?? '') === 'mainFrame' && details.error !== 'net::ERR_ABORTED') {
            this.#lastNavError.set(tabId, { url: details.url, error: details.error, at: nowIso });
          }
          const entry: NetworkEntry = {
            method: details.method,
            url: details.url,
            status: 0,
            resourceType: String(details.resourceType ?? ''),
            at: nowIso,
            tabId,
            error: details.error,
          };
          this.#writeNetwork(this.#tabToEnv.get(tabId) ?? '', entry);
          this.#lastActivity.set(tabId, Date.now());
        } catch {
          // 遥测永远不能影响页面本身
        }
      });
    } catch {
      // 网络摘要挂不上不影响环境可用
    }
  }

  attachTab(envId: string, tabId: string, webContents: WebContents): void {
    const tabs = this.#envTabs.get(envId) ?? new Set<string>();
    tabs.add(tabId);
    this.#envTabs.set(envId, tabs);
    this.#tabToEnv.set(tabId, envId);
    this.#webContentsToTab.set(webContents.id, tabId);

    webContents.on('console-message', ((...args: unknown[]) => {
      try {
        const first = args[0] as Record<string, unknown> | undefined;
        const event = first && typeof first === 'object' && 'message' in first ? first : undefined;
        const level = event ? String(event.level ?? '') : String(args[1] ?? '');
        const message = event ? String(event.message ?? '') : String(args[2] ?? '');
        const line = event ? Number(event.lineNumber ?? 0) : Number(args[3] ?? 0);
        const source = event ? String(event.sourceId ?? '') : String(args[4] ?? '');
        this.#writeConsole(envId, {
          level: normalizeLevel(level),
          message,
          line,
          source: shortSource(source),
          at: new Date().toISOString(),
          tabId,
        });
      } catch {
        // 遥测永远不能影响页面本身
      }
    }) as never);
  }

  detachTab(tabId: string): void {
    this.#lastActivity.delete(tabId);
    this.#inFlight.delete(tabId);
    this.#lastNavError.delete(tabId);
    this.#counts.delete(tabId);
    this.#tabToEnv.delete(tabId);
    for (const tabs of this.#envTabs.values()) tabs.delete(tabId);
    for (const [id, mapped] of this.#webContentsToTab) {
      if (mapped === tabId) this.#webContentsToTab.delete(id);
    }
  }

  detachSession(session: Session): void {
    if (!this.#sessions.delete(session)) return;
    try {
      session.webRequest.onBeforeRequest(null);
      session.webRequest.onCompleted(null);
      session.webRequest.onErrorOccurred(null);
    } catch {
      // session 可能已经销毁
    }
  }

  #writeConsole(envId: string, entry: ConsoleEntry): void {
    this.#timed(() =>
      this.#db
        .prepare(
          'INSERT INTO console_entries (env_id, tab_id, at, level, message, line, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(envId, entry.tabId ?? '', entry.at, entry.level, entry.message, entry.line, entry.source),
    );
    this.#prune(entry.tabId ?? '', 'console_entries');
  }

  #writeNetwork(envId: string, entry: NetworkEntry): void {
    this.#timed(() =>
      this.#db
        .prepare(
          'INSERT INTO network_entries (env_id, tab_id, at, method, url, status, resource_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(envId, entry.tabId ?? '', entry.at, entry.method, entry.url, entry.status, entry.resourceType),
    );
    this.#prune(entry.tabId ?? '', 'network_entries');
  }

  #prune(tabId: string, table: 'console_entries' | 'network_entries'): void {
    const next = (this.#counts.get(tabId) ?? 0) + 1;
    this.#counts.set(tabId, next);
    if (next % PRUNE_EVERY !== 0) return;
    this.#db
      .prepare(
        `DELETE FROM ${table} WHERE tab_id = ? AND id NOT IN (
           SELECT id FROM ${table} WHERE tab_id = ? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(tabId, tabId, LIMIT);
  }
}

function normalizeLevel(level: string): string {
  if (level === '0' || /verbose|debug/i.test(level)) return 'debug';
  if (level === '1' || /info|log/i.test(level)) return 'info';
  if (level === '2' || /warn/i.test(level)) return 'warn';
  if (level === '3' || /error/i.test(level)) return 'error';
  return level || 'info';
}

function shortSource(source: string): string {
  if (!source) return '';
  try {
    const url = new URL(source);
    return url.pathname.split('/').pop() || url.hostname;
  } catch {
    return source.split('/').pop() ?? source;
  }
}
