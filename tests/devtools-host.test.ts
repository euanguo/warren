import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebContents, WebContentsView } from 'electron';
import { DevToolsHost } from '../src/main/ui/devtools-host.ts';
import type { WindowLayerManager } from '../src/main/ui/layer-manager.ts';
import { LayerOrderModel, type LayerSlot } from '../src/main/ui/layer-order.ts';
import type { ViewportRect } from '../src/shared/types.ts';

class FakeWebContents extends EventEmitter {
  destroyed = false;
  devToolsOpened = false;
  devToolsWebContents: FakeWebContents | null = null;
  openCount = 0;
  openOptions: Array<{ mode?: string; activate?: boolean } | undefined> = [];
  focusCount = 0;
  closeDevToolsCount = 0;
  closeCount = 0;
  inspected: Array<{ x: number; y: number }> = [];
  #usesCustomHost = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isDevToolsOpened(): boolean {
    // 复现 Electron 45 真实行为：setDevToolsWebContents 宿主模式下原生恒为 false
    return this.#usesCustomHost ? false : this.devToolsOpened;
  }

  setDevToolsWebContents(wc: FakeWebContents): void {
    this.#usesCustomHost = true;
    this.devToolsWebContents = wc;
  }

  openDevTools(opts?: { mode?: string; activate?: boolean }): void {
    this.openCount += 1;
    this.openOptions.push(opts);
    if (!this.#usesCustomHost) {
      this.devToolsOpened = true;
    }
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('devtools-opened');
    });
  }

  closeDevTools(): void {
    this.closeDevToolsCount += 1;
    this.devToolsOpened = false;
    queueMicrotask(() => {
      this.#usesCustomHost = false;
      this.devToolsWebContents = null;
      this.emit('devtools-closed');
    });
  }

  close(): void {
    this.closeCount += 1;
    this.destroyed = true;
    this.emit('destroyed');
  }

  focus(): void {
    this.focusCount += 1;
  }

  inspectElement(x: number, y: number): void {
    this.inspected.push({ x, y });
  }
}

class FakeDockView {
  webContents = new FakeWebContents();
  bounds?: ViewportRect;
  visible = false;

  setBounds(bounds: ViewportRect): void {
    this.bounds = bounds;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }
}

function createFakeLayers() {
  const model = new LayerOrderModel<FakeDockView>();
  const fake = {
    setSlot(slot: LayerSlot, view: FakeDockView | undefined, options?: { visible?: boolean; bounds?: ViewportRect }) {
      model.setSlot(slot, view, options?.bounds);
      if (options?.visible !== undefined) model.setVisible(slot, options.visible);
    },
    setBounds(slot: LayerSlot, bounds: ViewportRect) {
      model.setBounds(slot, bounds);
      model.get(slot).view?.setBounds(bounds);
    },
    setVisible(slot: LayerSlot, visible: boolean) {
      model.setVisible(slot, visible);
      model.get(slot).view?.setVisible(visible);
    },
    slotView(slot: LayerSlot) {
      return model.get(slot).view;
    },
    snapshot() {
      return model.snapshot();
    },
  };
  return fake as unknown as WindowLayerManager;
}

