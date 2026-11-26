/**
 * 动作：click / dblclick / hover / drag / drop / fill / selectOption / check / uncheck /
 * focus / press / setInputFiles，以及弹窗与下载。全部通过 PageContext 工作，不依赖 controller 类。
 */
import type {
  ActionReceipt,
  ClickOptions,
  DownloadStatus,
  DragOptions,
  FillOptions,
  FillWarning,
  NavigationReceipt,
  PressOptions,
  SelectValue,
  TargetInput,
} from '../../shared/types.ts';
import type { PageContext } from './ctx.ts';
import { checkActionable, isVisibleFloatingFlyout, requiredStates, runAction } from './actionability.ts';
import { mousePath, STEP_DELAY_MS, type Point } from './input-synthesis.ts';
import { isMac, keyEvents, mouseButtonParams } from './input.ts';
import {
  assertNoDialog,
  boxCenter,
  boxRect,
  err,
  evalOnNode,
  nodeIdFor,
  peekDialog,
  receipt,
  resolveTarget,
  scrollIntoView,
  waitForNavigation,
} from './page-helpers.ts';
import { checkInputFiles, guardSavePath } from './policy.ts';
import { heldModifiers, lastMouse, takePendingRelease } from './mouse-state.ts';
import { markDialogHandled } from './session.ts';

/** 动作名里带的目标摘要，进错误消息用。 */
function tname(target: TargetInput): string {
  return typeof target === 'string' ? target : JSON.stringify(target).slice(0, 60);
}

/**
 * 是否开启贝塞尔曲线鼠标移动：
 * - 显式传入 `opts.humanize` 时优先听调用方；
 * - 否则仅当 `WARREN_INPUT_PATH=1` 时启用（默认直达，避免后台 tab 多步 mouseMoved 停顿）。
 */
function shouldHumanizeMove(humanize?: boolean): boolean {
  if (humanize !== undefined) return humanize;
  return process.env.WARREN_INPUT_PATH === '1';
}

/** 把鼠标移到目标坐标；按需走拟人化贝塞尔曲线。 */
async function moveAlongPath(ctx: PageContext, to: Point, humanize?: boolean): Promise<void> {
  const points = shouldHumanizeMove(humanize) ? mousePath(lastMouse, to) : [to];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    await ctx.sendInput('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      buttons: 0,
      pointerType: 'mouse',
    });
    if (i < points.length - 1) await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
  }
  lastMouse.x = to.x;
  lastMouse.y = to.y;
}

/** 若上次点击被 JS Dialog 截断留下未闭合的 `mousePressed`，在关闭弹窗后立即补发 `mouseReleased`。 */
async function flushPendingRelease(ctx: PageContext): Promise<void> {
  const pending = takePendingRelease(ctx.wc.id);
  if (!pending) return;
  await ctx
    .send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pending.x,
      y: pending.y,
      button: pending.button,
      buttons: 0,
      clickCount: pending.clickCount,
      pointerType: 'mouse',
    })
    .catch(() => {});
}

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
      const { x, y } = await boxCenter(ctx, backendNodeId, opts.position, sessionId);
      const urlBefore = ctx.wc.getURL();
      const navigated = opts.noWaitAfter
        ? Promise.resolve<NavigationReceipt>('none')
        : waitForNavigation(ctx, urlBefore, opts.navigationTimeoutMs ?? 15_000);
      const { button, buttons } = mouseButtonParams(opts.button ?? 'left');
      const clickCount = opts.clickCount ?? 1;
      const modifiers = heldModifiers() | (opts.newTab ? (isMac() ? 4 : 2) : 0);

      await moveAlongPath(ctx, { x, y }, opts.humanize);
      await ctx.sendInput('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        buttons,
        clickCount,
        modifiers,
        pointerType: 'mouse',
      });
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      await ctx.sendInput('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        buttons: 0,
        clickCount,
        modifiers,
        pointerType: 'mouse',
      });
      if (opts.label) ctx.record('browser.action', `${opts.label} @${x | 0},${y | 0}`);

      const navigation = await navigated;
      return { x, y, url: ctx.wc.getURL(), navigation, ...receipt(ctx, since) };
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
      const modifiers = heldModifiers();

      await moveAlongPath(ctx, { x, y }, opts.humanize);
      for (const count of [1, 2]) {
        await ctx.sendInput('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button,
          buttons,
          clickCount: count,
          modifiers,
          pointerType: 'mouse',
        });
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
        await ctx.sendInput('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button,
          buttons: 0,
          clickCount: count,
          modifiers,
          pointerType: 'mouse',
        });
        if (peekDialog(ctx)) break;
      }
      if (opts.label) ctx.record('browser.action', `双击 ${opts.label} @${x | 0},${y | 0}`);
      const navigation = await navigated;
      return { x, y, url: ctx.wc.getURL(), navigation, ...receipt(ctx, since) };
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
      const { x, y } = await boxCenter(ctx, backendNodeId, opts.position, sessionId);
      await moveAlongPath(ctx, { x, y }, opts.humanize);
      if (opts.label) ctx.record('browser.action', `悬停 ${opts.label} @${x | 0},${y | 0}`);
      return { x, y, ...receipt(ctx, since) };
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

      return { ok: true, placement, ...(html5Dispatched ? { html5Dispatched } : {}), ...receipt(ctx, since) };
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
      throw err('PATH_DENIED', `文件不存在: ${p}`);
    }
    if (!st.isFile()) throw err('PATH_DENIED', `不是文件: ${p}`);
    if (st.size > 20 * 1024 * 1024) throw err('BAD_REQUEST', `拖放文件超过 20MB 上限: ${p}`);
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
      return { ok: true, files: list, ...receipt(ctx, since) };
    },
  });
}

