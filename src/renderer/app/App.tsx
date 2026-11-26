import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { AppRail, type RailDestination } from '@/app/app-rail';
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
import { environmentActions, useEnvironmentState } from '@/state/environment-store';
import {
  openEnvironments,
  openPluginPage,
  openSettings,
  setSettingsSection,
  toggleSettings,
  useNavigationState,
  type SettingsSection,
} from '@/state/navigation-store';
import { pluginActions, usePluginState } from '@/state/plugin-store';
import { configureTelemetryTarget, telemetryActions, useTelemetryState } from '@/state/telemetry-store';
import type { NavigationAction, SpaceId } from '@shared/types';

/** 侧栏宽度阶梯。react-resizable-panels v4 里数字即像素。 */
const SIDEBAR_WIDTH = { default: 260, min: 200, max: 420, collapsed: 0 };

export function App() {
  const { environments, groups, events, selected } = useEnvironmentState();
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
  const stageReplaced = settingsOpen || Boolean(activePluginPage);
  const sidebarVisible = !stageReplaced;

  const current = environments.find((env) => env.id === selected);
  const running = current?.status === 'running';
  const activeSpaceId: SpaceId = current?.activeSpaceId ?? 'person';
  const activeSpace = (current?.spaces ?? []).find((space) => space.id === activeSpaceId);
  const activeTabId = activeSpace?.activeTabId ?? current?.activeTabId;

  /*
   * 用实测宽度判断侧栏是否收起（不依赖 Panel.onResize：命令式 collapse() 不触发它，见 AGENTS.md）。
   */
  useEffect(() => {
    const node = sidebarElementRef.current;
    if (!node) return;
    const sync = () => setSidebarCollapsed(node.getBoundingClientRect().width <= SIDEBAR_WIDTH.collapsed + 1);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, [sidebarVisible]);

  /*
   * 侧栏每次（重）挂都把默认宽度定在 260px，避免 v4 首帧按 % 计算落成其它值。
   */
  useEffect(() => {
    if (!sidebarVisible) return;
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
  }, [sidebarPanelRef, sidebarVisible]);

  const openCommandBar = useCallback(() => {
    void window.envApi
      .openOverlay<{ command?: string; section?: SettingsSection } | null>({ kind: 'command-bar' })
      .then((result) => {
        if (result?.command === 'openSettings') {
          openSettings(result.section);
        }
      });
  }, []);

  // ⌘K 全局命令栏（走 OverlayHost 独立透明层，不挡也不藏底层网页）
  useEffect(() => {
    return window.envApi.onBrowserShortcut((shortcut) => {
      if (shortcut === 'commandBar') openCommandBar();
    });
  }, [openCommandBar]);

  useEffect(() => {
    void window.envApi.setViewVisible(!stageReplaced);
  }, [stageReplaced]);

  /*
   * WebContentsView 是原生视图，不遵守 DOM 布局；把占位区的实际矩形报给主进程。
   * 依赖 stageReplaced 以确保从设置页 / 插件页切回后重新观察新的 DOM 节点。
   */
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const report = () => {
      const rect = node.getBoundingClientRect();
      void window.envApi.setViewport({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    window.addEventListener('resize', report);
    return () => {
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

  const toggleSidebar = () => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (sidebarCollapsed) panel.expand();
    else panel.collapse();
  };

  const navigate = (action: NavigationAction) => {
    if (!current) return;
    void environmentActions.navigate(current.id, current.activeSpaceId ?? 'person', action);
  };

  const railDestinations: RailDestination[] = [
    {
      id: 'environments',
      label: '环境',
      icon: 'Folder',
      active: !activePluginPage && !settingsOpen,
      onSelect: () => {
        openEnvironments();
        if (sidebarCollapsed) sidebarPanelRef.current?.expand();
      },
    },
    ...registry.railPages.map((page) => ({
      id: `plugin:${page.pluginId}:${page.id}`,
      label: page.title,
      icon: page.icon ?? 'Puzzle',
      active: activePluginPage?.id === page.id && activePluginPage.pluginId === page.pluginId,
      onSelect: () => openPluginPage(page.pluginId, page.id),
    })),
  ];

  const shellStyle: CSSProperties = {
    '--sidebar-width': `${SIDEBAR_WIDTH.default}px`,
    ...(settings.compactTopbar
      ? {
          '--shell-chrome-row-height': '1.9rem',
          '--shell-address-row-height': '2.375rem',
        }
      : {}),
  } as CSSProperties;

  return (
    <TooltipProvider>
      <SidebarProvider style={shellStyle} className="block h-svh min-h-0">
        <div
          className="flex h-full overflow-hidden bg-surface-recessed pr-[var(--shell-frame-lip)] pb-[var(--shell-frame-lip)] text-foreground select-none"
          data-compact-topbar={settings.compactTopbar ? 'true' : 'false'}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-clip rounded-[var(--shell-card-radius)] bg-background">
            <AppTitlebar
              environment={current}
              groupName={current?.groupId ? groups.find((g) => g.id === current.groupId)?.name : undefined}
              showSidebarToggle={sidebarVisible}
              sidebarOpen={!sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              onTakeover={(id) => void environmentActions.takeover(id)}
              onRelease={(id) => void environmentActions.release(id)}
            />

            <div className="flex min-h-0 flex-1">
              <AppRail
                settingsActive={settingsOpen}
                onOpenSettings={() => toggleSettings()}
                onOpenCommandBar={openCommandBar}
                destinations={railDestinations}
              />

              <ResizablePanelGroup
                key={sidebarVisible ? 'with-sidebar' : 'no-sidebar'}
                orientation="horizontal"
                className="h-full min-w-0"
              >
                {sidebarVisible && (
                  <>
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

                    <ResizableHandle />
                  </>
                )}

                <ResizablePanel id="stage" className="min-w-0">
                  {settingsOpen ? (
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
                  ) : activePluginPage ? (
                    <div className="h-full overflow-auto bg-background">
                      <PluginSurfaceHost
                        pluginId={activePluginPage.pluginId}
                        title={activePluginPage.title}
                        Component={activePluginPage.component}
                        props={{ pluginId: activePluginPage.pluginId, environmentId: selected }}
                      />
                    </div>
                  ) : (
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
                      onSpaceSelect={(id, space) => void environmentActions.selectSpace(id, space)}
                      onTabSelect={(id, space, ref) => void environmentActions.tabSelect(id, space, ref)}
                      onTabClose={(id, space, ref) => void environmentActions.tabClose(id, space, ref)}
                      onTabCreate={(id, space) => void environmentActions.tabCreate(id, space)}
                      onTabCloseOthers={(id, space, ref) => void environmentActions.tabCloseOthers(id, space, ref)}
                      onTabCloseRight={(id, space, ref) => void environmentActions.tabCloseRight(id, space, ref)}
                      onTabReorder={(id, space, from, to) => void environmentActions.tabReorder(id, space, from, to)}
                      onTabReopen={(id, space) => void environmentActions.tabReopen(id, space)}
                      onTabToggleMute={(id, space, ref, muted) =>
                        void environmentActions.tabMute(id, space, ref, muted)
                      }
                      nav={nav}
                      onNavigate={navigate}
                      pluginTabs={registry.inspectorTabs}
                      sidebarCollapsed={sidebarCollapsed}
                    />
                  )}
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          </div>
        </div>
      </SidebarProvider>

      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
