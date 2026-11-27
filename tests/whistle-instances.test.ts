import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, reconcileInstances, splitDuplicatePorts } from '../plugins/whistle/lib/instances.mjs';
import whistlePlugin from '../plugins/whistle/host.mjs';
import { ruleLine, setRule } from '../plugins/whistle/lib/rules-presets.mjs';
import { sha256 } from '../plugins/whistle/presets.mjs';

const inst = (storage: string, port: number, createdAt = '2026-01-01T00:00:00.000Z') => ({ storage, port, createdAt });
const status = (storage: string) => ({ storage, version: '2.10.12' });

test('单个实例原样保留，不产生 stale', () => {
  const instances = [inst('a', 8900)];
  const { live, stale } = splitDuplicatePorts(instances, new Map([[8900, status('a')]]));
  assert.deepEqual(
    live.map((item: { storage: string }) => item.storage),
    ['a'],
  );
  assert.deepEqual(stale, []);
});

test('同端口两条登记：留下真正在跑的那条，另一条进 stale', () => {
  const instances = [inst('new', 8900, '2026-11-01T00:00:00.000Z'), inst('old', 8900, '2026-10-01T00:00:00.000Z')];
  const { live, stale } = splitDuplicatePorts(instances, new Map([[8900, status('old')]]));
  assert.deepEqual(
    live.map((item: { storage: string }) => item.storage),
    ['old'],
  );
  assert.deepEqual(stale, [
    {
      storage: 'new',
      port: 8900,
      reason: 'duplicate-port',
      liveStorage: 'old',
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ]);
});

test('同端口没有任何实例在跑：留最新登记的那条', () => {
  const instances = [inst('old', 8900, '2026-10-01T00:00:00.000Z'), inst('new', 8900, '2026-11-01T00:00:00.000Z')];
  const { live, stale } = splitDuplicatePorts(instances, new Map([[8900, null]]));
  assert.deepEqual(
    live.map((item: { storage: string }) => item.storage),
    ['new'],
  );
  assert.deepEqual(
    stale.map((item: { storage: string }) => item.storage),
    ['old'],
  );
});

test('端口上跑的是第三方 storage：只剩登记顺序，不误判为在多跑', () => {
  const instances = [inst('a', 8900), inst('b', 8901)];
  const { live, stale } = splitDuplicatePorts(
    instances,
    new Map([
      [8900, status('someone-else')],
      [8901, null],
    ]),
  );
  assert.deepEqual(
    live.map((item: { storage: string }) => item.storage),
    ['a', 'b'],
  );
  assert.deepEqual(stale, []);
});

test('describe 正确映射绑定环境且在端口被其它 storage 占用时标 alive=false', async () => {
  const env = { id: 'e1', name: 'Work', proxy: 'http://127.0.0.1:8900' };
  const occupied = await describe(
    { storage: 's1', port: 8900, hostPattern: 'a.test', createdAt: '2026-01-01' },
    [env],
    null,
    { storage: 'foreign', version: '2.10.15' },
    {},
  );
  assert.equal(occupied.alive, false);
  assert.equal(occupied.portOccupant, 'foreign');
  assert.equal(occupied.environmentId, 'e1');
  assert.equal(ruleLine('a.test', 3000), 'a.test 127.0.0.1:3000');
});

test('setRule 写入后启用规则组，并在 expectedHash 漂移或校验失败时拒绝/回滚', async () => {
  const stored = { name: 'warren', data: 'old.test 127.0.0.1:3000', selected: true };
  let dropEnable = false;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/cgi-bin/status') {
        res.end(JSON.stringify({ name: 'whistle', storage: 's-rule', version: '2.10.15' }));
        return;
      }
      if (req.url?.startsWith('/cgi-bin/rules/list')) {
        res.end(JSON.stringify({ allowMultipleChoice: true, list: [{ ...stored }] }));
        return;
      }
      if (req.url === '/cgi-bin/rules/allow-multiple-choice') {
        res.end(JSON.stringify({ ec: 0 }));
        return;
      }
      if (req.url === '/cgi-bin/rules/project') {
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        if (body.has('rules')) stored.data = body.get('rules') ?? '';
        if (body.has('enable') && !dropEnable) stored.selected = body.get('enable') === '1';
        res.end(JSON.stringify({ ec: 0 }));
        return;
      }
      res.end(JSON.stringify({ ec: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const fakeHost = {
    storage: { kv: { get: async () => [{ storage: 's-rule', port }] } },
    signal: { publish: async () => undefined },
  };

  try {
    await assert.rejects(
      () => setRule(fakeHost, { storage: 's-rule', rules: 'x.test 127.0.0.1:4000', expectedHash: 'wrong' }),
      (e: Error & { code?: string }) => e.code === 'RULE_STALE',
    );

    stored.selected = false;
    const saved = await setRule(fakeHost, {
      storage: 's-rule',
      rules: 'next.test 127.0.0.1:4000',
      expectedHash: sha256('old.test 127.0.0.1:3000'),
    });
    assert.equal(saved.verified, true);
    assert.equal(saved.selected, true);

    dropEnable = true;
    stored.selected = false;
    await assert.rejects(
      () => setRule(fakeHost, { storage: 's-rule', rules: 'bad-enable.test 127.0.0.1:5000' }),
      (e: Error & { code?: string }) => e.code === 'RULE_ENABLE_UNCONFIRMED',
    );
    assert.equal(stored.data, 'next.test 127.0.0.1:4000');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('reconcileInstances 按端口去重、限流并发、跳过他家实例占用端口并支持 AbortSignal 中止', async () => {
  const probedPorts: number[] = [];
  const enabledPorts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const instances = [
    inst('dup-a', 8900),
    inst('dup-b', 8900), // 同端口重复登记：只探一次
    inst('alive-1', 8901),
    inst('dead-2', 8902),
    inst('foreign-3', 8903),
    inst('alive-4', 8904),
  ];
  const fakeHost = { log: { warn: async () => undefined } };

  const result = await reconcileInstances(fakeHost, {
    instances,
    concurrency: 2,
    probe: async (port: number) => {
      probedPorts.push(port);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      if (port === 8900) return status('dup-b');
      if (port === 8901) return status('alive-1');
      if (port === 8903) return status('someone-else');
      if (port === 8904) return status('alive-4');
      return null;
    },
    enable: async (port: number) => {
      enabledPorts.push(port);
    },
  });

  assert.equal(probedPorts.length, 5, '重复端口 8900 只应探测一次');
  assert.ok(maxInFlight <= 2, `并发度不应超过 2，实际 ${maxInFlight}`);
  assert.deepEqual(enabledPorts.sort(), [8900, 8901, 8904]);
  assert.deepEqual(result, { probedPorts: 5, alivePorts: 3, enabledPorts: 3 });

  // 验证已中止的 AbortSignal 立刻跳过探测
  const controller = new AbortController();
  controller.abort();
  let abortedProbes = 0;
  const aborted = await reconcileInstances(fakeHost, {
    instances,
    signal: controller.signal,
    probe: async () => {
      abortedProbes += 1;
      return null;
    },
  });
  assert.equal(abortedProbes, 0);
  assert.equal(aborted.probedPorts, 0);
});

test('whistle activate() 不被慢端口探活阻塞，后台异步完成多选规则补开', async () => {
  let multiChoiceCalled = false;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/cgi-bin/status') {
      setTimeout(() => {
        res.end(JSON.stringify({ name: 'whistle', storage: 'slow-inst', version: '2.10.15' }));
      }, 220);
      return;
    }
    if (req.url?.startsWith('/cgi-bin/rules/list')) {
      res.end(JSON.stringify({ allowMultipleChoice: multiChoiceCalled, list: [] }));
      return;
    }
    if (req.url === '/cgi-bin/rules/allow-multiple-choice') {
      multiChoiceCalled = true;
      res.end(JSON.stringify({ ec: 0 }));
      return;
    }
    res.end(JSON.stringify({ ec: 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  const fakeHost = {
    storage: {
      kv: { get: async () => [inst('slow-inst', port)] },
      sql: {
        migrate: async () => 0,
        exec: async () => undefined,
        query: async () => [],
        run: async () => undefined,
      },
    },
    log: {
      info: async () => undefined,
      warn: async () => undefined,
    },
  };

  try {
    const start = Date.now();
    await whistlePlugin.activate({ host: fakeHost });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 120, `whistle activate() 应立即返回而非等待 220ms 探活，实际 ${elapsed}ms`);

    // 等待后台对账完成并确认最终补开了多选规则
    const deadline = Date.now() + 1500;
    while (!multiChoiceCalled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(multiChoiceCalled, true, '后台对账应为存活实例补开 allowMultipleChoice');
  } finally {
    await whistlePlugin.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
