import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentNetOps, type NetInterceptable } from '../src/main/net/ops.ts';
import type { HarEntry } from '../src/main/net/har.ts';
import type { NetHit, NetRule } from '../src/shared/types.ts';

/**
 * `net/ops.ts` 的编排逻辑。它**不 import electron**（真拦截器走工厂注入），
 * 所以这里能喂一个假拦截器直接跑 —— 这是把 net.* 从 environments.ts 拆出来的全部意义。
 */

type Rule = NetRule & { id: string };

/** 假拦截器：只实现 ops 真正用到的那几个方法（`NetInterceptable` 是 Pick 出来的，会跟着真货变）。 */
function fakeInterceptor(): NetInterceptable & {
  rulesTable: Rule[];
  bodiesTable: HarEntry[];
  recording: boolean;
  replaying: boolean;
  removed: string[];
} {
  const self = {
    rulesTable: [] as Rule[],
    hitsTable: [] as NetHit[],
    recording: false,
    replaying: false,
    removed: [] as string[],
    seq: 0,
    summary() {
      return {
        rules: self.rulesTable,
        hits: self.hitsTable.length,
        recording: self.recording,
        replaying: self.replaying,
      };
    },
    hits(limit?: number) {
      return typeof limit === 'number' ? self.hitsTable.slice(-limit) : self.hitsTable;
    },
    rules() {
      return self.rulesTable;
    },
    addRule(input: unknown) {
      const raw = input as { match: { url: string }; action: { type: string }; expiresAt?: number; priority?: number };
      const rule = {
        id: `r${++self.seq}`,
        match: raw.match,
        action: raw.action,
        expiresAt: raw.expiresAt,
        priority: raw.priority ?? 0,
      } as Rule;
      self.rulesTable.push(rule);
      return rule;
    },
    setRuleEnabled(ruleId: string, enabled: boolean) {
      const rule = self.rulesTable.find((r) => r.id === ruleId);
      if (!rule) throw Object.assign(new Error('no rule'), { code: 'NOT_FOUND' });
      rule.enabled = enabled;
      return rule;
    },
    removeRule(ruleId: string) {
      const before = self.rulesTable.length;
      self.rulesTable = self.rulesTable.filter((r) => r.id !== ruleId);
      const removed = self.rulesTable.length !== before;
      if (removed) self.removed.push(ruleId);
      return removed;
    },
    startRecording() {
      self.recording = true;
    },
    async stopRecording() {
      self.recording = false;
      return [] as HarEntry[];
    },
    installReplay(rules: NetRule[]) {
      self.replaying = true;
      self.rulesTable.push(...(rules as Rule[]));
    },
    stopReplay() {
      self.replaying = false;
      const n = self.rulesTable.length;
      self.rulesTable = [];
      return n;
    },
    bodiesTable: [] as HarEntry[],
    capturedBodies() {
      return self.bodiesTable;
    },
    detached: 0,
    attach() {},
    detach() {
      self.detached += 1;
    },
  };
  return self as unknown as NetInterceptable & typeof self;
}

function makeOps() {
  const events: { type: string; message: string; actor: string; envId: string }[] = [];
  let changes = 0;
  const byEnv = new Map<string, ReturnType<typeof fakeInterceptor>>();
  const ops = new EnvironmentNetOps({
    record: (type, message, actor, envId) => void events.push({ type, message, actor, envId }),
    onChange: () => void (changes += 1),
    // 每个环境一个假拦截器 —— 工厂是真货 `new NetInterceptor(...)` 的替身
    createInterceptor: (id) => {
      const fake = fakeInterceptor();
      byEnv.set(id, fake);
      return fake;
    },
  });
  return {
    ops,
    events,
    interceptor: (id = 'a') => byEnv.get(id)!,
    changes: () => changes,
  };
}

test('for() 是惰性建的：同一个环境拿到同一个拦截器，不同环境不同', () => {
  const { ops } = makeOps();
  assert.equal(ops.for('a'), ops.for('a'));
  assert.notEqual(ops.for('a'), ops.for('b'));
});

