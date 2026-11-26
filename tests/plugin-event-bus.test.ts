import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabases, openDatabase } from '../src/main/db.ts';
import {
  EVENT_BUS_MAX_QUEUE_PER_PLUGIN,
  PLUGIN_EVENT_TYPES,
  PluginEventBus,
  sanitizeEvent,
  type PluginBusEvent,
} from '../src/main/plugins/event-bus.ts';
import { createHandlers, dispatchHostCall } from '../src/main/plugins/api.ts';
import { PluginHost } from '../src/main/plugins/host.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('PluginEventBus：事件类型白名单、按环境/类型过滤与 sanitizeEvent 防御脱敏', async () => {
  const delivered: Array<{ pluginId: string; subId: string; event: PluginBusEvent }> = [];
  const bus = new PluginEventBus((pluginId, subId, event) => {
    delivered.push({ pluginId, subId, event });
  });

  assert.deepEqual([...PLUGIN_EVENT_TYPES], ['nav.committed', 'lease.changed', 'tab.created', 'env.status', 'net.hit']);
  assert.throws(
    () => bus.subscribe('p1', { types: ['cookie.steal' as never] }),
    (error: Error & { code?: string }) => error.code === 'PLUGIN_BAD_REQUEST',
  );

  const sub1 = bus.subscribe('p1', { environmentId: 'env-1', types: ['nav.committed', 'net.hit'] });
  assert.equal(bus.subscriptionCount('p1'), 1);
  assert.equal(bus.subscriptionCount(), 1);

  // 非白名单事件被静默忽略
  bus.dispatchEvent({ type: 'internal.secret', environmentId: 'env-1', at: 't0', payload: { x: 1 } });
  // 不匹配环境 / 类型被过滤
  bus.dispatchEvent({ type: 'nav.committed', environmentId: 'env-2', at: 't1', payload: { url: 'https://a.test' } });
  bus.dispatchEvent({ type: 'tab.created', environmentId: 'env-1', at: 't2', payload: { tabId: 'tab-1' } });
  // 匹配事件（携带敏感字段：必须被脱敏清除）
  bus.dispatchEvent({
    type: 'net.hit',
    environmentId: 'env-1',
    at: 't3',
    payload: {
      url: 'https://api.example.test/login',
      status: 200,
      cookie: 'session=secret',
      cookies: [{ name: 'sid', value: 'raw' }],
      password: '[REDACTED]',
      token: 'tok',
      body: '<html>secret page</html>',
      html: '<div>secret</div>',
      responseBody: '{"secret":1}',
      headers: {
        'content-type': 'application/json',
        cookie: 'sid=123',
        authorization: 'Bearer abc',
        'set-cookie': 'a=b',
      },
    },
  });

  await sleep(20);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.subId, sub1.subscriptionId);
  assert.deepEqual(delivered[0]?.event.payload, {
    url: 'https://api.example.test/login',
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const clean = sanitizeEvent({
    type: 'nav.committed',
    environmentId: 'env-1',
    at: 't4',
    payload: { url: 'https://x.test', apiKey: 'k', innerHTML: '<b>x</b>', secret: 's' },
  });
  assert.deepEqual(clean.payload, { url: 'https://x.test' });

  bus.unsubscribe('p1', sub1.subscriptionId);
  assert.equal(bus.subscriptionCount('p1'), 0);
});

test('PluginEventBus：单插件 256 条背压上限（丢最老保最新，绝不阻塞同步分发）', async () => {
  const received: number[] = [];
  const bus = new PluginEventBus((_pluginId, _subId, event) => {
    received.push(Number(event.payload.seq));
  });

  bus.subscribe('p-burst', { types: ['net.hit'] });
  assert.equal(EVENT_BUS_MAX_QUEUE_PER_PLUGIN, 256);

  for (let i = 0; i < 300; i += 1) {
    bus.dispatchEvent({
      type: 'net.hit',
      environmentId: 'env-1',
      at: '2026-11-26T00:00:00.000Z',
      payload: { seq: i },
    });
  }

  // 同步分发阶段只进背压队列，最大积压 256 条
  assert.equal(bus.queuedCount('p-burst'), 256);

  await sleep(40);
  assert.equal(received.length, 256);
  assert.equal(received[0], 44);
  assert.equal(received.at(-1), 299);
  assert.equal(bus.queuedCount('p-burst'), 0);
});

