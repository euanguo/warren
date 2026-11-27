#!/usr/bin/env node
/**
 * Warren v4 Agent 效率无头基准脚本（覆盖 5 大高频场景）：
 * 1. 单步写动作 Action Delta 省回合 & 紧凑文本压缩率（对比旧 JSON + 额外 snapshot）
 * 2. 长列表折叠 + 视口感知 + 会话记忆去重 Token 压缩率
 * 3. 4 并发隔离读池 vs 串行单页读取耗时加速比
 * 4. Exec v2 持久化 state 断点续跑（故障后零重复拉取）
 * 5. Auto-Flow v2 零模板录制 + 1 步复跑 vs 传统多步探索
 */
import assert from 'node:assert/strict';
import { formatActionResultText } from '../../bin/delta-formatter.mjs';
import { runExecCommand } from '../../bin/commands/system.mjs';
import { runWithActionDelta } from '../../src/main/browser/ops/action-delta.ts';
import { ActionTraceRing, correlateStepsWithNetwork } from '../../src/main/browser/ops/action-trace.ts';
import { readUrlsConcurrently } from '../../src/main/browser/ops/batch-reader.ts';
import { SessionContextTracker } from '../../src/main/browser/ops/context-tracker.ts';
import { buildFlowSpecFromRecordedRequest, executeSavedFlow } from '../../src/main/browser/ops/flow.ts';
import { formatCompactSnapshot } from '../../src/main/browser/ops/snapshot-compact.ts';
import { ExecStateStore } from '../../src/main/env/exec-state.ts';

function estTokens(text) {
  return Math.ceil(String(text).length / 4);
}

// 场景 1：表单提交弹窗 Action Delta（1 回合替代 click + snapshot + eval = 3 回合）
async function benchActionDelta() {
  const beforeNodes = [
    { role: 'textbox', name: '标题', ref: '@1', value: 'Q4 报告' },
    { role: 'button', name: '提交', ref: '@2' },
  ];
  const afterNodes = [
    ...beforeNodes,
    { role: 'dialog', name: '确认提交' },
    { role: 'button', name: '确认发布', ref: '@3' },
    { role: 'button', name: '取消', ref: '@4' },
  ];
  let phase = 'before';
  const net = [
    { id: 1, method: 'GET', url: 'https://app.test/bundle.js', status: 200, resourceType: 'script', at: 't' },
  ];
  const client = {
    currentUrl: () => 'https://app.test/editor',
    title: async () => 'Editor',
    snapshot: async () => (phase === 'before' ? beforeNodes : afterNodes),
    snapshotWithRefs: async () => afterNodes,
    evaluate: async () => '确认提交：发布后全员可见，是否继续？',
    peekUnhandledSideEffects: () => ({}),
    consumeHealedRefs: () => [],
  };
  const receipt = await runWithActionDelta(
    {
      client,
      scopeKey: 'bench:delta',
      networkEntries: () => [...net],
      includeText: true,
      settleMs: 0,
    },
    async () => {
      phase = 'after';
      net.push(
        { id: 2, method: 'GET', url: 'https://app.test/icon.svg', status: 200, resourceType: 'image', at: 't' },
        {
          id: 3,
          method: 'POST',
          url: 'https://app.test/api/draft/validate',
          status: 200,
          resourceType: 'fetch',
          at: 't',
        },
      );
      return { ok: true };
    },
  );
  const v4Text = formatActionResultText('click @2', receipt);
  const legacyBaseline =
    JSON.stringify({ ok: true }) +
    '\n' +
    JSON.stringify({ url: 'https://app.test/editor', title: 'Editor', nodes: afterNodes }, null, 2);
  assert.match(v4Text, /确认发布.*@3/);
  assert.match(v4Text, /POST \/api\/draft\/validate -> 200/);
  assert.doesNotMatch(v4Text, /icon\.svg/);
  return {
    name: '1. Form + Modal Action Delta',
    turnsBefore: 3,
    turnsAfter: 1,
    tokensBefore: estTokens(legacyBaseline),
    tokensAfter: estTokens(v4Text),
    tokenReductionPct: Math.round((1 - estTokens(v4Text) / estTokens(legacyBaseline)) * 100),
  };
}

// 场景 2：100 条选项 + 10 个禁用按钮 + 重复站点笔记会话去重
function benchSnapshotFoldingAndContext() {
  const nodes = [
    ...Array.from({ length: 100 }, (_, i) => ({
      role: 'option',
      name: `SKU-${String(i + 1).padStart(3, '0')}`,
      ref: `@${i + 1}`,
      depth: 1,
      selected: i === 42,
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      role: 'button',
      name: `已锁定操作 ${i + 1}`,
      ref: `@${200 + i}`,
      depth: 0,
      disabled: true,
    })),
  ];
  const note = [
    { site: 'shop.test', content: 'line1\nline2\nline3\nline4\nline5', updatedBy: 'human', updatedAt: 't1' },
  ];
  const tracker = new SessionContextTracker();
  tracker.consumeHints('bench:s1', 'https://shop.test/a', { siteNotes: note });
  const secondHints = tracker.consumeHints('bench:s1', 'https://shop.test/b', { siteNotes: note });

  const unfolded = formatCompactSnapshot({
    url: 'https://shop.test/b',
    title: 'Catalog',
    nodes,
    siteNotes: note,
    noFold: true,
    interactiveOnly: true,
  });
  const folded = formatCompactSnapshot({
    url: 'https://shop.test/b',
    title: 'Catalog',
    nodes,
    siteNotes: secondHints.siteNotes,
    notesAlreadyLoadedLines: secondHints.notesAlreadyLoadedLines,
    viewport: {
      width: 1280,
      height: 800,
      scrollX: 0,
      scrollY: 400,
      scrollWidth: 1280,
      scrollHeight: 3200,
      abovePx: 400,
      belowPx: 2000,
      scrollPercentY: 17,
      omittedBelow: 60,
    },
    interactiveOnly: true,
  });
  assert.match(folded, /SKU-043.*selected/);
  assert.match(folded, /more option folded/);
  return {
    name: '2. Long List Folding + Context Dedup',
    tokensBefore: estTokens(unfolded),
    tokensAfter: estTokens(folded),
    tokenReductionPct: Math.round((1 - estTokens(folded) / estTokens(unfolded)) * 100),
  };
}

