import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashPluginDir, isRuntimeFile } from '../src/main/plugins/installer.ts';
import { createTestPluginHost } from './helpers/plugin-host.ts';

async function writePlugin(
  dir: string,
  options: {
    id: string;
    delayMs?: number;
    serverCode?: string;
    rpcMethods?: string[];
  },
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const delayMs = options.delayMs ?? 0;
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: `warren-plugin-${options.id.split('.').at(-1)}`,
      version: '0.1.0',
      files: ['server.js'],
      warren: {
        id: options.id,
        name: options.id,
        apiVersion: '4',
        runtime: 'sandbox',
        server: 'server.js',
        permissions: ['rpc.serve'],
        contributes: {
          commands: [{ name: 'ping', summary: 'ping' }],
          rpc: options.rpcMethods ?? ['ping'],
        },
      },
    }),
  );
  await writeFile(
    path.join(dir, 'server.js'),
    options.serverCode ??
      `module.exports = {
        async activate() {
          if (${delayMs} > 0) await new Promise((r) => setTimeout(r, ${delayMs}));
        },
        async ping() { return { id: ${JSON.stringify(options.id)} }; },
        rpc: {
          async ping() { return { id: ${JSON.stringify(options.id)} }; },
        },
      };`,
  );
}

test('PluginHost 两阶段加载：loadState 秒返 starting，activateEnabled 后台并发且 waitReady 透明插队', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-plugin-startup-'));
  const src1 = path.join(root, 'src-p1');
  const src2 = path.join(root, 'src-p2');
  const src3 = path.join(root, 'src-p3');

  // 先用第一个宿主安装并启用 3 个插件，落盘到 warren.db
  const setup = createTestPluginHost(root);
  try {
    await writePlugin(src1, { id: 'com.test.p1', delayMs: 280 });
    await writePlugin(src2, { id: 'com.test.p2', delayMs: 280 });
    await writePlugin(src3, { id: 'com.test.p3', delayMs: 10 });
    await setup.host.load();
    for (const [src, id] of [
      [src1, 'com.test.p1'],
      [src2, 'com.test.p2'],
      [src3, 'com.test.p3'],
    ] as const) {
      await setup.host.install(`path:${src}`);
      await setup.host.enable(id);
    }
  } finally {
    await setup.cleanup();
  }

  // 模拟应用重启：先 loadState()，再后台 activateEnabled({ concurrency: 1, notify: true })
  let notifyCount = 0;
  const boot = createTestPluginHost(root, {
    onChange: () => {
      notifyCount += 1;
    },
  });
  try {
    const t0 = Date.now();
    await boot.host.loadState();
    const loadStateMs = Date.now() - t0;
    assert.ok(loadStateMs < 150, `loadState 应毫秒级完成，实际 ${loadStateMs}ms`);
    assert.equal(boot.host.statusOf('com.test.p1').status, 'starting');
    assert.equal(boot.host.statusOf('com.test.p2').status, 'starting');
    assert.equal(boot.host.statusOf('com.test.p3').status, 'starting');

    const bg = boot.host.activateEnabled({ concurrency: 1, notify: true });

    // p3 排在 concurrency=1 队列末尾，主动调 rpc('com.test.p3') 必须触发插队并在慢插件 p1+p2 前返回
    const promotedStart = Date.now();
    const p3Res = await boot.host.rpc('com.test.p3', 'ping', {}, { caller: 'ui' });
    const p3Ms = Date.now() - promotedStart;
    assert.equal(p3Res.ok, true);
    assert.deepEqual(p3Res.result, { id: 'com.test.p3' });
    assert.ok(p3Ms < 500, `插队激活 p3 不应被 p1+p2 串行阻塞，实际 ${p3Ms}ms`);

    // 对正在激活中的 p1 调 run 应透明等待，而不是报 PLUGIN_NOT_ACTIVE
    const p1Res = await boot.host.run('com.test.p1', 'ping', { environmentId: '' });
    assert.deepEqual(p1Res.result, { id: 'com.test.p1' });

    await bg;
    assert.equal(boot.host.statusOf('com.test.p1').status, 'running');
    assert.equal(boot.host.statusOf('com.test.p2').status, 'running');
    assert.equal(boot.host.statusOf('com.test.p3').status, 'running');
    assert.ok(notifyCount >= 1 && notifyCount <= 3, `批次广播应合并收敛，实际 ${notifyCount} 次`);
  } finally {
    await boot.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('PluginLifecycle：后台激活中途 disable 或 dispose 时通过 epoch 阻止孤儿实例回写', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-plugin-cancel-'));
  const srcSlow1 = path.join(root, 'src-slow1');
  const srcSlow2 = path.join(root, 'src-slow2');

  const setup = createTestPluginHost(root);
  try {
    await writePlugin(srcSlow1, { id: 'com.test.slow1', delayMs: 260 });
    await writePlugin(srcSlow2, { id: 'com.test.slow2', delayMs: 260 });
    await setup.host.load();
    await setup.host.install(`path:${srcSlow1}`);
    await setup.host.enable('com.test.slow1');
    await setup.host.install(`path:${srcSlow2}`);
    await setup.host.enable('com.test.slow2');
  } finally {
    await setup.cleanup();
  }

  const boot = createTestPluginHost(root);
  try {
    await boot.host.loadState();
    const bg = boot.host.activateEnabled({ concurrency: 2 });
    // 在 slow1 激活半途停用它：disable 必须等旧任务取消回收，且状态停在 disabled
    await new Promise((r) => setTimeout(r, 40));
    await boot.host.disable('com.test.slow1');
    assert.equal(boot.host.statusOf('com.test.slow1').status, 'disabled');
    const rpcDisabled = await boot.host.rpc('com.test.slow1', 'ping', {}, { caller: 'ui' });
    assert.equal(rpcDisabled.ok, false);
    assert.equal(rpcDisabled.code, 'PLUGIN_DISABLED');

    // 在 slow2 尚未或刚刚完成时 dispose 整个宿主：不应抛错或残留孤儿进程
    await boot.host.dispose();
    await bg;
    assert.equal(boot.host.statusOf('com.test.slow1').status, 'disabled');
  } finally {
    await boot.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('hashPluginDir 并发读盘结果与串行参考算法字节级等价，并跳过 node_modules 与运行时库', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-hash-dir-'));
  try {
    await mkdir(path.join(root, 'ui', 'nested'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"name":"demo"}');
    await writeFile(path.join(root, 'server.js'), 'module.exports = {};');
    await writeFile(path.join(root, 'ui', 'a.js'), 'export const a = 1;');
    await writeFile(path.join(root, 'ui', 'nested', 'b.js'), 'export const b = 2;');
    await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'ignored');
    await writeFile(path.join(root, 'data.db'), 'runtime-sqlite');
    await writeFile(path.join(root, 'data.db-wal'), 'runtime-wal');

    const referenceHash = async (dir: string): Promise<string> => {
      const hash = createHash('sha256');
      const walk = async (current: string, prefix: string): Promise<void> => {
        const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            await walk(path.join(current, entry.name), relative);
            continue;
          }
          if (isRuntimeFile(entry.name)) continue;
          hash.update(relative);
          hash.update(await readFile(path.join(current, entry.name)));
        }
      };
      await walk(dir, '');
      return hash.digest('hex');
    };

    const expected = await referenceHash(root);
    const actual = await hashPluginDir(root);
    assert.equal(actual, expected);

    // 改 ignored 文件不影响摘要；改代码文件必须改变摘要
    await writeFile(path.join(root, 'data.db'), 'changed-runtime-data');
    await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'changed-dep');
    assert.equal(await hashPluginDir(root), expected);

    await writeFile(path.join(root, 'ui', 'nested', 'b.js'), 'export const b = 3;');
    assert.notEqual(await hashPluginDir(root), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main.ts 启动序不变量：loadState 与 registerIpcRoutes 位于主窗 loadMainWindow 之前，插件激活非阻塞后置', async () => {
  const source = await readFile(path.resolve('src/main/main.ts'), 'utf8');
  const loadStateAt = source.indexOf('await plugins.loadState()');
  const registerIpcAt = source.indexOf('registerIpcRoutes({');
  const loadWindowAt = source.indexOf('loadMainWindow(window)');
  const activateEnabledAt = source.indexOf('.activateEnabled({ notify: true })');

  assert.ok(loadStateAt > 0, '缺少 plugins.loadState()');
  assert.ok(registerIpcAt > loadStateAt, 'registerIpcRoutes 必须在 plugins.loadState() 之后');
  assert.ok(loadWindowAt > registerIpcAt, 'loadMainWindow(window) 必须在 registerIpcRoutes 之后以消除 IPC 竞态');
  assert.ok(activateEnabledAt > loadWindowAt, 'plugins.activateEnabled 必须在主窗口加载之后后台执行');
  assert.equal(source.includes('await plugins.load()'), false, '主进程启动链路禁止再同步阻塞等待 plugins.load()');
});
