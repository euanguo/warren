import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSnapshotFreshness,
  foldDeltaItems,
  isStaticAssetRequest,
  markSnapshotFresh,
  runWithActionDelta,
  summarizeApiNetworkDelta,
  type ActionDeltaClient,
} from '../src/main/browser/ops/action-delta.ts';
import { clearCachedSnapshots, rememberSnapshot } from '../src/main/browser/ops/diff.ts';
import { executeBatch, type BatchClient } from '../src/main/browser/ops/batch.ts';
import { formatActionResultText, formatBatchResultText } from '../bin/delta-formatter.mjs';
import { createOutputBuffer, isHardStopError } from '../bin/output-buffer.mjs';
import { runCli } from '../bin/cli.mjs';

test('isStaticAssetRequest 与 summarizeApiNetworkDelta 滤掉静态资源但保留 POST 与 4xx/5xx', () => {
  assert.equal(
    isStaticAssetRequest({ method: 'GET', url: 'https://a.test/app.js', status: 200, resourceType: 'script' }),
    true,
  );
  assert.equal(
    isStaticAssetRequest({ method: 'GET', url: 'https://a.test/logo.png', status: 200, resourceType: 'image' }),
    true,
  );
  assert.equal(
    isStaticAssetRequest({ method: 'GET', url: 'https://a.test/missing.png', status: 404, resourceType: 'image' }),
    false,
  );
  assert.equal(
    isStaticAssetRequest({ method: 'POST', url: 'https://a.test/api/orders', status: 201, resourceType: 'fetch' }),
    false,
  );

  const before = [{ id: 1, method: 'GET', url: 'https://a.test/init', status: 200, resourceType: 'fetch', at: 't0' }];
  const after = [
    ...before,
    { id: 2, method: 'GET', url: 'https://a.test/main.css', status: 200, resourceType: 'stylesheet', at: 't1' },
    { id: 3, method: 'POST', url: 'https://a.test/api/orders', status: 201, resourceType: 'fetch', at: 't2' },
    { id: 4, method: 'GET', url: 'https://a.test/api/me', status: 401, resourceType: 'xhr', at: 't3' },
  ];
  assert.deepEqual(summarizeApiNetworkDelta(before, after), ['POST /api/orders -> 201', 'GET /api/me -> 401']);
});

test('foldDeltaItems 折叠连续长列表并保留前 3、选中项与末 1 项', () => {
  const options = Array.from({ length: 12 }, (_, i) => ({
    role: 'option',
    name: `Option ${i + 1}`,
    ref: `@${i + 10}`,
    ...(i === 6 ? { selected: true } : {}),
    ...(i >= 8 ? { disabled: true } : {}),
  }));
  const folded = foldDeltaItems(options, 6);
  assert.equal(folded.foldedGroups.length, 1);
  assert.match(folded.foldedGroups[0]!, /\+ 12 option.*4 disabled.*@10\.\.@21/);
  assert.equal(folded.items.length, 5); // 3 head + 1 selected + 1 tail
  assert.equal(folded.items[3]?.name, 'Option 7');
  assert.equal(folded.items[4]?.name, 'Option 12');
});

