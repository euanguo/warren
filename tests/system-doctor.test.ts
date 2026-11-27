import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { collectSystemDiagnostics } from '../src/main/system-doctor.ts';

test('collectSystemDiagnostics 浏览器环境池统计读取 manager 运行时列表而非静态 store', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS dummy (id TEXT PRIMARY KEY)');

  const report = await collectSystemDiagnostics({
    appVersion: '0.1.0-test',
    dataDir: os.tmpdir(),
    coreDir: path.join(os.tmpdir(), 'warren-nonexistent-core'),
    socketPath: path.join(os.tmpdir(), 'warren-nonexistent.sock'),
    runtimeFile: path.join(os.tmpdir(), 'warren-nonexistent-runtime.json'),
    skillSourceDir: path.join(os.tmpdir(), 'warren-nonexistent-skills'),
    db,
    store: {
      // 模拟 SQLite 静态表始终为 stopped
      list: () => [
        {
          id: 'env-1',
          name: 'One',
          storagePath: '/tmp/1',
          createdBy: 'human',
          status: 'stopped',
          headed: true,
          order: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          spaces: [],
          activeSpaceId: 'person',
          owner: 'none',
        },
        {
          id: 'env-2',
          name: 'Two',
          storagePath: '/tmp/2',
          createdBy: 'human',
          status: 'stopped',
          headed: true,
          order: 1,
          createdAt: '2026-01-01T00:00:01.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
          spaces: [],
          activeSpaceId: 'person',
          owner: 'none',
        },
      ],
      listGroups: () => [],
      events: () => [],
    },
    manager: {
      list: () => [
        {
          id: 'env-1',
          name: 'One',
          storagePath: '/tmp/1',
          createdBy: 'human',
          status: 'running',
          headed: true,
          order: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          spaces: [],
          activeSpaceId: 'person',
          owner: 'none',
        },
        {
          id: 'env-2',
          name: 'Two',
          storagePath: '/tmp/2',
          createdBy: 'human',
          status: 'dormant',
          headed: true,
          order: 1,
          createdAt: '2026-01-01T00:00:01.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
          spaces: [],
          activeSpaceId: 'person',
          owner: 'none',
        },
      ],
      maxRunning: 8,
      hasActiveAgentLease: () => true,
    },
    plugins: {
      list: async () => [],
    },
  });

  const envCheck = report.checks.find((c) => c.id === 'environments');
  assert.ok(envCheck);
  assert.match(envCheck.detail, /共 2 个环境 · 运行中 1 \/ 休眠 1（上限 8） · Agent 持权中/);
});
