/**
 * 页面级小工具：CDP 节点换算、dialog 守卫、收据、动作超时、Sticky 四态滚动与 AX 遮挡描述。
 */
import type { ActionReceipt } from '../../shared/types.ts';
import type { PageContext, PendingSink } from './ctx.ts';
import { describeDomNode, localQuadClickPoint } from './click-point.ts';
import { richErr, type ErrorDetails } from './ops/remedy.ts';
import { readAxFrames } from './snapshot.ts';

/** controller 不注入队列时（单测、老路径）用的空实现。 */
export function emptyPending(): PendingSink {
  const empty: ActionReceipt = {};
  return {
    consumePopup: () => null,
    consumeDownload: () => null,
    dialogOpen: () => null,
    takeDialogEvent: () => null,
    consumeFileChooser: () => null,
    receiptSince: () => empty,
  };
}

/**
 * 动作默认超时：解析目标 → 等 actionable → 执行（含重试）。
 * Playwright 默认 30s，但 `warren exec` 的 RPC 上限是 60s，一段脚本里几个动作就会撞上，
 * agent 看到的会是 RPC 超时而不是动作错误，所以这里压到 5s。
 */
export const ACTION_TIMEOUT_DEFAULT = 5000;

export function err(code: string, message: string, details?: ErrorDetails): Error {
  return richErr(code, message, details);
}

/**
 * 解析目标：backendNodeId + 它在哪个会话里。
 *
 * 跨源 iframe 的元素属于**另一个渲染进程**，它的命令必须发到它自己的子会话；
 * 拿它的 backendNodeId 去主会话查**不会报错**，而是静默命中主会话里的无关元素。
 */
export async function resolveTarget(
  ctx: PageContext,
  target: Parameters<PageContext['backendIdFor']>[0],
): Promise<{ backendNodeId: number; sessionId?: string }> {
  const backendNodeId = await ctx.backendIdFor(target);
  const frame = await ctx.frameOf(backendNodeId);
  const sessionId = frame?.sessionId;
  if (typeof target === 'string' && /^(@\d+|ref=\d+)$/.test(target.trim())) {
    const node = await ctx
      .sendOn<{ node?: { nodeType?: number; nodeName?: string } }>(sessionId, 'DOM.describeNode', { backendNodeId })
      .catch(() => null);
    if (node?.node?.nodeType !== 1) {
      throw err(
        'TARGET_NOT_ACTIONABLE',
        `ref ${target} 指向的是 ${node?.node?.nodeName ?? '非元素节点'}，不是可操作元素；请重新 snapshot 并选用可交互节点`,
      );
    }
  }
  return { backendNodeId, sessionId };
}

/** backendNodeId → nodeId（在它所属的会话里）。DOM 域需要先有文档缓存，否则稳定返回 0（实测）。 */
export async function nodeIdFor(ctx: PageContext, backendNodeId: number, sessionId?: string): Promise<number> {
  await ctx.sendOn(sessionId, 'DOM.getDocument', { depth: 0 });
  const { nodeIds } = await ctx.sendOn<{ nodeIds: number[] }>(sessionId, 'DOM.pushNodesByBackendIdsToFrontend', {
    backendNodeIds: [backendNodeId],
  });
  const nodeId = nodeIds[0];
  if (!nodeId) throw err('TARGET_NOT_FOUND', 'target is not attached to the DOM');
  return nodeId;
}

