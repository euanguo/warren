import { useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface TabShapeProps {
  /** 选中标签的 CSS 选择器（默认匹配 SurfaceTab 的 active 态）。 */
  selected?: string;
  /** 监听尺寸变化的子元素选择器。 */
  sized?: string;
  /** 可选水平滚动容器选择器，用于把滑块裁剪在可视区域内。 */
  scroller?: string;
  /** 作用域标识（如 envId:spaceId）：切换环境或空间时瞬时复位，避免跨空间滑飞。 */
  scopeKey?: string;
  /** 外部暂隐（例如指针拖拽激活标签期间，由标签本体接管实色表面，避免凹角拉丝）。 */
  suppressed?: boolean;
  className?: string;
}

const WATCHED_ATTRIBUTES = ['aria-selected', 'data-state', 'data-selected', 'data-dragged', 'data-frozen', 'style', 'hidden'];
const TRAILING_EDGE_DELAY = '70ms';

function computeSlideDurationMs(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const durations = style.transitionDuration.split(',').map((value) => Number.parseFloat(value) * 1000 || 0);
  const delays = style.transitionDelay.split(',').map((value) => Number.parseFloat(value) * 1000 || 0);
  return Math.max(0, ...durations.map((duration, index) => duration + (delays[index % delays.length] ?? 0)));
}

/**
 * 顶栏凹角无界滑动标签背景（对齐 OpenBot TabShape 几何、描边与流体回弹机制）。
 *
 * - 激活标签本体为 28px 垂直居中透明胶囊，TabShape 从激活标签顶边向下延伸到顶栏最底边，
 *   以 1px 发丝描边 + 双层 radial-gradient 凹角无缝融入下方主画布卡片；
 * - 切签时前进边 0ms 启动、尾随边延迟 70ms 追赶，形成平滑流体拉伸；
 * - 切环境/切空间、窗口缩放、侧栏调宽、滚轮滚动及拖拽排序期间按边界策略瞬时贴合或暂隐。
 */
export function TabShape({
  selected = '[data-slot="surface-tab"][data-state="active"]',
  sized = '[data-slot="surface-tab"]',
  scroller,
  scopeKey,
  suppressed = false,
  className,
}: TabShapeProps) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    const row = element?.parentElement;
    if (!element || !row) return;

    let frame = 0;
    let disposed = false;
    let lastTab: Element | null = null;
    let lastLeft: number | null = null;
    let lastRight = 0;
    let slideEnd = 0;
    let list: HTMLElement | null = null;
    const observed = new Set<Element>();

    const clearClip = () => {
      delete element.dataset.clipStart;
      delete element.dataset.clipEnd;
    };

    const hide = () => {
      element.dataset.hidden = 'true';
      element.dataset.ready = 'false';
      clearClip();
      lastTab = null;
      lastLeft = null;
      slideEnd = 0;
    };

    const watchList = () => {
      const next = scroller ? row.querySelector<HTMLElement>(scroller) : null;
      if (next === list) return;
      list?.removeEventListener('scroll', place);
      list = next;
      list?.addEventListener('scroll', place, { passive: true });
      lastLeft = null;
    };

    const place = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (disposed) return;

      if (suppressed) {
        hide();
        return;
      }

      if (typeof getComputedStyle === 'function' && getComputedStyle(element).display === 'none') {
        hide();
        return;
      }

      watchList();

      for (const part of observed) {
        if (!part.isConnected) {
          sizes?.unobserve(part);
          observed.delete(part);
        }
      }
      if (sizes) {
        for (const part of row.querySelectorAll(sized)) {
          if (observed.has(part)) continue;
          sizes.observe(part);
          observed.add(part);
        }
      }

      const tab = row.querySelector<HTMLElement>(selected);
      const parent = element.offsetParent instanceof HTMLElement ? element.offsetParent : row;
      if (!tab || !parent) {
        hide();
        return;
      }
      if (typeof tab.checkVisibility === 'function' && !tab.checkVisibility({ visibilityProperty: true })) {
        hide();
        return;
      }

      const area = parent.getBoundingClientRect();
      const box = tab.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (area.width <= 0 || box.width <= 0) {
        hide();
        return;
      }

      const scale = parent.offsetWidth > 0 ? area.width / parent.offsetWidth : 1;
      let start = box.left;
      let end = box.right;
      let clipStart = false;
      let clipEnd = false;
      if (list && list.contains(tab)) {
        const view = list.getBoundingClientRect();
        clipStart = box.left < view.left + 2;
        clipEnd = box.right > view.right - 2;
        start = Math.max(start, view.left);
        end = Math.min(end, view.right);
      }

      if (end - start < 6) {
        hide();
        return;
      }

      const left = (start - area.left) / scale - parent.clientLeft;
      const width = (end - start) / scale;
      const right = Math.max(0, parent.clientWidth - left - width);
      const top = Math.max(0, (box.top - area.top) / scale - parent.clientTop);
      const bottom = (rowRect.bottom - area.top) / scale - parent.clientTop;
      const height = Math.max(0, bottom - top);

      const shown = lastLeft !== null && element.dataset.hidden === undefined;
      const now = performance.now();

      if (tab !== lastTab) {
        const moved =
          shown &&
          lastTab !== null &&
          lastLeft !== null &&
          (row.contains(lastTab) ? !lastTab.matches(selected) : left >= lastRight || left + width <= lastLeft);

        // 连续快速切签打断上一段过渡时，以当前实际视觉左边缘作为新方向基准，防止反向折返抖动
        let originLeft = lastLeft;
        if (moved && now < slideEnd) {
          const visualRect = element.getBoundingClientRect();
          if (visualRect.width > 0) {
            originLeft = (visualRect.left - area.left) / scale - parent.clientLeft;
          }
        }
        const towardEnd = originLeft !== null && left > originLeft;
        element.style.setProperty('--tab-shape-start-delay', towardEnd ? TRAILING_EDGE_DELAY : '0ms');
        element.style.setProperty('--tab-shape-end-delay', towardEnd ? '0ms' : TRAILING_EDGE_DELAY);
        slideEnd = moved ? now + computeSlideDurationMs(element) : 0;
      }

      lastTab = tab;
      const instant = !shown || now >= slideEnd;
      if (instant) {
        element.dataset.instant = 'true';
      }
      delete element.dataset.hidden;
      element.dataset.ready = 'true';
      if (clipStart) element.dataset.clipStart = 'true';
      else delete element.dataset.clipStart;
      if (clipEnd) element.dataset.clipEnd = 'true';
      else delete element.dataset.clipEnd;

      element.style.setProperty('--tab-shape-left', `${left}px`);
      element.style.setProperty('--tab-shape-right', `${right}px`);
      element.style.setProperty('--tab-shape-top', `${top}px`);
      element.style.setProperty('--tab-shape-height', `${height}px`);

      if (instant) {
        // 强制同步刷新一次布局，确保首次落位或跨环境切换不产生滑入残影
        void element.getBoundingClientRect();
        delete element.dataset.instant;
      }

      lastLeft = left;
      lastRight = left + width;
    };

    const schedule = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          place();
        });
      }
    };

    const sizes = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    sizes?.observe(row);

    // 利用 ResizeObserver 在浏览器「布局后、绘制前」同帧触发的特性，消除切签 1 帧闪烁；
    // 同时保留 schedule 兜底兼容无头测试环境中的轻量 ResizeObserver stub。
    const changes =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver((records) => {
            if (!records.some((record) => record.target !== element)) return;
            if (sizes) {
              sizes.unobserve(row);
              sizes.observe(row);
            }
            schedule();
          })
        : null;
    changes?.observe(row, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });

    row.addEventListener('transitionend', schedule);
    row.addEventListener('animationend', schedule);
    window.addEventListener('resize', schedule);
    void document.fonts?.ready?.then(() => {
      if (!disposed) schedule();
    });
    place();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      changes?.disconnect();
      sizes?.disconnect();
      list?.removeEventListener('scroll', place);
      row.removeEventListener('transitionend', schedule);
      row.removeEventListener('animationend', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [selected, sized, scroller, scopeKey, suppressed]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-slot="tab-shape"
      data-hidden="true"
      data-ready="false"
      className={cn('warren-tab-shape', className)}
    />
  );
}
