/**
 * 观察：层次化 AX 树取数（带短 TTL 缓存与 per-frame loaderId）、混合 DOM 补盲
 * （密码定宽脱敏 / 幽灵文本过滤 / cursor:pointer 与隐藏控件救回 / `-u` 链接解析）、
 * 稳定自愈 ref 分配、截图（含 `--annotate` 编号叠加）。
 *
 * **只有 `assignRefs()` 会往 `RefTable` 注册 ref。** 别的模块要读 AX 树一律走 `readAxNodes()`。
 */
import type {
  AxNode,
  ScreenshotAnnotation,
  ScreenshotOptions,
  ScreenshotResult,
  SnapshotOptions,
} from '../../shared/types.ts';
import type { AxFrame, PageContext } from './ctx.ts';
import { defaultScreenshotPath, guardScreenshotPath, imageSize, sha256Buffer, writeArtifact } from '../artifacts.ts';
import { INTERACTIVE_ROLE_RE } from './ops/snapshot-compact.ts';
import { boxRect, err } from './page-helpers.ts';
import {
  canFallbackToElectronScreenshot,
  SCREENSHOT_CDP_TIMEOUT_MS,
  screenshotFallbackError,
  withTimeout,
} from './screenshot-policy.ts';

/** 同一轮等待里的多次取树复用一份。 */
const AX_CACHE_TTL_MS = 300;
const axCache = new Map<number, { frames: AxFrame[]; at: number }>();

/** 导航/销毁后丢掉缓存，别把上一页的结构喂给下一步。 */
export function invalidateAxCache(wcId: number): void {
  axCache.delete(wcId);
}

interface RawFrameTreeNode {
  frame?: { id?: string; loaderId?: string; url?: string; name?: string };
  childFrames?: RawFrameTreeNode[];
}

/**
 * 各 frame 的 AX 节点（含同源子 frame 与 OOPIF 跨源子 frame），附带每个 frame 的 `loaderId`。
 */