/**
 * 页面内 fill 准备脚本：
 * - 自动从 `<label>` / 单控件包装器解析真实输入控件；
 * - 对 `date/time/color/range` 等使用 `HTMLInputElement.prototype` 原生 setter（兼容 React 受控组件），
 *   并在浏览器拒值时给出精确格式提示；
 * - 对文本输入执行选中，并返回字段元数据（类型/旧值/maxLength/是否为富文本）供分级校验。
 */
function fillPrepareScript(value: string, clearFirst: boolean): string {
  return `(el) => {
  const value = ${JSON.stringify(value)};
  const tagGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
  const safeTag = (n) => {
    try { return n && n.nodeType === 1 ? String(tagGetter ? tagGetter.call(n) : n.tagName).toLowerCase() : ''; }
    catch { return ''; }
  };
  let target = el;
  const initialTag = safeTag(target);
  if (initialTag === 'label' && target.control) {
    target = target.control;
  } else if (initialTag !== 'input' && initialTag !== 'textarea' && !target.isContentEditable) {
    const inner = target.querySelectorAll?.('input:not([type="hidden"]), textarea, [contenteditable=""], [contenteditable="true"]');
    if (inner && inner.length === 1) target = inner[0];
  }
  const tag = safeTag(target);
  const type = tag === 'input' ? String(target.type || 'text').toLowerCase() : tag;
  const isPassword = tag === 'input' && type === 'password';
  const prevValue = 'value' in target ? String(target.value ?? '') : String(target.textContent ?? '');
  const maxLength = typeof target.maxLength === 'number' && target.maxLength > 0 ? target.maxLength : -1;

  if (tag === 'input') {
    const byAssign = ['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week'];
    const byTyping = ['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url'];
    if (!byAssign.includes(type) && !byTyping.includes(type)) {
      return { status: 'error', message: 'input type "' + type + '" 不能 fill' };
    }
    if (type === 'number' && value.trim() !== '' && isNaN(Number(value.trim()))) {
      return { status: 'error', message: 'number 输入框不接受非数字（请传入合法数字）' };
    }
    if (byAssign.includes(type)) {
      const v = type === 'color' ? value.toLowerCase() : value.trim();
      target.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(target, v);
      else target.value = v;
      if (target.value !== v) {
        const formatHints = {
          date: 'YYYY-MM-DD',
          time: 'HH:MM 或 HH:MM:SS',
          'datetime-local': 'YYYY-MM-DDTHH:MM',
          month: 'YYYY-MM',
          week: 'YYYY-Www',
          color: '#rrggbb',
          range: 'min..max 之间的数字',
        };
        return {
          status: 'error',
          message: '页面拒绝了 ' + type + ' 值，请确认格式为 ' + (formatHints[type] || '合法值'),
        };
      }
      target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return { status: 'done', type, isPassword, prevValue, maxLength };
    }
  } else if (tag !== 'textarea' && !target.isContentEditable) {
    return { status: 'error', message: '不是 input/textarea/contenteditable' };
  }

  target.focus();
  let selectedAll = false;
  if (${clearFirst}) {
    if (typeof target.select === 'function') {
      try {
        target.select();
        selectedAll = true;
      } catch {}
    }
    if (!selectedAll && target.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
          selectedAll = true;
        }
      } catch {}
    }
  }
  return {
    status: 'needsinput',
    type,
    isPassword,
    isContentEditable: Boolean(target.isContentEditable),
    selectedAll,
    prevValue: isPassword ? '' : prevValue,
    prevLength: prevValue.length,
    maxLength,
  };
}`;
}

