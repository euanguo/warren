/**
 * 多 Frame 可访问性树读取、TTL 缓存、层次化展开与静态文本剪枝。
 * 供 `snapshot.ts`、`locator.ts` 与 `waits.ts` 共用；不负责分配 `@N` 引用。
 */
import type { AxNode } from '../../shared/types.ts';
import type { AxFrame, PageContext } from './ctx.ts';
import { INTERACTIVE_ROLE_RE } from './roles.ts';

/** 同一轮等待里的多次取树复用一份。 */
const AX_CACHE_TTL_MS = 300;
const axCache = new Map<number, { frames: AxFrame[]; at: number }>();

/** 导航/销毁后丢掉 AX 树缓存。 */
export function invalidateAxTreeCache(wcId: number): void {
  axCache.delete(wcId);
}

interface RawFrameTreeNode {
  frame?: { id?: string; loaderId?: string; url?: string; name?: string };
  childFrames?: RawFrameTreeNode[];
}

function sessionsAlive(ctx: PageContext, frames: AxFrame[]): boolean {
  const alive = new Set(ctx.childSessions().map((child) => child.sessionId));
  return frames.every((frame) => !frame.sessionId || alive.has(frame.sessionId));
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

/** 记录 AxNode 所属 OOPIF sessionId，避免直接暴露内部字段到 IPC DTO。 */
const nodeSessions = new WeakMap<AxNode, string>();

export function tagAxNodeSession(node: AxNode, sessionId: string | undefined): void {
  if (sessionId) nodeSessions.set(node, sessionId);
}

export function sessionOfAxNode(node: AxNode): string | undefined {
  return nodeSessions.get(node);
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
  frame: Pick<AxFrame, 'frameId' | 'loaderId' | 'sessionId'>,
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
        const item: AxNode = {
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
        if (frame.sessionId) nodeSessions.set(item, frame.sessionId);
        return item;
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

      const axItem: AxNode = {
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
      };
      if (frame.sessionId) nodeSessions.set(axItem, frame.sessionId);
      out.push(axItem);
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
