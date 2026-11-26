import test from 'node:test';
import assert from 'node:assert/strict';
import { TabList, closeSet } from '../src/main/domain/tabs.ts';
import type { TabState } from '../src/shared/types.ts';

const NOW = '2026-01-01T00:00:00.000Z';

function tab(id: string): TabState {
  return {
    id,
    space: 'person',
    title: id,
    url: `https://example.com/${id}`,
    loading: false,
    audible: false,
    muted: false,
    createdAt: NOW,
  };
}

function listOf(...ids: string[]): TabList {
  const list = new TabList();
  for (const id of ids) list.add(tab(id), { activate: false });
  return list;
}

test('第一个标签无条件激活，后面的按 activate 决定', () => {
  const list = new TabList();
  list.add(tab('a'), { activate: false });
  assert.equal(list.activeId, 'a', '第一个标签必须激活，否则环境启动了却没有页面在前台');

  list.add(tab('b'), { activate: false });
  assert.equal(list.activeId, 'a', '后台标签不抢激活');

  list.add(tab('c'), { activate: true });
  assert.equal(list.activeId, 'c');
});

test('关掉当前标签选右边邻居', () => {
  const list = listOf('a', 'b', 'c');
  list.select('b');

  const result = list.remove('b');
  assert.equal(result.empty, false);
  assert.equal(result.nextActiveId, 'c', '右边邻居优先');
  assert.equal(list.activeId, 'c');
  assert.deepEqual(
    list.list.map((item) => item.id),
    ['a', 'c'],
  );
});

test('关掉最右边那个则选左边', () => {
  const list = listOf('a', 'b', 'c');
  list.select('c');

  assert.equal(list.remove('c').nextActiveId, 'b');
});

test('关掉非当前标签不动激活', () => {
  const list = listOf('a', 'b', 'c');
  list.select('c');

  const result = list.remove('a');
  assert.equal(result.nextActiveId, 'c');
  assert.equal(list.activeId, 'c');
});

test('关掉最后一个标签返回 empty，激活清空', () => {
  const list = listOf('a');
  list.select('a');

  const result = list.remove('a');
  assert.equal(result.empty, true, 'empty=true 时调用方要停掉整个环境');
  assert.equal(list.activeId, undefined);
  assert.equal(list.size, 0);
});

test('关掉不存在的标签是幂等的', () => {
  const list = listOf('a', 'b');
  list.select('a');

  const result = list.remove('nope');
  assert.equal(result.empty, false);
  assert.equal(result.nextActiveId, 'a');
  assert.equal(list.size, 2);
});

test('select 只接受已知 id', () => {
  const list = listOf('a', 'b');
  assert.equal(list.select('b'), true);
  assert.equal(list.activeId, 'b');
  assert.equal(list.select('nope'), false);
  assert.equal(list.activeId, 'b', '失败的 select 不能改变激活');
});

test('resolve 支持 1-based 序号和 tabId', () => {
  const list = listOf('a', 'b', 'c');
  assert.equal(list.resolve(1), 'a');
  assert.equal(list.resolve(3), 'c');
  assert.equal(list.resolve('2'), 'b', '数字字符串按序号解析，和 ⌘1..9 一致');
  assert.equal(list.resolve('b'), 'b', '非数字字符串按 tabId 解析');
  assert.equal(list.resolve(0), undefined);
  assert.equal(list.resolve(4), undefined);
  assert.equal(list.resolve('nope'), undefined);
});

test('update 改字段但不动 id，未知 id 返回 false', () => {
  const list = listOf('a');
  assert.equal(list.update('a', { title: '改过了', loading: true }), true);
  assert.equal(list.get('a')?.title, '改过了');
  assert.equal(list.get('a')?.loading, true);
  assert.equal(list.update('nope', { title: 'x' }), false);
});

test('reorder 只改顺序，不动激活', () => {
  const list = listOf('a', 'b', 'c');
  list.select('b');

  assert.equal(list.reorder(0, 2), true, '把第一个挪到最后');
  assert.deepEqual(
    list.list.map((item) => item.id),
    ['b', 'c', 'a'],
  );
  assert.equal(list.activeId, 'b', '拖拽排序不能让当前标签换人');
});

test('reorder 越界返回 false 且不改动', () => {
  const list = listOf('a', 'b');
  assert.equal(list.reorder(0, 2), false);
  assert.equal(list.reorder(-1, 0), false);
  assert.equal(list.reorder(1, 1), true, '挪到自己身上是合法的空操作');
  assert.deepEqual(
    list.list.map((item) => item.id),
    ['a', 'b'],
  );
});

test('closeSet 给出「关闭其他 / 关闭右侧」的目标，顺序从右往左', () => {
  const tabs = listOf('a', 'b', 'c', 'd').list;

  assert.deepEqual(closeSet(tabs, 'b', 'others'), ['d', 'c', 'a'], '从右往左，逐个关不掉下标');
  assert.deepEqual(closeSet(tabs, 'b', 'right'), ['d', 'c']);
  assert.deepEqual(closeSet(tabs, 'd', 'right'), [], '最右一个的右边是空的');
  assert.deepEqual(closeSet(tabs, 'nope', 'others'), [], '未知 id 不猜');
});
