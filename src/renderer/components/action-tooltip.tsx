import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface ActionTooltipProps {
  label: string;
  description?: string;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement;
}

/**
 * 统一的操作提示浮层（label + 可选副说明 + Kbd）。
 *
 * DOM 弹层永远压在原生网页视图下方（紧凑侧栏的图标轨道、顶栏、地址栏都会中招），
 * 所以视觉画在 `OverlayHost` 的顶层：主窗只上报锚点矩形，宿主负责绘制并让命中测试穿透。
 * 这里保留一份 `sr-only` 的 `TooltipContent`，让 base-ui 的悬停/焦点状态机与
 * `aria-describedby` 照常工作。
 */
export function ActionTooltip({ label, description, shortcut, side = 'bottom', children }: ActionTooltipProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 触发元素被卸载（切 tab、关抽屉）时不留孤儿浮层。
  useEffect(() => () => void window.envApi.hideTooltip(), []);

  const show = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    void window.envApi.showTooltip({
      anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      side,
      label,
      description,
      shortcut,
    });
  };

  return (
    <Tooltip onOpenChange={(open) => (open ? show() : void window.envApi.hideTooltip())}>
      <TooltipTrigger ref={triggerRef} render={children} />
      <TooltipContent side={side} className="sr-only">
        <span className="inline-flex items-center gap-2 font-medium">
          <span>{label}</span>
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </span>
        {description ? <span className="text-[11px] opacity-75">{description}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
