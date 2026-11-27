import { Icon } from '@/components/icons';
import { SidebarGroupLabel } from '@/components/ui/sidebar';
import { StatusDot } from '@/components/ui/status-dot';
import { disclosureChevronClassName } from '@/lib/disclosure-motion';

interface Props {
  title: string;
  count: number;
  runningCount: number;
  collapsed: boolean;
  onToggle: () => void;
}

export function SidebarGroupHeader({ title, count, runningCount, collapsed, onToggle }: Props) {
  return (
    <SidebarGroupLabel
      className="h-[var(--size-row)] cursor-pointer select-none rounded-[var(--control-radius)] text-[11px] font-medium tracking-wide text-muted-foreground transition-none hover:bg-surface-hover hover:text-foreground"
      onClick={onToggle}
    >
      <Icon name="ChevronRight" className={disclosureChevronClassName(!collapsed, 'size-4')} />
      <span className="truncate">{title}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {collapsed && runningCount > 0 && <StatusDot tone="success" />}
        <span className="text-[length:var(--font-size-micro)] tabular-nums text-subtle-foreground">{count}</span>
      </span>
    </SidebarGroupLabel>
  );
}