export async function readAxFrames(ctx: PageContext): Promise<AxFrame[]> {
  const cached = axCache.get(ctx.wc.id);
  if (cached && Date.now() - cached.at < AX_CACHE_TTL_MS && sessionsAlive(ctx, cached.frames)) return cached.frames;

  const tree = await ctx.send<{ frameTree?: RawFrameTreeNode }>('Page.getFrameTree').catch(() => null);
  const frameMetas: Array<{ frameId: string; loaderId?: string; url?: string; name?: string }> = [];
  const walk = (node: RawFrameTreeNode | undefined) => {
    if (!node?.frame?.id) return;
    frameMetas.push({
      frameId: node.frame.id,
      loaderId: node.frame.loaderId,
      url: node.frame.url,
      name: node.frame.name,
    });
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(tree?.frameTree);

  const out: AxFrame[] = [];
  for (const meta of frameMetas) {
    try {
      const r = await ctx.send<{ nodes?: Array<Record<string, unknown>> }>('Accessibility.getFullAXTree', {
        frameId: meta.frameId,
      });
      out.push({
        frameId: meta.frameId,
        loaderId: meta.loaderId,
        url: meta.url,
        name: meta.name,
        nodes: r.nodes ?? [],
      });
    } catch {
      // frame 可能在取的过程中销毁
    }
  }
  // OOPIF：每个子会话自己就是一棵树，主会话的 frame tree 里根本没有它
  for (const child of ctx.childSessions()) {
    if (!child.frameId) continue;
    try {
      const [childTree, r] = await Promise.all([
        ctx.sendOn<{ frameTree?: RawFrameTreeNode }>(child.sessionId, 'Page.getFrameTree').catch(() => null),
        ctx.sendOn<{ nodes?: Array<Record<string, unknown>> }>(child.sessionId, 'Accessibility.getFullAXTree'),
      ]);
      out.push({
        frameId: child.frameId,
        sessionId: child.sessionId,
        loaderId: childTree?.frameTree?.frame?.loaderId,
        url: childTree?.frameTree?.frame?.url ?? child.url,
        name: childTree?.frameTree?.frame?.name,
        nodes: r.nodes ?? [],
      });
    } catch {
      // 子 frame 可能在取的过程中销毁
    }
  }
  axCache.set(ctx.wc.id, { frames: out, at: Date.now() });
  return out;
}

function sessionsAlive(ctx: PageContext, frames: AxFrame[]): boolean {
  const alive = new Set(ctx.childSessions().map((child) => child.sessionId));
  return frames.every((frame) => !frame.sessionId || alive.has(frame.sessionId));
}

/** 这个 backendNodeId 属于哪个 frame / 会话。没在 AX 树里（比如裸 div）返回 undefined。 */
export async function frameOfBackendId(
  ctx: PageContext,
  backendNodeId: number,
): Promise<{ frameId: string; sessionId?: string } | undefined> {
  const frames = await readAxFrames(ctx).catch(() => []);
  const alive = new Set(ctx.childSessions().map((child) => child.sessionId));
  for (const frame of frames) {
    if (frame.nodes.some((node) => node.backendDOMNodeId === backendNodeId)) {
      if (frame.sessionId && !alive.has(frame.sessionId)) {
        throw Object.assign(new Error('跨源子会话已经换掉了，重新解析目标'), {
          code: 'NODE_DETACHED',
        });
      }
      return { frameId: frame.frameId, sessionId: frame.sessionId };
    }
  }
  return undefined;
}

function propValue(node: Record<string, unknown>, name: string): unknown {
  const props = node.properties as Array<{ name?: string; value?: { value?: unknown } }> | undefined;
  return props?.find((p) => p.name === name)?.value?.value;
}

function statesOf(node: Record<string, unknown>) {
  const bool = (v: unknown): boolean | undefined =>
    typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
  const tri = (v: unknown): boolean | 'mixed' | undefined => (v === 'mixed' ? 'mixed' : bool(v));
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return {
    disabled: bool(propValue(node, 'disabled')),
    checked: tri(propValue(node, 'checked')),
    expanded: bool(propValue(node, 'expanded')),
    selected: bool(propValue(node, 'selected')),
    pressed: tri(propValue(node, 'pressed')),
    level: num(propValue(node, 'level')),
    readonly: bool(propValue(node, 'readonly')),
    required: bool(propValue(node, 'required')),
    focused: bool(propValue(node, 'focused')),
    valuetext: str(propValue(node, 'valuetext')),
  };
}

/** 噪音包裹角色：不增加语义缩进层，透传给子节点。 */
const TRANSPARENT_ROLE_RE =
  /^(RootWebArea|generic|none|presentation|LayoutTable|LayoutTableRow|LayoutTableCell|InlineTextBox|LineBreak)$/i;

/**
 * 基于 `childIds` 深度优先遍历单帧 AX 树，还原真实语义缩进 `depth`，
 * 同时完成：
 * 1. `MenuListPopup` / `<select>` 的选项摘要合并到父 `combobox.optionsSummary`；
 * 2. 剪除与父按钮/链接完全同名的冗余子 `StaticText`；
 * 3. 合并同一层级下相邻的 `StaticText`。
 */
export function buildHierarchicalAxNodes(
  rawNodes: Array<Record<string, unknown>>,
  frame: Pick<AxFrame, 'frameId' | 'loaderId'>,
  includeFrameId: boolean,
  limit: number,
): AxNode[] {
  if (rawNodes.length === 0) return [];
  const byId = new Map<string, Record<string, unknown>>();
  const hasParent = new Set<string>();
  for (const n of rawNodes) {
    const id = n.nodeId !== undefined && n.nodeId !== null ? String(n.nodeId) : '';
    if (id) byId.set(id, n);
  }
  for (const n of rawNodes) {
    const kids = n.childIds as unknown[] | undefined;
    if (Array.isArray(kids)) {
      for (const k of kids) hasParent.add(String(k));
    }
  }
  const roots: string[] = [];
  for (const n of rawNodes) {
    const id = n.nodeId !== undefined && n.nodeId !== null ? String(n.nodeId) : '';
    if (id && !hasParent.has(id)) roots.push(id);
  }
  // 兜底：若原始测试数据没带 nodeId/childIds，退回顺序拍平
  if (roots.length === 0 || byId.size === 0) {
    return rawNodes
      .filter((n) => !n.ignored)
      .slice(0, limit)
      .map((node) => {
        const role = (node.role as { value?: string } | undefined)?.value ?? '';
        const name = (node.name as { value?: string } | undefined)?.value ?? '';
        const value = (node.value as { value?: string } | undefined)?.value;
        return {
          role,
          name: typeof name === 'string' ? name : '',
          backendNodeId: node.backendDOMNodeId as number | undefined,
          value: typeof value === 'string' ? value : undefined,
          description: (node.description as { value?: string } | undefined)?.value,
          depth: 0,
          loaderId: frame.loaderId,
          ...statesOf(node),
          ...(includeFrameId ? { frameId: frame.frameId } : {}),
        };
      });
  }

  const out: AxNode[] = [];
  const visited = new Set<string>();

  const collectMenuOptions = (nodeId: string): string[] => {
    const opts: string[] = [];
    const queue = [nodeId];
    const seen = new Set<string>();
    while (queue.length > 0 && opts.length < 20) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id);
      if (!n) continue;
      const role = String((n.role as { value?: string } | undefined)?.value ?? '');
      const name = String((n.name as { value?: string } | undefined)?.value ?? '').trim();
      if (/^(MenuListOption|option)$/i.test(role) && name) {
        opts.push(name);
      }
      const kids = n.childIds as unknown[] | undefined;
      if (Array.isArray(kids)) {
        for (const k of kids) queue.push(String(k));
      }
    }
    return opts;
  };

  const dfs = (nodeId: string, depth: number, parentRole: string, parentNameNorm: string) => {
    if (out.length >= limit || visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = byId.get(nodeId);
    if (!node) return;
    const kids = (node.childIds as unknown[] | undefined)?.map(String) ?? [];

    if (node.ignored) {
      for (const kid of kids) dfs(kid, depth, parentRole, parentNameNorm);
      return;
    }

    const role = String((node.role as { value?: string } | undefined)?.value ?? '');
    const rawName = String((node.name as { value?: string } | undefined)?.value ?? '');
    const nameNorm = rawName.replace(/\s+/g, ' ').trim();
    const value = (node.value as { value?: string } | undefined)?.value;
    const backendId = node.backendDOMNodeId as number | undefined;

    // 跳过已折叠进父 combobox 的 MenuListPopup
    if (/^MenuListPopup$/i.test(role)) return;

    // 剪除与父交互控件（button/link/tab/menuitem/heading）完全同名的冗余子 StaticText
    if (
      /^StaticText$/i.test(role) &&
      nameNorm &&
      parentNameNorm &&
      nameNorm.toLowerCase() === parentNameNorm.toLowerCase() &&
      /^(button|link|tab|menuitem|heading|option|treeitem|checkbox|radio|switch)$/i.test(parentRole)
    ) {
      return;
    }

    const isTransparent = TRANSPARENT_ROLE_RE.test(role);
    const isInteractive = INTERACTIVE_ROLE_RE.test(role);
    const isMeaningful = !isTransparent && (Boolean(nameNorm) || isInteractive || Boolean(value));

    let nextDepth = depth;
    let nextParentRole = parentRole;
    let nextParentName = parentNameNorm;

    if (isMeaningful) {
      // 合并同一深度连续的 StaticText，削减碎片段
      const prev = out[out.length - 1];
      if (
        /^StaticText$/i.test(role) &&
        prev &&
        /^StaticText$/i.test(prev.role) &&
        (prev.depth ?? 0) === depth &&
        prev.frameId === (includeFrameId ? frame.frameId : undefined)
      ) {
        if (nameNorm && !prev.name.includes(nameNorm)) {
          prev.name = `${prev.name} ${nameNorm}`.trim();
        }
        return;
      }

      let optionsSummary: string[] | undefined;
      if (/^(combobox|PopUpButton)$/i.test(role)) {
        const collected: string[] = [];
        for (const kid of kids) {
          const kn = byId.get(kid);
          const kr = String((kn?.role as { value?: string } | undefined)?.value ?? '');
          if (/^MenuListPopup$/i.test(kr)) collected.push(...collectMenuOptions(kid));
        }
        if (collected.length > 0) optionsSummary = collected;
      }

      out.push({
        role,
        name: nameNorm,
        backendNodeId: backendId,
        value: typeof value === 'string' ? value : undefined,
        description: (node.description as { value?: string } | undefined)?.value,
        depth,
        loaderId: frame.loaderId,
        ...(optionsSummary ? { optionsSummary } : {}),
        ...statesOf(node),
        ...(includeFrameId ? { frameId: frame.frameId } : {}),
      });
      nextDepth = depth + 1;
      nextParentRole = role;
      nextParentName = nameNorm;
    }

    for (const kid of kids) {
      dfs(kid, nextDepth, nextParentRole, nextParentName);
      if (out.length >= limit) break;
    }
  };

  for (const r of roots) {
    dfs(r, 0, '', '');
    if (out.length >= limit) break;
  }
  return out;
}

