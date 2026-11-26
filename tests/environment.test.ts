import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireLease,
  assertEnvironmentId,
  canMutate,
  createEnvironmentConfig,
  diagnoseLease,
  ENVIRONMENT_NAME_MAX,
  isEnvironmentId,
  leaseDenialError,
  pickDormant,
  pickEvictions,
  renewLease,
  releaseLease,
  safeEnvKey,
  toEnvironment,
} from '../src/main/domain/environment.ts';

test('environment starts stopped and unowned', () => {
  const config = createEnvironmentConfig({
    id: 'alpha',
    storagePath: '/tmp/alpha',
    now: '2026-01-01T00:00:00.000Z',
  });
  const environment = toEnvironment(config);
  assert.equal(environment.status, 'stopped');
  assert.equal(environment.owner, 'none');
});

test('environment lease allows only its owner to mutate', () => {
  const config = createEnvironmentConfig({ id: 'alpha', storagePath: '/tmp/alpha' });
  const environment = acquireLease(toEnvironment(config), 'agent', 'lease-1', 10_000, 1000);
  assert.equal(canMutate(environment, 'agent', 'lease-1'), true);
  assert.equal(canMutate(environment, 'human', 'lease-1'), false);
  assert.throws(() => acquireLease(environment, 'human', 'lease-2', 10_000, 1001), /ENV_BUSY/);
});

test('expired lease can be replaced and old lease cannot release it', () => {
  const config = createEnvironmentConfig({ id: 'alpha', storagePath: '/tmp/alpha' });
  const first = acquireLease(toEnvironment(config), 'agent', 'lease-1', 10, 1000);
  const second = acquireLease(first, 'human', 'lease-2', 10_000, 1011);
  assert.equal(second.owner, 'human');
  assert.throws(() => releaseLease(second, 'lease-1', 1012), /CONTROL_REVOKED/);
  assert.equal(releaseLease(second, 'lease-2', 1012).owner, 'none');
});

test('environment name is clamped instead of rejected', () => {
  // CLI 脚本批量建环境时，一个超长名字不该中断整批
  const long = 'x'.repeat(200);
  const config = createEnvironmentConfig({ id: 'a', name: long, storagePath: '/tmp/a' });
  assert.equal(config.name!.length, ENVIRONMENT_NAME_MAX);
  assert.ok(config.name!.endsWith('…'), '超长要能看出被截了');
});

test('a blank environment name falls back instead of rendering empty', () => {
  const config = createEnvironmentConfig({ id: 'a', name: '   ', storagePath: '/tmp/a' });
  assert.equal(config.name, '未命名');
});

test('environment id validation rejects path traversal and keeps safe path keys', () => {
  for (const id of ['', '.', '..', 'a/b', '/abs', 'a\\b', '../x', '.hidden']) {
    assert.equal(isEnvironmentId(id), false, `${JSON.stringify(id)} 不是合法 id`);
    assert.throws(
      () => assertEnvironmentId(id),
      (error: Error & { code?: string }) => error.code === 'BAD_REQUEST',
    );
  }
  for (const id of ['alpha', 'a1', 'my.env', 'my-env']) {
    assert.equal(isEnvironmentId(id), true);
    assert.equal(safeEnvKey(id), id, '正常 id 原样使用');
  }
  const escaped = safeEnvKey('../../../../tmp/warren-escape');
  assert.equal(escaped.includes('/'), false);
  assert.equal(escaped.includes('..'), false);
  assert.match(escaped, /^[a-f0-9]{64}$/);
});

test('renewLease 只推到期时间，leaseId 和 owner 不动', () => {
  const config = createEnvironmentConfig({ id: 'alpha', storagePath: '/tmp/alpha' });
  const leased = acquireLease(toEnvironment(config), 'agent', 'lease-1', 10_000, 1000);
  const renewed = renewLease(leased, 'lease-1', 60_000, 5000);
  assert.equal(renewed.leaseId, 'lease-1', '续租不能换 leaseId，否则 CLI 手上的那个立刻作废');
  assert.equal(renewed.owner, 'agent');
  assert.equal(renewed.leaseExpiresAt, 65_000);
  assert.equal(leased.leaseExpiresAt, 11_000, '不能就地改原对象');
});

