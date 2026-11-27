import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionTraceRing, correlateStepsWithNetwork } from '../src/main/browser/ops/action-trace.ts';
import { readUrlsConcurrently } from '../src/main/browser/ops/batch-reader.ts';
import { buildFlowSpecFromRecordedRequest, executeSavedFlow, inferFlowSchema } from '../src/main/browser/ops/flow.ts';
import { readPage } from '../src/main/browser/ops/reader.ts';

test('readUrlsConcurrently 遵守并发上限、隔离单页失败、保序输出且始终回收离屏句柄', async () => {
  let active = 0;
  let peak = 0;
  let closed = 0;

  const result = await readUrlsConcurrently(
    [
      'https://docs.test/p1',
      'https://docs.test/p2',
      'https://docs.test/fail',
      'https://docs.test/p4',
      'https://docs.test/p5',
    ],
    { concurrency: 3, maxCharsPerPage: 2000 },
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      let loadedUrl = '';
      return {
        load: async (url) => {
          loadedUrl = url;
          await new Promise((r) => setTimeout(r, 20));
          if (url.endsWith('/fail')) throw new Error('HTTP 500');
        },
        client: {
          currentUrl: () => loadedUrl,
          title: async () => `Title ${loadedUrl.split('/').pop()}`,
          evaluate: async () => ({ text: `Body of ${loadedUrl}`, outline: [] }),
        },
        close: () => {
          active -= 1;
          closed += 1;
        },
      };
    },
  );

  assert.equal(result.total, 5);
  assert.equal(result.ok, 4);
  assert.equal(result.failed, 1);
  assert.equal(result.concurrency, 3);
  assert.ok(peak <= 3 && peak >= 2, `peak concurrency should be <=3, got ${peak}`);
  assert.equal(closed, 5, '所有临时离屏句柄必须在 finally 中关闭');
  assert.equal(result.items[0]?.url, 'https://docs.test/p1');
  assert.equal(result.items[2]?.ok, false);
  assert.match(result.items[2]?.error ?? '', /HTTP 500/);
  assert.equal(result.items[4]?.url, 'https://docs.test/p5');
});

test('readPage --data 支持块摘要 dataSummary 与 --block/--where/--fields/--limit 精准切片', async () => {
  const res = await readPage(
    {
      currentUrl: () => 'https://shop.test/catalog',
      title: async () => 'Catalog',
      evaluate: async () => ({
        text: 'Name | Price\nSneaker Pro | 129\nRunner Air | 89',
        data: [
          {
            source: '__NEXT_DATA__',
            payload: {
              props: {
                pageProps: {
                  products: [
                    { id: 1, name: 'Sneaker Pro', category: 'Running Shoes', price: 129 },
                    { id: 2, name: 'Leather Boot', category: 'Boots', price: 199 },
                    { id: 3, name: 'Runner Air', category: 'Running Shoes', price: 89 },
                  ],
                },
              },
            },
          },
        ],
      }),
    },
    {
      data: true,
      block: '__NEXT_DATA__',
      where: { category: 'running' },
      fields: ['id', 'name', 'price'],
      limit: 1,
    },
  );

  assert.equal(res.dataSummary?.length, 1);
  assert.equal(res.dataSummary?.[0]?.source, '__NEXT_DATA__');
  assert.equal(res.dataSlice?.arrayPath, 'props.pageProps.products');
  assert.equal(res.dataSlice?.total, 3);
  assert.equal(res.dataSlice?.count, 1);
  assert.deepEqual(res.dataSlice?.rows, [{ id: 1, name: 'Sneaker Pro', price: 129 }]);
});

