import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { satisfiesEngines, validatePluginPackage } from '../src/main/plugins/package.ts';
import { PluginStorage, KV_MAX_VALUE_BYTES } from '../src/main/plugins/storage.ts';
import { openDatabase } from '../src/main/db.ts';
import { PluginSettings } from '../src/main/plugins/settings.ts';
import { HostRuntime, SandboxRuntime } from '../src/main/plugins/runtime.ts';
import { buildHostApi, createHandlers, dispatchHostCall } from '../src/main/plugins/api.ts';

const pluginPackage = {
  name: 'warren-plugin-notes',
  version: '0.4.0',
  description: 'Notes',
  warren: {
    id: 'com.example.notes',
    name: 'Notes',
    apiVersion: '4',
    runtime: 'sandbox',
    server: 'server.js',
    app: 'app.js',
    permissions: ['environment.read', 'storage.write', 'rpc.serve', 'ui.mount'],
    contributes: {
      commands: [{ name: 'addNote', summary: '存一条笔记' }],
      settings: [{ key: 'title', type: 'string', label: '标题', default: '笔记' }],
      surfaces: [{ kind: 'railPage', id: 'notes', title: '笔记', path: 'notes' }],
      rpc: ['list', 'add'],
    },
  },
};

test('v4 package 通过校验，contributes 被规范化', () => {
  const result = validatePluginPackage(pluginPackage);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.package?.runtime, 'sandbox');
  assert.equal(result.package?.server, 'server.js');
  assert.deepEqual(result.package?.contributes.commands, [{ name: 'addNote', summary: '存一条笔记' }]);
  assert.deepEqual(result.package?.contributes.rpc, ['list', 'add']);
});

