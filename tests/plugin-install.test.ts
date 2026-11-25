import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabases, openDatabase } from '../src/main/db.ts';
import { PluginHost } from '../src/main/plugins/host.ts';

test('PluginHost 能从 path 包安装、启用、运行、更新、卸载', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'warren-plugin-host-'));
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
  });

  try {
    await host.load();
    const installed = await host.install('path:plugins/account-manager');
    assert.equal(installed.id, 'com.warren.accounts');
    assert.equal(installed.packageName, 'warren-plugin-account-manager');
    assert.equal(installed.enabled, false);
    assert.match(installed.source, /^path:/);

    await host.enable(installed.id);
    const output = (await host.run(installed.id, 'list', { environmentId: '', input: {} })) as {
      result: { accounts: unknown[] };
    };
    assert.deepEqual(output.result.accounts, []);

    const updated = await host.update(installed.id);
    assert.equal(updated.enabled, true);
    assert.equal(updated.status, 'running');

    await host.uninstall(installed.id);
    assert.deepEqual(await host.list(), []);
  } finally {
    closeDatabases();
    await rm(root, { recursive: true, force: true });
  }
});
