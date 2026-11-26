import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, splitDuplicatePorts } from '../plugins/whistle/lib/instances.mjs';
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
