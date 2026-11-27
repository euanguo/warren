import type { AxNode, SavedFlowSummary, SiteNote, SnapshotScope, ViewportMetrics } from '../../../shared/types.ts';
import { INTERACTIVE_ROLE_RE } from '../roles.ts';

/** 语义上下文容器角色（在缩进树与 `--filter` 剪枝时保留作结构锚点）。 */
const CONTAINER_CONTEXT_ROLE_RE =
  /^(dialog|alertdialog|navigation|main|form|region|table|tablist|menu|menubar|tree|list|banner|complementary|contentinfo)$/i;

const KEY_SEMANTIC_ROLE_RE = /^(heading|alert|status|dialog|alertdialog|img)$/i;

const CHECKABLE_ROLE_RE = /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/i;

/** 同构长列表折叠角色（刻意排除根部普通 button 按钮组，避免隐藏独立动作按钮）。 */
const FOLDABLE_LIST_ROLE_RE = /^(option|menuitem|listitem|treeitem|row|link|tab|gridcell)$/i;

export interface CompactSnapshotOptions {
  url: string;
  title: string;
  nodes: AxNode[];
  siteNotes?: SiteNote[];
  /** 同站点笔记已在当前会话注入且未变化时仅输出单行极简锚点。 */
  notesAlreadyLoadedLines?: number;
  /** 命中当前域名的只读 Saved Flows 摘要（首访自动提示）。 */
  savedFlows?: SavedFlowSummary[];
  /** WebMCP 探测到的工具摘要（纯提示，标记为 untrusted）。 */
  webmcpTools?: Array<{ name: string; description?: string }>;
  /** 视口与滚动进度元数据（开启 `--viewport` 时同时附带上下屏外省略统计）。 */
  viewport?: ViewportMetrics;
  scope?: SnapshotScope;
  interactiveOnly?: boolean;
  /** 最大树缩进深度（从 0 起算，对应 `node.depth` 而非 heading `level`）。 */
  maxDepth?: number;
  maxNodes?: number;
  /** 分层 Token 预算上限（按 4 字符 ≈ 1 token 估算）；超限时按 Tier1→Tier2→Tier3 与 80/20 首尾截断。 */
  maxTokens?: number;
  /** 在链接后展示真实 URL（`-u` / `--urls`）。 */
  urls?: boolean;
  /** 按子串或 `/regex/` 过滤节点（同时保留其语义祖先链）。 */
  filter?: string;
  /** 禁用长列表与连续禁用节点自动折叠（`--no-fold`）。 */
  noFold?: boolean;
}

