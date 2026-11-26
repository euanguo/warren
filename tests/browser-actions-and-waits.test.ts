import test from 'node:test';
import assert from 'node:assert/strict';
import { click, dblclick, hover } from '../src/main/browser/pointer-actions.ts';
import { fill } from '../src/main/browser/form-actions.ts';
import { screenshot } from '../src/main/browser/screenshot.ts';
import { waitForFunction, waitForSelector, waitForURL } from '../src/main/browser/waits.ts';
import { createFakePageContext } from './helpers/fake-cdp.ts';

test('pointer-actions：click / dblclick / hover 走可用性检查、派发键鼠并记录视觉轨迹', async () => {
  const h = createFakePageContext();
  const clicked = await click(h.ctx, '#submit', { noWaitAfter: true, label: '提交' });
  assert.equal(clicked.url, 'https://example.test/app');
  assert.equal(clicked.navigation, 'none');
  const types = h.inputCalls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params?.type);
  assert.ok(types.includes('mousePressed'));
  assert.ok(types.includes('mouseReleased'));
  assert.equal(h.visualActions[0]?.kind, 'click');

  h.inputCalls.length = 0;
  await dblclick(h.ctx, '#item', { noWaitAfter: true });
  const pressCounts = h.inputCalls
    .filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed')
    .map((c) => c.params?.clickCount);
  assert.deepEqual(pressCounts, [1, 2]);

  h.visualActions.length = 0;
  await hover(h.ctx, '#menu', { label: '菜单' });
  assert.equal(h.visualActions[0]?.kind, 'hover');
});

test('form-actions：fill 输入明文绝不进视觉轨迹，且不可编辑目标抛 TARGET_NOT_FILLABLE', async () => {
  const h = createFakePageContext({
    onSend: async (method, params) => {
      if (method === 'Runtime.callFunctionOn') {
        if (params?.returnByValue === false) return { result: {} };
        const decl = String(params?.functionDeclaration || '');
        if (decl.includes('numberInvalid')) {
          return {
            result: {
              value: { status: 'needsinput', selectedAll: true, isPassword: true, prevLength: 0 },
            },
          };
        }
        if (decl.includes('activeElement')) {
          return { result: { value: { value: 'ok', moved: false } } };
        }
      }
      return undefined;
    },
  });

  const secret = 'my-secret-pw-123';
  const res = await fill(h.ctx, '#password', secret);
  assert.equal(res.ok, true);
  assert.ok(h.inputCalls.some((c) => c.method === 'Input.insertText' && c.params?.text === secret));
  assert.ok(h.visualActions.every((v) => !String(v.label ?? '').includes(secret) && v.kind === 'fill'));

  const nonEditable = createFakePageContext({
    onSend: async (method, params) => {
      if (method === 'Runtime.callFunctionOn') {
        if (params?.returnByValue === false) return { result: {} };
        const decl = String(params?.functionDeclaration || '');
        if (decl.includes('numberInvalid')) {
          return { result: { value: { status: 'error', message: 'read-only field' } } };
        }
      }
      return undefined;
    },
  });
  await assert.rejects(
    () => fill(nonEditable.ctx, '#readonly', 'abc'),
    (error: Error & { code?: string }) => error.code === 'TARGET_NOT_FILLABLE',
  );
});

test('waits：waitForURL / waitForSelector / waitForFunction 超时与弹窗透传行为正确', async () => {
  const h = createFakePageContext({ url: 'https://example.test/start' });
  setTimeout(() => h.setUrl('https://example.test/done'), 40);
  const done = await waitForURL(h.ctx, { regex: '\\/done$' }, { timeoutMs: 1000 });
  assert.equal(done.url, 'https://example.test/done');

  const attached = await waitForSelector(h.ctx, '#ok', { state: 'attached', timeoutMs: 200 });
  assert.deepEqual(attached, {});

  const hiddenHarness = createFakePageContext({
    onSend: async (method) => {
      if (method === 'Runtime.callFunctionOn') return { result: { value: false } };
      return undefined;
    },
  });
  await assert.rejects(
    () => waitForSelector(hiddenHarness.ctx, '#invisible', { state: 'visible', timeoutMs: 80 }),
    (error: Error & { code?: string }) => error.code === 'TIMEOUT',
  );

  // DIALOG_OPEN 在 waitForFunction 内必须立刻透传，不能吞成 TIMEOUT
  h.setDialog({ type: 'alert', message: 'hi', url: 'https://example.test/done' });
  await assert.rejects(
    () => waitForFunction(h.ctx, '() => window.ready', undefined, { timeoutMs: 500, polling: 20 }),
    (error: Error & { code?: string }) => error.code === 'DIALOG_OPEN',
  );
});

test('screenshot：--annotate 无论成功失败都清理标注层，且 CDP 超时可兜底 Electron capturePage', async () => {
  const fallbackPng = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  );

  const annotateHarness = createFakePageContext({
    onSend: async (method) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1, backendNodeId: 1 } };
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 100 }],
        };
      }
      if (method === 'Page.captureScreenshot') throw new Error('cdp capture failed');
      return undefined;
    },
    capturedPng: fallbackPng,
  });

  const shot = await screenshot(annotateHarness.ctx, { annotate: true, encoding: 'base64' });
  assert.equal(shot.source, 'electron');
  assert.equal(shot.format, 'png');
  assert.equal(shot.annotations?.length, 1);
  assert.ok(
    annotateHarness.cdpCalls.some(
      (c) => c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('__warren_annotate_layer'),
    ),
  );
  assert.ok(
    annotateHarness.cdpCalls.some(
      (c) =>
        c.method === 'Runtime.evaluate' &&
        String(c.params?.expression).includes("getElementById('__warren_annotate_layer')?.remove()"),
    ),
  );
});