/** 把 AX 树整理成层次节点数组。只读，不注册 ref。 */
export async function readAxNodes(ctx: PageContext, limit = 2000): Promise<AxNode[]> {
  const frames = await readAxFrames(ctx);
  const out: AxNode[] = [];
  for (const frame of frames) {
    const remaining = limit - out.length;
    if (remaining <= 0) break;
    const part = buildHierarchicalAxNodes(frame.nodes, frame, frames.length > 1, remaining);
    out.push(...part);
  }
  return out;
}

/** 以某个 backendId 为根，在它所属的那个 frame 里按 childIds 收子树。 */
function collectSubtree(nodes: Array<Record<string, unknown>>, rootBackendId: number): Set<number> {
  const byNodeId = new Map<string, Record<string, unknown>>();
  for (const n of nodes) {
    if (n.nodeId !== undefined && n.nodeId !== null) byNodeId.set(String(n.nodeId), n);
  }
  let rootNodeId: string | null = null;
  for (const [id, n] of byNodeId) {
    if (n.backendDOMNodeId === rootBackendId) {
      rootNodeId = id;
      break;
    }
  }
  const out = new Set<number>();
  if (rootNodeId === null) return out;
  const queue = [rootNodeId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    const node = byIdOrGet(byNodeId, id);
    const b = node?.backendDOMNodeId;
    if (typeof b === 'number') out.add(b);
    const kids = node?.childIds as unknown[] | undefined;
    if (Array.isArray(kids)) queue.push(...kids.map(String));
  }
  return out;
}

