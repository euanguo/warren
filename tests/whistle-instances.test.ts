import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDuplicatePorts } from '../plugins/whistle/host.mjs';

const inst = (storage, port, createdAt = '2026-01-01T00:00:00.000Z') => ({ storage, port, createdAt });
const status = (storage) => ({ storage, version: '2.10.12' });

test('单个实例原样保留，不产生 stale', () => {
  const instances = [inst('a', 8900)];
  const { live, stale } = splitDuplicatePorts(instances, new Map([[8900, status('a')]]));
  assert.deepEqual(
    live.map((item) => item.storage),
    ['a'],
  );
  assert.deepEqual(stale, []);
});

test('同端口两条登记：留下真正在跑的那条，另一条进 stale', () => {
  const instances = [inst('new', 8900, '2026-11-01T00:00:00.000Z'), inst('old', 8900, '2026-10-01T00:00:00.000Z')];
  const { live, stale } = splitDuplicatePorts(instances, new Map([[8900, status('old')]]));
  assert.deepEqual(
    live.map((item) => item.storage),
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
    live.map((item) => item.storage),
    ['new'],
  );
  assert.deepEqual(
    stale.map((item) => item.storage),
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
    live.map((item) => item.storage),
    ['a', 'b'],
  );
  assert.deepEqual(stale, []);
});