test('addRule 记事件 + 通知界面，过期规则的事件里带倒计时', () => {
  const { ops, events, changes } = makeOps();
  const plain = ops.addRule('a', { match: { url: '*/api/*' }, action: { type: 'block' } }, 'agent');
  assert.equal(events.at(-1)?.type, 'net.rule.added');
  assert.equal(events.at(-1)?.actor, 'agent');
  assert.equal(events.at(-1)?.envId, 'a');
  assert.ok(!/自动摘掉/.test(events.at(-1)!.message), '没过期的规则不该提倒计时');

  ops.addRule('a', { match: { url: '*/x' }, action: { type: 'block' }, expiresAt: Date.now() + 30_000 }, 'human');
  assert.match(events.at(-1)!.message, /后自动摘掉/);
  assert.equal(events.at(-1)?.actor, 'human');
  assert.equal(changes(), 2);
  assert.equal(plain.match.url, '*/api/*');
});

test('passthrough 卡时长：<1s / >1h / NaN 都拒，且不碰规则表', () => {
  const { ops, events, interceptor } = makeOps();
  for (const forMs of [0, 999, 3_600_001, Number.NaN]) {
    assert.throws(
      () => ops.passthrough('a', { match: '*/x', forMs }, 'agent'),
      (err: { code?: string }) => err.code === 'BAD_REQUEST',
      `forMs=${forMs} 应被拒`,
    );
  }
  // 校验在碰拦截器**之前**发生：连拦截器都不该被建出来
  assert.equal(interceptor(), undefined, '时长不合法时不该建拦截器');
  assert.equal(events.length, 0);
});

test('passthrough 同模式只留最新一条（连点两次不该堆两条口子）', () => {
  const { ops, interceptor } = makeOps();
  ops.passthrough('a', { match: '*/x', forMs: 5000 }, 'agent');
  ops.passthrough('a', { match: '*/x', forMs: 5000 }, 'agent');
  assert.equal(interceptor().rulesTable.length, 1, '同 match 应该只剩一条');

  // 不同 match / 不同 method / 不同 isRegex 各自独立
  ops.passthrough('a', { match: '*/y', forMs: 5000 }, 'agent');
  ops.passthrough('a', { match: '*/x', method: 'POST', forMs: 5000 }, 'agent');
  ops.passthrough('a', { match: '*/x', isRegex: true, forMs: 5000 }, 'agent');
  assert.equal(interceptor().rulesTable.length, 4);
  assert.ok(interceptor().rulesTable.every((r) => r.action.type === 'passthrough'));
});

test('setRuleEnabled / removeRule 各自记事件；removeRule 没删到就不记', () => {
  const { ops, events, changes } = makeOps();
  const rule = ops.addRule('a', { match: { url: '*/x' }, action: { type: 'block' } }, 'agent');
  const before = changes();

  ops.setRuleEnabled('a', rule.id, false, 'human');
  assert.equal(events.at(-1)?.type, 'net.rule.updated');
  assert.match(events.at(-1)!.message, /关闭规则/);

  assert.equal(ops.removeRule('a', rule.id, 'agent'), true);
  assert.equal(events.at(-1)?.type, 'net.rule.removed');

  const afterRemove = events.length;
  assert.equal(ops.removeRule('a', 'nope', 'agent'), false);
  assert.equal(events.length, afterRemove, '没删到不该记事件');
  assert.ok(changes() > before);
});

test('record：start 记开始，stop 记条数；未知动作报 BAD_REQUEST', async () => {
  const { ops, events, interceptor } = makeOps();
  assert.deepEqual(await ops.record('a', 'start', undefined, 'agent'), { recording: true, entries: 0 });
  assert.equal(interceptor().recording, true);
  assert.equal(events.at(-1)?.type, 'net.record.started');

  assert.deepEqual(await ops.record('a', 'stop', undefined, 'agent'), {
    recording: false,
    entries: 0,
    path: undefined,
    bytes: undefined,
    sha256: undefined,
  });
  assert.equal(interceptor().recording, false);
  assert.match(events.at(-1)!.message, /录到 0 条/);

  await assert.rejects(
    () => ops.record('a', 'nope', undefined, 'agent'),
    (err: { code?: string }) => err.code === 'BAD_REQUEST',
  );
});

