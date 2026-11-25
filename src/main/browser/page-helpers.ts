/**
 * 页面级小工具：CDP 节点换算、dialog 守卫、收据、动作超时。
 *
 * 放在这里而不是 controller 里，是因为 waits / actions / escape 都要用，
 * 谁 import 谁都会形成环。都是薄函数，逻辑和以前一字不差。
 */
import type { ActionReceipt } from '../../shared/types.ts';
import type { PageContext, PendingSink } from './ctx.ts';
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

export function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * 解析目标：backendNodeId + 它在哪个会话里。
 *
 * 跨源 iframe 的元素属于**另一个渲染进程**，它的命令必须发到它自己的子会话；
 * 拿它的 backendNodeId 去主会话查**不会报错**，而是静默命中主会话里的无关元素
 * （`backendNodeId` 只在同一个 renderer 内唯一，实测点到过 x=1445 的假坐标）。
 * 所以「会话」必须和目标一起解析出来，后面每一步都带着它走。
 */
export async function resolveTarget(
  ctx: PageContext,
  target: Parameters<PageContext['backendIdFor']>[0],
): Promise<{ backendNodeId: number; sessionId?: string }> {
  const backendNodeId = await ctx.backendIdFor(target);
  // 不吞 frameOf 的错：它只会在「跨源子会话刚被换掉」时抛 NODE_DETACHED，
  // 那个错要往上走，让动作循环重新解析目标（吞掉就会退回主会话、静默点到别的元素）
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
      // `fn` 是 `(el) => …` 形式的源码。callFunctionOn **不传参数**，节点只在 `this` 上，
      // 所以必须显式把 `this` 喂进去；直接当 functionDeclaration 发的话 `el` 是 undefined。
      functionDeclaration: `function () { return (${fn})(this); }`,
      returnByValue: true,
      awaitPromise: true,
    });
    // 不检查 exceptionDetails 会把「页面里抛错」变成「返回 undefined」——静默失败最难查
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
    // 光说「有个 dialog」不够：agent 需要知道下一步敲哪条命令
    throw err(
      'DIALOG_OPEN',
      `页面开着 ${d.type} 对话框：「${d.message.slice(0, 120)}」。后续所有输入命令都会挂起，先处理它：` +
        'acceptDialog（确认）/ dismissDialog（取消）/ events（看详情）',
    );
  }
}

export function receipt(ctx: PageContext, since: number): ActionReceipt {
  return ctx.pending.receiptSince(since);
}

/**
 * 等「本次动作触发的」导航（对标 Playwright 的 SignalBarrier）。
 *
 * 不再轮询 URL：轮询会把无关导航算成自己的、也只认 URL 变化（SPA 里 `history.pushState`
 * 之后 URL 变了但页面没换）。这里监听原生导航事件，并分两段：
 * 1. 300ms 内没有新导航开始 → `none`（不报错，只是收据里告诉 agent「没跳转」）；
 * 2. 已经开始 → 等到提交（commit），最长 `timeoutMs`。
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
 * 先滚进视口。
 *
 * 顺序很重要：先滚再检查 actionability，否则 `display:none` 之类的元素会在
 * `DOM.getBoxModel` 上抛出没有错误码的内部错误（agent 看不出原因）。
 */
