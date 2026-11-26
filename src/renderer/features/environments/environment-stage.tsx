import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { EnvironmentAddressBar } from './environment-address-bar';
import { EnvironmentInspector } from './environment-inspector';
import type { PluginInspectorTab } from '@/lib/plugin-runtime';
import { WarrenMark } from '@/components/warren-mark';
import { setInspectorOpen, setInspectorTab, useNavigationState } from '@/state/navigation-store';
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
  sidebarCollapsed: boolean;
  onTabSelect: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabClose: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabCreate: (id: string, space: SpaceId) => void;
  onTabReopen: (id: string, space: SpaceId) => void;
  nav?: NavigationState | null;
  onNavigate: (action: NavigationAction) => void;
  pluginTabs?: PluginInspectorTab[];
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
  onTabSelect,
  onTabClose,
  onTabCreate,
  onTabReopen,
  nav,
  onNavigate,
  pluginTabs = [],
  sidebarCollapsed,
}: Props) {
  const running = current?.status === 'running';
  const activeSpaceId: SpaceId = current?.activeSpaceId ?? 'person';
  const activeSpace = (current?.spaces ?? []).find((space) => space.id === activeSpaceId);
  const tabs = activeSpace?.tabs ?? current?.tabs ?? [];
  const activeTabId = activeSpace?.activeTabId ?? current?.activeTabId;
  const locked = activeSpaceId === 'agent' && activeSpace?.owner !== 'human';
  const canNavigate = running && (activeSpaceId === 'person' || activeSpace?.owner === 'human');
  const [addressFocusToken, setAddressFocusToken] = useState(0);

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

  const toggleInspector = useCallback(() => {
    const panel = inspectorPanelRef.current;
    if (!panel) return;
    if (inspectorOpen) panel.collapse();
    else panel.expand();
  }, [inspectorOpen, inspectorPanelRef]);

  const toggleDevTools = useCallback(() => {
    if (!current || !canNavigate) return;
    if (devToolsState.open) {
      void window.envApi.closeDevTools(current.id, activeSpaceId).then(() => void syncPagePrefs());
    } else {
      void window.envApi.openDevTools(current.id, activeSpaceId).then(() => void syncPagePrefs());
    }
  }, [current, canNavigate, activeSpaceId, devToolsState.open, syncPagePrefs]);

  const changeDevToolsDock = useCallback(
    (dock: DevToolsDockMode) => {
      void window.envApi.setDevToolsDock(dock).then(() => void syncPagePrefs());
    },
    [syncPagePrefs],
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

  const showTargetUrl = running && current?.id === hoverTarget.envId && Boolean(hoverTarget.url);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <EnvironmentAddressBar
        envId={current?.id}
        spaceId={activeSpaceId}
        url={nav?.url || current?.currentUrl || ''}
        loading={nav?.loading ?? false}
        editable={canNavigate}
        running={running}
        canGoBack={nav?.canGoBack ?? false}
        canGoForward={nav?.canGoForward ?? false}
        inspectorOpen={inspectorOpen}
        devToolsOpen={devToolsState.open}
        devToolsDock={devToolsState.dock}
        zoomFactor={zoomFactor}
        viewportPreset={viewportPreset}
        hasActiveDownload={hasActiveDownload}
        focusToken={addressFocusToken}
        onToggleInspector={toggleInspector}
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
      />

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
                    <EmptyTitle>{!current ? '未选择环境' : running ? '这个空间还没有标签' : '环境未启动'}</EmptyTitle>
                    <EmptyDescription>
                      {!current
                        ? '左侧选择一个环境，页面会显示在这里。'
                        : running
                          ? '点标签行右侧的 + 新建一个。'
                          : sidebarCollapsed
                            ? '这个环境还没有启动。点左上角 ☰ 展开侧栏，再点环境行上的 ▶。'
                            : '点击左侧「启动」拉起这个环境的浏览器。'}
                    </EmptyDescription>
                  </EmptyHeader>
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
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  );
}
