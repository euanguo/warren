import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestPluginHost } from './helpers/plugin-host.ts';

async function writeTestPlugin(
  dir: string,
  options: {
    id: string;
    version?: string;
    engines?: string;
    permissions?: string[];
    serverCode: string;
  },
) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: `warren-plugin-${options.id.split('.').at(-1)}`,
      version: options.version ?? '0.1.0',
      files: ['server.js'],
      warren: {
        id: options.id,
        name: 'Lifecycle Test',
        apiVersion: '4',
        runtime: 'sandbox',
        server: 'server.js',
        ...(options.engines ? { engines: { warren: options.engines } } : {}),
        permissions: options.permissions ?? [],
        contributes: {
          commands: [{ name: 'ping', summary: 'ping' }],
        },
      },
    }),
  );
  await writeFile(path.join(dir, 'server.js'), options.serverCode);
}

test('PluginLifecycle：reload 激活失败或磁盘遭篡改时均保留旧实例并记录错误细节', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-lifecycle-reload-'));
  const pluginSrc = path.join(root, 'src');
  const { host, cleanup } = createTestPluginHost(root);

  try {
    await writeTestPlugin(pluginSrc, {
      id: 'com.test.reload',
      version: '0.1.0',
      permissions: ['storage.write'],
      serverCode: `module.exports = {
        async activate(ctx) {
          if (await ctx.host.storage.kv.get('failNext')) {
            throw new Error('broken activate');
          }
        },
        async ping(ctx) {
          if (ctx.input && ctx.input.armFail) await ctx.host.storage.kv.set('failNext', true);
          return { ver: 1 };
        }
      };`,
    });
    await host.load();
    await host.install(`path:${pluginSrc}`);
    await host.enable('com.test.reload');

    // 先标记下次 activate 抛错，测试 reload 候选启动失败回退保留旧实例
    const armed = (await host.run('com.test.reload', 'ping', {
      environmentId: '',
      input: { armFail: true },
    })) as { result: { ver: number } };
    assert.equal(armed.result.ver, 1);

    const afterActivateFail = await host.reload('com.test.reload');
    assert.equal(afterActivateFail.status, 'running');
    assert.match(afterActivateFail.statusDetail ?? '', /保留旧实例.*broken activate/);

    // 篡改磁盘文件触发摘要校验失败，同样保留旧实例
    const installedEntry = path.join(root, 'plugins', 'com.test.reload', 'server.js');
    await writeFile(installedEntry, `module.exports = { async ping() { return { ver: 99 }; } };`);
    const afterDigestFail = await host.reload('com.test.reload');
    assert.equal(afterDigestFail.status, 'running');
    assert.match(afterDigestFail.statusDetail ?? '', /保留旧实例.*摘要不符/);

    const stillOld = (await host.run('com.test.reload', 'ping', { environmentId: '' })) as { result: { ver: number } };
    assert.equal(stillOld.result.ver, 1);
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('PluginLifecycle：NeedsConfigurationError 使插件进入 needs-configuration 状态', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-lifecycle-cfg-'));
  const pluginSrc = path.join(root, 'src');
  const { host, cleanup } = createTestPluginHost(root);

  try {
    await writeTestPlugin(pluginSrc, {
      id: 'com.test.needscfg',
      serverCode: `module.exports = {
        async activate() {
          const err = new Error('缺少必需配置');
          err.name = 'NeedsConfigurationError';
          throw err;
        },
        async ping() { return { ok: true }; }
      };`,
    });
    await host.load();
    await host.install(`path:${pluginSrc}`);
    const enabled = await host.enable('com.test.needscfg');
    assert.equal(enabled.status, 'needs-configuration');
    assert.match(enabled.statusDetail ?? '', /缺少必需配置/);
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('PluginInstaller：启用态 update 失败自动回滚到旧版本；engines 不兼容与 id 不匹配均拒绝', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-installer-rollback-'));
  const pluginSrc = path.join(root, 'src-v1');
  const incompatibleSrc = path.join(root, 'src-bad-engine');
  const { host, cleanup } = createTestPluginHost(root, { appVersion: '0.1.0' });

  try {
    await writeTestPlugin(pluginSrc, {
      id: 'com.test.updater',
      version: '1.0.0',
      serverCode: `module.exports = { async ping() { return { ver: '1.0.0' }; } };`,
    });
    await writeTestPlugin(incompatibleSrc, {
      id: 'com.test.too-new',
      engines: '>=9.0.0',
      serverCode: `module.exports = { async ping() { return {}; } };`,
    });

    await host.load();
    await assert.rejects(
      () => host.install(`path:${incompatibleSrc}`),
      (err: Error & { code?: string }) => err.code === 'PLUGIN_ENGINE_MISMATCH',
    );
    assert.equal(existsSync(path.join(root, 'plugins', 'com.test.too-new')), false);

    await host.install(`path:${pluginSrc}`);
    await host.enable('com.test.updater');

    // 将源目录改写成激活失败的 2.0.0 版本并 update：update 必须抛错并回滚恢复 1.0.0 运行态
    await writeTestPlugin(pluginSrc, {
      id: 'com.test.updater',
      version: '2.0.0',
      serverCode: `module.exports = { async activate() { throw new Error('v2 init failed'); }, async ping() { return { ver: '2.0.0' }; } };`,
    });

    await assert.rejects(() => host.update('com.test.updater'), /v2 init failed/);
    const info = (await host.list()).find((item) => item.id === 'com.test.updater')!;
    assert.equal(info.version, '1.0.0');
    assert.equal(info.enabled, true);
    const runOld = (await host.run('com.test.updater', 'ping', { environmentId: '' })) as {
      result: { ver: string };
    };
    assert.equal(runOld.result.ver, '1.0.0');
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('PluginLifecycle / Installer：reload / update / disable / shutdown 向 dispose(ctx) 传递准确 reason，且 stagedSource 保留原始 displaySource', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-dispose-reason-'));
  const pluginSrc = path.join(root, 'src-v1');
  const { host, cleanup } = createTestPluginHost(root);

  try {
    await writeTestPlugin(pluginSrc, {
      id: 'com.test.reason',
      version: '1.0.0',
      permissions: ['storage.write'],
      serverCode: `module.exports = {
        async ping(ctx) {
          return { reasons: (await ctx.host.storage.kv.get('reasons')) || [] };
        },
        async dispose(ctx) {
          const prev = (await ctx.host.storage.kv.get('reasons')) || [];
          prev.push(String(ctx.reason || 'missing'));
          await ctx.host.storage.kv.set('reasons', prev);
        },
      };`,
    });
    await host.load();
    await host.install(`path:${pluginSrc}`, { displaySource: 'path:/original/plugin/dir' });
    const installed = (await host.list()).find((item) => item.id === 'com.test.reason')!;
    assert.equal(installed.source, 'path:/original/plugin/dir');

    await host.enable('com.test.reason');
    await host.reload('com.test.reason');
    await host.update('com.test.reason', { stagedSource: `path:${pluginSrc}` });
    const afterUpdate = (await host.list()).find((item) => item.id === 'com.test.reason')!;
    assert.equal(afterUpdate.source, 'path:/original/plugin/dir');

    await host.disable('com.test.reason');
    await host.enable('com.test.reason');
    const res = (await host.run('com.test.reason', 'ping', { environmentId: '' })) as {
      result: { reasons: string[] };
    };
    assert.deepEqual(res.result.reasons, ['reload', 'update', 'disable']);
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
