import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/main/db.ts';
import { createHandlers, dispatchHostCall } from '../src/main/plugins/api/index.ts';
import { currentCaller, runWithPluginContext } from '../src/main/plugins/call-context.ts';
import { SandboxRuntime } from '../src/main/plugins/runtime-sandbox.ts';
import { PluginStorage } from '../src/main/plugins/storage.ts';

const ROOT = path.join(import.meta.dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'account-manager');
/** 凭据测试值一律 [REDACTED] 风格（AGENTS.md 硬约束第 7 条） */
const PASSWORD = '  [REDACTED]  ';
const ENV = 'env-fixture';

interface FillCall {
  target: unknown;
  value: string;
}

interface ClickCall {
  target: unknown;
  options: unknown;
}

interface SignalCall {
  channel: string;
  payload: unknown;
}

interface MockPluginOptions {
  currentUrl?: () => string;
  title?: () => string;
  activeSpaceId?: 'person' | 'agent';
  detectResult?: (space?: 'person' | 'agent') => Record<string, unknown>;
}

/**
 * 把插件后端跑起来，并记录页面填充、点击与信号广播。
 */
async function withPlugin(
  run: (
    runtime: SandboxRuntime,
    recorder: { fills: FillCall[]; clicks: ClickCall[]; signals: SignalCall[] },
    storage: PluginStorage,
  ) => Promise<void>,
  options: MockPluginOptions = {},
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-accounts-'));
  const storage = new PluginStorage({
    dir,
    pluginId: 'com.warren.accounts',
    db: openDatabase(':memory:'),
  });
  const fills: FillCall[] = [];
  const clicks: ClickCall[] = [];
  const signals: SignalCall[] = [];
  let runtime: SandboxRuntime | undefined;
  try {
    await storage.load();
    const currentUrlFn = options.currentUrl ?? (() => 'http://127.0.0.1:8899/login.html');
    const titleFn = options.title ?? (() => 'Fixture Login');
    const handlers = createHandlers({
      pluginId: 'com.warren.accounts',
      currentEnvironmentId: () => ENV,
      currentCaller,
      require: () => undefined,
      manager: {
        get: () => ({ id: ENV, activeSpaceId: options.activeSpaceId ?? 'person' }),
        assertWritable: () => ({ leaseId: 'lease' }),
        controllerFor: (_id: string, _tab?: unknown, space?: 'person' | 'agent') => ({
          currentUrl: currentUrlFn,
          title: async () => titleFn(),
          info: async () => ({
            url: currentUrlFn(),
            title: titleFn(),
            loading: false,
            dialog: null,
            tab: { id: 'tab-1', index: 0 },
            env: ENV,
          }),
          detectLoginFields: async () =>
            options.detectResult
              ? options.detectResult(space)
              : {
                  url: currentUrlFn(),
                  host: new URL(currentUrlFn()).hostname,
                  step: 'single',
                  fields: {
                    username: { kind: 'username', selector: '#u', target: '#u', confidence: 0.9 },
                    password: { kind: 'password', selector: '#p', target: '#p', confidence: 0.95 },
                    submit: { kind: 'submit', selector: '#submit', target: '#submit', confidence: 0.9 },
                  },
                  candidates: [],
                },
          fill: async (target: unknown, value: string) => {
            fills.push({ target, value });
          },
          click: async (target: unknown, clickOpts: unknown) => {
            clicks.push({ target, options: clickOpts });
            return {};
          },
        }),
        ensureOperable: () => true,
        detachOperable: () => undefined,
        assertInputOnScreen: () => undefined,
        assertActiveTab: () => undefined,
        focusForInput: async () => undefined,
        prepareBackgroundInput: async () => false,
        clearBackgroundInput: async () => undefined,
        withInputContext: async (_id: string, _space: unknown, _tab: unknown, fn: () => Promise<unknown>) => fn(),
      } as never,
      storage,
      settings: { get: () => ({}) } as never,
      descriptors: [],
      record: () => undefined,
      log: () => undefined,
      signal: (channel, payload) => {
        signals.push({ channel, payload });
      },
      withLease: async (_env, fn) => fn('lease'),
    });
    runtime = new SandboxRuntime({
      pluginId: 'com.warren.accounts',
      entryPath: path.join(PLUGIN_DIR, 'server.js'),
      code: await readFile(path.join(PLUGIN_DIR, 'server.js'), 'utf8'),
      onHostCall: (callPath, args, context) =>
        runWithPluginContext(
          {
            pluginId: 'com.warren.accounts',
            environmentId: context.environmentId ?? ENV,
            leaseId: context.leaseId,
            caller: context.caller,
          },
          () => dispatchHostCall(handlers, callPath, args),
        ),
      log: () => undefined,
    });
    await runtime.start();
    await run(runtime, { fills, clicks, signals }, storage);
  } finally {
    await runtime?.dispose();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

interface PublicAccount {
  id: number;
  name: string;
  url: string;
  urls: string[];
  username?: string;
  usernameHint: string;
  hasPassword: boolean;
  hasTotp: boolean;
  extraFieldKeys: string[];
  note: string;
  tags: string;
  displayAliases: string[];
  appHints: string[];
  manualVerificationHint: string;
  selectors: Record<string, unknown>;
  allowedHosts: string[];
  envIds: string[];
  pinned: boolean;
  useCount: number;
  lastUsedAt: string;
  deletedAt: string;
}

async function createFixture(runtime: SandboxRuntime, overrides: Record<string, unknown> = {}): Promise<PublicAccount> {
  await runtime.command('create', {
    input: {
      name: '测试后台',
      url: 'http://127.0.0.1:8899/login.html',
      username: 'tester@example.test',
      password: PASSWORD,
      note: '只用于本地 fixture',
      tags: 'local,fixture',
      ...overrides,
    },
  });
  const list = (await runtime.rpc('list', {}, { caller: 'ui' })) as { accounts: PublicAccount[] };
  return list.accounts[0]!;
}

test('Agent-first：agent 通道可直接维护 url / urls / allowedHosts', async () => {
  await withPlugin(async (runtime) => {
    const account = await createFixture(runtime);
    await runtime.command('update', {
      input: {
        id: account.id,
        url: 'https://cloud.tencent.com/login',
        urls: ['https://console.cloud.tencent.com'],
        allowedHosts: ['cloud.tencent.com'],
      },
      caller: 'agent',
    });
    const list = (await runtime.rpc('list', {}, { caller: 'agent' })) as { accounts: PublicAccount[] };
    const item = list.accounts.find((a) => a.id === account.id)!;
    assert.deepEqual(item.allowedHosts, ['cloud.tencent.com']);
    assert.equal((item as unknown as { url: string }).url, 'https://cloud.tencent.com/login');
    assert.deepEqual((item as unknown as { urls: string[] }).urls, ['https://console.cloud.tencent.com']);
  });
});

test('账号管理插件：明文新增、搜索、改备注、删除与 changed 信号', async () => {
  await withPlugin(async (runtime, { signals }) => {
    const account = await createFixture(runtime);
    assert.equal(account.note, '只用于本地 fixture');
    assert.equal(
      signals.some((s) => s.channel === 'changed'),
      true,
    );

    const searched = (await runtime.command('list', { input: { query: 'fixture' } })) as {
      accounts: PublicAccount[];
    };
    assert.equal(searched.accounts.length, 1);

    await runtime.command('update', { input: { id: account.id, note: '备注已更新', password: '[REDACTED]' } });
    const updated = (await runtime.command('list', { input: {} })) as { accounts: PublicAccount[] };
    assert.equal(updated.accounts[0]!.note, '备注已更新');

    await runtime.command('remove', { input: { id: account.id } });
    const empty = (await runtime.command('list', { input: {} })) as { accounts: unknown[] };
    assert.equal(empty.accounts.length, 0);
  });
});

test('旧版表结构在 activate 时幂等迁移并读写全量扩展列', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-accounts-legacy-'));
  const storage = new PluginStorage({ dir, pluginId: 'com.warren.accounts', db: openDatabase(':memory:') });
  try {
    await storage.load();
    // 模拟老版本数据库只有最初的 9 列（不含 6 个激活列也不含 Phase 2A 新增 10 列）
    storage.db().exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        password TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _warren_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO _warren_migrations (id, applied_at) VALUES (0, '2026-01-01T00:00:00.000Z');
      INSERT INTO accounts (name, url, username, password, created_at, updated_at)
      VALUES ('Legacy', 'https://legacy.test', 'old@legacy.test', '[REDACTED]', '2026-01-01', '2026-01-01');
    `);
    const handlers = createHandlers({
      pluginId: 'com.warren.accounts',
      currentEnvironmentId: () => ENV,
      require: () => undefined,
      manager: { get: () => ({ id: ENV }) } as never,
      storage,
      settings: { get: () => ({}) } as never,
      descriptors: [],
      record: () => undefined,
      log: () => undefined,
      signal: () => undefined,
      withLease: async (_e, fn) => fn('lease'),
    });
    const onHostCall = (
      callPath: string,
      args: unknown[],
      context: { environmentId?: string; leaseId?: string; caller?: 'ui' | 'agent' },
    ) =>
      runWithPluginContext(
        {
          pluginId: 'com.warren.accounts',
          environmentId: context.environmentId ?? ENV,
          leaseId: context.leaseId,
          caller: context.caller,
        },
        () => dispatchHostCall(handlers, callPath, args),
      );
    const runtime = new SandboxRuntime({
      pluginId: 'com.warren.accounts',
      entryPath: path.join(PLUGIN_DIR, 'server.js'),
      code: await readFile(path.join(PLUGIN_DIR, 'server.js'), 'utf8'),
      onHostCall,
      log: () => undefined,
    });
    try {
      await runtime.start();
      // 再次启动验证幂等
      await runtime.dispose();
      const runtime2 = new SandboxRuntime({
        pluginId: 'com.warren.accounts',
        entryPath: path.join(PLUGIN_DIR, 'server.js'),
        code: await readFile(path.join(PLUGIN_DIR, 'server.js'), 'utf8'),
        onHostCall,
        log: () => undefined,
      });
      await runtime2.start();
      try {
        const res = (await runtime2.rpc(
          'create',
          {
            name: '新全量账号',
            url: 'https://app.example.test/login',
            urls: ['https://sso.example.test'],
            username: 'alice@example.test',
            password: PASSWORD,
            totpSecret: 'JBSWY3DPEHPK3PXP',
            extraFields: { tenant: 'acme' },
            displayAliases: ['示例平台', 'portal.example.test'],
            appHints: ['web'],
            manualVerificationHint: '如遇滑块请人工完成',
            selectors: { username: '#u', password: '#p', submit: '#go' },
            allowedHosts: ['auth.example.test'],
            envIds: [ENV],
            pinned: true,
          },
          { caller: 'ui' },
        )) as { accounts: PublicAccount[] };
        const created = res.accounts.find((a) => a.name === '新全量账号')!;
        assert.deepEqual(created.urls, ['https://sso.example.test']);
        assert.equal(created.hasTotp, true);
        assert.deepEqual(created.extraFieldKeys, ['tenant']);
        assert.deepEqual(created.displayAliases, ['示例平台', 'portal.example.test']);
        assert.deepEqual(created.appHints, ['web']);
        assert.equal(created.manualVerificationHint, '如遇滑块请人工完成');
        assert.deepEqual(created.selectors, { username: '#u', password: '#p', submit: '#go' });
        assert.deepEqual(created.allowedHosts, ['auth.example.test']);
        assert.deepEqual(created.envIds, [ENV]);
        assert.equal(created.pinned, true);
      } finally {
        await runtime2.dispose();
      }
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('安全边界：agent 通道绝不返回明文 username / password / totpSecret / extraFields，ui 通道保留 username', async () => {
  await withPlugin(async (runtime) => {
    const account = await createFixture(runtime, {
      totpSecret: 'JBSWY3DPEHPK3PXP',
      extraFields: { corpId: '[REDACTED_CORP]' },
    });

    // agent (显式与缺省 caller)
    for (const ctx of [{ caller: 'agent' }, {}]) {
      const viaList = (await runtime.rpc('list', {}, ctx)) as { accounts: PublicAccount[] };
      const item = viaList.accounts[0]!;
      assert.equal('username' in item, false, 'agent list 禁止返回明文 username');
      assert.equal('password' in item, false);
      assert.equal('totpSecret' in item, false);
      assert.equal('extraFields' in item, false);
      assert.equal(item.usernameHint, 't***@example.test');
      assert.equal(item.hasPassword, true);
      assert.equal(item.hasTotp, true);
      assert.deepEqual(item.extraFieldKeys, ['corpId']);
      const serialized = JSON.stringify(viaList);
      assert.equal(serialized.includes('tester@example.test'), false);
      assert.equal(serialized.includes(PASSWORD.trim()), false);
      assert.equal(serialized.includes('JBSWY3DPEHPK3PXP'), false);
      assert.equal(serialized.includes('[REDACTED_CORP]'), false);

      const got = (await runtime.rpc('get', { id: account.id }, ctx)) as { account: PublicAccount };
      assert.equal('username' in got.account, false, 'agent get 禁止返回明文 username');
      assert.equal('password' in got.account, false);

      const matched = (await runtime.rpc('match', { url: 'http://127.0.0.1:8899/login.html' }, ctx)) as {
        matches: Array<{ account: PublicAccount }>;
      };
      assert.equal(matched.matches.length, 1);
      assert.equal('username' in matched.matches[0]!.account, false, 'agent match 禁止返回明文 username');
    }

    // ui caller 保留 username（兼容旧 app.js）但仍不给 password/totpSecret/extraFields 值
    const uiList = (await runtime.rpc('list', {}, { caller: 'ui' })) as { accounts: PublicAccount[] };
    assert.equal(uiList.accounts[0]!.username, 'tester@example.test');
    assert.equal('password' in uiList.accounts[0]!, false);
    assert.equal('totpSecret' in uiList.accounts[0]!, false);
    assert.equal('extraFields' in uiList.accounts[0]!, false);
  });
});

test('export 仅对插件界面开放且必须显式 confirm=plaintext（防 agent 导出明文全库）', async () => {
  await withPlugin(async (runtime) => {
    const account = await createFixture(runtime, {
      totpSecret: 'JBSWY3DPEHPK3PXP',
      extraFields: { tenant: 'acme' },
      urls: ['https://backup.example.test'],
    });

    // Agent 通道即便传 confirm=plaintext 也一律拒绝
    await assert.rejects(
      () => runtime.command('export', { input: { confirm: 'plaintext' }, caller: 'agent' }),
      (error: Error & { code?: string }) => error.code === 'ACCOUNT_EXPORT_UI_ONLY',
    );
    await assert.rejects(
      () => runtime.rpc('export', { confirm: 'plaintext' }, { caller: 'agent' }),
      (error: Error & { code?: string }) => error.code === 'ACCOUNT_EXPORT_UI_ONLY',
    );

    // UI 通道不带 confirm 拒绝
    await assert.rejects(
      () => runtime.rpc('export', {}, { caller: 'ui' }),
      (error: Error & { code?: string }) => error.code === 'ACCOUNT_EXPORT_CONFIRM_REQUIRED',
    );

    // UI 通道带 confirm=plaintext 返回 v2 明文备份
    const exported = (await runtime.rpc('export', { confirm: 'plaintext' }, { caller: 'ui' })) as {
      version: number;
      accounts: Array<{ id: number; password: string; totpSecret: string; extraFields: Record<string, string> }>;
    };
    assert.equal(exported.version, 2);
    assert.equal(exported.accounts[0]!.password, PASSWORD);
    assert.equal(exported.accounts[0]!.id, account.id);
    assert.equal(exported.accounts[0]!.totpSecret, 'JBSWY3DPEHPK3PXP');
    assert.deepEqual(exported.accounts[0]!.extraFields, { tenant: 'acme' });
  });
});

test('reveal 与 totpCode 仅对插件界面开放，支持扩展字段与 RFC 6238 测试向量', async () => {
  await withPlugin(async (runtime) => {
    // RFC 6238 Appendix B 密钥（ASCII "12345678901234567890" 的 Base32 编码）
    const sha1Secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const sha256Secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA'; // 32 bytes "12345678901234567890123456789012"
    const sha512Secret =
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA'; // 64 bytes

    const account = await createFixture(runtime, {
      totpSecret: `otpauth://totp/RFC:test?secret=${sha1Secret}&algorithm=SHA1&digits=8&period=30`,
      extraFields: { pin: '[REDACTED_PIN]' },
    });

    // reveal 拒绝 agent
    for (const ctx of [{ caller: 'agent' }, {}]) {
      await assert.rejects(
        () => runtime.rpc('reveal', { id: account.id, field: 'password' }, ctx),
        (error: Error & { code?: string }) => error.code === 'ACCOUNT_REVEAL_UI_ONLY',
      );
      await assert.rejects(
        () => runtime.rpc('totpCode', { id: account.id }, ctx),
        (error: Error & { code?: string }) => error.code === 'ACCOUNT_TOTP_UI_ONLY',
      );
    }

    // reveal ui 支持 password / username / totpSecret / extra:<key>
    const revPwd = (await runtime.rpc('reveal', { id: account.id, field: 'password' }, { caller: 'ui' })) as {
      value: string;
    };
    const revUser = (await runtime.rpc('reveal', { id: account.id, field: 'username' }, { caller: 'ui' })) as {
      value: string;
    };
    const revTotp = (await runtime.rpc('reveal', { id: account.id, field: 'totpSecret' }, { caller: 'ui' })) as {
      value: string;
    };
    const revExtra = (await runtime.rpc('reveal', { id: account.id, field: 'extra:pin' }, { caller: 'ui' })) as {
      value: string;
    };
    assert.equal(revPwd.value, PASSWORD);
    assert.equal(revUser.value, 'tester@example.test');
    assert.match(revTotp.value, /^otpauth:\/\/totp/);
    assert.equal(revExtra.value, '[REDACTED_PIN]');

    // RFC 6238 标准向量验证：t = 59s & 1111111109s (SHA1)
    const vSha1_59 = (await runtime.rpc('totpCode', { id: account.id, timestampMs: 59_000 }, { caller: 'ui' })) as {
      code: string;
      remainingSeconds: number;
      digits: number;
      algorithm: string;
    };
    assert.equal(vSha1_59.code, '94287082');
    assert.equal(vSha1_59.digits, 8);
    assert.equal(vSha1_59.algorithm, 'SHA1');
    assert.equal(vSha1_59.remainingSeconds, 1);

    const vSha1_1111 = (await runtime.rpc(
      'totpCode',
      { id: account.id, timestampMs: 1_111_111_109_000 },
      { caller: 'ui' },
    )) as { code: string };
    assert.equal(vSha1_1111.code, '07081804');

    // SHA-256 向量
    await runtime.rpc(
      'update',
      {
        id: account.id,
        totpSecret: `otpauth://totp/RFC:sha256?secret=${sha256Secret}&algorithm=SHA256&digits=8&period=30`,
      },
      { caller: 'ui' },
    );
    const vSha256_59 = (await runtime.rpc('totpCode', { id: account.id, timestampMs: 59_000 }, { caller: 'ui' })) as {
      code: string;
      algorithm: string;
    };
    assert.equal(vSha256_59.code, '46119246');
    assert.equal(vSha256_59.algorithm, 'SHA256');

    const vSha256_1111 = (await runtime.rpc(
      'totpCode',
      { id: account.id, timestampMs: 1_111_111_109_000 },
      { caller: 'ui' },
    )) as { code: string };
    assert.equal(vSha256_1111.code, '68084774');

    // SHA-512 向量
    await runtime.rpc(
      'update',
      {
        id: account.id,
        totpSecret: `otpauth://totp/RFC:sha512?secret=${sha512Secret}&algorithm=SHA512&digits=8&period=30`,
      },
      { caller: 'ui' },
    );
    const vSha512_59 = (await runtime.rpc('totpCode', { id: account.id, timestampMs: 59_000 }, { caller: 'ui' })) as {
      code: string;
      algorithm: string;
    };
    assert.equal(vSha512_59.code, '90693936');
    assert.equal(vSha512_59.algorithm, 'SHA512');

    const vSha512_1111 = (await runtime.rpc(
      'totpCode',
      { id: account.id, timestampMs: 1_111_111_109_000 },
      { caller: 'ui' },
    )) as { code: string };
    assert.equal(vSha512_1111.code, '25091201');
  });
});

