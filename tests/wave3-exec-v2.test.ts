import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatExecErrorSnippet, runExecCommand, writeExecOutputFile } from '../bin/commands/system.mjs';
import { helpApi, suggestClosestMethods } from '../bin/exec-api-schema.mjs';
import { createPageApi, describeCapabilities } from '../bin/exec-runtime.mjs';
import { ExecStateStore, writeExecCheckpoint } from '../src/main/env/exec-state.ts';

test('ExecStateStore 按环境隔离内存态、随 env.stop 清理并拦截敏感凭据字段', () => {
  const store = new ExecStateStore();
  assert.deepEqual(store.get('envA:agent:default').state, {});

  store.set('envA:agent:default', { cursor: 3, items: ['a', 'b'] });
  store.set('envA:agent:job2', { step: 2 });
  store.set('envB:agent:default', { keep: true });

  assert.deepEqual(store.get('envA:agent:default').state, { cursor: 3, items: ['a', 'b'] });
  assert.throws(
    () => store.set('envA:agent:default', { password: 'secret-value' }),
    (err: { code?: string }) => err.code === 'SECRET_REJECTED',
  );
  assert.throws(
    () => store.set('envA:agent:default', { pem: '-----BEGIN RSA PRIVATE KEY-----\nabc' }),
    (err: { code?: string }) => err.code === 'SECRET_REJECTED',
  );

  // clearEnv 只清理目标环境
  assert.equal(store.clearEnv('envA'), 2);
  assert.deepEqual(store.get('envA:agent:default').state, {});
  assert.deepEqual(store.get('envB:agent:default').state, { keep: true });
});

test('writeExecCheckpoint 原子落盘受控路径并拦截路径穿越与凭据字段', () => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'warren-ckpt-'));
  try {
    const saved = writeExecCheckpoint('env-1', 'orders-step-1', { count: 2, ids: [1, 2] }, { warrenHome: tmpHome });
    assert.ok(saved.path.startsWith(path.join(tmpHome, 'checkpoints', 'env-1')));
    const parsed = JSON.parse(readFileSync(saved.path, 'utf8'));
    assert.equal(parsed.name, 'orders-step-1');
    assert.deepEqual(parsed.value, { count: 2, ids: [1, 2] });

    assert.throws(
      () => writeExecCheckpoint('env-1', '../escape', { x: 1 }, { warrenHome: tmpHome }),
      (err: { code?: string }) => err.code === 'PATH_DENIED',
    );
    assert.throws(
      () => writeExecCheckpoint('env-1', 'bad', { totp: '123456' }, { warrenHome: tmpHome }),
      (err: { code?: string }) => err.code === 'SECRET_REJECTED',
    );
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('helpApi、describeCapabilities(--detailed) 与 UNSUPPORTED_PAGE_API 模糊推荐生效', () => {
  assert.match(helpApi(), /globals\s*:/);
  assert.match(helpApi('snapshot'), /page\.snapshot/);
  assert.match(helpApi('state'), /持久化内存对象/);
  assert.ok(suggestClosestMethods('clik', ['click', 'dblclick', 'fill']).includes('click'));

  const page = createPageApi(() => {
    throw new Error('no rpc');
  });
  const detailed = describeCapabilities(page, { detailed: true }) as {
    signatures?: { page?: Record<string, unknown> };
  };
  assert.ok(detailed.signatures?.page?.snapshot);

  assert.throws(
    () => (page as Record<string, unknown>).clik,
    (err: { code?: string; message?: string }) =>
      err.code === 'UNSUPPORTED_PAGE_API' && /最相近的合法方法.*click/.test(err.message ?? ''),
  );
});

test('runExecCommand 跨调用持久化 state、中途报错仍回写 state、精准行号上下文与 --out 落盘', async () => {
  const store = new ExecStateStore();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'warren-exec-out-'));
  const savedCheckpoints: Array<{ name: string; value: unknown }> = [];
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const scope = `${params.id}:agent:${params.session ?? 'default'}`;
    if (method === 'env.acquire') return { leaseId: 'L1', leaseExpiresAt: Date.now() + 60_000 };
    if (method === 'env.release') return { ok: true };
    if (method === 'exec.state.get') return store.get(scope);
    if (method === 'exec.state.set') return store.set(scope, params.state);
    if (method === 'exec.state.clear') return store.clear(scope);
    if (method === 'exec.checkpoint') {
      savedCheckpoints.push({ name: String(params.name), value: params.value });
      return { path: '/tmp/ckpt.json', bytes: 12, name: params.name, savedAt: 'now' };
    }
    if (method === 'browser.info') return { url: 'https://app.test/list', title: 'List', dialog: null };
    throw new Error(`unexpected method ${method}`);
  };

  try {
    // 第 1 次执行：写 state 后中途抛错，仍应自动回写 state 并支持精准行号片段
    const failingCode = `state.done = ['item-1'];\nawait checkpoint('p1', state.done);\nthrow new Error('boom-at-line-3');`;
    await assert.rejects(
      () =>
        runExecCommand({
          args: ['exec', 'demo'],
          flags: { 'no-tail-state': true },
          asJson: true,
          call,
          readStdin: async () => failingCode,
          startLeaseRenewer: () => () => {},
          defaultTimeoutMs: 5000,
        }),
      (err: Error) => {
        const snippet = formatExecErrorSnippet(failingCode, err);
        assert.match(snippet, /warren-exec\.js:3/);
        assert.match(snippet, />   3 \| throw new Error\('boom-at-line-3'\);/);
        return true;
      },
    );
    assert.deepEqual(store.get('demo:agent:default').state, { done: ['item-1'] });
    assert.equal(savedCheckpoints.length, 1);

    // 第 2 次执行：续读上次保留的 state，并将结果以 --out 原子落盘为 jsonl
    const outFile = path.join(tmpDir, 'rows.jsonl');
    const code2 = `state.done.push('item-2');\nreturn state.done.map((id, i) => ({ idx: i + 1, id }));`;
    const exitCode = await runExecCommand({
      args: ['exec', 'demo'],
      flags: { out: outFile, 'no-tail-state': true },
      asJson: true,
      call,
      readStdin: async () => code2,
      startLeaseRenewer: () => () => {},
      defaultTimeoutMs: 5000,
    });
    assert.equal(exitCode, 0);
    const lines = readFileSync(outFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(lines, [
      { idx: 1, id: 'item-1' },
      { idx: 2, id: 'item-2' },
    ]);

    // writeExecOutputFile CSV 落盘
    const csvFile = path.join(tmpDir, 'rows.csv');
    const csvMeta = writeExecOutputFile(csvFile, [{ id: 'A', label: 'hello, world' }]);
    assert.equal(csvMeta.rows, 1);
    assert.match(readFileSync(csvFile, 'utf8'), /"hello, world"/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