test('ActionTraceRing 严守密码脱敏边界，correlateStepsWithNetwork 自动关联 s<N>r<M> 与参数线索', () => {
  const ring = new ActionTraceRing();
  // 密码字段绝对不能被记录
  const secretStep = ring.record('env1', {
    action: 'fill',
    target: 'input[type="password"]',
    value: 'SuperSecret123',
    urlBefore: 'https://shop.test/login',
    urlAfter: 'https://shop.test/login',
    netBeforeId: 0,
    netAfterId: 0,
  });
  assert.equal(secretStep.value, undefined);

  // 非敏感搜索输入被记录并关联后续 GET API
  ring.record('env1', {
    action: 'fill',
    target: '@search',
    value: 'shoes',
    urlBefore: 'https://shop.test/',
    urlAfter: 'https://shop.test/',
    netBeforeId: 10,
    netAfterId: 10,
  });
  ring.record('env1', {
    action: 'click',
    target: '@go',
    urlBefore: 'https://shop.test/',
    urlAfter: 'https://shop.test/search?q=shoes',
    netBeforeId: 10,
    netAfterId: 12,
  });

  const candidates = correlateStepsWithNetwork(ring.list('env1'), [
    {
      id: 11,
      method: 'GET',
      url: 'https://shop.test/api/search?q=shoes&page=1&token=dropme',
      status: 200,
      resourceType: 'fetch',
      at: 't',
    },
    { id: 12, method: 'GET', url: 'https://shop.test/app.js', status: 200, resourceType: 'script', at: 't' },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.ref, 's3r1');
  assert.equal(candidates[0]?.suggestedTemplate, 'https://shop.test/api/search?q={{q}}&page={{page}}');
  assert.deepEqual(candidates[0]?.matchedParams, [{ param: 'q', value: 'shoes', sourceStepId: 's2' }]);
});

test('buildFlowSpecFromRecordedRequest 零模板自动参数化 + inferFlowSchema + executeSavedFlow 宽容筛选与错误分型', async () => {
  const sampleBody = JSON.stringify({
    code: 0,
    data: {
      orders: [
        { id: 'O1', title: 'Express Running Shoes', status: 'shipped', price: 99, nested: { a: 1 } },
        { id: 'O2', title: 'Winter Jacket', status: 'pending', price: 150, nested: { a: 2 } },
      ],
    },
  });
  const inferred = inferFlowSchema(JSON.parse(sampleBody));
  assert.equal(inferred.extractPath, 'data.orders');
  assert.deepEqual(inferred.fields, ['id', 'title', 'status', 'price']);

  const built = buildFlowSpecFromRecordedRequest('https://shop.test/api/orders?q=shoes&limit=20&api_key=leak', {
    params: { query: 'shoes' },
    description: '搜索订单',
    sampleBody,
  });
  assert.equal(built.site, 'shop.test');
  assert.equal(built.spec.urlTemplate, 'https://shop.test/api/orders?q={{query}}&limit=20');
  assert.equal(built.spec.extractPath, 'data.orders');
  assert.deepEqual(built.spec.fields, ['id', 'title', 'status', 'price']);

  const record = { name: 'orders', site: built.site, spec: built.spec, updatedBy: 'agent', updatedAt: 'now' };

  // 宽容子串匹配 --where title=running
  const okRes = await executeSavedFlow(
    record,
    async (url) => ({ ok: true, status: 200, statusText: 'OK', url, headers: {}, body: sampleBody }),
    { params: { query: 'shoes' }, where: { title: 'running' } },
  );
  assert.equal(okRes.count, 1);
  assert.equal((okRes.rows as Array<{ id: string }>)[0]?.id, 'O1');

  // 未知字段明确报错并列出可用字段
  await assert.rejects(
    () =>
      executeSavedFlow(
        record,
        async (url) => ({ ok: true, status: 200, statusText: 'OK', url, headers: {}, body: sampleBody }),
        { params: { query: 'shoes' }, where: { nonexistent: 'x' } },
      ),
    (err: { code?: string; message?: string }) =>
      err.code === 'FLOW_UNKNOWN_FIELD' && /可用字段.*title/.test(err.message ?? ''),
  );

  // 401 -> FLOW_AUTH_EXPIRED，429 -> FLOW_RATE_LIMITED
  await assert.rejects(
    () =>
      executeSavedFlow(
        record,
        async (url) => ({ ok: false, status: 401, statusText: 'Unauthorized', url, headers: {}, body: '' }),
        { params: { query: 'shoes' } },
      ),
    (err: { code?: string }) => err.code === 'FLOW_AUTH_EXPIRED',
  );
  await assert.rejects(
    () =>
      executeSavedFlow(
        record,
        async (url) => ({ ok: false, status: 429, statusText: 'Too Many Requests', url, headers: {}, body: '' }),
        { params: { query: 'shoes' } },
      ),
    (err: { code?: string }) => err.code === 'FLOW_RATE_LIMITED',
  );
});
