import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { ActionTooltip } from '@/components/action-tooltip';
import { Icon } from '@/components/icons';
import { EnvIdentityAvatar, PluginBrandGlyph } from '@/components/identity-glyphs';
import { Button, IconButton } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { StatusDot } from '@/components/ui/status-dot';
import { EnvironmentSpaceSwitcher } from '@/features/environments/environment-space-switcher';
import { EnvironmentTabstrip } from '@/features/environments/environment-tabstrip';
import { egressLabel } from '@/features/environments/sidebar-env-row';
import { openEnvironmentContextMenu } from '@/features/environments/sidebar-menus';
import type { PluginEnvAction, PluginRailPage } from '@/lib/plugin-sdk-types';
import { cn } from '@/lib/utils';
import type { SettingsSection, StageRoute } from '@/state/navigation-store';
import type { Environment, Group, NativeMenuItem, SpaceId, TabRef, TabState } from '@shared/types';

/** macOS hiddenInset 红绿灯占位（84px）。 */
const TRAFFIC_LIGHT_RESERVE_CLASS = 'pl-[84px]';

const DRAG_CLASS = 'select-none [app-region:drag] [-webkit-app-region:drag]';
const NO_DRAG_CLASS = '[app-region:no-drag] [-webkit-app-region:no-drag]';

interface Props {
  route: StageRoute;
  environment?: Environment;
  groups: Group[];
  activeSpaceId: SpaceId;
  tabs: TabState[];
  activeTabId?: string;
  running: boolean;
  locked: boolean;
  canNavigate: boolean;
  sidebarOpen: boolean;
  railPages: PluginRailPage[];
  activePluginPage?: PluginRailPage;
  pluginActions: PluginEnvAction[];
  onToggleSidebar: () => void;
  onSpaceSelect: (id: string, space: SpaceId) => void;
  onTabSelect: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabClose: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabCreate: (id: string, space: SpaceId) => void;
  onTabReload: (ref?: TabRef) => void;
  onTabHardReload: (ref?: TabRef) => void;
  onTabCloseOthers: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabCloseRight: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabReorder: (id: string, space: SpaceId, from: number, to: number) => void;
  onTabToggleMute: (id: string, space: SpaceId, ref: TabRef, muted: boolean) => void;
  onTabSleep?: (id: string, space: SpaceId, ref: TabRef) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onHibernate?: (id: string) => void;
  onClearCache?: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveToGroup: (envId: string, groupId: string | undefined) => void;
  onRunPluginAction: (pluginId: string, command: string, envId: string) => void;
  onTakeover: (id: string) => void;
  onRelease: (id: string) => void;
  onOpenCommandBar: () => void;
  onOpenSettings: (section?: SettingsSection) => void;
  onOpenPluginPage: (pluginId: string, surfaceId: string) => void;
  onBackToEnvironments: () => void;
}

/**
 * OpenBot 风格 38px 无边框顶栏（位于外框 bg-frame 上，下方衔接 14px 圆角主画布卡片）：
 * - 环境模式：红绿灯 + 侧栏切换 + 扁平环境胶囊 + SlidingTabs 空间切换 + 凹角无界标签条 + Agent 控制胶囊 + ⌘K / 扩展 / 设置；
 * - 全局模式（设置 / 插件全屏页）：切为纯全局导航条（← 返回环境 + 居中滑动胶囊导航）。
 */
