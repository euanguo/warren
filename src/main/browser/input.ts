/**
 * chord 解析 + mouse/keyboard 的 CDP 参数组装。纯函数，可单测。
 *
 * 键名口径对标 Playwright / Chromium US 键盘布局：
 * - 完整覆盖字母、数字、US OEM 标点（`; = , - . / \` [ \ ] '`）与 Shift 符号；
 * - 正确提供 `windowsVirtualKeyCode` / `nativeVirtualKeyCode` / `location`；
 * - 修复 `.` 被 ASCII 46 错映成 `VK_DELETE`、`Enter`/`Tab` 缺 `text` 与 VK 码、
 *   以及 `Control`/`Alt`/`Meta` 组合键误发 `text` 的历史缺陷；
 * - 兼容常见别名：`Esc`、`Return`、`Space`、`Up`/`Down`/`Left`/`Right`、`Ctrl`、`Cmd`、`Command`。
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
  'ShiftRight',
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
  'Space',
  'BracketLeft',
  'BracketRight',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
];

// 命名键大小写不敏感：按小写查回标准写法（`ARROWLEFT` -> `ArrowLeft`）。
const NAMED_KEYS = new Map(CANONICAL_KEYS.map((k) => [k.toLowerCase(), k]));

/** 常用键名别名 → 标准键名。 */
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  ins: 'Insert',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  pgdown: 'PageDown',
  ctrl: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  option: 'Alt',
  opt: 'Alt',
  spacebar: 'Space',
};

const MODIFIERS = new Set([
  'shift',
  'shiftleft',
  'shiftright',
  'control',
  'controlleft',
  'controlright',
  'ctrl',
  'alt',
  'altleft',
  'altright',
  'option',
  'opt',
  'meta',
  'metaleft',
  'metaright',
  'cmd',
  'command',
  'controlormeta',
]);

interface KeySpec {
  code: string;
  keyCode: number;
  text?: string;
  unmodifiedKey?: string;
  shifted?: boolean;
  location?: number;
}

/** US 键盘标点与数字的字符级映射：区分普通与 Shift 变体，彻底告别 charCode 错映。 */
const CHAR_SPECS: Record<string, KeySpec> = {
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  '`': { code: 'Backquote', keyCode: 192, text: '`' },
  '~': { code: 'Backquote', keyCode: 192, text: '~', unmodifiedKey: '`', shifted: true },
  '-': { code: 'Minus', keyCode: 189, text: '-' },
  _: { code: 'Minus', keyCode: 189, text: '_', unmodifiedKey: '-', shifted: true },
  '=': { code: 'Equal', keyCode: 187, text: '=' },
  '+': { code: 'Equal', keyCode: 187, text: '+', unmodifiedKey: '=', shifted: true },
  '[': { code: 'BracketLeft', keyCode: 219, text: '[' },
  '{': { code: 'BracketLeft', keyCode: 219, text: '{', unmodifiedKey: '[', shifted: true },
  ']': { code: 'BracketRight', keyCode: 221, text: ']' },
  '}': { code: 'BracketRight', keyCode: 221, text: '}', unmodifiedKey: ']', shifted: true },
  '\\': { code: 'Backslash', keyCode: 220, text: '\\' },
  '|': { code: 'Backslash', keyCode: 220, text: '|', unmodifiedKey: '\\', shifted: true },
  ';': { code: 'Semicolon', keyCode: 186, text: ';' },
  ':': { code: 'Semicolon', keyCode: 186, text: ':', unmodifiedKey: ';', shifted: true },
  "'": { code: 'Quote', keyCode: 222, text: "'" },
  '"': { code: 'Quote', keyCode: 222, text: '"', unmodifiedKey: "'", shifted: true },
  ',': { code: 'Comma', keyCode: 188, text: ',' },
  '<': { code: 'Comma', keyCode: 188, text: '<', unmodifiedKey: ',', shifted: true },
  '.': { code: 'Period', keyCode: 190, text: '.' },
  '>': { code: 'Period', keyCode: 190, text: '>', unmodifiedKey: '.', shifted: true },
  '/': { code: 'Slash', keyCode: 191, text: '/' },
  '?': { code: 'Slash', keyCode: 191, text: '?', unmodifiedKey: '/', shifted: true },
  '!': { code: 'Digit1', keyCode: 49, text: '!', unmodifiedKey: '1', shifted: true },
  '@': { code: 'Digit2', keyCode: 50, text: '@', unmodifiedKey: '2', shifted: true },
  '#': { code: 'Digit3', keyCode: 51, text: '#', unmodifiedKey: '3', shifted: true },
  $: { code: 'Digit4', keyCode: 52, text: '$', unmodifiedKey: '4', shifted: true },
  '%': { code: 'Digit5', keyCode: 53, text: '%', unmodifiedKey: '5', shifted: true },
  '^': { code: 'Digit6', keyCode: 54, text: '^', unmodifiedKey: '6', shifted: true },
  '&': { code: 'Digit7', keyCode: 55, text: '&', unmodifiedKey: '7', shifted: true },
  '*': { code: 'Digit8', keyCode: 56, text: '*', unmodifiedKey: '8', shifted: true },
  '(': { code: 'Digit9', keyCode: 57, text: '(', unmodifiedKey: '9', shifted: true },
  ')': { code: 'Digit0', keyCode: 48, text: ')', unmodifiedKey: '0', shifted: true },
};

