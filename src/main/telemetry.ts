import type { Session, WebContents } from 'electron';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { redactUrl } from './browser/redact.ts';
import { tx } from './db.ts';

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

/** 批量落盘阈值：单页并发加载 50-150 个资源时合并进同一事务，避免主线程 I/O 抖动。 */
const FLUSH_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 250;
const MAX_CONSOLE_MESSAGE_LEN = 4096;
const MAX_NETWORK_URL_LEN = 2048;

/** 超过此毫秒仍未结束的在途请求视为长轮询/流式请求，不再阻塞 networkidle。 */
const STALE_INFLIGHT_MS = 1500;

/** 不计入 networkidle 在途计数的非页面就绪类资源。 */
const IGNORED_INFLIGHT_TYPES = new Set(['webSocket', 'media', 'ping', 'cspReport', 'other']);

interface PendingConsoleRow {
  envId: string;
  tabId: string;
  at: string;
  level: string;
  message: string;
  line: number;
  source: string;
}

interface PendingNetworkRow {
  envId: string;
  tabId: string;
  at: string;
  method: string;
  url: string;
  status: number;
  resourceType: string;
  error: string;
}

/**
 * 每个标签的 console 与 network 摘要，读取时按 Environment 聚合。
 *
 * 用 Electron 原生 `session.webRequest`（`onBeforeRequest` / `onCompleted` / `onErrorOccurred`）
 * 与 `webContents` 事件，**绝不开启 CDP `Runtime.enable` / `Network.enable`**，保持零检测面。
 */
