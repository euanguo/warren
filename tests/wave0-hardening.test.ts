/**
 * Wave 0 安全加固、CDP 批量化、RPC 客户端与遥测批量落盘回归测试。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { createRpcClient } from '../bin/rpc-client.mjs';
import { cdp } from '../src/main/browser/escape.ts';
import { resolveLocatorTarget } from '../src/main/browser/locator.ts';
import { readTargetProperty } from '../src/main/browser/ops/inspector.ts';
import { checkCdpAllowed, guardSavePath } from '../src/main/browser/policy.ts';
import { openDatabase } from '../src/main/db.ts';
import { isBlockedPluginAssetPath } from '../src/main/plugin-protocol.ts';
import { createHandlers, dispatchHostCall } from '../src/main/plugins/api/index.ts';
import { assertSafePluginSql, PluginStorage } from '../src/main/plugins/storage.ts';
import { Telemetry } from '../src/main/telemetry.ts';
import { createFakePageContext } from './helpers/fake-cdp.ts';

const require = createRequire(import.meta.url);

test('forge.config.cjs：FusesPlugin 顶层配置正确生效且启用全部 7 项安全 Fuse', () => {
  const forgeConfig = require('../forge.config.cjs') as {
    plugins: Array<{ name?: string; fusesConfig?: Record<string | number, unknown> }>;
  };
  const fusesPlugin = forgeConfig.plugins.find((p) => p?.name === 'fuses');
  assert.ok(fusesPlugin, 'plugins 必须包含 FusesPlugin 实例');
  const cfg = fusesPlugin.fusesConfig;
  assert.ok(cfg, 'FusesPlugin 必须暴露扁平 fusesConfig');
  assert.equal(cfg.version, FuseVersion.V1);
  assert.equal(cfg[FuseV1Options.RunAsNode], false);
  assert.equal(cfg[FuseV1Options.EnableCookieEncryption], true);
  assert.equal(cfg[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(cfg[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(cfg[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(cfg[FuseV1Options.OnlyLoadAppFromAsar], true);
  assert.equal(cfg[FuseV1Options.GrantFileProtocolExtraPrivileges], false);
});

test('plugin-protocol：拒绝 data.db、HTML、package.json、后端源码与越界路径，仅放行前端资产', () => {
  const plugin = { server: 'server.js', host: 'host.mjs' };
  for (const blocked of [
    'data.db',
    'data.db-wal',
    'data.db-shm',
    'sub/secret.sqlite',
    'package.json',
    'server.js',
    'host.mjs',
    'index.html',
    'node_modules/pkg/index.js',
    '.env',
    '../other/app.js',
  ]) {
    assert.equal(isBlockedPluginAssetPath(blocked, plugin), true, `应拦截 ${blocked}`);
  }
  for (const allowed of ['app.js', 'ui/accounts-page.js', 'ui/styles.css', 'assets/icon.svg']) {
    assert.equal(isBlockedPluginAssetPath(allowed, plugin), false, `应放行 ${allowed}`);
  }
});

test('PluginStorage SQL 边界与独立 dataDir 迁移：禁止 ATTACH / VACUUM INTO / 写查询', async () => {
  for (const bad of [
    "ATTACH DATABASE '/tmp/other.db' AS x",
    'DETACH DATABASE x',
    "VACUUM INTO '/tmp/dump.db'",
    "SELECT load_extension('/tmp/a.so')",
    'PRAGMA writable_schema = ON',
    'PRAGMA database_list',
  ]) {
    assert.throws(() => assertSafePluginSql(bad), { code: 'PLUGIN_SQL_FORBIDDEN' }, `应拦截 ${bad}`);
  }
  assert.doesNotThrow(() => assertSafePluginSql("INSERT INTO notes (body) VALUES ('ATTACH DATABASE ok')"));
  assert.doesNotThrow(() => assertSafePluginSql('PRAGMA table_info(accounts)', { readOnly: true }));
  assert.doesNotThrow(() => assertSafePluginSql('SELECT id FROM accounts WHERE id = ?', { readOnly: true }));

  for (const badQuery of [
    'DELETE FROM accounts',
    'UPDATE accounts SET name = "x"',
    'SELECT 1; DROP TABLE accounts',
    'WITH d AS (DELETE FROM accounts RETURNING *) SELECT * FROM d',
  ]) {
    assert.throws(
      () => assertSafePluginSql(badQuery, { readOnly: true }),
      { code: 'PLUGIN_SQL_FORBIDDEN' },
      `readOnly 应拦截 ${badQuery}`,
    );
  }

  // 验证 legacy data.db 自动迁移至独立 dataDir 并从代码目录清理
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-plugin-data-'));
  try {
    const codeDir = path.join(root, 'plugins', 'com.test.p');
    const dataDir = path.join(root, 'plugin-data', 'com.test.p');
    mkdirSync(codeDir, { recursive: true });
    writeFileSync(path.join(codeDir, 'data.db'), 'legacy-content');
    const storage = new PluginStorage({
      dir: codeDir,
      dataDir,
      pluginId: 'com.test.p',
      db: openDatabase(':memory:'),
    });
    await storage.load();
    assert.equal(existsSync(path.join(codeDir, 'data.db')), false, '旧目录的 data.db 应已移走');
    assert.equal(existsSync(path.join(dataDir, 'data.db')), true, '新数据目录应收到 data.db');
    storage.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('插件 host API：storage.sql.query 强制鉴权，browser.waitForFunction 归入 browser.evaluate(denied)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-api-guard-'));
  try {
    const storage = new PluginStorage({
      dir: path.join(root, 'code'),
      dataDir: path.join(root, 'data'),
      pluginId: 'com.test.guard',
      db: openDatabase(':memory:'),
    });
    await storage.load();
    const granted = new Set<string>(['browser.dom.read']);
    const handlers = createHandlers({
      pluginId: 'com.test.guard',
      currentEnvironmentId: () => 'env1',
      currentCaller: () => 'agent',
      require: (perm) => {
        if (!granted.has(perm)) {
          throw Object.assign(new Error(`缺少权限 ${perm}`), { code: 'PLUGIN_PERMISSION_DENIED' });
        }
      },
      manager: {
        controllerFor: () => ({
          waitForFunction: async () => true,
        }),
      } as never,
      vault: { available: false, list: () => [], reveal: () => ({}) },
      storage,
      settings: {} as never,
      descriptors: [],
      record: () => {},
      log: () => {},
      signal: () => {},
      withLease: async (_envId, fn) => fn('lease-1'),
    });

    await assert.rejects(() => dispatchHostCall(handlers, 'storage.sql.query', ['SELECT 1']), {
      code: 'PLUGIN_PERMISSION_DENIED',
    });
    await assert.rejects(() => dispatchHostCall(handlers, 'browser.waitForFunction', ['() => true']), {
      code: 'PLUGIN_PERMISSION_DENIED',
    });
    storage.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('browser policy / escape / inspector：封禁危险 CDP、符号链接逃逸与密码明文读取', async () => {
  for (const method of [
    'DOM.setFileInputFiles',
    'Page.setDownloadBehavior',
    'Page.addScriptToEvaluateOnNewDocument',
    'Runtime.addBinding',
  ]) {
    assert.throws(() => checkCdpAllowed(method), { code: 'CDP_BLOCKED' });
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'warren-policy-'));
  const prevHome = process.env.WARREN_HOME;
  try {
    const fakeWarrenHome = path.join(tmpRoot, 'warren-home');
    mkdirSync(fakeWarrenHome, { recursive: true });
    process.env.WARREN_HOME = fakeWarrenHome;
    const escapeLink = path.join(tmpRoot, 'escape-link');
    symlinkSync(fakeWarrenHome, escapeLink);
    assert.throws(() => guardSavePath(path.join(escapeLink, 'core', 'warren.db')), { code: 'PATH_DENIED' });
    assert.throws(() => guardSavePath(path.join(os.homedir(), '.ssh', 'id_rsa')), { code: 'PATH_DENIED' });
    assert.throws(() => guardSavePath(path.join(os.homedir(), '.aws', 'credentials')), { code: 'PATH_DENIED' });
  } finally {
    if (prevHome === undefined) delete process.env.WARREN_HOME;
    else process.env.WARREN_HOME = prevHome;
    await rm(tmpRoot, { recursive: true, force: true });
  }

  // cdp() 必须对返回值脱敏
  const cdpHarness = createFakePageContext({
    onSend: (method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { accessToken: 'tok-secret', ok: true } } };
      }
      return undefined;
    },
  });
  const cdpRes = (await cdp(cdpHarness.ctx, 'Runtime.evaluate', { expression: '1' })) as {
    result: { value: { accessToken: string; ok: boolean } };
  };
  assert.equal(cdpRes.result.value.accessToken, '[REDACTED]');
  assert.equal(cdpRes.result.value.ok, true);

  // readTargetProperty 对密码框返回定宽掩码（绝不泄露明文）
  const pwdHarness = createFakePageContext({
    onSend: (method, params) => {
      if (method === 'Runtime.callFunctionOn') {
        const decl = String(params?.functionDeclaration ?? '');
        if (decl.includes("type === 'password'")) {
          return { result: { value: '••••••••' } };
        }
      }
      return undefined;
    },
  });
  const val = await readTargetProperty(pwdHarness.ctx, 'value', { kind: 'selector', selector: '#pwd' });
  assert.equal(val, '••••••••');
});

test('locator：零 window.__warrenMatches 全局污染，单次 Runtime.getProperties 批量解析', async () => {
  const calls: string[] = [];
  const harness = createFakePageContext({
    onSend: (method, params) => {
      calls.push(method);
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression ?? '');
        assert.equal(expr.includes('window.__warrenMatches'), false, '不应写入 window.__warrenMatches 全局变量');
        return { result: { type: 'object', subtype: 'array', objectId: 'arr-1' } };
      }
      if (method === 'Runtime.getProperties' && params?.objectId === 'arr-1') {
        return {
          result: [
            { name: '0', value: { type: 'object', objectId: 'el-0' } },
            { name: 'length', value: { type: 'number', value: 1 } },
          ],
        };
      }
      if (method === 'DOM.describeNode' && params?.objectId === 'el-0') {
        return { node: { backendNodeId: 777 } };
      }
      return undefined;
    },
  });
  const resolved = await resolveLocatorTarget(harness.ctx, { kind: 'selector', selector: 'button.primary' });
  assert.equal(resolved.backendNodeId, 777);
  assert.equal(calls.filter((m) => m === 'Runtime.evaluate').length, 1);
  assert.equal(calls.filter((m) => m === 'Runtime.getProperties').length, 1);
});

test('rpc-client：分片响应不提前清超时、异常断连立刻报错、自动续租调用 env.renew', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'warren-rpc-cli-'));
  const socketPath = path.join(dir, 'envd.sock');
  const runtimeFile = path.join(dir, 'runtime.json');
  const received: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const req = JSON.parse(buf.slice(0, idx)) as { id: string; method: string; params: Record<string, unknown> };
      received.push({ method: req.method, params: req.params });
      if (req.method === 'test.chunked') {
        const full = JSON.stringify({ id: req.id, ok: true, result: { chunked: true } }) + '\n';
        socket.write(full.slice(0, 10));
        setTimeout(() => socket.write(full.slice(10)), 25);
        return;
      }
      if (req.method === 'test.drop') {
        socket.destroy();
        return;
      }
      if (req.method === 'env.acquire') {
        // 返回 2.2s 后过期（让 renewer 在 ~1.1s 触发 env.renew）
        socket.write(
          JSON.stringify({
            id: req.id,
            ok: true,
            result: { leaseId: 'lease-xyz', expiresAt: Date.now() + 2200 },
          }) + '\n',
        );
        return;
      }
      if (req.method === 'env.renew') {
        socket.write(
          JSON.stringify({
            id: req.id,
            ok: true,
            result: { leaseId: req.params.leaseId, expiresAt: Date.now() + 60_000 },
          }) + '\n',
        );
        return;
      }
      socket.write(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + '\n');
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  writeFileSync(runtimeFile, JSON.stringify({ socketPath, token: 'tok-1', pid: process.pid }));

  try {
    const client = createRpcClient({ runtimeFile, defaultTimeoutMs: 5000 });
    const chunked = (await client.call('test.chunked')) as { chunked: boolean };
    assert.equal(chunked.chunked, true);

    await assert.rejects(() => client.call('test.drop'), { code: 'CONNECTION_CLOSED' });

    await client.withLease('env-1', {}, 'cli-test', async (leaseId: string) => {
      assert.equal(leaseId, 'lease-xyz');
      await new Promise((r) => setTimeout(r, 1250));
    });

    const renewCall = received.find((item) => item.method === 'env.renew');
    assert.ok(renewCall, '续租必须调用 env.renew 而非 env.acquire');
    assert.equal(renewCall.params.leaseId, 'lease-xyz');
    assert.equal(received.filter((item) => item.method === 'env.acquire').length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Telemetry：批量事务刷盘、URL 敏感参数脱敏、error 字段落盘与 detachTab 监听解绑', () => {
  const db = openDatabase(':memory:');
  const telemetry = new Telemetry(db);

  let onCompleted: ((details: Record<string, unknown>) => void) | undefined;
  let onError: ((details: Record<string, unknown>) => void) | undefined;
  const fakeSession = {
    webRequest: {
      onBeforeRequest: () => {},
      onCompleted: (_filter: unknown, cb: (d: Record<string, unknown>) => void) => {
        onCompleted = cb;
      },
      onErrorOccurred: (_filter: unknown, cb: (d: Record<string, unknown>) => void) => {
        onError = cb;
      },
    },
  };
  let consoleListeners = 0;
  let consoleHandler: ((...args: unknown[]) => void) | undefined;
  const fakeWc = {
    id: 501,
    on: (_ev: string, fn: (...args: unknown[]) => void) => {
      consoleListeners += 1;
      consoleHandler = fn;
    },
    off: () => {
      consoleListeners -= 1;
    },
  };

  telemetry.attachSession(fakeSession as never);
  telemetry.attachTab('env-1', 'tab-1', fakeWc as never);
  assert.equal(consoleListeners, 1);

  onCompleted?.({
    id: 1,
    webContentsId: 501,
    method: 'GET',
    url: 'https://api.example.test/v1?token=secret123&page=1',
    statusCode: 200,
    resourceType: 'xhr',
  });
  onError?.({
    id: 2,
    webContentsId: 501,
    method: 'POST',
    url: 'https://api.example.test/fail?api_key=k999',
    resourceType: 'xhr',
    error: 'net::ERR_CONNECTION_REFUSED',
  });
  consoleHandler?.({ level: 'error', message: 'boom', lineNumber: 12, sourceId: 'https://a.test/app.js' });

  // 未满 50 条前尚未落盘（写次数为 0），读取时自动单事务刷盘（writes === 1）
  assert.equal(telemetry.writeStats.writes, 0);
  const netRows = telemetry.networkEntries('env-1');
  assert.equal(telemetry.writeStats.writes, 1);
  assert.equal(netRows.length, 2);
  assert.equal(netRows[0]!.url.includes('secret123'), false, 'query token 应被脱敏');
  assert.equal(netRows[0]!.url.includes('REDACTED'), true);
  assert.equal(netRows[1]!.error, 'net::ERR_CONNECTION_REFUSED');
  assert.equal(netRows[1]!.url.includes('k999'), false);

  const consoleRows = telemetry.consoleEntries('env-1');
  assert.equal(consoleRows.length, 1);
  assert.equal(consoleRows[0]!.message, 'boom');

  telemetry.detachTab('tab-1');
  assert.equal(consoleListeners, 0, 'detachTab 必须解绑 console-message 监听');
  db.close();
});
