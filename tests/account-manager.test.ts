import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/main/db.ts';
import { buildHostApi, createHandlers } from '../src/main/plugins/api.ts';
import { SandboxRuntime } from '../src/main/plugins/runtime.ts';
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

/**
 * 把插件后端跑起来，并记录它真的填了什么。
 *
 * `manager` 只实现被走到的那几个方法：这条测试要证明的是「值有没有出插件」，
 * 不是「输入准备做得对不对」（那条在 `tests/rpc-dispatch.test.ts`）。
 */
async function withPlugin(run: (runtime: SandboxRuntime, fills: FillCall[]) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-accounts-'));
  const storage = new PluginStorage({
    dir,
    pluginId: 'com.warren.accounts',
    db: openDatabase(':memory:'),
  });
  const fills: FillCall[] = [];
  let runtime: SandboxRuntime | undefined;
  try {
    await storage.load();
    const handlers = createHandlers({
      pluginId: 'com.warren.accounts',
      currentEnvironmentId: () => ENV,
      require: () => undefined,
      manager: {
        assertWritable: () => ({ leaseId: 'lease' }),
        controllerFor: () => ({
          currentUrl: () => 'https://example.test/login',
          fill: async (target: unknown, value: string) => {
            fills.push({ target, value });
          },
        }),
        ensureOperable: () => true,
        detachOperable: () => undefined,
        assertInputOnScreen: () => undefined,
        assertActiveTab: () => undefined,
        focusForInput: async () => undefined,
        prepareBackgroundInput: async () => false,
        clearBackgroundInput: async () => undefined,
      } as never,
      vault: { available: false, list: () => [], reveal: () => ({}), add: () => ({ ref: '' }), remove: () => true },
      storage,
      settings: { get: () => ({}) } as never,
      descriptors: [],
      record: () => undefined,
      log: () => undefined,
      signal: () => undefined,
      withLease: async (_env, fn) => fn('lease'),
    });
    runtime = new SandboxRuntime({
      pluginId: 'com.warren.accounts',
      entryPath: path.join(PLUGIN_DIR, 'server.js'),
      code: await readFile(path.join(PLUGIN_DIR, 'server.js'), 'utf8'),
      host: buildHostApi(handlers),
      log: () => undefined,
    });
    await runtime.start();
    await run(runtime, fills);
  } finally {
    await runtime?.dispose();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

interface PublicAccount {
  id: number;
  username: string;
  usernameHint: string;
  hasPassword: boolean;
  note: string;
}

async function createFixture(runtime: SandboxRuntime): Promise<PublicAccount> {
  await runtime.command('create', {
    input: {
      name: '测试后台',
      url: 'http://127.0.0.1:8899/login.html',
      username: 'tester@example.test',
      password: PASSWORD,
      note: '只用于本地 fixture',
      tags: 'local,fixture',
    },
  });
  const list = (await runtime.command('list', { input: {} })) as { accounts: PublicAccount[] };
  assert.equal(list.accounts.length, 1);
  return list.accounts[0]!;
}

test('账号管理插件：明文新增、搜索、改备注、删除', async () => {
  await withPlugin(async (runtime) => {
    const account = await createFixture(runtime);
    assert.equal(account.note, '只用于本地 fixture');

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

test('list / get 不返回明文，只给 hasPassword 与打码用户名', async () => {
  await withPlugin(async (runtime) => {
    const account = await createFixture(runtime);

    assert.equal('password' in account, false, 'list 不能带 password 字段');
    assert.equal(account.hasPassword, true);
    // 打码规则来自宿主的 vault.maskHint：首字符 + 域名
    assert.equal(account.usernameHint, 't***@example.test');

    const viaList = (await runtime.rpc('list', {}, {})) as { accounts: PublicAccount[] };
    assert.equal(JSON.stringify(viaList).includes(PASSWORD.trim()), false, '序列化后的 list 不能出现密码原文');

    const got = (await runtime.rpc('get', { id: account.id }, {})) as { account: PublicAccount };
    assert.equal('password' in got.account, false, 'get 同样不能带 password');
    assert.equal(JSON.stringify(got).includes(PASSWORD.trim()), false);
  });
});

test('export 没有 confirm 直接拒绝，带 confirm 才给明文（人工备份）', async () => {
  await withPlugin(async (runtime) => {
    const account = await createFixture(runtime);

    await assert.rejects(
      () => runtime.command('export', { input: {} }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'ACCOUNT_EXPORT_CONFIRM_REQUIRED');
        return true;
      },
    );
    await assert.rejects(
      () => runtime.rpc('export', {}, {}),
      (error: Error & { code?: string }) => error.code === 'ACCOUNT_EXPORT_CONFIRM_REQUIRED',
    );

    const exported = (await runtime.command('export', { input: { confirm: 'plaintext' } })) as {
      accounts: Array<{ id: number; password: string }>;
    };
    // 导出是明确的人工备份通道：值要原样（密码首尾空格也是密码的一部分）
    assert.equal(exported.accounts[0]!.password, PASSWORD);
    assert.equal(exported.accounts[0]!.id, account.id);
  });
});

test('reveal 只对插件界面开放：agent 通道报 ACCOUNT_REVEAL_UI_ONLY', async () => {
  await withPlugin(async (runtime) => {
    const account = await createFixture(runtime);

    await assert.rejects(
      () => runtime.rpc('reveal', { id: account.id, field: 'password' }, { caller: 'agent' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'ACCOUNT_REVEAL_UI_ONLY');
        return true;
      },
    );
    // 不带 caller 也按 agent 处理：漏传只能更保守，不能更宽松
    await assert.rejects(
      () => runtime.rpc('reveal', { id: account.id, field: 'password' }, {}),
      (error: Error & { code?: string }) => error.code === 'ACCOUNT_REVEAL_UI_ONLY',
    );

    const revealed = (await runtime.rpc('reveal', { id: account.id, field: 'password' }, { caller: 'ui' })) as {
      value: string;
    };
    assert.equal(revealed.value, PASSWORD);
  });
});

test('fill 把值送进页面，返回体不含值', async () => {
  await withPlugin(async (runtime, fills) => {
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

    // sandbox 里的对象来自另一个 realm，原型不同，只能比序列化后的形状
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
