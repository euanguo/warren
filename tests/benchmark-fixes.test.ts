import assert from 'node:assert/strict';
import test from 'node:test';
import { checkActionable } from '../src/main/browser/actionability.ts';
import { describeDomNode, evaluateHitAcceptance, isHitAcceptable } from '../src/main/browser/click-point.ts';
import type { PageContext } from '../src/main/browser/ctx.ts';
import { evaluate } from '../src/main/browser/escape.ts';
import { emptyPending } from '../src/main/browser/page-helpers.ts';
import { isActionableRole } from '../src/main/browser/roles.ts';

function makeMockCtx(handler: (method: string, params?: Record<string, unknown>) => unknown): PageContext {
  return {
    send: async (method: string, params?: Record<string, unknown>) => handler(method, params) as never,
    sendOn: async (_sessionId: string | undefined, method: string, params?: Record<string, unknown>) =>
      handler(method, params) as never,
  } as unknown as PageContext;
}

test('evaluateHitAcceptance 在命中 ::before 伪元素无法 resolveNode 时返回 unresolvable 而非 blocked', async () => {
  const released: string[] = [];
  const ctx = makeMockCtx((method, params) => {
    if (method === 'DOM.resolveNode') {
      if (params?.backendNodeId === 101) return { object: { objectId: 'obj-target' } };
      // 模拟 FontAwesome i::before 伪元素无法解析为 JS 对象
      return { object: {} };
    }
    if (method === 'Runtime.releaseObject') {
      released.push(String(params?.objectId));
      return {};
    }
    return {};
  });

  const verdict = await evaluateHitAcceptance(ctx, 101, 202);
  assert.equal(verdict, 'unresolvable');
  assert.deepEqual(released, ['obj-target']);
  // 向后兼容的 isHitAcceptable 仍仅在明确 accepted 时返回 true
  assert.equal(await isHitAcceptable(ctx, 101, 202), false);
});

test('checkActionable 在 CDP 命中伪元素且 Shadow DOM elementFromPoint 通过时放行点击', async () => {
  const ctx = makeMockCtx((method, params) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [11] };
    if (method === 'DOM.resolveNode') {
      if (params?.nodeId === 11) return { object: { objectId: 'obj-eval' } };
      if (params?.backendNodeId === 101) return { object: { objectId: 'obj-target' } };
      return { object: {} };
    }
    if (method === 'Runtime.callFunctionOn') {
      return {
        result: {
          value: {
            visible: true,
            stable: true,
            enabled: true,
            editable: false,
            inert: false,
            inViewport: true,
            floatingFlyout: false,
            hit: { ok: true },
          },
        },
      };
    }
    if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 50, 10, 50, 40, 10, 40]] };
    if (method === 'Page.getLayoutMetrics')
      return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 202 };
    return {};
  });

  await assert.doesNotReject(() => checkActionable(ctx, 101, ['visible', 'stable', 'enabled', 'receivesEvents']));
});

test('checkActionable 在 CDP 命中伪元素但 snapshot.hit 判定为外部伪元素遮罩时仍拦截 TARGET_OCCLUDED', async () => {
  const ctx = makeMockCtx((method, params) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [11] };
    if (method === 'DOM.resolveNode') {
      if (params?.nodeId === 11) return { object: { objectId: 'obj-eval' } };
      if (params?.backendNodeId === 101) return { object: { objectId: 'obj-target' } };
      return { object: {} };
    }
    if (method === 'Runtime.callFunctionOn') {
      return {
        result: {
          value: {
            visible: true,
            stable: true,
            enabled: true,
            editable: false,
            inert: false,
            inViewport: true,
            floatingFlyout: false,
            hit: { ok: false, blocker: 'div.modal-backdrop' },
          },
        },
      };
    }
    if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 50, 10, 50, 40, 10, 40]] };
    if (method === 'Page.getLayoutMetrics')
      return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 202 };
    return {};
  });

  await assert.rejects(
    () => checkActionable(ctx, 101, ['visible', 'stable', 'enabled', 'receivesEvents']),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'TARGET_OCCLUDED');
      assert.match(String(err.message), /modal-backdrop/);
      return true;
    },
  );
});

