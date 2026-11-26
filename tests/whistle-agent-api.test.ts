import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_ENDPOINTS, agentApiFor, isAgentApiVersion, resolveAgentMethod } from '../plugins/whistle/agent-api.mjs';
import hostPlugin from '../plugins/whistle/host.mjs';
import { agent, agentStatus, requireLiveAgentInstance } from '../plugins/whistle/lib/traffic.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const manifest = path.join(ROOT, 'plugins', 'whistle', 'package.json');

test('官方能力清单覆盖 network/rules/values/plugins/HTTPS 与 2.10.15 createUrl', () => {
  assert.equal(isAgentApiVersion('2.10.6'), false);
  assert.equal(isAgentApiVersion('2.10.7'), true);
  assert.equal(isAgentApiVersion('2.10.12'), true);
  assert.equal(isAgentApiVersion('2.10.15'), true);
  for (const method of [
    'network.getStatus',
    'network.getSessions',
    'network.getFrames',
    'network.request',
    'network.saveSessions',
    'rules.getStatus',
    'rules.getList',
    'rules.get',
    'rules.add',
    'rules.select',
    'rules.unselect',
    'values.getList',
    'values.get',
    'values.add',
    'values.remove',
    'values.rename',
    'plugins.getStatus',
    'plugins.getList',
    'plugins.get',
    'isEnabledHTTPS',
    'setEnableHTTPS',
    'getRootCA',
    'createFile',
    'getFile',
    'createUrl',
  ]) {
    assert.ok((AGENT_ENDPOINTS as Record<string, readonly string[]>)[method], method);
  }
});

test('resolveAgentMethod 支持无点平铺写法与命名空间别名路由', () => {
  for (const [input, canonical, group] of [
    ['isEnabledHTTPS', 'isEnabledHTTPS', 'https'],
    ['https.isEnabled', 'isEnabledHTTPS', 'https'],
    ['setEnableHTTPS', 'setEnableHTTPS', 'https'],
    ['https.setEnabled', 'setEnableHTTPS', 'https'],
    ['getRootCA', 'getRootCA', 'https'],
    ['https.getRootCA', 'getRootCA', 'https'],
    ['createFile', 'createFile', 'files'],
    ['files.create', 'createFile', 'files'],
    ['getFile', 'getFile', 'files'],
    ['files.get', 'getFile', 'files'],
    ['createUrl', 'createUrl', 'network'],
    ['network.createUrl', 'createUrl', 'network'],
    ['values.remove', 'values.remove', 'values'],
    ['values.rename', 'values.rename', 'values'],
  ]) {
    const resolved = resolveAgentMethod(input);
    assert.ok(resolved, `无法解析方法 ${input}`);
    assert.equal(resolved.canonical, canonical);
    assert.equal(resolved.group, group);
  }
  assert.equal(resolveAgentMethod('nonExistentMethod'), null);
});

test('插件暴露 agent / agentStatus，并与 RPC 共用同一派发表', async () => {
  const data = JSON.parse(await readFile(manifest, 'utf8')).warren;
  assert.equal(typeof (hostPlugin as Record<string, unknown>).agent, 'function');
  assert.equal(typeof (hostPlugin.rpc as Record<string, unknown>).agent, 'function');
  assert.equal(typeof (hostPlugin as Record<string, unknown>).agentStatus, 'function');
  assert.equal(typeof (hostPlugin.rpc as Record<string, unknown>).agentStatus, 'function');
  assert.equal(
    data.contributes.commands.some((item: { name: string }) => item.name === 'agent'),
    true,
  );
  assert.equal(
    data.contributes.commands.some((item: { name: string }) => item.name === 'agentStatus'),
    true,
  );
  assert.equal(data.contributes.rpc.includes('agent'), true);
  assert.equal(data.contributes.rpc.includes('agentStatus'), true);
});

