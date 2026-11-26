import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_ENDPOINTS, agentApiFor, isAgentApiVersion, resolveAgentMethod } from '../plugins/whistle/agent-api.mjs';
import { requireLiveAgentInstance } from '../plugins/whistle/host.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const host = path.join(ROOT, 'plugins', 'whistle', 'host.mjs');
const agent = path.join(ROOT, 'plugins', 'whistle', 'agent-api.mjs');
const manifest = path.join(ROOT, 'plugins', 'whistle', 'package.json');

test('Whistle Agent API 版本门槛与隔离寻址存在', async () => {
  const source = await readFile(agent, 'utf8');
  assert.match(source, /2\.10\.7/);
  assert.match(source, /w2.*root.*bin\/api/);
  assert.match(source, /isAgentApiVersion/);
  assert.match(source, /instance\.pidFile|startingDataDir/);
  assert.match(source, /127\.0\.0\.1/);
  const pkg = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(pkg.dependencies.whistle, '2.10.15');
});

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
    assert.ok(AGENT_ENDPOINTS[method], method);
  }
});

test('resolveAgentMethod 支持无点平铺写法与命名空间别名路由', async () => {
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
  const hostSource = await readFile(host, 'utf8');
  assert.match(hostSource, /resolveAgentMethod/);
});

test('官方 Agent API 只通过实例端口调用，不回落到 8899', async () => {
  const source = await readFile(agent, 'utf8');
  assert.match(source, /port:.*instance\.port|instance\.port/);
  assert.doesNotMatch(source, /127\.0\.0\.1:8899/);
  assert.match(source, /network\.getSessions/);
  assert.match(source, /rules\.getList/);
  assert.match(source, /plugins\.getStatus/);
  assert.match(source, /getRootCA/);
});

test('插件暴露 agent / agentStatus，并对 rules 正文默认脱敏', async () => {
  const source = await readFile(host, 'utf8');
  const data = JSON.parse(await readFile(manifest, 'utf8')).warren;
  assert.match(source, /async function agent\(host, input\)/);
  assert.match(source, /includeValues/);
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
