/**
 * 统一动作变化回执引擎（Action Delta Engine）：
 * - 供单步写动作（click/fill/select/press/check/open 等）与 `browser.batch` 共享；
 * - 零 Electron 运行时依赖，全部依赖通过轻量接口注入，支持 `node --test` 高速无头单测；
 * - 在极低延迟开销下输出：URL/Title 变化、交互节点增删改（自带立即可用的稳定 `@N`）、
 *   同类长列表折叠、非静态 API 请求摘要、新打开弹窗/区域可读 `text:`、自愈播报与未处理副作用冒泡。
 */
import type {
  ActionDelta,
  ActionSideEffects,
  AxNode,
  CompactDeltaItem,
  NetworkEntry,
  RefHealNotice,
  SavedFlowSummary,
  SiteNote,
  SnapshotResult,
} from '../../../shared/types.ts';
import { diffSnapshots, getLastSnapshot, rememberSnapshot } from './diff.ts';

const STATIC_EXT_RE = /\.(?:js|mjs|cjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map|mp4|webm|mp3)(?:\?|$)/i;
const STATIC_RESOURCE_RE = /^(?:image|font|stylesheet|media|manifest|other_static)$/i;
const OPENED_TEXT_ROLE_RE = /^(?:dialog|alertdialog|alert|status|heading|region|article|banner|main)$/i;
const FOLDABLE_DELTA_ROLE_RE = /^(?:option|menuitem|listitem|treeitem|row|link|tab|gridcell|radio|checkbox|button)$/i;

const OPENED_TEXT_EXTRACTOR_JS = `(hintRoles) => {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
      }
    } catch {}
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const pickContainer = () => {
    const modals = [...document.querySelectorAll('dialog[open], [role="alertdialog"], [role="dialog"], [aria-modal="true"]')].filter(isVisible);
    if (modals.length > 0) return modals[modals.length - 1];
    const alerts = [...document.querySelectorAll('[role="alert"], [role="status"]')].filter(isVisible);
    if (alerts.length > 0 && hintRoles.includes('alert')) return alerts[alerts.length - 1];
    return document.querySelector('main, article, [role="main"]') || document.body;
  };
  const root = pickContainer();
  if (!root) return '';
  const parts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/i.test(parent.tagName)) continue;
    if (parent.closest('input[type="password"], [autocomplete*="password"]')) continue;
    if (!isVisible(parent)) continue;
    const txt = clean(node.nodeValue);
    if (!txt) continue;
    parts.push(txt);
    total += txt.length + 1;
    if (total >= 820) break;
  }
  const joined = parts.join(' ').replace(/\\s+/g, ' ').trim();
  return joined.length > 780 ? joined.slice(0, 777) + '...' : joined;
}`;

export interface ActionDeltaClient {
  currentUrl(): string;
  title(): Promise<string>;
  snapshot(opts?: { interactiveOnly?: boolean }): Promise<AxNode[]>;
  snapshotWithRefs(opts?: { interactiveOnly?: boolean }): Promise<AxNode[]>;
  smartSettle?(opts?: { maxWaitMs?: number; quietMs?: number }): Promise<unknown>;
  evaluate?(fn: string, arg?: unknown): Promise<unknown>;
  peekUnhandledSideEffects?(): ActionSideEffects;
  consumeHealedRefs?(): RefHealNotice[];
  lastNavigationError?(): { url: string; error: string; at: string } | null;
}

export interface ActionDeltaContext {
  client: ActionDeltaClient;
  scopeKey: string;
  networkEntries?: () => NetworkEntry[];
  networkEntriesSince?: (afterId: number) => NetworkEntry[];
  /** 可选：读取站点上下文提示（Wave 2 ContextTracker 接入）。 */
  resolveContextHints?: (url: string) => { siteNotes?: SiteNote[]; savedFlows?: SavedFlowSummary[] } | undefined;
  /** 可选：记录本步结果用于死循环检测（Wave 2 LoopDetector 接入）。 */
  recordLoopProbe?: (probe: { urlBefore: string; urlAfter: string; changed: boolean }) => string | undefined;
  includeText?: boolean;
  settleMs?: number;
  /** 复用缓存快照的最大新鲜窗口（ms），默认 3000ms，避免每次单步动作拍两次快照。 */
  reuseSnapshotWindowMs?: number;
}

const snapshotTimestamps = new Map<string, number>();

