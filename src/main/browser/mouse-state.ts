/**
 * 跨命令的输入状态：鼠标位置、按住的鼠标键、按住的修饰键，
 * 以及被 JS Dialog 打断而未闭合的 `PendingRelease`。
 *
 * 为什么需要 `PendingRelease`：
 * 若某次点击在 `mousePressed` 时立即触发 `alert()` / `confirm()`，
 * 渲染进程挂起后续输入，CLI 会提前把控制权交回调用方去处理弹窗；
 * 弹窗关掉后如果没补发 `mouseReleased`，浏览器内部一直认为鼠标键仍处于按下态，
 * 后续移动鼠标就会意外框选文本或触发拖拽。
 */
export const lastMouse = { x: 0, y: 0 };

/** CDP modifiers 位：Alt=1, Control=2, Meta=4, Shift=8。 */
let heldModifierBits = 0;

export function heldModifiers(): number {
  return heldModifierBits;
}

export function holdModifier(bit: number): void {
  heldModifierBits |= bit;
}

export function releaseModifier(bit: number): void {
  heldModifierBits &= ~bit;
}

/** 当前按住的鼠标键位掩码（left=1, right=2, middle=4）。 */
let heldButtonBits = 0;

export function heldButtons(): number {
  return heldButtonBits;
}

export function holdButton(bit: number): void {
  heldButtonBits |= bit;
}

export function releaseButton(bit: number): void {
  heldButtonBits &= ~bit;
}

export interface PendingMouseRelease {
  x: number;
  y: number;
  button: string;
  clickCount: number;
}

/** 按 WebContents id 追踪未闭合的 `mousePressed`，弹窗关闭后立即补发 `mouseReleased`。 */
const pendingReleases = new Map<number, PendingMouseRelease>();

export function setPendingRelease(wcId: number, release: PendingMouseRelease): void {
  pendingReleases.set(wcId, release);
}

export function takePendingRelease(wcId: number): PendingMouseRelease | undefined {
  const entry = pendingReleases.get(wcId);
  if (entry) pendingReleases.delete(wcId);
  return entry;
}

export function clearPendingRelease(wcId: number): void {
  pendingReleases.delete(wcId);
}

export function hasPendingRelease(wcId: number): boolean {
  return pendingReleases.has(wcId);
}
