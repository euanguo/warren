import assert from 'node:assert/strict';
import test from 'node:test';
import { RefTable } from '../src/main/browser/refs.ts';

test('register 一次快照后 @1..@N 对应输出顺序', () => {
  const refs = new RefTable();
  const list = refs.register([101, 102, 103]);
  assert.deepEqual(list, ['@1', '@2', '@3']);
  assert.equal(refs.resolve('@1').backendId, 101);
  assert.equal(refs.resolve('@3').backendId, 103);
  // 没有 backendId 的节点不占号
  assert.deepEqual(refs.register([201, undefined, 203]), ['@1', '@2']);
});

test('register 会重排编号：这是「必须重拍」的语义，不是导航', () => {
  const refs = new RefTable();
  refs.register([101, 102, 103]);
  refs.register([201, 202, 203]);
  // 页没导航（gen 不变），但 @1 已经换了元素——所以内部解析绝不能调 register
  assert.equal(refs.resolve('@1').backendId, 201);
  assert.equal(refs.gen, 1);
});

test('重排后越界的旧 ref 报 TARGET_STALE，不静默指向别人', () => {
  const refs = new RefTable();
  refs.register([101, 102, 103]);
  refs.register([201]);
  assert.throws(
    () => refs.resolve('@3'),
    (e: unknown) => (e as { code?: string }).code === 'TARGET_STALE',
  );
});

test('bump 之后所有老 ref 报 TARGET_STALE', () => {
  const refs = new RefTable();
  refs.register([101, 102]);
  refs.bump();
  assert.equal(refs.gen, 2);
  assert.throws(
    () => refs.resolve('@1'),
    (e: unknown) => (e as { code?: string }).code === 'TARGET_STALE',
  );
  assert.equal(refs.has('@1'), false);
});

test('has 与 resolve 的三种写法口径一致', () => {
  const refs = new RefTable();
  refs.register([101, 102]);
  assert.equal(refs.has('@2'), true);
  assert.equal(refs.has('ref=2'), true);
  assert.equal(refs.has('2'), true);
  assert.equal(refs.has('@9'), false);
  assert.equal(refs.resolve('ref=2').backendId, 102);
});