test('Agent API 使用隔离 HOME、版本门槛校验并精准路由到实例端口', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warren-whistle-api-test-'));
  const seenRequests: Array<{ url: string; method: string }> = [];
  let reportedVersion = '2.10.15';

  const server = http.createServer((req, res) => {
    seenRequests.push({ url: req.url || '/', method: req.method || 'GET' });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/cgi-bin/status') {
      res.end(JSON.stringify({ version: reportedVersion, storage: 'iso-a' }));
      return;
    }
    if (req.url === '/cgi-bin/rules/list') {
      res.end(
        JSON.stringify({
          ec: 0,
          list: [{ name: 'warren', data: 'a.test 127.0.0.1:9000', selected: true }],
        }),
      );
      return;
    }
    if (req.url === '/cgi-bin/rules/status') {
      res.end(JSON.stringify({ ec: 0, count: 1 }));
      return;
    }
    if (req.url === '/cgi-bin/plugins/status') {
      res.end(JSON.stringify({ ec: 0, count: 0 }));
      return;
    }
    if (req.url === '/cgi-bin/is-enabled-https') {
      res.end(JSON.stringify({ enabled: true }));
      return;
    }
    res.end(JSON.stringify({ ec: 0, items: [{ id: 's1' }] }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  const homeLog = path.join(dir, 'home-log.json');
  const stubApiFile = path.join(dir, 'api-stub.cjs');
  const stubW2Script = path.join(dir, 'stub-w2.cjs');

  await writeFile(
    stubApiFile,
    `module.exports = {
      network: { getStatus() {}, getSessions() {} },
      rules: { getList() {}, getStatus() {} },
      plugins: { getStatus() {} },
      isEnabledHTTPS() {},
    };`,
  );
  await writeFile(
    stubW2Script,
    `const fs = require('node:fs');
    fs.writeFileSync(process.env.STUB_HOME_LOG, JSON.stringify({ home: process.env.HOME, argv: process.argv.slice(2) }));
    process.stdout.write(process.env.STUB_API_FILE);`,
  );

  const isolatedHomeDir = path.join(os.tmpdir(), 'warren-whistle-api-iso-a-999999');

  try {
    const api = agentApiFor(
      { storage: 'iso-a', port, pid: 999_999, specialAuth: 'tok-xyz' },
      {
        file: process.execPath,
        prefixArgs: [stubW2Script],
        env: { STUB_HOME_LOG: homeLog, STUB_API_FILE: stubApiFile },
        display: 'stub-w2',
        source: 'test',
      },
    );

    const rules = await api.rules.getList();
    assert.deepEqual(rules, [{ name: 'warren', value: 'a.test 127.0.0.1:9000', selected: true }]);
    assert.equal(seenRequests[0]?.url, '/cgi-bin/status');
    assert.equal(seenRequests[1]?.url, '/cgi-bin/rules/list');

    const w2Call = JSON.parse(await readFile(homeLog, 'utf8')) as { home: string; argv: string[] };
    assert.deepEqual(w2Call.argv, ['root', 'bin/api']);
    assert.notEqual(w2Call.home, os.homedir());
    const clientPid = await readFile(path.join(w2Call.home, '.whistle_client.pid'), 'utf8');
    assert.equal(clientPid, `999999,127.0.0.1,${port},tok-xyz\n`);

    reportedVersion = '2.10.6';
    await assert.rejects(
      () => api.network.getStatus(),
      (error: Error & { code?: string }) => error.code === 'WHISTLE_API_VERSION',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(isolatedHomeDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('Agent API 端到端通过 traffic.mjs 调用内置 Whistle（别名解析与规则脱敏）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warren-whistle-traffic-agent-'));
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/cgi-bin/status') {
      res.end(JSON.stringify({ name: 'whistle', version: '2.10.15', storage: 'live-e2e' }));
      return;
    }
    if (req.url === '/cgi-bin/rules/list') {
      res.end(
        JSON.stringify({ ec: 0, list: [{ name: 'warren', data: 'secret.test 127.0.0.1:9000', selected: true }] }),
      );
      return;
    }
    if (req.url === '/cgi-bin/rules/status') {
      res.end(JSON.stringify({ ec: 0, activeCount: 1 }));
      return;
    }
    if (req.url === '/cgi-bin/plugins/status') {
      res.end(JSON.stringify({ ec: 0, count: 0 }));
      return;
    }
    if (req.url === '/cgi-bin/is-enabled-https') {
      res.end(JSON.stringify({ enabled: true }));
      return;
    }
    res.end(JSON.stringify({ ec: 0 }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const whistleDir = path.join(dir, 'whistle-root');
  const startingDir = path.join(whistleDir, '.startingAppData');
  await mkdir(startingDir, { recursive: true });
  await writeFile(
    path.join(startingDir, '#live-e2e#'),
    JSON.stringify({ pid: process.pid, options: { storage: 'live-e2e', port } }),
  );
  const isolatedHome = path.join(os.tmpdir(), `warren-whistle-api-live-e2e-${process.pid}`);

  const fakeHost = {
    settings: { get: async () => ({ whistlePath: whistleDir }) },
    log: { warn: async () => undefined },
    storage: {
      kv: {
        get: async () => [{ storage: 'live-e2e', port, startingDataDir: whistleDir }],
      },
    },
  };

  try {
    const viaAlias = await agent(fakeHost, { storage: 'live-e2e', method: 'https.isEnabled' });
    assert.equal(viaAlias.method, 'isEnabledHTTPS');
    assert.equal(viaAlias.result, true);

    const redactedRules = await agent(fakeHost, { storage: 'live-e2e', method: 'rules.getList' });
    assert.deepEqual(redactedRules.result, [{ name: 'warren', value: '', selected: true }]);

    const fullRules = await agent(fakeHost, {
      storage: 'live-e2e',
      method: 'rules.getList',
      includeValues: true,
    });
    assert.deepEqual(fullRules.result, [{ name: 'warren', value: 'secret.test 127.0.0.1:9000', selected: true }]);

    const summary = await agentStatus(fakeHost, { storage: 'live-e2e' });
    assert.equal(summary.https, true);
    assert.equal((summary.status as { storage: string }).storage, 'live-e2e');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(isolatedHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('Agent API 使用已验证 live pid，不依赖 startingData 注册表', async () => {
  const api = agentApiFor(
    { storage: 'live-instance', port: 8933, pid: 20_505 },
    {
      file: '/definitely/missing/whistle.js',
      prefixArgs: [],
      env: {},
      display: 'missing-test-w2',
      source: 'test',
    },
  );

  await assert.rejects(
    () => api.network.getStatus(),
    (error: Error & { code?: string }) => {
      assert.notEqual(error.code, 'WHISTLE_API_INSTANCE_UNKNOWN');
      assert.equal(error.code, 'WHISTLE_API_LOAD_FAILED');
      return true;
    },
  );
});

test('Agent API 只接受同 storage 存活实例与有效 pid', () => {
  const instance = { storage: 'live-instance', port: 8933 };
  assert.deepEqual(requireLiveAgentInstance(instance, { storage: 'live-instance' }, 20_505), {
    ...instance,
    pid: 20_505,
  });
  assert.throws(
    () => requireLiveAgentInstance(instance, { storage: 'other-instance' }, 20_505),
    (error: Error & { code?: string }) => error.code === 'WHISTLE_INSTANCE_MISMATCH',
  );
  assert.throws(
    () => requireLiveAgentInstance(instance, { storage: 'live-instance' }, null),
    (error: Error & { code?: string }) => error.code === 'WHISTLE_API_INSTANCE_UNKNOWN',
  );
});
