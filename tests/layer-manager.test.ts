import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_SLOTS, LayerOrderModel } from '../src/main/ui/layer-order.ts';

test('LayerOrderModel 严格保持 5 层固定栈顺序', () => {
  const model = new LayerOrderModel<string>();
  assert.deepEqual([...LAYER_SLOTS], ['below', 'page', 'devtools', 'shield', 'overlay']);

  model.setSlot('overlay', 'V_OVERLAY');
  model.setSlot('below', 'V_BELOW');
  model.setSlot('shield', 'V_SHIELD');
  model.setSlot('page', 'V_PAGE');
  model.setSlot('devtools', 'V_DEVTOOLS');

  assert.deepEqual(model.orderedViews(), ['V_BELOW', 'V_PAGE', 'V_DEVTOOLS', 'V_SHIELD', 'V_OVERLAY']);
  assert.equal(model.isInOrder(['V_BELOW', 'V_PAGE', 'V_DEVTOOLS', 'V_SHIELD', 'V_OVERLAY']), true);
  assert.equal(model.isInOrder(['V_BELOW', 'V_SHIELD', 'V_PAGE', 'V_DEVTOOLS', 'V_OVERLAY']), false);
});

test('LayerOrderModel 支持同视图升槽位去重并清理旧槽', () => {
  const model = new LayerOrderModel<string>();
  model.setSlot('below', 'TAB_1');
  model.setSlot('page', 'TAB_1');
  assert.deepEqual(model.orderedViews(), ['TAB_1']);

  model.setSlot('below', undefined);
  assert.deepEqual(model.orderedViews(), ['TAB_1']);
});

test('LayerOrderModel snapshot 只报告已挂载且可见的槽位', () => {
  const model = new LayerOrderModel<string>();
  model.setSlot('page', 'P1');
  model.setVisible('page', true);
  model.setVisible('overlay', true);
  const snap = model.snapshot();
  assert.equal(snap.page.attached, true);
  assert.equal(snap.page.visible, true);
  assert.equal(snap.overlay.attached, false);
  assert.equal(snap.overlay.visible, false);
});
