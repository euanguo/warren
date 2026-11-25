import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentConfig } from '../src/main/domain/environment.ts';
import {
  createGroup,
  detachGroupEnvironments,
  groupIdFromName,
  moveToGroup,
  nextOrder,
  renameGroup,
  reorderBy,
  setGroupCollapsed,
  validateGroupName,
} from '../src/main/domain/group.ts';

const NOW = '2026-01-01T00:00:00.000Z';

function env(id: string, groupId?: string, order = 0) {
  return {
    ...createEnvironmentConfig({ id, storagePath: `/tmp/${id}`, now: NOW }),
    groupId,
    order,
  };
}

test('group name is validated and trimmed', () => {
  assert.equal(validateGroupName('  生产  '), undefined);
  assert.match(validateGroupName('   ')!, /不能为空/);
  assert.match(validateGroupName('x'.repeat(41))!, /不能超过/);
  assert.equal(createGroup({ name: '  生产  ', now: NOW }).name, '生产');
});

test('group id derives from name, falls back for non-ascii', () => {
  assert.equal(groupIdFromName('Prod Web'), 'prod-web');
  // 中文名清空后回退到随机串，不能产出空 id
  const id = groupIdFromName('生产');
  assert.ok(id.startsWith('g-'));
  assert.ok(id.length > 2);
});

test('createGroup rejects empty name and starts expanded', () => {
  assert.throws(() => createGroup({ name: '  ' }), /不能为空/);
  const group = createGroup({ name: '生产', now: NOW });
  assert.equal(group.collapsed, false);
  assert.equal(group.createdAt, NOW);
});

test('rename and collapse bump updatedAt only', () => {
  const group = createGroup({ name: '生产', now: NOW });
  const renamed = renameGroup(group, '线上', '2026-02-02T00:00:00.000Z');
  assert.equal(renamed.name, '线上');
  assert.equal(renamed.id, group.id, '重命名不应改 id');
  assert.equal(renamed.updatedAt, '2026-02-02T00:00:00.000Z');

  const collapsed = setGroupCollapsed(group, true, '2026-02-02T00:00:00.000Z');
  assert.equal(collapsed.collapsed, true);
  assert.equal(collapsed.name, group.name);
});

test('nextOrder appends after the max, empty set is 0', () => {
  assert.equal(nextOrder([]), 0);
  assert.equal(nextOrder([{ order: 0 }, { order: 7 }, { order: 3 }]), 8);
});

test('moveToGroup appends to end of target group', () => {
  const groups = [createGroup({ id: 'g1', name: 'A', order: 0 }), createGroup({ id: 'g2', name: 'B', order: 1 })];
  const siblings = [env('a', 'g2', 0), env('b', 'g2', 1)];
  const moved = moveToGroup(env('c'), 'g2', groups, siblings);
  assert.equal(moved.groupId, 'g2');
  assert.equal(moved.order, 2, '应排在目标组末尾');
});

test('moveToGroup with undefined detaches the environment', () => {
  const moved = moveToGroup(env('a', 'g1', 3), undefined, [], []);
  assert.equal(moved.groupId, undefined);
  assert.equal(moved.order, 0);
});

test('moveToGroup refuses an unknown group instead of silently hiding it', () => {
  assert.throws(
    () => moveToGroup(env('a'), 'nope', [], []),
    (error: Error & { code?: string }) => error.code === 'GROUP_NOT_FOUND',
  );
});

test('reorderBy honours the given ids and keeps the rest after them', () => {
  const items = [
    { id: 'a', order: 0 },
    { id: 'b', order: 1 },
    { id: 'c', order: 2 },
  ];
  assert.deepEqual(
    reorderBy(items, ['c', 'a']).map((i) => i.id),
    ['c', 'a', 'b'],
  );
  // 未列出的 id 按原 order 排在后面
  assert.deepEqual(
    reorderBy(items, ['b']).map((i) => i.id),
    ['b', 'a', 'c'],
  );
  // 未知 id 被忽略，不抛错——一次拖拽失败不该把整个列表搞乱
  assert.deepEqual(
    reorderBy(items, ['zzz']).map((i) => i.id),
    ['a', 'b', 'c'],
  );
});

test('removing a group keeps its environments and detaches them', () => {
  const environments = [env('a', 'g1', 0), env('b', 'g1', 1), env('c', 'g2', 0)];
  const after = detachGroupEnvironments(environments, 'g1', NOW);
  assert.equal(after.length, 3, '不能删掉环境');
  assert.equal(after.find((e) => e.id === 'a')!.groupId, undefined);
  assert.equal(after.find((e) => e.id === 'b')!.groupId, undefined);
  assert.equal(after.find((e) => e.id === 'c')!.groupId, 'g2', '别的组不受影响');
  // 移出后重新编号，避免与原组序号冲突
  assert.deepEqual(
    after.filter((e) => !e.groupId).map((e) => e.order),
    [0, 1],
  );
});