function cleanText(raw?: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteText(raw: string): string {
  const shortened = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  return JSON.stringify(shortened);
}

function compileFilter(raw?: string): ((text: string) => boolean) | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  const reMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  if (reMatch) {
    try {
      const re = new RegExp(reMatch[1]!, reMatch[2] || 'i');
      return (text) => re.test(text);
    } catch {
      // 非法正则退回子串匹配
    }
  }
  const needle = trimmed.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

function stateFlagsFor(node: AxNode, nthDisplay?: number): string[] {
  const flags: string[] = [];
  if (node.sensitive) {
    flags.push('value="••••••••"');
  } else if (node.value !== undefined && node.value !== '') {
    flags.push(`value=${quoteText(cleanText(node.value))}`);
  }
  if (node.checked === true) flags.push('checked');
  else if (node.checked === 'mixed') flags.push('checked=mixed');
  else if (node.checked === false && CHECKABLE_ROLE_RE.test(node.role)) flags.push('unchecked');
  if (node.selected) flags.push('selected');
  if (node.expanded !== undefined) flags.push(node.expanded ? 'expanded' : 'collapsed');
  if (node.pressed === true) flags.push('pressed');
  else if (node.pressed === 'mixed') flags.push('pressed=mixed');
  if (node.disabled) flags.push('disabled');
  if (node.readonly) flags.push('readonly');
  if (node.required) flags.push('required');
  if (node.focused) flags.push('focused');
  if (node.level !== undefined) flags.push(`level=${node.level}`);
  if (node.cursorInteractive) flags.push('cursor');
  if (node.hiddenInput) flags.push('hidden-input');
  if (node.isNew) flags.push('new');
  if (node.optionsSummary && node.optionsSummary.length > 0) {
    const preview = node.optionsSummary.slice(0, 6).map((s) => cleanText(s).slice(0, 32));
    const more = node.optionsSummary.length > 6 ? `, +${node.optionsSummary.length - 6}` : '';
    flags.push(`options=[${preview.join(', ')}${more}]`);
  }
  if (nthDisplay !== undefined) flags.push(`nth=${nthDisplay}`);
  return flags;
}

interface RenderRow {
  line: string;
  tier: 1 | 2 | 3;
  depth: number;
  parentIdx: number;
  role: string;
  name: string;
  ref?: string;
  disabled?: boolean;
  selected?: boolean;
  checked?: boolean | 'mixed';
  isInteractive: boolean;
}

function estimateTokens(lines: readonly string[]): number {
  let chars = 0;
  for (const line of lines) chars += line.length + 1;
  return Math.ceil(chars / 4);
}

/**
 * 折叠连续同构长列表（>=8 项）与连续禁用节点（>=4 项），保留首尾与选中/勾选态，显著压低快照噪音。
 */
function foldCompactRows(rows: readonly RenderRow[], hasTreeDepth: boolean): RenderRow[] {
  const afterDisabled: RenderRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const cur = rows[i]!;
    if (cur.disabled) {
      let j = i + 1;
      while (
        j < rows.length &&
        rows[j]!.disabled &&
        rows[j]!.depth === cur.depth &&
        rows[j]!.parentIdx === cur.parentIdx &&
        rows[j]!.role.toLowerCase() === cur.role.toLowerCase()
      ) {
        j += 1;
      }
      const runLen = j - i;
      if (runLen >= 4) {
        afterDisabled.push(cur);
        const indent = hasTreeDepth ? '  '.repeat(Math.min(cur.depth, 10)) : '';
        afterDisabled.push({
          line: `${indent}... (${runLen - 1} more disabled ${cur.role} folded; use --no-fold to expand)`,
          tier: 2,
          depth: cur.depth,
          parentIdx: cur.parentIdx,
          role: 'fold',
          name: '',
          isInteractive: false,
        });
        i = j;
        continue;
      }
    }
    afterDisabled.push(cur);
    i += 1;
  }

  const out: RenderRow[] = [];
  i = 0;
  while (i < afterDisabled.length) {
    const cur = afterDisabled[i]!;
    if (FOLDABLE_LIST_ROLE_RE.test(cur.role)) {
      let j = i + 1;
      while (
        j < afterDisabled.length &&
        afterDisabled[j]!.depth === cur.depth &&
        afterDisabled[j]!.parentIdx === cur.parentIdx &&
        afterDisabled[j]!.role.toLowerCase() === cur.role.toLowerCase()
      ) {
        j += 1;
      }
      const runLen = j - i;
      if (runLen >= 8) {
        const run = afterDisabled.slice(i, j);
        const head = run.slice(0, 3);
        const tail = run[run.length - 1]!;
        const special = run
          .slice(3, -1)
          .filter((r) => r.selected || r.checked === true || r.checked === 'mixed')
          .slice(0, 3);
        const omitted = runLen - head.length - special.length - 1;
        const firstRef = run.find((r) => r.ref)?.ref;
        const lastRef = [...run].reverse().find((r) => r.ref)?.ref;
        const refRange = firstRef && lastRef && firstRef !== lastRef ? ` ${firstRef}..${lastRef}` : '';
        const indent = hasTreeDepth ? '  '.repeat(Math.min(cur.depth, 10)) : '';
        out.push(...head, ...special);
        out.push({
          line: `${indent}... (${omitted} more ${cur.role} folded${refRange}; use --no-fold or --filter to expand)`,
          tier: 2,
          depth: cur.depth,
          parentIdx: cur.parentIdx,
          role: 'fold',
          name: '',
          isInteractive: false,
        });
        out.push(tail);
        i = j;
        continue;
      }
    }
    out.push(cur);
    i += 1;
  }
  return out;
}