/** 按住 Shift 时，普通标点/数字对应的 Shift 字符。 */
const SHIFT_CHAR_MAP: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
};

/** 命名键的完整 Windows Virtual Key 码、可选 `text` 与 `location`。 */
const NAMED_SPECS: Record<string, { keyCode: number; key?: string; code?: string; text?: string; location?: number }> =
  {
    Backspace: { keyCode: 8 },
    Tab: { keyCode: 9, text: '\t' },
    Enter: { keyCode: 13, text: '\r' },
    Shift: { keyCode: 16, location: 1 },
    ShiftLeft: { keyCode: 16, key: 'Shift', code: 'ShiftLeft', location: 1 },
    ShiftRight: { keyCode: 16, key: 'Shift', code: 'ShiftRight', location: 2 },
    Control: { keyCode: 17, location: 1 },
    ControlLeft: { keyCode: 17, key: 'Control', code: 'ControlLeft', location: 1 },
    ControlRight: { keyCode: 17, key: 'Control', code: 'ControlRight', location: 2 },
    Alt: { keyCode: 18, location: 1 },
    AltLeft: { keyCode: 18, key: 'Alt', code: 'AltLeft', location: 1 },
    AltRight: { keyCode: 18, key: 'Alt', code: 'AltRight', location: 2 },
    Pause: { keyCode: 19 },
    CapsLock: { keyCode: 20 },
    Escape: { keyCode: 27 },
    Space: { keyCode: 32, key: ' ', code: 'Space', text: ' ' },
    PageUp: { keyCode: 33 },
    PageDown: { keyCode: 34 },
    End: { keyCode: 35 },
    Home: { keyCode: 36 },
    ArrowLeft: { keyCode: 37 },
    ArrowUp: { keyCode: 38 },
    ArrowRight: { keyCode: 39 },
    ArrowDown: { keyCode: 40 },
    PrintScreen: { keyCode: 44 },
    Insert: { keyCode: 45 },
    Delete: { keyCode: 46 },
    Meta: { keyCode: 91, location: 1 },
    MetaLeft: { keyCode: 91, key: 'Meta', code: 'MetaLeft', location: 1 },
    MetaRight: { keyCode: 92, key: 'Meta', code: 'MetaRight', location: 2 },
    ContextMenu: { keyCode: 93 },
    NumLock: { keyCode: 144 },
    ScrollLock: { keyCode: 145 },
    Help: { keyCode: 47 },
    Backquote: { keyCode: 192, key: '`', text: '`' },
    Minus: { keyCode: 189, key: '-', text: '-' },
    Equal: { keyCode: 187, key: '=', text: '=' },
    BracketLeft: { keyCode: 219, key: '[', text: '[' },
    BracketRight: { keyCode: 221, key: ']', text: ']' },
    Backslash: { keyCode: 220, key: '\\', text: '\\' },
    Semicolon: { keyCode: 186, key: ';', text: ';' },
    Quote: { keyCode: 222, key: "'", text: "'" },
    Comma: { keyCode: 188, key: ',', text: ',' },
    Period: { keyCode: 190, key: '.', text: '.' },
    Slash: { keyCode: 191, key: '/', text: '/' },
  };