function byIdOrGet(map: Map<string, Record<string, unknown>>, key: string) {
  return map.get(key);
}

interface DomAugmentResult {
  passwordIndices: number[];
  hiddenGhostIndices: number[];
  urls: Record<number, string>;
  extras: Array<{ idx: number; role: string; name: string; cursorInteractive?: boolean; hiddenInput?: boolean }>;
  boxes?: Record<number, { x: number; y: number; width: number; height: number }>;
}

/**
 * 隔离世界 DOM 补盲与隐私加固：
 * 1. 标记所有密码框（`type="password"` / `autocomplete*="password"`）做固定宽度 `"••••••••"` 脱敏；
 * 2. 识别 `opacity: 0` / `visibility: hidden` 幽灵元素（保留 `input[type=file]`）；
 * 3. 可选解析 `a[href]` 真实 URL（`-u`）；
 * 4. 可选扫描 `cursor: pointer`（父已 pointer 时去重）、`onclick`、`tabindex>=0`、`[contenteditable]`
 *    与隐藏 `<input type="file">`，把 AX 树漏掉的可交互元素救回快照。
 */
async function augmentMainFrameWithDom(
  ctx: PageContext,
  nodes: AxNode[],
  options: { urls?: boolean; includeCursor?: boolean; boxes?: boolean; mainFrameId?: string; mainLoaderId?: string },
): Promise<AxNode[]> {
  if (ctx.wc.isDestroyed()) return nodes;
  // 在隔离世界扫描页面，绝不污染主世界 window
  const mainFrameId = options.mainFrameId;
  let contextId: number | undefined;
  try {
    const tree = await ctx.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree');
    const fid = mainFrameId ?? tree?.frameTree?.frame?.id;
    if (!fid) return nodes;
    const world = await ctx.send<{ executionContextId?: number }>('Page.createIsolatedWorld', {
      frameId: fid,
      worldName: 'warren-augment',
    });
    contextId = world?.executionContextId;
  } catch {
    return nodes;
  }
  if (!contextId) return nodes;

  try {
    const raw = await ctx.send<{ result?: { value?: DomAugmentResult } }>('Runtime.evaluate', {
      contextId,
      returnByValue: true,
      expression: `(() => {
        const opts = ${JSON.stringify({ urls: Boolean(options.urls), includeCursor: Boolean(options.includeCursor), boxes: Boolean(options.boxes) })};
        const tagGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
        const safeTag = (n) => {
          try { return n && n.nodeType === 1 ? String(tagGetter ? tagGetter.call(n) : n.tagName).toLowerCase() : ''; }
          catch { return ''; }
        };
        const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const collected = [];
        const passwordIndices = [];
        const hiddenGhostIndices = [];
        const urls = {};
        const extras = [];
        const boxes = {};
        const seen = new Set();

        const pushEl = (el) => {
          const idx = collected.length;
          collected.push(el);
          return idx;
        };

        const walk = (root, parentHasPointer) => {
          let all;
          try { all = root.querySelectorAll('*'); } catch { return; }
          for (const el of all) {
            if (seen.has(el)) continue;
            seen.add(el);
            const tag = safeTag(el);
            if (!tag || tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;

            // 1) 密码字段识别
            if (tag === 'input') {
              const type = String(el.type || '').toLowerCase();
              const ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
              if (type === 'password' || ac.includes('password')) {
                passwordIndices.push(pushEl(el));
              }
              // 隐藏 file input 救回
              if (type === 'file' && opts.includeCursor) {
                const label = (el.labels && el.labels[0] && clean(el.labels[0].textContent)) || el.getAttribute('aria-label') || el.getAttribute('name') || 'Upload file';
                extras.push({ idx: pushEl(el), role: 'file_input', name: label.slice(0, 80), hiddenInput: !isVisible(el) });
              }
            }

            // 2) -u 链接 URL
            if (opts.urls && tag === 'a' && el.href) {
              urls[pushEl(el)] = String(el.href);
            }

            const cs = getComputedStyle(el);
            const invisible = cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0;
            if (invisible) {
              if (tag !== 'input' || String(el.type || '').toLowerCase() !== 'file') {
                if (clean(el.textContent).length > 0 && el.children.length === 0) {
                  hiddenGhostIndices.push(pushEl(el));
                }
              }
              if (el.shadowRoot) walk(el.shadowRoot, false);
              continue;
            }

            // 3) Cursor 交互补盲（排除原生可交互标签与大容器）
            const hasPointer = cs.cursor === 'pointer';
            if (opts.includeCursor && extras.length < 120) {
              const isNative = /^(a|button|input|select|textarea|summary|label|option)$/.test(tag);
              const role = (el.getAttribute('role') || '').toLowerCase();
              const hasAriaInteractive = /^(button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|searchbox|option|treeitem|listbox|gridcell)$/.test(role);
              if (!isNative && !hasAriaInteractive) {
                const r = el.getBoundingClientRect();
                const reasonableSize = r.width >= 8 && r.height >= 8 && r.width * r.height < innerWidth * innerHeight * 0.45;
                const explicitInteractive =
                  typeof el.onclick === 'function' ||
                  el.hasAttribute('onclick') ||
                  el.isContentEditable ||
                  (el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0);
                if (reasonableSize && (explicitInteractive || (hasPointer && !parentHasPointer))) {
                  const text = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent).slice(0, 80);
                  if (text || explicitInteractive) {
                    const idx = pushEl(el);
                    extras.push({
                      idx,
                      role: el.isContentEditable ? 'textbox' : 'clickable',
                      name: text || tag,
                      cursorInteractive: true,
                    });
                    if (opts.boxes) {
                      boxes[idx] = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
                    }
                  }
                }
              }
            }

            if (el.shadowRoot) walk(el.shadowRoot, hasPointer);
          }
        };

        walk(document, false);
        window.__warrenAugment = collected;
        return { passwordIndices, hiddenGhostIndices, urls, extras, boxes };
      })()`,
    });

    const data = raw?.result?.value;
    if (!data) return nodes;

    const indexToBackend = new Map<number, number>();
    const neededIndices = new Set<number>([
      ...data.passwordIndices,
      ...data.hiddenGhostIndices,
      ...Object.keys(data.urls).map(Number),
      ...data.extras.map((e) => e.idx),
    ]);
    for (const idx of neededIndices) {
      const obj = await ctx
        .send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
          contextId,
          expression: `window.__warrenAugment[${idx}]`,
          returnByValue: false,
        })
        .catch(() => null);
      const objectId = obj?.result?.objectId;
      if (!objectId) continue;
      try {
        const desc = await ctx
          .send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId })
          .catch(() => null);
        if (typeof desc?.node?.backendNodeId === 'number') {
          indexToBackend.set(idx, desc.node.backendNodeId);
        }
      } finally {
        await ctx.send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }
    await ctx
      .send('Runtime.evaluate', { contextId, expression: 'delete window.__warrenAugment', returnByValue: true })
      .catch(() => {});

    const passwordIds = new Set<number>();
    for (const idx of data.passwordIndices) {
      const bid = indexToBackend.get(idx);
      if (bid !== undefined) passwordIds.add(bid);
    }
    const ghostIds = new Set<number>();
    for (const idx of data.hiddenGhostIndices) {
      const bid = indexToBackend.get(idx);
      if (bid !== undefined) ghostIds.add(bid);
    }
    const urlByBackend = new Map<number, string>();
    for (const [idxStr, href] of Object.entries(data.urls)) {
      const bid = indexToBackend.get(Number(idxStr));
      if (bid !== undefined) urlByBackend.set(bid, href);
    }

    const existingBackendIds = new Set<number>();
    const filtered: AxNode[] = [];
    for (const node of nodes) {
      const bid = node.backendNodeId;
      if (typeof bid === 'number') {
        if (ghostIds.has(bid) && !node.hiddenInput) continue;
        existingBackendIds.add(bid);
        if (passwordIds.has(bid)) {
          node.sensitive = true;
          node.value = '••••••••';
        }
        const href = urlByBackend.get(bid);
        if (href && /^link$/i.test(node.role)) {
          node.url = href;
        }
      }
      filtered.push(node);
    }

    for (const extra of data.extras) {
      const bid = indexToBackend.get(extra.idx);
      if (bid === undefined || existingBackendIds.has(bid)) continue;
      existingBackendIds.add(bid);
      filtered.push({
        role: extra.role,
        name: extra.name,
        backendNodeId: bid,
        depth: 0,
        loaderId: options.mainLoaderId,
        ...(extra.cursorInteractive ? { cursorInteractive: true } : {}),
        ...(extra.hiddenInput ? { hiddenInput: true } : {}),
        ...(data.boxes?.[extra.idx] ? { box: data.boxes[extra.idx] } : {}),
      });
    }

    return filtered;
  } catch {
    return nodes;
  }
}

