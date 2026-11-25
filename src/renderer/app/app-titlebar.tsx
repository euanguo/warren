import { Icon } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/status-dot';
import { statusLabel, statusTone } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { Environment } from '@shared/types';

/**
 * macOS 红绿灯占位。窗口是 `titleBarStyle: 'hiddenInset'`，红绿灯浮在内容上，
 * 不留位就会被盖住（bb 同样留 84px）。
 */
const TRAFFIC_LIGHT_RESERVE_CLASS = 'pl-[84px]';

const DRAG_CLASS = 'select-none [app-region:drag] [-webkit-app-region:drag]';
const NO_DRAG_CLASS = '[app-region:no-drag] [-webkit-app-region:no-drag]';

interface Props {
  environment?: Environment;
  groupName?: string;
  /** 环境列表此刻在不在（插件页 / 设置页占满整卡时它不在，☰ 就没意义）。 */
  showSidebarToggle: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onTakeover: (id: string) => void;
  onRelease: (id: string) => void;
}

/**
 * 窗口标题行。
 *
 * 这一行是 **环境级** 的上下文：看的是哪个环境、谁在控制。
 * 页面级的动作（前进/后退/地址）在内容卡片的地址栏里，两者不混。
 * 环境身份放这里而不是侧栏，是因为侧栏可以收起——收起后仍然要知道在看哪个环境。
 */
export function AppTitlebar({
  environment,
  groupName,
  showSidebarToggle,
  sidebarOpen,
  onToggleSidebar,
  onTakeover,
  onRelease,
}: Props) {
  const running = environment?.status === 'running';
  const agentOwner =
    (environment?.spaces ?? []).find((space) => space.id === 'agent')?.owner ?? environment?.owner ?? 'none';
  const agentLabel = agentOwner === 'agent' ? 'Agent 操作中' : agentOwner === 'human' ? '你接管了 Agent' : 'Agent 空闲';

  return (
    <header
      data-slot="app-titlebar"
      className={cn(
        'flex h-[var(--shell-title-bar-height)] shrink-0 items-center gap-2 pr-2',
        window.envApi.platform === 'darwin' ? TRAFFIC_LIGHT_RESERVE_CLASS : 'pl-2',
        DRAG_CLASS,
      )}
    >
      {/*
        侧栏开合放在**标题行**，不放 rail —— rail 是路由切换器，和"这行窗口在干什么"不是一回事。
        槽位宽度固定：切到插件页 / 设置页时按钮消失，不留位的话环境名会往左跳 28px。
      */}
      <div className={cn('flex w-[var(--rail-control-size)] shrink-0 items-center justify-center', NO_DRAG_CLASS)}>
        {showSidebarToggle && (
          <IconButton
            title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
            aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
            aria-expanded={sidebarOpen}
            onClick={onToggleSidebar}
          >
            <Icon name={sidebarOpen ? 'PanelLeftClose' : 'PanelLeftOpen'} />
          </IconButton>
        )}
      </div>

      {environment ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <StatusDot tone={environment.error ? 'error' : statusTone(environment.status)} />
          <span className="truncate text-sm font-medium">{environment.name}</span>
          {groupName ? (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="truncate text-xs text-muted-foreground">{groupName}</span>
            </>
          ) : null}
          {/* 页面加载失败时环境**仍然是 running**，所以说「运行中」是错的——这里优先报错 */}
          <span
            className={cn('shrink-0 text-xs', environment.error ? 'text-destructive' : 'text-muted-foreground')}
            title={environment.error}
          >
            {environment.error ? '页面加载失败' : (statusLabel[environment.status] ?? environment.status)}
          </span>
          <span className="shrink-0 truncate font-mono text-xs text-muted-foreground/70">
            {environment.proxy ?? '直连'}
          </span>
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">未选择环境</span>
      )}

      <div className={cn('ml-auto flex shrink-0 items-center gap-1.5', NO_DRAG_CLASS)}>
        {environment ? (
          <>
            {/* 「谁在控制」是这一行的核心信息之一，空闲是常态、有主才要显眼 */}
            <span
              className={cn('text-xs', agentOwner === 'none' ? 'text-muted-foreground' : 'font-medium text-foreground')}
            >
              {agentLabel}
            </span>
            {/* 空闲时也要能接管——否则导航按钮永远解不开，是个死角 */}
            {running && agentOwner !== 'human' && (
              <Button size="sm" onClick={() => onTakeover(environment.id)}>
                <Icon name="Grab" />
                接管 Agent
              </Button>
            )}
            {agentOwner === 'human' && (
              <Button size="sm" variant="secondary" onClick={() => onRelease(environment.id)}>
                <Icon name="Release" />
                交还 Agent
              </Button>
            )}
          </>
        ) : null}
      </div>
    </header>
  );
}
