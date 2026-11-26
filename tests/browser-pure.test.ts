import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { parseChord, keyEvents, mouseButtonParams, modifierBitOf } from '../src/main/browser/input.ts';
import { RefTable } from '../src/main/browser/refs.ts';
import { checkCdpAllowed, guardSavePath, defaultCredentials, sanitizeFilename } from '../src/main/browser/policy.ts';
import { hostAllowed } from '../src/main/browser/policy.ts';
import { redactSecrets } from '../src/main/browser/redact.ts';
import { matchUrl, readyStateAtLeast } from '../src/main/browser/matcher.ts';
import { requiredStates, isRetryable, runAction } from '../src/main/browser/actionability.ts';
import { canFallbackToElectronScreenshot } from '../src/main/browser/screenshot-policy.ts';
import { withTimeout } from '../src/main/browser/timeout.ts';

test('chord 单字符保留大小写', () => {
  assert.deepEqual(parseChord('a'), { key: 'a', code: 'KeyA', modifiers: 0 });
  assert.deepEqual(parseChord('A'), { key: 'A', code: 'KeyA', modifiers: 0 });
});

test('chord 命名键大小写不敏感', () => {
  assert.equal(parseChord('enter').key, 'Enter');
  assert.equal(parseChord('ARROWLEFT').key, 'ArrowLeft');
});

test('chord 修饰键与 ControlOrMeta', () => {
  const c = parseChord('Control+Shift+T');
  assert.equal(c.modifiers & 2, 2, 'Control 位');
  assert.equal(c.modifiers & 8, 8, 'Shift 位');
  assert.equal(c.key, 'T');
  // ControlOrMeta 按平台展开成一边
  const m = parseChord('ControlOrMeta+A');
  assert.equal(m.modifiers === 2 || m.modifiers === 4, true);
});

test('chord 非法报 BAD_SELECTOR', () => {
  for (const bad of ['', 'Control+', 'Foo+Bar', 'NoSuchKey']) {
    assert.throws(
      () => parseChord(bad),
      (e: unknown) => (e as { code?: string }).code === 'BAD_SELECTOR',
      bad,
    );
  }
});

test('keyEvents 拼出 keyDown+keyUp', () => {
  const [down, up] = keyEvents('Control+A');
  assert.equal(down.type, 'keyDown');
  assert.equal(up.type, 'keyUp');
  assert.equal(down.modifiers, 2);
});

test('mouseButtonParams 三键', () => {
  assert.deepEqual(mouseButtonParams('left'), { button: 'left', buttons: 1 });
  assert.deepEqual(mouseButtonParams('middle'), { button: 'middle', buttons: 4 });
  assert.deepEqual(mouseButtonParams('right'), { button: 'right', buttons: 2 });
});

test('RefTable 注册解析与导航失效', () => {
  const refs = new RefTable();
  const [r1, r2] = refs.register([101, undefined, 103]);
  assert.equal(r1, '@1');
  assert.equal(r2, '@2');
  assert.equal(refs.resolve('@1').backendId, 101);
  assert.equal(refs.resolve('ref=2').backendId, 103);
  refs.bump();
  assert.throws(
    () => refs.resolve('@1'),
    (e: unknown) => (e as { code?: string }).code === 'TARGET_STALE',
  );
  assert.throws(
    () => refs.resolve('@9'),
    (e: unknown) => (e as { code?: string }).code === 'TARGET_STALE',
  );
});

test('cdp 白名单拦 Browser/Target 与整 profile 方法', () => {
  checkCdpAllowed('Page.captureScreenshot');
  checkCdpAllowed('Runtime.evaluate');
  checkCdpAllowed('DOM.getDocument');
  for (const bad of [
    'Browser.getVersion',
    'Target.getTargets',
    'Network.clearBrowserCookies',
    'Network.clearBrowserCache',
    'Storage.clearCookies',
    'Storage.clearDataForOrigin',
    'Network.enable',
    'Nope',
    'a.b.c',
  ]) {
    assert.throws(
      () => checkCdpAllowed(bad),
      (e: unknown) => (e as { code?: string }).code === 'CDP_BLOCKED',
      bad,
    );
  }
});