test('renewLease 拒绝别人的 leaseId 与已过期的 lease', () => {
  const config = createEnvironmentConfig({ id: 'alpha', storagePath: '/tmp/alpha' });
  const leased = acquireLease(toEnvironment(config), 'agent', 'lease-1', 10_000, 1000);
  assert.throws(() => renewLease(leased, 'lease-2', 10_000, 2000), /CONTROL_REVOKED/);
  assert.throws(() => renewLease(leased, 'lease-1', 10_000, 99_999), /ENV_NOT_LEASED/);
});

// ── lease 被拒的原因（ENV_NOT_LEASED / CONTROL_REVOKED 共用） ─────────────
// 五个 reason 都要能从「环境的 lease 状态」推出来：agent 靠它决定是重取还是等人交还。

const now = 10_000;

test('diagnoseLease：没 lease → never_leased', () => {
  const denial = diagnoseLease({
    environmentId: 'alpha',
    lease: undefined,
    providedLeaseId: undefined,
    space: 'agent',
    now,
  });
  assert.equal(denial?.reason, 'never_leased');
  assert.equal(denial?.code, 'ENV_NOT_LEASED', '错误码保持不变');
  assert.match(denial!.message, /warren env acquire alpha/, '消息里要带下一步命令');
});

test('diagnoseLease：到期 → expired，带 expiredAt', () => {
  const denial = diagnoseLease({
    environmentId: 'alpha',
    lease: { leaseId: 'lease-1', owner: 'agent', space: 'agent', expiresAt: 9_000 },
    providedLeaseId: 'lease-1',
    space: 'agent',
    now,
  });
  assert.equal(denial?.reason, 'expired');
  assert.equal(denial?.code, 'ENV_NOT_LEASED');
  assert.equal(denial?.expiredAt, 9_000);
  assert.match(denial!.message, /过期/);
});

test('diagnoseLease：leaseId 对不上且 owner 还是 agent → superseded', () => {
  const denial = diagnoseLease({
    environmentId: 'alpha',
    lease: { leaseId: 'lease-2', owner: 'agent', space: 'agent', expiresAt: 99_000 },
    providedLeaseId: 'lease-1',
    space: 'agent',
    now,
  });
  assert.equal(denial?.reason, 'superseded');
  assert.equal(denial?.code, 'CONTROL_REVOKED');
});

test('diagnoseLease：leaseId 对不上且 owner 是人 → user_takeover', () => {
  const denial = diagnoseLease({
    environmentId: 'alpha',
    lease: { leaseId: 'lease-2', owner: 'human', space: 'agent', expiresAt: 99_000 },
    providedLeaseId: 'lease-1',
    space: 'agent',
    now,
  });
  assert.equal(denial?.reason, 'user_takeover');
  assert.equal(denial?.code, 'CONTROL_REVOKED');
  assert.match(denial!.message, /人工接管/);
});

test('diagnoseLease：lease 属于别的 space → wrong_space', () => {
  const denial = diagnoseLease({
    environmentId: 'alpha',
    lease: { leaseId: 'lease-1', owner: 'agent', space: 'person', expiresAt: 99_000 },
    providedLeaseId: 'lease-1',
    space: 'agent',
    now,
  });
  assert.equal(denial?.reason, 'wrong_space');
  assert.equal(denial?.code, 'CONTROL_REVOKED');
});

test('diagnoseLease：一切正常时返回 undefined', () => {
  assert.equal(
    diagnoseLease({
      environmentId: 'alpha',
      lease: { leaseId: 'lease-1', owner: 'agent', space: 'agent', expiresAt: 99_000 },
      providedLeaseId: 'lease-1',
      space: 'agent',
      now,
    }),
    undefined,
  );
});

