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

test('buildShieldHtml：采用 Ardia PowerUp+Halo 空心四边 WebGL2 物理光场（带纯 CSS 降级与按需停帧），支持双节律与接管/结束双动作', () => {
  const html = buildShieldHtml();
  assert.ok(html.includes('id="shield-canvas"'));
  assert.ok(html.includes('webgl2'));
  assert.ok(html.includes('sampleDiaSpectrum'));
  assert.ok(html.includes('srgbToOklab'));
  assert.ok(html.includes('haloNoise'));
  assert.ok(html.includes('buildHollowBorderGeometry'));
  assert.ok(html.includes('cancelAnimationFrame'));
  assert.ok(html.includes('visibilitychange'));
  assert.ok(html.includes('data-renderer="webgl2"'));
  assert.ok(html.includes('id="aura"'));
  assert.ok(html.includes('id="prism-ring"'));
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
