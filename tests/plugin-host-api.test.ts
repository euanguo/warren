import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchHostRead } from '../src/main/plugins/host-read.ts';
import { PLUGIN_HOST_READ_METHODS, isPluginHostReadMethod } from '../src/shared/plugin-host-api.ts';

function deps(overrides: { granted?: string[]; list?: unknown[]; get?: unknown; controller?: unknown } = {}) {
  const granted = new Set(overrides.granted ?? ['environment.read', 'browser.dom.read']);
  return {
    require: (permission: string) => {
      if (!granted.has(permission)) {
        throw Object.assign(new Error(`没有 ${permission}`), { code: 'PLUGIN_PERMISSION_DENIED' });
      }
    },
    manager: {
      list: () => overrides.list ?? [],
      get: () => overrides.get,
      controllerFor: () =>
        overrides.controller ?? { currentUrl: () => 'https://example.test/', title: async () => '标题' },
    },
  } as never;
}

test('宿主只读白名单里没有写路径、secret 路径和插件数据路径', () => {
  assert.deepEqual(
    [...PLUGIN_HOST_READ_METHODS],
    ['environment.list', 'environment.get', 'environment.activeContext', 'browser.info'],
  );
  for (const forbidden of [
    'settings.get',
    'vault.listRefs',
    'storage.kv.set',
    'storage.sql.query',
    'environment.update',
    'browser.navigate',
    'browser.snapshot',
  ]) {
    assert.equal(isPluginHostReadMethod(forbidden), false, forbidden);
  }
});

test('environment.list 返回窄 DTO：没有 leaseId / storagePath / tabs', async () => {
  const result = await dispatchHostRead(
    deps({
      list: [
        {
          id: 'a',
          name: 'A',
          status: 'running',
          owner: 'none',
          proxy: 'http://127.0.0.1:8899',
          leaseId: 'lease-a',
          leaseExpiresAt: 123,
          storagePath: '/tmp/secret',
          tabs: [{ id: 't1', title: '页面' }],
        },
      ],
    }),
    'environment.list',
    undefined,
    [],
  );
  assert.deepEqual(result, [{ id: 'a', name: 'A', status: 'running', owner: 'none', proxy: 'http://127.0.0.1:8899' }]);
});

test('environment.get 对未知 id 返回 null；browser.info 必须显式带环境', async () => {
  assert.equal(await dispatchHostRead(deps(), 'environment.get', undefined, ['missing']), null);
  await assert.rejects(
    () => dispatchHostRead(deps(), 'browser.info', undefined, []),
    (error: Error & { code?: string }) => error.code === 'PLUGIN_NO_ENVIRONMENT',
  );
  assert.deepEqual(await dispatchHostRead(deps(), 'browser.info', 'a', []), {
    url: 'https://example.test/',
    title: '标题',
  });
});

test('白名单外的已知 host API 直接拒绝；权限不足也拒绝', async () => {
  await assert.rejects(
    () => dispatchHostRead(deps(), 'settings.get', undefined, []),
    (error: Error & { code?: string }) => error.code === 'PLUGIN_HOST_METHOD_UNKNOWN',
  );
  await assert.rejects(
    () => dispatchHostRead(deps({ granted: [] }), 'environment.list', undefined, []),
    (error: Error & { code?: string }) => error.code === 'PLUGIN_PERMISSION_DENIED',
  );
});