test('replay：缺文件 / 坏 HAR 都报 BAD_REQUEST；stop 摘掉规则', async () => {
  const { ops } = makeOps();
  await assert.rejects(
    () => ops.replay('a', 'start', undefined, false, 'agent'),
    (err: { code?: string }) => err.code === 'BAD_REQUEST',
  );
  await assert.rejects(
    () => ops.replay('a', 'start', '/tmp/绝对路径但不存在.har', false, 'agent'),
    (err: { code?: string }) => err.code === 'BAD_REQUEST',
  );
  // stop 不需要文件
  assert.deepEqual(await ops.replay('a', 'stop', undefined, false, 'agent'), { replaying: false, rules: 0 });
});

test('body：没录制时给 NET_BODY_NEEDS_RECORDING，消息里带下一步命令', () => {
  const { ops } = makeOps();
  assert.throws(
    () => ops.body('a', 0),
    (err: { code?: string; message: string }) => {
      assert.equal(err.code, 'NET_BODY_NEEDS_RECORDING');
      assert.match(err.message, /net record start a/, '错误消息要给下一步命令');
      assert.match(err.message, /CORS/, '要说清为什么不能常开');
      return true;
    },
  );
});

test('body：序号越界报 BAD_REQUEST 并报出总数', () => {
  const { ops, interceptor } = makeOps();
  ops.for('a'); // 假拦截器是工厂按需建的，先要一个
  interceptor().bodiesTable.push({ at: '', method: 'GET', url: 'http://x/a', status: 200, body: '{"a":1}' });
  assert.throws(
    () => ops.body('a', 3),
    (err: { code?: string; message: string }) => {
      assert.equal(err.code, 'BAD_REQUEST');
      assert.match(err.message, /一共抓到 1 条/);
      return true;
    },
  );
});

test('body：JSON 按敏感 key 脱敏；URL 的 query 也脱敏', () => {
  const { ops, interceptor } = makeOps();
  ops.for('a');
  interceptor().bodiesTable.push({
    at: '',
    method: 'POST',
    url: 'http://x/api/login?token=abc&id=7',
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: 7, session: 's3cr3t', nested: { api_key: 'k' }, list: [{ password: 'p' }] }),
  });
  const got = ops.body('a', 0);
  assert.equal(got.status, 200);
  assert.equal(got.redacted, true);
  const parsed = JSON.parse(got.body) as Record<string, unknown>;
  assert.equal(parsed.session, '[REDACTED]');
  assert.equal((parsed.nested as Record<string, unknown>).api_key, '[REDACTED]');
  assert.equal(((parsed.list as Record<string, unknown>[])[0] as Record<string, unknown>).password, '[REDACTED]');
  assert.equal(parsed.id, 7, '不敏感的字段不能被误伤');
  assert.match(got.url, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
  assert.match(got.url, /id=7/);
});

test('body：非 JSON 原样返回并把 redacted 标成 false（不假装安全）', () => {
  const { ops, interceptor } = makeOps();
  ops.for('a');
  interceptor().bodiesTable.push({ at: '', method: 'GET', url: 'http://x/t', status: 200, body: 'token=abc' });
  const got = ops.body('a', 0);
  assert.equal(got.body, 'token=abc');
  assert.equal(got.redacted, false, '非 JSON 不做正则猜，必须显式标成未脱敏');
});

test('录制 / 回放的文件路径要过护栏（相对路径直接拒）', async () => {
  const { ops } = makeOps();
  await assert.rejects(
    () => ops.record('a', 'stop', 'relative.har', 'agent'),
    (err: { code?: string }) => err.code === 'PATH_DENIED',
  );
  await assert.rejects(
    () => ops.replay('a', 'start', 'relative.har', false, 'agent'),
    (err: { code?: string }) => err.code === 'PATH_DENIED',
  );
});
