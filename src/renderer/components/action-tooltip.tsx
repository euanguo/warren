import type { ReactElement } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface ActionTooltipProps {
  label: string;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement;
}

/**
 * 统一的操作提示浮层（label + Kbd）。
 *
 * Electron 下原生网页 WebContentsView 位于主渲染层上方（y ≥ 80px）：
 * - Row 1 顶栏按钮请用 `side="bottom"`（落在 Row 2 内）；
 * - Row 2 地址栏按钮请用 `side="top"`（落在 Row 1 内），避免被网页视图遮挡。
 */
export function ActionTooltip({ label, shortcut, side = 'bottom', children }: ActionTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        <span>{label}</span>
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}