export async function snapshot(
  ctx: PageContext,
  options: SnapshotOptions & { limit?: number; interestingOnly?: boolean } = {},
): Promise<AxNode[]> {
  const scope = options.scope ?? 'viewport';
  const limit = options.limit ?? (scope === 'full_page' ? 2000 : 600);
  const frames = await readAxFrames(ctx);
  let onlyFrame: string | undefined = options.frame ?? ctx.activeFrameId?.();
  let allowed: Set<number> | null = null;

  if (scope === 'subtree') {
    if (!options.root) throw err('BAD_REQUEST', 'subtree 需要 root（snapshot ref）');
    const { backendId } = ctx.refs.resolve(options.root);
    let ownerFrame: string | undefined;
    let rootNode: Record<string, unknown> | undefined;
    for (const frame of frames) {
      rootNode = frame.nodes.find((node) => node.backendDOMNodeId === backendId);
      if (rootNode) {
        ownerFrame = frame.frameId;
        break;
      }
    }
    if (!ownerFrame) throw err('TARGET_NOT_FOUND', `subtree root 不在当前 AX 树里: ${options.root}`);
    onlyFrame = ownerFrame;
    const role = String((rootNode?.role as { value?: string } | undefined)?.value ?? '');
    if (/^iframe$/i.test(role)) {
      const desc = await ctx
        .send<{ node: { frameId?: string } }>('DOM.describeNode', { backendNodeId: backendId })
        .catch(() => null);
      const childFrame = desc?.node?.frameId;
      if (childFrame && frames.some((frame) => frame.frameId === childFrame)) onlyFrame = childFrame;
    }
    if (onlyFrame === ownerFrame && !/^iframe$/i.test(role)) {
      allowed = collectSubtree(frames.find((frame) => frame.frameId === ownerFrame)?.nodes ?? [], backendId);
    }
  }

  const roles = Array.isArray(options.roles) ? new Set(options.roles.map((role) => role.toLowerCase())) : null;
  let selectorAllowed: Set<number> | null = null;
  if (options.selector) {
    const evaluated = await ctx
      .send<{ result: { objectId?: string } }>('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(options.selector)})`,
        returnByValue: false,
      })
      .catch(() => null);
    const objectId = evaluated?.result?.objectId;
    if (objectId) {
      const described = await ctx
        .send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId })
        .catch(() => null);
      await ctx.send('Runtime.releaseObject', { objectId }).catch(() => {});
      const rootBackendId = described?.node?.backendNodeId;
      if (rootBackendId) {
        const main = frames.find((frame) => !frame.sessionId);
        selectorAllowed = collectSubtree(main?.nodes ?? [], rootBackendId);
      }
    }
    if (!selectorAllowed) selectorAllowed = new Set();
  }

  let out: AxNode[] = [];
  for (const frame of frames) {
    if (onlyFrame && frame.frameId !== onlyFrame) continue;
    const remaining = limit - out.length;
    if (remaining <= 0) break;
    const built = buildHierarchicalAxNodes(frame.nodes, frame, frames.length > 1, remaining * 2);
    for (const node of built) {
      const backendId = node.backendNodeId;
      if (allowed && !(typeof backendId === 'number' && allowed.has(backendId))) continue;
      if (selectorAllowed && !(typeof backendId === 'number' && selectorAllowed.has(backendId))) continue;
      if (options.maxDepth !== undefined && (node.depth ?? 0) > options.maxDepth) continue;
      const isInteractive = INTERACTIVE_ROLE_RE.test(node.role);
      if (options.interactiveOnly && !isInteractive) continue;
      if (roles && !roles.has(node.role.toLowerCase())) continue;
      out.push(node);
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }

  // 主 frame DOM 补盲：密码定宽脱敏 + 幽灵节点剔除 + 按需 cursor/file-input 救回与 -u URL 解析
  const mainFrame = frames.find((f) => !f.sessionId);
  if (!onlyFrame || (mainFrame && onlyFrame === mainFrame.frameId)) {
    out = await augmentMainFrameWithDom(ctx, out, {
      urls: options.urls,
      includeCursor: options.includeCursor ?? Boolean(options.interactiveOnly),
      boxes: options.boxes,
      mainFrameId: mainFrame?.frameId,
      mainLoaderId: mainFrame?.loaderId,
    });
    if (options.interactiveOnly) {
      out = out.filter((n) => INTERACTIVE_ROLE_RE.test(n.role) || n.cursorInteractive || n.hiddenInput);
    }
    if (roles) {
      out = out.filter((n) => roles.has(n.role.toLowerCase()));
    }
  }

  // 若显式要求 boxes，补齐尚未带 box 的可交互节点坐标
  if (options.boxes) {
    for (const n of out) {
      if (n.box || !n.backendNodeId || !isActionableRole(n.role)) continue;
      const frame = frames.find((f) => f.frameId === n.frameId);
      const rect = await boxRect(ctx, n.backendNodeId, frame?.sessionId).catch(() => null);
      if (rect) {
        n.box = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }
    }
  }

  for (const n of out) {
    if (options.includeStableLocator) n.locator = stableLocator(n);
    if (options.includeActionMarks) n.actions = actionMarks(n.role);
  }
  return out.slice(0, limit);
}

