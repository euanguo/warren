import { Icon } from '@/components/icons';
import { IconButton } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WarrenMark } from '@/components/warren-mark';

export interface RailDestination {
  id: string;
  label: string;
  icon: string;
  active?: boolean;
  onSelect: () => void;
}

interface Props {
  /** 设置页此刻占着 stage —— 底部的 ⚙ 要显示成选中态。 */
  settingsActive: boolean;
  onOpenSettings: () => void;
  destinations: RailDestination[];
}

/**
 * 导航栏（图标列）。
 *
 * 架构照抄 bb 的 `components/sidebar/AppNavRail.tsx`：rail **永远常驻**，
 * 收起侧栏只折 body，所以 ☰ 的位置不会跳。
 *
 * **☰ 不在这里**：它在标题行（见 `app-titlebar.tsx`）。rail 只做路由切换。
 * 因此 rail 也**不再留顶格空行** —— 那是给 ☰ 占的位，☰ 走了就是一块死空间。
 * 目的地从卡片顶边开始，`pt-2` 和底部的 `pb-2` 对称。
 */
export function AppRail({ settingsActive, onOpenSettings, destinations }: Props) {
  return (
    <nav
      aria-label="主导航"
      data-slot="app-rail"
      className="flex w-[var(--rail-width)] shrink-0 flex-col items-center bg-surface-recessed pt-2 pb-2"
    >
      {/* 溢出时纵向滚动；滚动条藏掉，rail 太窄，露出来会挤掉图标 */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto [scrollbar-width:none]">
        {destinations.map((destination) => (
          <Tooltip key={destination.id}>
            <TooltipTrigger
              render={
                <IconButton
                  title={destination.label}
                  aria-label={destination.label}
                  aria-current={destination.active ? 'page' : undefined}
                  onClick={destination.onSelect}
                  className="aria-[current=page]:bg-surface-active aria-[current=page]:text-foreground"
                />
              }
            >
              <Icon name={destination.icon} />
            </TooltipTrigger>
            {/* rail 贴左边缘，tooltip 必须往右弹，否则被窗口裁掉 */}
            <TooltipContent side="right">{destination.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* 底部固定区：设置入口 + 品牌标记。不参与滚动，所以不会挤掉上面的导航。 */}
      <div className="flex w-full shrink-0 flex-col items-center gap-1 pt-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <IconButton
                title="设置"
                aria-label="设置"
                aria-current={settingsActive ? 'page' : undefined}
                onClick={onOpenSettings}
                className="aria-[current=page]:bg-surface-active aria-[current=page]:text-foreground"
              />
            }
          >
            <Icon name="Settings" />
          </TooltipTrigger>
          <TooltipContent side="right">设置</TooltipContent>
        </Tooltip>
        <WarrenMark className="size-5 opacity-70" />
      </div>
    </nav>
  );
}