/** 穿透 Shadow DOM 读取当前真正拥有焦点的元素值（兼容 Combobox 弹出层焦点转移）。 */
const ACTIVE_READBACK_JS = `(el) => {
  const deepActive = () => {
    let cur = document.activeElement;
    while (cur && cur.shadowRoot && cur.shadowRoot.activeElement) {
      cur = cur.shadowRoot.activeElement;
    }
    return cur;
  };
  const active = deepActive();
  const readVal = (n) => {
    if (!n) return '';
    return 'value' in n ? String(n.value ?? '') : String(n.textContent ?? '');
  };
  const tagGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
  const safeTag = (n) => {
    try { return n && n.nodeType === 1 ? String(tagGetter ? tagGetter.call(n) : n.tagName).toLowerCase() : ''; }
    catch { return ''; }
  };
  let target = el;
  if (safeTag(target) === 'label' && target.control) target = target.control;
  const moved = Boolean(active && active !== target && (safeTag(active) === 'input' || safeTag(active) === 'textarea' || active.isContentEditable));
  return {
    value: readVal(moved ? active : target),
    targetValue: readVal(target),
    moved,
  };
}`;

export async function fill(
  ctx: PageContext,
  target: TargetInput,
  value: string,
  opts: FillOptions = {},
): Promise<{ ok: true; warning?: FillWarning; focusMoved?: boolean } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  return runAction({
    name: `fill ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      await scrollIntoView(ctx, backendNodeId, retry, sessionId);
      // 跳过直接对 <label> 的 editable 检查：若目标是 label，先放行由准备脚本转绑真实控件
      const isLabelWrapper = await (async () => {
        const nid = await nodeIdFor(ctx, backendNodeId, sessionId).catch(() => 0);
        if (!nid) return false;
        const r = await evalOnNode(
          ctx,
          nid,
          `(el) => {
            const tag = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get?.call(el)?.toLowerCase();
            if (tag === 'label' && el.control) return true;
            if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) {
              const inner = el.querySelectorAll?.('input:not([type="hidden"]), textarea, [contenteditable=""], [contenteditable="true"]');
              return Boolean(inner && inner.length === 1);
            }
            return false;
          }`,
          sessionId,
        ).catch(() => false);
        return r === true;
      })();
      if (!isLabelWrapper) {
        await checkActionable(ctx, backendNodeId, requiredStates('fill'), sessionId);
      }
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      await ctx.sendOn(sessionId, 'DOM.focus', { nodeId }).catch(() => {});

      const clearFirst = opts.clearFirst !== false;
      const outcome = (await evalOnNode(ctx, nodeId, fillPrepareScript(value, clearFirst), sessionId)) as {
        status: 'done' | 'needsinput' | 'error';
        message?: string;
        type?: string;
        isPassword?: boolean;
        isContentEditable?: boolean;
        selectedAll?: boolean;
        prevValue?: string;
        prevLength?: number;
        maxLength?: number;
      } | null;
      if (outcome?.status === 'error') throw err('TARGET_NOT_FILLABLE', outcome.message ?? 'fill 失败');

      if (outcome?.status !== 'done') {
        if (clearFirst) {
          // 对富文本编辑器或未选中成功的控件，走 Chromium 原生 editing command `selectAll` + Backspace
          if (!outcome?.selectedAll || outcome?.isContentEditable) {
            await ctx.sendInput('Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              commands: ['selectAll'],
              key: 'a',
              code: 'KeyA',
              windowsVirtualKeyCode: 65,
              modifiers: isMac() ? 4 : 2,
            });
            await ctx.sendInput('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'a',
              code: 'KeyA',
              windowsVirtualKeyCode: 65,
              modifiers: isMac() ? 4 : 2,
            });
          }
          if (value === '' || (outcome?.prevLength ?? 0) > 0) {
            const [bsDown, bsUp] = keyEvents('Backspace');
            await ctx.sendInput('Input.dispatchKeyEvent', bsDown!);
            await ctx.sendInput('Input.dispatchKeyEvent', bsUp!);
          }
        }
        if (value.length > 0) {
          // 混合输入：前 n-1 字符高速 insertText，最后一个 ASCII 可打印字符走真实 keyDown/keyUp，
          // 以便触发依赖 keydown/keyup 的 autocomplete / combobox / datepicker。
          const lastChar = value[value.length - 1]!;
          const canTailKey = !outcome?.isPassword && /^[\x20-\x7e]$/.test(lastChar);
          if (canTailKey) {
            const prefix = value.slice(0, -1);
            if (prefix) await ctx.sendInput('Input.insertText', { text: prefix });
            const [down, up] = keyEvents(lastChar);
            await ctx.sendInput('Input.dispatchKeyEvent', down!);
            await ctx.sendInput('Input.dispatchKeyEvent', up!);
          } else {
            await ctx.sendInput('Input.insertText', { text: value });
          }
        }
      }

      let warning: FillWarning | undefined;
      let focusMoved = false;
      // 分级回读校验：密码框直接跳过且绝不回显明文
      if (!outcome?.isPassword && outcome?.status !== 'done') {
        const readInfo = (await evalOnNode(ctx, nodeId, ACTIVE_READBACK_JS, sessionId).catch(() => null)) as {
          value?: string;
          targetValue?: string;
          moved?: boolean;
        } | null;
        if (readInfo && typeof readInfo.value === 'string') {
          focusMoved = Boolean(readInfo.moved);
          const actual = readInfo.value;
          const norm = (s: string) =>
            outcome?.type === 'email' || outcome?.isContentEditable ? s.replace(/\s+/g, ' ').trim() : s;
          if (norm(actual) !== norm(value)) {
            const maxLen = outcome?.maxLength ?? -1;
            if (maxLen > 0 && actual === value.slice(0, maxLen)) {
              warning = {
                kind: 'truncated',
                expectedLength: value.length,
                actualLength: actual.length,
                message: `输入达到字段 maxLength=${maxLen} 限制，已截断为 ${actual.length} 字符`,
              };
            } else if (value.length > 0 && actual.length > 0 && actual !== (outcome?.prevValue ?? '')) {
              warning = {
                kind: 'formatted',
                expectedLength: value.length,
                actualLength: actual.length,
                message: `页面已对输入值做格式化改写（期望 ${value.length} 字，读回 ${actual.length} 字）`,
              };
            } else if (value.length > 0 || actual.length > 0) {
              throw err('FILL_UNCONFIRMED', `FILL_UNCONFIRMED 期望 ${value.length} 字，读回 ${actual.length} 字`, {
                hint: '页面可能拦截或吞掉了输入，请检查焦点是否落在自定义组件内或存在前置弹窗',
                data: { expectedLength: value.length, actualLength: actual.length, focusMoved },
              });
            }
          }
        }
      }

      if (opts.submit) {
        const [enterDown, enterUp] = keyEvents('Enter');
        await ctx.sendInput('Input.dispatchKeyEvent', enterDown!);
        await ctx.sendInput('Input.dispatchKeyEvent', enterUp!);
      }

      return {
        ok: true,
        ...(warning ? { warning } : {}),
        ...(focusMoved ? { focusMoved } : {}),
        ...receipt(ctx, since),
      };
    },
  });
}

/**
 * 选择下拉选项：同时支持原生 `<select>`（含 `option.disabled` 校验与 `availableOptions` 反馈）
 * 和现代 SPA 自定义 ARIA `combobox` / `listbox`。
 */
export async function selectOption(
  ctx: PageContext,
  target: TargetInput,
  value: SelectValue,
  opts: { timeoutMs?: number; by?: 'auto' | 'value' | 'label' | 'index' } = {},
): Promise<{ selected: string[]; kind?: 'native' | 'aria' } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  const byMode = opts.by ?? 'auto';
  return runAction({
    name: `selectOption ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      await scrollIntoView(ctx, backendNodeId, retry, sessionId);
      await checkActionable(ctx, backendNodeId, requiredStates('selectOption'), sessionId);
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);

      // 先判定元素是原生 <select> 还是 ARIA combobox/listbox
      const inspect = (await evalOnNode(
        ctx,
        nodeId,
        `(el) => {
          const isNative = el instanceof HTMLSelectElement;
          const role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
          return { isNative, role, isAria: role === 'combobox' || role === 'listbox' || el.getAttribute?.('aria-haspopup') === 'listbox' };
        }`,
        sessionId,
      )) as { isNative: boolean; role: string; isAria: boolean } | null;

      if (inspect?.isNative) {
        const res = (await evalOnNode(
          ctx,
          nodeId,
          `(el) => {
            const norm = ${JSON.stringify(value)};
            const byMode = ${JSON.stringify(byMode)};
            const wants = norm === null ? [] : Array.isArray(norm) ? norm : [norm];
            const available = Array.from(el.options).slice(0, 30).map((o) => ({
              value: o.value,
              label: (o.label || o.text || '').trim(),
              index: o.index,
              disabled: Boolean(o.disabled),
            }));
            const match = (opt, w) => {
              const label = (opt.label || opt.text || '').trim();
              if (typeof w === 'string') {
                if (byMode === 'value') return opt.value === w;
                if (byMode === 'label') return label === w;
                if (byMode === 'index') return String(opt.index) === w;
                return opt.value === w || label === w || opt.text === w;
              }
              if (w && typeof w === 'object') {
                if (w.value !== undefined && opt.value !== w.value) return false;
                if (w.label !== undefined && label !== w.label && opt.text !== w.label) return false;
                if (w.index !== undefined && opt.index !== w.index) return false;
                return true;
              }
              return false;
            };
            if (wants.length === 0) {
              el.value = '';
              el.selectedIndex = -1;
            } else {
              const matched = [];
              for (const opt of el.options) {
                if (wants.some((w) => match(opt, w))) matched.push(opt);
              }
              if (matched.length === 0) {
                return { status: 'not_found', available };
              }
              const disabledHit = matched.find((o) => o.disabled);
              if (disabledHit) {
                return { status: 'disabled', option: { value: disabledHit.value, label: (disabledHit.label || disabledHit.text || '').trim() }, available };
              }
              let first = true;
              for (const opt of el.options) {
                const hit = matched.includes(opt);
                if (el.multiple) opt.selected = hit;
                else if (hit && first) { opt.selected = true; first = false; }
                else if (!el.multiple) opt.selected = false;
              }
            }
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { status: 'ok', selected: Array.from(el.selectedOptions).map((o) => o.value) };
          }`,
          sessionId,
        )) as
          | { status: 'ok'; selected: string[] }
          | { status: 'not_found'; available: Array<Record<string, unknown>> }
          | { status: 'disabled'; option: { value: string; label: string }; available: Array<Record<string, unknown>> };

        if (res.status === 'not_found') {
          throw err('TARGET_NOT_FOUND', `下拉框中找不到匹配选项：${JSON.stringify(value)}`, {
            hint: '请从 availableOptions 中选择存在的 value 或 label',
            data: { availableOptions: res.available },
          });
        }
        if (res.status === 'disabled') {
          throw err('NOT_ACTIONABLE', `选项 "${res.option.label || res.option.value}" 处于 disabled 状态，不可选择`, {
            data: { availableOptions: res.available },
          });
        }
        return { selected: res.selected, kind: 'native', ...receipt(ctx, since) };
      }

      if (inspect?.isAria) {
        // 自定义 ARIA combobox / listbox：展开列表后匹配可见 `[role="option"]` 并点击
        const wantedLabel =
          typeof value === 'string'
            ? value
            : Array.isArray(value)
              ? typeof value[0] === 'string'
                ? value[0]
                : (value[0]?.label ?? value[0]?.value ?? '')
              : (value?.label ?? value?.value ?? '');
        const center = await boxCenter(ctx, backendNodeId, undefined, sessionId);
        if (inspect.role !== 'listbox') {
          await moveAlongPath(ctx, center);
          await ctx.sendInput('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: center.x,
            y: center.y,
            button: 'left',
            buttons: 1,
            clickCount: 1,
            pointerType: 'mouse',
          });
          await ctx.sendInput('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: center.x,
            y: center.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
            pointerType: 'mouse',
          });
          await new Promise((r) => setTimeout(r, 120));
        }
        const ariaOutcome = (await evalOnNode(
          ctx,
          nodeId,
          `(el) => {
            const wanted = ${JSON.stringify(String(wantedLabel ?? '').trim())};
            const wantedLower = wanted.toLowerCase();
            const controlsId = el.getAttribute?.('aria-controls') || el.getAttribute?.('aria-owns');
            const scope = (controlsId && document.getElementById(controlsId)) || (el.getAttribute?.('role') === 'listbox' ? el : document);
            const opts = Array.from(scope.querySelectorAll('[role="option"]')).filter((o) => {
              const r = o.getBoundingClientRect();
              const cs = getComputedStyle(o);
              return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
            });
            const available = opts.slice(0, 30).map((o, idx) => ({
              value: o.getAttribute('data-value') || o.getAttribute('value') || (o.textContent || '').trim(),
              label: (o.textContent || '').trim(),
              index: idx,
              disabled: o.getAttribute('aria-disabled') === 'true',
            }));
            const hit = opts.find((o) => {
              const text = (o.textContent || '').trim();
              const dv = o.getAttribute('data-value') || o.getAttribute('value') || '';
              return text === wanted || dv === wanted || text.toLowerCase() === wantedLower || dv.toLowerCase() === wantedLower;
            }) || opts.find((o) => (o.textContent || '').trim().toLowerCase().includes(wantedLower));
            if (!hit) return { status: 'not_found', available };
            if (hit.getAttribute('aria-disabled') === 'true') {
              return { status: 'disabled', label: (hit.textContent || '').trim(), available };
            }
            hit.scrollIntoView?.({ block: 'nearest' });
            const r = hit.getBoundingClientRect();
            return {
              status: 'click',
              x: r.left + r.width / 2,
              y: r.top + r.height / 2,
              selected: hit.getAttribute('data-value') || (hit.textContent || '').trim(),
            };
          }`,
          sessionId,
        )) as
          | { status: 'click'; x: number; y: number; selected: string }
          | { status: 'not_found'; available: Array<Record<string, unknown>> }
          | { status: 'disabled'; label: string; available: Array<Record<string, unknown>> };

        if (ariaOutcome.status === 'not_found') {
          throw err('TARGET_NOT_FOUND', `ARIA 下拉列表中未找到选项：${wantedLabel}`, {
            hint: '请从 availableOptions 中选择可见的选项文本',
            data: { availableOptions: ariaOutcome.available },
          });
        }
        if (ariaOutcome.status === 'disabled') {
          throw err('NOT_ACTIONABLE', `ARIA 选项 "${ariaOutcome.label}" 处于禁用状态`, {
            data: { availableOptions: ariaOutcome.available },
          });
        }
        await moveAlongPath(ctx, { x: ariaOutcome.x, y: ariaOutcome.y });
        await ctx.sendInput('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: ariaOutcome.x,
          y: ariaOutcome.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          pointerType: 'mouse',
        });
        await ctx.sendInput('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: ariaOutcome.x,
          y: ariaOutcome.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          pointerType: 'mouse',
        });
        return { selected: [ariaOutcome.selected], kind: 'aria', ...receipt(ctx, since) };
      }

      throw err('TARGET_NOT_FILLABLE', `selectOption 失败：目标既不是 <select> 也不是 ARIA combobox/listbox`);
    },
  });
}