/**
 * 给一批节点分配跨快照稳定的 `@N` 并绑定 per-frame `loaderId` 写进 ref 表。
 * **只有 agent 的 `browser.snapshot` / `batch` 调它。**
 */
export function assignRefs(ctx: PageContext, nodes: AxNode[], options: { includeStableLocator?: boolean } = {}): void {
  const frameLoaders = new Map<string, string>();
  for (const n of nodes) {
    if (n.frameId && n.loaderId) frameLoaders.set(n.frameId, n.loaderId);
  }
  const assigned = ctx.refs.registerStable(
    nodes.map((node) =>
      isActionableRole(node.role) || node.cursorInteractive || node.hiddenInput
        ? {
            backendId: node.backendNodeId,
            frameId: node.frameId,
            loaderId: node.loaderId,
            role: node.role,
            name: node.name,
          }
        : undefined,
    ),
    frameLoaders,
  );
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const hit = assigned[i];
    if (hit) {
      node.ref = hit.ref;
      if (hit.isNew) node.isNew = true;
    }
    if (options.includeStableLocator) node.locator = stableLocator(node);
  }
}

export function isActionableRole(role: string): boolean {
  return INTERACTIVE_ROLE_RE.test(String(role || ''));
}

/**
 * 截屏，支持 `--annotate` 在隔离世界叠加临时 `@N` 编号标签框（截图完毕立刻移除）。
 */