export function markSnapshotFresh(scopeKey: string, now = Date.now()): void {
  snapshotTimestamps.set(scopeKey, now);
}

export function clearSnapshotFreshness(scopeKey?: string): void {
  if (scopeKey) snapshotTimestamps.delete(scopeKey);
  else snapshotTimestamps.clear();
}

export function isStaticAssetRequest(entry: Pick<NetworkEntry, 'url' | 'method' | 'status' | 'resourceType'>): boolean {
  const method = entry.method.toUpperCase();
  // 非 GET 请求或 4xx/5xx 失败请求始终对 AI 有高诊断价值，绝不过滤
  if (method !== 'GET') return false;
  if (entry.status >= 400 || entry.status === 0) return false;
  if (STATIC_RESOURCE_RE.test(entry.resourceType || '')) return true;
  return STATIC_EXT_RE.test(entry.url);
}

/** 按 SQLite 自增 id 游标切片并过滤静态资源，仅保留有业务意义的 API 摘要。 */
export function summarizeApiNetworkDelta(
  before: readonly NetworkEntry[],
  after: readonly NetworkEntry[],
  options: { includeStatic?: boolean; limit?: number } = {},
): string[] {
  let added: NetworkEntry[];
  const lastBeforeId = before.length > 0 ? before[before.length - 1]!.id : undefined;
  const hasIds = after.some((e) => typeof e.id === 'number');
  if (hasIds) {
    const cursor = typeof lastBeforeId === 'number' ? lastBeforeId : 0;
    added = after.filter((e) => typeof e.id === 'number' && e.id > cursor);
  } else {
    const start = Math.min(before.length, after.length);
    added = after.slice(start);
  }
  const filtered = options.includeStatic ? added : added.filter((e) => !isStaticAssetRequest(e));
  const limit = options.limit ?? 15;
  return filtered.slice(-limit).map((entry) => {
    let shortUrl = entry.url;
    try {
      const u = new URL(entry.url);
      shortUrl = `${u.pathname}${u.search}`;
    } catch {
      // 保留原 URL
    }
    const statusText = entry.status || (entry.error ?? 'ERR');
    return `${entry.method.toUpperCase()} ${shortUrl} -> ${statusText}`;
  });
}

/** 折叠同一 role 连续 ≥ threshold 条的新增/移除节点，防止长列表/下拉撑爆 Delta。 */
export function foldDeltaItems(
  items: readonly CompactDeltaItem[],
  threshold = 6,
): { items: CompactDeltaItem[]; foldedGroups: string[] } {
  if (items.length < threshold) return { items: [...items], foldedGroups: [] };
  const kept: CompactDeltaItem[] = [];
  const foldedGroups: string[] = [];

  let i = 0;
  while (i < items.length) {
    const role = items[i]!.role;
    let j = i + 1;
    while (j < items.length && items[j]!.role.toLowerCase() === role.toLowerCase()) j += 1;
    const runLen = j - i;

    if (runLen >= threshold && FOLDABLE_DELTA_ROLE_RE.test(role)) {
      const run = items.slice(i, j);
      const head = run.slice(0, 3);
      const tail = run[run.length - 1]!;
      const special = run
        .slice(3, -1)
        .filter((it) => it.selected || it.checked === true || it.checked === 'mixed')
        .slice(0, 3);
      kept.push(...head, ...special, tail);

      const firstRef = run.find((it) => it.ref)?.ref;
      const lastRef = [...run].reverse().find((it) => it.ref)?.ref;
      const refRange = firstRef && lastRef && firstRef !== lastRef ? ` (${firstRef}..${lastRef})` : '';
      const disabledCount = run.filter((it) => it.disabled).length;
      const disabledNote = disabledCount > 0 ? `, ${disabledCount} disabled` : '';
      const omittedCount = runLen - head.length - special.length - 1;
      foldedGroups.push(
        `+ ${runLen} ${role} (${omittedCount} folded${disabledNote})${refRange}: "${run[0]!.name.slice(0, 36)}" … "${tail.name.slice(0, 36)}"`,
      );
    } else {
      for (let k = i; k < j; k += 1) kept.push(items[k]!);
    }
    i = j;
  }

  return { items: kept, foldedGroups };
}

function toCompactAdded(nodes: ReturnType<typeof diffSnapshots>['added']): CompactDeltaItem[] {
  return nodes.map((n) => ({
    role: n.role,
    name: n.name,
    ...(n.ref ? { ref: n.ref } : {}),
    ...(n.value !== undefined && n.value !== '' ? { value: n.value } : {}),
  }));
}

