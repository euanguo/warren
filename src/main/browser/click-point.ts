/**
 * 精准多边形点击点计算 + CDP 级命中归属检测。
 *
 * 为什么不能只用 `DOM.getBoxModel` 外接矩形中心：
 * 1. 折行内联链接（`<a>` 跨两行）的外接矩形中心常常落在空白处；
 * 2. CSS transform 旋转/倾斜元素的外接矩形中心可能偏离真实多边形；
 * 3. `document.elementFromPoint` 可被页面脚本劫持且穿透不了 Closed Shadow DOM，
 *    而 CDP `DOM.getNodeForLocation` 在浏览器引擎侧直接做命中测试。
 *
 * 几何算法为纯函数，可零依赖单测。
 */
import type { PageContext } from './ctx.ts';
import { RELATION_CHECK_JS } from './dom-scripts.ts';
import { richErr } from './errors.ts';
import { evalOnNode, nodeIdFor } from './page-helpers.ts';

export interface Point2D {
  x: number;
  y: number;
}

/** CDP `Quad` 为 8 个数字：`[x1, y1, x2, y2, x3, y3, x4, y4]`。 */
export type Quad = readonly number[];

/** 用鞋带公式计算任意四边形面积（像素²）。 */
export function quadArea(quad: Quad): number {
  if (quad.length < 8) return 0;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const x1 = quad[i * 2]!;
    const y1 = quad[i * 2 + 1]!;
    const x2 = quad[((i + 1) % 4) * 2]!;
    const y2 = quad[((i + 1) % 4) * 2 + 1]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** 四边形四顶点均值重心。 */
export function quadCenter(quad: Quad): Point2D {
  return {
    x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
    y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
  };
}

/** 从多个内容多边形（如多行折行链接）中挑出面积最大且有效的那个。 */
export function largestQuad(quads: readonly Quad[]): Quad | null {
  let best: Quad | null = null;
  let bestArea = 0;
  for (const q of quads) {
    if (q.length < 8) continue;
    const area = quadArea(q);
    if (area > bestArea) {
      bestArea = area;
      best = q;
    }
  }
  return bestArea > 0 ? best : null;
}

/** 判断点 `(px, py)` 是否落在四边形内部（射线法，支持凹凸四边形）。 */
export function isPointInsideQuad(px: number, py: number, quad: Quad): boolean {
  if (quad.length < 8) return false;
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = quad[i * 2]!;
    const yi = quad[i * 2 + 1]!;
    const xj = quad[j * 2]!;
    const yj = quad[j * 2 + 1]!;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * 在四边形内寻找一个尽量靠中心、且取整后仍在多边形内的点击坐标。
 * 窄元素或细斜条若重心取整越界，则尝试浮点重心与边中点内缩候选，避免四舍五入落到元素外。
 */
export function findIntegerPointInsideQuad(quad: Quad): Point2D {
  const center = quadCenter(quad);
  const rounded = { x: Math.round(center.x), y: Math.round(center.y) };
  if (isPointInsideQuad(rounded.x, rounded.y, quad)) return rounded;

  const candidates: Point2D[] = [
    { x: Math.floor(center.x), y: Math.floor(center.y) },
    { x: Math.ceil(center.x), y: Math.floor(center.y) },
    { x: Math.floor(center.x), y: Math.ceil(center.y) },
    { x: Math.ceil(center.x), y: Math.ceil(center.y) },
  ];
  for (let i = 0; i < 4; i++) {
    const vx = quad[i * 2]!;
    const vy = quad[i * 2 + 1]!;
    // 从顶点向重心推进 25% 和 50%
    candidates.push(
      { x: Math.round((vx + center.x) / 2), y: Math.round((vy + center.y) / 2) },
      { x: Math.round(vx * 0.25 + center.x * 0.75), y: Math.round(vy * 0.25 + center.y * 0.75) },
    );
  }
  for (const pt of candidates) {
    if (isPointInsideQuad(pt.x, pt.y, quad)) return pt;
  }
  // 极细元素（宽/高 < 1px）保留浮点重心
  return center;
}

/**
 * 通过 `DOM.getContentQuads` 获取元素最佳点击点（子 frame 视口局部坐标），
 * 若无 quads 则优雅退回 `DOM.getBoxModel`。
 */
export async function localQuadClickPoint(
  ctx: PageContext,
  backendNodeId: number,
  position?: Point2D,
  sessionId?: string,
): Promise<{ point: Point2D; quad: Quad; rect: { x: number; y: number; width: number; height: number } }> {
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
  const quadsResp = await ctx
    .sendOn<{ quads?: number[][] }>(sessionId, 'DOM.getContentQuads', { backendNodeId })
    .catch(() => null);
  let best = quadsResp?.quads ? largestQuad(quadsResp.quads) : null;
  if (!best) {
    const box = await ctx
      .sendOn<{ model?: { content?: number[] } }>(sessionId, 'DOM.getBoxModel', { nodeId })
      .catch(() => null);
    if (box?.model?.content && box.model.content.length >= 8) {
      best = box.model.content;
    }
  }
  if (!best) {
    throw richErr('NOT_ACTIONABLE', '元素没有布局盒（display:none 或零尺寸）');
  }
  const xs = [best[0]!, best[2]!, best[4]!, best[6]!];
  const ys = [best[1]!, best[3]!, best[5]!, best[7]!];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  const point = position ? { x: minX + position.x, y: minY + position.y } : findIntegerPointInsideQuad(best);
  return { point, quad: best, rect };
}

/** 视口尺寸与滚动原点（`Page.getLayoutMetrics`）。 */
export async function layoutViewport(
  ctx: PageContext,
  sessionId?: string,
): Promise<{ width: number; height: number; pageX: number; pageY: number } | null> {
  const metrics = await ctx
    .sendOn<{
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
      visualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
    }>(sessionId, 'Page.getLayoutMetrics')
    .catch(() => null);
  const vp = metrics?.cssVisualViewport ?? metrics?.visualViewport ?? metrics?.cssLayoutViewport;
  if (!vp || typeof vp.clientWidth !== 'number' || typeof vp.clientHeight !== 'number') return null;
  return {
    width: vp.clientWidth,
    height: vp.clientHeight,
    pageX: vp.pageX ?? 0,
    pageY: vp.pageY ?? 0,
  };
}

/**
 * CDP 浏览器级命中测试：`DOM.getNodeForLocation`。
 * 坐标采用文档/视口整像素（Chromium 在视口内 `x/y` 加上 `pageX/pageY` 命中文档坐标）。
 */
export async function hitTestLocation(
  ctx: PageContext,
  viewportPoint: Point2D,
  sessionId?: string,
): Promise<{ backendNodeId?: number; frameId?: string } | null> {
  const vp = await layoutViewport(ctx, sessionId);
  const docX = Math.round(viewportPoint.x + (vp?.pageX ?? 0));
  const docY = Math.round(viewportPoint.y + (vp?.pageY ?? 0));
  const res = await ctx
    .sendOn<{ backendNodeId?: number; frameId?: string }>(sessionId, 'DOM.getNodeForLocation', {
      x: docX,
      y: docY,
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: true,
    })
    .catch(() => null);
  return res;
}

/** CDP 命中测试归属判定结果。 */
export type HitAcceptanceResult = 'accepted' | 'blocked' | 'unresolvable';

/**
 * 用 CDP `Runtime.callFunctionOn` 比较两个 `backendNodeId` 是否构成合法点击归属关系。
 *
 * 当命中的节点无法解析为 JS 对象（常见于 FontAwesome 图标的 `::before`/`::after` 伪元素或
 * UA Shadow DOM 伪节点）时，返回 `'unresolvable'` 而非 `'blocked'`，让调用方优雅回退到已穿透
 * Open Shadow DOM 的 `elementFromPoint` 校验，避免误报 `TARGET_OCCLUDED` 的同时保留对真实遮挡层的拦截。
 */
export async function evaluateHitAcceptance(
  ctx: PageContext,
  targetBackendId: number,
  hitBackendId: number,
  sessionId?: string,
): Promise<HitAcceptanceResult> {
  if (targetBackendId === hitBackendId) return 'accepted';
  const [targetObj, hitObj] = await Promise.all([
    ctx
      .sendOn<{ object?: { objectId?: string } }>(sessionId, 'DOM.resolveNode', { backendNodeId: targetBackendId })
      .catch(() => null),
    ctx
      .sendOn<{ object?: { objectId?: string } }>(sessionId, 'DOM.resolveNode', { backendNodeId: hitBackendId })
      .catch(() => null),
  ]);
  const tId = targetObj?.object?.objectId;
  const hId = hitObj?.object?.objectId;
  if (!tId || !hId) {
    if (tId) await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: tId }).catch(() => {});
    if (hId) await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: hId }).catch(() => {});
    return 'unresolvable';
  }
  try {
    const r = await ctx.sendOn<{ result?: { value?: unknown } }>(sessionId, 'Runtime.callFunctionOn', {
      objectId: tId,
      functionDeclaration: `function(hit) { return (${RELATION_CHECK_JS})(this, hit); }`,
      arguments: [{ objectId: hId }],
      returnByValue: true,
    });
    if (r?.result?.value === true) return 'accepted';
    // Chromium 在部分 Shadow DOM 图标按钮（如 FontAwesome i::before）上会为伪元素返回 objectId，
    // 但在 JS 侧它不是标准 DOM 树节点，导致 RELATION_CHECK_JS 返回 false。
    // 仅在拒绝分支做一次 DOM.describeNode：若是伪元素则判 unresolvable，交给穿透 Shadow DOM 的 snapshot.hit 裁决。
    const described = await ctx
      .sendOn<{ node?: { pseudoType?: string } }>(sessionId, 'DOM.describeNode', { backendNodeId: hitBackendId })
      .catch(() => null);
    if (described?.node?.pseudoType) return 'unresolvable';
    return 'blocked';
  } catch {
    return 'unresolvable';
  } finally {
    await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: tId }).catch(() => {});
    await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: hId }).catch(() => {});
  }
}

