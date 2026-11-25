import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSelector, normalizeTarget, assertUnique, pickNth } from '../src/main/browser/target.ts';

test('ref 三种写法', () => {
  assert.deepEqual(parseSelector('@21'), { kind: 'ref', ref: '@21', nth: undefined });
  assert.deepEqual(parseSelector('ref=21'), { kind: 'ref', ref: '@21', nth: undefined });
});

test('text 精确与模糊', () => {
  assert.deepEqual(parseSelector('text=登录'), {
    kind: 'text',
    text: '登录',
    exact: false,
    nth: undefined,
  });
  assert.deepEqual(parseSelector('text="登录"'), {
    kind: 'text',
    text: '登录',
    exact: true,
    nth: undefined,
  });
});

test('loc=role 精确与子串', () => {
  assert.deepEqual(parseSelector('loc=role:button[name="Sign in"]'), {
    kind: 'role',
    role: 'button',
    name: 'Sign in',
    nameExact: true,
    nth: undefined,
  });
  assert.deepEqual(parseSelector('loc=role:button[name*="Sign"]'), {
    kind: 'role',
    role: 'button',
    name: 'Sign',
    nameExact: false,
    nth: undefined,
  });
  assert.deepEqual(parseSelector('loc=css:#a'), {
    kind: 'selector',
    selector: '#a',
    hasText: undefined,
    textIs: undefined,
    nth: undefined,
  });
  assert.deepEqual(parseSelector('loc=href:/x'), { kind: 'href', href: '/x', nth: undefined });
});

test('xpath / css= / 裸 CSS / nth / 文本过滤', () => {
  assert.equal(parseSelector('xpath=//button').kind, 'xpath');
  assert.equal(parseSelector('css=.a').kind, 'selector');
  assert.equal(parseSelector('.a').kind, 'selector');
  assert.deepEqual(parseSelector('.a >> nth=-1').nth, -1);
  assert.deepEqual(parseSelector('css=.a:has-text("x")'), {
    kind: 'selector',
    selector: '.a',
    hasText: 'x',
    textIs: undefined,
    nth: undefined,
  });
  assert.deepEqual(parseSelector('.a:text-is("x")').textIs, 'x');
});

test('非法选择器报 BAD_SELECTOR 不猜', () => {
  for (const bad of ['', '   ', 'loc=foo:bar', 'loc=role:button[name=x]', 'text=', '.a >> nth=-2']) {
    assert.throws(
      () => parseSelector(bad),
      (e: unknown) => (e as { code?: string }).code === 'BAD_SELECTOR',
      bad,
    );
  }
});

test('老 Target 对象原样兼容', () => {
  assert.deepEqual(normalizeTarget({ kind: 'role', role: 'button', name: 'x' }), {
    kind: 'role',
    role: 'button',
    name: 'x',
  });
  assert.deepEqual(normalizeTarget({ kind: 'text', text: 'x' }), { kind: 'text', text: 'x' });
  assert.deepEqual(normalizeTarget({ kind: 'label', text: 'x' }), { kind: 'label', text: 'x' });
  assert.deepEqual(normalizeTarget({ kind: 'selector', selector: '.x' }), {
    kind: 'selector',
    selector: '.x',
  });
  assert.throws(
    () => normalizeTarget({ kind: 'nope' }),
    (e: unknown) => (e as { code?: string }).code === 'BAD_SELECTOR',
  );
});

test('歧义报 TARGET_AMBIGUOUS 带候选', () => {
  const items = [
    { role: 'button', name: '确定提交表单第一项' },
    { role: 'button', name: '确定提交表单第二项' },
  ];
  assert.throws(
    () => assertUnique(items, 'text=确定'),
    (e: unknown) => {
      const err = e as Error & { code?: string };
      return err.code === 'TARGET_AMBIGUOUS' && err.message.includes('2 个匹配');
    },
  );
  assert.throws(
    () => assertUnique([], 'x'),
    (e: unknown) => (e as { code?: string }).code === 'TARGET_NOT_FOUND',
  );
});

test('pickNth 越界报 TARGET_NOT_FOUND', () => {
  assert.equal(pickNth(['a', 'b'], -1, 'x'), 'b');
  assert.equal(pickNth(['a', 'b'], 0, 'x'), 'a');
  assert.throws(
    () => pickNth(['a'], 5, 'x'),
    (e: unknown) => (e as { code?: string }).code === 'TARGET_NOT_FOUND',
  );
});
