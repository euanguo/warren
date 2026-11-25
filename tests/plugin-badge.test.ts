import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginPluginLoad,
  getPluginBadgeSnapshot,
  prunePluginBadges,
  registerPluginBadgeSurface,
  setPluginEnvBadge,
} from '../src/renderer/lib/plugin-badges.ts';

test('badge：同 digest 重载不清，digest 变化清掉，stale setter 被忽略', () => {
  prunePluginBadges(new Set());
  const first = beginPluginLoad('com.example.badge', 'd1');
  registerPluginBadgeSurface('com.example.badge', first, 'todos');
  setPluginEnvBadge('com.example.badge', first, 'todos', 'env-a', { label: '3' });
  assert.equal(getPluginBadgeSnapshot()['com.example.badge']?.['env-a']?.label, '3');

  // 同 digest 再 load：generation 不变，badge 保留
  const same = beginPluginLoad('com.example.badge', 'd1');
  assert.equal(same, first);
  assert.equal(getPluginBadgeSnapshot()['com.example.badge']?.['env-a']?.label, '3');

  // digest 变了：旧 badge 清掉，旧 setter 不能再写
  const next = beginPluginLoad('com.example.badge', 'd2');
  assert.notEqual(next, first);
  assert.equal(getPluginBadgeSnapshot()['com.example.badge'], undefined);
  setPluginEnvBadge('com.example.badge', first, 'todos', 'env-a', { label: '9' });
  assert.equal(getPluginBadgeSnapshot()['com.example.badge'], undefined);
});

test('badge：label 截到 3 字符；多 surface 按声明顺序取第一个', () => {
  prunePluginBadges(new Set());
  const generation = beginPluginLoad('com.example.badge2', 'd1');
  registerPluginBadgeSurface('com.example.badge2', generation, 'first');
  registerPluginBadgeSurface('com.example.badge2', generation, 'second');
  setPluginEnvBadge('com.example.badge2', generation, 'second', 'env-a', { label: 'B' });
  setPluginEnvBadge('com.example.badge2', generation, 'first', 'env-a', { label: '12345' });
  assert.equal(getPluginBadgeSnapshot()['com.example.badge2']?.['env-a']?.label, '123');
});

test('badge：多插件按 pluginId 稳定排序；prune 后立刻消失', () => {
  prunePluginBadges(new Set());
  const z = beginPluginLoad('z.example', 'd1');
  const a = beginPluginLoad('a.example', 'd1');
  registerPluginBadgeSurface('z.example', z, 'x');
  registerPluginBadgeSurface('a.example', a, 'x');
  setPluginEnvBadge('z.example', z, 'x', 'env-a', { label: 'Z' });
  setPluginEnvBadge('a.example', a, 'x', 'env-a', { label: 'A' });
  assert.deepEqual(Object.keys(getPluginBadgeSnapshot()), ['a.example', 'z.example']);

  prunePluginBadges(new Set(['a.example']));
  assert.deepEqual(Object.keys(getPluginBadgeSnapshot()), ['a.example']);
});
