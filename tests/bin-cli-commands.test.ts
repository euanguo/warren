import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../bin/cli.mjs';

interface RecordedRpcCall {
  method: string;
  params: unknown;
}

function createFakeRpc(responses: Record<string, unknown> = {}) {
  const calls: RecordedRpcCall[] = [];
  let leaseSeq = 0;

  const call = async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (Object.hasOwn(responses, method)) {
      const value = responses[method];
      return typeof value === 'function' ? (value as (p: unknown) => unknown)(params) : value;
    }
    return { ok: true };
  };

  const withLease = async <T>(
    id: string,
    _flags: Record<string, unknown>,
    _label: string,
    fn: (leaseId: string) => Promise<T>,
  ): Promise<T> => {
    const leaseId = `lease-${++leaseSeq}`;
    calls.push({ method: 'env.acquire', params: { id } });
    try {
      return await fn(leaseId);
    } finally {
      calls.push({ method: 'env.release', params: { id, leaseId } });
    }
  };

  return { calls, call, withLease };
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  const origErr = console.error;
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' ') + '\n');
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' ') + '\n');
  try {
    const result = await fn();
    return { result, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
    console.error = origErr;
  }
}

test('runCli：help、--skill 与未知命令组返回正确退出码', async () => {
  const rpc = createFakeRpc({ 'skills.compose': { markdown: '# TEST SKILL' } });
  const helpRun = await captureStdout(() => runCli(['--help'], { rpc }));
  assert.equal(helpRun.result, 0);
  assert.match(helpRun.stdout, /warren/);

  const skillRun = await captureStdout(() => runCli(['--skill'], { rpc }));
  assert.equal(skillRun.result, 0);
  assert.match(skillRun.stdout, /# TEST SKILL/);

  const unknown = await captureStdout(() => runCli(['not-a-group'], { rpc }));
  assert.equal(unknown.result, 1);
  assert.match(unknown.stderr, /未知命令组/);
});

test('runCli：env / tab / net / vault / plugin 命令正确拼接参数并管理 lease 与 secret', async () => {
  const rpc = createFakeRpc({
    'env.list': [{ id: 'e1', name: 'E1', status: 'stopped', activeSpaceId: 'person', spaces: [] }],
    'tab.list': [{ id: 't1', url: 'https://a.test', title: 'A', active: true }],
    'vault.add': { ref: 'v-1', provider: 'github', label: 'prod' },
    'net.rule.add': { id: 'r1', match: { url: '*/api/*' }, action: { type: 'block' }, enabled: true },
    'plugin.run': { result: { pong: 1 } },
  });

  const envOut = await captureStdout(() =>
    runCli(['env', 'create', 'alpha', '--proxy=http://127.0.0.1:8899', '--start-url=https://x.test', '--json'], {
      rpc,
    }),
  );
  assert.equal(envOut.result, 0);
  assert.deepEqual(rpc.calls[0], {
    method: 'env.create',
    params: {
      id: 'alpha',
      proxy: 'http://127.0.0.1:8899',
      startUrl: 'https://x.test',
      headed: undefined,
    },
  });

  // person space 写 tab 不申请 agent lease；agent space 写 tab 走 withLease
  await captureStdout(() => runCli(['tab', 'new', 'alpha', '--space=person', 'https://a.test', '--json'], { rpc }));
  assert.equal(rpc.calls.at(-1)?.method, 'tab.new');
  assert.equal((rpc.calls.at(-1)?.params as { leaseId?: string } | undefined)?.leaseId, undefined);

  await captureStdout(() => runCli(['tab', 'close', 'alpha', '2', '--json'], { rpc }));
  assert.ok(
    rpc.calls.some((c) => c.method === 'tab.close' && (c.params as { leaseId?: string }).leaseId === 'lease-1'),
  );
  assert.equal(rpc.calls.at(-1)?.method, 'env.release');

  // net rule add 走 withLease
  const netOut = await captureStdout(() =>
    runCli(['net', 'rule', 'add', 'alpha', '--match=*/api/*', '--block', '--json'], { rpc }),
  );
  assert.equal(netOut.result, 0);
  const netCall = rpc.calls.find((c) => c.method === 'net.rule.add');
  assert.deepEqual(netCall?.params, {
    id: 'alpha',
    leaseId: 'lease-2',
    rule: {
      match: { url: '*/api/*', isRegex: false, method: undefined },
      priority: undefined,
      action: { type: 'block' },
    },
  });

  // vault add 从 stdin 读凭据，不经 argv
  const vaultOut = await captureStdout(() =>
    runCli(['vault', 'add', 'github', '--label=prod', '--json'], {
      rpc,
      readStdin: async () => JSON.stringify({ username: 'u', password: '[REDACTED]' }),
    }),
  );
  assert.equal(vaultOut.result, 0);
  assert.equal(JSON.parse(vaultOut.stdout).ref, 'v-1');

  // plugin run 带 --input
  const pluginOut = await captureStdout(() =>
    runCli(['plugin', 'run', 'com.test.demo', 'ping', '--env=alpha', '--input={"x":2}', '--json'], { rpc }),
  );
  assert.equal(pluginOut.result, 0);
  assert.deepEqual(rpc.calls.at(-1), {
    method: 'plugin.run',
    params: { id: 'com.test.demo', command: 'ping', env: 'alpha', input: { x: 2 }, leaseId: undefined },
  });
});
