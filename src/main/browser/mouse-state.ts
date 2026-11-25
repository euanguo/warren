/**
 * 跨命令的输入状态：鼠标位置、按住的鼠标键、按住的修饰键。
 *
 * 元素动作（click/hover）和坐标键鼠（move/down/up/wheel）都读写它，所以放在共享模块里：
 * - CDP 的 `mouseWheel` **必须**带 x/y，`mouseDown/Up` 不传坐标时要沿用上一次位置，否则落到 0,0 误触；
 * - `down('Shift')` 之后 `press('a')` 必须得到大写 A（Playwright 的 `Keyboard._modifiers` 同款语义），
 *   所以修饰键状态要跨命令保存。
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