export async function scrollIntoView(ctx: PageContext, backendNodeId: number): Promise<void> {
  const sessionId = (await ctx.frameOf(backendNodeId))?.sessionId;
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
  await ctx.sendOn(sessionId, 'DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
}

/**
 * 元素布局盒中心 → **主 frame 视口**坐标。
 *
 * **每次调用都自己解析 nodeId**：`DOM.getDocument` 会让之前的 nodeId 全部失效，
 * 拿别的函数返回的 nodeId 来用会稳定拿到空盒模型（实测）。
 * 没有布局盒（display:none / 零尺寸）给可重试的错误码，而不是内部错误。
 *
 * 跨源 iframe 里的元素要再加一次 owner iframe 的偏移（见 `frameOffsetFor`）。
 */
export async function boxCenter(
  ctx: PageContext,
  backendNodeId: number,
  position?: { x: number; y: number },
  sessionId?: string,
): Promise<{ x: number; y: number }> {
  const rect = await boxRect(ctx, backendNodeId, sessionId);
  if (position) {
    // 元素内偏移
    return { x: rect.x + position.x, y: rect.y + position.y };
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** 元素的布局盒（**主 frame 视口**坐标）。跨源 iframe 里的元素已经加过 owner 偏移。 */
export async function boxRect(
  ctx: PageContext,
  backendNodeId: number,
  sessionId?: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
  const { model } = await ctx
    .sendOn<{ model: { content: number[] } | null }>(sessionId, 'DOM.getBoxModel', { nodeId })
    .catch(() => ({ model: null }));
  if (!model?.content || model.content.length < 8) {
    throw err('NOT_ACTIONABLE', '元素没有布局盒（display:none 或零尺寸）');
  }
  const [x1, y1, , , x3, y3] = model.content;
  const offset = sessionId ? await frameOffsetFor(ctx, sessionId) : { x: 0, y: 0 };
  return { x: x1 + offset.x, y: y1 + offset.y, width: x3 - x1, height: y3 - y1 };
}

/**
 * 跨源 frame 的视口原点在主 frame 视口里的位置。
 *
 * 子会话的盒模型坐标是**子 frame 自己视口**里的，直接当主 frame 坐标用会点到 iframe 外面
 * （实测：算出来 x=562，而 iframe 盒子只有 x∈[82.6, 506.6]）。偏移取主会话里 owner iframe
 * 元素的**内容盒左上角**——那正好是子 frame 的视口原点（border / padding 已经扣掉）。
 */
async function frameOffsetFor(ctx: PageContext, sessionId: string): Promise<{ x: number; y: number }> {
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
  return { x: content[0], y: content[1] };
}

/**
 * 主会话里 frameId 对应的那个 iframe 元素。
 *
 * 认的是 `DOM.describeNode` 回来的 `frameId`——**不能**拿 `Target.attachedToTarget`
 * 的 `targetId` 比，那两个 id 不是一回事（实测踩过）。
 */
async function ownerIframeOf(ctx: PageContext, frameId: string): Promise<number | undefined> {
  const frames = await readAxFrames(ctx).catch(() => []);
  for (const frame of frames) {
    if (frame.sessionId) continue; // 只看主会话里的 iframe 元素
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

/** 高亮配色：比 DevTools 默认更显眼一点——它是画给**人**看的，不是给开发者看的。 */
const HIGHLIGHT = { r: 255, g: 92, b: 92, a: 0.35 };

/**
 * 把元素高亮出来（`Overlay` 域），返回它在主 frame 视口里的矩形。
 *
 * 这是**产品能力**不是对齐：warren 的窗口是「人机同视」的，agent 动手前高亮一下，
 * 人就知道它要操作哪里（Playwright 的 highlight 是给开发者看的）。
 * 不改 DOM、不加全局变量，所以在被控页面里看不见痕迹（V10 那条不变量仍然成立）。
 *
 * 跨源 iframe 里的元素走 `highlightRect`：子会话的 `highlightNode` 画不进主 frame 的 overlay，
 * 而我们的坐标本来就已经换算到主 frame 视口了。
 */
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

/**
 * 诊断：目标元素的点击点，以及「页面自己算出来的」那个点。
 *
 * 存在的理由：跨源 iframe 的坐标换算**没法靠人眼看出对不对**——点错了不报错
 * （这是 AGENTS 已知问题第 8 条那一类），而输入类命令又要求窗口在前台。
 * 这里把两个点并排返回，差多少一眼就看到，不需要真的点。
 */
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

  // 真值：owner iframe 的内容盒原点（父 frame 视口）+ 子 frame 里元素自己的 getBoundingClientRect
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
