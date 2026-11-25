import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieUrl, summarize } from '../src/main/browser/cookies.ts';
import { tierOf } from '../src/shared/permissions.ts';

/**
 * Cookie 受控通道的核心不变量：**值不出现在返回值里**。
 * 设计见 docs/PLUGIN-CAPABILITY-DESIGN.md §9。
 */

const cookie = {
  name: 'warren_session',
  value: 'super-secret-value',
  domain: 'localhost',
  path: '/',
  secure: false,
  httpOnly: true,
  session: true,
} as never;

test('summarize 只回白名单字段，值一个字都不带', () => {
  const summary = summarize(cookie);
  assert.equal(summary.name, 'warren_session');
  assert.equal(summary.domain, 'localhost');
  assert.equal(summary.httpOnly, true);
  assert.equal('value' in summary, false, '返回值里不该有 value 这个键');
  assert.equal(JSON.stringify(summary).includes('super-secret-value'), false);
});

test('白名单是逐字段挑的：cookie 以后多出新字段也不会自动漏出去', () => {
  const future = { ...(cookie as object), partitioned: true, futureField: 'leak-me' } as never;
  const summary = summarize(future);
  assert.equal(JSON.stringify(summary).includes('leak-me'), false, '不是 delete value 那种写法');
  assert.deepEqual(Object.keys(summary).sort(), ['domain', 'httpOnly', 'name', 'path', 'secure', 'session']);
});

test('cookieUrl：回环走 http、其余走 https，secure 一律 https', () => {
  assert.equal(cookieUrl({ domain: 'localhost', path: '/' }), 'http://localhost/');
  assert.equal(cookieUrl({ domain: '127.0.0.1', path: '/cap' }), 'http://127.0.0.1/cap');
  assert.equal(cookieUrl({ domain: '.example.com', path: '/' }), 'https://example.com/');
  assert.equal(cookieUrl({ domain: 'localhost', path: '/', secure: true }), 'https://localhost/');
  assert.equal(cookieUrl({ domain: 'example.com' }), 'https://example.com/');
});

test('宽形状的 cookie 权限永远留在 denied，只有窄通道是 confirm', () => {
  // 这条断言是安全姿态本身：谁把 read/write 调上去，测试就红
  assert.equal(tierOf('storage.cookie.read'), 'denied');
  assert.equal(tierOf('storage.cookie.write'), 'denied');
  assert.equal(tierOf('storage.cookie.port'), 'confirm');
});
