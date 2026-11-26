import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabases } from '../src/main/db.ts';
import { normalizeSiteKey, Store } from '../src/main/store.ts';

async function withTempStore(run: (store: Store) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-notes-'));
  try {
    const store = new Store(dir);
    await store.load();
    await run(store);
    closeDatabases();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('normalizeSiteKey 规范化 URL 与域名路径', () => {
  assert.equal(normalizeSiteKey('Example.COM/'), 'example.com');
  assert.equal(normalizeSiteKey('https://App.Example.com/admin/?tab=1#hash'), 'app.example.com/admin');
  assert.equal(normalizeSiteKey('http://localhost:8899/login/'), 'localhost:8899/login');
  assert.throws(() => normalizeSiteKey('   '));
  assert.throws(() => normalizeSiteKey('file:///etc/passwd'));
});

test('site_notes 支持 set / append / list / match / remove 并持久化', async () => {
  await withTempStore(async (store) => {
    const first = store.setSiteNote('https://example.com/', '登录页按钮文本为「下一步」', 'agent');
    assert.equal(first.site, 'example.com');
    assert.equal(first.updatedBy, 'agent');

    const second = store.setSiteNote('example.com/admin', '管理后台需要二次点击确认', 'human');
    assert.equal(second.site, 'example.com/admin');

    const appended = store.appendSiteNote('example.com', '列表分页每页 20 条', 'agent');
    assert.match(appended.content, /下一步/);
    assert.match(appended.content, /每页 20 条/);

    const matched = store.matchSiteNotesForUrl('https://example.com/admin/users?page=2');
    assert.equal(matched.length, 2);
    // 最长路径前缀优先
    assert.equal(matched[0]?.site, 'example.com/admin');
    assert.equal(matched[1]?.site, 'example.com');

    assert.equal(store.matchSiteNotesForUrl('https://other.test/').length, 0);
    assert.equal(store.listSiteNotes().length, 2);
    assert.equal(store.removeSiteNote('example.com/admin'), true);
    assert.equal(store.removeSiteNote('example.com/admin'), false);
    assert.equal(store.listSiteNotes().length, 1);
  });
});

test('site_notes 拒绝存入疑似密码或令牌明文', async () => {
  await withTempStore(async (store) => {
    assert.throws(() => store.setSiteNote('example.com', 'password=hunter2'), /vault/i);
    assert.throws(() => store.appendSiteNote('example.com', 'Authorization Bearer eyJhbGciOiJIUzI1NiIs'), /vault/i);
    assert.throws(() => store.setSiteNote('example.com', 'token sk-live_1234567890abcdefg'), /vault/i);
  });
});
