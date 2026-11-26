/**
 * 动作：click / dblclick / hover / drag / fill / selectOption / focus / press / setInputFiles，
 * 以及弹窗与下载。全部通过 PageContext 工作，不依赖 controller 类。
 */
import type {
  ActionReceipt,
  ClickOptions,
  DownloadStatus,
  FillOptions,
  NavigationReceipt,
  PressOptions,
  SelectValue,
  TargetInput,
} from '../../shared/types.ts';
import type { PageContext } from './ctx.ts';
import { checkActionable, requiredStates, runAction } from './actionability.ts';
import { inputPathEnabled, mousePath, STEP_DELAY_MS, type Point } from './input-synthesis.ts';
import { keyEvents, mouseButtonParams } from './input.ts';
import {
  assertNoDialog,
  boxCenter,
  boxRect,
  err,
  evalOnNode,
  nodeIdFor,
  resolveTarget,
  peekDialog,
  scrollIntoView,
  receipt,
  waitForNavigation,
} from './page-helpers.ts';
import { checkInputFiles, guardSavePath } from './policy.ts';
import { heldModifiers, lastMouse } from './mouse-state.ts';

import { markDialogHandled } from './session.ts';

/** 动作名里带的目标摘要，进错误消息用（agent 靠它定位是哪一步挂了）。 */
function tname(target: TargetInput): string {
  return typeof target === 'string' ? target : JSON.stringify(target).slice(0, 60);
}

/** 换算当前页面缩放比并向透明遮罩层播报动作位置（安全静默，永不中断主操作）。 */
function emitVisualAction(
  ctx: PageContext,
  kind: 'click' | 'fill' | 'hover',
  x: number,
  y: number,
  rect?: { x: number; y: number; width: number; height: number },
  label?: string,
): void {
  if (!ctx.onVisualAction) return;
  try {
    const rawZoom = typeof ctx.wc.getZoomFactor === 'function' ? ctx.wc.getZoomFactor() : 1;
    const zoom = Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1;
    ctx.onVisualAction({
      kind,
      x: Math.round(x * zoom),
      y: Math.round(y * zoom),
      ...(rect
        ? {
            rect: {
              x: Math.round(rect.x * zoom),
              y: Math.round(rect.y * zoom),
              width: Math.round(rect.width * zoom),
              height: Math.round(rect.height * zoom),
            },
          }
        : {}),
      ...(label ? { label: label.slice(0, 48) } : {}),
    });
  } catch {
    // 动画播报层永不影响真实操作
  }
}

/**
 * 页面内 fill 的脚本。按 input type 分流（对标 Playwright injected `fill`）：
 * 能直接赋值的类型直接赋值并派发 input/change，返回 `done`；文本类选中内容返回 `needsinput`，
 * 由服务端发 `Input.insertText`。**不要**用合成 ⌘A 代替选中——自定义编辑器收不到，会变成追加。
 */
function fillScript(value: string, clearFirst: boolean): string {
  return `(el) => {
  const value = ${JSON.stringify(value)};
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.type || 'text').toLowerCase();
    const byAssign = ['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week'];
    const byTyping = ['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url'];
    if (!byAssign.includes(type) && !byTyping.includes(type)) {
      return { status: 'error', message: 'input type "' + type + '" 不能 fill' };
    }
    if (type === 'number' && isNaN(Number(value.trim()))) {
      return { status: 'error', message: 'number 输入框不接受非数字: ' + value };
    }
    if (byAssign.includes(type)) {
      const v = type === 'color' ? value.toLowerCase() : value.trim();
      el.focus();
      el.value = v;
      if (el.value !== v) return { status: 'error', message: '页面拒绝了值: ' + value };
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { status: 'done' };
    }
  } else if (tag !== 'textarea' && !el.isContentEditable) {
    return { status: 'error', message: '不是 input/textarea/contenteditable' };
  }
  if (${clearFirst}) {
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) document.execCommand('selectAll');
  }
  return { status: 'needsinput' };
}`;
}

/**
 * 把鼠标**沿着路径**移到目标（含终点），而不是一步跳过去。
 *
 * 真人的 `mousemove` 是一串中间坐标；页面里做节流/去抖、canvas 绘制、命中检测的代码
 * 吃这个差别。`WARREN_INPUT_PATH=0` 关掉（见 input-synthesis.ts）。
 *
 * 只移动，不按下 —— 按下/抬起仍由各动作自己发，免得绕过 actionability 那套。
 */
