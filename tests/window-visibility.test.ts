import assert from 'node:assert/strict';
import test from 'node:test';
import {
  placeWindowOnItsDisplay,
  shouldEmulateRenderFocus,
  type DisplayFrame,
} from '../src/main/ui/window-visibility.ts';

const LAPTOP: DisplayFrame = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 25, width: 1512, height: 877 },
};

const EXTERNAL: DisplayFrame = {
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
};

const BOTH = [LAPTOP, EXTERNAL];

test('整扇在外接屏上时保持原位', () => {
  const onExternal = { x: -1700, y: 80, width: 1440, height: 920 };
  assert.deepEqual(placeWindowOnItsDisplay(onExternal, BOTH), onExternal);
});

test('跨两块屏时保持原位', () => {
  const straddling = { x: -200, y: 40, width: 1440, height: 920 };
  assert.deepEqual(placeWindowOnItsDisplay(straddling, BOTH), straddling);
});

test('坐标落在不存在的远端显示器上时回到距它最近的那块屏，而不是主屏', () => {
  const detached = { x: -5000, y: -3000, width: 1440, height: 920 };
  assert.deepEqual(placeWindowOnItsDisplay(detached, BOTH), {
    x: -1920 + Math.round((1920 - 1440) / 2),
    y: 0 + Math.round((1080 - 920) / 2),
    width: 1440,
    height: 920,
  });
});

test('外接屏拔掉后窗口坐标悬空时拉回主屏工作区中央', () => {
  const unpluggedExternal = { x: -1700, y: 80, width: 1440, height: 920 };
  assert.deepEqual(placeWindowOnItsDisplay(unpluggedExternal, [LAPTOP]), {
    x: Math.round((1512 - 1440) / 2),
    y: 25,
    width: 1440,
    height: 877,
  });
});

test('没有显示器信息时不改坐标', () => {
  const bounds = { x: -1700, y: 80, width: 1440, height: 920 };
  assert.deepEqual(placeWindowOnItsDisplay(bounds, []), bounds);
});

test('shouldEmulateRenderFocus：仅前台聚焦且为当前显示 Space 时不启用焦点仿真', () => {
  assert.equal(
    shouldEmulateRenderFocus({ windowVisible: true, windowFocused: true, isSelected: true, isActiveSpace: true }),
    false,
  );
  assert.equal(
    shouldEmulateRenderFocus({ windowVisible: false, windowFocused: false, isSelected: true, isActiveSpace: true }),
    true,
  );
  assert.equal(
    shouldEmulateRenderFocus({ windowVisible: false, windowFocused: true, isSelected: true, isActiveSpace: true }),
    true,
  );
  assert.equal(
    shouldEmulateRenderFocus({ windowVisible: true, windowFocused: false, isSelected: true, isActiveSpace: true }),
    true,
  );
  assert.equal(
    shouldEmulateRenderFocus({ windowVisible: true, windowFocused: true, isSelected: false, isActiveSpace: true }),
    true,
  );
  assert.equal(
    shouldEmulateRenderFocus({ windowVisible: true, windowFocused: true, isSelected: true, isActiveSpace: false }),
    true,
  );
});