export interface ParsedChord {
  /** 主键（原样大小写，单字符保留）。 */
  key: string;
  /** CDP code（单字符推 `KeyX` / `DigitN` / `Period` 等，命名键标准名）。 */
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

/** `ControlOrMeta` 与常见修饰键别名按平台展开。 */
export function expandControlOrMeta(part: string): string {
  const lower = part.toLowerCase();
  if (lower === 'controlormeta') return isMac() ? 'Meta' : 'Control';
  if (lower === 'ctrl') return 'Control';
  if (lower === 'cmd' || lower === 'command') return 'Meta';
  if (lower === 'option' || lower === 'opt') return 'Alt';
  return part;
}

export function parseChord(chord: string): ParsedChord {
  if (typeof chord !== 'string' || !chord.trim()) failChord(String(chord), '空按键');
  // 特殊支持单个 '+' 或 'Control++' 末尾 '+' 字符
  let rawMods: string[];
  let rawKey: string;
  if (chord === '+') {
    rawMods = [];
    rawKey = '+';
  } else if (chord.endsWith('++')) {
    rawMods = chord
      .slice(0, -2)
      .split('+')
      .map((p) => p.trim());
    rawKey = '+';
  } else {
    const parts = chord.split('+').map((p) => p.trim());
    if (parts.some((p) => !p)) failChord(chord, '空段');
    rawKey = parts[parts.length - 1]!;
    rawMods = parts.slice(0, -1);
  }
  if (rawMods.some((p) => !p)) failChord(chord, '空段');

  let modifiers = 0;
  for (const m of rawMods) {
    const name = expandControlOrMeta(m).toLowerCase();
    if (!MODIFIERS.has(name)) failChord(chord, `未知修饰键 ${m}`);
    if (name === 'alt' || name === 'altleft' || name === 'altright') modifiers |= 1;
    else if (name === 'control' || name === 'controlleft' || name === 'controlright') modifiers |= 2;
    else if (name === 'meta' || name === 'metaleft' || name === 'metaright') modifiers |= 4;
    else modifiers |= 8; // shift / shiftleft / shiftright
  }

  // 单字符保留大小写；命名键（含别名）大小写不敏感
  let key: string;
  let code: string;
  if (rawKey.length === 1) {
    key = rawKey;
    if (/^[a-zA-Z]$/.test(rawKey)) code = `Key${rawKey.toUpperCase()}`;
    else if (/^[0-9]$/.test(rawKey)) code = `Digit${rawKey}`;
    else if (CHAR_SPECS[rawKey]) code = CHAR_SPECS[rawKey]!.code;
    else code = rawKey;
  } else {
    const lower = rawKey.toLowerCase();
    const aliased = KEY_ALIASES[lower];
    const canonical = aliased ?? NAMED_KEYS.get(lower);
    if (!canonical) failChord(chord, `未知键名 ${rawKey}`);
    key = canonical === 'Space' ? ' ' : canonical;
    code = canonical;
  }
  return { key, code, modifiers };
}

/** 修饰键名 → CDP modifiers 位。非修饰键返回 0。 */
export function modifierBitOf(key: string): number {
  switch (expandControlOrMeta(key).toLowerCase()) {
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
    case 'shiftright':
      return 8;
    default:
      return 0;
  }
}

export interface KeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode?: number;
  text?: string;
  unmodifiedText?: string;
  location?: number;
}

