import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_MENU_SHORTCUTS, browserShortcut, type BrowserShortcutInput } from '../src/main/browser-shortcuts.ts';

function key(
  value: string,
  mods: Partial<Pick<BrowserShortcutInput, 'alt' | 'meta' | 'control' | 'shift'>> = {},
  type = 'keyDown',
): BrowserShortcutInput {
  return { type, key: value, alt: false, meta: false, control: false, shift: false, ...mods };
}

test('⌥⌘I / ⌥⌘J 认成 devtools / inspector', () => {
  assert.equal(browserShortcut(key('i', { alt: true, meta: true })), 'devtools');
  assert.equal(browserShortcut(key('J', { alt: true, meta: true })), 'inspector', '大小写都要认');
  assert.equal(browserShortcut(key('i', { alt: true, meta: true, shift: true })), null, '⌥⇧⌘I 不是我们的键');
});

test('⌘1..9 认成切标签，序号就是按下的数字', () => {
  assert.deepEqual(browserShortcut(key('1', { meta: true })), { selectTab: 1 });
  assert.deepEqual(browserShortcut(key('9', { control: true })), { selectTab: 9 }, 'Windows/Linux 走 ctrl');
  assert.equal(browserShortcut(key('0', { meta: true })), null, '⌘0 不是切标签');
});

test('菜单承载的键不在这个函数里认（macOS 上它们到不了页面）', () => {
  for (const value of ['t', 'w', 'r', 'l']) {
    assert.equal(browserShortcut(key(value, { meta: true })), null, `⌘${value.toUpperCase()} 归应用菜单`);
  }
});

test('编辑类快捷键和 keyUp 一律不认，免得吞掉页面的按键', () => {
  assert.equal(browserShortcut(key('c', { meta: true })), null);
  assert.equal(browserShortcut(key('v', { meta: true })), null);
  assert.equal(browserShortcut(key('a', { meta: true })), null);
  assert.equal(browserShortcut(key('t', { meta: true }, 'keyUp')), null);
  assert.equal(browserShortcut(key('i', { alt: true, meta: true }, 'keyUp')), null);
  assert.equal(browserShortcut(key('1', { meta: true, shift: true })), null, '⌘⇧1 不是切标签');
});

test('菜单里的加速键不重复（重复的话先注册的赢，另一个静默失效）', () => {
  const accelerators = BROWSER_MENU_SHORTCUTS.map((item) => item.accelerator);
  assert.equal(new Set(accelerators).size, accelerators.length);
  assert.equal(new Set(BROWSER_MENU_SHORTCUTS.map((item) => item.shortcut)).size, accelerators.length);
  assert.ok(
    BROWSER_MENU_SHORTCUTS.some(
      (item) => item.shortcut === 'quickAutofill' && item.accelerator === 'CmdOrCtrl+Shift+L',
    ),
    '菜单应注册 CmdOrCtrl+Shift+L 快捷填充快捷键',
  );
});