function toCompactChanged(nodes: ReturnType<typeof diffSnapshots>['changed']): CompactDeltaItem[] {
  return nodes.map((n) => ({
    role: n.role,
    name: n.name,
    ...(n.ref ? { ref: n.ref } : {}),
    ...(n.after.value !== undefined ? { value: n.after.value } : {}),
    ...(n.after.checked !== undefined ? { checked: n.after.checked } : {}),
    ...(n.after.disabled !== undefined ? { disabled: n.after.disabled } : {}),
    ...(n.after.selected !== undefined ? { selected: n.after.selected } : {}),
    ...(n.before.value !== undefined ? { beforeValue: n.before.value } : {}),
    ...(n.before.checked !== undefined ? { beforeChecked: n.before.checked } : {}),
    ...(n.before.disabled !== undefined ? { beforeDisabled: n.before.disabled } : {}),
  }));
}

function appendInlineRefs(text: string, added: readonly CompactDeltaItem[]): string {
  const actionable = added.filter((n) => n.ref && n.name && /^(?:button|link|menuitem|tab)$/i.test(n.role)).slice(0, 5);
  if (actionable.length === 0) return text;
  const tags = actionable.map((n) => `[${n.name.slice(0, 28)} ${n.ref}]`).join(' ');
  return text.includes(actionable[0]!.ref!) ? text : `${text} ${tags}`;
}

export interface ActionDeltaBaseline {
  beforeSnap: SnapshotResult;
  beforeNet: NetworkEntry[];
  beforeLastNetId: number;
  startedAt: number;
}

/** 采集动作前基线：若缓存快照在新鲜窗口内且 URL 一致，直接复用省去一次 AX 拉取。 */
export async function captureActionBaseline(ctx: ActionDeltaContext): Promise<ActionDeltaBaseline> {
  const startedAt = Date.now();
  const beforeNet = ctx.networkEntries ? ctx.networkEntries() : [];
  const beforeLastNetId =
    beforeNet.length > 0 && typeof beforeNet[beforeNet.length - 1]!.id === 'number'
      ? beforeNet[beforeNet.length - 1]!.id!
      : 0;
  const currentUrl = ctx.client.currentUrl();
  const cached = getLastSnapshot(ctx.scopeKey);
  const cachedAt = snapshotTimestamps.get(ctx.scopeKey) ?? 0;
  const freshWindow = ctx.reuseSnapshotWindowMs ?? 3_000;

  if (cached && cached.url === currentUrl && startedAt - cachedAt <= freshWindow) {
    return { beforeSnap: cached, beforeNet, beforeLastNetId, startedAt };
  }

  const [beforeTitle, beforeNodes] = await Promise.all([
    ctx.client.title().catch(() => ''),
    ctx.client.snapshot({ interactiveOnly: true }).catch(() => []),
  ]);
  return {
    beforeSnap: { url: currentUrl, title: beforeTitle, nodes: beforeNodes },
    beforeNet,
    beforeLastNetId,
    startedAt,
  };
}

