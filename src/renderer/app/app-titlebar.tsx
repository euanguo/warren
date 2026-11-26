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

/**
 * macOS 红绿灯占位。窗口是 `titleBarStyle: 'hiddenInset'`，红绿灯浮在内容上，
 * 不留位就会被盖住（bb 同样留 84px）。
 */
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
  onTabReload: () => void;
  onTabHardReload: () => void;
  onTabCloseOthers: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabCloseRight: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabReorder: (id: string, space: SpaceId, from: number, to: number) => void;
  onTabToggleMute: (id: string, space: SpaceId, ref: TabRef, muted: boolean) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
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
 * 两层精密浏览器壳首行（Row 1）：
 * - 环境模式：红绿灯 + 侧栏折叠 + 当前环境胶囊 + 我的/Agent 空间切换 + 标签条 + 仅 Agent 空间显示的控制权胶囊 + ⌘K / 全局扩展 / 设置；
 * - 全局模式（设置 / 插件全屏页）：切为纯全局导航条（← 返回环境 + 全局页面切换），避免环境胶囊与全局配置概念错位。
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
  onStart,
  onStop,
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
    const sync = () => {
      const activeEl = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!activeEl) {
        thumb.style.opacity = '0';
        return;
      }
      thumb.style.opacity = '1';
      thumb.style.width = `${activeEl.offsetWidth}px`;
      thumb.style.transform = `translateX(${activeEl.offsetLeft}px)`;
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
    items.push(
      { id: 'settings:plugins', label: '插件与权限管理…' },
      { id: 'settings:vault', label: '凭据与安全边界 (Vault)…' },
      { id: 'settings:general', label: '设置中心…' },
    );
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
          'relative flex h-[var(--shell-top-row-height)] w-full min-w-0 shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-border/60 bg-surface-under pr-2.5',
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
            className="max-w-[220px] text-foreground/85 hover:text-foreground"
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
            'absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-[var(--control-radius)] border border-border bg-input-fill p-0.5 [box-shadow:var(--shadow-recessed)]',
            NO_DRAG_CLASS,
          )}
        >
          <span
            ref={globalThumbRef}
            aria-hidden
            data-slot="global-nav-thumb"
            className="pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded-[var(--control-radius-icon)] border border-border-heavy/65 bg-surface-elevated opacity-0 [box-shadow:var(--shadow-chip)] transition-[transform,width,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          />
          <Button
            size="xs"
            variant="ghost"
            aria-label="设置"
            aria-current={route === 'settings' ? 'page' : undefined}
            onClick={() => onOpenSettings()}
            className={cn(
              'relative z-10 hover:bg-transparent',
              route === 'settings' ? 'font-medium text-foreground' : 'text-subtle-foreground hover:text-foreground',
            )}
          >
            <Icon name="Settings" />
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
                  'relative z-10 hover:bg-transparent',
                  active ? 'font-medium text-foreground' : 'text-subtle-foreground hover:text-foreground',
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
              className="h-[var(--control-height-icon)] gap-1.5 px-2 text-xs text-subtle-foreground hover:text-foreground"
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
        'flex h-[var(--shell-top-row-height)] w-full min-w-0 shrink-0 items-center gap-1.5 overflow-hidden bg-surface-under pr-2.5',
        window.envApi.platform === 'darwin' ? TRAFFIC_LIGHT_RESERVE_CLASS : 'pl-2',
        DRAG_CLASS,
      )}
    >
      <div className={cn('flex shrink-0 items-center gap-2', NO_DRAG_CLASS)}>
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
            className="flex h-[var(--control-height-icon)] max-w-[232px] shrink-0 items-center gap-1.5 rounded-[var(--control-radius)] border border-border-heavy/65 bg-surface-elevated px-2 text-xs [box-shadow:var(--shadow-chip)] outline-none transition-colors hover:bg-surface-hover focus-visible:border-focus"
          >
            <EnvIdentityAvatar
              envId={environment.id}
              name={environment.name}
              status={environment.status}
              hasError={Boolean(environment.error)}
              size="xs"
              className="mr-1"
            />
            <span className="truncate font-medium text-foreground">{environment.name}</span>
            <span className="truncate font-mono text-[length:var(--font-size-micro)] text-muted-foreground">
              {environment.error ? '加载失败' : egressLabel(environment.proxy)}
            </span>
            <Icon name="ChevronDown" className="size-3 shrink-0 text-subtle-foreground" />
          </button>
        ) : (
          <span data-slot="env-capsule" className="px-1.5 text-xs text-muted-foreground">
            未选择环境
          </span>
        )}

        {environment && running && (environment.spaces?.length ?? 0) > 0 && (
          <>
            <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
            <EnvironmentSpaceSwitcher
              spaces={environment.spaces ?? []}
              activeSpaceId={activeSpaceId}
              leaseLabel={environment.leaseLabel}
              onSelect={(space) => onSpaceSelect(environment.id, space)}
            />
            <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
          </>
        )}
      </div>

      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
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
              'mr-1 flex h-7 items-center gap-1.5 rounded-full border pr-1 pl-2.5 text-xs animate-in fade-in-0 slide-in-from-right-1 duration-150 motion-reduce:animate-none',
              agentOwner === 'agent' && 'border-[var(--info)]/55 bg-[var(--info)]/14 [box-shadow:var(--shadow-chip)]',
              agentOwner === 'human' &&
                'border-[var(--success)]/50 bg-[var(--success)]/12 [box-shadow:var(--shadow-chip)]',
              agentOwner === 'none' && 'border-border-heavy/75 bg-surface-elevated/90 [box-shadow:var(--shadow-chip)]',
            )}
          >
            <StatusDot
              tone={agentOwner === 'agent' ? 'info' : agentOwner === 'human' ? 'success' : 'idle'}
              className={cn(agentOwner === 'agent' && 'animate-pulse')}
            />
            <span className="max-w-[132px] truncate text-foreground">
              {agentOwner === 'agent'
                ? `${environment.leaseLabel || 'Agent'} 操作中`
                : agentOwner === 'human'
                  ? '你正在接管'
                  : 'Agent 空闲（只读）'}
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
                className={cn(
                  'h-[22px] rounded-full px-2.5',
                  agentOwner === 'agent' &&
                    'border border-[var(--info)]/45 bg-[var(--info)]/18 text-[var(--info)] hover:bg-[var(--info)]/28',
                )}
                onClick={() => onTakeover(environment.id)}
              >
                <Icon name="Grab" />
                {agentOwner === 'agent' ? '接管' : '接管编辑'}
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
            className="h-[var(--control-height-icon)] gap-1.5 px-2 text-xs text-subtle-foreground hover:text-foreground"
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