test('fill 把值送进页面，返回体不含值，且默认向后兼容', async () => {
  await withPlugin(async (runtime, { fills }) => {
    const account = await createFixture(runtime);

    const result = (await runtime.rpc(
      'fill',
      {
        id: account.id,
        environmentId: ENV,
        fields: { username: '#account', password: 'input[type=password]' },
      },
      {},
    )) as { filled: string[]; id: number };

    assert.deepEqual(JSON.parse(JSON.stringify(result)), { filled: ['username', 'password'], id: account.id });
    assert.equal(JSON.stringify(result).includes(PASSWORD.trim()), false, '返回体里一个字都不能有密码');
    assert.equal(JSON.stringify(result).includes('REDACTED'), false, '即使是占位符也不该出现在返回体里');

    assert.deepEqual(
      fills.map((item) => [item.target, item.value]),
      [
        ['#account', 'tester@example.test'],
        ['input[type=password]', PASSWORD],
      ],
    );

    const updated = (await runtime.rpc('get', { id: account.id }, {})) as { account: PublicAccount };
    assert.equal(updated.account.useCount, 1);
    assert.ok(updated.account.lastUsedAt);
  });
});

test('fill 缺 environmentId / 缺 fields 分别报明确错误码', async () => {
  await withPlugin(async (runtime) => {
    const account = await createFixture(runtime);

    await assert.rejects(
      () => runtime.rpc('fill', { id: account.id, fields: { password: '#p' } }, {}),
      (error: Error & { code?: string }) => error.code === 'ACCOUNT_NO_ENVIRONMENT',
    );
    await assert.rejects(
      () => runtime.rpc('fill', { id: account.id, environmentId: ENV, fields: {} }, {}),
      (error: Error & { code?: string }) => error.code === 'ACCOUNT_NO_FIELDS',
    );
  });
});