test('Host API events.subscribe / events.unsubscribe 强制校验 events.subscribe 权限', async () => {
  const granted = new Set<string>();
  const bus = new PluginEventBus(() => undefined);
  const handlers = createHandlers({
    pluginId: 'com.example.events',
    currentEnvironmentId: () => undefined,
    require: (permission) => {
      if (!granted.has(permission)) {
        throw Object.assign(new Error(`没有 ${permission}`), { code: 'PLUGIN_PERMISSION_DENIED' });
      }
    },
    manager: {} as never,
    vault: { available: false, list: () => [], reveal: () => ({}) },
    storage: {} as never,
    settings: { get: () => ({}) } as never,
    descriptors: [],
    record: () => undefined,
    log: () => undefined,
    signal: () => undefined,
    withLease: async (_env, fn) => fn('lease'),
    subscribeEvents: (filter) => bus.subscribe('com.example.events', filter),
    unsubscribeEvents: (subId) => {
      bus.unsubscribe('com.example.events', subId);
    },
  });

  await assert.rejects(
    () => dispatchHostCall(handlers, 'events.subscribe', [{ types: ['nav.committed'] }]),
    (error: Error & { code?: string }) => error.code === 'PLUGIN_PERMISSION_DENIED',
  );
  await assert.rejects(
    () => dispatchHostCall(handlers, 'events.unsubscribe', ['sub-1']),
    (error: Error & { code?: string }) => error.code === 'PLUGIN_PERMISSION_DENIED',
  );

  granted.add('events.subscribe');
  const sub = (await dispatchHostCall(handlers, 'events.subscribe', [{ types: ['nav.committed'] }])) as {
    subscriptionId: string;
  };
  assert.equal(bus.subscriptionCount('com.example.events'), 1);
  await dispatchHostCall(handlers, 'events.unsubscribe', [sub.subscriptionId]);
  assert.equal(bus.subscriptionCount('com.example.events'), 0);
});

async function createHostFixture(root: string): Promise<PluginHost> {
  const db = openDatabase(path.join(root, 'warren.db'));
  return new PluginHost({
    root: path.join(root, 'plugins'),
    manager: {} as never,
    vault: {
      available: false,
      list: () => [],
      add: () => ({ ref: '' }),
      remove: () => true,
      reveal: () => ({}),
    } as never,
    store: {
      record: () => undefined,
      appSettings: () => ({ controlPolicy: 'ask', pluginPolicy: 'ask' }),
    } as never,
    db,
    saveVault: async () => undefined,
    appVersion: '0.1.0',
    reconnectBaseMs: 0,
  });
}

