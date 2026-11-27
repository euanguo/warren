import { Suspense, lazy, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { AppTitlebar } from '@/app/app-titlebar';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
import { PanelResizer } from '@/components/ui/panel-resizer';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EnvironmentSidebar } from '@/features/environments/environment-sidebar';
import { EnvironmentStage } from '@/features/environments/environment-stage';
import { usePluginBadges } from '@/lib/plugin-badges';
import { cn } from '@/lib/utils';
import { environmentActions, useEnvironmentState } from '@/state/environment-store';
import {
  openEnvironments,
  openPluginPage,
  openSettings,
  requestPluginInspector,
  requestPluginPopover,
  setSettingsSection,
  useNavigationState,
  type SettingsSection,
} from '@/state/navigation-store';
import { pluginActions, usePluginState } from '@/state/plugin-store';
import { configureTelemetryTarget, telemetryActions, useTelemetryState } from '@/state/telemetry-store';
import type { NavigationAction, SpaceId, TabRef } from '@shared/types';

const SettingsPage = lazy(() => import('@/features/settings/settings-page').then((m) => ({ default: m.SettingsPage })));

/**
 * OpenBot 三态侧栏几何阶梯：
 * - expanded：默认 248px（可拖拽 176–400px，双击复位）
 * - compact：72px 紧凑图标轨道（拖拽越过 110px 迟滞吸附，拖出 118px 弹回展开）
 * - closed：0px 完全收起（⌘B 或顶栏按钮切换）
 */
const SIDEBAR_WIDTH = {
  default: 248,
  min: 176,
  max: 400,
  compact: 72,
  collapseThreshold: 110,
  expandThreshold: 118,
  autoCompactViewport: 920,
} as const;

const SIDEBAR_WIDTH_KEY = 'warren.sidebar.width';
const SIDEBAR_COMPACT_KEY = 'warren.sidebar.compact';

type SidebarOpenMode = 'expanded' | 'compact';

function readInitialSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= SIDEBAR_WIDTH.min && saved <= SIDEBAR_WIDTH.max) {
      return Math.round(saved);
    }
  } catch {
    // 忽略存储读取异常
  }
  return SIDEBAR_WIDTH.default;
}

function readInitialSidebarCompact(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COMPACT_KEY) === '1';
  } catch {
    return false;
  }
}