/**
 * 幂等勾选 / 取消勾选（checkbox / radio / switch / menuitemcheckbox）。
 * - 状态已符合目标时直接返回 `{ ok: true, changed: false, checked }`，绝不误反选；
 * - radio 不允许 `uncheck`（符合 HTML 规范，报 `NOT_ACTIONABLE`）；
 * - 隐藏的原生 `<input type="checkbox|radio">` 自动尝试点击其关联 `<label>` 或 DOM `.click()`。
 */
export async function setChecked(
  ctx: PageContext,
  target: TargetInput,
  wantChecked: boolean,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; checked: boolean; changed: boolean } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  const action = wantChecked ? 'check' : 'uncheck';
  return runAction({
    name: `${action} ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      const state = (await evalOnNode(
        ctx,
        nodeId,
        `(el) => {
          const tagGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
          const safeTag = (n) => {
            try { return n && n.nodeType === 1 ? String(tagGetter ? tagGetter.call(n) : n.tagName).toLowerCase() : ''; }
            catch { return ''; }
          };
          let ctrl = el;
          if (safeTag(ctrl) === 'label' && ctrl.control) ctrl = ctrl.control;
          const tag = safeTag(ctrl);
          const inputType = tag === 'input' ? String(ctrl.type || '').toLowerCase() : '';
          const role = String(ctrl.getAttribute?.('role') || '').toLowerCase();
          const isCheckable =
            (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) ||
            /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role);
          if (!isCheckable) return { checkable: false };
          const isRadio = inputType === 'radio' || role === 'radio' || role === 'menuitemradio';
          const disabled = Boolean(ctrl.disabled || ctrl.getAttribute?.('aria-disabled') === 'true');
          const checked = tag === 'input' ? Boolean(ctrl.checked) : ctrl.getAttribute?.('aria-checked') === 'true';
          const r = ctrl.getBoundingClientRect();
          const cs = getComputedStyle(ctrl);
          const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
          return { checkable: true, isRadio, disabled, checked, visible };
        }`,
        sessionId,
      )) as {
        checkable: boolean;
        isRadio?: boolean;
        disabled?: boolean;
        checked?: boolean;
        visible?: boolean;
      } | null;

      if (!state?.checkable) {
        throw err('TARGET_NOT_ACTIONABLE', '目标不是 checkbox / radio / switch 控件');
      }
      if (state.disabled) {
        throw err('NOT_ACTIONABLE', '控件处于 disabled 状态，无法切换勾选');
      }
      if (state.isRadio && !wantChecked) {
        throw err('NOT_ACTIONABLE', 'radio 单选框不支持 uncheck，请选择同组其他单选项');
      }
      if (state.checked === wantChecked) {
        return { ok: true, checked: wantChecked, changed: false, ...receipt(ctx, since) };
      }

      if (state.visible) {
        await scrollIntoView(ctx, backendNodeId, retry, sessionId);
        await checkActionable(ctx, backendNodeId, requiredStates(action), sessionId);
        const { x, y } = await boxCenter(ctx, backendNodeId, undefined, sessionId);
        await moveAlongPath(ctx, { x, y });
        await ctx.sendInput('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          pointerType: 'mouse',
        });
        await ctx.sendInput('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          pointerType: 'mouse',
        });
      } else {
        // 隐藏的原生 checkbox（sr-only / opacity:0）：尝试关联 label 点击，否则原生 DOM click
        const postNodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
        await evalOnNode(
          ctx,
          postNodeId,
          `(el) => {
            const ctrl = el.tagName?.toLowerCase() === 'label' && el.control ? el.control : el;
            const lbl = (ctrl.labels && ctrl.labels[0]) || (ctrl.id ? document.querySelector('label[for="' + CSS.escape(ctrl.id) + '"]') : null);
            if (lbl && typeof lbl.click === 'function') lbl.click();
            else if (typeof ctrl.click === 'function') ctrl.click();
          }`,
          sessionId,
        );
      }

      // 验证是否切换成功
      const verifyNodeId = await nodeIdFor(ctx, backendNodeId, sessionId).catch(() => 0);
      const afterChecked = verifyNodeId
        ? await evalOnNode(
            ctx,
            verifyNodeId,
            `(el) => {
              const ctrl = el.tagName?.toLowerCase() === 'label' && el.control ? el.control : el;
              return ctrl.tagName?.toLowerCase() === 'input'
                ? Boolean(ctrl.checked)
                : ctrl.getAttribute?.('aria-checked') === 'true';
            }`,
            sessionId,
          ).catch(() => wantChecked)
        : wantChecked;

      if (Boolean(afterChecked) !== wantChecked) {
        throw err('NOT_ACTIONABLE', `点击后勾选状态未变为 ${wantChecked}`);
      }
      return { ok: true, checked: wantChecked, changed: true, ...receipt(ctx, since) };
    },
  });
}

export async function focus(
  ctx: PageContext,
  target: TargetInput,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true } & ActionReceipt> {
  const since = Date.now();
  return runAction({
    name: `focus ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async () => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      await checkActionable(ctx, backendNodeId, requiredStates('focus'), sessionId);
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      await ctx.sendOn(sessionId, 'DOM.focus', { nodeId });
      return { ok: true, ...receipt(ctx, since) };
    },
  });
}

