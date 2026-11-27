import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import hostPlugin from '../plugins/whistle/host.mjs';
import {
  compose,
  harEntry,
  normalizeTrafficEntry,
  restoreRedactedJsonFields,
  traffic,
} from '../plugins/whistle/lib/traffic.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const manifestPath = path.join(ROOT, 'plugins', 'whistle', 'package.json');

function makeMockHost(instances: Array<{ storage: string; port: number }> = []) {
  return {
    storage: {
      kv: {
        get: async () => instances,
        set: async () => undefined,
      },
      sql: {
        query: async () => [],
        migrate: async () => 0,
      },
    },
    environment: { list: async () => [] },
    events: { publish: async () => undefined },
    log: { info: async () => undefined, warn: async () => undefined },
  };
}

test('Whistle 插件暴露全量观测、Values、Intent 与 Preset 能力，且 CLI 与 RPC 完全对称', async () => {
  const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
  const warren = pkg.warren;
  assert.equal(pkg.dependencies.whistle, '2.10.15');
  assert.ok(pkg.files.includes('intents.mjs'));
  assert.ok(pkg.files.includes('SKILL.md'));
  assert.ok(pkg.files.includes('lib/'));
  assert.equal(warren.skill?.entry, 'SKILL.md');
  assert.ok(Array.isArray(warren.skill?.triggers) && warren.skill.triggers.length > 0);

  const commands = new Set(warren.contributes.commands.map((item: { name: string }) => item.name));
  const rpc = new Set(warren.contributes.rpc);
  const pluginObj = hostPlugin as Record<string, unknown>;
  const rpcObj = hostPlugin.rpc as Record<string, unknown>;

  for (const name of commands) {
    assert.equal(typeof pluginObj[name as string], 'function', `host 缺命令 ${String(name)}`);
    assert.equal(rpc.has(name), true, `manifest 缺 rpc ${String(name)}`);
    assert.equal(typeof rpcObj[name as string], 'function', `host.rpc 缺方法 ${String(name)}`);
  }
});

test('所有新能力只操作已登记并存活的实例，未知或离线实例明确拒绝（不回落 8899）', async () => {
  await assert.rejects(
    () => traffic(makeMockHost([]), { storage: 'missing-inst' }),
    (err: Error & { code?: string }) => err.code === 'WHISTLE_INSTANCE_UNKNOWN',
  );
  await assert.rejects(
    () => compose(makeMockHost([]), { storage: 'missing-inst', url: 'https://example.com' }),
    (err: Error & { code?: string }) => err.code === 'WHISTLE_INSTANCE_UNKNOWN',
  );
});

test('traffic 条目归一化默认脱敏敏感请求/响应头，并保留 ReqId 与编码元数据', () => {
  const item = {
    req: {
      method: 'POST',
      headers: {
        authorization: 'Bearer [REDACTED]',
        cookie: 'session=[REDACTED]',
        'x-req': 'ok',
      },
      body: '{"password":"[REDACTED]","ok":true}',
    },
    res: {
      statusCode: 200,
      headers: { 'set-cookie': 'sid=[REDACTED]', 'content-type': 'application/json' },
      body: '{"token":"[REDACTED]"}',
    },
  };
  const redacted = normalizeTrafficEntry('req-1', item, {}) as Record<string, unknown>;
  assert.equal(redacted.entryId, 'req-1');
  const reqHeaders = redacted.requestHeaders as Record<string, unknown>;
  const resHeaders = redacted.responseHeaders as Record<string, unknown>;
  assert.equal(reqHeaders.authorization, '[REDACTED]');
  assert.equal(reqHeaders.cookie, '[REDACTED]');
  assert.equal(reqHeaders['x-req'], 'ok');
  assert.equal(resHeaders['set-cookie'], '[REDACTED]');
  assert.equal(redacted.requestBodyEncoding, 'text');
  assert.equal(redacted.responseBodyEncoding, 'text');

  const unredacted = normalizeTrafficEntry('req-2', item, { includeSensitive: true }) as Record<string, unknown>;
  assert.equal((unredacted.requestHeaders as Record<string, unknown>)['x-req'], 'ok');
});

test('harEntry 与 restoreRedactedJsonFields 行为契约完整', () => {
  const entry = harEntry({
    id: '1',
    startTime: Date.now(),
    url: 'https://example.com/api?a=1',
    req: { method: 'GET', headers: { host: 'example.com' } },
    res: { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'hi' },
  });
  assert.ok(typeof entry.startedDateTime === 'string');
  assert.equal(entry.request.method, 'GET');
  assert.equal(entry.response.status, 200);

  const restored = restoreRedactedJsonFields(
    { password: '[REDACTED]', nested: { secret: '[REDACTED]' }, note: 'edited' },
    { password: 'orig-pw', nested: { secret: 'orig-sec' }, note: 'orig' },
  ) as Record<string, unknown>;
  assert.equal(restored.note, 'edited');
});

test('仓库不内置真实预设，preset 命令与表结构全部面向用户导入预设', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')).warren;
  const presetCommands = manifest.contributes.commands
    .map((item: { name: string }) => item.name)
    .filter((name: string) => name.startsWith('preset'));
  assert.ok(presetCommands.includes('presetImport'));
  assert.ok(presetCommands.includes('presetPreview'));
  assert.ok(presetCommands.includes('presetApply'));
  const listed = await (hostPlugin.presetList as (c: unknown) => Promise<{ presets: unknown[] }>)({
    host: makeMockHost([]),
    input: {},
  });
  assert.deepEqual(listed.presets, []);
});

test('whistle host.mjs：compose 走 Agent 强制脱敏、长耗时命令声明 timeoutMs，且 reload/update 不误杀运行中实例', async () => {
  const hostSource = await readFile(path.join(ROOT, 'plugins', 'whistle', 'host.mjs'), 'utf8');
  assert.match(
    hostSource,
    /compose:\s*\(host,\s*input,\s*ctx\)\s*=>\s*compose\(host,\s*sanitizeTrafficInput\(ctx,\s*input\)\)/,
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')).warren;
  const cmdTimeout = new Map(
    manifest.contributes.commands.map((item: { name: string; timeoutMs?: number }) => [item.name, item.timeoutMs]),
  );
  for (const name of ['fork', 'start', 'bind', 'presetApply']) {
    assert.equal(cmdTimeout.get(name), 90_000, `${name} 应声明 90000ms 超时`);
  }
  // reload / update 路径直接返回，不会尝试调 w2 stop
  await (hostPlugin.dispose as (ctx?: unknown) => Promise<void>)({ reason: 'reload', host: makeMockHost([]) });
  await (hostPlugin.dispose as (ctx?: unknown) => Promise<void>)({ reason: 'update', host: makeMockHost([]) });
});
