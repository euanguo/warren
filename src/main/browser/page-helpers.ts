/**
 * 页面级小工具：CDP 节点换算、dialog 守卫、收据、动作超时、Sticky 四态滚动与 AX 遮挡描述。
 */
import type { ActionReceipt } from '../../shared/types.ts';
import type { PageContext, PendingSink } from './ctx.ts';
import { richErr } from './errors.ts';

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
  const resolved = ctx.resolveTarget
    ? await ctx.resolveTarget(target)
    : { backendNodeId: await ctx.backendIdFor(target) };
  const backendNodeId = resolved.backendNodeId;
  const sessionId = resolved.sessionId ?? (await ctx.frameOf(backendNodeId))?.sessionId;
  if (typeof target === 'string' && /^(@\d+|ref=\d+)$/.test(target.trim())) {
    const node = await ctx
      .sendOn<{ node?: { nodeType?: number; nodeName?: string } }>(sessionId, 'DOM.describeNode', { backendNodeId })
      .catch(() => null);
    if (node?.node?.nodeType !== 1) {
      throw richErr(
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
  if (!nodeId) throw richErr('TARGET_NOT_FOUND', 'target is not attached to the DOM');
  return nodeId;
}

/** 在某个节点上跑一段 `(el, ...args) => …` 源码。节点只在 `this` 上。 */
export async function evalOnNode(
  ctx: PageContext,
  nodeId: number,
  fn: string,
  sessionId?: string,
  args: unknown[] = [],
): Promise<unknown> {
  const resolved = await ctx
    .sendOn<{ object: { objectId?: string } }>(sessionId, 'DOM.resolveNode', { nodeId })
    .catch(() => null);
  const objectId = resolved?.object?.objectId;
  if (!objectId) throw richErr('TARGET_NOT_FOUND', 'resolveNode 失败');
  try {
    const r = await ctx.sendOn<{
      result: { value: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(sessionId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () { return (${fn}).apply(null, [this, ...arguments]); }`,
      ...(args.length > 0 ? { arguments: args.map((value) => ({ value })) } : {}),
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown';
      throw richErr('BAD_REQUEST', `页面内求值抛错: ${String(detail).slice(0, 200)}`);
    }
    return r.result?.value;
  } finally {
    await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

/** 有未处理的 dialog 时后续命令会被渲染进程挂住，所以这些命令开头先拦。 */
export function assertNoDialog(ctx: PageContext): void {
  const d = ctx.pending.dialogOpen();
  if (d) {
    throw richErr(
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

export async function clearHighlight(ctx: PageContext): Promise<void> {
  await ctx.send('Overlay.hideHighlight').catch(() => {});
}

/** 页面内抛错的摘要。CDP 的 `text` 常常只是 "Uncaught"，真正的信息在 `exception.description`。 */
export function pageError(details: { text?: string; exception?: { description?: string } }): string {
  return String(details.exception?.description ?? details.text ?? 'unknown').slice(0, 300);
}