export async function screenshot(
  ctx: PageContext,
  opts: ScreenshotOptions = {},
  environmentId?: string,
): Promise<ScreenshotResult> {
  let annotations: ScreenshotAnnotation[] | undefined;
  let annotateContextId: number | undefined;

  if (opts.annotate) {
    const nodes = await snapshot(ctx, { interactiveOnly: true, boxes: true, includeCursor: true });
    assignRefs(ctx, nodes);
    annotations = nodes
      .filter((n) => n.ref && n.box && n.box.width > 0 && n.box.height > 0)
      .slice(0, 80)
      .map((n) => ({
        ref: n.ref!,
        role: n.role,
        name: n.name.slice(0, 60),
        box: n.box!,
      }));
    if (annotations.length > 0) {
      try {
        const tree = await ctx.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree');
        const fid = tree?.frameTree?.frame?.id;
        if (fid) {
          const world = await ctx.send<{ executionContextId?: number }>('Page.createIsolatedWorld', {
            frameId: fid,
            worldName: 'warren-annotate',
          });
          annotateContextId = world?.executionContextId;
          if (annotateContextId) {
            await ctx.send('Runtime.evaluate', {
              contextId: annotateContextId,
              returnByValue: true,
              expression: `(() => {
                const items = ${JSON.stringify(annotations)};
                const old = document.getElementById('__warren_annotate_layer');
                if (old) old.remove();
                const layer = document.createElement('div');
                layer.id = '__warren_annotate_layer';
                layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
                for (const item of items) {
                  const box = document.createElement('div');
                  box.style.cssText =
                    'position:fixed;box-sizing:border-box;border:2px solid #ef4444;background:rgba(239,68,68,0.08);pointer-events:none;' +
                    'left:' + item.box.x + 'px;top:' + item.box.y + 'px;width:' + item.box.width + 'px;height:' + item.box.height + 'px;';
                  const tag = document.createElement('span');
                  tag.textContent = item.ref;
                  tag.style.cssText =
                    'position:absolute;top:-16px;left:0;background:#ef4444;color:#fff;font:600 11px/14px monospace;padding:1px 4px;border-radius:3px;white-space:nowrap;';
                  box.appendChild(tag);
                  layer.appendChild(box);
                }
                (document.body || document.documentElement).appendChild(layer);
                return items.length;
              })()`,
            });
          }
        }
      } catch {
        // 标注覆盖失败不影响主截图
      }
    }
  }

  try {
    const format = opts.format ?? 'png';
    const params: Record<string, unknown> = { format };
    if (opts.fullPage) params.captureBeyondViewport = true;
    if (opts.clip) {
      params.clip = {
        x: opts.clip.x,
        y: opts.clip.y,
        width: opts.clip.width,
        height: opts.clip.height,
        scale: 1,
      };
    }
    let buffer: Buffer;
    let source: 'cdp' | 'electron' = 'cdp';
    try {
      const { data } = await withTimeout(
        ctx.send<{ data: string }>('Page.captureScreenshot', params),
        SCREENSHOT_CDP_TIMEOUT_MS,
        `CDP screenshot timed out after ${SCREENSHOT_CDP_TIMEOUT_MS}ms`,
      );
      buffer = Buffer.from(data, 'base64');
    } catch (error) {
      const fallback = await captureVisiblePage(ctx, format, opts);
      if (!fallback.buffer) throw screenshotFallbackError(fallback.error ?? error);
      buffer = fallback.buffer;
      source = 'electron';
    }
    const wantsBase64 = opts.encoding === 'base64';
    const target =
      opts.path ?? (wantsBase64 ? undefined : defaultScreenshotPath(environmentId ?? String(ctx.tabIndex()), format));
    const extra = annotations ? { annotations } : {};
    if (target) {
      const meta = await writeArtifact(guardScreenshotPath(target), buffer);
      const size = imageSize(buffer, format);
      return {
        ...meta,
        format,
        ...size,
        source,
        ...extra,
        ...(wantsBase64 ? { base64: buffer.toString('base64') } : {}),
      };
    }
    const size = imageSize(buffer, format);
    return {
      bytes: buffer.length,
      sha256: sha256Buffer(buffer),
      format,
      ...size,
      source,
      ...extra,
      base64: buffer.toString('base64'),
    };
  } finally {
    if (annotateContextId) {
      await ctx
        .send('Runtime.evaluate', {
          contextId: annotateContextId,
          returnByValue: true,
          expression: `document.getElementById('__warren_annotate_layer')?.remove()`,
        })
        .catch(() => {});
    }
  }
}

