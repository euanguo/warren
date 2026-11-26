import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { warrenHome, warrenPaths } from '../src/main/paths.ts';
import { guardSavePath } from '../src/main/browser/policy.ts';

/*
 * 数据根。见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §6。
 * 这里钉两件事：默认值在哪、`WARREN_HOME` 能不能把它挪走（CLI 与主进程都靠这一条对齐）。
 */

test('默认根是 ~/.warren', () => {
  assert.equal(warrenHome({}), path.join(os.homedir(), '.warren'));
});

test('WARREN_HOME 覆盖默认根（相对路径按 cwd 解析）', () => {
  assert.equal(warrenHome({ WARREN_HOME: '/tmp/wh-alt' }), '/tmp/wh-alt');
  assert.equal(warrenHome({ WARREN_HOME: 'relative-dir' }), path.resolve('relative-dir'));
});

test('布局：五个子目录都在根下面', () => {
  const paths = warrenPaths({ WARREN_HOME: '/tmp/wh-alt' });
  assert.deepEqual(paths, {
    home: '/tmp/wh-alt',
    app: '/tmp/wh-alt/app',
    core: '/tmp/wh-alt/core',
    runtime: '/tmp/wh-alt/runtime',
    whistle: '/tmp/wh-alt/whistle',
    logs: '/tmp/wh-alt/logs',
    crashDumps: '/tmp/wh-alt/crashDumps',
  });
});

test('写路径护栏跟着根走，不是硬编码 ~/.warren', () => {
  const previous = process.env.WARREN_HOME;
  try {
    process.env.WARREN_HOME = '/tmp/wh-guard';
    assert.throws(() => guardSavePath('/tmp/wh-guard/core/x.har'), /PATH_DENIED/);
    // 旧位置现在不再是数据根，就不该拦
    assert.equal(guardSavePath('/tmp/other/x.har'), '/tmp/other/x.har');
  } finally {
    if (previous === undefined) delete process.env.WARREN_HOME;
    else process.env.WARREN_HOME = previous;
  }
});
