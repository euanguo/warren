import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabases } from '../src/main/db.ts';
import { Store } from '../src/main/store.ts';

test('标签快照按 Space 分开保存，并各自保留 activeTab', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-spaces-'));
  try {
    const store = new Store(dir);
    await store.load();
    store.saveTabs('cap', [
      { space: 'person', url: 'https://person.test/1', active: false },
      { space: 'agent', url: 'https://agent.test/1', active: true },
      { space: 'person', url: 'https://person.test/2', active: true },
      { space: 'agent', url: 'https://agent.test/2', active: false },
    ]);
    assert.deepEqual(store.tabsFor('cap'), [
      { space: 'person', url: 'https://person.test/1', active: false },
      { space: 'agent', url: 'https://agent.test/1', active: true },
      { space: 'person', url: 'https://person.test/2', active: true },
      { space: 'agent', url: 'https://agent.test/2', active: false },
    ]);
  } finally {
    closeDatabases();
    await rm(dir, { recursive: true, force: true });
  }
});