test('截图回退只覆盖可见视口，不伪装 fullPage/clip', () => {
  assert.equal(canFallbackToElectronScreenshot({}), true);
  assert.equal(canFallbackToElectronScreenshot({ format: 'jpeg' }), true);
  assert.equal(canFallbackToElectronScreenshot({ fullPage: true }), false);
  assert.equal(canFallbackToElectronScreenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }), false);
});

test('截图超时会把挂起的 CDP 转成可回退错误', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, 'cdp hang'),
    (error: Error & { code?: string }) => error.code === 'TIMEOUT' && /cdp hang/.test(error.message),
  );
  assert.equal(await withTimeout(Promise.resolve(42), 100, 'unused'), 42);
});

test('路径护栏禁数据目录与系统区', () => {
  assert.throws(
    () => guardSavePath('a/b.png'),
    (e: unknown) => (e as { code?: string }).code === 'PATH_DENIED',
  );
  const home = process.env.HOME ?? os.homedir();
  assert.throws(
    () => guardSavePath(`${home}/.warren/x`),
    (e: unknown) => (e as { code?: string }).code === 'PATH_DENIED',
  );
  assert.throws(
    () => guardSavePath('/etc/passwd'),
    (e: unknown) => (e as { code?: string }).code === 'PATH_DENIED',
  );
  assert.equal(guardSavePath('/tmp/x.png'), '/tmp/x.png');
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
});

test('fetch 凭据默认同站 include 跨站 omit', () => {
  assert.equal(defaultCredentials('http://a:8899/x', '/api', undefined), 'include');
  assert.equal(defaultCredentials('http://a:8899/x', 'http://b/y', undefined), 'omit');
  assert.equal(defaultCredentials('http://a/x', 'http://b/y', 'include'), 'include');
});

test('url matcher 三种形态', () => {
  assert.equal(matchUrl('https://a/b', 'a/b'), true);
  assert.equal(matchUrl('https://a/b?x=1', { regex: 'a/b\\?x=\\d' }), true);
  assert.equal(matchUrl('https://a/b/c', { glob: 'https://a/*/c' }), true);
  assert.equal(matchUrl('https://a/b', { glob: 'https://a/c' }), false);
  assert.throws(
    () => matchUrl('x', {} as never),
    (e: unknown) => (e as { code?: string }).code === 'BAD_REQUEST',
  );
});

test('readyState 判定', () => {
  assert.equal(readyStateAtLeast('loading', 'domcontentloaded'), false);
  assert.equal(readyStateAtLeast('interactive', 'domcontentloaded'), true);
  assert.equal(readyStateAtLeast('interactive', 'load'), false);
  assert.equal(readyStateAtLeast('complete', 'load'), true);
});

test('vault 域名名单：裸 host、子域继承、不传=不限', () => {
  assert.equal(hostAllowed('example.com', undefined), true);
  assert.equal(hostAllowed('example.com', []), true);
  assert.equal(hostAllowed('example.com', ['example.com']), true);
  assert.equal(hostAllowed('a.example.com', ['example.com']), true);
  assert.equal(hostAllowed('example.com', ['.example.com']), true);
  assert.equal(hostAllowed('evil-example.com', ['example.com']), false);
  assert.equal(hostAllowed('example.com.evil.com', ['example.com']), false);
  assert.equal(hostAllowed('other.com', ['example.com']), false);
  assert.equal(hostAllowed('', ['example.com']), false);
});

// ── 动作可用性与重试（对标 Playwright actionability / _retryAction）─────────

test('requiredStates 照抄 Playwright 的检查矩阵', () => {
  assert.deepEqual(requiredStates('click'), ['visible', 'stable', 'enabled', 'receivesEvents']);
  assert.deepEqual(requiredStates('hover'), ['visible', 'stable', 'receivesEvents']);
  assert.deepEqual(requiredStates('fill'), ['visible', 'enabled', 'editable']);
  assert.deepEqual(requiredStates('selectOption'), ['visible', 'enabled']);
  // 这三条在 Playwright 里是零检查：隐藏的 file input 是合法目标
  for (const action of ['focus', 'press', 'setInputFiles'] as const) {
    assert.deepEqual(requiredStates(action), [], action);
  }
});

