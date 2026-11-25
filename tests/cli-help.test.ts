import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { SUBS, TOP_LEVEL } from '../bin/commands.mjs';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'warren.mjs');
const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

/**
 * 命令清单是单一来源（`bin/commands.mjs`），但 `help` 正文和每组的报错提示是手写的。
 * 这三条测试盯着它们别漂 —— 实测漂过一次：help 漏了 `call` 和 4 个 plugin 子命令。
 */

test('help 覆盖 SUBS 里每一个子命令', () => {
  const help = run(['help']).stdout;
  const missing: string[] = [];
  for (const [group, list] of Object.entries(SUBS)) {
    // help 里可能写成 `warren env start|stop|remove|select`，所以按 token 切
    const listed = new Set<string>();
    for (const m of help.matchAll(new RegExp(`warren ${group} ([a-z|-]+)`, 'g'))) {
      for (const s of m[1].split('|')) listed.add(s);
    }
    for (const sub of list) if (!listed.has(sub)) missing.push(`${group} ${sub}`);
  }
  assert.deepEqual(missing, [], `help 漏了这些子命令：${missing.join(', ')}`);
});

test('help 覆盖顶层命令（exec / events / call / help）', () => {
  const help = run(['help']).stdout;
  const missing = TOP_LEVEL.filter((c) => !help.includes(`warren ${c}`));
  assert.deepEqual(missing, [], `help 漏了顶层命令：${missing.join(', ')}`);
});

test('每组的 default 报错里列全该组子命令', () => {
  for (const [group, list] of Object.entries(SUBS)) {
    const r = run([group, '__nope__', '__env__']);
    assert.equal(r.status, 1, `warren ${group} __nope__ 应该退出 1`);
    for (const sub of list) {
      assert.ok(r.stderr.includes(sub), `warren ${group} 的报错漏了 ${sub}：${r.stderr.trim()}`);
    }
  }
});

test('未知命令组报错退出 1，且不往 stdout 吐 help', () => {
  const r = run(['nope']);
  assert.equal(r.status, 1, 'warren nope 必须退出 1（以前是静默退出 0）');
  assert.equal(r.stdout.trim(), '', 'warren nope 不该往 stdout 写东西');
  assert.match(r.stderr, /未知命令组/);
});

test('无参数 / help 仍然打印 help 并退出 0', () => {
  for (const args of [[], ['help']]) {
    const r = run(args);
    assert.equal(r.status, 0, `warren ${args.join(' ')} 应该退出 0`);
    assert.match(r.stdout, /Warren 的 Agent 接口/);
  }
});

test('plugin run --help 不传 id 时列出已安装插件并退出 0', () => {
  const r = run(['plugin', 'run', '--help']);
  assert.equal(r.status, 0, r.stderr);
  const [plugin] = r.stdout.split('\n');
  assert.match(plugin, /已安装插件的命令/);
  assert.match(r.stdout, /用法: warren plugin run/);
});

test('plugin run <id> <cmd> --help 只打印帮助，不能执行命令', () => {
  // 实测事故：`fork --help` 真的起了一个 whistle 实例（端口被占才发现）。
  // 这里用一个必然写文件的命令验证「没有副作用」，而不是只看退出码。
  const r = run(['plugin', 'run', 'com.warren.accounts', 'create', '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /只打印帮助，不执行命令/);
  assert.doesNotMatch(r.stdout, /"pluginId"/, '--help 不能走到真正的 plugin.run');
});
