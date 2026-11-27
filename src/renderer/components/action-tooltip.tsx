import type { ReactElement, ReactNode } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface ActionTooltipProps {
  label: string;
  description?: ReactNode;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement;
}

/**
 * 统一的操作提示浮层（label + 可选副说明 + Kbd）。
 *
 * Electron 下原生网页 WebContentsView 位于主渲染层上方：
 * - 顶栏按钮请用 `side="bottom"`；
 * - 地址栏按钮请用 `side="top"`，避免被网页视图遮挡；
 * - 紧凑侧栏图标轨道请用 `side="right"`，并可附带环境状态副说明。
 */
export function ActionTooltip({ label, description, shortcut, side = 'bottom', children }: ActionTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} className={description ? 'flex-col items-start gap-0.5 py-1.5' : undefined}>
        <span className="inline-flex items-center gap-2 font-medium">
          <span>{label}</span>
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </span>
        {description ? <span className="text-[11px] opacity-75">{description}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
