import assert from 'node:assert/strict';
import test from 'node:test';
import { nextViewTransition } from '../src/main/environment-view-state.ts';

test('切到有视图的环境：摘旧挂新', () => {
  assert.deepEqual(nextViewTransition({ currentSelected: 'alpha', targetId: 'beta', targetHasView: true }), {
    detachCurrent: true,
    attachTarget: true,
  });
});

test('切到没启动的环境：摘旧、不挂新（这是修掉的那个 bug）', () => {
  // 目标没有视图时必须 detachCurrent=true，否则屏幕上留着上一个环境的页面；
  // 而且 attachTarget 必须是 false，不能凭空挂一个空视图上去。
  assert.deepEqual(nextViewTransition({ currentSelected: 'alpha', targetId: 'beta', targetHasView: false }), {
    detachCurrent: true,
    attachTarget: false,
  });
});

test('切回自己：什么都不动（别把当前视图摘了又挂一遍）', () => {
  assert.deepEqual(nextViewTransition({ currentSelected: 'alpha', targetId: 'alpha', targetHasView: true }), {
    detachCurrent: false,
    attachTarget: true,
  });
});

test('从没有选中态切过去：只挂新，不用摘', () => {
  assert.deepEqual(nextViewTransition({ currentSelected: undefined, targetId: 'alpha', targetHasView: true }), {
    detachCurrent: false,
    attachTarget: true,
  });
});