test('PluginHost 集成：权限门控、过滤分发、disable / reload / 子进程超时强杀后 subscriptionCount 归零', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'warren-event-bus-'));
  const srcSandbox = path.join(root, 'src-sandbox');
  const srcHost = path.join(root, 'src-host');
  const host = await createHostFixture(root);

  try {
    await mkdir(srcSandbox, { recursive: true });
    await writeFile(
      path.join(srcSandbox, 'package.json'),
      JSON.stringify({
        name: 'warren-plugin-event-sandbox',
        version: '0.1.0',
        files: ['server.js'],
        warren: {
          id: 'com.test.events.sandbox',
          name: 'Event Sandbox',
          apiVersion: '4',
          runtime: 'sandbox',
          server: 'server.js',
          permissions: ['events.subscribe', 'rpc.serve'],
          contributes: {
            commands: [
              { name: 'subscribeNow', summary: '手动订阅' },
              { name: 'unsubscribeNow', summary: '取消订阅' },
              { name: 'received', summary: '查看收到的事件' },
              { name: 'hang', summary: '挂起' },
            ],
            rpc: ['subscribeNow', 'unsubscribeNow', 'received', 'hang'],
          },
        },
      }),
    );
    await writeFile(
      path.join(srcSandbox, 'server.js'),
      `
      const events = [];
      let unsub = null;
      module.exports = {
        async subscribeNow(ctx) {
          unsub = await ctx.host.events.subscribe(
            { environmentId: (ctx.input && ctx.input.environmentId) || undefined, types: (ctx.input && ctx.input.types) || undefined },
            (event) => { events.push(event); },
          );
          return { subscribed: true };
        },
        async unsubscribeNow() {
          if (unsub) {
            await unsub();
            unsub = null;
          }
          return { unsubscribed: true };
        },
        async received() {
          return { events };
        },
        async hang() {
          await new Promise(() => {});
        },
      };
      `,
    );

    await mkdir(srcHost, { recursive: true });
    await writeFile(
      path.join(srcHost, 'package.json'),
      JSON.stringify({
        name: 'warren-plugin-event-host',
        version: '0.1.0',
        type: 'module',
        files: ['host.mjs'],
        warren: {
          id: 'com.test.events.host',
          name: 'Event Host',
          apiVersion: '4',
          runtime: 'host',
          host: 'host.mjs',
          permissions: ['events.subscribe'],
          contributes: {
            commands: [{ name: 'crash', summary: '异常退出' }],
          },
        },
      }),
    );
    await writeFile(
      path.join(srcHost, 'host.mjs'),
      `
      export default {
        async activate(ctx) {
          await ctx.host.events.subscribe({ types: ['env.status'] }, () => {});
        },
        async crash() {
          process.exit(9);
        },
      };
      `,
    );

    await host.load();
    const sandboxPkg = await host.install(`path:${srcSandbox}`);
    await host.enable(sandboxPkg.id);

    // 1. 权限门控：未 grant events.subscribe 时订阅必须被拒
    await assert.rejects(
      () => host.run(sandboxPkg.id, 'subscribeNow', { environmentId: '', input: {} }),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_PERMISSION_DENIED',
    );
    assert.equal(host.subscriptionCount(sandboxPkg.id), 0);

    // 2. grant 后订阅并接收脱敏过滤事件
    await host.grant(sandboxPkg.id, ['events.subscribe']);
    await host.run(sandboxPkg.id, 'subscribeNow', {
      environmentId: '',
      input: { environmentId: 'env-1', types: ['nav.committed', 'net.hit'] },
    });
    assert.equal(host.subscriptionCount(sandboxPkg.id), 1);

    host.dispatchEvent({
      type: 'nav.committed',
      environmentId: 'env-2',
      at: '2026-11-26T00:00:01.000Z',
      payload: { url: 'https://other.test' },
    });
    host.dispatchEvent({
      type: 'tab.created',
      environmentId: 'env-1',
      at: '2026-11-26T00:00:02.000Z',
      payload: { tabId: 't1' },
    });
    host.dispatchEvent({
      type: 'net.hit',
      environmentId: 'env-1',
      at: '2026-11-26T00:00:03.000Z',
      payload: { url: 'https://ok.test', cookie: 'secret-cookie', password: '[REDACTED]', body: 'html-body' },
    });

    await sleep(30);
    const received = (await host.run(sandboxPkg.id, 'received', { environmentId: '' })).result as {
      events: PluginBusEvent[];
    };
    assert.equal(received.events.length, 1);
    assert.equal(received.events[0]?.type, 'net.hit');
    assert.deepEqual(received.events[0]?.payload, { url: 'https://ok.test' });

    // 3. reload 后旧动态订阅被一次性清除
    await host.reload(sandboxPkg.id);
    assert.equal(host.subscriptionCount(sandboxPkg.id), 0);

    // 4. disable 后 subscriptionCount 归零
    await host.run(sandboxPkg.id, 'subscribeNow', { environmentId: '', input: {} });
    assert.equal(host.subscriptionCount(sandboxPkg.id), 1);
    await host.disable(sandboxPkg.id);
    assert.equal(host.subscriptionCount(sandboxPkg.id), 0);

    // 5. 超时强杀后 subscriptionCount 归零且标记 crashed
    await host.enable(sandboxPkg.id);
    await host.run(sandboxPkg.id, 'subscribeNow', { environmentId: '', input: {} });
    assert.equal(host.subscriptionCount(sandboxPkg.id), 1);
    const prevTimeout = process.env.WARREN_PLUGIN_TIMEOUT_MS;
    process.env.WARREN_PLUGIN_TIMEOUT_MS = '200';
    try {
      await assert.rejects(
        () => host.run(sandboxPkg.id, 'hang', { environmentId: '' }),
        (error: Error & { code?: string }) => error.code === 'PLUGIN_TIMEOUT',
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.WARREN_PLUGIN_TIMEOUT_MS;
      else process.env.WARREN_PLUGIN_TIMEOUT_MS = prevTimeout;
    }
    assert.equal(host.subscriptionCount(sandboxPkg.id), 0);
    assert.equal(host.statusOf(sandboxPkg.id).status, 'error');
    assert.equal(host.isCrashed(sandboxPkg.id), true);

    // 6. host 运行时子进程异常 exit 后 subscriptionCount 归零，且可手动 reconnect 恢复
    const hostPkg = await host.install(`path:${srcHost}`);
    await host.grant(hostPkg.id, ['events.subscribe']);
    await host.enable(hostPkg.id);
    assert.equal(host.subscriptionCount(hostPkg.id), 1);

    await assert.rejects(
      () => host.run(hostPkg.id, 'crash', { environmentId: '' }),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_CRASHED',
    );
    assert.equal(host.subscriptionCount(hostPkg.id), 0);
    assert.equal(host.statusOf(hostPkg.id).status, 'error');
    assert.equal(host.isCrashed(hostPkg.id), true);

    const reconnected = await host.reconnect(hostPkg.id);
    assert.equal(reconnected.status, 'running');
    assert.equal(host.isCrashed(hostPkg.id), false);
    assert.equal(host.subscriptionCount(hostPkg.id), 1);
  } finally {
    await host.dispose();
    closeDatabases();
    await rm(root, { recursive: true, force: true });
  }
});

