import test from 'node:test';
import assert from 'node:assert/strict';
import { guardApi, guardPage, snapshotText, withSnapshotText } from '../bin/page-contract.mjs';

/**
 * `warren exec` 的 page 契约（审计 P1-6）：
 * - `snapshot()` 是结构，不是字符串；`.slice()` / `String()` 得能用且输出与 CLI 一致；
 * - 访问不存在的方法要报 `UNSUPPORTED_PAGE_API`，不能再是 `is not a function`。
 */

const sample = { url: 'https://example.com/', title: '示例', nodes: [{ role: 'button', name: '登录', ref: '@1' }] };
const copy = () => JSON.parse(JSON.stringify(sample));

test('snapshot 结果可以直接 String() / slice()', () => {
  const snapshot = withSnapshotText(copy());
  const text = String(snapshot);
  assert.equal(text, snapshotText(sample), '文本要与 warren browser snapshot 打出来的完全一致');
  assert.match(text.slice(0, 1), /\{/);
  assert.ok(text.includes('"ref": "@1"'));
});

test('toString 不改变 JSON 形状，也不出现在枚举里', () => {
  const snapshot = withSnapshotText(copy());
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), sample, 'JSON 还得是原来那份结构');
  assert.equal(Object.keys(snapshot).includes('toString'), false);
  assert.equal('toString' in snapshot, true, '原型上本来就有 toString，用完不能丢');
});

test('非对象原样返回（不硬造 toString）', () => {
  assert.equal(withSnapshotText(undefined), undefined);
  assert.equal(withSnapshotText('text'), 'text');
});

test('page 上不存在的方法报 UNSUPPORTED_PAGE_API 并点名去哪看清单', () => {
  const page = guardPage({ click: () => 'clicked', url: async () => 'https://example.com/' });
  assert.equal(page.click(), 'clicked', '已有方法原样可用');
  assert.throws(
    () => page.getByRole,
    (error: Error & { code?: string }) =>
      error.code === 'UNSUPPORTED_PAGE_API' &&
      /page\.getByRole/.test(error.message) &&
      /--capabilities/.test(error.message),
  );
});

test('定位器上不存在的 Playwright 方法也报 UNSUPPORTED_PAGE_API', () => {
  const locator = guardApi({ click: () => 'clicked' }, 'page.locator(...)');
  assert.throws(
    () => locator.nth,
    (error: Error & { code?: string }) =>
      error.code === 'UNSUPPORTED_PAGE_API' && /page\.locator\(\.\.\.\)\.nth/.test(error.message),
  );
});

test('guardPage 不影响 JSON.stringify / Object.keys / await', async () => {
  const page = guardPage({ click: () => 1, url: async () => 'https://example.com/' });
  assert.deepEqual(Object.keys(page), ['click', 'url']);
  assert.equal(JSON.stringify(page), '{}', '函数本来就不进 JSON，有没有 Proxy 都一样');
  assert.equal(await page, page, 'await page 不能被 then 探测搞崩');
  assert.equal(await page.url(), 'https://example.com/');
});
