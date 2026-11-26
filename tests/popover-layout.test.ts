import test from 'node:test';
import assert from 'node:assert/strict';
import { computePopoverBounds } from '../src/main/ui/popover-layout.ts';

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
