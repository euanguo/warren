import type { BaseWindow, WebContentsView } from 'electron';
import { LAYER_SLOTS, LayerOrderModel, type LayerSlot } from './layer-order.ts';
import type { ViewportRect } from '../../shared/types.ts';

export type { LayerSlot };

/**
 * 窗口原生子视图的统一 Z-Order 控制器。
 *
 * 强制维护 `below → page → devtools → shield → splitter → overlay` 六层固定顺序，
 * 并统一在 `'page'`、`'devtools'` 与 `'shield'` 槽位应用圆角。
 */
export class WindowLayerManager {
  #window: BaseWindow;
  #model = new LayerOrderModel<WebContentsView>();
  #pageRadius = 8;
  #viewport: ViewportRect = { x: 0, y: 0, width: 800, height: 600 };
  #viewportReady = false;
  #viewVisible = true;

  constructor(window: BaseWindow, pageRadius = 8) {
    this.#window = window;
    this.#pageRadius = pageRadius;
  }

  /** 窗口内容区基线视口与页面原生视图可见态单一真相源。 */
  viewport(): ViewportRect {
    return this.#viewport;
  }

  isViewportReady(): boolean {
    return this.#viewportReady;
  }

  setViewport(rect: ViewportRect): void {
    if (rect.width <= 0 || rect.height <= 0) return;
    this.#viewport = rect;
    this.#viewportReady = true;
  }

  viewVisible(): boolean {
    return this.#viewVisible;
  }

  setViewVisible(visible: boolean): void {
    this.#viewVisible = visible;
  }

  setPageRadius(radius: number): void {
    this.#pageRadius = Math.max(0, Math.round(radius));
    for (const slot of ['page', 'devtools', 'shield'] as const) {
      const view = this.#model.get(slot).view;
      if (view) this.#applyBorderRadius(view, this.#pageRadius);
    }
  }

  setSlot(
    slot: LayerSlot,
    view: WebContentsView | undefined,
    options?: { visible?: boolean; bounds?: ViewportRect },
  ): void {
    const prev = this.#model.get(slot).view;
    if (prev && prev !== view) {
      this.#safeRemove(prev);
    }
    this.#model.setSlot(slot, view, options?.bounds);
    if (options?.visible !== undefined) this.#model.setVisible(slot, options.visible);
    if (view) {
      if (slot === 'page' || slot === 'devtools' || slot === 'shield') {
        this.#applyBorderRadius(view, this.#pageRadius);
      }
      this.restack();
      this.#syncSlotProps(slot);
    }
  }

  setBounds(slot: LayerSlot, bounds: ViewportRect): void {
    this.#model.setBounds(slot, bounds);
    const record = this.#model.get(slot);
    if (record.view && this.#isLive(record.view)) {
      record.view.setBounds(bounds);
      if (record.visible) record.view.webContents.invalidate?.();
    }
  }

  setVisible(slot: LayerSlot, visible: boolean): void {
    this.#model.setVisible(slot, visible);
    const record = this.#model.get(slot);
    if (record.view && this.#isLive(record.view)) {
      record.view.setVisible(visible);
      if (visible) record.view.webContents.invalidate?.();
    }
  }

  slotView(slot: LayerSlot): WebContentsView | undefined {
    return this.#model.get(slot).view;
  }

  restack(): void {
    const contentView = this.#window.contentView;
    const actual = contentView.children as WebContentsView[];
    const expected = this.#model.orderedViews();
    if (this.#model.isInOrder(actual)) {
      return;
    }
    // 快路径：仅新挂入最底层 `'below'` 且其余上层视图已在正确顺序时，直接插在 index 0，
    // 避免把正在显示的 `'page'` / `'devtools'` / `'overlay'` 摘下重挂导致画面闪烁与焦点抖动。
    const belowView = this.#model.get('below').view;
    if (belowView && expected[0] === belowView && !actual.includes(belowView) && this.#isLive(belowView)) {
      const upper = expected.slice(1);
      const relevantUpper = actual.filter((child) => upper.includes(child));
      if (relevantUpper.length === upper.length && upper.every((view, index) => relevantUpper[index] === view)) {
        contentView.addChildView(belowView, 0);
        this.#syncSlotProps('below');
        return;
      }
    }
    for (const view of expected) {
      this.#safeRemove(view);
    }
    for (const view of expected) {
      if (!this.#isLive(view)) continue;
      contentView.addChildView(view);
    }
    for (const slot of LAYER_SLOTS) {
      this.#syncSlotProps(slot);
    }
  }

  snapshot() {
    return this.#model.snapshot();
  }

  #syncSlotProps(slot: LayerSlot): void {
    const record = this.#model.get(slot);
    if (!record.view || !this.#isLive(record.view)) return;
    if (record.bounds) record.view.setBounds(record.bounds);
    record.view.setVisible(record.visible);
    if (record.visible) record.view.webContents.invalidate?.();
  }

  #applyBorderRadius(view: WebContentsView, radius: number): void {
    if (!this.#isLive(view)) return;
    try {
      view.setBorderRadius(radius);
    } catch {
      // 某些平台或未初始化态不阻断流程
    }
  }

  #safeRemove(view: WebContentsView): void {
    try {
      this.#window.contentView.removeChildView(view);
    } catch {
      // 视图未挂在窗口上或已销毁时忽略
    }
  }

  #isLive(view: WebContentsView): boolean {
    try {
      const wc = view.webContents as Electron.WebContents | undefined;
      return Boolean(wc && !wc.isDestroyed());
    } catch {
      return false;
    }
  }
}
