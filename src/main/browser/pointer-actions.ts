/**
 * 指针类动作：click / dblclick / hover / drag / dropFiles。
 */
import type { ActionReceipt, ClickOptions, DragOptions, NavigationReceipt, TargetInput } from '../../shared/types.ts';
import type { PageContext } from './ctx.ts';
import { checkActionable, isVisibleFloatingFlyout, requiredStates, runAction } from './actionability.ts';
import { dispatchMouseClick, emitVisualAction, moveAlongPath, tname } from './actions.ts';
import { richErr } from './errors.ts';
import { isMac, mouseButtonParams } from './input.ts';
import { boxCenter, boxPointAndRect, boxRect } from './locator.ts';
import { heldModifiers, lastMouseOf } from './mouse-state.ts';
import {
  assertNoDialog,
  evalOnNode,
  nodeIdFor,
  resolveTarget,
  scrollIntoView,
  waitForNavigation,
} from './page-helpers.ts';
import { checkInputFiles } from './policy.ts';

export async function click(
  ctx: PageContext,
  target: TargetInput,
  opts: ClickOptions = {},
): Promise<{ x: number; y: number; url: string; navigation: NavigationReceipt } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  return runAction({
    name: `click ${opts.label ?? tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      // Portal 浮层菜单项（Radix/Base UI/MUI）已在视口内时跳过滚动，防止滚屏触发菜单关闭
      const skipScroll = retry === 0 && (await isVisibleFloatingFlyout(ctx, backendNodeId, sessionId));
      if (!skipScroll) await scrollIntoView(ctx, backendNodeId, retry, sessionId);
      await checkActionable(
        ctx,
        backendNodeId,
        requiredStates(opts.clickCount === 2 ? 'dblclick' : 'click'),
        sessionId,
      );
      const { x, y, rect } = await boxPointAndRect(ctx, backendNodeId, opts.position, sessionId);
      emitVisualAction(ctx, 'click', x, y, rect, opts.label ?? tname(target));
      const urlBefore = ctx.wc.getURL();
      const navigated = opts.noWaitAfter
        ? Promise.resolve<NavigationReceipt>('none')
        : waitForNavigation(ctx, urlBefore, opts.navigationTimeoutMs ?? 15_000);
      const { button, buttons } = mouseButtonParams(opts.button ?? 'left');
      const clickCount = opts.clickCount ?? 1;
      const modifiers = heldModifiers(ctx.wc) | (opts.newTab ? (isMac() ? 4 : 2) : 0);

      await dispatchMouseClick(
        ctx,
        { x, y },
        {
          button,
          buttons,
          clickCount,
          modifiers,
          delay: opts.delay,
          humanize: opts.humanize,
        },
      );
      if (opts.label) ctx.record('browser.action', `${opts.label} @${x | 0},${y | 0}`);

      const navigation = await navigated;
      return { x, y, url: ctx.wc.getURL(), navigation, ...ctx.pending.receiptSince(since) };
    },
  });
}

/**
 * 真实双击状态机：`Move → Press(1) → Release(1) → Press(2) → Release(2)`。
 * 只发 `clickCount: 2` 会漏掉第一次 click 序列，很多编辑器/表格的双击激活逻辑不认。
 */
export async function dblclick(
  ctx: PageContext,
  target: TargetInput,
  opts: ClickOptions = {},
): Promise<{ x: number; y: number; url: string; navigation: NavigationReceipt } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  return runAction({
    name: `dblclick ${opts.label ?? tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      const skipScroll = retry === 0 && (await isVisibleFloatingFlyout(ctx, backendNodeId, sessionId));
      if (!skipScroll) await scrollIntoView(ctx, backendNodeId, retry, sessionId);
      await checkActionable(ctx, backendNodeId, requiredStates('dblclick'), sessionId);
      const { x, y } = await boxCenter(ctx, backendNodeId, opts.position, sessionId);
      const urlBefore = ctx.wc.getURL();
      const navigated = opts.noWaitAfter
        ? Promise.resolve<NavigationReceipt>('none')
        : waitForNavigation(ctx, urlBefore, opts.navigationTimeoutMs ?? 15_000);
      const { button, buttons } = mouseButtonParams(opts.button ?? 'left');
      const modifiers = heldModifiers(ctx.wc);

      await moveAlongPath(ctx, { x, y }, opts.humanize);
      for (const clickCount of [1, 2]) {
        await dispatchMouseClick(
          ctx,
          { x, y },
          { move: false, button, buttons, clickCount, modifiers, delay: opts.delay },
        );
        if (ctx.pending.dialogOpen()) break;
      }
      if (opts.label) ctx.record('browser.action', `双击 ${opts.label} @${x | 0},${y | 0}`);
      const navigation = await navigated;
      return { x, y, url: ctx.wc.getURL(), navigation, ...ctx.pending.receiptSince(since) };
    },
  });
}

