import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  computeUnifiedLineDiff,
  decodePngRgba,
  diffScreenshots,
  diffSnapshots,
  encodePngRgba,
} from '../src/main/browser/ops/diff.ts';
import { hasWriteSteps, parseBatchLines, summarizeNetworkDelta } from '../src/main/browser/ops/batch.ts';
import {
  executeSavedFlow,
  extractFlowCandidates,
  renderFlowUrl,
  sanitizeFlowSpec,
} from '../src/main/browser/ops/flow.ts';
import { Store } from '../src/main/store.ts';
import { closeDatabases } from '../src/main/db.ts';

test('diffSnapshots 忽略 [ref=@N] 漂移并生成干净行级统一 Diff', () => {
  const prev = {
    url: 'https://app.test/items',
    title: 'Items',
    nodes: [
      { role: 'button', name: 'Add', ref: '@1' },
      { role: 'button', name: 'Export', ref: '@2' },
    ],
  };
  const next = {
    url: 'https://app.test/items',
    title: 'Items',
    nodes: [
      { role: 'button', name: 'Banner Close', ref: '@1' },
      { role: 'button', name: 'Add', ref: '@2' },
      { role: 'button', name: 'Export', ref: '@3' },
    ],
  };
  const res = diffSnapshots(prev, next);
  assert.match(res.unifiedDiff, /^\+ - button "Banner Close"$/m);
  // ref 从 @1/@2 变成 @2/@3 的未变节点不应误报成修改行
  assert.doesNotMatch(res.unifiedDiff, /^- - button "Add"/m);
  assert.equal(computeUnifiedLineDiff('- button "A" [ref=@1]', '- button "A" [ref=@9]'), '');
});

test('diffScreenshots 纯 JS PNG 解码/编码与逐像素 RGBA 差分、差异图输出', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-px-diff-'));
  try {
    const w = 4;
    const h = 4;
    const rgbaA = new Uint8Array(w * h * 4).fill(255);
    const rgbaB = new Uint8Array(w * h * 4).fill(255);
    // 修改 2 个像素为纯黑
    rgbaB[0] = 0;
    rgbaB[1] = 0;
    rgbaB[2] = 0;
    rgbaB[4] = 0;
    rgbaB[5] = 0;
    rgbaB[6] = 0;

    const bufA = encodePngRgba(w, h, rgbaA);
    const bufB = encodePngRgba(w, h, rgbaB);
    const decoded = decodePngRgba(bufB);
    assert.equal(decoded?.width, 4);
    assert.equal(decoded?.height, 4);
    assert.equal(decoded?.rgba[0], 0);

    const fileA = path.join(dir, 'a.png');
    const fileB = path.join(dir, 'b.png');
    const outDiff = path.join(dir, 'diff.png');
    await writeFile(fileA, bufA);
    await writeFile(fileB, bufB);

    const diff = await diffScreenshots(fileA, fileB, { threshold: 0.05, outputPath: outDiff });
    assert.equal(diff.match, false);
    assert.equal(diff.pixelCompared, true);
    assert.equal(diff.totalPixels, 16);
    assert.equal(diff.differentPixels, 2);
    assert.equal(diff.mismatchPercentage, 12.5);
    assert.equal(diff.diffPath, outDiff);
    assert.equal(existsSync(outDiff), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('summarizeNetworkDelta 按 SQLite 自增 id 游标增量统计，满 300 条后仍准确无漏', () => {
  const makeEntry = (id: number) => ({
    id,
    method: 'GET',
    url: `https://api.test/item/${id}`,
    status: 200,
    resourceType: 'xhr',
    at: '2026-11-26T00:00:00Z',
  });
  const before = Array.from({ length: 300 }, (_, i) => makeEntry(i + 1));
  // 模拟环形截断：保留最近 300 条（id 3..302），长度仍为 300
  const after = Array.from({ length: 300 }, (_, i) => makeEntry(i + 3));
  const delta = summarizeNetworkDelta(before, after);
  assert.deepEqual(delta, ['GET /item/301 -> 200', 'GET /item/302 -> 200']);
});

test('parseBatchLines 支持全量新动词与读写门控识别', () => {
  const steps = parseBatchLines(`
    check @1
    uncheck @2
    scroll down 400
    wait --load networkidle
    dialog accept "ok"
    find role button click
    frame main
    eval "document.title"
    screenshot --annotate /tmp/s.png
  `);
  assert.equal(steps.length, 9);
  assert.equal(hasWriteSteps(steps), true);

  const readOnly = parseBatchLines(`
    find role button text
    wait 100
    snapshot -i -u
  `);
  assert.equal(hasWriteSteps(readOnly), false);
});

test('Saved Flow 严守只读 GET 与脱敏边界，支持参数渲染、过滤投影、漂移检测与 SQLite 持久化', async () => {
  // 拒绝 POST 写请求
  assert.throws(
    () => sanitizeFlowSpec({ method: 'POST' as never, urlTemplate: 'https://api.test/orders' }),
    /仅允许只读 GET/,
  );

  // 自动剥离 Cookie / Authorization 等认证头
  const { site, spec } = sanitizeFlowSpec({
    method: 'GET',
    urlTemplate: 'https://api.test/items?q={{query}}',
    headers: {
      Accept: 'application/json',
      Cookie: 'sid=secret',
      Authorization: 'Bearer secret_token_123456',
      'X-API-Key': 'abc',
    },
    extractPath: 'data.items',
    fields: ['id', 'title', 'missingField'],
  });
  assert.equal(site, 'api.test');
  assert.deepEqual(spec.headers, { Accept: 'application/json' });

  // 参数渲染 URL 编码
  assert.equal(renderFlowUrl(spec.urlTemplate, { query: 'a b&c=1' }), 'https://api.test/items?q=a%20b%26c%3D1');
  assert.throws(() => renderFlowUrl(spec.urlTemplate, {}), /缺少必填参数/);

  // 遥测候选提取忽略非 GET 与静态资源
  const candidates = extractFlowCandidates([
    { method: 'POST', url: 'https://api.test/mutate', status: 200, resourceType: 'xhr', at: 'x' },
    { method: 'GET', url: 'https://api.test/app.js', status: 200, resourceType: 'script', at: 'x' },
    { method: 'GET', url: 'https://api.test/users?page=2&token=secret', status: 200, resourceType: 'xhr', at: 'x' },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.suggestedTemplate, 'https://api.test/users?page={{page}}');

  // 执行过滤、投影与 schemaDrift 告警
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-flow-db-'));
  try {
    const store = new Store(dir);
    await store.load();
    const saved = store.saveFlow('search-items', site, spec, 'agent');
    assert.equal(store.getSavedFlow('search-items')?.site, 'api.test');
    assert.equal(store.listSavedFlows().length, 1);

    const runRes = await executeSavedFlow(
      saved,
      async (url) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        url,
        headers: {},
        body: JSON.stringify({
          data: {
            items: [
              { id: 1, title: 'Alpha', status: 'open' },
              { id: 2, title: 'Beta', status: 'closed' },
            ],
          },
        }),
      }),
      { params: { query: 'test' }, where: { status: 'open' }, limit: 10 },
    );
    assert.equal(runRes.count, 1);
    assert.deepEqual(runRes.rows, [{ id: 1, title: 'Alpha', missingField: undefined }]);
    assert.deepEqual(runRes.schemaDrift?.missingFields, ['missingField']);

    assert.equal(store.removeSavedFlow('search-items'), true);
    assert.equal(store.getSavedFlow('search-items'), undefined);
  } finally {
    closeDatabases();
    await rm(dir, { recursive: true, force: true });
  }
});
