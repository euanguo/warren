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
  onOpenCommandBar?: () => void;
  destinations: RailDestination[];
}

/**
 * 导航栏（图标列）。
 *
 * 几何对齐参考稿（Growth Ops）：66 宽 = 44 控件 + 2×11 padding，图标 18，圆角 10，间距 12。
 * 选中态是**淡灰圆角块**，不是强调色填充；和内容之间是常显的 1px 竖线（--divider）。
 *
 * 架构照抄 bb 的 `components/sidebar/AppNavRail.tsx`：rail **永远常驻**，
 * 收起侧栏只折 body，所以 ☰ 的位置不会跳。
 *
 * **☰ 不在这里**：它在标题行（见 `app-titlebar.tsx`）。rail 只做路由切换。
 */
export function AppRail({ settingsActive, onOpenSettings, onOpenCommandBar, destinations }: Props) {
  return (
    <nav
      aria-label="主导航"
      data-slot="app-rail"
      className="flex w-[var(--rail-width)] shrink-0 flex-col items-center gap-[var(--rail-gap)] border-r border-divider bg-background px-[var(--rail-padding)] py-[var(--rail-padding-y)]"
    >
      {/* 溢出时纵向滚动；滚动条藏掉，rail 太窄，露出来会挤掉图标 */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-[var(--rail-gap)] overflow-y-auto [scrollbar-width:none]">
        {destinations.map((destination) => (
          <RailButton
            key={destination.id}
            label={destination.label}
            icon={destination.icon}
            active={destination.active}
            onSelect={destination.onSelect}
          />
        ))}
      </div>

      {/* 底部固定区：命令栏入口 + 设置入口 + 品牌标记。不参与滚动，所以不会挤掉上面的导航。 */}
      <div className="flex w-full shrink-0 flex-col items-center gap-[var(--rail-gap)]">
        {onOpenCommandBar && (
          <RailButton label="命令栏 (⌘K)" icon="Command" active={false} onSelect={onOpenCommandBar} />
        )}
        <RailButton label="设置" icon="Settings" active={settingsActive} onSelect={onOpenSettings} />
        <WarrenMark className="size-5 opacity-90" />
      </div>
    </nav>
  );
}

function RailButton({
  label,
  icon,
  active,
  onSelect,
}: {
  label: string;
  icon: string;
  active?: boolean;
  onSelect: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconButton
            title={label}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            onClick={onSelect}
            className="size-[var(--rail-control-size)] rounded-[var(--rail-control-radius)] text-muted-foreground aria-[current=page]:bg-surface-selected aria-[current=page]:text-foreground"
          />
        }
      >
        <Icon name={icon} className="size-[var(--rail-control-icon-size)]" />
      </TooltipTrigger>
      {/* rail 贴左边缘，tooltip 必须往右弹，否则被窗口裁掉 */}
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
