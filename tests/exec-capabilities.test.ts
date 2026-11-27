import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  EXEC_GLOBALS,
  RESULT_SENTINEL,
  createEmitResult,
  createExecSandbox,
  createPageApi,
  describeCapabilities,
} from '../bin/exec-runtime.mjs';

/**
 * `warren exec` 的能力面**只有一个来源**：`bin/exec-runtime.mjs`。
 *
 * 这里盯两件事：
 * 1. 注入的全局就是 `EXEC_GLOBALS`（多一个少一个都红），且没有 fs；
 * 2. `skills/warren/SKILL.md` 里写的名字必须都在反射出来的集合里 —— 文档漂移是本项目
 *    反复踩的坑（审计里 agent 按文档调 `readFileSync` 直接 EXIT=1）。
 */

const ROOT = path.join(import.meta.dirname, '..');
const SKILL = readFileSync(path.join(ROOT, 'skills', 'warren', 'SKILL.md'), 'utf8');

/** 反射不执行 RPC：反射期间任何调用都是 bug。 */
function probePage() {
  const call = () => {
    throw new Error('capabilities 不应该发起 RPC');
  };
  return createPageApi(call, { environmentId: 'probe', leaseId: 'probe' });
}

const CAPS = describeCapabilities(probePage());

test('EXEC_GLOBALS 就是 VM 里的全部全局', () => {
  assert.deepEqual([...EXEC_GLOBALS].sort(), [
    'checkpoint',
    'clearTimeout',
    'console',
    'emitResult',
    'help',
    'page',
    'setTimeout',
    'sleep',
    'state',
  ]);
});

test('沙箱按 EXEC_GLOBALS 装配，且拿不到 fs / require / process', () => {
  const sandbox = createExecSandbox({
    page: { name: 'page' },
    console: { name: 'console' },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    emitResult: () => undefined,
    state: {},
    checkpoint: async () => ({}),
    help: () => '',
    sleep: async () => undefined,
  }) as Record<string, unknown>;

  assert.deepEqual(Object.keys(sandbox).sort(), [...EXEC_GLOBALS].sort());
  assert.equal(typeof sandbox.emitResult, 'function');
  assert.equal(typeof sandbox.checkpoint, 'function');
  assert.equal(typeof sandbox.help, 'function');
  assert.equal(typeof sandbox.sleep, 'function');
  for (const forbidden of [
    'require',
    'process',
    'Buffer',
    'readFileSync',
    'writeFileSync',
    'existsSync',
    'mkdirSync',
  ]) {
    assert.equal(forbidden in sandbox, false, `VM 里不该有 ${forbidden}`);
  }
});

test('createExecSandbox 少给一个全局就报错（不允许静默注入 undefined）', () => {
  assert.throws(
    () =>
      createExecSandbox({
        page: {},
        console: {},
        setTimeout: () => 0,
        clearTimeout: () => undefined,
        state: {},
        checkpoint: async () => ({}),
        help: () => '',
        sleep: async () => undefined,
      }),
    /emitResult/,
  );
});

test('emitResult 打印同一前缀的哨兵行，并原样返回 payload', () => {
  const lines: string[] = [];
  const emitResult = createEmitResult((line) => lines.push(line));
  const payload = { ok: true, cases: [{ id: 'C01' }] };

  assert.deepEqual(emitResult(payload), payload);
  assert.deepEqual(lines, [`${RESULT_SENTINEL}${JSON.stringify(payload)}`]);
  assert.equal(RESULT_SENTINEL, '__CONSOLE_E2E_RESULT__');
});

test('能力清单由 page 实例反射：常用方法与 locator / mouse / keyboard 都在', () => {
  assert.deepEqual(CAPS.globals, [...EXEC_GLOBALS]);
  for (const name of ['goto', 'goBack', 'click', 'fill', 'snapshot', 'waitForSelector', 'tabs', 'locator']) {
    assert.ok(CAPS.page.includes(name), `page 上应该有 ${name}`);
  }
  for (const name of ['click', 'fill', 'press']) {
    assert.ok(CAPS.locator.includes(name), `locator 上应该有 ${name}`);
  }
  assert.ok(CAPS.mouse.includes('click'));
  assert.ok(CAPS.keyboard.includes('type'));
  // Playwright 有、这里没有的：清单必须如实反映「没有」
  for (const name of ['context', 'route', 'setViewportSize', 'expect']) {
    assert.equal(CAPS.page.includes(name), false, `没实现的方法不该出现在清单里：${name}`);
  }
});

test('skills/warren/SKILL.md 声明的全局与代码一致，且不再声称注入 fs', () => {
  const line = SKILL.split('\n').find((row) => row.includes('VM 里的全局就这几个'));
  assert.ok(line, 'SKILL.md 必须有一行说明 VM 里注入了哪些全局');

  // 只看「就这几个」那半句：后面「没有 fs / require / process」是反例清单
  const declared = [...line.split('**没有')[0]!.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]!)
    .filter((token) => /^[A-Za-z_$][\w$]*$/.test(token));
  assert.deepEqual(declared.sort(), [...EXEC_GLOBALS].sort());

  for (const ghost of ['readFileSync', 'writeFileSync', 'existsSync', 'mkdirSync']) {
    assert.equal(SKILL.includes(ghost), false, `SKILL.md 不能再声称注入 ${ghost}`);
  }
  assert.ok(SKILL.includes('warren exec --capabilities'), 'SKILL.md 要指向能力清单命令');
});

test('skills/warren/SKILL.md 里点名的方法都能在能力清单里找到', () => {
  const section = SKILL.split('## exec 里有什么')[1]?.split('\n## ')[0];
  assert.ok(section, 'SKILL.md 里找不到「exec 里有什么」一节');

  // `mouse` / `keyboard` 是命名空间（对象不是函数），反射按函数过滤时不会列出来，
  // 但它们确实是 page 上的属性，文档点它们的名是合法的
  const allowed = new Set([
    ...EXEC_GLOBALS,
    'mouse',
    'keyboard',
    ...CAPS.page,
    ...CAPS.locator,
    ...CAPS.mouse,
    ...CAPS.keyboard,
  ]);
  const bullets = section.split('\n').filter((row) => row.trimStart().startsWith('- '));
  assert.ok(bullets.length > 0, '这一节应该按能力分组的列表');

  const unknown = new Set();
  for (const bullet of bullets) {
    for (const match of bullet.matchAll(/`([^`]+)`/g)) {
      const token = match[1]!.replace(/\(\)$/, '').replace(/\.\*$/, '');
      if (!/^[A-Za-z_$][\w$]*$/.test(token)) continue;
      if (!allowed.has(token)) unknown.add(token);
    }
  }
  assert.deepEqual([...unknown], [], `文档点名了 exec 里不存在的方法：${[...unknown].join(', ')}`);
});
