import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeRegExp,
  isActive,
  isExpired,
  matchUrl,
  nextExpiry,
  normalizeRule,
  pickRule,
  type NetRule,
} from '../src/main/net/rules.ts';

const rule = (over: Partial<NetRule> & Pick<NetRule, 'id'>): NetRule => ({
  enabled: true,
  match: { url: '*' },
  action: { type: 'block' },
  ...over,
});

test('glob 是全匹配，要部分匹配得两端写 *', () => {
  assert.equal(matchUrl('https://a.com/api/user', 'https://a.com/api/user'), true);
  assert.equal(matchUrl('*/api/user*', 'https://a.com/api/user/1'), true);
  assert.equal(matchUrl('https://a.com/api/user', 'https://a.com/api/user/1'), false);
  assert.equal(matchUrl('*/api/*', 'https://a.com/other'), false);
});

test('regex 模式与非法正则', () => {
  assert.equal(matchUrl('^https://a\\.com/\\d+$', 'https://a.com/123', true), true);
  assert.equal(matchUrl('^https://a\\.com/\\d+$', 'https://a.com/x', true), false);
  // 坏正则不能把链路弄崩，只当作不命中
  assert.equal(matchUrl('([', 'https://a.com/', true), false);
});

test('method 过滤', () => {
  const rules = [rule({ id: 'r1', match: { url: '*', method: 'POST' } })];
  assert.equal(pickRule(rules, 'https://a.com/', 'POST')?.id, 'r1');
  assert.equal(pickRule(rules, 'https://a.com/', 'GET'), null);
  // 大小写不敏感
  assert.equal(pickRule(rules, 'https://a.com/', 'post')?.id, 'r1');
});

test('priority 大的先命中，相同则按表顺序', () => {
  const rules = [rule({ id: 'low', priority: 1 }), rule({ id: 'high', priority: 9 }), rule({ id: 'same' })];
  assert.equal(pickRule(rules, 'https://a.com/', 'GET')?.id, 'high');
  assert.equal(pickRule([rule({ id: 'first' }), rule({ id: 'second' })], 'https://a.com/', 'GET')?.id, 'first');
});

test('disabled 的规则不参与匹配', () => {
  const rules = [rule({ id: 'off', enabled: false })];
  assert.equal(pickRule(rules, 'https://a.com/', 'GET'), null);
});

test('没有命中时返回 null（反例门：别把无关请求也拦了）', () => {
  const rules = [rule({ id: 'api', match: { url: '*/api/*' } })];
  assert.equal(pickRule(rules, 'https://a.com/static/logo.png', 'GET'), null);
  assert.equal(pickRule([], 'https://a.com/', 'GET'), null);
});

test('normalizeRule：method 统一大写、id 缺省留空、默认 enabled', () => {
  const parsed = normalizeRule({
    match: { url: '*/api/*', method: 'post' },
    action: { type: 'block' },
  });
  assert.equal(parsed.match.method, 'POST');
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.id, '');
  assert.deepEqual(parsed.action, { type: 'block' });
});

test('normalizeRule 是信任边界：坏规则一律 BAD_REQUEST，不放行到 session', () => {
  const cases: unknown[] = [
    { action: { type: 'block' } }, // 没有 match.url
    { match: { url: '*/a*' }, action: { type: 'nope' } }, // 未知 action
    { match: { url: '*/a*' }, action: { type: 'delay', ms: -1 } },
    { match: { url: '*/a*' }, action: { type: 'mock', status: 999 } },
    { match: { url: '*/a*' }, action: { type: 'setRequestHeaders', headers: {} } },
    { match: { url: '*/a*' }, action: { type: 'setRequestHeaders', headers: { a: 1 } } },
  ];
  for (const input of cases) {
    assert.throws(
      () => normalizeRule(input),
      (error: Error & { code?: string }) => error.code === 'BAD_REQUEST',
      `应该拒绝: ${JSON.stringify(input)}`,
    );
  }
});

test('HAR 回放用精确 URL：glob 的 `?` 是单字符通配，所以走正则转义', () => {
  const url = 'https://a.com/api?x=1';
  const pattern = `^${escapeRegExp(url)}$`;
  assert.equal(matchUrl(pattern, url, true), true);
  assert.equal(matchUrl(pattern, 'https://a.com/api1x=1', true), false);
  // 反例：直接拿 URL 当 glob，`?` 会命中任意单字符
  assert.equal(matchUrl(url, 'https://a.com/api1x=1'), true);
});

// ── 临时放行（net passthrough）：过期规则必须真的不算数 ──────────────────

const NOW = 1_700_000_000_000;

test('过期规则不再命中；没过期的照常命中', () => {
  const rules = [
    rule({ id: 'old', expiresAt: NOW - 1, action: { type: 'passthrough' } }),
    rule({ id: 'live', expiresAt: NOW + 1000, action: { type: 'passthrough' } }),
    rule({ id: 'forever', action: { type: 'passthrough' } }),
  ];
  // priority 相同 → 按表顺序；old 被跳过，所以命中的是 live
  assert.equal(pickRule(rules, 'https://a.com/', 'GET', NOW)?.id, 'live');
  assert.equal(isExpired(rules[0], NOW), true);
  assert.equal(isActive(rules[0], NOW), false);
  assert.equal(isActive(rules[1], NOW), true);
  // 反例：到点那一刻就失效（<= 而不是 <）
  assert.equal(pickRule([rules[1]], 'https://a.com/', 'GET', NOW + 1000), null);
});

test('只有过期规则时不挂 handler（CORS 偏差不能漏出去）', () => {
  const rules = [rule({ id: 'gone', expiresAt: NOW - 1 })];
  assert.equal(
    rules.some((item) => isActive(item, NOW)),
    false,
  );
  assert.equal(nextExpiry(rules, NOW), undefined, '已经过期的规则不用再排定时器');
});

test('nextExpiry 取最近的未来过期时刻，忽略禁用/永不过期的规则', () => {
  const rules = [
    rule({ id: 'forever' }),
    rule({ id: 'off', enabled: false, expiresAt: NOW + 5_000 }),
    rule({ id: 'later', expiresAt: NOW + 60_000 }),
    rule({ id: 'sooner', expiresAt: NOW + 1_000 }),
  ];
  assert.equal(nextExpiry(rules, NOW), NOW + 1_000);
  assert.equal(nextExpiry([rule({ id: 'forever' })], NOW), undefined);
});

test('normalizeRule 收 expiresAt，但拒绝已经过去的时刻', () => {
  const parsed = normalizeRule(
    {
      match: { url: '*/api/*' },
      action: { type: 'passthrough' },
      expiresAt: NOW + 1000,
    },
    NOW,
  );
  assert.equal(parsed.expiresAt, NOW + 1000);
  assert.deepEqual(parsed.action, { type: 'passthrough' });

  for (const expiresAt of [NOW - 1, NOW, 'soon', Number.NaN]) {
    assert.throws(
      () => normalizeRule({ match: { url: '*a*' }, action: { type: 'passthrough' }, expiresAt }, NOW),
      (error: Error & { code?: string }) => error.code === 'BAD_REQUEST',
      `应该拒绝 expiresAt=${String(expiresAt)}`,
    );
  }
});