export function AppTitlebar({
  route,
  environment,
  groups,
  activeSpaceId,
  tabs,
  activeTabId,
  running,
  locked,
  canNavigate,
  sidebarOpen,
  railPages,
  activePluginPage,
  pluginActions,
  onToggleSidebar,
  onSpaceSelect,
  onTabSelect,
  onTabClose,
  onTabCreate,
  onTabReload,
  onTabHardReload,
  onTabCloseOthers,
  onTabCloseRight,
  onTabReorder,
  onTabToggleMute,
  onTabSleep,
  onStart,
  onStop,
  onHibernate,
  onClearCache,
  onRemove,
  onMoveToGroup,
  onRunPluginAction,
  onTakeover,
  onRelease,
  onOpenCommandBar,
  onOpenSettings,
  onOpenPluginPage,
  onBackToEnvironments,
}: Props) {
  const isGlobalMode = route !== 'environments';
  const globalNavRef = useRef<HTMLElement>(null);
  const globalThumbRef = useRef<HTMLSpanElement>(null);
  const activeGlobalKey =
    route === 'settings' ? 'settings' : activePluginPage ? `${activePluginPage.pluginId}:${activePluginPage.id}` : '';

  useLayoutEffect(() => {
    if (!isGlobalMode) return;
    const nav = globalNavRef.current;
    const thumb = globalThumbRef.current;
    if (!nav || !thumb) return;
    let initialized = false;
    const sync = () => {
      const activeEl = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!activeEl) {
        thumb.style.opacity = '0';
        return;
      }
      if (!initialized) nav.dataset.initializing = 'true';
      thumb.style.opacity = '1';
      thumb.style.width = `${activeEl.offsetWidth}px`;
      thumb.style.transform = `translate3d(${activeEl.offsetLeft}px, 0, 0)`;
      if (!initialized) {
        void thumb.getBoundingClientRect();
        delete nav.dataset.initializing;
        initialized = true;
      }
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [isGlobalMode, activeGlobalKey, railPages.length]);

  const agentOwner =
    (environment?.spaces ?? []).find((space) => space.id === 'agent')?.owner ?? environment?.owner ?? 'none';

  const openCurrentEnvMenu = (event: MouseEvent) => {
    if (!environment) return;
    void openEnvironmentContextMenu(event, environment, groups, pluginActions, {
      onStart,
      onStop,
      onHibernate,
      onClearCache,
      onRemove,
      onTakeover,
      onRelease,
      onMoveToGroup,
      onRunPluginAction,
    });
  };

  const openGlobalPluginsMenu = async (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: NativeMenuItem[] = [];
    if (railPages.length > 0) {
      items.push({ label: '插件全屏页', enabled: false });
      for (const page of railPages) {
        items.push({
          id: `page:${page.pluginId}:${page.id}`,
          label: page.title,
        });
      }
      items.push({ type: 'separator' });
    }
    items.push({ id: 'settings:plugins', label: '插件与权限管理…' }, { id: 'settings:general', label: '设置中心…' });
    const picked = await window.envApi.popupMenu(items, {
      x: Math.min(Math.round(rect.left), Math.max(8, Math.round(window.innerWidth - 236))),
      y: Math.round(rect.bottom + 4),
    });
    if (!picked) return;
    if (picked.startsWith('page:')) {
      const rest = picked.slice(5);
      const sep = rest.indexOf(':');
      if (sep > 0) onOpenPluginPage(rest.slice(0, sep), rest.slice(sep + 1));
    } else if (picked.startsWith('settings:')) {
      onOpenSettings(picked.slice(9) as SettingsSection);
    }
  };

  if (isGlobalMode) {
    return (
      <header
        data-slot="global-header"
        className={cn(
          'relative flex h-[var(--shell-top-row-height)] w-full min-w-0 shrink-0 items-center justify-between gap-2 overflow-hidden bg-frame pr-2',
          window.envApi.platform === 'darwin' ? TRAFFIC_LIGHT_RESERVE_CLASS : 'pl-2',
          DRAG_CLASS,
        )}
      >
        <div className={cn('flex min-w-0 items-center gap-1.5', NO_DRAG_CLASS)}>
          <Button
            size="xs"
            variant="ghost"
            data-slot="settings-back"
            aria-label="返回环境"
            title="返回环境工作台 (Esc)"
            onClick={onBackToEnvironments}
            className="h-[var(--control-height-icon)] max-w-[220px] rounded-[var(--control-radius)] text-muted-foreground hover:text-foreground"
          >
            <Icon name="ChevronLeft" />
            <span className="truncate">返回环境{environment ? ` · ${environment.name}` : ''}</span>
          </Button>
        </div>

        <nav
          ref={globalNavRef}
          aria-label="全局视图"
          data-slot="global-nav"
          className={cn(
            'absolute left-1/2 flex h-[var(--control-height-icon)] -translate-x-1/2 items-center gap-[3px] rounded-[var(--control-radius)] bg-tabs-bar p-[3px] [box-shadow:inset_0_0_0_1px_var(--border)]',
            NO_DRAG_CLASS,
          )}
        >
          <span
            ref={globalThumbRef}
            aria-hidden
            data-slot="global-nav-thumb"
            className="warren-sliding-pill opacity-0"
          />
          <Button
            size="xs"
            variant="ghost"
            aria-label="设置"
            aria-current={route === 'settings' ? 'page' : undefined}
            onClick={() => onOpenSettings()}
            className={cn(
              'relative z-10 h-full border-0 hover:bg-transparent active:scale-100',
              route === 'settings' ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon name="Settings" className="size-3.5" />
            <span>设置</span>
          </Button>
          {railPages.map((page) => {
            const active =
              route === 'pluginPage' &&
              activePluginPage?.pluginId === page.pluginId &&
              activePluginPage?.id === page.id;
            return (
              <Button
                key={`${page.pluginId}:${page.id}`}
                size="xs"
                variant="ghost"
                aria-label={page.title}
                aria-current={active ? 'page' : undefined}
                onClick={() => onOpenPluginPage(page.pluginId, page.id)}
                className={cn(
                  'relative z-10 h-full border-0 hover:bg-transparent active:scale-100',
                  active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <PluginBrandGlyph pluginId={page.pluginId} icon={page.icon} className={cn(!active && 'opacity-80')} />
                <span>{page.title}</span>
              </Button>
            );
          })}
        </nav>

        <div className={cn('flex shrink-0 items-center gap-1', NO_DRAG_CLASS)}>
          <ActionTooltip label="命令栏与全局搜索" shortcut="⌘K" side="bottom">
            <Button
              size="xs"
              variant="outline"
              data-slot="command-bar-trigger"
              aria-label="命令栏 (⌘K)"
              onClick={onOpenCommandBar}
              className="h-[var(--control-height-icon)] gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <Icon name="Search" className="size-3.5" />
              <Kbd>⌘K</Kbd>
            </Button>
          </ActionTooltip>
        </div>
      </header>
    );
  }

  return (
    <header
      data-slot="app-header"
      className={cn(
        'relative z-10 -mb-px flex h-[var(--shell-top-row-height)] w-full min-w-0 shrink-0 items-center gap-1.5 overflow-hidden bg-transparent pr-2',
        window.envApi.platform === 'darwin' ? TRAFFIC_LIGHT_RESERVE_CLASS : 'pl-2',
        DRAG_CLASS,
      )}
    >
      <div className={cn('flex shrink-0 items-center gap-1.5', NO_DRAG_CLASS)}>
        <ActionTooltip label={sidebarOpen ? '收起环境侧栏' : '展开环境侧栏'} shortcut="⌘B" side="bottom">
          <IconButton
            data-slot="sidebar-toggle"
            aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
            aria-expanded={sidebarOpen}
            onClick={onToggleSidebar}
          >
            <Icon name={sidebarOpen ? 'PanelLeftClose' : 'PanelLeftOpen'} />
          </IconButton>
        </ActionTooltip>

        {environment ? (
          <button
            type="button"
            data-slot="env-capsule"
            onClick={openCurrentEnvMenu}
            onContextMenu={openCurrentEnvMenu}
            title={`${environment.name} (${environment.id}) · ${environment.proxy ?? '直连'} · 点击管理环境`}
            className="flex h-[var(--control-height-icon)] max-w-[232px] shrink-0 items-center gap-1.5 rounded-[var(--control-radius)] border border-border-strong bg-control px-2 text-xs outline-none transition-none hover:bg-control-hover active:scale-[0.97] focus-visible:border-focus focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]"
          >
            <EnvIdentityAvatar
              envId={environment.id}
              name={environment.name}
              status={environment.status}
              hasError={Boolean(environment.error)}
              size="xs"
              ringClassName="ring-control"
              className="mr-0.5"
            />
            <span className="truncate font-medium text-foreground">{environment.name}</span>
            <span className="truncate font-mono text-[length:var(--font-size-micro)] text-muted-foreground">
              {environment.error ? '加载失败' : egressLabel(environment.proxy)}
            </span>
            <Icon name="ChevronDown" className="size-3 shrink-0 text-muted-foreground" />
          </button>
        ) : (
          <span
            data-slot="env-capsule"
            className="inline-flex h-[var(--control-height-icon)] items-center px-1.5 text-xs text-muted-foreground"
          >
            未选择环境
          </span>
        )}

        {environment && running && (environment.spaces?.length ?? 0) > 0 && (
          <>
            <span className="h-3.5 w-px shrink-0 bg-border-strong" aria-hidden />
            <EnvironmentSpaceSwitcher
              spaces={environment.spaces ?? []}
              activeSpaceId={activeSpaceId}
              leaseLabel={environment.leaseLabel}
              onSelect={(space) => onSpaceSelect(environment.id, space)}
            />
            <span className="h-3.5 w-px shrink-0 bg-border-strong" aria-hidden />
          </>
        )}
      </div>

      <div className="flex h-full min-w-0 flex-1 items-end overflow-hidden">
        {environment && running ? (
          <EnvironmentTabstrip
            tabs={tabs}
            activeTabId={activeTabId}
            disabled={!running}
            locked={locked}
            canReload={canNavigate}
            onSelect={(ref) => onTabSelect(environment.id, activeSpaceId, ref)}
            onClose={(ref) => onTabClose(environment.id, activeSpaceId, ref)}
            onCreate={() => onTabCreate(environment.id, activeSpaceId)}
            onReload={onTabReload}
            onHardReload={onTabHardReload}
            onCloseOthers={(ref) => onTabCloseOthers(environment.id, activeSpaceId, ref)}
            onCloseRight={(ref) => onTabCloseRight(environment.id, activeSpaceId, ref)}
            onReorder={(from, to) => onTabReorder(environment.id, activeSpaceId, from, to)}
            onToggleMute={(ref, muted) => onTabToggleMute(environment.id, activeSpaceId, ref, muted)}
            onSleep={onTabSleep ? (ref) => onTabSleep(environment.id, activeSpaceId, ref) : undefined}
          />
        ) : null}
      </div>

      <div className={cn('flex shrink-0 items-center gap-1', NO_DRAG_CLASS)}>
        {/* 控制权胶囊只在 Agent 空间出现：我的空间永远可写，不制造接管噪音 */}
        {environment && running && activeSpaceId === 'agent' && (
          <div
            data-slot="control-pill"
            data-owner={agentOwner}
            className={cn(
              'mr-1 flex h-[var(--control-height-icon)] items-center gap-1.5 rounded-full border pr-1 pl-2.5 text-xs animate-in fade-in-0 slide-in-from-right-1 duration-150 motion-reduce:animate-none',
              agentOwner === 'agent' && 'border-accent-strong bg-accent-soft',
              agentOwner === 'human' && 'border-success/40 bg-success-soft',
              agentOwner === 'none' && 'border-border-strong bg-control',
            )}
          >
            <StatusDot
              tone={agentOwner === 'agent' ? 'info' : agentOwner === 'human' ? 'success' : 'idle'}
              className={cn(agentOwner === 'agent' && 'animate-pulse')}
            />
            <span className="max-w-[148px] truncate text-foreground">
              {agentOwner === 'agent'
                ? `${environment.leaseLabel || 'Agent'} 操作中`
                : agentOwner === 'human'
                  ? '你正在接管'
                  : 'Agent 空闲 · 可自由操作'}
            </span>
            {agentOwner === 'human' ? (
              <Button
                size="xs"
                variant="secondary"
                className="h-[22px] rounded-full px-2.5"
                onClick={() => onRelease(environment.id)}
              >
                <Icon name="Release" />
                交还
              </Button>
            ) : (
              <Button
                size="xs"
                variant={agentOwner === 'agent' ? 'ghost' : 'outline'}
                title={agentOwner === 'agent' ? '立即中止 Agent 租约并接管页面' : '锁定 Agent 空间，暂停 AI 自动介入'}
                className={cn(
                  'h-[22px] rounded-full px-2.5',
                  agentOwner === 'agent' &&
                    'border border-accent-strong bg-accent-soft text-accent-text hover:bg-accent-strong/50',
                )}
                onClick={() => onTakeover(environment.id)}
              >
                <Icon name="Grab" />
                {agentOwner === 'agent' ? '接管' : '暂停 AI'}
              </Button>
            )}
          </div>
        )}

        <ActionTooltip label="命令栏与全局搜索" shortcut="⌘K" side="bottom">
          <Button
            size="xs"
            variant="outline"
            data-slot="command-bar-trigger"
            aria-label="命令栏 (⌘K)"
            onClick={onOpenCommandBar}
            className="h-[var(--control-height-icon)] gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <Icon name="Search" className="size-3.5" />
            <Kbd>⌘K</Kbd>
          </Button>
        </ActionTooltip>

        <ActionTooltip label="全局插件页与扩展工具" side="bottom">
          <IconButton
            data-slot="global-plugins-trigger"
            aria-label="扩展与全局页"
            onClick={(event) => void openGlobalPluginsMenu(event)}
          >
            <Icon name="Plug" />
          </IconButton>
        </ActionTooltip>

        <ActionTooltip label="设置中心" side="bottom">
          <IconButton data-slot="settings-trigger" aria-label="设置" onClick={() => onOpenSettings()}>
            <Icon name="Settings" />
          </IconButton>
        </ActionTooltip>
      </div>
    </header>
  );
}
