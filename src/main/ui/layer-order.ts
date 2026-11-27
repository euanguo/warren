import type { ViewportRect } from '../../shared/types.ts';

/**
 * 窗口子视图的固定 6 层 Z-Order 栈（从底到顶）。
 *
 * 任何视图切换与挂载都必须经由这一张表重排，禁止业务模块直接调 `addChildView`
 * 去猜当前排在谁上面（历史事故：切 Tab 后新页把 InputShield 盖掉、attachBelow 残影）。
 */
export const LAYER_SLOTS = ['below', 'page', 'devtools', 'shield', 'splitter', 'overlay'] as const;

export type LayerSlot = (typeof LAYER_SLOTS)[number];

export interface SlotRecord<T> {
  view?: T;
  visible: boolean;
  bounds?: ViewportRect;
}

/**
 * 纯逻辑视图层顺序模型（不依赖 Electron，可用于单测断言不变式）。
 */
export class LayerOrderModel<T> {
  #slots: Record<LayerSlot, SlotRecord<T>> = {
    below: { visible: true },
    page: { visible: true },
    devtools: { visible: false },
    shield: { visible: false },
    splitter: { visible: false },
    overlay: { visible: false },
  };

  setSlot(slot: LayerSlot, view: T | undefined, bounds?: ViewportRect, visible?: boolean): void {
    const prev = this.#slots[slot];
    const defaultVisible =
      prev.view === undefined && view !== undefined ? slot === 'below' || slot === 'page' : prev.visible;
    this.#slots[slot] = {
      view,
      visible: view !== undefined ? (visible ?? defaultVisible) : false,
      bounds: bounds ?? prev.bounds,
    };
  }

  setBounds(slot: LayerSlot, bounds: ViewportRect): void {
    this.#slots[slot].bounds = bounds;
  }

  setVisible(slot: LayerSlot, visible: boolean): void {
    this.#slots[slot].visible = visible;
  }

  get(slot: LayerSlot): Readonly<SlotRecord<T>> {
    return this.#slots[slot];
  }

  /**
   * 计算从底到顶应当挂载进父 View 的有序视图序列。
   * 未设置的槽位不占位；同一个 view 引用去重（以更高层为准）。
   */
  orderedViews(): T[] {
    const result: T[] = [];
    const seen = new Set<T>();
    for (let i = LAYER_SLOTS.length - 1; i >= 0; i -= 1) {
      const view = this.#slots[LAYER_SLOTS[i]].view;
      if (view === undefined || seen.has(view)) continue;
      seen.add(view);
      result.unshift(view);
    }
    return result;
  }

  /** 判断实际子视图列表是否与期望槽序完全一致（含去重后顺序）。 */
  isInOrder(actualChildren: readonly T[]): boolean {
    const expected = this.orderedViews();
    const relevant = actualChildren.filter((child) => expected.includes(child));
    if (relevant.length !== expected.length) return false;
    return expected.every((view, index) => relevant[index] === view);
  }

  snapshot(): Record<LayerSlot, { attached: boolean; visible: boolean; bounds?: ViewportRect }> {
    return {
      below: {
        attached: this.#slots.below.view !== undefined,
        visible: this.#slots.below.visible && this.#slots.below.view !== undefined,
        bounds: this.#slots.below.bounds,
      },
      page: {
        attached: this.#slots.page.view !== undefined,
        visible: this.#slots.page.visible && this.#slots.page.view !== undefined,
        bounds: this.#slots.page.bounds,
      },
      devtools: {
        attached: this.#slots.devtools.view !== undefined,
        visible: this.#slots.devtools.visible && this.#slots.devtools.view !== undefined,
        bounds: this.#slots.devtools.bounds,
      },
      shield: {
        attached: this.#slots.shield.view !== undefined,
        visible: this.#slots.shield.visible && this.#slots.shield.view !== undefined,
        bounds: this.#slots.shield.bounds,
      },
      splitter: {
        attached: this.#slots.splitter.view !== undefined,
        visible: this.#slots.splitter.visible && this.#slots.splitter.view !== undefined,
        bounds: this.#slots.splitter.bounds,
      },
      overlay: {
        attached: this.#slots.overlay.view !== undefined,
        visible: this.#slots.overlay.visible && this.#slots.overlay.view !== undefined,
        bounds: this.#slots.overlay.bounds,
      },
    };
  }
}