export function App() {
  const { environments, groups, events, selected, ready: environmentsReady } = useEnvironmentState();
  const { plugins, settings, registry } = usePluginState();
  const { route, settingsSection, requestedPage, inspectorOpen, inspectorTab } = useNavigationState();
  const telemetry = useTelemetryState();
  const pluginBadges = usePluginBadges();

  const [sidebarWidth, setSidebarWidth] = useState<number>(readInitialSidebarWidth);
  const [sidebarCompactPref, setSidebarCompactPref] = useState<boolean>(readInitialSidebarCompact);
  const [sidebarClosed, setSidebarClosed] = useState<boolean>(false);
  const [autoCompact, setAutoCompact] = useState<boolean>(
    () =>
      typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < SIDEBAR_WIDTH.autoCompactViewport,
  );
  const [sidebarSearchFocusToken, setSidebarSearchFocusToken] = useState(0);
  const [inspectorMaximized, setInspectorMaximized] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const workbenchGridRef = useRef<HTMLDivElement>(null);

  // 窄窗口自动降为 72px 紧凑图标轨道（不覆盖用户显式关闭或偏好）
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth <= 0) return;
      setAutoCompact(window.innerWidth < SIDEBAR_WIDTH.autoCompactViewport);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const persistSidebarWidth = useCallback((nextWidth: number) => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(nextWidth)));
    } catch {
      // 忽略存储写入异常
    }
  }, []);

  const setSidebarCompact = useCallback((nextCompact: boolean) => {
    setSidebarCompactPref(nextCompact);
    try {
      localStorage.setItem(SIDEBAR_COMPACT_KEY, nextCompact ? '1' : '0');
    } catch {
      // 忽略存储写入异常
    }
  }, []);

  const sidebarMode: SidebarOpenMode | 'closed' = sidebarClosed
    ? 'closed'
    : sidebarCompactPref || autoCompact
      ? 'compact'
      : 'expanded';
  const leftPanelPx = sidebarMode === 'closed' ? 0 : sidebarMode === 'compact' ? SIDEBAR_WIDTH.compact : sidebarWidth;

  // 插件面被停用 / 卸载后就不该再算「当前视图」——派生出来，不用 effect 去清 state
  const activePluginPage =
    route === 'pluginPage' && requestedPage
      ? registry.railPages.find(
          (page) => page.pluginId === requestedPage.pluginId && page.id === requestedPage.surfaceId,
        )
      : undefined;

  const settingsOpen = route === 'settings';
  const effectiveRoute = settingsOpen ? 'settings' : activePluginPage ? 'pluginPage' : 'environments';
  const stageReplaced = effectiveRoute !== 'environments';

  const current = environments.find((env) => env.id === selected);
  const running = current?.status === 'running';
  const activeSpaceId: SpaceId = current?.activeSpaceId ?? 'person';
  const activeSpace = (current?.spaces ?? []).find((space) => space.id === activeSpaceId);
  const tabs = activeSpace?.tabs ?? current?.tabs ?? [];
  const activeTabId = activeSpace?.activeTabId ?? current?.activeTabId;
  const locked = activeSpaceId === 'agent' && activeSpace?.owner === 'agent';
  const canNavigate = Boolean(running) && !locked;

  const openCommandBar = useCallback(() => {
    void window.envApi
      .openOverlay<{
        command?: string;
        section?: SettingsSection;
        pluginId?: string;
        surfaceId?: string;
      } | null>({ kind: 'command-bar' })
      .then((result) => {
        if (result?.command === 'openSettings') {
          openSettings(result.section);
        } else if (result?.command === 'openPluginPage' && result.pluginId && result.surfaceId) {
          openPluginPage(result.pluginId, result.surfaceId);
        } else if (result?.command === 'openPluginPopover' && result.pluginId && result.surfaceId) {
          openEnvironments();
          requestPluginPopover(result.pluginId, result.surfaceId);
        } else if (result?.command === 'openPluginInspectorTab' && result.pluginId && result.surfaceId) {
          openEnvironments();
          requestPluginInspector(result.pluginId, result.surfaceId);
        }
      });
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarClosed((prev) => !prev);
  }, []);

  const expandSidebarAndFocusSearch = useCallback(() => {
    setSidebarClosed(false);
    setSidebarCompact(false);
    setSidebarSearchFocusToken((token) => token + 1);
  }, [setSidebarCompact]);

  // ⌘K 全局命令栏（走 OverlayHost 独立透明层，不挡也不藏底层网页）
  useEffect(() => {
    return window.envApi.onBrowserShortcut((shortcut) => {
      if (shortcut === 'commandBar') openCommandBar();
    });
  }, [openCommandBar]);

  // 响应侧栏内存速览 Popover 的「打开完整内存面板」动作
  useEffect(() => {
    return window.envApi.onPopoverAction((event) => {
      if (event.id === 'memory-quick' && event.action === 'openMemoryPanel') {
        openSettings('memory');
      }
    });
  }, []);

  // ⌘B 切换环境侧栏；插件全屏页按 Esc 返回环境工作台
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
        if (!stageReplaced) {
          event.preventDefault();
          toggleSidebar();
        }
        return;
      }
      if (event.key === 'Escape' && activePluginPage) {
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
        event.preventDefault();
        openEnvironments();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stageReplaced, activePluginPage, toggleSidebar]);

  // 全屏设置 / 插件页 或 右侧检查器最大化时，隐藏原生 WebContentsView 避免压盖 DOM
  const hideNativeView = stageReplaced || inspectorMaximized;
  useEffect(() => {
    void window.envApi.setViewVisible(!hideNativeView);
  }, [hideNativeView]);

  /*
   * WebContentsView 是原生视图，不遵守 DOM 布局；把占位区的实际矩形实时报给主进程。
   * 侧栏 240ms 平滑过渡期间也通过 ResizeObserver + transitionend 追踪终点，确保坐标零漂移。
   */
  useEffect(() => {
    const node = stageRef.current;
    const grid = workbenchGridRef.current;
    if (!node) return;
    const report = () => {
      if (hideNativeView) return;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      void window.envApi.setViewport({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };
    report();
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      report();
      raf2 = window.requestAnimationFrame(report);
    });
    const observer = new ResizeObserver(report);
    observer.observe(node);
    const onTransitionEnd = () => report();
    grid?.addEventListener('transitionend', onTransitionEnd);
    window.addEventListener('resize', report);
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
      observer.disconnect();
      grid?.removeEventListener('transitionend', onTransitionEnd);
      window.removeEventListener('resize', report);
    };
  }, [hideNativeView, leftPanelPx]);

  // 将观测焦点同步给 TelemetryStore：收起检查器时完全停掉 1.5s 轮询
  useEffect(() => {
    configureTelemetryTarget({
      envId: selected,
      running: Boolean(running),
      space: activeSpaceId,
      activeTabId,
      inspectorOpen: !stageReplaced && inspectorOpen,
      inspectorTab,
    });
  }, [selected, running, activeSpaceId, activeTabId, stageReplaced, inspectorOpen, inspectorTab]);

  const liveTelemetry = telemetry.envId === selected && running ? telemetry : undefined;
  const consoleEntries = liveTelemetry?.logs ?? [];
  const networkEntries = liveTelemetry?.requests ?? [];
  const netRules = liveTelemetry?.rules ?? [];
  const netHits = liveTelemetry?.hits ?? [];
  const nav = liveTelemetry?.space === activeSpaceId ? liveTelemetry?.nav : undefined;
  const snapshot = telemetry.envId === selected ? telemetry.snapshot : undefined;
  const cookies = telemetry.envId === selected ? telemetry.cookies : undefined;

  const navigate = (action: NavigationAction) => {
    if (!current) return;
    void environmentActions.navigate(current.id, current.activeSpaceId ?? 'person', action);
  };

  /** 对右键菜单指定的标签执行刷新：若目标不是当前激活标签，先切换过去再刷新，避免误刷前景页。 */
  const reloadTab = (ref: TabRef | undefined, hard: boolean) => {
    if (!current) return;
    const space = current.activeSpaceId ?? 'person';
    const action: NavigationAction = { kind: hard ? 'hardReload' : 'reload' };
    if (ref !== undefined && ref !== activeTabId) {
      void environmentActions.tabSelect(current.id, space, ref).then(() => {
        void environmentActions.navigate(current.id, space, action);
      });
      return;
    }
    void environmentActions.navigate(current.id, space, action);
  };

  const shellStyle: CSSProperties = {
    '--sidebar-width': `${leftPanelPx}px`,
    '--left-panel-width': `${leftPanelPx}px`,
    ...(settings.compactTopbar
      ? {
          '--shell-top-row-height': '34px',
          '--shell-address-row-height': '38px',
        }
      : {}),
  } as CSSProperties;

  return (
    <TooltipProvider>
      <SidebarProvider style={shellStyle} className="block h-svh min-h-0 w-full overflow-clip">
        <div
          data-slot="app-frame"
          data-sidebar-mode={sidebarMode}
          className="flex h-full w-full min-w-0 flex-col overflow-clip bg-frame px-[var(--shell-frame-lip)] pb-[var(--shell-frame-lip)] text-foreground select-none"
          data-compact-topbar={settings.compactTopbar ? 'true' : 'false'}
        >
          <AppTitlebar
            route={effectiveRoute}
            environment={current}
            groups={groups}
            activeSpaceId={activeSpaceId}
            tabs={tabs}
            activeTabId={activeTabId}
            running={Boolean(running)}
            locked={locked}
            canNavigate={canNavigate}
            sidebarOpen={sidebarMode !== 'closed'}
            railPages={registry.railPages}
            activePluginPage={activePluginPage}
            pluginActions={registry.envActions}
            onToggleSidebar={toggleSidebar}
            onSpaceSelect={(id, space) => void environmentActions.selectSpace(id, space)}
            onTabSelect={(id, space, ref) => void environmentActions.tabSelect(id, space, ref)}
            onTabClose={(id, space, ref) => void environmentActions.tabClose(id, space, ref)}
            onTabCreate={(id, space) => void environmentActions.tabCreate(id, space)}
            onTabReload={(ref) => reloadTab(ref, false)}
            onTabHardReload={(ref) => reloadTab(ref, true)}
            onTabCloseOthers={(id, space, ref) => void environmentActions.tabCloseOthers(id, space, ref)}
            onTabCloseRight={(id, space, ref) => void environmentActions.tabCloseRight(id, space, ref)}
            onTabReorder={(id, space, from, to) => void environmentActions.tabReorder(id, space, from, to)}
            onTabToggleMute={(id, space, ref, muted) => void environmentActions.tabMute(id, space, ref, muted)}
            onTabSleep={(id, space, ref) => void environmentActions.tabSleep(id, space, ref)}
            onStart={(id) => void environmentActions.start(id)}
            onStop={(id) => void environmentActions.stop(id)}
            onHibernate={(id) => void environmentActions.hibernate(id)}
            onClearCache={(id) => void environmentActions.clearCache(id)}
            onRemove={(id) => void environmentActions.remove(id)}
            onMoveToGroup={(id, groupId) => void environmentActions.moveToGroup(id, groupId)}
            onRunPluginAction={(pluginId, command, envId) => void pluginActions.runAction(pluginId, command, envId)}
            onTakeover={(id) => void environmentActions.takeover(id)}
            onRelease={(id) => void environmentActions.release(id)}
            onOpenCommandBar={openCommandBar}
            onOpenSettings={(section) => openSettings(section)}
            onOpenPluginPage={(pluginId, surfaceId) => openPluginPage(pluginId, surfaceId)}
            onBackToEnvironments={openEnvironments}
          />

          {/* OpenBot 单一主工作区圆角卡片（14px radius + 1px 发丝边，承接侧栏 + 舞台 + 伴随抽屉 / 全局页） */}
          <div
            data-slot="workbench-card"
            className="relative flex min-h-0 flex-1 overflow-hidden rounded-[var(--shell-card-radius)] border border-border bg-canvas"
          >
            {/* 工作区常驻挂载不卸载，全局页覆盖在其上，切回时保留侧栏搜索、滚动与宽度 */}
            <div
              ref={workbenchGridRef}
              className={cn(
                'grid h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden',
                'transition-[grid-template-columns] duration-[var(--panel-resize-duration)] ease-[var(--ease-panel)]',
                stageReplaced && 'invisible pointer-events-none',
              )}
              style={{
                gridTemplateColumns: 'var(--left-panel-width) 0px minmax(0, 1fr)',
              }}
              inert={stageReplaced}
            >
              <div
                id="warren-sidebar-pane"
                data-slot="sidebar-pane"
                data-mode={sidebarMode}
                className={cn(
                  'h-full min-h-0 min-w-0 overflow-hidden bg-sidebar',
                  sidebarMode !== 'closed' && 'border-r border-border',
                )}
              >
                <EnvironmentSidebar
                  environments={environments}
                  groups={groups}
                  selected={selected}
                  ready={environmentsReady}
                  onSelect={(id) => void environmentActions.select(id)}
                  onStart={(id) => void environmentActions.start(id)}
                  onStop={(id) => void environmentActions.stop(id)}
                  onHibernate={(id) => void environmentActions.hibernate(id)}
                  onClearCache={(id) => void environmentActions.clearCache(id)}
                  onRemove={(id) => void environmentActions.remove(id)}
                  onTakeover={(id) => void environmentActions.takeover(id)}
                  onRelease={(id) => void environmentActions.release(id)}
                  onRenameGroup={(id, name) => void environmentActions.renameGroup(id, name)}
                  onRemoveGroup={(id) => void environmentActions.removeGroup(id)}
                  onToggleGroup={(id, collapsed) => void environmentActions.toggleGroup(id, collapsed)}
                  onMoveToGroup={(id, groupId) => void environmentActions.moveToGroup(id, groupId)}
                  pluginActions={registry.envActions}
                  onRunPluginAction={(pluginId, command, envId) =>
                    void pluginActions.runAction(pluginId, command, envId)
                  }
                  pluginBadges={pluginBadges}
                  compact={sidebarMode === 'compact'}
                  closed={sidebarMode === 'closed'}
                  paused={stageReplaced}
                  searchFocusToken={sidebarSearchFocusToken}
                  onExpandFromCompact={expandSidebarAndFocusSearch}
                  onToggleCompact={() => setSidebarCompact(sidebarMode !== 'compact')}
                />
              </div>

              {sidebarMode !== 'closed' ? (
                <PanelResizer
                  label="调整环境侧栏宽度"
                  controls="warren-sidebar-pane"
                  direction="left"
                  value={sidebarWidth}
                  defaultValue={SIDEBAR_WIDTH.default}
                  min={SIDEBAR_WIDTH.min}
                  max={SIDEBAR_WIDTH.max}
                  onResize={setSidebarWidth}
                  onResizeEnd={persistSidebarWidth}
                  onReset={() => {
                    setSidebarCompact(false);
                    setSidebarWidth(SIDEBAR_WIDTH.default);
                    persistSidebarWidth(SIDEBAR_WIDTH.default);
                  }}
                  snap={{
                    compactValue: SIDEBAR_WIDTH.compact,
                    compact: sidebarMode === 'compact',
                    collapseThreshold: SIDEBAR_WIDTH.collapseThreshold,
                    expandThreshold: SIDEBAR_WIDTH.expandThreshold,
                    onCompactChange: setSidebarCompact,
                  }}
                />
              ) : (
                <div aria-hidden="true" />
              )}

              <div className="h-full min-h-0 min-w-0 overflow-hidden">
                <EnvironmentStage
                  current={current}
                  events={events}
                  snapshot={snapshot}
                  snapshotLoading={telemetry.snapshotLoading}
                  onRefreshSnapshot={(id) => void telemetryActions.readSnapshot(id, activeSpaceId)}
                  cookies={cookies}
                  onReadCookies={(id) => void telemetryActions.readCookies(id)}
                  consoleEntries={consoleEntries}
                  networkEntries={networkEntries}
                  netRules={netRules}
                  netHits={netHits}
                  onNetRuleToggle={(id, ruleId, enabled) => void telemetryActions.toggleNetRule(id, ruleId, enabled)}
                  stageRef={stageRef}
                  stageReplaced={stageReplaced}
                  onInspectorMaximizedChange={setInspectorMaximized}
                  onStart={(id) => void environmentActions.start(id)}
                  onStartAndNavigate={(id, space, url) => void environmentActions.startAndNavigate(id, space, url)}
                  onTabSelect={(id, space, ref) => void environmentActions.tabSelect(id, space, ref)}
                  onTabClose={(id, space, ref) => void environmentActions.tabClose(id, space, ref)}
                  onTabCreate={(id, space) => void environmentActions.tabCreate(id, space)}
                  onTabReopen={(id, space) => void environmentActions.tabReopen(id, space)}
                  nav={nav}
                  onNavigate={navigate}
                  pluginTabs={registry.inspectorTabs}
                  pluginPopovers={registry.popovers}
                  pluginStatusBadges={registry.statusBadges}
                  pluginRailPages={registry.railPages}
                />
              </div>
            </div>

            {settingsOpen && (
              <div className="warren-page-enter absolute inset-0 z-20 flex min-h-0 flex-col bg-canvas">
                <Suspense fallback={null}>
                  <SettingsPage
                    section={settingsSection}
                    onSectionChange={(next) => setSettingsSection(next as SettingsSection)}
                    onChanged={() => void pluginActions.refreshAll()}
                    onClose={openEnvironments}
                    pluginSections={registry.settingsSections}
                    pluginErrors={registry.errors}
                    plugins={plugins}
                    environments={environments}
                  />
                </Suspense>
              </div>
            )}

            {!settingsOpen && activePluginPage && (
              <div className="warren-page-enter absolute inset-0 z-20 h-full overflow-auto bg-canvas">
                <PluginSurfaceHost
                  pluginId={activePluginPage.pluginId}
                  title={activePluginPage.title}
                  Component={activePluginPage.component}
                  props={{
                    pluginId: activePluginPage.pluginId,
                    environmentId: selected,
                    space: activeSpaceId,
                    url: nav?.url || current?.currentUrl || '',
                    openPluginPage: (surfaceId) =>
                      openPluginPage(activePluginPage.pluginId, surfaceId ?? activePluginPage.id),
                    openInspectorTab: (surfaceId) => {
                      const targetId =
                        surfaceId ?? registry.inspectorTabs.find((t) => t.pluginId === activePluginPage.pluginId)?.id;
                      if (!targetId) return;
                      openEnvironments();
                      requestPluginInspector(activePluginPage.pluginId, targetId);
                    },
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </SidebarProvider>

      <Toaster position="top-center" offset={{ top: 6 }} />
    </TooltipProvider>
  );
}
