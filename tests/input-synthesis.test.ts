import test from 'node:test';
import assert from 'node:assert/strict';
import { inputPathEnabled, mousePath, STEP_DELAY_MS } from '../src/main/browser/input-synthesis.ts';

test('路径含终点不含起点，终点精确落在目标上', () => {
  const path = mousePath({ x: 10, y: 10 }, { x: 210, y: 90 });
  assert.ok(path.length >= 3, `中间点太少：${path.length}`);
  assert.deepEqual(path.at(-1), { x: 210, y: 90 });
  assert.notDeepEqual(path[0], { x: 10, y: 10 });
});

test('距离越远中间点越多，但有上下限', () => {
  const near = mousePath({ x: 0, y: 0 }, { x: 5, y: 0 });
  const far = mousePath({ x: 0, y: 0 }, { x: 5000, y: 0 });
  assert.ok(far.length > near.length);
  assert.ok(near.length >= 3, '近处也至少要有几个点');
  assert.ok(far.length <= 16, '远处不能无限多（每次点击的开销要可控）');
});

test('原地点击退化成单点（不引入无谓的移动）', () => {
  assert.deepEqual(mousePath({ x: 5, y: 5 }, { x: 5, y: 5 }), [{ x: 5, y: 5 }]);
});

test('是弧线不是直线：中间点偏离两点连线', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 400, y: 0 };
  const mid = mousePath(from, to).at(Math.floor(mousePath(from, to).length / 2))!;
  assert.notEqual(mid.y, 0, '中间点应该偏离直线');
  assert.ok(Math.abs(mid.y) <= 24, '偏移幅度要有上限，别飘到别的元素上');
});

test('横向移动的 y 不漂、纵向移动的 x 不漂（别把点击带偏）', () => {
  const horizontal = mousePath({ x: 0, y: 50 }, { x: 300, y: 50 });
  assert.ok(horizontal.every((p) => Math.abs(p.y - 50) <= 24));
  const vertical = mousePath({ x: 50, y: 0 }, { x: 50, y: 300 });
  assert.ok(vertical.every((p) => Math.abs(p.x - 50) <= 24));
});

test('开销可预期：steps × STEP_DELAY_MS 是每次点击多出来的时间', () => {
  const worst = 16 * STEP_DELAY_MS;
  assert.ok(worst <= 200, `最坏开销 ${worst}ms，太慢了`);
});

test('WARREN_INPUT_PATH=0 关掉，其它值开着', () => {
  assert.equal(inputPathEnabled({}), true);
  assert.equal(inputPathEnabled({ WARREN_INPUT_PATH: '1' }), true);
  assert.equal(inputPathEnabled({ WARREN_INPUT_PATH: '0' }), false);
});
