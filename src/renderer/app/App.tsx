import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { AppTitlebar } from '@/app/app-titlebar';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EnvironmentSidebar } from '@/features/environments/environment-sidebar';
import { EnvironmentStage } from '@/features/environments/environment-stage';
import { SettingsPage } from '@/features/settings/settings-page';
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
import type { NavigationAction, SpaceId } from '@shared/types';

/** 侧栏宽度阶梯。react-resizable-panels v4 里数字即像素。 */
const SIDEBAR_WIDTH = { default: 248, min: 200, max: 420, collapsed: 0 };

export function App() {
  const { environments, groups, events, selected, ready: environmentsReady } = useEnvironmentState();
  const { plugins, settings, registry } = usePluginState();
  const { route, settingsSection, requestedPage, inspectorOpen, inspectorTab } = useNavigationState();
  const telemetry = useTelemetryState();
  const pluginBadges = usePluginBadges();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const sidebarPanelRef = usePanelRef();
  const sidebarElementRef = useRef<HTMLDivElement>(null);

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
  const locked = activeSpaceId === 'agent' && activeSpace?.owner !== 'human';
  const canNavigate = Boolean(running) && (activeSpaceId === 'person' || activeSpace?.owner === 'human');

  /*
   * 用实测宽度判断侧栏是否收起（不依赖 Panel.onResize：命令式 collapse() 不触发它，见 AGENTS.md）。
   * 全局页以绝对覆层盖在工作区上方，不卸载侧栏 DOM，宽度始终真实有效。
   */
  useEffect(() => {
    const node = sidebarElementRef.current;
    if (!node) return;
    const sync = () => setSidebarCollapsed(node.getBoundingClientRect().width <= SIDEBAR_WIDTH.collapsed + 1);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /*
   * 首次挂载时将侧栏对齐至默认像素宽，避免 react-resizable-panels v4 首帧按比例落偏。
   */
  useEffect(() => {
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        sidebarPanelRef.current?.resize(SIDEBAR_WIDTH.default);
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
    };
  }, [sidebarPanelRef]);

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
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (sidebarCollapsed) panel.expand();
    else panel.collapse();
  }, [sidebarCollapsed, sidebarPanelRef]);

  // ⌘K 全局命令栏（走 OverlayHost 独立透明层，不挡也不藏底层网页）
  useEffect(() => {
    return window.envApi.onBrowserShortcut((shortcut) => {
      if (shortcut === 'commandBar') openCommandBar();
    });
  }, [openCommandBar]);

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

  useEffect(() => {
    void window.envApi.setViewVisible(!stageReplaced);
  }, [stageReplaced]);

  /*
   * WebContentsView 是原生视图，不遵守 DOM 布局；把占位区的实际矩形报给主进程。
   * 侧栏与舞台常驻不卸载，切回环境时立刻重报一次确保坐标零漂移。
   */
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const report = () => {
      if (stageReplaced) return;
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
    window.addEventListener('resize', report);
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [stageReplaced]);

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

  const shellStyle: CSSProperties = {
    '--sidebar-width': `${SIDEBAR_WIDTH.default}px`,
    ...(settings.compactTopbar
      ? {
          '--shell-top-row-height': '2.125rem',
          '--shell-address-row-height': '2.125rem',
        }
      : {}),
  } as CSSProperties;

  return (
    <TooltipProvider>
      <SidebarProvider style={shellStyle} className="block h-svh min-h-0 w-full overflow-clip">
        <div
          className="flex h-full w-full min-w-0 overflow-clip bg-surface-under pr-[var(--shell-frame-lip)] pb-[var(--shell-frame-lip)] text-foreground select-none"
          data-compact-topbar={settings.compactTopbar ? 'true' : 'false'}
        >
          <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-clip bg-surface-under">
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
              sidebarOpen={!sidebarCollapsed}
              railPages={registry.railPages}
              activePluginPage={activePluginPage}
              pluginActions={registry.envActions}
              onToggleSidebar={toggleSidebar}
              onSpaceSelect={(id, space) => void environmentActions.selectSpace(id, space)}
              onTabSelect={(id, space, ref) => void environmentActions.tabSelect(id, space, ref)}
              onTabClose={(id, space, ref) => void environmentActions.tabClose(id, space, ref)}
              onTabCreate={(id, space) => void environmentActions.tabCreate(id, space)}
              onTabReload={() => navigate({ kind: 'reload' })}
              onTabHardReload={() => navigate({ kind: 'hardReload' })}
              onTabCloseOthers={(id, space, ref) => void environmentActions.tabCloseOthers(id, space, ref)}
              onTabCloseRight={(id, space, ref) => void environmentActions.tabCloseRight(id, space, ref)}
              onTabReorder={(id, space, from, to) => void environmentActions.tabReorder(id, space, from, to)}
              onTabToggleMute={(id, space, ref, muted) => void environmentActions.tabMute(id, space, ref, muted)}
              onStart={(id) => void environmentActions.start(id)}
              onStop={(id) => void environmentActions.stop(id)}
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

            <div className="relative flex min-h-0 flex-1">
              {/* 工作区常驻挂载不卸载，全局页以绝对覆层盖在其上，切回时保留侧栏搜索、滚动与宽度 */}
              <div
                className={cn(
                  'flex min-h-0 min-w-0 flex-1 overflow-hidden',
                  stageReplaced && 'invisible pointer-events-none',
                )}
                inert={stageReplaced}
              >
                <ResizablePanelGroup orientation="horizontal" className="h-full min-w-0">
                  <ResizablePanel
                    id="sidebar"
                    panelRef={sidebarPanelRef}
                    elementRef={sidebarElementRef}
                    defaultSize={SIDEBAR_WIDTH.default}
                    minSize={SIDEBAR_WIDTH.min}
                    maxSize={SIDEBAR_WIDTH.max}
                    collapsible
                    collapsedSize={SIDEBAR_WIDTH.collapsed}
                    className="min-w-0"
                  >
                    <EnvironmentSidebar
                      environments={environments}
                      groups={groups}
                      selected={selected}
                      ready={environmentsReady}
                      onSelect={(id) => void environmentActions.select(id)}
                      onStart={(id) => void environmentActions.start(id)}
                      onStop={(id) => void environmentActions.stop(id)}
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
                      compact={sidebarCollapsed}
                    />
                  </ResizablePanel>

                  <ResizableHandle subtle />

                  <ResizablePanel id="stage" className="min-w-0">
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
                      onNetRuleToggle={(id, ruleId, enabled) =>
                        void telemetryActions.toggleNetRule(id, ruleId, enabled)
                      }
                      stageRef={stageRef}
                      stageReplaced={stageReplaced}
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
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>

              {settingsOpen && (
                <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background animate-in fade-in-0 duration-150 motion-reduce:animate-none">
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
                </div>
              )}

              {!settingsOpen && activePluginPage && (
                <div className="absolute inset-0 z-20 h-full overflow-auto bg-background animate-in fade-in-0 duration-150 motion-reduce:animate-none">
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
        </div>
      </SidebarProvider>

      <Toaster position="top-center" offset={{ top: 6 }} />
    </TooltipProvider>
  );
}
