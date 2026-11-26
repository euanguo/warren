import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EVENT_LIMIT, Store } from '../src/main/store.ts';
import { closeDatabases } from '../src/main/db.ts';

async function withStore(initial: unknown, run: (store: Store, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-store-'));
  try {
    if (initial !== undefined) {
      await writeFile(path.join(dir, 'environments.json'), JSON.stringify(initial));
    }
    const store = new Store(dir);
    await store.load();
    await run(store, dir);
    closeDatabases();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('migrates legacy data that has no groups and no order', async () => {
  // 这是真实的老文件形状：只有 environments，环境没有 order / groupId
  const legacy = {
    environments: [
      {
        id: 'alpha',
        name: 'alpha',
        storagePath: '/tmp/alpha',
        headed: true,
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        id: 'beta',
        name: 'beta',
        storagePath: '/tmp/beta',
        headed: true,
        createdAt: 'x',
        updatedAt: 'x',
      },
    ],
  };
  await withStore(legacy, async (store) => {
    const list = store.list();
    assert.equal(list.length, 2, '环境不能丢');
    assert.deepEqual(
      list.map((e) => e.order),
      [0, 1],
      'order 按原顺序补齐，否则排序静默失效',
    );
    assert.deepEqual(store.listGroups(), []);
  });
});

test('an environment pointing at a missing group is detached, not hidden', async () => {
  const broken = {
    environments: [
      {
        id: 'a',
        name: 'a',
        storagePath: '/tmp/a',
        headed: true,
        order: 0,
        groupId: 'ghost',
        createdAt: 'x',
        updatedAt: 'x',
      },
    ],
    groups: [],
  };
  await withStore(broken, async (store) => {
    // 指向不存在的分组会让它在侧栏里不显示——迁移必须把它捞回未分组
    assert.equal(store.list()[0].groupId, undefined);
  });
});

test('a stale absolute storagePath is recomputed under the current store dir', async () => {
  // 应用改名后 userData 变了，持久化的绝对路径会悬空。
  // 悬空路径不会被报错——Chromium 会照着它把旧目录重建出来，数据悄悄写错地方。
  const stale = {
    environments: [
      {
        id: 'alpha',
        name: 'alpha',
        storagePath: '/Users/someone/Library/Application Support/environment-browser/core/sessions/alpha',
        headed: true,
        order: 0,
        createdAt: 'x',
        updatedAt: 'x',
      },
    ],
    groups: [],
  };
  await withStore(stale, async (store, dir) => {
    assert.equal(store.configFor('alpha')!.storagePath, path.join(dir, 'sessions', 'alpha'));
  });
});

test('a storagePath already under the store dir is left alone', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-store-'));
  try {
    const inPlace = path.join(dir, 'sessions', 'alpha');
    await writeFile(
      path.join(dir, 'environments.json'),
      JSON.stringify({
        environments: [
          {
            id: 'alpha',
            name: 'alpha',
            storagePath: inPlace,
            headed: true,
            order: 0,
            createdAt: 'x',
            updatedAt: 'x',
          },
        ],
        groups: [],
      }),
    );
    const store = new Store(dir);
    await store.load();
    assert.equal(store.configFor('alpha')!.storagePath, inPlace);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing or corrupt file yields an empty store instead of throwing', async () => {
  await withStore(undefined, async (store) => {
    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.listGroups(), []);
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-store-'));
  try {
    await writeFile(path.join(dir, 'environments.json'), '{ not json');
    const store = new Store(dir);
    await store.load();
    assert.deepEqual(store.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('create assigns order per group and persists groups', async () => {
  await withStore({ environments: [], groups: [] }, async (store, dir) => {
    const group = store.createGroup({ name: '生产' });
    store.create({ id: 'a', groupId: group.id });
    store.create({ id: 'b', groupId: group.id });
    store.create({ id: 'c' });

    assert.equal(store.configFor('a')!.order, 0);
    assert.equal(store.configFor('b')!.order, 1, '组内递增');
    assert.equal(store.configFor('c')!.order, 0, '未分组自成一档');

    // 持久化断言用「重开一次读同一个目录」，不看存储格式——
    // 这一轮刚从 JSON 换到 SQLite，测格式的断言会跟着格式一起烂掉
    const reopened = new Store(dir);
    await reopened.load();
    assert.equal(reopened.listGroups().length, 1);
    assert.equal(reopened.list().length, 3);
    closeDatabases();
  });
});

test('create rejects environment ids that can escape the storage root', async () => {
  await withStore({ environments: [], groups: [] }, async (store) => {
    for (const id of ['', '.', '..', 'a/b', '/abs', 'a\\b', '../x']) {
      assert.throws(
        () => store.create({ id }),
        (error: Error & { code?: string }) => error.code === 'BAD_REQUEST',
        `id ${JSON.stringify(id)} 必须被拒绝`,
      );
    }
    for (const id of ['alpha', 'a1', 'my.env', 'my-env']) {
      store.create({ id });
      assert.ok(store.configFor(id), `id ${id} 应该被接受`);
    }
  });
});

test('storagePathFor keeps legacy bad ids inside the sessions root', async () => {
  await withStore({ environments: [], groups: [] }, async (store, dir) => {
    const escaped = store.storagePathFor('../../../../tmp/warren-escape');
    assert.equal(escaped.startsWith(path.join(dir, 'sessions') + path.sep), true, '坏 id 不能逃出 sessions');
    assert.equal(store.storagePathFor('alpha'), path.join(dir, 'sessions', 'alpha'), '正常 id 路径不变');
  });
});

test('removing a group keeps its environments and detaches them', async () => {
  await withStore({ environments: [], groups: [] }, async (store) => {
    const group = store.createGroup({ name: '临时' });
    store.create({ id: 'a', groupId: group.id });
    store.create({ id: 'b', groupId: group.id });

    const result = store.removeGroup(group.id);
    assert.equal(result.detached, 2);
    assert.equal(store.list().length, 2, '删组不能删环境');
    assert.deepEqual(store.listGroups(), []);
    assert.ok(store.list().every((e) => e.groupId === undefined));
  });
});

test('moving to an unknown group is refused', async () => {
  await withStore({ environments: [], groups: [] }, async (store) => {
    store.create({ id: 'a' });
    assert.throws(
      () => store.moveToGroup('a', 'ghost'),
      (error: Error & { code?: string }) => error.code === 'GROUP_NOT_FOUND',
    );
  });
});

test('reorder only affects the target group', async () => {
  await withStore({ environments: [], groups: [] }, async (store) => {
    const g1 = store.createGroup({ name: 'A' });
    const g2 = store.createGroup({ name: 'B' });
    store.create({ id: 'a1', groupId: g1.id });
    store.create({ id: 'a2', groupId: g1.id });
    store.create({ id: 'b1', groupId: g2.id });

    store.reorderEnvironments(g1.id, ['a2', 'a1']);
    assert.equal(store.configFor('a2')!.order, 0);
    assert.equal(store.configFor('a1')!.order, 1);
    assert.equal(store.configFor('b1')!.order, 0, '别的组不受影响');
  });
});

test('写到 SQLite：不再产生 environments.json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-store-'));
  try {
    const store = new Store(dir);
    await store.load();
    store.create({ id: 'a' });
    assert.equal(existsSync(path.join(dir, 'environments.json')), false, 'JSON 不该再被写出来');
    assert.equal(existsSync(path.join(dir, 'warren.db')), true);
    const reopened = new Store(dir);
    await reopened.load();
    assert.deepEqual(
      reopened.list().map((e) => e.id),
      ['a'],
    );
    closeDatabases();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a crash between write and rename is recovered from the temp file', async () => {
  // 崩溃或磁盘满会留下一个完整的 tmp，而主文件还是旧的（甚至损坏）。
  // 导入 SQLite 时不优先读 tmp，就等于把一次可恢复的写崩变成「所有环境看起来被删了」。
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-store-'));
  try {
    await writeFile(path.join(dir, 'environments.json'), '{"environments":[{"id":"old"');
    const complete = {
      environments: [
        {
          id: 'rescued',
          name: 'rescued',
          storagePath: '/tmp/rescued',
          headed: true,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      groups: [],
    };
    await writeFile(path.join(dir, 'environments.json.tmp'), JSON.stringify(complete));

    const store = new Store(dir);
    await store.load();
    assert.deepEqual(
      store.list().map((e) => e.id),
      ['rescued'],
    );
    // 导完留档，不删：迁移错了还能人工捞回来
    assert.equal(existsSync(path.join(dir, 'environments.json.tmp.migrated')), true);
    assert.equal(existsSync(path.join(dir, 'environments.json')), false);
    closeDatabases();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('both files corrupt still yields an empty store instead of throwing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-store-'));
  try {
    await writeFile(path.join(dir, 'environments.json'), '{oops');
    await writeFile(path.join(dir, 'environments.json.tmp'), '{also oops');
    const store = new Store(dir);
    await store.load();
    assert.deepEqual(store.list(), []);
    closeDatabases();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── SQLite 迁移本身 ─────────────────────────────────────────────────────

test('老 JSON 只导入一次：第二次打开不会把已删的环境倒回来', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-store-'));
  try {
    const store = new Store(dir);
    await store.load();
    store.create({ id: 'a' });
    store.create({ id: 'b' });
    store.remove('b');
    closeDatabases();

    // 有人（或某次崩溃）又放了一份老的 environments.json 回来
    await writeFile(
      path.join(dir, 'environments.json'),
      JSON.stringify({
        environments: [{ id: 'ghost', name: 'ghost', storagePath: '/tmp/ghost', headed: true }],
      }),
    );
    const reopened = new Store(dir);
    await reopened.load();
    assert.deepEqual(
      reopened.list().map((e) => e.id),
      ['a'],
      '库里非空时绝不回头吃老文件',
    );
    closeDatabases();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('事件落盘：重启之后还读得到（JSON 时代是内存缓冲，重启即清空）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-store-'));
  try {
    const store = new Store(dir);
    await store.load();
    store.record({
      id: 'e1',
      type: 'test.event',
      actor: 'system',
      message: '落盘了吗',
      createdAt: new Date().toISOString(),
    });
    closeDatabases();

    const reopened = new Store(dir);
    await reopened.load();
    assert.deepEqual(
      reopened.events().map((e) => e.message),
      ['落盘了吗'],
    );
    assert.equal(reopened.events('nope').length, 0, '按环境过滤');
    closeDatabases();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('事件表封顶：超过水位就把最老的删掉（清理按批做，最多到水位 + 99）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-store-'));
  try {
    const store = new Store(dir);
    await store.load();
    for (let index = 0; index < EVENT_LIMIT + 150; index += 1) {
      store.record({
        id: `e${index}`,
        type: 'test.event',
        actor: 'system',
        message: `第 ${index} 条`,
        createdAt: new Date(1700000000000 + index).toISOString(),
      });
    }
    const kept = store.events(undefined, EVENT_LIMIT + 1000);
    assert.ok(kept.length <= EVENT_LIMIT + 99, `最多到水位 + 99，实际 ${kept.length}`);
    assert.ok(kept.length >= EVENT_LIMIT, `不该提前删，实际 ${kept.length}`);
    assert.equal(kept[0].message, '第 100 条', '删的是最老的（5150 条时清掉前 100 条）');
    closeDatabases();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('库损坏也能起来：挪到一边再开一个新的，不把应用卡死', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'warren-store-'));
  try {
    // 一个不是 SQLite 的 warren.db
    await writeFile(path.join(dir, 'warren.db'), '这不是数据库');
    const store = new Store(dir);
    await store.load();
    assert.deepEqual(store.list(), [], '坏库当成空 store');
    const leftovers = (await import('node:fs'))
      .readdirSync(dir)
      .filter((name) => name.startsWith('warren.db.corrupt-'));
    assert.equal(leftovers.length, 1, '坏库要留档，不能直接删');
    await store.create({ id: 'a' });
    assert.deepEqual(
      store.list().map((e) => e.id),
      ['a'],
      '新库照常用',
    );
    closeDatabases();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('按域偏好：保存缩放与视口预设并在删环境时连带清理', async () => {
  await withStore({ environments: [], groups: [] }, async (store) => {
    store.create({ id: 'a' });
    store.create({ id: 'b' });

    const saved = store.setDomainPref('a', 'https://example.com', {
      zoomFactor: 1.25,
      viewportPreset: 'mobile-390',
    });
    assert.equal(saved.zoomFactor, 1.25);
    assert.equal(saved.viewportPreset, 'mobile-390');
    assert.equal(store.domainPref('a', 'https://example.com')?.zoomFactor, 1.25);

    store.setDomainPref('a', 'https://example.com', { viewportPreset: null });
    const updated = store.domainPref('a', 'https://example.com');
    assert.equal(updated?.zoomFactor, 1.25);
    assert.equal(updated?.viewportPreset, undefined);

    store.setDomainPref('b', 'https://example.com', { zoomFactor: 0.9 });
    assert.equal(store.listDomainPrefs('a').length, 1);

    assert.equal(store.removeDomainPref('b', 'https://example.com'), true);
    assert.equal(store.removeDomainPref('b', 'https://example.com'), false);
    assert.equal(store.domainPref('b', 'https://example.com'), undefined);

    store.recordUrlHistory('https://example.com/a');
    store.recordUrlHistory('https://example.com/b');
    assert.equal(store.searchUrlHistory('example.com').length, 2);
    assert.equal(store.clearUrlHistory(), 2);
    assert.equal(store.searchUrlHistory('example.com').length, 0);

    store.remove('a');
    assert.equal(store.domainPref('a', 'https://example.com'), undefined);
  });
});
