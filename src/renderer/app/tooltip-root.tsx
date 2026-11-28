import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { useStandaloneThemeSync } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { elevatedTooltipSurfaceClass } from '@/theme/surface';
import type { OverlayTooltipRequest } from '@shared/types';

const GAP = 8;

/**
 * 把主窗里的锚点矩形换算成浮层内部坐标（纯函数，便于单测）。
 *
 * tooltip 子窗与主窗内容区同尺寸同原点，所以主窗的 `getBoundingClientRect()`
 * 可以直接当 CSS 坐标用。
 */
export function tooltipPlacement({ anchor, side }: Pick<OverlayTooltipRequest, 'anchor' | 'side'>): CSSProperties {
  const centerX = anchor.x + anchor.width / 2;
  const centerY = anchor.y + anchor.height / 2;
  switch (side) {
    case 'right':
      return { left: anchor.x + anchor.width + GAP, top: centerY, transform: 'translateY(-50%)' };
    case 'left':
      return { left: anchor.x - GAP, top: centerY, transform: 'translate(-100%, -50%)' };
    case 'bottom':
      return { left: centerX, top: anchor.y + anchor.height + GAP, transform: 'translateX(-50%)' };
    default:
      return { left: centerX, top: anchor.y - GAP, transform: 'translate(-50%, -100%)' };
  }
}

/** 原生 tooltip 窗口的渲染入口：只画，不接事件（窗口整体 ignoreMouseEvents）。 */
export function NativeTooltip({ request }: { request: OverlayTooltipRequest | null }) {
  if (!request) return null;
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
      <div
        data-slot="native-tooltip"
        style={tooltipPlacement(request)}
        className={cn(
          elevatedTooltipSurfaceClass,
          'absolute inline-flex w-fit max-w-xs items-center gap-2 px-2.5 py-1.5 text-[12px] leading-[16px] font-normal text-tooltip-foreground select-none',
          request.description ? 'flex-col items-start gap-0.5' : null,
        )}
      >
        <span className="inline-flex items-center gap-2 font-medium">
          <span>{request.label}</span>
          {request.shortcut ? <Kbd>{request.shortcut}</Kbd> : null}
        </span>
        {request.description ? <span className="text-[11px] opacity-75">{request.description}</span> : null}
      </div>
    </div>
  );
}

export function TooltipRoot() {
  useStandaloneThemeSync();
  const [request, setRequest] = useState<OverlayTooltipRequest | null>(null);

  useEffect(() => {
    void window.envApi.getTooltipState().then(setRequest);
    return window.envApi.onTooltipState(setRequest);
  }, []);

  return <NativeTooltip request={request} />;
}