test('DevToolsHost 在自定义宿主 isDevToolsOpened()=false 时仍正确跟踪开启、分栏与 right/bottom 复用', () => {
  const layers = createFakeLayers();
  let stateChanges = 0;
  const dockViews: FakeDockView[] = [];
  const host = new DevToolsHost(
    layers,
    () => {
      stateChanges += 1;
    },
    () => {
      const view = new FakeDockView();
      dockViews.push(view);
      return view as unknown as WebContentsView;
    },
  );
  host.setViewport({ x: 300, y: 120, width: 1200, height: 800 });

  const targetWc = new FakeWebContents();
  host.openForTab('tab-1', targetWc as unknown as WebContents, 'right');

  assert.equal(host.isOpen('tab-1'), true);
  assert.deepEqual(host.state(), { open: true, dock: 'right', size: 420 });
  assert.equal(dockViews.length, 1);
  const splitRight = host.computeSplitBounds();
  assert.deepEqual(splitRight.page, { x: 300, y: 120, width: 774, height: 800 });
  assert.deepEqual(splitRight.devtools, { x: 1080, y: 120, width: 420, height: 800 });

  host.setDockConfig('bottom', 300);
  assert.equal(dockViews.length, 1, 'right <-> bottom 切换应复用同一个 dockView');
  assert.deepEqual(host.state(), { open: true, dock: 'bottom', size: 300 });
  const splitBottom = host.computeSplitBounds();
  assert.deepEqual(splitBottom.page, { x: 300, y: 120, width: 1200, height: 494 });
  assert.deepEqual(splitBottom.devtools, { x: 300, y: 620, width: 1200, height: 300 });

  host.closeForTab('tab-1');
  assert.equal(host.isOpen('tab-1'), false);
  assert.equal(targetWc.closeDevToolsCount, 1);
  assert.equal(dockViews[0]?.webContents.closeCount, 1);
  assert.equal(layers.snapshot().devtools.attached, false);
  assert.ok(stateChanges >= 3);
});

test('DevToolsHost 在 docked <-> detach 切换时等待 devtools-closed 再打开，且不因旧监听误关', async () => {
  const layers = createFakeLayers();
  const dockViews: FakeDockView[] = [];
  const host = new DevToolsHost(
    layers,
    () => {},
    () => {
      const view = new FakeDockView();
      dockViews.push(view);
      return view as unknown as WebContentsView;
    },
  );
  host.setViewport({ x: 300, y: 120, width: 1200, height: 800 });

  const targetWc = new FakeWebContents();
  host.openForTab('tab-1', targetWc as unknown as WebContents, 'right');
  host.setDockConfig('detach');

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.isOpen('tab-1'), true);
  assert.equal(host.state().dock, 'detach');
  assert.equal(targetWc.openCount, 2);
  assert.equal(layers.snapshot().devtools.attached, false);
  assert.deepEqual(host.computeSplitBounds(), { page: { x: 300, y: 120, width: 1200, height: 800 } });

  host.setDockConfig('right');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.isOpen('tab-1'), true);
  assert.equal(host.state().dock, 'right');
  assert.equal(dockViews.length, 2);
  assert.equal(layers.snapshot().devtools.attached, true);

  // 模拟用户在 dockView 内关闭 DevTools（dockView 触发 destroyed）
  dockViews[1]!.webContents.close();
  assert.equal(host.isOpen('tab-1'), false);
});

test('DevToolsHost 在宿主主窗口失焦时传 activate=false 且不强行 focus，防止抢前台窗口', () => {
  const layers = createFakeLayers();
  let hostFocused = false;
  const host = new DevToolsHost(
    layers,
    () => {},
    () => new FakeDockView() as unknown as WebContentsView,
    () => hostFocused,
  );
  const targetWc = new FakeWebContents();
  host.openForTab('tab-bg', targetWc as unknown as WebContents, 'right');
  assert.deepEqual(targetWc.openOptions[0], { mode: 'detach', activate: false });

  const detachWc = new FakeWebContents();
  const dtWc = new FakeWebContents();
  detachWc.devToolsWebContents = dtWc;
  host.openForTab('tab-detach', detachWc as unknown as WebContents, 'detach');
  assert.deepEqual(detachWc.openOptions[0], { mode: 'detach', activate: false });
  host.openForTab('tab-detach', detachWc as unknown as WebContents, 'detach');
  assert.equal(dtWc.focusCount, 0, '失焦时重复打开 detach 不应窃走焦点');

  hostFocused = true;
  host.openForTab('tab-detach', detachWc as unknown as WebContents, 'detach');
  assert.equal(dtWc.focusCount, 1, '主窗口本就在前台时允许聚焦已有 DevTools');
});
