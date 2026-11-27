import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export interface PanelResizerSnapConfig {
  /** 紧凑图标轨道的目标宽度（px，例如 72）。 */
  compactValue: number;
  /** 当前是否处于紧凑模式。 */
  compact: boolean;
  /** 向内拖过该宽度阈值时吸附进紧凑模式（迟滞下界，例如 110）。 */
  collapseThreshold: number;
  /** 紧凑态下向外拖过该宽度阈值时弹回展开模式（迟滞上界，例如 118）。 */
  expandThreshold: number;
  onCompactChange: (compact: boolean) => void;
}

export interface PanelResizerProps {
  label: string;
  controls: string;
  /** `left` = 控制左侧面板宽度；`right` = 控制右侧面板宽度。 */
  direction: "left" | "right";
  value: number;
  defaultValue: number;
  min: number;
  max: number | (() => number);
  onResize: (value: number) => void;
  onResizeEnd?: (value: number) => void;
  onReset?: () => void;
  snap?: PanelResizerSnapConfig;
  className?: string;
}

/**
 * OpenBot 风格无边框面板拖拽分割条：
 * - 平时视觉完全隐形（0px 占位 + 16px 跨缝隐形热区）；
 * - 悬停 / 键盘聚焦 / 拖拽中居中浮现 1px 竖向渐隐发丝线；
 * - 拖拽期间给 `html` 挂 `.panel-resizing` 冻结 240ms 布局过渡，松手恢复丝滑动画；
 * - 支持双阈值迟滞吸附紧凑态（`snap`）、双击复位默认值、键盘方向键与 Home/End 微调。
 */
export function PanelResizer({
  label,
  controls,
  direction,
  value,
  defaultValue,
  min,
  max,
  onResize,
  onResizeEnd,
  onReset,
  snap,
  className,
}: PanelResizerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const propsRef = useRef({ value, defaultValue, min, max, onResize, onResizeEnd, onReset, snap, direction });
  useEffect(() => {
    propsRef.current = { value, defaultValue, min, max, onResize, onResizeEnd, onReset, snap, direction };
  });

  const resolveMax = useCallback(() => {
    const current = propsRef.current;
    const raw = typeof current.max === "function" ? current.max() : current.max;
    return Math.max(current.min, raw);
  }, []);

  const clampValue = useCallback(
    (next: number) => {
      const { min: currentMin } = propsRef.current;
      return Math.round(Math.min(resolveMax(), Math.max(currentMin, next)));
    },
    [resolveMax],
  );

  const resolveWithSnap = useCallback(
    (rawWidth: number, currentCompact: boolean) => {
      const currentSnap = propsRef.current.snap;
      if (!currentSnap) {
        return { compact: false, width: clampValue(rawWidth) };
      }
      if (currentCompact) {
        return rawWidth < currentSnap.expandThreshold
          ? { compact: true, width: currentSnap.compactValue }
          : { compact: false, width: clampValue(Math.max(propsRef.current.min, rawWidth)) };
      }
      return rawWidth < currentSnap.collapseThreshold
        ? { compact: true, width: currentSnap.compactValue }
        : { compact: false, width: clampValue(rawWidth) };
    },
    [clampValue],
  );

  const withoutTransition = useCallback((action: () => void) => {
    document.documentElement.classList.add("panel-resizing");
    action();
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("panel-resizing");
    });
  }, []);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      document.documentElement.classList.remove("panel-resizing");
    };
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    dragCleanupRef.current?.();
    const startX = event.clientX;
    const initialSnap = propsRef.current.snap;
    const startWidth = initialSnap?.compact ? initialSnap.compactValue : propsRef.current.value;
    let activeCompact = Boolean(initialSnap?.compact);
    let lastWidth = startWidth;

    const rootEl = rootRef.current;
    if (rootEl) rootEl.dataset.dragging = "true";
    document.documentElement.classList.add("panel-resizing");

    const applyDelta = (clientX: number, commit: boolean) => {
      const delta = clientX - startX;
      const raw = startWidth + (propsRef.current.direction === "left" ? delta : -delta);
      const next = resolveWithSnap(raw, activeCompact);
      if (propsRef.current.snap && next.compact !== activeCompact) {
        activeCompact = next.compact;
        propsRef.current.snap.onCompactChange(next.compact);
      }
      if (!next.compact) {
        lastWidth = next.width;
        propsRef.current.onResize(next.width);
        if (commit) {
          propsRef.current.onResizeEnd?.(next.width);
        }
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      applyDelta(moveEvent.clientX, false);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (rootEl) delete rootEl.dataset.dragging;
      document.documentElement.classList.remove("panel-resizing");
      dragCleanupRef.current = null;
    };

    const onUp = (upEvent: PointerEvent) => {
      applyDelta(upEvent.clientX, true);
      cleanup();
    };

    const onCancel = () => {
      if (!activeCompact) {
        propsRef.current.onResizeEnd?.(lastWidth);
      }
      cleanup();
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const growKey = direction === "left" ? "ArrowRight" : "ArrowLeft";
    const shrinkKey = direction === "left" ? "ArrowLeft" : "ArrowRight";

    if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      withoutTransition(() => {
        if (snap) {
          snap.onCompactChange(true);
        } else {
          const next = clampValue(min);
          onResize(next);
          onResizeEnd?.(next);
        }
      });
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      withoutTransition(() => {
        if (snap?.compact) snap.onCompactChange(false);
        const next = resolveMax();
        onResize(next);
        onResizeEnd?.(next);
      });
      return;
    }

    if (event.key === growKey && snap?.compact) {
      event.preventDefault();
      event.stopPropagation();
      withoutTransition(() => {
        snap.onCompactChange(false);
        const next = clampValue(min);
        onResize(next);
        onResizeEnd?.(next);
      });
      return;
    }

    if (event.key === shrinkKey && snap && !snap.compact && value <= min) {
      event.preventDefault();
      event.stopPropagation();
      withoutTransition(() => {
        snap.onCompactChange(true);
      });
      return;
    }

    if (event.key === growKey || event.key === shrinkKey) {
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 24 : 12;
      const next = clampValue(value + (event.key === growKey ? step : -step));
      withoutTransition(() => {
        onResize(next);
        onResizeEnd?.(next);
      });
    }
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (onReset) {
      onReset();
      return;
    }
    if (snap?.compact) {
      snap.onCompactChange(false);
    }
    const next = clampValue(defaultValue);
    onResize(next);
    onResizeEnd?.(next);
  };

  const displayedWidth = snap?.compact ? snap.compactValue : value;
  const maxVal = typeof max === "function" ? Math.max(min, max()) : Math.max(min, max);

  return (
    <div
      ref={rootRef}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 可聚焦可拖拽面板分割条需带 aria-valuenow 语义，原生 <hr> 无法提供交互容器
      role="separator"
      tabIndex={0}
      data-slot="panel-resizer"
      data-direction={direction}
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={snap?.compactValue ?? min}
      aria-valuemax={maxVal}
      aria-valuenow={Math.round(displayedWidth)}
      aria-valuetext={snap?.compact ? `紧凑栏 ${snap.compactValue}px` : `${Math.round(value)}px`}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
      className={cn("warren-panel-resizer", className)}
    >
      <div className="warren-panel-resizer-hit">
        <span className="warren-panel-resizer-line" aria-hidden="true" />
      </div>
    </div>
  );
}