test('fill 与 autoFill：保存选择器优先、自动探测、TOTP、扩展字段、submit、跨站拦截与两步登录', async () => {
  let step: 'single' | 'username-only' | 'password-only' = 'single';
  let currentUrl = 'https://app.example.test/login';

  await withPlugin(
    async (runtime, { fills, clicks }) => {
      const account = await createFixture(runtime, {
        name: 'Example App',
        url: 'https://app.example.test/login',
        username: 'alice@example.test',
        password: '[REDACTED_PASS]',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        extraFields: { tenant: 'acme-corp' },
        selectors: { username: '#saved-user', tenant: '#tenant-input' },
        manualVerificationHint: '若弹出图形验证码请人工处理',
      });

      // 1. 省略 fields：username 优先走 saved selectors，password/totp/submit 走 detectLoginFields
      const res = (await runtime.rpc('autoFill', { environmentId: ENV, submit: true }, { caller: 'agent' })) as {
        id: number;
        filled: string[];
        submitted: boolean;
        step: string;
        manualVerificationHint: string;
        matchedAccount: PublicAccount;
      };
      assert.equal(res.id, account.id);
      assert.deepEqual(res.filled, ['username', 'password', 'tenant', 'totp']);
      assert.equal(res.submitted, true);
      assert.equal(res.step, 'single');
      assert.equal(res.manualVerificationHint, '若弹出图形验证码请人工处理');
      assert.equal('username' in res.matchedAccount, false, 'autoFill 返回的 matchedAccount 也必须按 caller 脱敏');
      assert.equal(fills.length, 4);
      assert.equal(fills[0]!.target, '#saved-user');
      assert.equal(fills[1]!.target, '#detected-pass');
      assert.equal(fills[2]!.target, '#tenant-input');
      assert.equal(fills[2]!.value, 'acme-corp');
      assert.equal(fills[3]!.target, '#detected-totp');
      assert.match(fills[3]!.value, /^\d{6}$/);
      assert.equal(JSON.stringify(res).includes(fills[3]!.value), false, '返回体绝不能出现 TOTP 动态码');
      assert.equal(clicks.length, 1);
      assert.equal(clicks[0]!.target, '#detected-submit');

      // 2. 两步登录：username-only -> password-only
      fills.length = 0;
      step = 'username-only';
      const step1 = (await runtime.rpc('fill', { id: account.id, environmentId: ENV }, { caller: 'agent' })) as {
        filled: string[];
        step: string;
      };
      assert.deepEqual(step1.filled, ['username']);
      assert.equal(step1.step, 'username-only');

      step = 'password-only';
      const step2 = (await runtime.rpc('fill', { id: account.id, environmentId: ENV }, { caller: 'agent' })) as {
        filled: string[];
        step: string;
      };
      assert.deepEqual(step2.filled, ['password']);
      assert.equal(step2.step, 'password-only');

      // 3. agent 禁止操作 Person Space
      await assert.rejects(
        () => runtime.rpc('fill', { id: account.id, environmentId: ENV, space: 'person' }, { caller: 'agent' }),
        (error: Error & { code?: string }) => error.code === 'SPACE_FORBIDDEN',
      );
      // ui 允许操作 Person Space
      await runtime.rpc('fill', { id: account.id, environmentId: ENV, space: 'person' }, { caller: 'ui' });

      // 4. 跨站域名白名单强拦截（agent 无法绕过，ui 需显式 allowCrossOrigin）
      currentUrl = 'https://evil.phishing.test/login';
      await assert.rejects(
        () =>
          runtime.rpc(
            'fill',
            { id: account.id, environmentId: ENV, fields: { password: '#detected-pass' }, allowCrossOrigin: true },
            { caller: 'agent' },
          ),
        (error: Error & { code?: string }) => error.code === 'PATH_DENIED',
      );
      await assert.rejects(
        () =>
          runtime.rpc(
            'fill',
            { id: account.id, environmentId: ENV, fields: { password: '#detected-pass' } },
            { caller: 'ui' },
          ),
        (error: Error & { code?: string }) => error.code === 'PATH_DENIED',
      );
      const crossOk = (await runtime.rpc(
        'fill',
        { id: account.id, environmentId: ENV, fields: { password: '#detected-pass' }, allowCrossOrigin: true },
        { caller: 'ui' },
      )) as { filled: string[] };
      assert.deepEqual(crossOk.filled, ['password']);
    },
    {
      currentUrl: () => currentUrl,
      detectResult: () => {
        if (step === 'username-only') {
          return {
            url: currentUrl,
            host: new URL(currentUrl).hostname,
            step: 'username-only',
            fields: {
              username: { kind: 'username', selector: '#u', target: '#u', confidence: 0.9 },
              submit: { kind: 'submit', selector: '#next', target: '#next', confidence: 0.9 },
            },
            candidates: [],
          };
        }
        if (step === 'password-only') {
          return {
            url: currentUrl,
            host: new URL(currentUrl).hostname,
            step: 'password-only',
            fields: {
              password: { kind: 'password', selector: '#detected-pass', target: '#detected-pass', confidence: 0.95 },
              submit: { kind: 'submit', selector: '#detected-submit', target: '#detected-submit', confidence: 0.9 },
            },
            candidates: [],
          };
        }
        return {
          url: currentUrl,
          host: new URL(currentUrl).hostname,
          step: 'single',
          fields: {
            username: { kind: 'username', selector: '#detected-user', target: '#detected-user', confidence: 0.9 },
            password: { kind: 'password', selector: '#detected-pass', target: '#detected-pass', confidence: 0.95 },
            totp: { kind: 'totp', selector: '#detected-totp', target: '#detected-totp', confidence: 0.9 },
            submit: { kind: 'submit', selector: '#detected-submit', target: '#detected-submit', confidence: 0.9 },
          },
          candidates: [],
        };
      },
    },
  );
});