/**
 * press(sel?, chord, opts?)：形如 `press('Enter')` 是老全局 press(key)；
 * `press(sel, chord)` 先聚焦再按键。
 */
export async function press(
  ctx: PageContext,
  selOrChord: string | TargetInput,
  chordOrOpts?: string | PressOptions,
  maybeOpts?: PressOptions,
): Promise<{ ok: true } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  let chord: string;
  let opts: PressOptions;
  if (typeof selOrChord === 'string' && (chordOrOpts === undefined || typeof chordOrOpts !== 'string')) {
    chord = selOrChord as string;
    opts = (chordOrOpts as PressOptions) ?? {};
  } else {
    if (typeof chordOrOpts !== 'string') throw err('BAD_REQUEST', 'press(sel, chord) 的 chord 必须是字符串');
    chord = chordOrOpts;
    opts = maybeOpts ?? {};
    await runAction({
      name: `press ${tname(selOrChord as TargetInput)} ${chord}`,
      timeoutMs: opts.timeoutMs,
      attempt: async () => {
        const { backendNodeId, sessionId } = await resolveTarget(ctx, selOrChord as TargetInput);
        const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
        await ctx.sendOn(sessionId, 'DOM.focus', { nodeId });
        return { ok: true } as const;
      },
    });
  }
  const events = keyEvents(chord, { modifiers: heldModifiers() });
  await ctx.sendInput('Input.dispatchKeyEvent', events[0] as Record<string, unknown>);
  if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
  await ctx.sendInput('Input.dispatchKeyEvent', events[1] as Record<string, unknown>);
  return { ok: true, ...receipt(ctx, since) };
}

