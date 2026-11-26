import type { BaseWindow, WebContentsView } from 'electron';
import { LAYER_SLOTS, LayerOrderModel, type LayerSlot } from './layer-order.ts';
import type { ViewportRect } from '../../shared/types.ts';

export type { LayerSlot };

/**
 * 窗口原生子视图的统一 Z-Order 控制器。
 *
 * 强制维护 `below → page → devtools → shield → overlay` 五层固定顺序，
 * 并统一在 `'page'` 与 `'devtools'` 槽位应用圆角。
 */
export class WindowLayerManager {
  #window: BaseWindow;
  #model = new LayerOrderModel<WebContentsView>();
  #pageRadius = 8;

  constructor(window: BaseWindow, pageRadius = 8) {
    this.#window = window;
    this.#pageRadius = pageRadius;
  }

  setPageRadius(radius: number): void {
    this.#pageRadius = Math.max(0, Math.round(radius));
    const pageView = this.#model.get('page').view;
    if (pageView) this.#applyBorderRadius(pageView, this.#pageRadius);
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
      if (slot === 'page') this.#applyBorderRadius(view, this.#pageRadius);
      else if (slot === 'devtools') this.#applyBorderRadius(view, this.#pageRadius);
      this.restack();
      this.#syncSlotProps(slot);
    }
  }

  setBounds(slot: LayerSlot, bounds: ViewportRect): void {
    this.#model.setBounds(slot, bounds);
    const record = this.#model.get(slot);
    if (record.view && this.#isLive(record.view)) {
      record.view.setBounds(bounds);
    }
  }

  setVisible(slot: LayerSlot, visible: boolean): void {
    this.#model.setVisible(slot, visible);
    const record = this.#model.get(slot);
    if (record.view && this.#isLive(record.view)) {
      record.view.setVisible(visible);
    }
  }

  slotView(slot: LayerSlot): WebContentsView | undefined {
    return this.#model.get(slot).view;
  }

  restack(): void {
    const contentView = this.#window.contentView;
    const expected = this.#model.orderedViews();
    if (this.#model.isInOrder(contentView.children as WebContentsView[])) {
      return;
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