/**
 * 将 AX 节点数组格式化为带真实 2 空格缩进的紧凑语义树：
 * - 修复 `-d`（按真实 `node.depth` 裁剪，不再误比 heading `level`）；
 * - 完整输出 3 态 `checked`/`unchecked`/`checked=mixed` 与重复 `(role, name)` 的 `nth=N`；
 * - 支持 `-u` 链接 URL、`--filter` 剪枝（保留祖先链）、视口进度提示、长列表/禁用折叠与密码定宽脱敏；
 * - 支持分层 Token 预算 + 80/20 首尾保留，避免截断页面底部弹窗或提交按钮。
 */
export function formatCompactSnapshot(options: CompactSnapshotOptions): string {
  const headerLines: string[] = [];
  if (options.siteNotes && options.siteNotes.length > 0) {
    headerLines.push('# site-notes');
    for (const note of options.siteNotes) {
      for (const noteLine of note.content.split(/\r?\n/)) {
        const trimmed = noteLine.trim();
        if (trimmed) headerLines.push(`- [${note.site}] ${trimmed}`);
      }
    }
    headerLines.push('');
  } else if (options.notesAlreadyLoadedLines && options.notesAlreadyLoadedLines > 0) {
    headerLines.push(`# site-notes (已加载 ${options.notesAlreadyLoadedLines} 行，未变更)`);
  }

  if (options.savedFlows && options.savedFlows.length > 0) {
    headerLines.push('# saved-flows (可用 warren flow run <env> <name> 直接读数据)');
    for (const flow of options.savedFlows.slice(0, 8)) {
      const pText = flow.params.length > 0 ? ` [params: ${flow.params.join(', ')}]` : '';
      const desc = flow.description ? `: ${cleanText(flow.description).slice(0, 80)}` : '';
      headerLines.push(`- ${flow.name}${pText}${desc}`);
    }
    headerLines.push('');
  }

  if (options.webmcpTools && options.webmcpTools.length > 0) {
    headerLines.push('# webmcp-tools (untrusted page-declared)');
    for (const tool of options.webmcpTools.slice(0, 12)) {
      const desc = cleanText(tool.description).slice(0, 100);
      headerLines.push(`- ${tool.name}${desc ? `: ${desc}` : ''}`);
    }
    headerLines.push('');
  }

  headerLines.push(`url: ${options.url}`);
  if (options.title) headerLines.push(`title: ${cleanText(options.title)}`);
  if (options.viewport) {
    const vp = options.viewport;
    const pct = Number.isFinite(vp.scrollPercentY)
      ? Math.max(0, Math.min(100, Math.round(vp.scrollPercentY)))
      : (() => {
          const maxScroll = Math.max(0, vp.scrollHeight - vp.height);
          return maxScroll > 0 ? Math.min(100, Math.round((vp.scrollY / maxScroll) * 100)) : 100;
        })();
    const scopeTag = options.scope === 'viewport' ? ' [scope=viewport]' : '';
    headerLines.push(`viewport: ${vp.width}x${vp.height} scroll=${vp.scrollY}/${vp.scrollHeight} (${pct}%)${scopeTag}`);
  }

  const maxDepth = options.maxDepth;
  const maxNodes = options.maxNodes && options.maxNodes > 0 ? options.maxNodes : 600;
  const filterFn = compileFilter(options.filter);

  // 统计 `(role, name)` 重复次数，仅对重复项附加 `nth=N` 消歧标记
  const pairTotals = new Map<string, number>();
  for (const node of options.nodes) {
    const n = cleanText(node.name);
    if (!n) continue;
    const key = `${node.role.toLowerCase()}::${n.toLowerCase()}`;
    pairTotals.set(key, (pairTotals.get(key) ?? 0) + 1);
  }
  const pairSeen = new Map<string, number>();

  // 当使用 `--filter` 或包含真实深度树时，预先计算每个节点对应的祖先链索引
  const parentIndex = Array.from({ length: options.nodes.length }, () => -1);
  const stack: Array<{ idx: number; depth: number }> = [];
  for (let i = 0; i < options.nodes.length; i++) {
    const d = options.nodes[i]!.depth ?? 0;
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= d) stack.pop();
    parentIndex[i] = stack.length > 0 ? stack[stack.length - 1]!.idx : -1;
    stack.push({ idx: i, depth: d });
  }

  // 计算每个节点的可见与保留集合
  const keep = new Set<number>();
  const markAncestors = (idx: number) => {
    let cur = parentIndex[idx]!;
    while (cur >= 0) {
      const anc = options.nodes[cur]!;
      const ancDepth = anc.depth ?? 0;
      if (maxDepth === undefined || ancDepth <= maxDepth) {
        if (CONTAINER_CONTEXT_ROLE_RE.test(anc.role) || KEY_SEMANTIC_ROLE_RE.test(anc.role)) {
          keep.add(cur);
        }
      }
      cur = parentIndex[cur]!;
    }
  };

  for (let i = 0; i < options.nodes.length; i++) {
    const node = options.nodes[i]!;
    const depth = node.depth ?? 0;
    if (maxDepth !== undefined && depth > maxDepth) continue;
    const isInteractive = INTERACTIVE_ROLE_RE.test(node.role) || Boolean(node.cursorInteractive || node.hiddenInput);
    const isSemantic = KEY_SEMANTIC_ROLE_RE.test(node.role);
    const isContainer = CONTAINER_CONTEXT_ROLE_RE.test(node.role) && Boolean(cleanText(node.name));
    if (options.interactiveOnly && !isInteractive) continue;
    if (!options.interactiveOnly && !isInteractive && !isSemantic && !isContainer && !cleanText(node.name)) continue;

    if (filterFn) {
      const searchable = `${node.role} ${cleanText(node.name)} ${node.sensitive ? '' : cleanText(node.value)} ${node.url ?? ''}`;
      if (!filterFn(searchable)) continue;
      keep.add(i);
      markAncestors(i);
    } else {
      keep.add(i);
    }
  }

  // 构建带真实缩进的行表
  const hasTreeDepth = options.nodes.some((n) => (n.depth ?? 0) > 0);
  const rows: RenderRow[] = [];
  for (let i = 0; i < options.nodes.length; i++) {
    if (!keep.has(i)) continue;
    const node = options.nodes[i]!;
    const depth = node.depth ?? 0;
    const name = cleanText(node.name);
    const pairKey = name ? `${node.role.toLowerCase()}::${name.toLowerCase()}` : '';
    let nthDisplay: number | undefined;
    if (pairKey && (pairTotals.get(pairKey) ?? 0) > 1) {
      const curNth = pairSeen.get(pairKey) ?? 0;
      pairSeen.set(pairKey, curNth + 1);
      nthDisplay = node.nth ?? curNth;
    }

    const isInteractive = INTERACTIVE_ROLE_RE.test(node.role) || Boolean(node.cursorInteractive || node.hiddenInput);
    const isSemantic = KEY_SEMANTIC_ROLE_RE.test(node.role) || CONTAINER_CONTEXT_ROLE_RE.test(node.role);
    const tier: 1 | 2 | 3 = isInteractive ? 1 : isSemantic ? 2 : 3;

    const namePart = name ? ` ${quoteText(name)}` : '';
    const flags = stateFlagsFor(node, nthDisplay);
    if (node.ref) flags.push(`ref=${node.ref}`);
    const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    const urlPart = options.urls && node.url ? ` -> ${node.url}` : '';
    const indentSpaces = hasTreeDepth ? '  '.repeat(Math.min(depth, 10)) : '';

    rows.push({
      line: `${indentSpaces}- ${node.role}${namePart}${suffix}${urlPart}`,
      tier,
      depth,
      parentIdx: parentIndex[i]!,
      role: node.role,
      name,
      ref: node.ref,
      disabled: node.disabled,
      selected: node.selected,
      checked: node.checked,
      isInteractive,
    });
  }

  const effectiveRows = !options.noFold && !filterFn ? foldCompactRows(rows, hasTreeDepth) : rows;

  const viewportFooterLines: string[] = [];
  if (options.viewport && ((options.viewport.omittedAbove ?? 0) > 0 || (options.viewport.omittedBelow ?? 0) > 0)) {
    const parts: string[] = [];
    if (options.viewport.omittedAbove) parts.push(`${options.viewport.omittedAbove} above`);
    if (options.viewport.omittedBelow) parts.push(`${options.viewport.omittedBelow} below`);
    viewportFooterLines.push(`# viewport-omitted: ${parts.join(', ')} (use browser scroll or snapshot --full-page)`);
  }

  if (effectiveRows.length === 0) {
    return [...headerLines, '(no matching nodes)', ...viewportFooterLines].join('\n');
  }

  // 先按分层策略与 Token / Node 预算筛选
  let selectedRows = effectiveRows;
  let truncatedReason = '';

  const maxTokens = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : undefined;
  const headerTokens = estimateTokens(headerLines);
  const bodyTokenBudget = maxTokens ? Math.max(120, maxTokens - headerTokens - 30) : undefined;

  if (bodyTokenBudget !== undefined && estimateTokens(effectiveRows.map((r) => r.line)) > bodyTokenBudget) {
    // Tier 1（交互）全留 → Tier 2（语义上下文）→ Tier 3（普通文本）
    const tier1Idx = new Set<number>();
    const tier2Idx = new Set<number>();
    const tier3Idx = new Set<number>();
    effectiveRows.forEach((r, idx) => {
      if (r.tier === 1) tier1Idx.add(idx);
      else if (r.tier === 2) tier2Idx.add(idx);
      else tier3Idx.add(idx);
    });

    const chosen = new Set<number>();
    let usedTokens = 0;
    const addByIndices = (indices: number[]) => {
      for (const idx of indices) {
        const cost = Math.ceil((effectiveRows[idx]!.line.length + 1) / 4);
        if (usedTokens + cost > bodyTokenBudget) return false;
        chosen.add(idx);
        usedTokens += cost;
      }
      return true;
    };

    const t1List = [...tier1Idx];
    const t1Tokens = estimateTokens(t1List.map((i) => effectiveRows[i]!.line));
    if (t1Tokens > bodyTokenBudget) {
      // 80/20 首尾保留：同时护住顶部核心操作与底部弹窗/页脚操作栏
      const headBudget = Math.floor(bodyTokenBudget * 0.8);
      const tailBudget = bodyTokenBudget - headBudget;
      let acc = 0;
      for (const idx of t1List) {
        const cost = Math.ceil((effectiveRows[idx]!.line.length + 1) / 4);
        if (acc + cost > headBudget) break;
        chosen.add(idx);
        acc += cost;
      }
      acc = 0;
      for (let k = t1List.length - 1; k >= 0; k--) {
        const idx = t1List[k]!;
        if (chosen.has(idx)) break;
        const cost = Math.ceil((effectiveRows[idx]!.line.length + 1) / 4);
        if (acc + cost > tailBudget) break;
        chosen.add(idx);
        acc += cost;
      }
    } else {
      addByIndices(t1List);
      addByIndices([...tier2Idx]);
      addByIndices([...tier3Idx]);
    }

    selectedRows = [...chosen].sort((a, b) => a - b).map((idx) => effectiveRows[idx]!);
    truncatedReason = `... (token-budget truncated: kept ${selectedRows.length}/${effectiveRows.length} nodes within ~${maxTokens} tokens; use --selector or --filter to narrow)`;
  } else if (effectiveRows.length > maxNodes) {
    // 超过节点硬上限时同样用 80/20 首尾保留，避免末尾弹窗永远被切掉
    const headCount = Math.floor(maxNodes * 0.8);
    const tailCount = maxNodes - headCount;
    const head = effectiveRows.slice(0, headCount);
    const tail = tailCount > 0 ? effectiveRows.slice(effectiveRows.length - tailCount) : [];
    const omitted = effectiveRows.length - head.length - tail.length;
    selectedRows = [
      ...head,
      {
        line: `... (${omitted} middle nodes omitted; kept ${head.length} head + ${tail.length} tail of ${effectiveRows.length})`,
        tier: 2,
        depth: 0,
        parentIdx: -1,
        role: 'fold',
        name: '',
        isInteractive: false,
      },
      ...tail,
    ];
    truncatedReason = `... (truncated at ${maxNodes} nodes; use --selector, --filter, or --max-depth to narrow)`;
  }

  const outLines = [...headerLines, ...selectedRows.map((r) => r.line), ...viewportFooterLines];
  if (truncatedReason) outLines.push(truncatedReason);
  return outLines.join('\n');
}