test('旧清单和裸字符串命令都不再兼容', () => {
  const result = validatePluginPackage({
    name: 'warren-plugin-login',
    version: '0.1.0',
    warren: {
      id: 'com.example.login',
      name: 'Login',
      apiVersion: '3',
      runtime: 'sandbox',
      server: 'index.js',
      permissions: ['browser.dom.read'],
      contributes: { commands: ['login', 'status'] },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /apiVersion/);
  assert.match(result.errors.join(' '), /命令声明必须是/);
});

test('package 的硬约束：runtime / 挂面 / rpc / 设置都要有对应权限', () => {
  const noRuntime = validatePluginPackage({ ...pluginPackage, warren: { ...pluginPackage.warren, runtime: 'shell' } });
  assert.equal(noRuntime.ok, false);
  assert.match(noRuntime.errors.join(' '), /runtime/);

  const hostWithoutEntry = validatePluginPackage({
    ...pluginPackage,
    warren: { ...pluginPackage.warren, runtime: 'host' },
  });
  assert.equal(hostWithoutEntry.ok, false);
  assert.match(hostWithoutEntry.errors.join(' '), /warren\.host/);

  const noMount = validatePluginPackage({
    ...pluginPackage,
    warren: {
      ...pluginPackage.warren,
      permissions: ['environment.read', 'storage.write', 'rpc.serve'],
    },
  });
  assert.equal(noMount.ok, false);
  assert.match(noMount.errors.join(' '), /ui\.mount/);

  const noServe = validatePluginPackage({
    ...pluginPackage,
    warren: {
      ...pluginPackage.warren,
      permissions: ['environment.read', 'storage.write', 'ui.mount'],
    },
  });
  assert.equal(noServe.ok, false);
  assert.match(noServe.errors.join(' '), /rpc\.serve/);

  const noStorage = validatePluginPackage({
    ...pluginPackage,
    warren: {
      ...pluginPackage.warren,
      permissions: ['environment.read', 'rpc.serve', 'ui.mount'],
    },
  });
  assert.equal(noStorage.ok, false);
  assert.match(noStorage.errors.join(' '), /storage\.write/);
});

test('面 / rpc / 设置的声明本身要被校验', () => {
  const bad = validatePluginPackage({
    ...pluginPackage,
    warren: {
      ...pluginPackage.warren,
      contributes: {
        ...pluginPackage.warren.contributes,
        surfaces: [{ kind: 'everywhere', id: 'x', title: 'X' }],
        rpc: ['bad method!'],
      },
    },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /未知的挂载类型/);
  assert.match(bad.errors.join(' '), /rpc 方法名非法/);

  const envActionWithoutCommand = validatePluginPackage({
    ...pluginPackage,
    warren: {
      ...pluginPackage.warren,
      contributes: { ...pluginPackage.warren.contributes, surfaces: [{ kind: 'envAction', id: 'x', title: 'X' }] },
    },
  });
  assert.equal(envActionWithoutCommand.ok, false);
  assert.match(envActionWithoutCommand.errors.join(' '), /必须声明 command/);
});

test('engines.warren 只认 >=x.y.z 与 *', () => {
  assert.equal(satisfiesEngines(undefined, '0.1.0'), true);
  assert.equal(satisfiesEngines('*', '0.1.0'), true);
  assert.equal(satisfiesEngines('>=0.1.0', '0.1.0'), true);
  assert.equal(satisfiesEngines('>=0.2.0', '0.1.0'), false);
  assert.equal(satisfiesEngines('^1.0.0', '2.0.0'), false);
});

test('storage.kv：读写删列 + 单键上限', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-plugin-'));
  try {
    const storage = new PluginStorage({
      dir,
      pluginId: 'com.example.notes',
      db: openDatabase(':memory:'),
    });
    await storage.load();
    await storage.set('cursor', { page: 3 });
    assert.deepEqual(storage.get('cursor'), { page: 3 });
    assert.deepEqual(storage.list('cur'), [{ key: 'cursor', value: { page: 3 } }]);

    await assert.rejects(
      () => storage.set('huge', 'x'.repeat(KV_MAX_VALUE_BYTES + 10)),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_STORAGE_TOO_LARGE',
    );

    assert.equal(await storage.delete('cursor'), true);
    assert.equal(storage.get('cursor'), null);
    storage.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('storage.sql：migrate 只跑没跑过的，重复调用不会重放', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-plugin-'));
  try {
    const storage = new PluginStorage({
      dir,
      pluginId: 'com.example.notes',
      db: openDatabase(':memory:'),
    });
    await storage.load();
    const statements = ['CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)'];
    assert.equal(storage.migrate(statements), 1);
    assert.equal(storage.migrate(statements), 0);
    assert.equal(storage.migrate([...statements, 'ALTER TABLE notes ADD COLUMN created_at TEXT']), 1);

    const db = storage.db();
    db.prepare('INSERT INTO notes (text, created_at) VALUES (?, ?)').run('hello', 'now');
    const rows = db.prepare('SELECT id, text, created_at FROM notes').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, 'hello');
    storage.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('settings：secret 存进 Vault，插件前端只看到「已配置」', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-plugin-'));
  const records = new Map<string, string>();
  const vault = {
    available: true,
    list: () =>
      [...records.entries()].map(([ref]) => ({
        ref,
        provider: 'plugin:com.example.notes',
        label: ref,
      })),
    add: ({ label, secret }: { label: string; secret: { password: string } }) => {
      records.set(label, secret.password);
      return { ref: label };
    },
    reveal: (ref: string) => ({ password: records.get(ref) }),
    remove: (ref: string) => records.delete(ref),
  };
  try {
    const descriptors = [
      { key: 'title', type: 'string' as const, label: '标题', default: '笔记' },
      { key: 'apiKey', type: 'secret' as const, label: 'API Key' },
    ];
    const settings = new PluginSettings({
      dir,
      pluginId: 'com.example.notes',
      vault,
      saveVault: async () => undefined,
      db: openDatabase(':memory:'),
    });
    await settings.load();
    await settings.seedDefaults(descriptors);

    await settings.set(descriptors, 'apiKey', 'super-secret');
    assert.equal(settings.get(descriptors).apiKey, 'super-secret');

    const listed = settings.list(descriptors);
    const secret = listed.find((item) => item.key === 'apiKey')!;
    assert.equal(secret.value, undefined, 'secret 的值不能出现在前端视图里');
    assert.equal(secret.configured, true);
    assert.equal(listed.find((item) => item.key === 'title')!.value, '笔记');

    await settings.purge(descriptors);
    assert.equal(settings.get(descriptors).apiKey, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host API：权限门控 + 路径分发（两种运行时共用同一张表）', async () => {
  const calls: string[] = [];
  const granted = new Set(['environment.read']);
  const handlers = createHandlers({
    pluginId: 'com.example.notes',
    currentEnvironmentId: () => 't1',
    require: (permission) => {
      if (!granted.has(permission)) {
        throw Object.assign(new Error(`没有 ${permission}`), { code: 'PLUGIN_PERMISSION_DENIED' });
      }
    },
    manager: {
      list: () => [{ id: 't1', storagePath: '/tmp/t1', leaseId: 'lease-1', leaseExpiresAt: 123 }],
      get: () => ({ id: 't1', storagePath: '/tmp/t1', leaseId: 'lease-1', leaseExpiresAt: 123 }),
    } as never,
    vault: { available: true, list: () => [], reveal: () => ({}) },
    storage: {
      get: () => null,
      set: async () => undefined,
      delete: async () => true,
      list: () => [],
      db: () => ({}),
    } as never,
    settings: { get: () => ({ title: '笔记' }) } as never,
    descriptors: [],
    record: (type) => calls.push(type),
    log: (level, message) => calls.push(`${level}:${message}`),
    signal: (channel) => calls.push(`signal:${channel}`),
    withLease: async (_env, fn) => fn('lease'),
  });

  assert.deepEqual(await dispatchHostCall(handlers, 'environment.list', []), [{ id: 't1', storagePath: '/tmp/t1' }]);
  assert.deepEqual(await dispatchHostCall(handlers, 'environment.get', ['t1']), {
    id: 't1',
    storagePath: '/tmp/t1',
  });
  assert.deepEqual(await dispatchHostCall(handlers, 'settings.get', []), { title: '笔记' });
  await assert.rejects(
    () => dispatchHostCall(handlers, 'storage.kv.set', ['a', 1]),
    (error: Error & { code?: string }) => error.code === 'PLUGIN_PERMISSION_DENIED',
  );
  await assert.rejects(
    () => dispatchHostCall(handlers, 'browser.url', []),
    (error: Error & { code?: string }) => error.code === 'PLUGIN_PERMISSION_DENIED',
  );
  await assert.rejects(
    () => dispatchHostCall(handlers, 'nope.nope', []),
    (error: Error & { code?: string }) => error.code === 'PLUGIN_HOST_API_UNKNOWN',
  );

  const api = buildHostApi(handlers) as { environment: { list: () => Promise<unknown> } };
  assert.deepEqual(await api.environment.list(), [{ id: 't1', storagePath: '/tmp/t1' }]);
});

test('plugin browser.waitForTimeout rejects missing / non-finite / negative milliseconds', async () => {
  const calls: number[] = [];
  const granted = new Set(['browser.dom.read']);
  const handlers = createHandlers({
    pluginId: 'com.example.timeout',
    currentEnvironmentId: () => 't1',
    require: (permission) => {
      if (!granted.has(permission)) {
        throw Object.assign(new Error(`没有 ${permission}`), { code: 'PLUGIN_PERMISSION_DENIED' });
      }
    },
    manager: {
      controllerFor: () => ({
        waitForTimeout: (ms: number) => {
          calls.push(ms);
          return { ok: true };
        },
      }),
    } as never,
    vault: { available: true, list: () => [], reveal: () => ({}) },
    storage: {} as never,
    settings: { get: () => ({}) } as never,
    descriptors: [],
    record: () => undefined,
    log: () => undefined,
    signal: () => undefined,
    withLease: async (_env, fn) => fn('lease'),
  });

  assert.deepEqual(await dispatchHostCall(handlers, 'browser.waitForTimeout', [25]), { ok: true });
  assert.deepEqual(calls, [25]);
  for (const bad of [undefined, Number.NaN, -1]) {
    await assert.rejects(
      () => dispatchHostCall(handlers, 'browser.waitForTimeout', [bad]),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_BAD_REQUEST',
    );
  }
});

test('environment.write：换代理 / 信一张 CA / 启停，都要显式授权，且 null 表示清掉', async () => {
  const patches: unknown[] = [];
  const started: string[] = [];
  const granted = new Set(['environment.read']);
  const manager = {
    update: (id: string, patch: unknown) => {
      patches.push({ id, patch });
      return { id };
    },
    start: async (id: string) => {
      started.push(id);
      return { id };
    },
    stop: (id: string) => started.push(`stop:${id}`),
  };
  const handlers = createHandlers({
    pluginId: 'com.warren.whistle',
    currentEnvironmentId: () => undefined,
    require: (permission) => {
      if (!granted.has(permission)) {
        throw Object.assign(new Error(`没有 ${permission}`), { code: 'PLUGIN_PERMISSION_DENIED' });
      }
    },
    manager: manager as never,
    vault: { available: true, list: () => [], reveal: () => ({}) },
    storage: {} as never,
    settings: { get: () => ({}) } as never,
    descriptors: [],
    record: () => undefined,
    log: () => undefined,
    signal: () => undefined,
    withLease: async (_env, fn) => fn('lease'),
  });

  // 只读权限：三条写通道全部拒绝
  for (const path of ['environment.update', 'environment.start', 'environment.stop']) {
    await assert.rejects(
      () => dispatchHostCall(handlers, path, [{ id: 't1' }]),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_PERMISSION_DENIED',
      path,
    );
  }

  granted.add('environment.write');
  await dispatchHostCall(handlers, 'environment.update', [
    { id: 't1', proxy: 'http://127.0.0.1:8901', trustedCa: '/tmp/ca.pem' },
  ]);
  assert.deepEqual(patches[0], {
    id: 't1',
    patch: { proxy: 'http://127.0.0.1:8901', trustedCa: '/tmp/ca.pem' },
  });
  // 解绑：null / '' 都要变成「清掉」，不能悄悄当成「不改」
  await dispatchHostCall(handlers, 'environment.update', [{ id: 't1', proxy: null, trustedCa: '' }]);
  assert.deepEqual(patches[1], { id: 't1', patch: { proxy: null, trustedCa: null } });

  await dispatchHostCall(handlers, 'environment.start', ['t1']);
  await dispatchHostCall(handlers, 'environment.stop', ['t1']);
  assert.deepEqual(started, ['t1', 'stop:t1']);
});

test('sandbox 运行时：命令 / rpc / activate / dispose，且拿不到 require / process / fs / fetch / setImmediate', async () => {
  const logs: string[] = [];
  const code = `
    const escaped = {
      require: typeof require,
      process: typeof process,
      fs: typeof fs,
      child_process: typeof child_process,
      fetch: typeof fetch,
      Buffer: typeof Buffer,
      setImmediate: typeof setImmediate,
    };
    module.exports = {
      async activate(ctx) { await ctx.host.log.info('activated'); },
      async dispose() { await host.log.info('disposed'); },
      async hello(ctx) {
        const u = new URL('https://example.test/path?q=1');
        const encoded = new TextEncoder().encode('ok');
        const decoded = new TextDecoder().decode(encoded);
        const uuid = crypto.randomUUID();
        return { command: ctx.command, env: ctx.environmentId, url: u.pathname, decoded, hasUuid: uuid.length > 10 };
      },
      rpc: {
        async sum(input) { return { total: input.a + input.b, escaped }; },
        async boom() { throw Object.assign(new Error('炸了'), { code: 'BOOM' }); },
      },
    };
  `;
  const runtime = new SandboxRuntime({
    pluginId: 'com.example.test',
    entryPath: '/tmp/fake/index.js',
    code,
    log: (level, message) => logs.push(`${level}:${message}`),
    host: { log: { info: async (message: string) => logs.push(`info:${message}`) } },
  });

  try {
    await runtime.start();
    const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const hello = plain(await runtime.command('hello', { command: 'hello', environmentId: 't1' })) as {
      command: string;
      env: string;
      url: string;
      decoded: string;
      hasUuid: boolean;
    };
    assert.deepEqual(hello, {
      command: 'hello',
      env: 't1',
      url: '/path',
      decoded: 'ok',
      hasUuid: true,
    });
    assert.deepEqual(plain(await runtime.rpc('sum', { a: 1, b: 2 }, {})), {
      total: 3,
      escaped: {
        require: 'undefined',
        process: 'undefined',
        fs: 'undefined',
        child_process: 'undefined',
        fetch: 'undefined',
        Buffer: 'undefined',
        setImmediate: 'undefined',
      },
    });
    await assert.rejects(
      () => runtime.rpc('boom', null, {}),
      (error: Error & { code?: string }) => error.message === '炸了' && error.code === 'BOOM',
    );
    await assert.rejects(() => runtime.rpc('nope', null, {}), /没有导出 rpc 方法/);
    await runtime.dispose();
    assert.deepEqual(logs, ['info:activated', 'info:disposed']);
  } finally {
    await runtime.dispose();
  }
});

test('sandbox 插件的异步执行有时限：永不返回的命令报 PLUGIN_TIMEOUT 并真实杀掉底层子进程', async () => {
  const previous = process.env.WARREN_PLUGIN_TIMEOUT_MS;
  process.env.WARREN_PLUGIN_TIMEOUT_MS = '200';
  const logs: string[] = [];
  const crashes: Array<{ reason: string }> = [];
  const entryPath = new URL('../fixtures/plugins/hangs/server.js', import.meta.url).pathname;
  const runtime = new SandboxRuntime({
    entryPath,
    pluginId: 'com.example.hangs',
    code: await readFile(entryPath, 'utf8'),
    log: (level, message) => logs.push(`${level}:${message}`),
    host: {},
    onCrash: (info) => crashes.push({ reason: info.reason }),
  });
  try {
    await runtime.start();
    const pid = runtime.pid;
    assert.ok(typeof pid === 'number' && pid > 0, 'sandbox 必须运行在独立子进程中');
    // 正常命令在未超时前可执行
    assert.deepEqual(JSON.parse(JSON.stringify(await runtime.command('quick', {}))), { ok: true });

    const started = Date.now();
    await assert.rejects(
      () => runtime.command('forever', {}),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_TIMEOUT',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 180 && elapsed < 2000, `应该在 200ms 左右超时，实际 ${elapsed}ms`);
    assert.ok(
      logs.some((line) => line.startsWith('error:') && line.includes('PLUGIN_TIMEOUT')),
      '超时要在插件日志里留一条 error',
    );
    assert.equal(runtime.crashed, true);
    assert.equal(crashes.length, 1);
    assert.equal(crashes[0]?.reason, 'timeout');
    // 底层子进程必须已被真实 kill 退出
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    // 崩溃后未重启前调用 fail-fast 报错
    await assert.rejects(
      () => runtime.command('quick', {}),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_CRASHED',
    );
  } finally {
    await runtime.dispose();
    if (previous === undefined) delete process.env.WARREN_PLUGIN_TIMEOUT_MS;
    else process.env.WARREN_PLUGIN_TIMEOUT_MS = previous;
  }
});

test('sandbox 同步死循环可被 PLUGIN_TIMEOUT 强杀且 dispose 超时也强杀子进程', async () => {
  const previous = process.env.WARREN_PLUGIN_TIMEOUT_MS;
  process.env.WARREN_PLUGIN_TIMEOUT_MS = '200';
  const runtime = new SandboxRuntime({
    pluginId: 'com.example.spin',
    entryPath: '/tmp/fake/spin.js',
    code: `module.exports = { spin() { while (true) {} } };`,
    log: () => undefined,
    host: {},
  });
  try {
    await runtime.start();
    const pid = runtime.pid!;
    await assert.rejects(
      () => runtime.command('spin', {}),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_TIMEOUT',
    );
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await runtime.dispose();
  }

  const hangingDispose = new SandboxRuntime({
    pluginId: 'com.example.hangdispose',
    entryPath: '/tmp/fake/hangdispose.js',
    code: `module.exports = { async dispose() { await new Promise(() => {}); } };`,
    log: () => undefined,
    host: {},
  });
  try {
    await hangingDispose.start();
    const pid = hangingDispose.pid!;
    await hangingDispose.dispose();
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    if (previous === undefined) delete process.env.WARREN_PLUGIN_TIMEOUT_MS;
    else process.env.WARREN_PLUGIN_TIMEOUT_MS = previous;
  }
});

test('sandbox 与 host 运行时：子进程异常退出对在途调用 fail-fast 并触发 onCrash', async () => {
  const crashes: string[] = [];
  const sandbox = new SandboxRuntime({
    pluginId: 'com.example.crash-sandbox',
    entryPath: '/tmp/fake/crash.js',
    code: `module.exports = { async wait() { await new Promise(() => {}); } };`,
    log: () => undefined,
    host: {},
    onCrash: (info) => crashes.push(info.reason),
  });
  try {
    await sandbox.start();
    const pid = sandbox.pid!;
    const pending = sandbox.command('wait', {});
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已退出
      }
    }, 30);
    await assert.rejects(
      () => pending,
      (error: Error & { code?: string }) => error.code === 'PLUGIN_CRASHED',
    );
    assert.equal(sandbox.crashed, true);
    assert.deepEqual(crashes, ['exit']);
  } finally {
    await sandbox.dispose();
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'warren-host-rt-'));
  const hostEntry = path.join(dir, 'host.mjs');
  await writeFile(
    hostEntry,
    `export default {
      async activate(ctx) { await ctx.host.log.info('host-ready'); },
      async ping(ctx) { return { pid: process.pid, input: ctx.input }; },
      async crashNow() { process.exit(42); },
    };`,
  );
  const hostLogs: string[] = [];
  const hostCrashes: Array<{ code: number | null }> = [];
  const hostRt = new HostRuntime({
    pluginId: 'com.example.host-rt',
    entryPath: hostEntry,
    log: (level, message) => hostLogs.push(`${level}:${message}`),
    onHostCall: async (callPath, args) => {
      if (callPath === 'log.info') hostLogs.push(`host:${String(args[0])}`);
      return null;
    },
    onCrash: (info) => hostCrashes.push({ code: info.code }),
  });
  try {
    await hostRt.start();
    const res = (await hostRt.command('ping', { input: { ok: 1 } })) as { pid: number; input: { ok: number } };
    assert.notEqual(res.pid, process.pid);
    assert.deepEqual(res.input, { ok: 1 });
    assert.ok(hostLogs.includes('host:host-ready'));

    await assert.rejects(
      () => hostRt.command('crashNow', {}),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_CRASHED',
    );
    assert.equal(hostRt.crashed, true);
    assert.equal(hostCrashes.length, 1);
    assert.equal(hostCrashes[0]?.code, 42);
  } finally {
    await hostRt.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
