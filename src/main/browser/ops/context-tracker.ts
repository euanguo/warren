/**
 * 会话级上下文追踪器（SessionContextTracker）：
 * - 对标 Ardia & agent-browser 的 per-session-once 主动提示机制；
 * - 首次进入某站点（或该站点的 notes / savedFlows / webmcp 清单发生变更）时完整注入；
 * - 同站点后续连续 snapshot/read 不再重复刷屏浪费几百~上千 Token。
 */
import type { SavedFlowSummary, SiteNote } from '../../../shared/types.ts';

export interface WebMcpToolSummary {
  name: string;
  description?: string;
}

export interface ContextHintsInput {
  siteNotes?: SiteNote[];
  savedFlows?: SavedFlowSummary[];
  webmcpTools?: WebMcpToolSummary[];
}

export interface ConsumedContextHints {
  siteNotes: SiteNote[];
  savedFlows: SavedFlowSummary[];
  webmcpTools: WebMcpToolSummary[];
  /** 同站点笔记此前已注入且未变更时返回已加载笔记行数，供紧凑快照打印单行极简锚点。 */
  notesAlreadyLoadedLines?: number;
  siteChanged: boolean;
}

interface ScopeDeliveryState {
  site: string;
  notesDigest: string;
  flowsDigest: string;
  webmcpDigest: string;
}

function siteKeyOf(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/i.test(u.protocol)) return u.protocol;
    return u.host.toLowerCase();
  } catch {
    return rawUrl || '';
  }
}

function digestNotes(notes: readonly SiteNote[]): string {
  return notes.map((n) => `${n.site}:${n.updatedAt}:${n.content}`).join('\n');
}

function digestFlows(flows: readonly SavedFlowSummary[]): string {
  return flows.map((f) => `${f.site}:${f.name}:${f.params.join(',')}:${f.description ?? ''}`).join('\n');
}

function digestWebMcp(tools: readonly WebMcpToolSummary[]): string {
  return tools.map((t) => `${t.name}:${t.description ?? ''}`).join('\n');
}

export class SessionContextTracker {
  #scopes = new Map<string, ScopeDeliveryState>();

  consumeHints(
    scopeKey: string,
    url: string,
    input: ContextHintsInput,
    options: { force?: boolean } = {},
  ): ConsumedContextHints {
    const site = siteKeyOf(url);
    const notes = input.siteNotes ?? [];
    const flows = input.savedFlows ?? [];
    const webmcp = input.webmcpTools ?? [];

    const notesDigest = digestNotes(notes);
    const flowsDigest = digestFlows(flows);
    const webmcpDigest = digestWebMcp(webmcp);

    const prev = this.#scopes.get(scopeKey);
    const siteChanged = !prev || prev.site !== site;
    const force = Boolean(options.force);

    const deliverNotes = notes.length > 0 && (force || siteChanged || prev.notesDigest !== notesDigest);
    const deliverFlows = flows.length > 0 && (force || siteChanged || prev.flowsDigest !== flowsDigest);
    const deliverWebMcp = webmcp.length > 0 && (force || siteChanged || prev.webmcpDigest !== webmcpDigest);

    this.#scopes.set(scopeKey, {
      site,
      notesDigest: notes.length > 0 ? notesDigest : prev?.site === site ? prev.notesDigest : '',
      flowsDigest: flows.length > 0 ? flowsDigest : prev?.site === site ? prev.flowsDigest : '',
      webmcpDigest: webmcp.length > 0 ? webmcpDigest : prev?.site === site ? prev.webmcpDigest : '',
    });

    // 防止超长运行会话积累过多 scope
    if (this.#scopes.size > 300) {
      const oldest = this.#scopes.keys().next().value;
      if (oldest !== undefined) this.#scopes.delete(oldest);
    }

    const noteLinesCount =
      !deliverNotes && notes.length > 0
        ? notes.reduce((acc, n) => acc + n.content.split(/\r?\n/).filter((l) => l.trim()).length, 0)
        : undefined;

    return {
      siteNotes: deliverNotes ? notes : [],
      savedFlows: deliverFlows ? flows : [],
      webmcpTools: deliverWebMcp ? webmcp : [],
      ...(noteLinesCount ? { notesAlreadyLoadedLines: noteLinesCount } : {}),
      siteChanged,
    };
  }

  reset(scopeKey?: string): void {
    if (scopeKey) this.#scopes.delete(scopeKey);
    else this.#scopes.clear();
  }

  resetByPrefix(prefix: string): void {
    for (const key of [...this.#scopes.keys()]) {
      if (key.startsWith(prefix)) this.#scopes.delete(key);
    }
  }
}

export const sessionContextTracker = new SessionContextTracker();
