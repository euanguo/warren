import type { Session, WebContents } from 'electron';
import type { DatabaseSync } from 'node:sqlite';

export interface ConsoleEntry {
  level: string;
  message: string;
  line: number;
  source: string;
  at: string;
  /** 哪条标签记的（加法，老数据没有）。 */
  tabId?: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  resourceType: string;
  at: string;
  /** 哪条标签记的（加法，老数据没有）。 */
  tabId?: string;
}

/** 每条标签保留的摘要条数（读的时候也按这个数取）。 */
const LIMIT = 300;

/** 攒够这么多条才清一次旧数据（每条都 COUNT 太贵）。 */
const PRUNE_EVERY = 50;

/**
 * 每个标签的 console 与 network 摘要，读取时按 Environment 聚合。
 *
 * 落在 `warren.db` 的 `console_entries` / `network_entries`（以前是主进程内存里的环形缓冲，
 * 重启即清空——**崩掉的那一次恰恰是最想看它的时候**）。每条标签留最近 300 条，按批清理。
 * 环境停止时照旧整个清掉（`clear()`）：面板是「这一轮页面干了什么」，不是永久档案。
 *
 * 用 Electron 原生事件，不碰 CDP 的 Runtime.enable / Network.enable ——
 * 既省掉检测面，也不需要为了看日志把页面置于调试状态。
 *
 * 为什么按标签而不是按环境记：
 * - 一个环境有多个标签，按环境记分不清哪条日志来自哪个页面
 * - `session.webRequest` 每个 session **只能有一个监听器**（后注册的覆盖先注册的，
 *   传 null 会整体解绑）。多标签共用一个 session，按标签注册会把彼此冲掉，
 *   所以改成「每个 session 只注册一次，回调里按 webContentsId 反查标签」。
 */
export class Telemetry {
  #db: DatabaseSync;
  /** 每标签的写入计数，用来决定什么时候清旧数据。 */
  #counts = new Map<string, number>();
  #envTabs = new Map<string, Set<string>>();
  /** tabId → envId。网络事件回调里只有 webContentsId，靠这张表一步反查到环境。 */
  #tabToEnv = new Map<string, string>();
  #webContentsToTab = new Map<number, string>();
  /** 已经挂上 webRequest 监听的 session。Session 对象在 `session.fromPath` 之间复用。 */
  #sessions = new Set<Session>();
  /** 每标签最后一次网络活动（Date.now()），给 networkidle 空闲窗口用。 */
  #lastActivity = new Map<string, number>();
  /**
   * 写库到底花了多少：条数 + 累计毫秒。
   *
   * 存在的理由：遥测是**每条请求一把同步 INSERT**（WAL），这是主进程里的真实开销，
   * 而「日志把页面拖慢了」这种问题不量就看不出来。`debug.layout` 里能读到。
   */
  #writes = 0;
  #writeMs = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** 写库统计（诊断用）。 */
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
        `SELECT at, level, message, line, source, tab_id FROM console_entries
         WHERE env_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(envId, LIMIT) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
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
        `SELECT at, method, url, status, resource_type, tab_id FROM network_entries
         WHERE env_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(envId, LIMIT) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
        method: String(row.method),
        url: String(row.url),
        status: Number(row.status ?? 0),
        resourceType: String(row.resource_type ?? ''),
        at: String(row.at),
        tabId: String(row.tab_id),
      }))
      .reverse();
  }

  /** 该 tab 最后一次网络活动；从未活动返回 0（调用方按 idle 处理）。 */
  lastActivityAt(tabId: string): number {
    return this.#lastActivity.get(tabId) ?? 0;
  }

  clear(envId: string): void {
    for (const tabId of this.#envTabs.get(envId) ?? []) {
      this.#lastActivity.delete(tabId);
      this.#counts.delete(tabId);
      this.#tabToEnv.delete(tabId);
    }
    try {
      this.#db.prepare('DELETE FROM console_entries WHERE env_id = ?').run(envId);
      this.#db.prepare('DELETE FROM network_entries WHERE env_id = ?').run(envId);
    } catch {
      // 遥测永远不能影响页面本身
    }
    this.#envTabs.delete(envId);
  }

  attachSession(session: Session): void {
    if (this.#sessions.has(session)) return;
    this.#sessions.add(session);
    try {
      // 过滤串必须是合法 pattern；'*' 会抛 "Missing scheme separator"
      session.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
        try {
          const tabId =
            details.webContentsId === undefined ? undefined : this.#webContentsToTab.get(details.webContentsId);
          if (!tabId) return;
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

    // Electron 36+ 传单个 event 对象，更早的版本是 (event, level, message, line, sourceId)
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
    this.#counts.delete(tabId);
    this.#tabToEnv.delete(tabId);
    for (const tabs of this.#envTabs.values()) tabs.delete(tabId);
    for (const [id, mapped] of this.#webContentsToTab) {
      if (mapped === tabId) this.#webContentsToTab.delete(id);
    }
    // 表里的行**不删**：标签关掉了，但它这一轮的 console / 请求还是有用
    // （要清是环境停止时的 `clear()`）。
  }

  detachSession(session: Session): void {
    if (!this.#sessions.delete(session)) return;
    try {
      session.webRequest.onCompleted(null);
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

  /** 按标签留最近 LIMIT 条。攒 PRUNE_EVERY 条才清一次，别每条都数。 */
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