/** 计算给定键与当前修饰位掩码对应的完整 CDP 按键描述符。 */
export function resolveKeyDescriptor(parsed: ParsedChord, modifiers: number): KeyDescriptor {
  const hasShift = Boolean(modifiers & 8);
  const hasCommandMod = Boolean(modifiers & (1 | 2 | 4)); // Alt | Control | Meta

  // 1) F1-F12
  const fMatch = parsed.code.match(/^F(\d{1,2})$/);
  if (fMatch) {
    const idx = Number(fMatch[1]);
    if (idx >= 1 && idx <= 24) {
      return { key: parsed.key, code: parsed.code, windowsVirtualKeyCode: 111 + idx };
    }
  }
  // 2) Numpad0-9
  const numMatch = parsed.code.match(/^Numpad(\d)$/);
  if (numMatch) {
    const d = numMatch[1]!;
    return {
      key: d,
      code: parsed.code,
      windowsVirtualKeyCode: 96 + Number(d),
      location: 3,
      ...(hasCommandMod ? {} : { text: d, unmodifiedText: d }),
    };
  }
  // 3) KeyA-Z 命名形式（当入参直接是 "KeyA" 而非 "a"）
  const keyAlpha = parsed.key.match(/^Key([A-Z])$/);
  if (keyAlpha) {
    const ch = hasShift ? keyAlpha[1]! : keyAlpha[1]!.toLowerCase();
    return {
      key: ch,
      code: parsed.code,
      windowsVirtualKeyCode: keyAlpha[1]!.charCodeAt(0),
      ...(hasCommandMod ? {} : { text: ch, unmodifiedText: keyAlpha[1]!.toLowerCase() }),
    };
  }
  // 4) Digit0-9 命名形式（当入参直接是 "Digit1"）
  const digitNamed = parsed.key.match(/^Digit(\d)$/);
  if (digitNamed) {
    const base = digitNamed[1]!;
    const out = hasShift ? (SHIFT_CHAR_MAP[base] ?? base) : base;
    return {
      key: out,
      code: parsed.code,
      windowsVirtualKeyCode: base.charCodeAt(0),
      ...(hasCommandMod ? {} : { text: out, unmodifiedText: base }),
    };
  }
  // 5) 命名键表（Enter/Tab/Escape/Arrow*/修饰键/OEM 命名键等）
  const namedSpec = NAMED_SPECS[parsed.code];
  if (namedSpec && (parsed.key.length > 1 || parsed.code === 'Space')) {
    const outKey = namedSpec.key ?? parsed.key;
    const outCode = namedSpec.code ?? parsed.code;
    const text = !hasCommandMod ? namedSpec.text : undefined;
    return {
      key: outKey,
      code: outCode,
      windowsVirtualKeyCode: namedSpec.keyCode,
      ...(namedSpec.location ? { location: namedSpec.location } : {}),
      ...(text !== undefined ? { text, unmodifiedText: text } : {}),
    };
  }

  // 6) 单字符（字母 / 数字 / US 标点 / Unicode）
  if (parsed.key.length === 1) {
    const baseKey = parsed.key;
    let outKey = baseKey;
    if (hasShift) {
      if (/^[a-z]$/.test(baseKey)) outKey = baseKey.toUpperCase();
      else if (SHIFT_CHAR_MAP[baseKey]) outKey = SHIFT_CHAR_MAP[baseKey]!;
    }
    let vk: number | undefined;
    if (/^[a-zA-Z]$/.test(outKey)) {
      vk = outKey.toUpperCase().charCodeAt(0);
    } else if (/^[0-9]$/.test(outKey)) {
      vk = outKey.charCodeAt(0);
    } else if (CHAR_SPECS[outKey]) {
      vk = CHAR_SPECS[outKey]!.keyCode;
    } else if (CHAR_SPECS[baseKey]) {
      vk = CHAR_SPECS[baseKey]!.keyCode;
    }
    return {
      key: outKey,
      code: parsed.code,
      ...(vk !== undefined ? { windowsVirtualKeyCode: vk } : {}),
      ...(hasCommandMod
        ? {}
        : {
            text: outKey,
            unmodifiedText: CHAR_SPECS[baseKey]?.unmodifiedKey ?? baseKey,
          }),
    };
  }

  return { key: parsed.key, code: parsed.code };
}

/**
 * keyDown + keyUp 两步的 CDP 参数。
 *
 * `modifiers` 是**当前按住**的修饰键位（跨命令状态），会和 chord 自带的位合并——
 * 这样 `keyboard.down('Shift')` 之后 `press('a')` 才会得到大写 A（Playwright 同款）。
 * 单字符与 Enter/Tab/Space 在非 Ctrl/Alt/Meta 组合下带 `text`/`unmodifiedText`，
 * 否则 Chromium 不会派发 keypress/input；组合快捷键必须省略 `text`，防止误输入字符。
 */
export function keyEvents(chord: string, opts: { modifiers?: number } = {}): Array<Record<string, unknown>> {
  const parsed = parseChord(chord);
  const modifiers = parsed.modifiers | (opts.modifiers ?? 0);
  const desc = resolveKeyDescriptor(parsed, modifiers);

  const down: Record<string, unknown> = {
    type: 'keyDown',
    key: desc.key,
    code: desc.code,
    modifiers,
  };
  const up: Record<string, unknown> = {
    type: 'keyUp',
    key: desc.key,
    code: desc.code,
    modifiers,
  };
  if (desc.text !== undefined) {
    down.text = desc.text;
    down.unmodifiedText = desc.unmodifiedText ?? desc.text;
  }
  if (desc.windowsVirtualKeyCode !== undefined) {
    down.windowsVirtualKeyCode = desc.windowsVirtualKeyCode;
    down.nativeVirtualKeyCode = desc.windowsVirtualKeyCode;
    up.windowsVirtualKeyCode = desc.windowsVirtualKeyCode;
    up.nativeVirtualKeyCode = desc.windowsVirtualKeyCode;
  }
  if (desc.location !== undefined) {
    down.location = desc.location;
    up.location = desc.location;
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