export async function hover(
  ctx: PageContext,
  target: TargetInput,
  opts: ClickOptions = {},
): Promise<{ x: number; y: number } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  return runAction({
    name: `hover ${opts.label ?? tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      const skipScroll = retry === 0 && (await isVisibleFloatingFlyout(ctx, backendNodeId, sessionId));
      if (!skipScroll) await scrollIntoView(ctx, backendNodeId, retry, sessionId);
      await checkActionable(ctx, backendNodeId, requiredStates('hover'), sessionId);
      const { x, y, rect } = await boxPointAndRect(ctx, backendNodeId, opts.position, sessionId);
      emitVisualAction(ctx, 'hover', x, y, rect, opts.label ?? tname(target));
      await moveAlongPath(ctx, { x, y }, opts.humanize);
      if (opts.label) ctx.record('browser.action', `悬停 ${opts.label} @${x | 0},${y | 0}`);
      return { x, y, ...ctx.pending.receiptSince(since) };
    },
  });
}

export async function drag(
  ctx: PageContext,
  source: TargetInput,
  target: TargetInput,
  opts: DragOptions = {},
): Promise<{ ok: true; placement: string; html5Dispatched?: boolean } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  const placement = opts.placement ?? 'center';
  return runAction({
    name: `drag ${tname(source)} → ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const from = await resolveTarget(ctx, source);
      const to = await resolveTarget(ctx, target);
      const sId = from.backendNodeId;
      const tId = to.backendNodeId;
      await scrollIntoView(ctx, sId, retry, from.sessionId);
      await scrollIntoView(ctx, tId, retry, to.sessionId);
      await checkActionable(ctx, sId, requiredStates('drag'), from.sessionId);
      await checkActionable(ctx, tId, requiredStates('drag'), to.sessionId);
      const s = await boxCenter(ctx, sId, undefined, from.sessionId);
      const tRect = await boxRect(ctx, tId, to.sessionId);
      const t = {
        x: tRect.x + tRect.width / 2,
        y:
          placement === 'before'
            ? tRect.y + Math.max(2, tRect.height * 0.15)
            : placement === 'after'
              ? tRect.y + Math.min(tRect.height - 2, tRect.height * 0.85)
              : tRect.y + tRect.height / 2,
      };
      const steps = Math.max(2, opts.steps ?? 12);
      const { button, buttons } = mouseButtonParams(opts.button ?? 'left');
      await ctx.sendInput('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: s.x,
        y: s.y,
        buttons: 0,
        pointerType: 'mouse',
      });
      await ctx.sendInput('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: s.x,
        y: s.y,
        button,
        buttons,
        clickCount: 1,
        pointerType: 'mouse',
      });
      for (let i = 1; i <= steps; i++) {
        const x = s.x + ((t.x - s.x) * i) / steps;
        const y = s.y + ((t.y - s.y) * i) / steps;
        await ctx.sendInput('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
          buttons,
          pointerType: 'mouse',
        });
      }
      await ctx.sendInput('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: t.x,
        y: t.y,
        button,
        buttons: 0,
        clickCount: 1,
        pointerType: 'mouse',
      });
      const lastMouse = lastMouseOf(ctx.wc);
      lastMouse.x = t.x;
      lastMouse.y = t.y;

      // HTML5 draggable 降级：若源元素显式 draggable="true" 且同会话，补派标准 DragEvent 序列
      let html5Dispatched = false;
      if (from.sessionId === to.sessionId) {
        const [sObj, tObj] = await Promise.all([
          ctx
            .sendOn<{ object?: { objectId?: string } }>(from.sessionId, 'DOM.resolveNode', { backendNodeId: sId })
            .catch(() => null),
          ctx
            .sendOn<{ object?: { objectId?: string } }>(to.sessionId, 'DOM.resolveNode', { backendNodeId: tId })
            .catch(() => null),
        ]);
        const sObjId = sObj?.object?.objectId;
        const tObjId = tObj?.object?.objectId;
        if (sObjId && tObjId) {
          try {
            const dispatched = await ctx
              .sendOn<{ result?: { value?: boolean } }>(from.sessionId, 'Runtime.callFunctionOn', {
                objectId: sObjId,
                functionDeclaration: `function(dest, sx, sy, tx, ty) {
                  if (!(this instanceof HTMLElement) || !this.draggable) return false;
                  const dt = new DataTransfer();
                  const optsStart = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: sx, clientY: sy };
                  const optsEnd = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tx, clientY: ty };
                  this.dispatchEvent(new DragEvent('dragstart', optsStart));
                  dest.dispatchEvent(new DragEvent('dragenter', optsEnd));
                  dest.dispatchEvent(new DragEvent('dragover', optsEnd));
                  dest.dispatchEvent(new DragEvent('drop', optsEnd));
                  this.dispatchEvent(new DragEvent('dragend', optsEnd));
                  return true;
                }`,
                arguments: [{ objectId: tObjId }, { value: s.x }, { value: s.y }, { value: t.x }, { value: t.y }],
                returnByValue: true,
              })
              .catch(() => null);
            html5Dispatched = dispatched?.result?.value === true;
          } finally {
            await ctx.sendOn(from.sessionId, 'Runtime.releaseObject', { objectId: sObjId }).catch(() => {});
            await ctx.sendOn(to.sessionId, 'Runtime.releaseObject', { objectId: tObjId }).catch(() => {});
          }
        }
      }

      return {
        ok: true,
        placement,
        ...(html5Dispatched ? { html5Dispatched } : {}),
        ...ctx.pending.receiptSince(since),
      };
    },
  });
}

