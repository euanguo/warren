import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanupPreparedPlugin, parsePluginSource, preparePluginSource } from '../src/main/plugins/source.ts';

test('安装源只认 path / npm / git 三种协议；裸目录按 path 处理', () => {
  assert.deepEqual(parsePluginSource('path:plugins/account-manager'), {
    kind: 'path',
    value: 'plugins/account-manager',
    raw: 'path:plugins/account-manager',
  });
  assert.deepEqual(parsePluginSource('npm:warren-plugin-whistle@^0.3.0'), {
    kind: 'npm',
    value: 'warren-plugin-whistle@^0.3.0',
    raw: 'npm:warren-plugin-whistle@^0.3.0',
  });
  assert.deepEqual(parsePluginSource('git:https://example.test/plugin.git#v1'), {
    kind: 'git',
    value: 'https://example.test/plugin.git#v1',
    raw: 'git:https://example.test/plugin.git#v1',
  });
  assert.deepEqual(parsePluginSource('plugins/account-manager'), {
    kind: 'path',
    value: 'plugins/account-manager',
    raw: 'path:plugins/account-manager',
  });
});

test('path 安装先 npm pack 再校验 package.json#warren', async () => {
  const staging = await mkdtemp(path.join(tmpdir(), 'warren-source-'));
  try {
    const prepared = await preparePluginSource('path:plugins/account-manager', staging);
    try {
      assert.equal(prepared.package.id, 'com.warren.accounts');
      assert.equal(prepared.package.packageName, 'warren-plugin-account-manager');
      assert.equal(prepared.package.server, 'server.js');
      assert.equal(
        JSON.parse(await readFile(path.join(prepared.dir, 'package.json'), 'utf8')).warren.id,
        'com.warren.accounts',
      );
      assert.equal(await readFile(path.join(prepared.dir, 'app.js'), 'utf8').then(() => true), true);
    } finally {
      await cleanupPreparedPlugin(prepared);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test('缺 package.json#warren 的包被拒绝', async () => {
  const staging = await mkdtemp(path.join(tmpdir(), 'warren-source-'));
  const source = path.join(staging, 'bad');
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'warren-plugin-bad', version: '1.0.0' }));
    await assert.rejects(
      () => preparePluginSource(`path:${source}`, path.join(staging, 'staging')),
      (error: Error & { code?: string }) => error.code === 'PLUGIN_PACKAGE_INVALID',
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test('git 来源会 clone、pack 并记录 commit', async () => {
  if (!execFileSync('git', ['--version'], { encoding: 'utf8' }).includes('git version')) {
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'warren-source-git-'));
  const source = path.join(root, 'repo');
  try {
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: 'warren-plugin-git-smoke',
        version: '0.1.0',
        warren: {
          id: 'com.test.gitplugin',
          name: 'Git Smoke',
          apiVersion: '4',
          runtime: 'sandbox',
          server: 'server.js',
          permissions: [],
          contributes: {},
        },
      }),
    );
    await writeFile(path.join(source, 'server.js'), 'module.exports = { hello() { return "ok"; } };\n');
    execFileSync('git', ['init', '-q'], { cwd: source });
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'init'], {
      cwd: source,
    });
    const prepared = await preparePluginSource(`git:file://${source}`, path.join(root, 'stage'));
    try {
      assert.equal(prepared.package.id, 'com.test.gitplugin');
      assert.match(prepared.resolved, /^[0-9a-f]{40}$/);
    } finally {
      await cleanupPreparedPlugin(prepared);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