export async function setInputFiles(
  ctx: PageContext,
  target: TargetInput,
  paths: string | string[],
): Promise<{ ok: true; files: string[] } & ActionReceipt> {
  const since = Date.now();
  const list = checkInputFiles(paths);
  const { statSync } = await import('node:fs');
  for (const p of list) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      throw err('PATH_DENIED', `文件不存在: ${p}`);
    }
    if (!st.isFile()) throw err('PATH_DENIED', `不是文件: ${p}`);
  }
  return runAction({
    name: `setInputFiles ${tname(target)}`,
    attempt: async () => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      await ctx.sendOn(sessionId, 'DOM.setFileInputFiles', { nodeId, files: list });
      return { ok: true, files: list, ...receipt(ctx, since) };
    },
  });
}

// ── 弹窗与下载 ────────────────────────────────────────────────────

export async function acceptDialog(ctx: PageContext, promptText?: string): Promise<{ ok: true; type: string }> {
  const current = peekDialog(ctx);
  const d = ctx.pending.takeDialogEvent();
  const type = d && d.kind === 'dialog' ? d.type : (current?.type ?? 'alert');
  await ctx.sendOn(current?.sessionId, 'Page.handleJavaScriptDialog', { accept: true, promptText });
  markDialogHandled(ctx.wc);
  await flushPendingRelease(ctx);
  return { ok: true, type };
}

