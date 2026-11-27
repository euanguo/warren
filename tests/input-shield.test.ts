import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShieldHtml, shouldShieldAnimate } from '../src/main/ui/input-shield-view.ts';

test('shouldShieldAnimate：仅在挂载+可见+agent+未开启减弱动态时启用动态光效', () => {
  assert.equal(
    shouldShieldAnimate({ attached: true, visible: true, mode: 'agent', reducedMotion: false, hidden: false }),
    true,
  );
  assert.equal(shouldShieldAnimate({ attached: false, visible: true, mode: 'agent', reducedMotion: false }), false);
  assert.equal(shouldShieldAnimate({ attached: true, visible: false, mode: 'agent', reducedMotion: false }), false);
  assert.equal(shouldShieldAnimate({ attached: true, visible: true, mode: 'idle', reducedMotion: false }), false);
  assert.equal(shouldShieldAnimate({ attached: true, visible: true, mode: 'agent', reducedMotion: true }), false);
  assert.equal(
    shouldShieldAnimate({ attached: true, visible: true, mode: 'agent', reducedMotion: false, hidden: true }),
    false,
  );
});

test('buildShieldHtml：采用流体棱镜纯 CSS 护盾（零 WebGL/rAF），支持双节律与接管/结束双动作', () => {
  const html = buildShieldHtml();
  assert.equal(html.includes('id="shield-gl"'), false);
  assert.equal(html.includes('getContext('), false);
  assert.equal(html.includes('requestAnimationFrame'), false);
  assert.ok(html.includes('id="aura"'));
  assert.ok(html.includes('id="prism-ring"'));
  assert.ok(html.includes('id="prism-glow"'));
  assert.ok(html.includes('corner-mark tl'));
  assert.ok(html.includes('id="sweep"'));
  assert.ok(html.includes('id="target-box"'));
  assert.ok(html.includes('id="ripple"'));
  assert.ok(html.includes('id="status-timer"'));
  assert.ok(html.includes('data-phase="acting"'));
  assert.ok(html.includes('data-stale="false"'));
  assert.ok(html.includes('prefers-reduced-motion: reduce'));
  assert.ok(html.includes('__warrenShieldStats'));
  assert.ok(html.includes('warren-action://takeover'));
  assert.ok(html.includes('warren-action://finish'));
  assert.ok(html.includes('点击顶栏「接管」可暂停'));
});
