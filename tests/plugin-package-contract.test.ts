import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS, tierOf } from '../src/shared/permissions.ts';
import { diffPermissions, needsUserConfirmation, validatePluginPackage } from '../src/main/plugins/package.ts';

const base = {
  name: 'warren-plugin-login',
  version: '0.1.0',
  description: '登录插件',
  warren: {
    id: 'com.example.login',
    name: 'Example Login',
    apiVersion: '4',
    runtime: 'sandbox',
    server: 'server.js',
    permissions: ['browser.dom.read', 'browser.navigate'],
  },
};

test('valid package passes and keeps declared permissions', () => {
  const result = validatePluginPackage(base);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.package?.packageName, 'warren-plugin-login');
  assert.equal(result.package?.server, 'server.js');
  assert.deepEqual(result.package?.permissions, ['browser.dom.read', 'browser.navigate']);
  assert.deepEqual(result.downgraded, []);
});

test('declaring a denied permission silently downgrades instead of granting it', () => {
  const result = validatePluginPackage({
    ...base,
    warren: {
      ...base.warren,
      permissions: [...base.warren.permissions, 'storage.cookie.read', 'process.spawn'],
    },
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.package?.permissions, ['browser.dom.read', 'browser.navigate']);
  assert.deepEqual(result.downgraded, ['storage.cookie.read', 'process.spawn']);
});

test('unknown permission is a hard error', () => {
  const result = validatePluginPackage({
    ...base,
    warren: { ...base.warren, permissions: ['browser.teleport'] },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /未知权限/);
});

test('entry paths cannot escape the package directory', () => {
  for (const server of ['../../evil.js', '/etc/passwd', 'a/../../b.js', 'C:\\evil.js']) {
    const result = validatePluginPackage({ ...base, warren: { ...base.warren, server } });
    assert.equal(result.ok, false, `server 应被拒绝: ${server}`);
  }
});

test('apiVersion is v4 only and identity is validated', () => {
  for (const apiVersion of ['1', '2', '3', '9']) {
    assert.equal(
      validatePluginPackage({ ...base, warren: { ...base.warren, apiVersion } }).ok,
      false,
      `apiVersion ${apiVersion} 应被拒绝`,
    );
  }
  assert.equal(validatePluginPackage({ ...base, warren: { ...base.warren, id: 'Bad Id' } }).ok, false);
  assert.equal(validatePluginPackage({ ...base, version: 'v1' }).ok, false);
  assert.equal(validatePluginPackage({ ...base, name: 'Bad Package' }).ok, false);
});

test('sandbox and host entries are exclusive', () => {
  const host = {
    ...base,
    warren: {
      ...base.warren,
      runtime: 'host',
      server: undefined,
      host: 'host.mjs',
    },
  };
  assert.equal(validatePluginPackage(host).ok, true);
  assert.equal(validatePluginPackage({ ...host, warren: { ...host.warren, server: 'server.js' } }).ok, false);
  assert.equal(validatePluginPackage({ ...base, warren: { ...base.warren, host: 'host.mjs' } }).ok, false);
});

test('permission tiers and confirmation list', () => {
  assert.equal(PERMISSIONS.length, 19);
  assert.equal(tierOf('environment.read'), 'granted');
  assert.equal(tierOf('vault.fill'), 'confirm');
  assert.equal(tierOf('events.subscribe'), 'confirm');
  for (const denied of [
    'storage.cookie.read',
    'storage.cookie.write',
    'browser.evaluate',
    'process.spawn',
    'filesystem.read',
  ]) {
    assert.equal(tierOf(denied), 'denied', `${denied} 必须严格留在 denied 层`);
  }
  assert.deepEqual(needsUserConfirmation(['environment.read', 'vault.fill', 'browser.navigate', 'events.subscribe']), [
    'vault.fill',
    'browser.navigate',
    'events.subscribe',
  ]);
});

test('new surface kinds popover, commandBarAction, and statusBadge pass package validation', () => {
  const result = validatePluginPackage({
    ...base,
    warren: {
      ...base.warren,
      permissions: [...base.warren.permissions, 'ui.mount'],
      contributes: {
        surfaces: [
          { kind: 'popover', id: 'quick-panel', title: '快捷浮卡' },
          { kind: 'commandBarAction', id: 'quick-action', title: '命令栏动作', command: 'run' },
          { kind: 'statusBadge', id: 'live-status', title: '状态微标' },
        ],
      },
    },
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(
    result.package?.contributes.surfaces.map((item) => item.kind),
    ['popover', 'commandBarAction', 'statusBadge'],
  );
});

test('permission diff reports what an upgrade would add', () => {
  const before = validatePluginPackage(base).package!.permissions;
  const after = validatePluginPackage({
    ...base,
    warren: { ...base.warren, permissions: [...base.warren.permissions, 'vault.fill'] },
  }).package!.permissions;
  assert.deepEqual(diffPermissions(before, after), { added: ['vault.fill'], removed: [] });
});

/**
 * 只在 `contributes.rpc` 里、没进 `contributes.commands` 的方法，agent 用
 * `warren plugin run <id> --help` 看不到，只能 `warren call plugin.rpc` 绕一层
 * （审计：`rules / ruleSet / ruleToggle / ruleRemove / unbind` 就是这样漏的）。
 *
 * 豁免表只放「本来就不给 agent 用」的方法，每条写清原因。
 */
const INTERNAL_RPC: Record<string, string[]> = {
  // 账号插件：`get` 是 UI 详情视图，agent 侧走 list（WP1 会保留 rpc.get）。
  // `reveal` 是插件自己 UI surface 专用的明文出口，`totpCode` 是 UI 专用的动态验证码倒计时出口，agent 调用必须被拒。
  'com.warren.accounts': ['get', 'reveal', 'totpCode'],
  // 示例插件：统计只给面板用。
  'com.example.notes': ['stats'],
};

const pluginManifests = () =>
  readdirSync(join(import.meta.dirname, '..', 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(import.meta.dirname, '..', 'plugins', entry.name, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')));

test('rpc 方法必须注册成命令，或在 internalRpc 豁免表里', () => {
  const manifests = pluginManifests();
  assert.ok(manifests.length >= 5, '插件清单没扫到，断言会空转');
  const violations: string[] = [];
  for (const manifest of manifests) {
    const warren = manifest.warren ?? {};
    const commands = new Set<string>((warren.contributes?.commands ?? []).map((item: { name: string }) => item.name));
    const exempt = new Set(INTERNAL_RPC[warren.id] ?? []);
    for (const method of warren.contributes?.rpc ?? []) {
      if (!commands.has(method) && !exempt.has(method)) violations.push(`${warren.id}: ${method}`);
    }
  }
  assert.deepEqual(violations, [], `这些 rpc 方法 agent 看不到，也没有豁免理由: ${violations.join(', ')}`);
});

test('Whistle 插件的规则组命令对 agent 可见', () => {
  const whistle = pluginManifests().find((manifest) => manifest.warren?.id === 'com.warren.whistle');
  assert.ok(whistle, '没有找到 com.warren.whistle 清单');
  const names = (whistle.warren.contributes.commands as { name: string }[]).map((item) => item.name);
  for (const name of ['rules', 'ruleSet', 'ruleToggle', 'ruleRemove', 'unbind']) {
    assert.ok(names.includes(name), `com.warren.whistle 缺命令 ${name}`);
  }
  // 每条命令都要有线上的 rpc 实现，否则 `--help` 里会承诺一个不存在的动作
  const rpc = whistle.warren.contributes.rpc as string[];
  for (const name of names) assert.ok(rpc.includes(name), `命令 ${name} 没有对应的 rpc`);
});
