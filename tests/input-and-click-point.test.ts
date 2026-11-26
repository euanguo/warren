import test from 'node:test';
import assert from 'node:assert/strict';
import { keyEvents, parseChord, resolveKeyDescriptor } from '../src/main/browser/input.ts';
import {
  clearPendingRelease,
  hasPendingRelease,
  setPendingRelease,
  takePendingRelease,
} from '../src/main/browser/mouse-state.ts';
import {
  findIntegerPointInsideQuad,
  isPointInsideQuad,
  largestQuad,
  quadArea,
  quadCenter,
} from '../src/main/browser/click-point.ts';

test('US 键盘 OEM 标点映射正确：句点 . 是 VK 190 绝非 VK_DELETE(46)', () => {
  const [dotDown] = keyEvents('.');
  assert.equal(dotDown?.code, 'Period');
  assert.equal(dotDown?.windowsVirtualKeyCode, 190);
  assert.equal(dotDown?.text, '.');

  const [slashDown] = keyEvents('/');
  assert.equal(slashDown?.code, 'Slash');
  assert.equal(slashDown?.windowsVirtualKeyCode, 191);

  const [qDown] = keyEvents('?');
  assert.equal(qDown?.code, 'Slash');
  assert.equal(qDown?.windowsVirtualKeyCode, 191);
  assert.equal(qDown?.text, '?');
  assert.equal(qDown?.unmodifiedText, '/');
});

test('命名键补齐 VK 码、text、别名与左右修饰键 location', () => {
  const [enterDown] = keyEvents('Enter');
  assert.equal(enterDown?.windowsVirtualKeyCode, 13);
  assert.equal(enterDown?.text, '\r');

  const [tabDown] = keyEvents('Tab');
  assert.equal(tabDown?.windowsVirtualKeyCode, 9);
  assert.equal(tabDown?.text, '\t');

  const [spaceDown] = keyEvents('Space');
  assert.equal(spaceDown?.key, ' ');
  assert.equal(spaceDown?.code, 'Space');
  assert.equal(spaceDown?.windowsVirtualKeyCode, 32);
  assert.equal(spaceDown?.text, ' ');

  assert.equal(parseChord('Esc').key, 'Escape');
  assert.equal(parseChord('Return').key, 'Enter');
  assert.equal(parseChord('Up').key, 'ArrowUp');
  assert.equal(parseChord('Ctrl+a').modifiers, 2);
  assert.equal(parseChord('Cmd+s').modifiers, 4);

  const [shiftRightDown] = keyEvents('ShiftRight');
  assert.equal(shiftRightDown?.location, 2);
  assert.equal(shiftRightDown?.windowsVirtualKeyCode, 16);

  const [delDown] = keyEvents('Delete');
  assert.equal(delDown?.windowsVirtualKeyCode, 46);
  assert.equal(delDown?.text, undefined);
});

test('Control/Alt/Meta 组合快捷键绝不发送 text，避免编辑器误插入字符', () => {
  for (const chord of ['Control+a', 'Meta+c', 'Alt+f', 'Control+Enter']) {
    const [down] = keyEvents(chord);
    assert.equal(down?.text, undefined, `${chord} 不应带 text`);
    assert.equal(down?.unmodifiedText, undefined, `${chord} 不应带 unmodifiedText`);
  }
  // 按住 Shift + 标点仍产生 Shift 字符
  const desc = resolveKeyDescriptor(parseChord('1'), 8);
  assert.equal(desc.key, '!');
  assert.equal(desc.text, '!');
  assert.equal(desc.windowsVirtualKeyCode, 49);
});

test('PendingRelease 按 WebContents id 独立记录与一次性消费', () => {
  clearPendingRelease(999);
  assert.equal(hasPendingRelease(999), false);
  setPendingRelease(999, { x: 120, y: 80, button: 'left', clickCount: 1 });
  assert.equal(hasPendingRelease(999), true);
  assert.deepEqual(takePendingRelease(999), { x: 120, y: 80, button: 'left', clickCount: 1 });
  assert.equal(hasPendingRelease(999), false);
  assert.equal(takePendingRelease(999), undefined);
});

test('click-point 几何函数：多行折行最大多边形 + 旋转菱形内部整点', () => {
  // 模拟跨两行折行链接：第一行短(30x20=600)，第二行长(200x20=4000)
  const q1 = [100, 10, 130, 10, 130, 30, 100, 30];
  const q2 = [10, 30, 210, 30, 210, 50, 10, 50];
  assert.equal(quadArea(q1), 600);
  assert.equal(quadArea(q2), 4000);
  assert.deepEqual(largestQuad([q1, q2]), q2);
  assert.deepEqual(quadCenter(q2), { x: 110, y: 40 });

  // 旋转 45 度菱形
  const diamond = [50, 10, 90, 50, 50, 90, 10, 50];
  assert.equal(isPointInsideQuad(50, 50, diamond), true);
  assert.equal(isPointInsideQuad(15, 15, diamond), false);
  const pt = findIntegerPointInsideQuad(diamond);
  assert.equal(Number.isInteger(pt.x) && Number.isInteger(pt.y), true);
  assert.equal(isPointInsideQuad(pt.x, pt.y, diamond), true);
});
