import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDatabases, openDatabase } from '../src/main/db.ts';
import { PluginHost } from '../src/main/plugins/host.ts';
import { dispatchHostRead } from '../src/main/plugins/host-read.ts';

test('caller 权威透传与双 Space fillSecret：ui 可免 lease 填 Person Space，agent 严锁 Agent Space 与域名白名单', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-dual-space-'));
  const pluginSrc = path.join(root, 'plugin-src');
  const db = openDatabase(path.join(root, 'warren.db'));

  const fillCalls: Array<{ envId: string; space: string; target: unknown; value: string }> = [];
  const leaseAcquires: string[] = [];
  let currentUrl = 'https://good.example.test/login';

  const fakeManager = {
    get: (id: string) => ({
      id,
      name: 'Alpha',
      status: 'running',
      owner: 'none',
      activeSpaceId: 'person',
      spaces: [
        {
          id: 'person',
          activeTabId: 't1',
          tabs: [{ id: 't1', url: currentUrl, title: '登录页' }],
        },
      ],
    }),
    selected: 'env-a',
    acquire: (envId: string) => {
      leaseAcquires.push(envId);
      return { leaseId: 'lease-1' };
    },
    release: () => undefined,
    assertWritable: () => undefined,
    ensureOperable: () => false,
    assertInputOnScreen: () => undefined,
    assertActiveTab: () => undefined,
    focusForInput: async () => undefined,
    prepareBackgroundInput: async () => false,
    clearBackgroundInput: async () => undefined,
    detachOperable: () => undefined,
    controllerFor: (envId: string, _tab: unknown, space: string = 'agent') => ({
      currentUrl: () => currentUrl,
      title: async () => '登录页',
      fill: async (target: unknown, value: string) => {
        fillCalls.push({ envId, space, target, value });
      },
      detectLoginFields: async () => ({
        url: currentUrl,
        host: new URL(currentUrl).hostname,
        step: 'single',
        fields: {
          password: {
            kind: 'password',
            selector: '#pwd',
            target: '#pwd',
            confidence: 0.9,
            rect: { x: 0, y: 0, width: 100, height: 30 },
          },
        },
        candidates: [],
      }),
    }),
  } as never;

  const host = new PluginHost({
    root: path.join(root, 'plugins'),
    manager: fakeManager,
    vault: {
      available: false,
      list: () => [],
      add: () => ({ ref: '' }),
      remove: () => true,
      reveal: () => ({}),
    } as never,
    store: { record: () => undefined, appSettings: () => ({ controlPolicy: 'ask', pluginPolicy: 'auto' }) } as never,
    db,
    saveVault: async () => undefined,
    appVersion: '0.1.0',
    reconnectBaseMs: 0,
  });

  try {
    await mkdir(pluginSrc, { recursive: true });
    await writeFile(
      path.join(pluginSrc, 'package.json'),
      JSON.stringify({
        name: 'warren-plugin-dual-space',
        version: '0.1.0',
        files: ['server.js'],
        warren: {
          id: 'com.test.dualspace',
          name: 'DualSpace',
          apiVersion: '4',
          runtime: 'sandbox',
          server: 'server.js',
          permissions: ['environment.read', 'browser.dom.read', 'vault.fill', 'rpc.serve'],
          contributes: {
            commands: [{ name: 'doFill', summary: '填充测试' }],
            rpc: ['doFill', 'detect'],
          },
        },
      }),
    );
    await writeFile(
      path.join(pluginSrc, 'server.js'),
      `
      module.exports = {
        async doFill(ctx) {
          return ctx.host.browser.fillSecret(ctx.input.envId, '#pwd', '[REDACTED]', ctx.input.options);
        },
        rpc: {
          async doFill(input, ctx) {
            // 故意试图在插件内篡改 ctx.caller（不应影响主进程权威 caller）
            ctx.caller = 'ui';
            return ctx.host.browser.fillSecret(input.envId, '#pwd', '[REDACTED]', input.options);
          },
          async detect(input, ctx) {
            return ctx.host.browser.detectLoginFields(input.envId, input.options);
          },
        },
      };
      `,
    );

    await host.load();
    await host.install(`path:${pluginSrc}`);
    await host.enable('com.test.dualspace');

    // 1. caller=ui 填 Person Space：直接成功且不申请 Agent lease
    const uiRes = await host.rpc(
      'com.test.dualspace',
      'doFill',
      { envId: 'env-a', options: { space: 'person', allowedDomains: ['good.example.test'] } },
      { caller: 'ui' },
    );
    assert.equal(uiRes.ok, true, uiRes.message);
    assert.equal(leaseAcquires.length, 0, 'ui 填 Person Space 不应取 Agent lease');
    assert.equal(fillCalls.at(-1)?.space, 'person');

    // 2. caller=agent 试图填 Person Space（即使插件代码篡改 ctx.caller='ui'）：必须被主进程拒掉
    const agentPersonRes = await host.rpc(
      'com.test.dualspace',
      'doFill',
      { envId: 'env-a', options: { space: 'person' } },
      { caller: 'agent' },
    );
    assert.equal(agentPersonRes.ok, false);
    assert.equal(agentPersonRes.code, 'SPACE_FORBIDDEN');

    // 3. caller=agent 填 Agent Space 但域名不匹配白名单：必须被 PATH_DENIED 拦下
    currentUrl = 'https://phishing.evil.test/login';
    const agentDenied = await host.rpc(
      'com.test.dualspace',
      'doFill',
      { envId: 'env-a', options: { allowedDomains: ['good.example.test'] } },
      { caller: 'agent' },
    );
    assert.equal(agentDenied.ok, false);
    assert.equal(agentDenied.code, 'PATH_DENIED');

    // 4. caller=agent 在允许域名上填 Agent Space：走 Agent lease 并成功落到 agent space
    currentUrl = 'https://good.example.test/login';
    const leasesBefore = leaseAcquires.length;
    const agentOk = await host.rpc(
      'com.test.dualspace',
      'doFill',
      { envId: 'env-a', options: { allowedDomains: ['good.example.test'] } },
      { caller: 'agent' },
    );
    assert.equal(agentOk.ok, true, agentOk.message);
    assert.equal(leaseAcquires.length, leasesBefore + 1);
    assert.equal(fillCalls.at(-1)?.space, 'agent');

    // 5. hostRead: environment.activeContext 返回当前选中环境、Space 与活跃 Tab
    const activeCtx = await dispatchHostRead(
      { manager: fakeManager, require: () => undefined },
      'environment.activeContext',
      undefined,
      [],
    );
    assert.deepEqual(activeCtx, {
      environmentId: 'env-a',
      environmentName: 'Alpha',
      status: 'running',
      space: 'person',
      tabId: 't1',
      url: 'https://good.example.test/login',
      title: '登录页',
    });
  } finally {
    await host.dispose();
    closeDatabases();
    await rm(root, { recursive: true, force: true });
  }
});
