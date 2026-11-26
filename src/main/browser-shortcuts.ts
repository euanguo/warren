import type { BrowserShortcut } from '../shared/types';

/** Native key event fields used by Electron's `before-input-event`. */
export interface BrowserShortcutInput {
  type: string;
  key: string;
  alt: boolean;
  meta: boolean;
  control: boolean;
  shift: boolean;
}

/**
 * 页面里按下的、我们能认出来的浏览器快捷键。认不出来返回 null（键事件原样交给页面）。
 *
 * 这里只认**不在应用菜单里**的键：⌥⌘I / ⌥⌘J（DevTools / 检查器）和 ⌘1..9（切标签）。
 * 菜单里的加速键（⌘T / ⌘W / ⌘R / ⌘L）在 macOS 上先被 NSMenu 吃掉，走不到这里 —— 见
 * `BROWSER_MENU_SHORTCUTS`。
 */
export function browserShortcut(input: BrowserShortcutInput): BrowserShortcut | null {
  if (input.type !== 'keyDown') return null;
  const key = input.key.toLowerCase();
  if (input.alt && input.meta && !input.control && !input.shift) {
    if (key === 'i') return 'devtools';
    if (key === 'j') return 'inspector';
    return null;
  }
  if ((input.meta || input.control) && !input.alt && !input.shift && /^[1-9]$/.test(key)) {
    return { selectTab: Number(key) };
  }
  return null;
}

/**
 * 应用菜单承载的浏览器快捷键。
 *
 * **⌘R / ⌘W 必须放在菜单里**：Electron 默认菜单的 `reload` / `close` 就是这两个键，
 * macOS 上菜单加速键先于页面拿到按键，留在 `before-input-event` 里会被抢走
 * （症状是 ⌘R 重载了整个应用界面，而不是当前页面）。所以默认菜单里那两个 role 要撤掉，
 * 换成这一组。
 */
export const BROWSER_MENU_SHORTCUTS = [
  { shortcut: 'newTab', accelerator: 'CmdOrCtrl+T', label: '新建标签' },
  { shortcut: 'closeTab', accelerator: 'CmdOrCtrl+W', label: '关闭标签' },
  { shortcut: 'reopenTab', accelerator: 'CmdOrCtrl+Shift+T', label: '重新打开关掉的标签' },
  { shortcut: 'reload', accelerator: 'CmdOrCtrl+R', label: '重新加载页面' },
  { shortcut: 'hardReload', accelerator: 'CmdOrCtrl+Shift+R', label: '忽略缓存硬刷新' },
  { shortcut: 'focusAddress', accelerator: 'CmdOrCtrl+L', label: '聚焦地址栏' },
  { shortcut: 'commandBar', accelerator: 'CmdOrCtrl+K', label: '命令栏' },
  { shortcut: 'find', accelerator: 'CmdOrCtrl+F', label: '在页面中查找' },
  { shortcut: 'findNext', accelerator: 'CmdOrCtrl+G', label: '查找下一个' },
  { shortcut: 'findPrev', accelerator: 'CmdOrCtrl+Shift+G', label: '查找上一个' },
  { shortcut: 'zoomIn', accelerator: 'CmdOrCtrl+=', label: '放大页面' },
  { shortcut: 'zoomOut', accelerator: 'CmdOrCtrl+-', label: '缩小页面' },
  { shortcut: 'zoomReset', accelerator: 'CmdOrCtrl+0', label: '实际大小' },
  { shortcut: 'print', accelerator: 'CmdOrCtrl+P', label: '打印或存为 PDF' },
  { shortcut: 'savePage', accelerator: 'CmdOrCtrl+S', label: '将页面另存为' },
  { shortcut: 'quickAutofill', accelerator: 'CmdOrCtrl+Shift+L', label: '快捷填充账号' },
] as const satisfies ReadonlyArray<{
  shortcut: BrowserShortcut;
  accelerator: string;
  label: string;
}>;