test('runWithActionDelta 复用新鲜缓存快照并回传自愈、新弹窗文案、API 与副作用冒泡', async () => {
  clearCachedSnapshots();
  clearSnapshotFreshness();
  const scopeKey = 'env1:agent:active';
  rememberSnapshot(scopeKey, {
    url: 'https://app.test/orders',
    title: 'Orders',
    nodes: [{ role: 'button', name: '删除', ref: '@4' }],
  });
  markSnapshotFresh(scopeKey);

  let snapshotCalls = 0;
  let afterAction = false;
  const client: ActionDeltaClient = {
    currentUrl: () => 'https://app.test/orders',
    title: async () => 'Orders',
    snapshot: async () => {
      snapshotCalls += 1;
      return [{ role: 'button', name: '删除', ref: '@4' }];
    },
    snapshotWithRefs: async () => [
      { role: 'button', name: '删除', ref: '@4' },
      { role: 'dialog', name: '确认删除' },
      { role: 'button', name: '确认删除', ref: '@31' },
    ],
    smartSettle: async () => ({ settled: true }),
    evaluate: async () => '确定要删除订单 #9821 吗？',
    consumeHealedRefs: () => [{ ref: '@4', role: 'button', name: '删除', containerScope: 'row:"9821"' }],
    peekUnhandledSideEffects: () => ({
      unhandledPopups: [{ tabId: 'tab-2', index: 2, url: 'https://app.test/preview' }],
    }),
  };

  const out = await runWithActionDelta(
    {
      client,
      scopeKey,
      settleMs: 0,
      networkEntries: () =>
        afterAction
          ? [
              {
                id: 10,
                method: 'POST',
                url: 'https://app.test/api/orders/9821/precheck',
                status: 200,
                resourceType: 'fetch',
                at: 'x',
              },
            ]
          : [],
    },
    async () => {
      afterAction = true;
      return { x: 10, y: 20, url: 'https://app.test/orders', navigation: 'none' as const };
    },
  );

  // 新鲜快照命中缓存，动作前不应再重复调一次 snapshot()
  assert.equal(snapshotCalls, 0);
  assert.equal(out.delta?.changed, true);
  assert.equal(out.delta?.healed?.[0]?.ref, '@4');
  assert.deepEqual(out.delta?.network, ['POST /api/orders/9821/precheck -> 200']);
  assert.match(out.delta?.openedText ?? '', /订单 #9821.*\[确认删除 @31\]/);
  assert.equal(out.delta?.sideEffects.unhandledPopups?.[0]?.index, 2);

  const text = formatActionResultText('click @4', out);
  assert.match(text, /✓ click @4/);
  assert.match(text, /healed: @4 redrawn/);
  assert.match(text, /net: POST \/api\/orders\/9821\/precheck -> 200/);
  assert.match(text, /\+ button "确认删除" \[ref=@31\]/);
  assert.match(text, /\[unhandled-popup\] tab #2/);
});

test('Hard-Stop 原子缓冲在 CONTROL_REVOKED 时丢弃前序日志并只发权威指导', () => {
  assert.equal(isHardStopError('CONTROL_REVOKED'), true);
  assert.equal(isHardStopError('TARGET_NOT_FOUND'), false);

  const buf = createOutputBuffer();
  buf.push('step 1 ok\n');
  buf.push('step 2 ok\n');
  buf.markHardStop(
    {
      code: 'CONTROL_REVOKED',
      message: '人工已接管环境',
      details: { hint: '等待用户交还', remedy: 'warren env acquire dev --wait=10000' },
    },
    { completedSteps: 2 },
  );
  buf.push('late noise\n');

  const rendered = buf.render();
  assert.doesNotMatch(rendered, /step 1 ok/);
  assert.doesNotMatch(rendered, /late noise/);
  assert.match(rendered, /\[HARD-STOP\] CONTROL_REVOKED/);
  assert.match(rendered, /前 2 步已派发/);
  assert.match(rendered, /warren env acquire dev --wait=10000/);
});

test('executeBatch 遇到 CONTROL_REVOKED 自动硬中止且 formatBatchResultText 输出紧凑去重文本', async () => {
  let stepCount = 0;
  const client: BatchClient = {
    currentUrl: () => 'https://app.test',
    title: async () => 'App',
    navigate: async () => ({}),
    goBack() {},
    goForward() {},
    reload: async () => ({}),
    click: async () => {
      stepCount += 1;
      if (stepCount === 2) {
        throw Object.assign(new Error('用户接管'), {
          code: 'CONTROL_REVOKED',
          details: { remedy: 'warren env acquire dev --wait=10000' },
        });
      }
      return { ok: true };
    },
    dblclick: async () => ({}),
    hover: async () => ({}),
    focus: async () => ({}),
    fill: async () => ({}),
    selectOption: async () => ({}),
    press: async () => ({}),
    waitForTimeout: async () => {},
    snapshot: async () => [],
    snapshotWithRefs: async () => [],
    events: async () => [],
    evaluate: async () => null,
  };

  const res = await executeBatch({
    steps: [
      { cmd: 'click', target: '@1' },
      { cmd: 'click', target: '@2' },
      { cmd: 'click', target: '@3' },
    ],
    bail: false,
    settleMs: 0,
    controller: client,
  });

  assert.equal(res.ok, false);
  assert.equal(res.results.length, 2, 'CONTROL_REVOKED 必须立即硬中止，不执行第 3 步');
  assert.equal(res.hardStop?.code, 'CONTROL_REVOKED');
  assert.equal(res.hardStop?.completedSteps, 1);

  const compact = formatBatchResultText(res);
  assert.match(compact, /✗ batch 1\/2 steps ok/);
  assert.match(compact, /CONTROL_REVOKED/);
});

test('CLI 单步 click 默认启用 includeDelta 并以紧凑文本输出，--no-changes 关闭 Delta', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'browser.click') {
        return {
          x: 10,
          y: 20,
          url: 'https://app.test',
          navigation: 'none',
          ...(params.includeDelta
            ? {
                delta: {
                  changed: false,
                  urlChanged: false,
                  titleChanged: false,
                  url: 'https://app.test',
                  title: 'App',
                  nodes: { added: [], changed: [], removed: [] },
                  network: [],
                  sideEffects: {},
                },
              }
            : {}),
        };
      }
      return { ok: true };
    },
    withLease: async (_id: string, _flags: unknown, _label: string, fn: (lease: string) => Promise<unknown>) =>
      fn('lease-1'),
  };

  const outLines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => outLines.push(a.map(String).join(' '));
  try {
    await runCli(['browser', 'click', 'dev', '@5'], { rpc });
    await runCli(['browser', 'click', 'dev', '@5', '--no-changes'], { rpc });
  } finally {
    console.log = origLog;
  }

  assert.equal(calls[0]?.params.includeDelta, true);
  assert.equal(calls[1]?.params.includeDelta, false);
  assert.match(outLines[0] ?? '', /✓ click @5 -> no change/);
  assert.match(outLines[1] ?? '', /✓ click @5$/);
});