test('PluginHost 崩溃后支持指数退避自动重连并受最大重试次数上限约束', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'warren-plugin-backoff-'));
  const srcHost = path.join(root, 'src-host');
  const db = openDatabase(path.join(root, 'warren.db'));
  const host = new PluginHost({
    root: path.join(root, 'plugins'),
    manager: {} as never,
    vault: {
      available: false,
      list: () => [],
      add: () => ({ ref: '' }),
      remove: () => true,
      reveal: () => ({}),
    } as never,
    store: {
      record: () => undefined,
      appSettings: () => ({ controlPolicy: 'ask', pluginPolicy: 'ask' }),
    } as never,
    db,
    saveVault: async () => undefined,
    appVersion: '0.1.0',
    reconnectBaseMs: 40,
    maxReconnectAttempts: 2,
  });

  try {
    await mkdir(srcHost, { recursive: true });
    await writeFile(
      path.join(srcHost, 'package.json'),
      JSON.stringify({
        name: 'warren-plugin-backoff-host',
        version: '0.1.0',
        type: 'module',
        files: ['host.mjs'],
        warren: {
          id: 'com.test.backoff.host',
          name: 'Backoff Host',
          apiVersion: '4',
          runtime: 'host',
          host: 'host.mjs',
          permissions: [],
          contributes: {
            commands: [{ name: 'crash', summary: '退出' }],
          },
        },
      }),
    );
    await writeFile(path.join(srcHost, 'host.mjs'), `export default { async crash() { process.exit(7); } };`);

    await host.load();
    const pkg = await host.install(`path:${srcHost}`);
    await host.enable(pkg.id);

    // 第 1 次崩溃：触发 40ms 后自动重连
    await assert.rejects(
      () => host.run(pkg.id, 'crash', { environmentId: '' }),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_CRASHED',
    );
    assert.equal(host.isCrashed(pkg.id), true);

    await sleep(140);
    assert.equal(host.statusOf(pkg.id).status, 'running');
    assert.equal(host.isCrashed(pkg.id), false);

    // 第 2 次崩溃：触发 80ms 后自动重连
    await assert.rejects(
      () => host.run(pkg.id, 'crash', { environmentId: '' }),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_CRASHED',
    );
    await sleep(180);
    assert.equal(host.statusOf(pkg.id).status, 'running');

    // 第 3 次崩溃：超过 maxReconnectAttempts=2，不再自动拉起
    await assert.rejects(
      () => host.run(pkg.id, 'crash', { environmentId: '' }),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_CRASHED',
    );
    await sleep(160);
    assert.equal(host.statusOf(pkg.id).status, 'error');
    assert.equal(host.isCrashed(pkg.id), true);
  } finally {
    await host.dispose();
    closeDatabases();
    await rm(root, { recursive: true, force: true });
  }
});
