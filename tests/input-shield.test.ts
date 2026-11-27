import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShieldHtml, SHIELD_PALETTES, shouldShieldAnimate } from '../src/main/domain/input-shield-view.ts';

test('shouldShieldAnimate：仅在挂载+可见+agent+未开启减弱动态时开启渲染循环', () => {
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

test('buildShieldHtml：包含 EGO 三层 WebGL 着色器、浅深色板、降级回落与停帧探针', () => {
  const html = buildShieldHtml();
  assert.ok(html.includes('id="shield-gl"'));
  assert.ok(html.includes('fbm_norm'));
  assert.ok(html.includes('fbm_grid'));
  assert.ok(html.includes('sampleStroke'));
  assert.ok(html.includes('uTrail[15]'));
  assert.ok(html.includes("powerPreference: 'low-power'"));
  assert.ok(html.includes('webgl-fallback'));
  assert.ok(html.includes('__warrenShieldStats'));
  assert.ok(html.includes('warren-action://takeover'));
  assert.ok(html.includes(JSON.stringify(SHIELD_PALETTES.dark.borderAccent)));
  assert.ok(html.includes(JSON.stringify(SHIELD_PALETTES.light.borderAccent)));
});
