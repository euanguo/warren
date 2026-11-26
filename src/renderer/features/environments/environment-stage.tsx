import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { toast } from 'sonner';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
import { Icon } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Kbd } from '@/components/ui/kbd';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { EnvironmentAddressBar } from './environment-address-bar';
import { EnvironmentInspector } from './environment-inspector';
import { egressLabel } from './sidebar-env-row';
import type { PluginInspectorTab, PluginPopoverSurface } from '@/lib/plugin-runtime';
import { WarrenMark } from '@/components/warren-mark';
import { setInspectorOpen, setInspectorTab, useNavigationState } from '@/state/navigation-store';
import { shouldExcludeRightPanels } from '@/state/workbench-layout';
import type {
  ConsoleEntry,
  CookieSummary,
  DevToolsDockMode,
  Environment,
  EventRecord,
  NavigationAction,
  NavigationState,
  NetworkEntry,
  NetHit,
  NetRule,
  SnapshotResult,
  SpaceId,
  TabRef,
  ViewportPresetId,
} from '@shared/types';

interface Props {
  current?: Environment;
  events: EventRecord[];
  snapshot?: SnapshotResult;
  snapshotLoading: boolean;
  onRefreshSnapshot: (id: string) => void;
  cookies?: CookieSummary[];
  onReadCookies: (id: string) => void;
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  netRules: NetRule[];
  netHits: NetHit[];
  onNetRuleToggle: (id: string, ruleId: string, enabled: boolean) => void;
  stageRef: RefObject<HTMLDivElement | null>;
  stageReplaced?: boolean;
  onStart: (id: string) => void;
  onStartAndNavigate: (id: string, space: SpaceId, url: string) => void;
  onTabSelect: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabClose: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabCreate: (id: string, space: SpaceId) => void;
  onTabReopen: (id: string, space: SpaceId) => void;
  nav?: NavigationState | null;
  onNavigate: (action: NavigationAction) => void;
  pluginTabs?: PluginInspectorTab[];
  pluginPopovers?: PluginPopoverSurface[];
}

const INSPECTOR_WIDTH = { default: 360, min: 260, max: 720 };
const INSPECTOR_WIDTH_KEY = 'warren.inspector.width';
const INSPECTOR_TABS = ['events', 'snapshot', 'console', 'network', 'rules', 'storage'] as const;