/**
 * 外部文件拖放至目标区域（如无 `<input type="file">` 的纯拖放上传区）。
 * 复用 `checkInputFiles` 安全路径护栏，并限制单文件 ≤ 20MB 防内存膨胀。
 */
export async function dropFiles(
  ctx: PageContext,
  target: TargetInput,
  paths: string | string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; files: string[] } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  const list = checkInputFiles(paths);
  const { statSync, readFileSync } = await import('node:fs');
  const pathMod = await import('node:path');
  const payloads: Array<{ name: string; base64: string; mime: string }> = [];
  for (const p of list) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      throw richErr('PATH_DENIED', `文件不存在: ${p}`);
    }
    if (!st.isFile()) throw richErr('PATH_DENIED', `不是文件: ${p}`);
    if (st.size > 20 * 1024 * 1024) throw richErr('BAD_REQUEST', `拖放文件超过 20MB 上限: ${p}`);
    const ext = pathMod.extname(p).toLowerCase();
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.pdf'
            ? 'application/pdf'
            : ext === '.json'
              ? 'application/json'
              : ext === '.csv'
                ? 'text/csv'
                : ext === '.txt' || ext === '.md'
                  ? 'text/plain'
                  : 'application/octet-stream';
    payloads.push({ name: pathMod.basename(p), base64: readFileSync(p).toString('base64'), mime });
  }
  return runAction({
    name: `drop ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      await scrollIntoView(ctx, backendNodeId, retry, sessionId);
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      await evalOnNode(
        ctx,
        nodeId,
        `(el) => {
          const items = ${JSON.stringify(payloads)};
          const dt = new DataTransfer();
          for (const item of items) {
            const bin = atob(item.base64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            dt.items.add(new File([arr], item.name, { type: item.mime }));
          }
          const r = el.getBoundingClientRect();
          const base = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
          el.dispatchEvent(new DragEvent('dragenter', base));
          el.dispatchEvent(new DragEvent('dragover', base));
          el.dispatchEvent(new DragEvent('drop', base));
          return true;
        }`,
        sessionId,
      );
      return { ok: true, files: list, ...ctx.pending.receiptSince(since) };
    },
  });
}