async function captureVisiblePage(
  ctx: PageContext,
  format: 'png' | 'jpeg',
  opts: ScreenshotOptions,
): Promise<{ buffer?: Buffer; error?: unknown }> {
  if (!canFallbackToElectronScreenshot(opts)) return { error: 'fullPage/clip 不能走 Electron 兜底' };
  if (ctx.wc.isDestroyed()) return { error: 'webContents 已销毁' };
  try {
    const image = await ctx.wc.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty()) return { error: 'NativeImage 为空' };
    return { buffer: format === 'jpeg' ? image.toJPEG(92) : image.toPNG() };
  } catch (error) {
    return { error };
  }
}

function stableLocator(n: AxNode): string | undefined {
  if (n.name && /button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|treeitem/i.test(n.role)) {
    return `loc=role:${n.role.toLowerCase()}[name="${n.name.slice(0, 60).replace(/"/g, '\\"')}"]`;
  }
  if (n.ref) return n.ref;
  return undefined;
}

function actionMarks(role: string): Array<'click' | 'fill' | 'select' | 'focus'> {
  const r = role.toLowerCase();
  if (/button|link|menuitem|tab|switch|checkbox|radio|slider|treeitem|clickable|disclosuretriangle/i.test(r)) {
    return ['click', 'focus'];
  }
  if (/textbox|searchbox|combobox/i.test(r)) return ['fill', 'focus'];
  if (/listbox|combobox/i.test(r)) return ['select', 'focus'];
  return ['focus'];
}