test('checkActionable 在真实元素遮挡（evaluateHitAcceptance === blocked）时直接抛 TARGET_OCCLUDED', async () => {
  const ctx = makeMockCtx((method, params) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [11] };
    if (method === 'DOM.resolveNode') {
      if (params?.nodeId === 11) return { object: { objectId: 'obj-eval' } };
      if (params?.backendNodeId === 101) return { object: { objectId: 'obj-target' } };
      if (params?.backendNodeId === 303) return { object: { objectId: 'obj-blocker' } };
      return { object: {} };
    }
    if (method === 'Runtime.callFunctionOn') {
      if (params?.objectId === 'obj-target') return { result: { value: false } };
      return {
        result: {
          value: {
            visible: true,
            stable: true,
            enabled: true,
            editable: false,
            inert: false,
            inViewport: true,
            floatingFlyout: false,
            hit: { ok: true },
          },
        },
      };
    }
    if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 50, 10, 50, 40, 10, 40]] };
    if (method === 'Page.getLayoutMetrics')
      return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 303 };
    if (method === 'Accessibility.getPartialAXTree')
      return { nodes: [{ role: { value: 'button' }, name: { value: 'Green' } }] };
    return {};
  });

  await assert.rejects(
    () => checkActionable(ctx, 101, ['receivesEvents']),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'TARGET_OCCLUDED');
      assert.match(String(err.message), /Green/);
      return true;
    },
  );
});

test('describeDomNode 在伪元素无 nodeId 时退回 DOM.describeNode 输出 ::before', async () => {
  const ctx = makeMockCtx((method) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [0] };
    if (method === 'DOM.describeNode') return { node: { pseudoType: 'before', localName: '' } };
    return {};
  });
  assert.equal(await describeDomNode(ctx, 999), '::before');
});

test('roles 白名单包含 draggable 与 droppable 供拖拽补盲使用', () => {
  assert.equal(isActionableRole('draggable'), true);
  assert.equal(isActionableRole('droppable'), true);
});

test('evaluateHitAcceptance 在伪元素有 objectId 但 RELATION_CHECK 返回 false 时识别 pseudoType 并返回 unresolvable', async () => {
  const ctx = makeMockCtx((method, params) => {
    if (method === 'DOM.resolveNode') {
      if (params?.backendNodeId === 101) return { object: { objectId: 'obj-target' } };
      if (params?.backendNodeId === 202) return { object: { objectId: 'obj-pseudo' } };
    }
    if (method === 'Runtime.callFunctionOn') return { result: { value: false } };
    if (method === 'DOM.describeNode') return { node: { pseudoType: 'before', localName: '' } };
    return {};
  });

  assert.equal(await evaluateHitAcceptance(ctx, 101, 202), 'unresolvable');
});

test('evaluate 在选中同源子 frame 时通过 Page.createIsolatedWorld 在目标帧内求值', async () => {
  const calls: Array<{ sessionId?: string; method: string; params?: Record<string, unknown> }> = [];
  const ctx = {
    pending: emptyPending(),
    activeFrameId: () => 'FRAME_LEFT',
    childSessions: () => [],
    sendOn: async (sessionId: string | undefined, method: string, params?: Record<string, unknown>) => {
      calls.push({ sessionId, method, params });
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'LEFT' } };
      return {};
    },
  } as unknown as PageContext;

  const out = await evaluate(ctx, 'document.body.innerText');
  assert.equal(out, 'LEFT');
  assert.equal(calls[0]?.method, 'Page.createIsolatedWorld');
  assert.equal(calls[0]?.params?.frameId, 'FRAME_LEFT');
  assert.equal(calls[1]?.method, 'Runtime.evaluate');
  assert.equal(calls[1]?.params?.contextId, 42);
});

test('evaluate 在选中跨源 OOPIF 子 frame 时路由到对应 child session', async () => {
  const calls: Array<{ sessionId?: string; method: string; params?: Record<string, unknown> }> = [];
  const ctx = {
    pending: emptyPending(),
    activeFrameId: () => 'OOPIF_FRAME_9',
    childSessions: () => [{ frameId: 'OOPIF_FRAME_9', sessionId: 'SID_9', url: 'https://cross.test/' }],
    sendOn: async (sessionId: string | undefined, method: string, params?: Record<string, unknown>) => {
      calls.push({ sessionId, method, params });
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'CROSS_OK' } };
      return {};
    },
  } as unknown as PageContext;

  const out = await evaluate(ctx, 'location.href');
  assert.equal(out, 'CROSS_OK');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sessionId, 'SID_9');
  assert.equal(calls[0]?.params?.contextId, undefined);
});