export class Telemetry {
  #db: DatabaseSync;
  #consoleCounts = new Map<string, number>();
  #networkCounts = new Map<string, number>();
  #envTabs = new Map<string, Set<string>>();
  #tabToEnv = new Map<string, string>();
  #webContentsToTab = new Map<number, string>();
  #tabConsoleListeners = new Map<string, { wc: WebContents; listener: (...args: unknown[]) => void }>();
  #sessions = new Set<Session>();
  #lastActivity = new Map<string, number>();
  /** per-tab 在途请求表：`tabId -> Map<requestId, startedAt>`。 */
  #inFlight = new Map<string, Map<number, number>>();
  /** per-tab 最近一次主文档导航失败记录（用于诊断 `chrome-error://` 页）。 */
  #lastNavError = new Map<string, NavigationErrorRecord>();
  #pendingConsole: PendingConsoleRow[] = [];
  #pendingNetwork: PendingNetworkRow[] = [];
  #flushTimer?: ReturnType<typeof setTimeout>;
  #stmts?: {
    insertConsole: StatementSync;
    insertNetwork: StatementSync;
    pruneConsole: StatementSync;
    pruneNetwork: StatementSync;
    selectConsole: StatementSync;
    selectNetwork: StatementSync;
    selectNetworkSince: StatementSync;
  };
  #writes = 0;
  #writeMs = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #prepared() {
    if (!this.#stmts) {
      this.#stmts = {
        insertConsole: this.#db.prepare(
          'INSERT INTO console_entries (env_id, tab_id, at, level, message, line, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ),
        insertNetwork: this.#db.prepare(
          'INSERT INTO network_entries (env_id, tab_id, at, method, url, status, resource_type, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ),
        pruneConsole: this.#db.prepare(
          `DELETE FROM console_entries WHERE tab_id = ? AND id NOT IN (
             SELECT id FROM console_entries WHERE tab_id = ? ORDER BY id DESC LIMIT ?
           )`,
        ),
        pruneNetwork: this.#db.prepare(
          `DELETE FROM network_entries WHERE tab_id = ? AND id NOT IN (
             SELECT id FROM network_entries WHERE tab_id = ? ORDER BY id DESC LIMIT ?
           )`,
        ),
        selectConsole: this.#db.prepare(
          `SELECT id, at, level, message, line, source, tab_id FROM console_entries
           WHERE env_id = ? ORDER BY id DESC LIMIT ?`,
        ),
        selectNetwork: this.#db.prepare(
          `SELECT id, at, method, url, status, resource_type, error, tab_id FROM network_entries
           WHERE env_id = ? ORDER BY id DESC LIMIT ?`,
        ),
        selectNetworkSince: this.#db.prepare(
          `SELECT id, at, method, url, status, resource_type, error, tab_id FROM network_entries
           WHERE env_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
        ),
      };
    }
    return this.#stmts;
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

  /** 将缓冲队列中的遥测记录批量刷入同一 SQLite 事务。读/清理/退出前自动调用，确保读写一致性。 */
  flush(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    if (this.#pendingConsole.length === 0 && this.#pendingNetwork.length === 0) return;
    const consoleBatch = this.#pendingConsole;
    const networkBatch = this.#pendingNetwork;
    this.#pendingConsole = [];
    this.#pendingNetwork = [];
    const stmts = this.#prepared();
    const consolePruneTabs = new Set<string>();
    const networkPruneTabs = new Set<string>();

    try {
      this.#timed(() => {
        tx(this.#db, () => {
          for (const row of consoleBatch) {
            stmts.insertConsole.run(row.envId, row.tabId, row.at, row.level, row.message, row.line, row.source);
            const next = (this.#consoleCounts.get(row.tabId) ?? 0) + 1;
            this.#consoleCounts.set(row.tabId, next);
            if (next % PRUNE_EVERY === 0) consolePruneTabs.add(row.tabId);
          }
          for (const row of networkBatch) {
            stmts.insertNetwork.run(
              row.envId,
              row.tabId,
              row.at,
              row.method,
              row.url,
              row.status,
              row.resourceType,
              row.error,
            );
            const next = (this.#networkCounts.get(row.tabId) ?? 0) + 1;
            this.#networkCounts.set(row.tabId, next);
            if (next % PRUNE_EVERY === 0) networkPruneTabs.add(row.tabId);
          }
          for (const tabId of consolePruneTabs) stmts.pruneConsole.run(tabId, tabId, LIMIT);
          for (const tabId of networkPruneTabs) stmts.pruneNetwork.run(tabId, tabId, LIMIT);
        });
      });
    } catch {
      // 遥测永远不能影响页面本身
    }
  }

  #scheduleFlush(): void {
    if (this.#pendingConsole.length + this.#pendingNetwork.length >= FLUSH_BATCH_SIZE) {
      this.flush();
      return;
    }
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    this.#flushTimer.unref?.();
  }

  consoleEntries(envId: string): ConsoleEntry[] {
    this.flush();
    const rows = this.#prepared().selectConsole.all(envId, LIMIT) as Array<Record<string, unknown>>;
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
    this.flush();
    const rows = this.#prepared().selectNetwork.all(envId, LIMIT) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
        id: Number(row.id),
        method: String(row.method),
        url: String(row.url),
        status: Number(row.status ?? 0),
        resourceType: String(row.resource_type ?? ''),
        at: String(row.at),
        tabId: String(row.tab_id),
        ...(row.error ? { error: String(row.error) } : {}),
      }))
      .reverse();
  }

  /** 按自增游标增量读取某环境在 `afterId` 之后的网络请求（彻底规避 300 条上限 slice 错位）。 */
  networkEntriesSince(envId: string, afterId: number, limit = LIMIT): NetworkEntry[] {
    this.flush();
    const rows = this.#prepared().selectNetworkSince.all(envId, afterId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      method: String(row.method),
      url: String(row.url),
      status: Number(row.status ?? 0),
      resourceType: String(row.resource_type ?? ''),
      at: String(row.at),
      tabId: String(row.tab_id),
      ...(row.error ? { error: String(row.error) } : {}),
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
    this.flush();
    for (const tabId of this.#envTabs.get(envId) ?? []) {
      this.detachTab(tabId);
    }
    this.#envTabs.delete(envId);
  }

  /** 删除环境时彻底清空内存与 SQLite 遥测历史。 */
  clear(envId: string): void {
    this.forgetEnv(envId);
    this.#pendingConsole = this.#pendingConsole.filter((row) => row.envId !== envId);
    this.#pendingNetwork = this.#pendingNetwork.filter((row) => row.envId !== envId);
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
    const existing = this.#tabConsoleListeners.get(tabId);
    if (existing) {
      try {
        existing.wc.off('console-message', existing.listener as never);
      } catch {
        // 已销毁
      }
      this.#tabConsoleListeners.delete(tabId);
    }
    const tabs = this.#envTabs.get(envId) ?? new Set<string>();
    tabs.add(tabId);
    this.#envTabs.set(envId, tabs);
    this.#tabToEnv.set(tabId, envId);
    this.#webContentsToTab.set(webContents.id, tabId);

    const onConsole = (...args: unknown[]) => {
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
    };
    this.#tabConsoleListeners.set(tabId, { wc: webContents, listener: onConsole });
    webContents.on('console-message', onConsole as never);
  }

  detachTab(tabId: string): void {
    const bound = this.#tabConsoleListeners.get(tabId);
    if (bound) {
      try {
        bound.wc.off('console-message', bound.listener as never);
      } catch {
        // webContents 可能已销毁
      }
      this.#tabConsoleListeners.delete(tabId);
    }
    this.#lastActivity.delete(tabId);
    this.#inFlight.delete(tabId);
    this.#lastNavError.delete(tabId);
    this.#consoleCounts.delete(tabId);
    this.#networkCounts.delete(tabId);
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
    this.#pendingConsole.push({
      envId,
      tabId: entry.tabId ?? '',
      at: entry.at,
      level: entry.level,
      message: entry.message.slice(0, MAX_CONSOLE_MESSAGE_LEN),
      line: entry.line,
      source: entry.source.slice(0, 256),
    });
    this.#scheduleFlush();
  }

  #writeNetwork(envId: string, entry: NetworkEntry): void {
    const sanitizedUrl = redactUrl(entry.url).slice(0, MAX_NETWORK_URL_LEN);
    this.#pendingNetwork.push({
      envId,
      tabId: entry.tabId ?? '',
      at: entry.at,
      method: entry.method,
      url: sanitizedUrl,
      status: entry.status,
      resourceType: entry.resourceType,
      error: (entry.error ?? '').slice(0, 256),
    });
    this.#scheduleFlush();
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
