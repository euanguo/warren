import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * RPC 写门控的**静态**守卫。
 *
 * `rpc-dispatch.ts` 的派发表里，「改页面状态」的命令必须经过 `writeCall` / `inputCall` /
 * `dialogCall`，或者显式 `assertWritable`。
 *
 * `tests/rpc-dispatch.test.ts` 从运行时验「门控真的拦得住」；这里补的是另一半——
 * 新增一个 `browser.*` / `net.*` / `tab.*` 命令却**忘了挂门控**时立刻红
 * （运行时那个测试只覆盖它点名的那几条，覆盖不到新加的方法）。
 *
 * 和 `icon-names.test.ts` 同一路数——用源码断言守住一个「类型系统管不到」的约定。
 */
const RPC_SOURCE = readFileSync(new URL('../src/main/rpc-dispatch.ts', import.meta.url), 'utf8');

const GATE_CALL = /writeCall\(|inputCall\(|dialogCall\(|assertWritable\(/;

/** 明确只读的命令：读快照 / 等条件 / 看日志，都不改页面状态，所以不取 lease。 */
const READ_ONLY = new Set([
  // 读录制期间抓到的响应体 —— 只读，不改页面状态
  'net.body',
  'browser.snapshot',
  'browser.waitFor',
  'browser.waitForURL',
  'browser.waitForSelector',
  'browser.waitForFunction',
  'browser.waitForLoadState',
  'browser.waitForTimeout',
  'browser.waitForEvent',
  'browser.info',
  'browser.events',
  'browser.downloadStatus',
  'browser.console',
  'browser.network',
  'browser.screenshot',
  'browser.highlight',
  'net.rules',
  'net.hits',
  'tab.list',
]);

/** 从 dispatch 的 switch 里切出每个 case；`case 'a': case 'b': { ... }` 的 fall-through 要一起算。 */
function dispatchCases(): Array<{ method: string; body: string }> {
  const start = RPC_SOURCE.indexOf('switch (method) {');
  assert.notEqual(start, -1, 'rpc.ts 里找不到 dispatch 的 switch，这个测试要跟着改');

  const blocks = RPC_SOURCE.slice(start)
    .split(/\n\s*case '/)
    .slice(1)
    .flatMap((part) => {
      const label = part.match(/^([a-zA-Z][\w.]*)':/);
      return label ? [{ method: label[1]!, body: part.slice(label[0].length) }] : [];
    });

  // 从后往前：只有标签、没有语句的块（fall-through）继承下一个块的门控状态
  const out: Array<{ method: string; body: string }> = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const inherited = out.at(-1);
    out.push(block.body.trim() === '' && inherited ? { method: block.method, body: inherited.body } : block);
  }
  return out.reverse();
}

const CASES = dispatchCases();
const GATED = CASES.filter((item) => GATE_CALL.test(item.body)).map((item) => item.method);
const UNGATED = CASES.filter((item) => !GATE_CALL.test(item.body)).map((item) => item.method);

test('dispatch 被完整解析：门控 / 非门控加起来等于全部 case', () => {
  assert.ok(CASES.length > 80, `只解析到 ${CASES.length} 个 case，切分逻辑可能失效了`);
  assert.equal(GATED.length + UNGATED.length, CASES.length);
  // 抽查两条已知形状：fall-through 的 tab.closeOthers 算门控，tab.list 不算
  assert.ok(GATED.includes('tab.closeOthers'), 'fall-through 的 tab.closeOthers 应该继承到门控');
  assert.ok(UNGATED.includes('tab.list'));
});

test('browser.* / net.* / tab.* 里改状态的命令都走写门控', () => {
  const risky = CASES.filter(
    (item) => /^(browser|net|tab)\./.test(item.method) && !GATE_CALL.test(item.body) && !READ_ONLY.has(item.method),
  ).map((item) => item.method);

  assert.deepEqual(
    risky,
    [],
    `这些命令会改页面状态却没走 writeCall/inputCall/dialogCall/assertWritable：${risky.join(', ')}。` +
      '如果它确实是只读的，把它加进本文件的 READ_ONLY 白名单。',
  );
});

test('只读白名单不过期：每一条都还存在且确实没挂门控', () => {
  const actuallyReadOnly = new Set(UNGATED);
  const stale = [...READ_ONLY].filter((method) => !actuallyReadOnly.has(method));
  assert.deepEqual(stale, [], `白名单里这些已经不存在或已经挂了门控，删掉：${stale.join(', ')}`);
});
