import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestPluginHost } from './helpers/plugin-host.ts';

test('PluginHost 能从 path 包安装、启用、运行、更新、卸载', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'warren-plugin-host-'));
  const { host, cleanup } = createTestPluginHost(root);

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
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