// 场景 3：8 页面 4 并发隔离读取 vs 串行读取
async function benchConcurrentRead() {
  const urls = Array.from({ length: 8 }, (_, i) => `https://docs.test/article-${i + 1}`);
  const fakeOpen = async () => {
    let cur = '';
    return {
      load: async (url) => {
        cur = url;
        await new Promise((r) => setTimeout(r, 35));
      },
      client: {
        currentUrl: () => cur,
        title: async () => cur,
        evaluate: async () => ({ text: `Content for ${cur}` }),
      },
      close: () => {},
    };
  };
  const serial = await readUrlsConcurrently(urls, { concurrency: 1 }, fakeOpen);
  const parallel = await readUrlsConcurrently(urls, { concurrency: 4 }, fakeOpen);
  assert.equal(parallel.ok, 8);
  return {
    name: '3. Offscreen 4x Concurrent Read (8 URLs)',
    serialMs: serial.durationMs,
    parallelMs: parallel.durationMs,
    speedup: `${(serial.durationMs / Math.max(1, parallel.durationMs)).toFixed(2)}x`,
  };
}

// 场景 4：Exec v2 报错后持久 state 续跑
async function benchExecStateResume() {
  const store = new ExecStateStore();
  let fetchedPages = 0;
  const call = async (method, params = {}) => {
    const scope = `${params.id}:agent:default`;
    if (method === 'env.acquire') return { leaseId: 'L', leaseExpiresAt: Date.now() + 60_000 };
    if (method === 'env.release') return { ok: true };
    if (method === 'exec.state.get') return store.get(scope);
    if (method === 'exec.state.set') return store.set(scope, params.state);
    if (method === 'browser.read') {
      fetchedPages += 1;
      return { url: 'https://a.test', title: 'A', text: `page-${fetchedPages}` };
    }
    if (method === 'browser.info') return { url: 'https://a.test', title: 'A', dialog: null };
    return {};
  };

  await assert.rejects(() =>
    runExecCommand({
      args: ['exec', 'bench'],
      flags: { 'no-tail-state': true },
      asJson: true,
      call,
      readStdin: async () =>
        `state.items ??= []; state.items.push((await page.read()).text); state.items.push((await page.read()).text); throw new Error('network hiccup');`,
      startLeaseRenewer: () => () => {},
      defaultTimeoutMs: 5000,
    }),
  );
  await runExecCommand({
    args: ['exec', 'bench'],
    flags: { 'no-tail-state': true },
    asJson: true,
    call,
    readStdin: async () => `state.items.push((await page.read()).text); return state.items.length;`,
    startLeaseRenewer: () => () => {},
    defaultTimeoutMs: 5000,
  });
  assert.equal(fetchedPages, 3, '断点续跑仅补读第 3 页，零返工');
  return {
    name: '4. Exec v2 Persistent State Resume',
    reworkPagesBefore: 2,
    reworkPagesAfter: 0,
    totalFetches: fetchedPages,
  };
}

// 场景 5：Auto-Flow v2 零手写模板录制并 1 步复跑
async function benchAutoFlow() {
  const ring = new ActionTraceRing();
  ring.record('bench', {
    action: 'fill',
    target: '@q',
    value: 'keyboard',
    urlBefore: 'https://shop.test',
    urlAfter: 'https://shop.test',
    netBeforeId: 1,
    netAfterId: 1,
  });
  ring.record('bench', {
    action: 'click',
    target: '@go',
    urlBefore: 'https://shop.test',
    urlAfter: 'https://shop.test/s',
    netBeforeId: 1,
    netAfterId: 2,
  });
  const cands = correlateStepsWithNetwork(ring.list('bench'), [
    {
      id: 2,
      method: 'GET',
      url: 'https://shop.test/api/products?q=keyboard&sort=hot',
      status: 200,
      resourceType: 'fetch',
      at: 't',
    },
  ]);
  const sample = JSON.stringify({
    data: {
      items: [
        { id: 1, name: 'Mech Keyboard', price: 199 },
        { id: 2, name: 'Mouse', price: 49 },
      ],
    },
  });
  const built = buildFlowSpecFromRecordedRequest(cands[0].url, { params: { q: 'keyboard' }, sampleBody: sample });
  const res = await executeSavedFlow(
    { name: 'search-products', site: built.site, spec: built.spec, updatedBy: 'agent', updatedAt: 'now' },
    async (url) => ({ ok: true, status: 200, statusText: 'OK', url, headers: {}, body: sample }),
    { params: { q: 'keyboard' }, where: { name: 'mech' } },
  );
  assert.equal(res.count, 1);
  return {
    name: '5. Auto-Flow v2 Zero-Template Reuse',
    recordedRef: cands[0].ref,
    inferredExtractPath: built.spec.extractPath,
    turnsBefore: 6,
    turnsAfter: 1,
  };
}

const report = [
  await benchActionDelta(),
  benchSnapshotFoldingAndContext(),
  await benchConcurrentRead(),
  await benchExecStateResume(),
  await benchAutoFlow(),
];
console.log(JSON.stringify({ benchmark: 'warren-v4-agent-efficiency', scenarios: report }, null, 2));
