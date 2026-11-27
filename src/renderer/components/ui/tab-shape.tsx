import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export interface TabShapeProps {
  /** 选中标签的 CSS 选择器（默认匹配 SurfaceTab 的 active 态）。 */
  selected?: string;
  /** 监听尺寸变化的子元素选择器。 */
  sized?: string;
  /** 可选水平滚动容器选择器，用于把滑块裁剪在可视区域内。 */
  scroller?: string;
  className?: string;
}

const WATCHED_ATTRIBUTES = ["aria-selected", "data-state", "data-selected", "style", "hidden"];
const TRAILING_EDGE_DELAY = "70ms";

function computeSlideDurationMs(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const durations = style.transitionDuration.split(",").map((value) => Number.parseFloat(value) * 1000 || 0);
  const delays = style.transitionDelay.split(",").map((value) => Number.parseFloat(value) * 1000 || 0);
  return Math.max(0, ...durations.map((duration, index) => duration + (delays[index % delays.length] ?? 0)));
}

/**
 * 顶栏凹角无界滑动标签背景（OpenBot TabShape 流体拖拽回弹移植）。
 *
 * 追踪父容器内当前激活标签的边界：切换标签时前进边 0ms 启动、尾随边延迟 70ms 追赶，
 * 底部左右通过 radial-gradient 绘制凹角圆弧无缝融进下方主画布卡片。
 */
export function TabShape({
  selected = '[data-slot="surface-tab"][data-state="active"]',
  sized = '[data-slot="surface-tab"]',
  scroller,
  className,
}: TabShapeProps) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    const row = element?.parentElement;
    if (!element || !row) return;

    let frame = 0;
    let lastTab: Element | null = null;
    let lastLeft: number | null = null;
    let lastRight = 0;
    let slideEnd = 0;
    let list: HTMLElement | null = null;
    const observed = new Set<Element>();

    const hide = () => {
      element.dataset.ready = "false";
      lastTab = null;
      lastLeft = null;
    };

    const watchList = () => {
      const next = scroller ? row.querySelector<HTMLElement>(scroller) : null;
      if (next === list) return;
      list?.removeEventListener("scroll", place);
      list = next;
      list?.addEventListener("scroll", place, { passive: true });
      lastLeft = null;
    };

    const place = () => {
      cancelAnimationFrame(frame);
      frame = 0;

      if (typeof getComputedStyle === "function" && getComputedStyle(element).display === "none") {
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

      const area = parent.getBoundingClientRect();
      const box = tab.getBoundingClientRect();
      if (area.width <= 0 || box.width <= 0) {
        hide();
        return;
      }

      const scale = parent.offsetWidth > 0 ? area.width / parent.offsetWidth : 1;
      let start = box.left;
      let end = box.right;
      if (list && list.contains(tab)) {
        const view = list.getBoundingClientRect();
        start = Math.max(start, view.left);
        end = Math.min(end, view.right);
      }

      if (end - start < 2) {
        hide();
        return;
      }

      const left = (start - area.left) / scale - parent.clientLeft;
      const width = (end - start) / scale;
      const right = Math.max(0, parent.clientWidth - left - width);
      const top = Math.max(2, (box.top - area.top) / scale - parent.clientTop);

      const shown = lastLeft !== null && element.dataset.ready === "true";
      const towardRight = lastLeft !== null && left > lastLeft;
      const now = performance.now();

      if (tab !== lastTab) {
        const moved =
          shown &&
          lastTab !== null &&
          lastLeft !== null &&
          (row.contains(lastTab) ? !lastTab.matches(selected) : left >= lastRight || left + width <= lastLeft);
        element.style.setProperty("--tab-left-delay", towardRight ? TRAILING_EDGE_DELAY : "0ms");
        element.style.setProperty("--tab-right-delay", towardRight ? "0ms" : TRAILING_EDGE_DELAY);
        slideEnd = moved ? now + computeSlideDurationMs(element) : 0;
      }

      lastTab = tab;
      const instant = !shown || now >= slideEnd;
      if (instant) {
        element.dataset.instant = "true";
      }
      element.dataset.ready = "true";
      element.style.setProperty("--tab-shape-left", `${left}px`);
      element.style.setProperty("--tab-shape-right", `${right}px`);
      element.style.setProperty("--tab-shape-top", `${top}px`);

      if (instant) {
        // 强制同步刷新一次布局，确保首次定位不产生滑入闪烁
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

    const sizes = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    sizes?.observe(row);

    const changes =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver((records) => {
            if (records.some((record) => record.target !== element)) {
              schedule();
            }
          })
        : null;
    changes?.observe(row, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });

    row.addEventListener("transitionend", schedule);
    window.addEventListener("resize", schedule);
    place();

    return () => {
      cancelAnimationFrame(frame);
      changes?.disconnect();
      sizes?.disconnect();
      list?.removeEventListener("scroll", place);
      row.removeEventListener("transitionend", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [selected, sized, scroller]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-slot="tab-shape"
      data-ready="false"
      className={cn("warren-tab-shape", className)}
    />
  );
}
