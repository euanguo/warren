import test from 'node:test';
import assert from 'node:assert/strict';
import { rulesFromHar, toHarDocument, type HarEntry } from '../src/main/net/har.ts';
import { pickRule } from '../src/main/net/rules.ts';

const entry = (over: Partial<HarEntry> = {}): HarEntry => ({
  at: '2026-10-15T02:00:00.000Z',
  method: 'GET',
  url: 'https://a.com/api/user?id=1',
  status: 200,
  contentType: 'application/json',
  body: '{"id":1}',
  ...over,
});

test('HAR 往返：录了什么就回放什么（URL 精确匹配，含查询串）', () => {
  const doc = toHarDocument([entry()]);
  const rules = rulesFromHar(doc);
  assert.equal(rules.length, 1);
  const rule = pickRule(rules, 'https://a.com/api/user?id=1', 'GET');
  assert.equal(rule?.action.type, 'mock');
  assert.deepEqual(rule?.action, {
    type: 'mock',
    status: 200,
    body: '{"id":1}',
    contentType: 'application/json',
  });
  // 反例：查询串不同就不是同一条请求（glob 会把 `?` 当单字符通配，所以必须走正则）
  assert.equal(pickRule(rules, 'https://a.com/api/userXid=1', 'GET'), null);
  // 反例：method 不同不算命中
  assert.equal(pickRule(rules, 'https://a.com/api/user?id=1', 'POST'), null);
});

test('没有响应体的条目跳过（回放不了，别造一个空响应）', () => {
  const doc = toHarDocument([entry({ body: undefined, contentType: 'image/png' })]);
  assert.deepEqual(rulesFromHar(doc), []);
});

test('offline：录不到的请求被兜底阻断，但已录的仍然走 mock', () => {
  const rules = rulesFromHar(toHarDocument([entry()]), true);
  const hit = pickRule(rules, 'https://a.com/api/user?id=1', 'GET');
  assert.equal(hit?.action.type, 'mock');
  const miss = pickRule(rules, 'https://a.com/other', 'GET');
  assert.equal(miss?.action.type, 'block');
  assert.equal(miss?.id, 'har:__offline__');
});

test('坏 HAR 报 BAD_REQUEST（信任边界）', () => {
  for (const input of [{}, { log: {} }, null, 'nope']) {
    assert.throws(
      () => rulesFromHar(input),
      (error: Error & { code?: string }) => error.code === 'BAD_REQUEST',
      `应该拒绝: ${JSON.stringify(input)}`,
    );
  }
});

test('HAR 里不写请求/响应头（凭据落盘 = 新的泄漏面）', () => {
  const doc = toHarDocument([entry()]) as {
    log: { entries: Array<{ request: { headers: unknown[] }; response: { headers: unknown[] } }> };
  };
  const written = doc.log.entries[0]!;
  assert.deepEqual(written.request.headers, []);
  assert.deepEqual(written.response.headers, []);
  assert.equal(JSON.stringify(doc).includes('authorization'), false);
});
