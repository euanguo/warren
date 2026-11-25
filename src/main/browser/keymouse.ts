/**
 * 坐标键鼠：mouse.click/move/down/up/wheel 与 keyboard.down/up/press/type/insertText/paste。
 *
 * 坐标单位是 CSS 像素；位置优先用显式坐标，否则沿用上次位置（CDP 的 mouseWheel 必须带 x/y）。
 * paste 是直接插内容、不触发页面 paste 事件——原因见 HANDOFF 坑 12。
 */
import type { ActionReceipt } from '../../shared/types.ts';
import type { PageContext } from './ctx.ts';
import { keyEvents, modifierBitOf, mouseButtonParams, parseChord, type MouseButton } from './input.ts';
import { evaluate } from './escape.ts';
import {
  heldButtons,
  heldModifiers,
  holdButton,
  holdModifier,
  lastMouse,
  releaseButton,
  releaseModifier,
} from './mouse-state.ts';
import { assertNoDialog, receipt } from './page-helpers.ts';

export async function mouseClick(
  ctx: PageContext,
  x: number,
  y: number,
  opts: { button?: MouseButton; clickCount?: number; delay?: number; label?: string } = {},
): Promise<{ x: number; y: number } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  const { button, buttons } = mouseButtonParams(opts.button ?? 'left');
  const clickCount = opts.clickCount ?? 1;
  await ctx.sendInput('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    buttons: 0,
    pointerType: 'mouse',
  });
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
  lastMouse.x = x;
  lastMouse.y = y;
  return { x, y, ...receipt(ctx, since) };
}

export async function mouseMove(
  ctx: PageContext,
  x: number,
  y: number,
  opts: { label?: string } = {},
): Promise<{ x: number; y: number }> {
  // 按住左键拖拽时，move 必须带 buttons，否则页面收到的是「没按键的移动」
  await ctx.sendInput('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    buttons: heldButtons(),
    pointerType: 'mouse',
  });
  lastMouse.x = x;
  lastMouse.y = y;
  if (opts.label) ctx.record('browser.action', `移鼠 ${opts.label} @${x | 0},${y | 0}`);
  return { x, y };
}

export async function mouseDown(
  ctx: PageContext,
  opts: { button?: MouseButton; x?: number; y?: number } = {},
): Promise<{ ok: true }> {
  // 位置优先用显式坐标，否则沿用上次位置（CDP 会话级，无需 0,0）
  const { button, buttons } = mouseButtonParams(opts.button ?? 'left');
  const x = opts.x ?? lastMouse.x;
  const y = opts.y ?? lastMouse.y;
  await ctx.sendInput('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    buttons,
    clickCount: 1,
    pointerType: 'mouse',
  });
  holdButton(buttons);
  lastMouse.x = x;
  lastMouse.y = y;
  return { ok: true };
}

export async function mouseUp(
  ctx: PageContext,
  opts: { button?: MouseButton; x?: number; y?: number } = {},
): Promise<{ ok: true }> {
  const { button, buttons } = mouseButtonParams(opts.button ?? 'left');
  const x = opts.x ?? lastMouse.x;
  const y = opts.y ?? lastMouse.y;
  await ctx.sendInput('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    buttons: 0,
    clickCount: 1,
    pointerType: 'mouse',
  });
  releaseButton(buttons);
  lastMouse.x = x;
  lastMouse.y = y;
  return { ok: true };
}

export async function mouseWheel(
  ctx: PageContext,
  deltaX: number,
  deltaY: number,
  opts: { label?: string } = {},
): Promise<{ ok: true }> {
  // 调用前先 move 到滚动容器上（Ego 同款要求）。
  // x/y 是 CDP 的必填项——不给会直接报 "Invalid parameters"（实测），所以沿用上次鼠标位置。
  await ctx.sendInput('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: lastMouse.x,
    y: lastMouse.y,
    deltaX,
    deltaY,
    pointerType: 'mouse',
  });
  if (opts.label) ctx.record('browser.action', `滚轮 ${opts.label} ${deltaX},${deltaY}`);
  return { ok: true };
}

export async function keyboardDown(ctx: PageContext, key: string): Promise<{ ok: true }> {
  const [down] = keyEvents(key, { modifiers: heldModifiers() });
  await ctx.sendInput('Input.dispatchKeyEvent', down as Record<string, unknown>);
  // 按住的修饰键要跨命令记住：down('Shift') 之后 press('a') 必须得到大写 A
  holdModifier(modifierBitOf(parseChord(key).key));
  return { ok: true };
}

export async function keyboardUp(ctx: PageContext, key: string): Promise<{ ok: true }> {
  const [, up] = keyEvents(key, { modifiers: heldModifiers() });
  await ctx.sendInput('Input.dispatchKeyEvent', up as Record<string, unknown>);
  releaseModifier(modifierBitOf(parseChord(key).key));
  return { ok: true };
}

export async function keyboardPress(
  ctx: PageContext,
  chord: string,
  opts: { delay?: number } = {},
): Promise<{ ok: true } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  const [down, up] = keyEvents(chord, { modifiers: heldModifiers() });
  await ctx.sendInput('Input.dispatchKeyEvent', down as Record<string, unknown>);
  if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
  await ctx.sendInput('Input.dispatchKeyEvent', up as Record<string, unknown>);
  return { ok: true, ...receipt(ctx, since) };
}

export async function keyboardType(
  ctx: PageContext,
  text: string,
  opts: { delay?: number } = {},
): Promise<{ ok: true }> {
  assertNoDialog(ctx);
  const delay = opts.delay ?? 0;
  for (const ch of text) {
    await ctx.sendInput('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
  return { ok: true };
}

export async function keyboardInsert(ctx: PageContext, text: string): Promise<{ ok: true }> {
  assertNoDialog(ctx);
  await ctx.sendInput('Input.insertText', { text });
  return { ok: true };
}

export async function keyboardPaste(
  ctx: PageContext,
  content: string | { text: string; html?: string },
): Promise<{ ok: true }> {
  assertNoDialog(ctx);
  const text = typeof content === 'string' ? content : content.text;
  const html = typeof content === 'object' ? content.html : undefined;
  // 不走「写剪贴板 + 合成 Cmd+V」：Chromium 的粘贴是**浏览器侧**行为，CDP 合成按键
  // 在 Electron 里不会触发它（实测：按键发出、命令成功、页面毫无反应）。
  // 直接插入内容，也就不必去动用户的系统剪贴板（Playwright 同款取舍）。
  // 代价：不会触发页面的 paste 事件，富文本走 insertHTML。
  if (html) {
    const inserted = await evaluate(
      ctx,
      `((arg) => {
         const el = document.activeElement;
         if (!el || typeof el.focus !== 'function') return false;
         el.focus();
         return document.execCommand('insertHTML', false, arg);
       })`,
      html,
    ).catch(() => false);
    if (inserted === true) return { ok: true };
  }
  await ctx.sendInput('Input.insertText', { text });
  return { ok: true };
}
