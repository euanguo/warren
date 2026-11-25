/**
 * chord 解析 + mouse/keyboard 的 CDP 参数组装。纯函数，可单测。
 *
 * 键名口径对标 Playwright keyboard：`F1-F12/Digit0-9/KeyA-Z`、
 * `Shift/Control/Alt/Meta/ShiftLeft/ControlOrMeta`（mac 上 ControlOrMeta=Meta，
 * Windows/Linux=Control）；`Control+o` / `Control+Shift+T` 形 chord；
 * 单字符保留大小写，命名键大小写不敏感。
 */

const CANONICAL_KEYS = [
  'Backquote',
  'Minus',
  'Equal',
  'Backslash',
  'Backspace',
  'Tab',
  'Delete',
  'Escape',
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'End',
  'Enter',
  'Home',
  'Insert',
  'PageDown',
  'PageUp',
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'ShiftLeft',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Pause',
  'PrintScreen',
  'ContextMenu',
  'Help',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
];
// 命名键大小写不敏感：按小写查回标准写法（`ARROWLEFT` -> `ArrowLeft`）。
const NAMED_KEYS = new Map(CANONICAL_KEYS.map((k) => [k.toLowerCase(), k]));

const MODIFIERS = new Set(['shift', 'control', 'alt', 'meta', 'controlormeta', 'shiftleft']);

export interface ParsedChord {
  /** 主键（原样大小写，单字符保留）。 */
  key: string;
  /** CDP code（单字符推 `KeyX`，命名键原样）。 */
  code: string;
  /** CDP modifiers 位：Alt=1, Control=2, Meta=4, Shift=8。 */
  modifiers: number;
}

export function isMac(): boolean {
  return process.platform === 'darwin';
}

function failChord(chord: string, reason: string): never {
  throw Object.assign(new Error(`BAD_CHORD ${reason}: ${chord}`), { code: 'BAD_SELECTOR' });
}

/** `ControlOrMeta` 按平台展开。 */
export function expandControlOrMeta(part: string): string {
  if (part.toLowerCase() !== 'controlormeta') return part;
  return isMac() ? 'Meta' : 'Control';
}

export function parseChord(chord: string): ParsedChord {
  if (typeof chord !== 'string' || !chord.trim()) failChord(String(chord), '空按键');
  const parts = chord.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) failChord(chord, '空段');
  const rawKey = parts[parts.length - 1];
  const rawMods = parts.slice(0, -1);

  let modifiers = 0;
  for (const m of rawMods) {
    const name = expandControlOrMeta(m).toLowerCase();
    if (!MODIFIERS.has(name) && name !== 'shiftleft') failChord(chord, `未知修饰键 ${m}`);
    if (name === 'alt' || name === 'altleft' || name === 'altright') modifiers |= 1;
    else if (name === 'control' || name === 'controlleft' || name === 'controlright') modifiers |= 2;
    else if (name === 'meta' || name === 'metaleft' || name === 'metaright') modifiers |= 4;
    else modifiers |= 8; // shift / shiftleft
  }

  // 单字符保留大小写；命名键大小写不敏感
  let key: string;
  let code: string;
  if (rawKey.length === 1) {
    key = rawKey;
    code = /^[a-zA-Z]$/.test(rawKey) ? `Key${rawKey.toUpperCase()}` : rawKey;
  } else {
    const lower = rawKey.toLowerCase();
    const canonical = NAMED_KEYS.get(lower);
    if (!canonical) failChord(chord, `未知键名 ${rawKey}`);
    key = canonical;
    code = canonical;
  }
  return { key, code, modifiers };
}

/** 修饰键名 → CDP modifiers 位。非修饰键返回 0。 */
export function modifierBitOf(key: string): number {
  switch (key.toLowerCase()) {
    case 'alt':
    case 'altleft':
    case 'altright':
      return 1;
    case 'control':
    case 'controlleft':
    case 'controlright':
      return 2;
    case 'meta':
    case 'metaleft':
    case 'metaright':
      return 4;
    case 'shift':
    case 'shiftleft':
      return 8;
    default:
      return 0;
  }
}

/**
 * keyDown + keyUp 两步的 CDP 参数。
 *
 * `modifiers` 是**当前按住**的修饰键位（跨命令状态），会和 chord 自带的位合并——
 * 这样 `keyboard.down('Shift')` 之后 `press('a')` 才会得到大写 A（Playwright 同款）。
 * 单字符键带上 `text`/`unmodifiedText`，否则 Chromium 不发 keypress/input，
 * 只监听 keypress 的页面收不到输入。
 */
export function keyEvents(chord: string, opts: { modifiers?: number } = {}): Array<Record<string, unknown>> {
  const parsed = parseChord(chord);
  const modifiers = parsed.modifiers | (opts.modifiers ?? 0);
  // 按住 Shift 时单字符变大写：按键描述要按当前修饰键算，不能照抄入参大小写
  const key = modifiers & 8 && parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key;
  const down: Record<string, unknown> = { type: 'keyDown', key, code: parsed.code, modifiers };
  const up: Record<string, unknown> = { type: 'keyUp', key, code: parsed.code, modifiers };
  if (key.length === 1) {
    down.text = key;
    down.unmodifiedText = parsed.key;
  }
  const windowsVirtualKeyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined;
  if (windowsVirtualKeyCode !== undefined) {
    down.windowsVirtualKeyCode = windowsVirtualKeyCode;
    up.windowsVirtualKeyCode = windowsVirtualKeyCode;
  }
  return [down, up];
}

export type MouseButton = 'left' | 'middle' | 'right';

export function mouseButtonParams(button: MouseButton = 'left'): {
  button: string;
  buttons: number;
} {
  if (button === 'middle') return { button: 'middle', buttons: 4 };
  if (button === 'right') return { button: 'right', buttons: 2 };
  return { button: 'left', buttons: 1 };
}
