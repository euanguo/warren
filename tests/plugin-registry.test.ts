import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabases, openDatabase } from '../src/main/db.ts';
import {
  appendPluginLog,
  loadPluginState,
  readPluginLogs,
  savePluginState,
  type PluginState,
} from '../src/main/plugins/registry.ts';

async function withRoot(
  run: (dir: string, db: ReturnType<typeof openDatabase>) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-registry-'));
  try {
    await run(dir, openDatabase(path.join(dir, 'warren.db')));
  } finally {
    closeDatabases();
    await rm(dir, { recursive: true, force: true });
  }
}

const EMPTY: PluginState = { enabled: [], granted: {}, installs: {} };

test('空库返回空状态', async () => {
  await withRoot(async (_dir, db) => {
    assert.deepEqual(await loadPluginState(db), EMPTY);
  });
});

test('保存后读回来：来源、解析结果、enabled / granted / installs 一个不丢', async () => {
  await withRoot(async (_dir, db) => {
    const state: PluginState = {
      enabled: ['a', 'b'],
      granted: { a: ['vault.fill'], b: ['browser.navigate', 'browser.input'] },
      installs: {
        a: {
          installedAt: '2026-01-01T00:00:00.000Z',
          digest: 'da',
          version: '1.0.0',
          packageName: 'warren-plugin-a',
          source: 'npm:warren-plugin-a@^1',
          resolved: 'warren-plugin-a@1.0.0',
        },
        b: {
          installedAt: '2026-01-02T00:00:00.000Z',
          digest: 'db',
          version: '2.0.0',
          packageName: 'warren-plugin-b',
          source: 'git:https://example.test/b.git#v2',
          resolved: 'abc123',
        },
      },
    };
    savePluginState(db, state);
    assert.deepEqual(await loadPluginState(db), state);
  });
});

test('插件日志按插件保留最近 500 条，最旧的先掉', async () => {
  await withRoot(async (_dir, db) => {
    for (let i = 1; i <= 505; i++) appendPluginLog(db, 'p', 'info', `msg-${i}`);

    const rows = readPluginLogs(db, 'p', 1000);
    assert.equal(rows.length, 500);
    assert.equal(rows[0]!.message, 'msg-6');
    assert.equal(rows.at(-1)!.message, 'msg-505');
  });
});

test('日志按插件隔离，limit 取最新的若干条且正序返回', async () => {
  await withRoot(async (_dir, db) => {
    appendPluginLog(db, 'p1', 'info', 'a');
    appendPluginLog(db, 'p2', 'warn', 'b');
    appendPluginLog(db, 'p1', 'error', 'c');

    assert.deepEqual(
      readPluginLogs(db, 'p1').map((row) => [row.level, row.message]),
      [
        ['info', 'a'],
        ['error', 'c'],
      ],
    );
    assert.deepEqual(
      readPluginLogs(db, 'p2').map((row) => [row.level, row.message]),
      [['warn', 'b']],
    );
    assert.deepEqual(
      readPluginLogs(db, 'p1', 1).map((row) => row.message),
      ['c'],
    );
  });
});

test('日志 level 从库里读出来会被归一，不让任意 TEXT 冒充联合类型', async () => {
  await withRoot(async (_dir, db) => {
    db.prepare('INSERT INTO plugin_logs (plugin_id, at, level, message) VALUES (?, ?, ?, ?)').run(
      'p',
      new Date().toISOString(),
      'weird',
      'x',
    );
    assert.equal(readPluginLogs(db, 'p')[0]!.level, 'info');
  });
});
