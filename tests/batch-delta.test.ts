import test from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch, hasWriteSteps, parseBatchLines, type BatchClient } from '../src/main/browser/ops/batch.ts';

test('parseBatchLines 与 hasWriteSteps 正确识别读写命令', () => {
  const steps = parseBatchLines(`
    # 打开登录页并提交
    goto https://example.test/login
    fill "input[name=user]" "alice"
    click "button:has-text(\\"Sign in\\")"
    wait 100
    snapshot -i
  `);
  assert.equal(steps.length, 5);
  assert.equal(hasWriteSteps(steps), true);

  const readOnly = parseBatchLines(`
    get title
    is visible @1
    snapshot -i
  `);
  assert.equal(hasWriteSteps(readOnly), false);
});

test('executeBatch --bail 在首个异常步骤中止并返回 Delta Receipt', async () => {
  let url = 'https://example.test/start';
  let title = 'Start';
  let callCount = 0;

  const client: BatchClient = {
    currentUrl: () => url,
    title: async () => title,
    async navigate(nextUrl: string) {
      url = nextUrl;
      title = 'Login';
      return { url };
    },
    goBack() {},
    goForward() {},
    async reload() {
      return {};
    },
    async click() {
      callCount += 1;
      throw Object.assign(new Error('button not found'), { code: 'TARGET_NOT_FOUND' });
    },
    async dblclick() {},
    async hover() {},
    async focus() {},
    async fill() {},
    async selectOption() {},
    async press() {},
    async waitForTimeout() {},
    async snapshot() {
      return url.endsWith('/login')
        ? [{ role: 'button', name: 'Submit', ref: '@1' }]
        : [{ role: 'link', name: 'Start Login' }];
    },
    async snapshotWithRefs() {
      return [{ role: 'button', name: 'Submit', ref: '@1' }];
    },
    async events() {
      return [{ kind: 'popup', url: 'https://example.test/pop' }];
    },
    async evaluate() {
      return { text: 'ok' };
    },
    async getProp() {
      return title;
    },
    async checkState() {
      return true;
    },
  };

  let netCall = 0;
  const out = await executeBatch({
    steps: [
      { cmd: 'goto', url: 'https://example.test/login' },
      { cmd: 'click', target: '#missing' },
      { cmd: 'get', prop: 'title' },
    ],
    bail: true,
    settleMs: 0,
    controller: client,
    networkEntries: () => {
      netCall += 1;
      if (netCall === 1) return [];
      return [{ method: 'POST', url: 'https://example.test/api/session', status: 200, resourceType: 'xhr', at: 'x' }];
    },
  });

  assert.equal(out.ok, false);
  assert.equal(out.abortedAt, 2);
  assert.equal(out.results.length, 2, '--bail 必须在第 2 步失败后立即停止，不执行第 3 步');
  assert.equal(callCount, 1);
  assert.equal(out.delta.urlChanged, true);
  assert.equal(out.delta.titleChanged, true);
  assert.deepEqual(out.delta.networkSummary, ['POST /api/session -> 200']);
  assert.equal(out.delta.events.length, 1);
  assert.equal(out.delta.interactiveDelta.addedCount, 1);
});
