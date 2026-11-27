import test from 'node:test';
import assert from 'node:assert/strict';
import type { BaseWindow, WebContentsView } from 'electron';
import { WindowLayerManager } from '../src/main/ui/layer-manager.ts';
import { LAYER_SLOTS, LayerOrderModel } from '../src/main/ui/layer-order.ts';

test('LayerOrderModel 严格保持 6 层固定栈顺序', () => {
  const model = new LayerOrderModel<string>();
  assert.deepEqual([...LAYER_SLOTS], ['below', 'page', 'devtools', 'shield', 'splitter', 'overlay']);

  model.setSlot('overlay', 'V_OVERLAY');
  model.setSlot('below', 'V_BELOW');
  model.setSlot('splitter', 'V_SPLITTER');
  model.setSlot('shield', 'V_SHIELD');
  model.setSlot('page', 'V_PAGE');
  model.setSlot('devtools', 'V_DEVTOOLS');

  assert.deepEqual(model.orderedViews(), ['V_BELOW', 'V_PAGE', 'V_DEVTOOLS', 'V_SHIELD', 'V_SPLITTER', 'V_OVERLAY']);
  assert.equal(model.isInOrder(['V_BELOW', 'V_PAGE', 'V_DEVTOOLS', 'V_SHIELD', 'V_SPLITTER', 'V_OVERLAY']), true);
  assert.equal(model.isInOrder(['V_BELOW', 'V_SHIELD', 'V_PAGE', 'V_DEVTOOLS', 'V_SPLITTER', 'V_OVERLAY']), false);
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

test('WindowLayerManager 插入 below 槽位时直接插到 index 0，不摘除重挂正在显示的 page', () => {
  const makeView = (name: string) => {
    const view = {
      name,
      bounds: undefined as unknown,
      visible: false,
      webContents: { isDestroyed: () => false },
      setBounds(b: unknown) {
        this.bounds = b;
      },
      setVisible(v: boolean) {
        this.visible = v;
      },
      setBorderRadius() {},
    };
    return view as unknown as WebContentsView & { name: string; bounds: unknown; visible: boolean };
  };

  const children: WebContentsView[] = [];
  const removed: WebContentsView[] = [];
  const added: Array<{ view: WebContentsView; index?: number }> = [];
  const fakeWindow = {
    contentView: {
      children,
      addChildView(view: WebContentsView, index?: number) {
        added.push({ view, index });
        if (typeof index === 'number') children.splice(index, 0, view);
        else children.push(view);
      },
      removeChildView(view: WebContentsView) {
        removed.push(view);
        const idx = children.indexOf(view);
        if (idx >= 0) children.splice(idx, 1);
      },
    },
  } as unknown as BaseWindow;

  const layers = new WindowLayerManager(fakeWindow);
  const pageView = makeView('page');
  const belowView = makeView('below');

  const pageRect = { x: 319, y: 134, width: 1114, height: 780 };
  layers.setSlot('page', pageView, { visible: true, bounds: pageRect });
  removed.length = 0;
  added.length = 0;

  layers.setSlot('below', belowView, { visible: true, bounds: pageRect });
  assert.deepEqual(children, [belowView, pageView]);
  assert.equal(removed.length, 0, '挂载 below 不应摘除正在显示的 page 视图');
  assert.equal(added.length, 1);
  assert.equal(added[0]?.index, 0);
  assert.deepEqual(belowView.bounds, pageRect);
});