/** 用 CDP `Runtime.callFunctionOn` 比较两个 `backendNodeId` 是否构成合法点击归属关系。 */
export async function isHitAcceptable(
  ctx: PageContext,
  targetBackendId: number,
  hitBackendId: number,
  sessionId?: string,
): Promise<boolean> {
  return (await evaluateHitAcceptance(ctx, targetBackendId, hitBackendId, sessionId)) === 'accepted';
}

/** 获取某个 `backendNodeId` 的紧凑标签描述（防 DOM Clobbering，伪元素退回 `DOM.describeNode`）。 */
export async function describeDomNode(ctx: PageContext, backendNodeId: number, sessionId?: string): Promise<string> {
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId).catch(() => 0);
  if (nodeId) {
    const desc = await evalOnNode(
      ctx,
      nodeId,
      `(el) => {
        if (!el || el.nodeType !== 1) return '';
        let tag = '';
        try { tag = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName').get.call(el).toLowerCase(); } catch { tag = 'element'; }
        const id = typeof el.getAttribute === 'function' ? el.getAttribute('id') : '';
        const cls = typeof el.getAttribute === 'function' ? (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.') : '';
        return tag + (id ? '#' + id : '') + (cls ? '.' + cls : '');
      }`,
      sessionId,
    ).catch(() => null);
    if (typeof desc === 'string' && desc) return desc;
  }
  const described = await ctx
    .sendOn<{ node?: { localName?: string; nodeName?: string; pseudoType?: string } }>(sessionId, 'DOM.describeNode', {
      backendNodeId,
    })
    .catch(() => null);
  const n = described?.node;
  if (n?.pseudoType) return `::${n.pseudoType}`;
  const tag = (n?.localName || n?.nodeName || '').toLowerCase();
  return tag && tag !== '#text' ? tag : '未知元素';
}