/** 在某个节点上跑一段 `(el) => …` 源码。`callFunctionOn` 不传参数，节点只在 `this` 上。 */
export async function evalOnNode(ctx: PageContext, nodeId: number, fn: string, sessionId?: string): Promise<unknown> {
  const resolved = await ctx
    .sendOn<{ object: { objectId?: string } }>(sessionId, 'DOM.resolveNode', { nodeId })
    .catch(() => null);
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw err('TARGET_NOT_FOUND', 'resolveNode 失败');
  try {
    const r = await ctx.sendOn<{
      result: { value: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(sessionId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () { return (${fn})(this); }`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown';
      throw err('BAD_REQUEST', `页面内求值抛错: ${String(detail).slice(0, 200)}`);
    }
    return r.result?.value;
  } finally {
    await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

export function peekDialog(
  ctx: PageContext,
): { type: string; message: string; url: string; sessionId?: string } | null {
  return ctx.pending.dialogOpen();
}

/** 有未处理的 dialog 时后续命令会被渲染进程挂住，所以这些命令开头先拦。 */
export function assertNoDialog(ctx: PageContext): void {
  const d = peekDialog(ctx);
  if (d) {
    throw err(
      'DIALOG_OPEN',
      `页面开着 ${d.type} 对话框：「${d.message.slice(0, 120)}」。后续所有输入命令都会挂起，先处理它：` +
        'acceptDialog（确认）/ dismissDialog（取消）/ events（看详情）',
      {
        hint: `页面存在未处理的 ${d.type} 对话框`,
        data: { dialogType: d.type, message: d.message.slice(0, 120) },
      },
    );
  }
}

export function receipt(ctx: PageContext, since: number): ActionReceipt {
  return ctx.pending.receiptSince(since);
}

/**
 * 等「本次动作触发的」导航（对标 Playwright 的 SignalBarrier）。
 */
export function waitForNavigation(
  ctx: PageContext,
  urlBefore: string,
  timeoutMs: number,
): Promise<'none' | 'started' | 'navigated' | 'timeout'> {
  const wc = ctx.wc;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = (result: 'none' | 'started' | 'navigated' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.off('did-start-navigation', onStart as never);
      wc.off('did-navigate', onCommit as never);
      wc.off('did-navigate-in-page', onCommit as never);
      resolve(result);
    };
    const onStart = (_e: unknown, url: string, _inPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame || url === urlBefore) return;
      clearTimeout(timer);
      timer = setTimeout(() => done('timeout'), timeoutMs);
    };
    const onCommit = (_e: unknown, url: string) => {
      if (url !== urlBefore) done('navigated');
    };
    timer = setTimeout(() => done('none'), 300);
    wc.on('did-start-navigation', onStart as never);
    wc.on('did-navigate', onCommit as never);
    wc.on('did-navigate-in-page', onCommit as never);
  });
}

/**
 * 四态滚动对齐轮转（对标 agent-browser / Playwright Sticky Header/Footer 绕行）：
 * - retry=0: 原生 `DOM.scrollIntoViewIfNeeded`（最温和，已在视口内时不乱滚）；
 * - retry=1: `block: 'center', inline: 'center'`（躲开顶部 Sticky Header 和底部 Sticky Footer）；
 * - retry=2: `block: 'end', inline: 'end'`（躲开顶栏固定遮挡）；
 * - retry=3: `block: 'start', inline: 'start'`（躲开底栏固定遮挡）。
 */
export async function scrollIntoView(
  ctx: PageContext,
  backendNodeId: number,
  retry = 0,
  sessionId?: string,
): Promise<void> {
  const sid = sessionId ?? (await ctx.frameOf(backendNodeId).catch(() => undefined))?.sessionId;
  const nodeId = await nodeIdFor(ctx, backendNodeId, sid);
  const mode = retry % 4;
  if (mode === 0) {
    await ctx.sendOn(sid, 'DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
    return;
  }
  const block = mode === 1 ? 'center' : mode === 2 ? 'end' : 'start';
  await evalOnNode(
    ctx,
    nodeId,
    `(el) => { if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: ${JSON.stringify(block)}, inline: 'center', behavior: 'instant' }); }`,
    sid,
  ).catch(async () => {
    await ctx.sendOn(sid, 'DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
  });
}

/**
 * 精准点击坐标（主 frame 视口坐标）。
 * 优先走 `DOM.getContentQuads` 最大多边形内部整点，避开折行链接/旋转元素的外接盒空心陷阱，
 * 并叠加跨源 iframe 偏移。
 */
export async function boxCenter(
  ctx: PageContext,
  backendNodeId: number,
  position?: { x: number; y: number },
  sessionId?: string,
): Promise<{ x: number; y: number }> {
  const { point } = await localQuadClickPoint(ctx, backendNodeId, position, sessionId);
  const offset = sessionId ? await frameOffsetFor(ctx, sessionId) : { x: 0, y: 0 };
  return { x: point.x + offset.x, y: point.y + offset.y };
}

/** 元素的布局盒（主 frame 视口坐标）。跨源 iframe 里的元素已经加过 owner 偏移。 */
export async function boxRect(
  ctx: PageContext,
  backendNodeId: number,
  sessionId?: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const { rect } = await localQuadClickPoint(ctx, backendNodeId, undefined, sessionId);
  const offset = sessionId ? await frameOffsetFor(ctx, sessionId) : { x: 0, y: 0 };
  return { x: rect.x + offset.x, y: rect.y + offset.y, width: rect.width, height: rect.height };
}

/**
 * 用 AX 树将遮挡元素的 `backendNodeId` 翻译成语义描述（如 `dialog "Cookie 设置"`），
 * 拿不到 AX 信息时回退到安全的 DOM 标签/id/class 描述。
 */
export async function describeAxBlocker(ctx: PageContext, backendNodeId: number, sessionId?: string): Promise<string> {
  const partial = await ctx
    .sendOn<{ nodes?: Array<Record<string, unknown>> }>(sessionId, 'Accessibility.getPartialAXTree', {
      backendNodeId,
      fetchRelatives: false,
    })
    .catch(() => null);
  const ax = partial?.nodes?.[0];
  const role = String((ax?.role as { value?: string } | undefined)?.value ?? '').trim();
  const name = String((ax?.name as { value?: string } | undefined)?.value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const domDesc = await describeDomNode(ctx, backendNodeId, sessionId);
  if (role && !/^(generic|none|presentation|StaticText)$/i.test(role)) {
    const clipped = name.length > 60 ? `${name.slice(0, 57)}...` : name;
    return clipped ? `${role} "${clipped}" (<${domDesc}>)` : `${role} (<${domDesc}>)`;
  }
  return `<${domDesc}>`;
}

/**
 * 跨源 frame 的视口原点在主 frame 视口里的位置。
 */
export async function frameOffsetFor(ctx: PageContext, sessionId: string): Promise<{ x: number; y: number }> {
  const child = ctx.childSessions().find((item) => item.sessionId === sessionId);
  if (!child?.frameId) return { x: 0, y: 0 };
  const owner = await ownerIframeOf(ctx, child.frameId);
  if (owner === undefined) return { x: 0, y: 0 };
  const nodeId = await nodeIdFor(ctx, owner);
  const { model } = await ctx
    .send<{ model: { content: number[] } | null }>('DOM.getBoxModel', { nodeId })
    .catch(() => ({ model: null }));
  const content = model?.content;
  if (!content || content.length < 8) return { x: 0, y: 0 };
  return { x: content[0]!, y: content[1]! };
}

/**
 * 主会话里 frameId 对应的那个 iframe 元素。
 */
async function ownerIframeOf(ctx: PageContext, frameId: string): Promise<number | undefined> {
  const frames = await readAxFrames(ctx).catch(() => []);
  for (const frame of frames) {
    if (frame.sessionId) continue;
    for (const node of frame.nodes) {
      const role = (node.role as { value?: string } | undefined)?.value ?? '';
      if (!/^iframe$/i.test(role)) continue;
      const backendNodeId = node.backendDOMNodeId as number | undefined;
      if (typeof backendNodeId !== 'number') continue;
      const desc = await ctx
        .send<{ node?: { frameId?: string } }>('DOM.describeNode', { backendNodeId })
        .catch(() => null);
      if (desc?.node?.frameId === frameId) return backendNodeId;
    }
  }
  return undefined;
}

/** 高亮配色：清爽品牌蓝描边+柔和填充，与表单校验红明确区分。 */
const HIGHLIGHT = { r: 59, g: 130, b: 246, a: 0.24 };

export async function highlightElement(
  ctx: PageContext,
  backendNodeId: number,
  sessionId?: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await boxRect(ctx, backendNodeId, sessionId);
  await ctx.send('Overlay.enable').catch(() => {});
  if (sessionId) {
    await ctx.send('Overlay.highlightRect', {
      ...rect,
      color: HIGHLIGHT,
      outlineColor: { ...HIGHLIGHT, a: 1 },
    });
  } else {
    await ctx.send('Overlay.highlightNode', {
      backendNodeId,
      highlightConfig: {
        contentColor: HIGHLIGHT,
        borderColor: { ...HIGHLIGHT, a: 1 },
        showInfo: false,
      },
    });
  }
  return rect;
}

export async function clearHighlight(ctx: PageContext): Promise<void> {
  await ctx.send('Overlay.hideHighlight').catch(() => {});
}

export async function probePoint(
  ctx: PageContext,
  target: Parameters<PageContext['backendIdFor']>[0],
): Promise<{
  backendNodeId: number;
  sessionId?: string;
  point: { x: number; y: number };
  truth?: { x: number; y: number };
  delta?: { x: number; y: number };
}> {
  const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
  const point = await boxCenter(ctx, backendNodeId, undefined, sessionId);
  if (!sessionId) return { backendNodeId, point };

  const frame = await ctx.frameOf(backendNodeId).catch(() => undefined);
  const owner = frame ? await ownerIframeOf(ctx, frame.frameId) : undefined;
  if (owner === undefined) return { backendNodeId, sessionId, point };
  const ownerNode = await nodeIdFor(ctx, owner);
  const origin = (await evalOnNode(
    ctx,
    ownerNode,
    `(el) => {
       const r = el.getBoundingClientRect();
       const cs = getComputedStyle(el);
       return {
         x: r.left + parseFloat(cs.borderLeftWidth || '0') + parseFloat(cs.paddingLeft || '0'),
         y: r.top + parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.paddingTop || '0'),
       };
     }`,
  )) as { x: number; y: number };
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
  const inner = (await evalOnNode(
    ctx,
    nodeId,
    `(el) => { const r = el.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; }`,
    sessionId,
  )) as { x: number; y: number };
  const truth = { x: origin.x + inner.x, y: origin.y + inner.y };
  return {
    backendNodeId,
    sessionId,
    point,
    truth,
    delta: { x: point.x - truth.x, y: point.y - truth.y },
  };
}

/** 页面内抛错的摘要。CDP 的 `text` 常常只是 "Uncaught"，真正的信息在 `exception.description`。 */
export function pageError(details: { text?: string; exception?: { description?: string } }): string {
  return String(details.exception?.description ?? details.text ?? 'unknown').slice(0, 300);
}