async function moveAlongPath(ctx: PageContext, to: Point): Promise<void> {
  const points = inputPathEnabled() ? mousePath(lastMouse, to) : [to];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    await ctx.sendInput('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      buttons: 0,
      pointerType: 'mouse',
    });
    // 最后一个点不等 —— 后面紧跟按下，中间不该再插延迟
    if (i < points.length - 1) await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
  }
  lastMouse.x = to.x;
  lastMouse.y = to.y;
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
    attempt: async () => {
      // 每次重试都重新解析：DOM 重渲染后要拿新节点，不能用上一轮的 backendNodeId
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      await scrollIntoView(ctx, backendNodeId);
      await checkActionable(
        ctx,
        backendNodeId,
        requiredStates(opts.clickCount === 2 ? 'dblclick' : 'click'),
        sessionId,
      );
      const rect = await boxRect(ctx, backendNodeId, sessionId);
      const x = opts.position ? rect.x + opts.position.x : rect.x + rect.width / 2;
      const y = opts.position ? rect.y + opts.position.y : rect.y + rect.height / 2;
      emitVisualAction(ctx, 'click', x, y, rect, opts.label ?? tname(target));
      const urlBefore = ctx.wc.getURL();
      const navigated = opts.noWaitAfter
        ? Promise.resolve<NavigationReceipt>('none')
        : waitForNavigation(ctx, urlBefore, opts.navigationTimeoutMs ?? 15_000);
      const { button, buttons } = mouseButtonParams(opts.button ?? 'left');
      const clickCount = opts.clickCount ?? 1;

      await moveAlongPath(ctx, { x, y });
      await ctx.sendInput('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        buttons,
        clickCount,
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
        pointerType: 'mouse',
      });
      if (opts.label) ctx.record('browser.action', `${opts.label} @${x | 0},${y | 0}`);

      const navigation = await navigated;
      // lastMouse 已经由 moveAlongPath 落好了，别再写一遍
      return { x, y, url: ctx.wc.getURL(), navigation, ...receipt(ctx, since) };
    },
  });
}

export async function dblclick(
  ctx: PageContext,
  target: TargetInput,
  opts: ClickOptions = {},
): Promise<{ x: number; y: number; url: string } & ActionReceipt> {
  return click(ctx, target, { ...opts, clickCount: 2 });
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
    attempt: async () => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      await scrollIntoView(ctx, backendNodeId);
      await checkActionable(ctx, backendNodeId, requiredStates('hover'), sessionId);
      const rect = await boxRect(ctx, backendNodeId, sessionId);
      const x = opts.position ? rect.x + opts.position.x : rect.x + rect.width / 2;
      const y = opts.position ? rect.y + opts.position.y : rect.y + rect.height / 2;
      emitVisualAction(ctx, 'hover', x, y, rect, opts.label ?? tname(target));
      await moveAlongPath(ctx, { x, y });
      if (opts.label) ctx.record('browser.action', `悬停 ${opts.label} @${x | 0},${y | 0}`);
      return { x, y, ...receipt(ctx, since) };
    },
  });
}