test('isRetryable 只放行「等一等可能就好」的错误', () => {
  for (const code of ['TARGET_NOT_FOUND', 'NOT_ACTIONABLE', 'TARGET_OCCLUDED', 'NODE_DETACHED']) {
    assert.equal(isRetryable({ code }), true, code);
  }
  // 多匹配是定位写错了，等多久都不会变唯一 → 不重试（Playwright strict 模式同款）
  for (const code of [
    'TARGET_AMBIGUOUS',
    'BAD_SELECTOR',
    'PATH_DENIED',
    'DIALOG_OPEN',
    'TARGET_STALE',
    'CDP_BLOCKED',
  ]) {
    assert.equal(isRetryable({ code }), false, code);
  }
});

test('runAction 重试后成功，并重新执行 attempt', async () => {
  let attempts = 0;
  const result = await runAction({
    name: 'click #late',
    timeoutMs: 1000,
    attempt: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('元素未出现'), { code: 'TARGET_NOT_FOUND' });
      return 'clicked';
    },
  });
  assert.equal(result, 'clicked');
  assert.equal(attempts, 3, '必须重试到成功为止');
});

test('runAction 遇到不可重试的错误立刻抛出，不拖到超时', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      runAction({
        name: 'click #x',
        timeoutMs: 5000,
        attempt: async () => {
          attempts += 1;
          throw Object.assign(new Error('选择器非法'), { code: 'BAD_SELECTOR' });
        },
      }),
    (e: unknown) => (e as { code?: string }).code === 'BAD_SELECTOR',
  );
  assert.equal(attempts, 1);
});

test('runAction 超时抛 TIMEOUT 且带重试历史', async () => {
  await assert.rejects(
    () =>
      runAction({
        name: 'click #never',
        timeoutMs: 120,
        attempt: async () => {
          await new Promise((r) => setTimeout(r, 30));
          throw Object.assign(new Error('元素不可见（零尺寸或 visibility:hidden）'), {
            code: 'NOT_ACTIONABLE',
          });
        },
      }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, 'TIMEOUT');
      assert.match(String(err.message), /#1 NOT_ACTIONABLE/);
      return true;
    },
  );
});

// ── 键盘状态机 ────────────────────────────────────────────────────────────

test('modifierBitOf 认修饰键', () => {
  assert.equal(modifierBitOf('Shift'), 8);
  assert.equal(modifierBitOf('Control'), 2);
  assert.equal(modifierBitOf('Alt'), 1);
  assert.equal(modifierBitOf('Meta'), 4);
  assert.equal(modifierBitOf('a'), 0);
});

test('单字符键带 text，才会产生 keypress/input', () => {
  const [down] = keyEvents('b');
  assert.equal(down.text, 'b');
  assert.equal(down.unmodifiedText, 'b');
  const [named] = keyEvents('ArrowLeft');
  assert.equal(named.text, undefined, '命名键不该带 text');
});

test('按住 Shift 时单字符变大写（down(Shift) 后 press(a)）', () => {
  const [down] = keyEvents('a', { modifiers: 8 });
  assert.equal(down.key, 'A');
  assert.equal(down.text, 'A');
  assert.equal(down.unmodifiedText, 'a');
  assert.equal(down.modifiers, 8);
});

test('redactSecrets 按关键词脱敏：嵌套对象与数组都走到', () => {
  const { value, redacted } = redactSecrets({
    url: 'https://example.com/ok',
    password: 'p',
    nested: { token: 't', list: [{ sessionId: 's', keep: 1 }] },
    API_KEY: 'k',
  });
  assert.equal(redacted, true);
  assert.equal(value.url, 'https://example.com/ok');
  assert.equal(value.password, '[REDACTED]');
  assert.equal(value.nested.token, '[REDACTED]');
  assert.equal(value.nested.list[0]!.sessionId, '[REDACTED]');
  assert.equal(value.nested.list[0]!.keep, 1, '不匹配关键词的字段原样保留');
  assert.equal(value.API_KEY, '[REDACTED]', '关键词大小写不敏感');
});

test('redactSecrets 不改原对象；干净对象不误伤且 redacted=false', () => {
  const input = { password: 'p', ok: 'keep' };
  const { value, redacted } = redactSecrets(input);
  assert.equal(redacted, true);
  assert.equal(value.password, '[REDACTED]');
  assert.equal(input.password, 'p', '原对象不能被就地改写');

  const clean = { a: 1, b: ['x'], c: { d: null } };
  const cleanResult = redactSecrets(clean);
  assert.equal(cleanResult.redacted, false);
  assert.deepEqual(cleanResult.value, clean);
});
