import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabases } from '../src/main/db.ts';
import { Store } from '../src/main/store.ts';

test('URL history is global, deduplicated, persisted, and searchable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-url-history-'));
  try {
    const store = new Store(dir);
    await store.load();
    store.recordUrlHistory('https://example.com/docs');
    store.recordUrlHistory('https://example.com/docs');
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.recordUrlHistory('https://other.test/example/path');
    store.recordUrlHistory('warren://newtab');
    store.recordUrlHistory('not a url');

    const all = store.searchUrlHistory('', 8);
    assert.equal(all.length, 2, '只存 http/https，且同一 URL 去重');
    assert.equal(all[0]?.url, 'https://other.test/example/path', '空 query 按最近访问排序');
    assert.equal(all[1]?.visitCount, 2, '重复访问累计次数');

    const matched = store.searchUrlHistory('example', 8);
    assert.deepEqual(
      matched.map((entry) => entry.url),
      ['https://example.com/docs', 'https://other.test/example/path'],
      '前缀命中排在子串命中之前',
    );

    closeDatabases();
    const reopened = new Store(dir);
    await reopened.load();
    assert.equal(reopened.searchUrlHistory('docs', 8)[0]?.visitCount, 2, '历史跨重启保留');
  } finally {
    closeDatabases();
    await rm(dir, { recursive: true, force: true });
  }
});
