import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADDRESS_SUGGEST_MAX_HEIGHT,
  ADDRESS_SUGGEST_MIN_HEIGHT,
  clampPopoverHeight,
  computePopoverBounds,
  estimateAddressSuggestHeight,
  shouldFocusPopover,
  toLocalPopoverPoint,
} from '../src/main/ui/popover-layout.ts';

const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };
const WINDOW = { x: 100, y: 100, width: 1000, height: 700 };

test('Popover 默认在锚点下方展开且对齐左边界', () => {
  const out = computePopoverBounds({
    anchorRect: { x: 200, y: 80, width: 400, height: 32 },
    windowBounds: WINDOW,
    preferredSize: { width: 400, height: 240 },
    workArea: WORK_AREA,
  });
  assert.deepEqual(out, { x: 300, y: 218, width: 400, height: 240 });
});

test('下方空间不足时自动翻转到锚点上方', () => {
  const out = computePopoverBounds({
    anchorRect: { x: 200, y: 650, width: 300, height: 32 },
    windowBounds: WINDOW,
    preferredSize: { width: 300, height: 220 },
    workArea: WORK_AREA,
  });
  // anchorTop = 100 + 650 = 750; anchorBottom = 782 -> 下方距 workArea 底 (900) 仅 118，上方充足 -> 750 - 6 - 220 = 524
  assert.deepEqual(out, { x: 300, y: 524, width: 300, height: 220 });
});

test('beyondWindow=false 时把浮卡夹紧在主窗内部', () => {
  const out = computePopoverBounds({
    anchorRect: { x: 850, y: 40, width: 140, height: 30 },
    windowBounds: WINDOW,
    preferredSize: { width: 300, height: 200 },
    placement: 'bottom-start',
    beyondWindow: false,
    workArea: WORK_AREA,
  });
  // 主窗右边界 1100，margin 8 -> max x = 1100 - 8 - 300 = 792
  assert.equal(out.x, 792);
});

test('bottom-end 右对齐并支持超出主窗探入工作区', () => {
  const out = computePopoverBounds({
    anchorRect: { x: 920, y: 620, width: 60, height: 28 },
    windowBounds: WINDOW,
    preferredSize: { width: 280, height: 120 },
    placement: 'bottom-end',
    beyondWindow: true,
    workArea: WORK_AREA,
  });
  // anchorRight = 100 + 920 + 60 = 1080 -> x = 1080 - 280 = 800; y = 100 + 648 + 6 = 754; 754 + 120 = 874 <= 892
  assert.deepEqual(out, { x: 800, y: 754, width: 280, height: 120 });
});

test('shouldFocusPopover 仅当宿主主窗口本就在前台时允许聚焦子窗，避免跨应用抢焦点', () => {
  assert.equal(shouldFocusPopover(true, true), true);
  assert.equal(shouldFocusPopover(true, false), false);
  assert.equal(shouldFocusPopover(false, true), false);
  assert.equal(shouldFocusPopover(false, false), false);
});

test('estimateAddressSuggestHeight / clampPopoverHeight 动态适配最小与最大高度', () => {
  assert.equal(estimateAddressSuggestHeight(0), ADDRESS_SUGGEST_MIN_HEIGHT);
  assert.ok(estimateAddressSuggestHeight(2) < estimateAddressSuggestHeight(8));
  assert.ok(estimateAddressSuggestHeight(8) < ADDRESS_SUGGEST_MAX_HEIGHT);
  assert.equal(estimateAddressSuggestHeight(20), ADDRESS_SUGGEST_MAX_HEIGHT);
  assert.equal(clampPopoverHeight(140.2), 141);
  assert.equal(clampPopoverHeight(20), ADDRESS_SUGGEST_MIN_HEIGHT);
  assert.equal(clampPopoverHeight(500), ADDRESS_SUGGEST_MAX_HEIGHT);
});

test('toLocalPopoverPoint 准确转换窗内坐标并在窗外返回 null', () => {
  const bounds = { x: 200, y: 120, width: 400, height: 240 };
  assert.deepEqual(toLocalPopoverPoint({ x: 250, y: 180 }, bounds), { x: 50, y: 60 });
  assert.equal(toLocalPopoverPoint({ x: 199, y: 180 }, bounds), null);
  assert.equal(toLocalPopoverPoint({ x: 600, y: 180 }, bounds), null);
  assert.equal(toLocalPopoverPoint({ x: 250, y: 360 }, bounds), null);
});