test('match 智能排序与 autoFill 多账号歧义处理', async () => {
  await withPlugin(
    async (runtime) => {
      await createFixture(runtime, {
        name: 'Subdomain Account',
        url: 'https://console.acme.com/login',
        username: 'sub@acme.com',
      });
      const exact = await createFixture(runtime, {
        name: 'Exact Origin A',
        url: 'https://auth.acme.com/login',
        username: 'a@acme.com',
        pinned: true,
      });
      await createFixture(runtime, {
        name: 'Other Site',
        url: 'https://unrelated.org/login',
        username: 'other@unrelated.org',
        envIds: [ENV],
      });

      const matchRes = (await runtime.rpc(
        'match',
        { url: 'https://auth.acme.com/oauth', environmentId: ENV },
        { caller: 'agent' },
      )) as { matches: Array<{ account: PublicAccount; score: number; reasons: string[] }> };
      // unrelated.org 虽然带 envIds，但不匹配域名应被过滤掉
      assert.equal(matchRes.matches.length, 2);
      assert.equal(matchRes.matches[0]!.account.id, exact.id);
      assert.ok(matchRes.matches[0]!.score > matchRes.matches[1]!.score);
      assert.ok(matchRes.matches[0]!.reasons.includes('exact-origin'));

      // 新增第二个同站账号触发 autoFill 歧义
      await createFixture(runtime, {
        name: 'Exact Origin B',
        url: 'https://auth.acme.com/login',
        username: 'b@acme.com',
      });
      await assert.rejects(
        () => runtime.rpc('autoFill', { environmentId: ENV }, { caller: 'agent' }),
        (error: Error & { code?: string }) => error.code === 'ACCOUNT_AMBIGUOUS',
      );
    },
    { currentUrl: () => 'https://auth.acme.com/login' },
  );
});

