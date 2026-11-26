/**
 * 写操作门禁完整性断言。
 *
 * 直接从单一事实源 `RPC_REGISTRY` 验证：
 * 1. `browser.*` / `net.*` / `tab.*` 中仅白名单方法使用 `gate: 'read'`，其余强制走对应写/输入/弹窗/标签/自定义门禁；
 * 2. 所有非 `'read'` 的 `(browser|net).*` 方法在未持有或伪造 lease 时被 `dispatchRpc` 拒绝且不穿透至 controller；
 * 3. `findRpcMethods()` 与 `RPC_REGISTRY` 键集严格一致，不存在契约漂移。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchRpc, findRpcMethods, RPC_REGISTRY, type DispatchDeps } from '../src/main/rpc/registry.ts';

const READ_ONLY = new Set([
  'tab.list',
  'browser.snapshot',
  'browser.read',
  'browser.get',
  'browser.is',
  'browser.diff',
  'browser.screenshot',
  'browser.highlight',
  'browser.frame.list',
  'browser.webmcp.list',
  'browser.vitals',
  'browser.a11y',
  'browser.react',
  'browser.waitFor',
  'browser.waitForURL',
  'browser.waitForSelector',
  'browser.waitForFunction',
  'browser.waitForLoadState',
  'browser.waitForTimeout',
  'browser.waitForEvent',
  'browser.info',
  'browser.detectLoginFields',
  'browser.events',
  'browser.downloadStatus',
  'browser.console',
  'browser.network',
  'net.rules',
  'net.body',
  'net.hits',
]);

test('RPC_REGISTRY：所有 browser.*/net.*/tab.* 非只读端点必须声明非 read 门禁', () => {
  const gatedNames = Object.keys(RPC_REGISTRY).filter((name) => /^(browser|net|tab)\./.test(name));
  assert.ok(gatedNames.length >= 80, `应覆盖全部 browser/net/tab 端点，实际 ${gatedNames.length}`);

  const readDeclared = gatedNames.filter((name) => RPC_REGISTRY[name].gate === 'read');
  const unexpectedRead = readDeclared.filter((name) => !READ_ONLY.has(name));
  assert.deepEqual(unexpectedRead, [], `以下端点未在 READ_ONLY 中却使用了 gate=read：${unexpectedRead.join(', ')}`);

  for (const name of READ_ONLY) {
    assert.ok(name in RPC_REGISTRY, `READ_ONLY 含有无效方法：${name}`);
    assert.equal(RPC_REGISTRY[name].gate, 'read', `${name} 在 READ_ONLY 中但 gate 不是 read`);
  }

  for (const name of gatedNames) {
    if (READ_ONLY.has(name)) continue;
    const def = RPC_REGISTRY[name];
    if (name.startsWith('tab.')) {
      assert.equal(def.gate, 'tab', `${name} 应声明 gate=tab`);
    } else {
      assert.ok(
        ['write', 'input', 'dialog', 'custom'].includes(def.gate),
        `${name} 必须声明 write/input/dialog/custom 门禁，实际 ${def.gate}`,
      );
    }
  }
});

test('RPC_REGISTRY 与 RPC_METHODS / findRpcMethods 严格一致（零漂移）', () => {
  const registryKeys = Object.keys(RPC_REGISTRY).sort();
  const listedNames = findRpcMethods()
    .map((m) => m.name)
    .sort();
  assert.deepEqual(listedNames, registryKeys);
  assert.ok(registryKeys.includes('debug.layout'));
  assert.ok(registryKeys.includes('rpc.methods'));
});

function unleasedDeps(): { deps: DispatchDeps; touchedController: () => boolean } {
  let touched = false;
  const manager = {
    get: () => ({ id: 'env1', status: 'running' }),
    isDormant: () => false,
    wake: () => false,
    assertWritable: () => {
      throw new Error('lease required');
    },
    assertTabWritable: () => {
      throw new Error('tab lease required');
    },
    assertDialogWritable: () => {
      throw new Error('dialog lease required');
    },
    assertSpaceWritable: () => {
      throw new Error('lease required');
    },
    withInputContext: async <T>(_id: string, _space: unknown, _tab: unknown, fn: () => Promise<T>) => fn(),
    controllerFor: () => {
      touched = true;
      throw new Error('should not reach controller');
    },
    listTabs: () => [],
  } as unknown as DispatchDeps['manager'];

  const deps: DispatchDeps = {
    manager,
    store: {} as DispatchDeps['store'],
    vault: {} as DispatchDeps['vault'],
    saveVault: async () => {},
    plugins: {} as DispatchDeps['plugins'],
    isPackaged: false,
    quit: () => {},
  };
  return { deps, touchedController: () => touched };
}

test('运行时阻断：所有声明 write/input/dialog 门禁的 browser/net 端点在无 lease 时拒绝且不触达 controller', async () => {
  const protectedMethods = Object.entries(RPC_REGISTRY)
    .filter(
      ([name, def]) =>
        /^(browser|net)\./.test(name) && (def.gate === 'write' || def.gate === 'input' || def.gate === 'dialog'),
    )
    .map(([name]) => name);

  for (const method of protectedMethods) {
    const { deps, touchedController } = unleasedDeps();
    await assert.rejects(() => dispatchRpc(deps, method, { id: 'env1', tabId: 1 }), /lease required/);
    assert.equal(touchedController(), false, `${method} 不得在校验 lease 前获取 controller`);
  }
});
