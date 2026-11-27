import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSimulatedPageBounds } from '../src/shared/viewport-presets.ts';

test('computeSimulatedPageBounds：auto 完整铺满容器，非 auto 在画布中居中并按需等比缩放', () => {
  const container = { x: 280, y: 80, width: 1150, height: 830 };

  const auto = computeSimulatedPageBounds(container, 'auto');
  assert.equal(auto.emulated, false);
  assert.equal(auto.scale, 1);
  assert.deepEqual(auto.bounds, container);

  // mobile-390 在常见 830 高舞台里：水平完全居中，顶部保留标签边距，等比微缩到 ~0.9
  const mobile = computeSimulatedPageBounds(container, 'mobile-390');
  assert.equal(mobile.emulated, true);
  assert.equal(mobile.logicalWidth, 390);
  assert.equal(mobile.logicalHeight, 844);
  assert.ok(mobile.scale > 0.85 && mobile.scale < 1);
  assert.ok(
    Math.abs(
      mobile.bounds.x - container.x - (container.x + container.width - (mobile.bounds.x + mobile.bounds.width)),
    ) <= 1,
  );
  assert.ok(mobile.bounds.y - container.y >= 40);

  // desktop-1440 在 1150 宽容器里等比缩放到可用宽内并保持 16:10 比例与左右居中
  const desktop = computeSimulatedPageBounds(container, 'desktop-1440');
  assert.equal(desktop.emulated, true);
  assert.equal(desktop.logicalWidth, 1440);
  assert.equal(desktop.logicalHeight, 900);
  assert.ok(desktop.scale < 0.8);
  assert.ok(desktop.bounds.width < container.width - 40);
  assert.ok(Math.abs(desktop.bounds.width / desktop.bounds.height - 1440 / 900) < 0.02);
  assert.ok(
    Math.abs(
      desktop.bounds.x - container.x - (container.x + container.width - (desktop.bounds.x + desktop.bounds.width)),
    ) <= 1,
  );

  // 超大画布下无需缩小（scale = 1），上下左右完全对称居中
  const largeContainer = { x: 0, y: 0, width: 1800, height: 1200 };
  const unscaled = computeSimulatedPageBounds(largeContainer, 'mobile-390');
  assert.equal(unscaled.scale, 1);
  assert.equal(unscaled.bounds.width, 390);
  assert.equal(unscaled.bounds.height, 844);
  assert.equal(unscaled.bounds.x, Math.round((1800 - 390) / 2));
  assert.equal(unscaled.bounds.y, Math.round((1200 - 844) / 2));
});