test('autoFill 无匹配账号报 ACCOUNT_NO_MATCH，detectFields 返回规范结构', async () => {
  await withPlugin(
    async (runtime) => {
      await assert.rejects(
        () => runtime.rpc('autoFill', { environmentId: ENV }, { caller: 'agent' }),
        (error: Error & { code?: string }) => error.code === 'ACCOUNT_NO_MATCH',
      );
      const detected = (await runtime.rpc('detectFields', { environmentId: ENV }, { caller: 'agent' })) as {
        url: string;
        title: string;
        step: string;
        hasOtp: boolean;
        hasCaptcha: boolean;
        submit: unknown;
      };
      assert.equal(detected.url, 'https://empty.test/login');
      assert.equal(detected.title, 'Empty Login');
      assert.equal(detected.step, 'single');
      assert.equal(detected.hasOtp, false);
      assert.equal(detected.hasCaptcha, false);
      assert.ok(detected.submit);
    },
    { currentUrl: () => 'https://empty.test/login', title: () => 'Empty Login' },
  );
});

test('generatePassword、importAccounts（JSON + Chrome CSV + 去重）、回收站、togglePin 与 saveSelectors', async () => {
  await withPlugin(async (runtime) => {
    // 1. 密码生成器
    const pwd = (await runtime.command('generatePassword', {
      input: { length: 24, excludeAmbiguous: true },
    })) as { password: string; length: number };
    assert.equal(pwd.length, 24);
    assert.equal(pwd.password.length, 24);
    assert.equal(/[IOl01]/.test(pwd.password), false, 'excludeAmbiguous 必须排除易混字符');

    // 2. Chrome CSV 导入（含引号逗号与换行备注）
    const chromeCsv = [
      'name,url,username,password,note',
      `GitHub,https://github.com/login,octo@example.test,${PASSWORD.trim()},"line1, ""quoted""\nline2"`,
      `GitLab,https://gitlab.com/users/sign_in,lab@example.test,${PASSWORD.trim()},work`,
    ].join('\n');
    const csvImport = (await runtime.command('importAccounts', {
      input: { format: 'chrome-csv', content: chromeCsv, strategy: 'skip' },
    })) as { imported: number; skipped: number; failed: number };
    assert.equal(csvImport.imported, 2);
    assert.equal(csvImport.failed, 0);

    // 重复导入 skip vs overwrite vs duplicate
    const skipAgain = (await runtime.command('importAccounts', {
      input: { format: 'auto', content: chromeCsv, strategy: 'skip' },
    })) as { imported: number; skipped: number };
    assert.equal(skipAgain.imported, 0);
    assert.equal(skipAgain.skipped, 2);

    const jsonUpdate = (await runtime.command('importAccounts', {
      input: {
        format: 'json',
        strategy: 'overwrite',
        content: JSON.stringify({
          version: 1,
          accounts: [
            {
              name: 'GitHub Updated',
              url: 'https://github.com/login',
              username: 'octo@example.test',
              password: PASSWORD,
              note: 'overwritten',
            },
          ],
        }),
      },
    })) as { updated: number };
    assert.equal(jsonUpdate.updated, 1);

    const dupImport = (await runtime.command('importAccounts', {
      input: {
        format: 'json',
        strategy: 'duplicate',
        content: [
          {
            name: 'GitHub Dup',
            url: 'https://github.com/login',
            username: 'octo@example.test',
            password: PASSWORD,
          },
        ],
      },
    })) as { imported: number };
    assert.equal(dupImport.imported, 1);

    // 3. togglePin 与 saveSelectors
    const listed = (await runtime.rpc('list', {}, { caller: 'ui' })) as { accounts: PublicAccount[] };
    assert.equal(listed.accounts.length, 3);
    const gitlab = listed.accounts.find((a) => a.name === 'GitLab')!;
    await runtime.command('togglePin', { input: { id: gitlab.id } });
    const afterPin = (await runtime.rpc('list', {}, { caller: 'ui' })) as { accounts: PublicAccount[] };
    assert.equal(afterPin.accounts[0]!.id, gitlab.id);
    assert.equal(afterPin.accounts[0]!.pinned, true);

    const saved = (await runtime.command('saveSelectors', {
      input: { id: gitlab.id, selectors: { username: '#user_login', submit: 'input[type=submit]' } },
    })) as { account: PublicAccount };
    assert.deepEqual(saved.account.selectors, { username: '#user_login', submit: 'input[type=submit]' });

    // 4. 回收站生命周期：trash -> list(onlyDeleted/includeDeleted) -> restore -> trash -> purge
    await runtime.command('trash', { input: { id: gitlab.id } });
    const activeOnly = (await runtime.command('list', { input: {} })) as { accounts: PublicAccount[] };
    assert.equal(
      activeOnly.accounts.some((a) => a.id === gitlab.id),
      false,
    );

    const deletedOnly = (await runtime.command('list', { input: { onlyDeleted: true } })) as {
      accounts: PublicAccount[];
    };
    assert.equal(deletedOnly.accounts.length, 1);
    assert.equal(deletedOnly.accounts[0]!.id, gitlab.id);
    assert.ok(deletedOnly.accounts[0]!.deletedAt);

    await runtime.command('restore', { input: { id: gitlab.id } });
    const restoredList = (await runtime.command('list', { input: {} })) as { accounts: PublicAccount[] };
    assert.equal(restoredList.accounts.length, 3);

    await runtime.command('trash', { input: { id: gitlab.id } });
    await runtime.command('purge', { input: { all: true } });
    const afterPurge = (await runtime.command('list', { input: { includeDeleted: true } })) as {
      accounts: PublicAccount[];
    };
    assert.equal(afterPurge.accounts.length, 2);
  });
});
