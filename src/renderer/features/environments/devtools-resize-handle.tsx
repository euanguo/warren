import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@/lib/utils';
import {
  clampDevToolsSize,
  defaultDevToolsSize,
  maxDevToolsSize,
  minDevToolsSize,
  type DockedDevToolsMode,
} from '@shared/devtools-layout';
import type { ViewportRect } from '@shared/types';

interface DevToolsResizeHandleProps {
  dock: DockedDevToolsMode;
  size: number;
  viewport: ViewportRect;
  gap: ViewportRect;
  onResize: (dock: DockedDevToolsMode, nextSize: number) => void;
  onReset: (dock: DockedDevToolsMode) => void;
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 40;

/**
 * 渲染层 DevTools 停靠分栏手柄（与主进程 `'splitter'` 原生层协同）：
 * - 真机鼠标拖拽由顶层透明 `'splitter'` 原生视图承接（防止跨 `WebContentsView` 丢事件与光标闪烁）；
 * - 本节点补齐 `role="separator"` 无障碍语义、键盘方向键调宽/调高与无头 UI 测试入口。
 */
export function DevToolsResizeHandle({ dock, size, viewport, gap, onResize, onReset }: DevToolsResizeHandleProps) {
  const isRight = dock === 'right';
  const min = minDevToolsSize(dock);
  const max = maxDevToolsSize(dock, viewport);
  const current = clampDevToolsSize(dock, size, viewport);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number | undefined;
    if (isRight) {
      if (event.key === 'ArrowLeft') next = clampDevToolsSize('right', current + step, viewport);
      else if (event.key === 'ArrowRight') next = clampDevToolsSize('right', current - step, viewport);
    } else {
      if (event.key === 'ArrowUp') next = clampDevToolsSize('bottom', current + step, viewport);
      else if (event.key === 'ArrowDown') next = clampDevToolsSize('bottom', current - step, viewport);
    }
    if (event.key === 'Home') next = max;
    else if (event.key === 'End') next = min;
    else if (event.key === 'Enter') {
      event.preventDefault();
      onReset(dock);
      return;
    }
    if (next !== undefined) {
      event.preventDefault();
      if (next !== current) onResize(dock, next);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = current;
    let latest = startSize;

    const onMove = (moveEvent: PointerEvent) => {
      const delta = isRight ? startX - moveEvent.clientX : startY - moveEvent.clientY;
      const next = clampDevToolsSize(dock, startSize + delta, viewport);
      if (next !== latest) {
        latest = next;
        onResize(dock, next);
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 可交互分栏手柄需要 focusable role="separator"（与 react-resizable-panels 一致），<hr> 是空元素且带 UA 样式
      role="separator"
      tabIndex={0}
      data-slot="devtools-resize-handle"
      data-dock={dock}
      aria-label={isRight ? '调整右侧 DevTools 宽度' : '调整底部 DevTools 高度'}
      aria-orientation={isRight ? 'vertical' : 'horizontal'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={current}
      style={{ left: gap.x, top: gap.y, width: gap.width, height: gap.height }}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => onResize(dock, clampDevToolsSize(dock, defaultDevToolsSize(dock), viewport))}
      className={cn(
        'absolute z-10 outline-none select-none',
        isRight ? 'cursor-col-resize' : 'cursor-row-resize',
        'after:absolute after:bg-transparent after:transition-colors focus-visible:after:bg-focus',
        isRight
          ? 'after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2'
          : 'after:inset-x-0 after:top-1/2 after:h-[2px] after:-translate-y-1/2',
      )}
    />
  );
}
