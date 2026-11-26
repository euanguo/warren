import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLoginFieldScanScript,
  classifyLoginStep,
  detectLoginFields,
  selectLoginFields,
  type RawScannedControl,
} from '../src/main/browser/login-fields.ts';

function control(overrides: Partial<RawScannedControl>): RawScannedControl {
  return {
    tag: 'input',
    type: 'text',
    role: '',
    autocomplete: '',
    name: '',
    id: '',
    placeholder: '',
    ariaLabel: '',
    labelText: '',
    text: '',
    inputMode: '',
    maxLength: 0,
    formKey: 'f1',
    selector: 'input',
    inShadow: false,
    inSameOriginFrame: false,
    rect: { x: 100, y: 100, width: 240, height: 36 },
    order: 0,
    ...overrides,
  };
}

test('selectLoginFields：正确识别单步登录框并排除页面顶部搜索框', () => {
  const result = selectLoginFields('https://admin.example.test/login', [
    control({
      id: 'global-search',
      name: 'search',
      placeholder: '搜索文档',
      selector: '#global-search',
      formKey: 'f0',
      order: 0,
      rect: { x: 20, y: 12, width: 200, height: 30 },
    }),
    control({
      id: 'account',
      name: 'username',
      autocomplete: 'username',
      labelText: '账号',
      selector: '#account',
      formKey: 'f1',
      order: 1,
      rect: { x: 100, y: 140, width: 240, height: 36 },
    }),
    control({
      id: 'pwd',
      type: 'password',
      autocomplete: 'current-password',
      labelText: '密码',
      selector: '#pwd',
      formKey: 'f1',
      order: 2,
      rect: { x: 100, y: 190, width: 240, height: 36 },
    }),
    control({
      tag: 'button',
      type: 'button',
      text: '忘记密码',
      selector: 'button.forgot',
      formKey: 'f1',
      order: 3,
      rect: { x: 100, y: 240, width: 80, height: 30 },
    }),
    control({
      tag: 'button',
      type: 'submit',
      text: '登录',
      selector: 'button[type="submit"]',
      formKey: 'f1',
      order: 4,
      rect: { x: 100, y: 260, width: 240, height: 40 },
    }),
  ]);

  assert.equal(result.host, 'admin.example.test');
  assert.equal(result.step, 'single');
  assert.equal(result.fields.username?.selector, '#account');
  assert.equal(result.fields.password?.selector, '#pwd');
  assert.equal(result.fields.submit?.selector, 'button[type="submit"]');
  assert.equal(result.fields.totp, undefined);
});

test('selectLoginFields：识别两步登录（username-only）与 MFA（totp-only）场景', () => {
  const step1 = selectLoginFields('https://sso.example.test/step1', [
    control({
      type: 'email',
      autocomplete: 'email',
      placeholder: '输入工作邮箱',
      selector: 'input[type="email"]',
      order: 0,
    }),
    control({
      tag: 'button',
      type: 'submit',
      text: '下一步',
      selector: 'button.next',
      order: 1,
      rect: { x: 100, y: 180, width: 120, height: 36 },
    }),
  ]);
  assert.equal(step1.step, 'username-only');
  assert.equal(step1.fields.username?.selector, 'input[type="email"]');
  assert.equal(step1.fields.submit?.selector, 'button.next');

  const mfa = selectLoginFields('https://sso.example.test/mfa', [
    control({
      name: 'otp',
      autocomplete: 'one-time-code',
      inputMode: 'numeric',
      maxLength: 6,
      placeholder: '6 位动态验证码',
      selector: 'input[name="otp"]',
      order: 0,
    }),
    control({
      tag: 'button',
      type: 'submit',
      text: '验证',
      selector: 'button.verify',
      order: 1,
      rect: { x: 100, y: 180, width: 120, height: 36 },
    }),
  ]);
  assert.equal(mfa.step, 'totp-only');
  assert.equal(mfa.fields.totp?.selector, 'input[name="otp"]');
  assert.equal(mfa.fields.username, undefined);
});

test('selectLoginFields：跨源 OOPIF 候选自动退化为可跨会话定位的 label / role target', () => {
  const result = selectLoginFields('https://portal.example.test/', [
    control({
      type: 'password',
      id: 'inner-pwd',
      labelText: '登录密码',
      selector: '#inner-pwd',
      frameId: 'frame-oopif',
      inCrossOriginFrame: true,
      order: 0,
    }),
    control({
      tag: 'button',
      type: 'submit',
      text: 'Sign in',
      selector: 'button.signin',
      frameId: 'frame-oopif',
      inCrossOriginFrame: true,
      order: 1,
      rect: { x: 100, y: 180, width: 120, height: 36 },
    }),
  ]);

  assert.equal(result.step, 'password-only');
  assert.equal(result.fields.password?.inCrossOriginFrame, true);
  assert.deepEqual(result.fields.password?.target, { kind: 'label', text: '登录密码' });
  assert.deepEqual(result.fields.submit?.target, { kind: 'role', role: 'button', name: 'Sign in' });
  assert.equal(classifyLoginStep({}), 'none');
});

test('detectLoginFields：在隔离世界中同时聚合主会话与跨源子会话', async () => {
  const seenSessions: Array<string | undefined> = [];
  const fakeCtx = {
    wc: { getURL: () => 'https://app.example.test/login' },
    childSessions: () => [{ sessionId: 'child-1', frameId: 'frame-child', url: 'https://auth.example.test/embed' }],
    sendOn: async (sessionId: string | undefined, method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-main' } } };
      if (method === 'Page.createIsolatedWorld') {
        seenSessions.push(sessionId);
        return { executionContextId: sessionId ? 202 : 101 };
      }
      if (method === 'Runtime.evaluate') {
        if (!sessionId) return { result: { value: [] } };
        return {
          result: {
            value: [
              control({
                id: 'u',
                autocomplete: 'username',
                labelText: '邮箱',
                selector: '#u',
                order: 0,
              }),
              control({
                id: 'p',
                type: 'password',
                autocomplete: 'current-password',
                labelText: '密码',
                selector: '#p',
                order: 1,
                rect: { x: 100, y: 150, width: 240, height: 36 },
              }),
            ],
          },
        };
      }
      return {};
    },
  } as never;

  const detected = await detectLoginFields(fakeCtx);
  assert.deepEqual(seenSessions, [undefined, 'child-1']);
  assert.equal(detected.step, 'single');
  assert.equal(detected.fields.username?.inCrossOriginFrame, true);
  assert.equal(detected.fields.password?.inCrossOriginFrame, true);
  assert.ok(buildLoginFieldScanScript().includes('shadowRoot'));
});
