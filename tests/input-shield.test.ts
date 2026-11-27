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

test('buildShieldHtml：采用轻量纯 CSS 护盾（零 WebGL/rAF），并修复 showControlPill=false 误点黑洞', () => {
  const html = buildShieldHtml();
  assert.equal(html.includes('id="shield-gl"'), false);
  assert.equal(html.includes('getContext('), false);
  assert.equal(html.includes('requestAnimationFrame'), false);
  assert.ok(html.includes('id="aura"'));
  assert.ok(html.includes('id="sweep"'));
  assert.ok(html.includes('id="target-box"'));
  assert.ok(html.includes('id="ripple"'));
  assert.ok(html.includes('prefers-reduced-motion: reduce'));
  assert.ok(html.includes('__warrenShieldStats'));
  assert.ok(html.includes('warren-action://takeover'));
  assert.ok(html.includes('点击顶栏「接管」可暂停'));
});