export function EnvironmentStage({
  current,
  events,
  snapshot,
  snapshotLoading,
  onRefreshSnapshot,
  cookies,
  onReadCookies,
  consoleEntries,
  networkEntries,
  netRules,
  netHits,
  onNetRuleToggle,
  stageRef,
  stageReplaced = false,
  onStart,
  onStartAndNavigate,
  onTabSelect,
  onTabClose,
  onTabCreate,
  onTabReopen,
  nav,
  onNavigate,
  pluginTabs = [],
  pluginPopovers = [],
}: Props) {
  const running = current?.status === 'running';
  const activeSpaceId: SpaceId = current?.activeSpaceId ?? 'person';
  const activeSpace = (current?.spaces ?? []).find((space) => space.id === activeSpaceId);
  const tabs = activeSpace?.tabs ?? current?.tabs ?? [];
  const activeTabId = activeSpace?.activeTabId ?? current?.activeTabId;
  const locked = activeSpaceId === 'agent' && activeSpace?.owner !== 'human';
  const canNavigate = running && (activeSpaceId === 'person' || activeSpace?.owner === 'human');
  const canStartOnSubmit = Boolean(current && !running && activeSpaceId === 'person');
  const [addressFocusToken, setAddressFocusToken] = useState(0);
  const [activePopoverKey, setActivePopoverKey] = useState<string | null>(null);
  const activePopover = activePopoverKey
    ? pluginPopovers.find((pop) => `${pop.pluginId}:${pop.id}` === activePopoverKey)
    : undefined;

  const [pagePrefs, setPagePrefs] = useState<{
    envId: string;
    spaceId: SpaceId;
    zoom: number;
    preset: ViewportPresetId;
    devTools: { open: boolean; dock: DevToolsDockMode; size: number };
    hasActiveDownload: boolean;
  }>();
  const [hoverTarget, setHoverTarget] = useState<{ envId: string; url: string }>({ envId: '', url: '' });

  const activePrefs =
    current && running && pagePrefs?.envId === current.id && pagePrefs.spaceId === activeSpaceId
      ? pagePrefs
      : undefined;
  const zoomFactor = activePrefs?.zoom ?? 1;
  const viewportPreset = activePrefs?.preset ?? 'auto';
  const devToolsState = activePrefs?.devTools ?? { open: false, dock: 'right' as DevToolsDockMode, size: 420 };
  const hasActiveDownload = activePrefs?.hasActiveDownload ?? false;

  const inspectorPanelRef = usePanelRef();
  const inspectorElementRef = useRef<HTMLDivElement>(null);
  const stageContainerRef = useRef<HTMLDivElement>(null);
  const { inspectorOpen, inspectorTab } = useNavigationState();
  const inspectorTabIds = [...INSPECTOR_TABS, ...pluginTabs.map((tab) => `plugin:${tab.pluginId}:${tab.id}`)];
  const activeInspectorTab = inspectorTabIds.includes(inspectorTab) ? inspectorTab : 'events';
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0
      ? Math.min(INSPECTOR_WIDTH.max, Math.max(INSPECTOR_WIDTH.min, saved))
      : INSPECTOR_WIDTH.default;
  });
  const inspectorWidthRef = useRef(inspectorWidth);
  useEffect(() => {
    inspectorWidthRef.current = inspectorWidth;
  }, [inspectorWidth]);

  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth)), 250);
    return () => window.clearTimeout(timer);
  }, [inspectorWidth]);

  useEffect(() => {
    return window.envApi.onTargetUrl((payload) => setHoverTarget(payload));
  }, []);

  const syncPagePrefs = useCallback(async () => {
    if (!current || !running) return;
    const envId = current.id;
    const spaceId = activeSpaceId;
    const [z, p, d, dl] = await Promise.all([
      window.envApi.getZoom(envId, spaceId),
      window.envApi.getViewportPreset(envId, spaceId),
      window.envApi.getDevToolsState(),
      window.envApi.downloads(envId),
    ]);
    setPagePrefs({
      envId,
      spaceId,
      zoom: z.factor,
      preset: p.preset,
      devTools: d,
      hasActiveDownload: dl.some((item) => item.state === 'progressing'),
    });
  }, [current, running, activeSpaceId]);

  useEffect(() => {
    if (!current || !running) return;
    let cancelled = false;
    const pull = () => {
      void Promise.all([
        window.envApi.getZoom(current.id, activeSpaceId),
        window.envApi.getViewportPreset(current.id, activeSpaceId),
        window.envApi.getDevToolsState(),
        window.envApi.downloads(current.id),
      ]).then(([z, p, d, dl]) => {
        if (cancelled) return;
        setPagePrefs({
          envId: current.id,
          spaceId: activeSpaceId,
          zoom: z.factor,
          preset: p.preset,
          devTools: d,
          hasActiveDownload: dl.some((item) => item.state === 'progressing'),
        });
      });
    };
    pull();
    const unsub = window.envApi.onStateChanged(pull);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [current, running, activeSpaceId, activeTabId, nav?.url]);

  const shouldExcludeRight = useCallback(
    (dock: DevToolsDockMode = devToolsState.dock) =>
      shouldExcludeRightPanels({
        stageContainerWidth: stageContainerRef.current?.getBoundingClientRect().width ?? 0,
        inspectorWidth: inspectorWidthRef.current,
        devToolsDock: dock,
        devToolsSize: devToolsState.size,
      }),
    [devToolsState.dock, devToolsState.size],
  );

  const toggleInspector = useCallback(() => {
    const panel = inspectorPanelRef.current;
    if (!panel) return;
    if (inspectorOpen) {
      panel.collapse();
      return;
    }
    if (current && running && devToolsState.open && shouldExcludeRight(devToolsState.dock)) {
      void window.envApi.closeDevTools(current.id, activeSpaceId).then(() => void syncPagePrefs());
      toast.info('已收起右侧 DevTools 为工作台留出空间', {
        description: '右键 </> 可切换底部停靠或独立窗口以便并行查看',
      });
    }
    panel.expand();
  }, [
    inspectorOpen,
    inspectorPanelRef,
    current,
    running,
    devToolsState.open,
    devToolsState.dock,
    activeSpaceId,
    shouldExcludeRight,
    syncPagePrefs,
  ]);

  const toggleDevTools = useCallback(() => {
    if (!current || !canNavigate) return;
    if (devToolsState.open) {
      void window.envApi.closeDevTools(current.id, activeSpaceId).then(() => void syncPagePrefs());
    } else {
      if (inspectorOpen && shouldExcludeRight(devToolsState.dock)) {
        inspectorPanelRef.current?.collapse();
        toast.info('已收起工作台抽屉为 DevTools 留出空间', {
          description: '右键 </> 可切换底部停靠或独立窗口以便并行查看',
        });
      }
      void window.envApi.openDevTools(current.id, activeSpaceId).then(() => void syncPagePrefs());
    }
  }, [
    current,
    canNavigate,
    activeSpaceId,
    devToolsState.open,
    devToolsState.dock,
    inspectorOpen,
    inspectorPanelRef,
    shouldExcludeRight,
    syncPagePrefs,
  ]);

  const changeDevToolsDock = useCallback(
    (dock: DevToolsDockMode) => {
      if (dock === 'right' && devToolsState.open && inspectorOpen && shouldExcludeRight('right')) {
        inspectorPanelRef.current?.collapse();
      }
      void window.envApi.setDevToolsDock(dock).then(() => void syncPagePrefs());
    },
    [devToolsState.open, inspectorOpen, inspectorPanelRef, shouldExcludeRight, syncPagePrefs],
  );

  const openFindPopover = useCallback(() => {
    if (!current || !running || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    void window.envApi.openPopover({
      id: 'find-in-page',
      anchorRect: {
        x: Math.max(Math.round(rect.left + 8), Math.round(rect.right - 340)),
        y: Math.round(rect.top + 8),
        width: 328,
        height: 1,
      },
      size: { width: 328, height: 42 },
      placement: 'bottom-end',
      focusable: true,
      beyondWindow: true,
      props: { envId: current.id, space: activeSpaceId },
    });
  }, [current, running, activeSpaceId, stageRef]);

  useEffect(() => {
    return window.envApi.onBrowserShortcut((shortcut) => {
      if (shortcut === 'commandBar') return;
      if (shortcut === 'devtools') {
        if (canNavigate && current) toggleDevTools();
        return;
      }
      if (shortcut === 'inspector') {
        toggleInspector();
        return;
      }
      if (!current || !running) return;
      if (shortcut === 'newTab') {
        if (!locked) onTabCreate(current.id, activeSpaceId);
        return;
      }
      if (shortcut === 'closeTab') {
        if (!locked && activeTabId) onTabClose(current.id, activeSpaceId, activeTabId);
        return;
      }
      if (shortcut === 'reopenTab') {
        if (!locked) onTabReopen(current.id, activeSpaceId);
        return;
      }
      if (shortcut === 'reload') {
        if (canNavigate) onNavigate({ kind: 'reload' });
        return;
      }
      if (shortcut === 'hardReload') {
        if (canNavigate) onNavigate({ kind: 'hardReload' });
        return;
      }
      if (shortcut === 'focusAddress') {
        setAddressFocusToken((token) => token + 1);
        return;
      }
      if (shortcut === 'find') {
        openFindPopover();
        return;
      }
      if (shortcut === 'findNext' || shortcut === 'findPrev') {
        openFindPopover();
        return;
      }
      if (shortcut === 'zoomIn' || shortcut === 'zoomOut' || shortcut === 'zoomReset') {
        const mode = shortcut === 'zoomIn' ? 'in' : shortcut === 'zoomOut' ? 'out' : 'reset';
        void window.envApi
          .setZoom(current.id, activeSpaceId, mode)
          .then(({ factor }) =>
            setPagePrefs((prev) =>
              prev && prev.envId === current.id && prev.spaceId === activeSpaceId ? { ...prev, zoom: factor } : prev,
            ),
          );
        return;
      }
      if (shortcut === 'print') {
        void window.envApi.printPage(current.id, activeSpaceId);
        return;
      }
      if (shortcut === 'savePage') {
        void window.envApi.savePage(current.id, activeSpaceId);
        return;
      }
      if (typeof shortcut === 'object' && 'selectTab' in shortcut) {
        if (!locked && shortcut.selectTab <= tabs.length) onTabSelect(current.id, activeSpaceId, shortcut.selectTab);
      }
    });
  }, [
    canNavigate,
    current,
    running,
    activeSpaceId,
    activeTabId,
    locked,
    tabs.length,
    toggleDevTools,
    toggleInspector,
    openFindPopover,
    onTabCreate,
    onTabClose,
    onNavigate,
    onTabSelect,
    onTabReopen,
  ]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const panel = inspectorPanelRef.current;
      if (!panel) return;
      panel.resize(inspectorWidthRef.current);
      panel.collapse();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inspectorPanelRef]);

  useEffect(() => {
    const node = inspectorElementRef.current;
    if (!node) return;
    const sync = () => setInspectorOpen(node.getBoundingClientRect().width > 1);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 未启动环境时按 Enter 快速拉起（不在输入框/按钮/弹窗中时触发）
  useEffect(() => {
    if (!current || running || stageReplaced) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, a, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      onStart(current.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [current, running, stageReplaced, onStart]);

  const openPluginSurface = useCallback(
    (kind: 'popover' | 'inspectorTab', pluginId: string, surfaceId: string) => {
      if (kind === 'popover') {
        setActivePopoverKey(`${pluginId}:${surfaceId}`);
      } else {
        setActivePopoverKey(null);
        setInspectorTab(`plugin:${pluginId}:${surfaceId}`);
      }
      if (!inspectorOpen && current && running && devToolsState.open && shouldExcludeRight(devToolsState.dock)) {
        void window.envApi.closeDevTools(current.id, activeSpaceId).then(() => void syncPagePrefs());
      }
      inspectorPanelRef.current?.expand();
    },
    [
      inspectorOpen,
      inspectorPanelRef,
      current,
      running,
      devToolsState.open,
      devToolsState.dock,
      activeSpaceId,
      shouldExcludeRight,
      syncPagePrefs,
    ],
  );

  const showTargetUrl = running && current?.id === hoverTarget.envId && Boolean(hoverTarget.url);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <EnvironmentAddressBar
        envId={current?.id}
        spaceId={activeSpaceId}
        url={nav?.url || current?.currentUrl || ''}
        loading={nav?.loading ?? false}
        editable={Boolean(canNavigate)}
        canStartOnSubmit={canStartOnSubmit}
        running={Boolean(running)}
        canGoBack={nav?.canGoBack ?? false}
        canGoForward={nav?.canGoForward ?? false}
        inspectorOpen={inspectorOpen}
        devToolsOpen={devToolsState.open}
        devToolsDock={devToolsState.dock}
        zoomFactor={zoomFactor}
        viewportPreset={viewportPreset}
        hasActiveDownload={hasActiveDownload}
        focusToken={addressFocusToken}
        pluginPopovers={pluginPopovers}
        pluginInspectorTabs={pluginTabs}
        onToggleInspector={() => {
          setActivePopoverKey(null);
          toggleInspector();
        }}
        onToggleDevTools={toggleDevTools}
        onChangeDevToolsDock={changeDevToolsDock}
        onResetZoom={() => {
          if (current) {
            void window.envApi
              .setZoom(current.id, activeSpaceId, 'reset')
              .then(({ factor }) =>
                setPagePrefs((prev) =>
                  prev && prev.envId === current.id && prev.spaceId === activeSpaceId
                    ? { ...prev, zoom: factor }
                    : prev,
                ),
              );
          }
        }}
        onOpenFind={openFindPopover}
        onViewportPresetChanged={(preset) =>
          setPagePrefs((prev) =>
            prev && current && prev.envId === current.id && prev.spaceId === activeSpaceId ? { ...prev, preset } : prev,
          )
        }
        onNavigate={onNavigate}
        onStartAndNavigate={(targetUrl) => {
          if (current) onStartAndNavigate(current.id, activeSpaceId, targetUrl);
        }}
        onOpenPluginSurface={openPluginSurface}
      />

      <div ref={stageContainerRef} className="flex min-h-0 flex-1">
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel id="page" className="min-w-0">
            <div className="h-full bg-surface-recessed p-1.5">
              <div
                ref={stageRef}
                data-slot="stage-placeholder"
                className="relative h-full rounded-[var(--radius-sm)] bg-muted/20 ring-1 ring-border/75"
              >
                {(!running || tabs.length === 0) && (
                  <Empty className="absolute inset-0 border-0">
                    <EmptyHeader>
                      <EmptyMedia>
                        <WarrenMark className="size-12" />
                      </EmptyMedia>
                      <EmptyTitle>
                        {!current ? '还没有选择环境' : running ? '这个空间还没有标签' : `环境「${current.name}」未启动`}
                      </EmptyTitle>
                      <EmptyDescription>
                        {!current
                          ? '新建或从左侧选择一个隔离环境，页面会在这里显示。'
                          : running
                            ? '新建标签页开始浏览，或在上方地址栏直接输入网址。'
                            : `${egressLabel(current.proxy)}${current.startUrl ? ` · 默认打开 ${current.startUrl}` : ''}`}
                      </EmptyDescription>
                    </EmptyHeader>
                    {!current ? (
                      <Button
                        data-slot="stage-create-env-button"
                        onClick={() => void window.envApi.openOverlay({ kind: 'create-env' })}
                      >
                        <Icon name="Plus" />
                        新建环境
                      </Button>
                    ) : running ? (
                      !locked && (
                        <Button onClick={() => onTabCreate(current.id, activeSpaceId)}>
                          <Icon name="Plus" />
                          新建标签页
                        </Button>
                      )
                    ) : (
                      <div className="flex flex-col items-center gap-3">
                        <div className="flex items-center gap-2">
                          <Button data-slot="stage-start-button" onClick={() => onStart(current.id)}>
                            <Icon name="Play" />
                            启动「{current.name}」
                          </Button>
                          <Button
                            variant="outline"
                            data-slot="stage-edit-button"
                            onClick={() => void window.envApi.openOverlay({ kind: 'edit-env', environment: current })}
                          >
                            <Icon name="Pencil" />
                            编辑配置
                          </Button>
                        </div>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          按 <Kbd>Enter</Kbd> 直接启动，或在上方地址栏输入网址回车自动启动
                        </span>
                      </div>
                    )}
                  </Empty>
                )}
                {showTargetUrl && (
                  <div
                    data-slot="target-url-preview"
                    className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 max-w-[65%] truncate rounded-[var(--radius-sm)] border border-border/60 bg-popover/90 px-2 py-0.5 font-mono text-[11px] text-popover-foreground shadow-sm"
                  >
                    {hoverTarget.url}
                  </div>
                )}
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel
            id="inspector"
            panelRef={inspectorPanelRef}
            elementRef={inspectorElementRef}
            defaultSize={inspectorWidth}
            minSize={INSPECTOR_WIDTH.min}
            maxSize={INSPECTOR_WIDTH.max}
            onResize={(size) => {
              if (size.inPixels > 0) setInspectorWidth(size.inPixels);
            }}
            collapsible
            collapsedSize={0}
            className="min-w-0"
          >
            {activePopover ? (
              <div data-slot="plugin-popover-drawer" className="flex h-full flex-col bg-background">
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                  <span className="truncate text-xs font-medium">{activePopover.title}</span>
                  <div className="flex items-center gap-1">
                    <Button size="xs" variant="ghost" onClick={() => setActivePopoverKey(null)}>
                      返回检查器
                    </Button>
                    <IconButton
                      title="收起工作台"
                      onClick={() => {
                        setActivePopoverKey(null);
                        inspectorPanelRef.current?.collapse();
                      }}
                    >
                      <Icon name="X" />
                    </IconButton>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <PluginSurfaceHost
                    pluginId={activePopover.pluginId}
                    title={activePopover.title}
                    Component={activePopover.component}
                    props={{ pluginId: activePopover.pluginId, environmentId: current?.id }}
                  />
                </div>
              </div>
            ) : (
              <EnvironmentInspector
                current={current}
                events={events}
                snapshot={snapshot}
                snapshotLoading={snapshotLoading}
                consoleEntries={consoleEntries}
                networkEntries={networkEntries}
                netRules={netRules}
                netHits={netHits}
                onNetRuleToggle={(ruleId, enabled) => current && onNetRuleToggle(current.id, ruleId, enabled)}
                activeTab={activeInspectorTab}
                onTabChange={(tab) => {
                  setInspectorTab(tab);
                  if (tab === 'storage' && current) onReadCookies(current.id);
                }}
                onRefreshSnapshot={() => current && onRefreshSnapshot(current.id)}
                cookies={cookies}
                pluginTabs={pluginTabs}
                environmentId={current?.id}
              />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </main>
  );
}