export async function dismissDialog(ctx: PageContext): Promise<{ ok: true; type: string }> {
  const current = peekDialog(ctx);
  const d = ctx.pending.takeDialogEvent();
  const type = d && d.kind === 'dialog' ? d.type : (current?.type ?? 'alert');
  await ctx.sendOn(current?.sessionId, 'Page.handleJavaScriptDialog', { accept: false });
  markDialogHandled(ctx.wc);
  await flushPendingRelease(ctx);
  return { ok: true, type };
}

export async function downloadSaveAs(
  ctx: PageContext,
  downloadId: string,
  dest: string,
): Promise<{ ok: true; path: string }> {
  const target = guardSavePath(dest, 'saveAs');
  const found = ctx.downloadById(downloadId);
  if (!found) throw err('DOWNLOAD_FAILED', `未知下载: ${downloadId}`);
  const { item } = found;
  if (item.isPaused()) item.resume();
  await new Promise<void>((resolve, reject) => {
    if (item.getState() === 'completed') return resolve();
    if (item.getState() === 'cancelled') return reject(err('DOWNLOAD_FAILED', '下载已取消'));
    item.once('done', (_e, state) => {
      if (state === 'completed') resolve();
      else reject(err('DOWNLOAD_FAILED', `下载结束 state=${state}`));
    });
  });
  const { mkdir, copyFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(target), { recursive: true });
  await copyFile(found.path, target);
  return { ok: true, path: target };
}

export function downloadCancel(ctx: PageContext, downloadId: string): { ok: true } {
  const found = ctx.downloadById(downloadId);
  if (!found) throw err('DOWNLOAD_FAILED', `未知下载: ${downloadId}`);
  found.item.cancel();
  return { ok: true };
}

export function downloadStatus(ctx: PageContext, downloadId: string): DownloadStatus {
  const found = ctx.downloadById(downloadId);
  if (!found) throw err('DOWNLOAD_FAILED', `未知下载: ${downloadId}`);
  const { item, url, filename } = found;
  const rawState = item.getState() as string;
  const state: DownloadStatus['state'] = rawState === 'progressing' ? 'pending' : (rawState as DownloadStatus['state']);
  return {
    downloadId,
    url,
    filename,
    state,
    receivedBytes: item.getReceivedBytes(),
    totalBytes: item.getTotalBytes(),
    path: state === 'completed' ? found.path : undefined,
  };
}
