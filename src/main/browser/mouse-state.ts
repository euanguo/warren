/**
 * 跨命令的输入状态：鼠标位置、按住的鼠标键、按住的修饰键，
 * 以及被 JS Dialog 打断而未闭合的 `PendingRelease`。
 *
 * 按 WebContents 实例绑定在 WeakMap 中：
 * - 多环境 / 多标签页之间严格隔离，不再共享进程级全局状态；
 * - WebContents 销毁后自动随 GC 回收，零内存泄漏。
 */
import type { WebContents } from 'electron';

export interface PendingMouseRelease {
  x: number;
  y: number;
  button: string;
  clickCount: number;
}

export interface InputState {
  lastMouse: { x: number; y: number };
  /** CDP modifiers 位：Alt=1, Control=2, Meta=4, Shift=8。 */
  heldModifierBits: number;
  /** 当前按住的鼠标键位掩码（left=1, right=2, middle=4）。 */
  heldButtonBits: number;
  /** 未闭合的 `mousePressed`，弹窗关闭后立即补发 `mouseReleased`。 */
  pendingRelease?: PendingMouseRelease;
}

const states = new WeakMap<object, InputState>();

function stateFor(wc: WebContents | object): InputState {
  let state = states.get(wc);
  if (!state) {
    state = {
      lastMouse: { x: 0, y: 0 },
      heldModifierBits: 0,
      heldButtonBits: 0,
    };
    states.set(wc, state);
  }
  return state;
}

export function lastMouseOf(wc: WebContents | object): { x: number; y: number } {
  return stateFor(wc).lastMouse;
}

export function heldModifiers(wc: WebContents | object): number {
  return stateFor(wc).heldModifierBits;
}

export function holdModifier(wc: WebContents | object, bit: number): void {
  stateFor(wc).heldModifierBits |= bit;
}

export function releaseModifier(wc: WebContents | object, bit: number): void {
  stateFor(wc).heldModifierBits &= ~bit;
}

export function heldButtons(wc: WebContents | object): number {
  return stateFor(wc).heldButtonBits;
}

export function holdButton(wc: WebContents | object, bit: number): void {
  stateFor(wc).heldButtonBits |= bit;
}

export function releaseButton(wc: WebContents | object, bit: number): void {
  stateFor(wc).heldButtonBits &= ~bit;
}

export function setPendingRelease(wc: WebContents | object, release: PendingMouseRelease): void {
  stateFor(wc).pendingRelease = release;
}

export function takePendingRelease(wc: WebContents | object): PendingMouseRelease | undefined {
  const state = states.get(wc);
  if (!state?.pendingRelease) return undefined;
  const entry = state.pendingRelease;
  state.pendingRelease = undefined;
  return entry;
}

export function clearPendingRelease(wc: WebContents | object): void {
  const state = states.get(wc);
  if (state) state.pendingRelease = undefined;
}

export function hasPendingRelease(wc: WebContents | object): boolean {
  return Boolean(states.get(wc)?.pendingRelease);
}