/** 在动作完成后采集统一 `ActionDelta`（含轻量 settle、交互差分折叠、API 增量、弹窗文案与副作用冒泡）。 */
export async function finalizeActionDelta(
  ctx: ActionDeltaContext,
  baseline: ActionDeltaBaseline,
): Promise<ActionDelta> {
  if (ctx.settleMs !== 0 && ctx.client.smartSettle) {
    const quietMs = ctx.settleMs ?? 120;
    await ctx.client.smartSettle({ maxWaitMs: 2500, quietMs }).catch(() => {});
  }

  const afterUrl = ctx.client.currentUrl();
  const [afterTitle, afterNodes] = await Promise.all([
    ctx.client.title().catch(() => ''),
    ctx.client.snapshotWithRefs({ interactiveOnly: true }).catch(() => []),
  ]);
  const afterSnap: SnapshotResult = { url: afterUrl, title: afterTitle, nodes: afterNodes };
  rememberSnapshot(ctx.scopeKey, afterSnap);
  markSnapshotFresh(ctx.scopeKey);

  const rawDiff = diffSnapshots(baseline.beforeSnap, afterSnap);
  const foldedAdded = foldDeltaItems(toCompactAdded(rawDiff.added));
  const changedItems = toCompactChanged(rawDiff.changed).slice(0, 30);
  const foldedRemoved = foldDeltaItems(toCompactAdded(rawDiff.removed));

  const network =
    ctx.networkEntriesSince && baseline.beforeLastNetId > 0
      ? summarizeApiNetworkDelta([], ctx.networkEntriesSince(baseline.beforeLastNetId))
      : summarizeApiNetworkDelta(baseline.beforeNet, ctx.networkEntries ? ctx.networkEntries() : []);

  const healed = ctx.client.consumeHealedRefs?.() ?? [];
  const sideEffects = ctx.client.peekUnhandledSideEffects?.() ?? {};
  const navErrorRec = afterUrl.startsWith('chrome-error://') ? ctx.client.lastNavigationError?.() : null;

  let openedText: string | undefined;
  const shouldExtractText =
    ctx.includeText !== false &&
    ctx.client.evaluate &&
    (rawDiff.urlChanged || rawDiff.added.some((n) => OPENED_TEXT_ROLE_RE.test(n.role)));
  if (shouldExtractText) {
    const hintRoles = rawDiff.added.map((n) => n.role.toLowerCase());
    const extracted = await ctx.client.evaluate!(OPENED_TEXT_EXTRACTOR_JS, hintRoles)
      .then((v) => (typeof v === 'string' ? v.trim() : ''))
      .catch(() => '');
    if (extracted) {
      openedText = appendInlineRefs(extracted, foldedAdded.items);
    }
  }

  const changed = Boolean(
    rawDiff.urlChanged ||
    rawDiff.titleChanged ||
    rawDiff.addedCount > 0 ||
    rawDiff.removedCount > 0 ||
    rawDiff.changedCount > 0 ||
    network.length > 0 ||
    sideEffects.openDialog ||
    (sideEffects.unhandledPopups && sideEffects.unhandledPopups.length > 0) ||
    (sideEffects.activeDownloads && sideEffects.activeDownloads.length > 0),
  );

  const hints = ctx.resolveContextHints?.(afterUrl);
  const contextHints =
    hints && ((hints.siteNotes && hints.siteNotes.length > 0) || (hints.savedFlows && hints.savedFlows.length > 0))
      ? {
          ...(hints.siteNotes?.length
            ? { siteNotes: hints.siteNotes.map((n) => ({ site: n.site, content: n.content })) }
            : {}),
          ...(hints.savedFlows?.length ? { savedFlows: hints.savedFlows } : {}),
        }
      : undefined;

  const loopWarning = ctx.recordLoopProbe?.({
    urlBefore: baseline.beforeSnap.url,
    urlAfter: afterUrl,
    changed,
  });

  const foldedGroups = [...foldedAdded.foldedGroups, ...foldedRemoved.foldedGroups.map((g) => g.replace(/^\+ /, '- '))];

  return {
    changed,
    urlChanged: rawDiff.urlChanged,
    titleChanged: rawDiff.titleChanged,
    url: afterUrl,
    title: afterTitle,
    ...(navErrorRec?.error ? { navError: navErrorRec.error } : {}),
    ...(healed.length > 0 ? { healed } : {}),
    nodes: {
      added: foldedAdded.items.slice(0, 40),
      changed: changedItems,
      removed: foldedRemoved.items.slice(0, 20),
      ...(foldedGroups.length > 0 ? { foldedGroups } : {}),
    },
    network,
    ...(openedText ? { openedText } : {}),
    ...(contextHints ? { contextHints } : {}),
    sideEffects,
    ...(loopWarning ? { loopWarning } : {}),
  };
}

/** 包装单步写动作：自动采集基线、执行动作并附加 `delta` 与 `healed` 到返回对象。 */
export async function runWithActionDelta<T>(
  ctx: ActionDeltaContext,
  fn: () => Promise<T>,
): Promise<T & { delta?: ActionDelta; healed?: RefHealNotice[] }> {
  const baseline = await captureActionBaseline(ctx);
  const result = await fn();
  const delta = await finalizeActionDelta(ctx, baseline);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const merged = {
      ...(result as Record<string, unknown>),
      ...(delta.healed?.length ? { healed: delta.healed } : {}),
      delta,
    };
    return merged as T & { delta?: ActionDelta; healed?: RefHealNotice[] };
  }
  return { value: result, ...(delta.healed?.length ? { healed: delta.healed } : {}), delta } as unknown as T & {
    delta?: ActionDelta;
    healed?: RefHealNotice[];
  };
}