test('leaseDenialError 把 reason / expiredAt 挂到 Error 上（RPC 才能转发）', () => {
  const error = leaseDenialError({
    code: 'ENV_NOT_LEASED',
    reason: 'expired',
    expiredAt: 9_000,
    message: 'lease 已过期',
  });
  assert.equal(error.code, 'ENV_NOT_LEASED');
  assert.equal(error.reason, 'expired');
  assert.equal(error.expiredAt, 9_000);
  assert.equal(error.message, 'lease 已过期');
  const plain = leaseDenialError({ code: 'CONTROL_REVOKED', reason: 'superseded', message: 'x' });
  assert.equal('expiredAt' in plain, false, '没有过期时间就不带这个字段');
});

test('releaseLease / renewLease 的错误带得上 reason', () => {
  const config = createEnvironmentConfig({ id: 'alpha', storagePath: '/tmp/alpha' });
  const takenByHuman = acquireLease(toEnvironment(config), 'human', 'lease-2', 10_000, 1000);
  assert.throws(
    () => releaseLease(takenByHuman, 'lease-1', 1001),
    (error: Error & { reason?: string }) => error.reason === 'user_takeover',
  );
  const leased = acquireLease(toEnvironment(config), 'agent', 'lease-1', 10_000, 1000);
  assert.throws(
    () => renewLease(leased, 'lease-1', 10_000, 99_999),
    (error: Error & { reason?: string; expiredAt?: number }) =>
      error.reason === 'expired' && error.expiredAt === 11_000,
  );
});

const running = (id: string, lastActiveAt: number, over: Partial<{ selected: boolean; leased: boolean }> = {}) => ({
  id,
  lastActiveAt,
  selected: false,
  leased: false,
  ...over,
});

test('pickEvictions：没超上限就一个都不回收', () => {
  const others = [running('a', 1), running('b', 2)];
  assert.deepEqual(pickEvictions(others, 8), [], '上限 8，现在只有 2 个在跑');
  assert.deepEqual(pickEvictions(others, 3), [], '再加一个正好 3，不超');
});

test('pickEvictions：超了就回收最久没用过的', () => {
  const others = [running('new', 300), running('old', 100), running('mid', 200)];
  // 上限 2，再加一个就是 4 个 → 要回收 2 个
  assert.deepEqual(pickEvictions(others, 2), ['old', 'mid']);
  assert.deepEqual(pickEvictions(others, 3), ['old']);
});

test('pickEvictions 绝不碰选中的和持着租约的', () => {
  const others = [
    running('selected', 1, { selected: true }),
    running('leased', 2, { leased: true }),
    running('free', 3),
  ];
  // 要回收 2 个，但只有 1 个可回收 → 宁可超限，也不动正在用的
  assert.deepEqual(pickEvictions(others, 2), ['free']);
});

test('pickEvictions：limit 0 表示不限', () => {
  assert.deepEqual(pickEvictions([running('a', 1), running('b', 2)], 0), []);
});

const dormant = (
  id: string,
  lastActiveAt: number,
  over: Partial<{ selected: boolean; leased: boolean; busy: boolean }> = {},
) => ({
  id,
  lastActiveAt,
  selected: false,
  leased: false,
  busy: false,
  ...over,
});

test('pickDormant：只挑闲置超过阈值的，最久没用的在前', () => {
  const now = 10_000;
  const candidates = [dormant('fresh', 9_000), dormant('old', 1_000), dormant('mid', 5_000), dormant('exact', 5_000)];
  assert.deepEqual(pickDormant(candidates, now, 5_000), ['old', 'mid', 'exact']);
});

test('pickDormant：选中的 / 持租约的 / 忙的绝不休眠', () => {
  const candidates = [
    dormant('selected', 1, { selected: true }),
    dormant('leased', 1, { leased: true }),
    dormant('loading', 1, { busy: true }),
    dormant('audible', 1, { busy: true }),
    dormant('recording', 1, { busy: true }),
    dormant('free', 1),
  ];
  assert.deepEqual(pickDormant(candidates, 10_000, 1_000), ['free']);
});

test('pickDormant：idleMs <= 0 关掉自动休眠', () => {
  const candidates = [dormant('old', 1)];
  assert.deepEqual(pickDormant(candidates, 10_000, 0), []);
  assert.deepEqual(pickDormant(candidates, 10_000, -1), []);
});