export async function drag(
  ctx: PageContext,
  source: TargetInput,
  target: TargetInput,
  opts: ClickOptions & { steps?: number } = {},
): Promise<{ ok: true } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  return runAction({
    name: `drag ${tname(source)} → ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async () => {
      const from = await resolveTarget(ctx, source);
      const to = await resolveTarget(ctx, target);
      const sId = from.backendNodeId;
      const tId = to.backendNodeId;
      await scrollIntoView(ctx, sId);
      await scrollIntoView(ctx, tId);
      await checkActionable(ctx, sId, requiredStates('drag'), from.sessionId);
      const s = await boxCenter(ctx, sId, undefined, from.sessionId);
      const t = await boxCenter(ctx, tId, undefined, to.sessionId);
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
      return { ok: true, ...receipt(ctx, since) };
    },
  });
}

export async function fill(
  ctx: PageContext,
  target: TargetInput,
  value: string,
  opts: FillOptions = {},
): Promise<{ ok: true } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  return runAction({
    name: `fill ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async () => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      await checkActionable(ctx, backendNodeId, requiredStates('fill'), sessionId);
      const rect = await boxRect(ctx, backendNodeId, sessionId).catch(() => undefined);
      if (rect) {
        // 严禁把填进去的 value 放进 label，避免密码/凭据明文出现在遮罩层
        emitVisualAction(ctx, 'fill', rect.x + rect.width / 2, rect.y + rect.height / 2, rect, `fill ${tname(target)}`);
      }
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      await ctx.sendOn(sessionId, 'DOM.focus', { nodeId });
      // 页面内选中 + 按 input type 分流（对标 Playwright injected fill）。
      // 合成 ⌘A 在自定义编辑器里选不中，会静默变成追加，所以必须用真 selection。
      const outcome = (await evalOnNode(ctx, nodeId, fillScript(value, opts.clearFirst !== false), sessionId)) as {
        status: 'done' | 'needsinput' | 'error';
        message?: string;
      } | null;
      if (outcome?.status === 'error') throw err('TARGET_NOT_FILLABLE', outcome.message ?? 'fill 失败');
      if (outcome?.status !== 'done') await ctx.sendInput('Input.insertText', { text: value });
      // 回读确认：Playwright 不验这一步，页面把输入吞掉它是不知道的
      const readBack = await evalOnNode(
        ctx,
        nodeId,
        `(el) => ('value' in el ? el.value : el.textContent ?? '')`,
        sessionId,
      ).catch(() => null);
      if (typeof readBack === 'string' && readBack !== value) {
        throw Object.assign(new Error(`FILL_UNCONFIRMED 期望 ${value.length} 字，读回 ${readBack.length} 字`), {
          code: 'FILL_UNCONFIRMED',
        });
      }
      return { ok: true, ...receipt(ctx, since) };
    },
  });
}

export async function selectOption(
  ctx: PageContext,
  target: TargetInput,
  value: SelectValue,
  opts: { timeoutMs?: number } = {},
): Promise<{ selected: string[] } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  return runAction({
    name: `selectOption ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async () => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      await checkActionable(ctx, backendNodeId, requiredStates('selectOption'), sessionId);
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      const selected = await evalOnNode(
        ctx,
        nodeId,
        `((sel) => {
      const el = sel;
      if (!(el instanceof HTMLSelectElement)) throw new Error('not a select');
      const norm = ${JSON.stringify(value)};
      const wants = norm === null ? [] : Array.isArray(norm) ? norm : [norm];
      const match = (opt, w) => {
        if (typeof w === 'string') return opt.value === w || opt.label === w || opt.text === w;
        if (w && typeof w === 'object') {
          if (w.value !== undefined && opt.value !== w.value) return false;
          if (w.label !== undefined && (opt.label !== w.label && opt.text !== w.label)) return false;
          if (w.index !== undefined && opt.index !== w.index) return false;
          return true;
        }
        return false;
      };
      if (wants.length === 0) { el.value = ''; el.selectedIndex = -1; }
      else {
        let first = true;
        for (const opt of el.options) {
          const hit = wants.some((w) => match(opt, w));
          if (el.multiple) opt.selected = hit;
          else if (hit && first) { opt.selected = true; first = false; }
          else if (!el.multiple) opt.selected = false;
        }
      }
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return [...el.selectedOptions].map((o) => o.value);
    })`,
        sessionId,
      ).catch((e) => {
        throw err('TARGET_NOT_FILLABLE', `selectOption 失败: ${(e as Error).message}`);
      });
      return { selected: (selected as string[]) ?? [], ...receipt(ctx, since) };
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
 * `press(sel, chord)` 先聚焦再按键。命名键大小写不敏感，单字符保留大小写。
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
    // press(key) / press(key, opts) 老形式：单字符串是全局按键
    chord = selOrChord as string;
    opts = (chordOrOpts as PressOptions) ?? {};
  } else {
    // press(sel, chord, opts?)：sel 可能是对象或选择器字符串
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
      // 隐藏的 file input 是合法目标：Playwright 的 _setInputFiles 也不做 actionability 检查
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
  // 跨源 iframe 里弹的 dialog 要发回它自己的子会话，否则应答永远不到
  await ctx.sendOn(current?.sessionId, 'Page.handleJavaScriptDialog', { accept: true, promptText });
  markDialogHandled(ctx.wc);
  return { ok: true, type };
}

export async function dismissDialog(ctx: PageContext): Promise<{ ok: true; type: string }> {
  const current = peekDialog(ctx);
  const d = ctx.pending.takeDialogEvent();
  const type = d && d.kind === 'dialog' ? d.type : (current?.type ?? 'alert');
  await ctx.sendOn(current?.sessionId, 'Page.handleJavaScriptDialog', { accept: false });
  markDialogHandled(ctx.wc);
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
