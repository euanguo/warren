import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import { PanelResizer } from '@/components/ui/panel-resizer';
import { cn } from '@/lib/utils';
import { DevToolsResizeHandle } from './devtools-resize-handle';
import { EnvironmentAddressBar } from './environment-address-bar';
import { EnvironmentInspector } from './environment-inspector';
import {
  PanelExclusivityNoticeBar,
  SimulatedViewportBackdrop,
  StageEmptyPlaceholder,
  TargetUrlPreviewPill,
} from './stage-overlays';
import type {
  PluginInspectorTab,
  PluginPopoverSurface,
  PluginRailPage,
  PluginStatusBadge,
} from '@/lib/plugin-sdk-types';
import {
  openPluginPage,
  openSettings,
  setInspectorOpen,
  setInspectorTab,
  subscribePluginSurfaceRequests,
  useNavigationState,
} from '@/state/navigation-store';
import { shouldExcludeRightPanels } from '@/state/workbench-layout';
import {
  clampDevToolsSize,
  computeDevToolsSplitBounds,
  defaultDevToolsSize,
  DEVTOOLS_RIGHT_SIZE,
  isDockedDevToolsMode,
  type DockedDevToolsMode,
} from '@shared/devtools-layout';
import { computeSimulatedPageBounds } from '@shared/viewport-presets';
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
  ViewportRect,
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
  onInspectorMaximizedChange?: (maximized: boolean) => void;
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
  pluginStatusBadges?: PluginStatusBadge[];
  pluginRailPages?: PluginRailPage[];
}

const INSPECTOR_WIDTH = { default: 360, min: 280, max: 560 };
const INSPECTOR_WIDTH_KEY = 'warren.inspector.width';
const EXCLUSIVITY_HINT_COUNT_KEY = 'warren.panelExclusivityHintCount';
const INSPECTOR_TABS = ['events', 'snapshot', 'console', 'network', 'rules', 'storage'] as const;

function nextExclusivityHintCount(): number {
  try {
    const next = (Number(localStorage.getItem(EXCLUSIVITY_HINT_COUNT_KEY)) || 0) + 1;
    localStorage.setItem(EXCLUSIVITY_HINT_COUNT_KEY, String(next));
    return next;
  } catch {
    return 1;
  }
}

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
  onInspectorMaximizedChange,
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
  pluginStatusBadges = [],
  pluginRailPages = [],
}: Props) {
  const running = current?.status === 'running';
  const activeSpaceId: SpaceId = current?.activeSpaceId ?? 'person';
  const activeSpace = (current?.spaces ?? []).find((space) => space.id === activeSpaceId);
  const tabs = activeSpace?.tabs ?? current?.tabs ?? [];
  const activeTabId = activeSpace?.activeTabId ?? current?.activeTabId;
  const locked = activeSpaceId === 'agent' && activeSpace?.owner === 'agent';
  const canNavigate = running && !locked;
  const canStartOnSubmit = Boolean(current && !running);
  const currentUrl = nav?.url || current?.currentUrl || '';
  const [addressFocusToken, setAddressFocusToken] = useState(0);
  const [activePopoverKey, setActivePopoverKey] = useState<string | null>(null);
  const [exclusivityNotice, setExclusivityNotice] = useState<{
    collapsed: 'inspector' | 'devtools';
    compact: boolean;
  } | null>(null);
  const exclusivityTimerRef = useRef<number>(0);

  const dismissExclusivityNotice = useCallback(() => {
    if (exclusivityTimerRef.current) {
      window.clearTimeout(exclusivityTimerRef.current);
      exclusivityTimerRef.current = 0;
    }
    setExclusivityNotice(null);
  }, []);

  const showExclusivityNotice = useCallback((collapsed: 'inspector' | 'devtools') => {
    const count = nextExclusivityHintCount();
    setExclusivityNotice({ collapsed, compact: count > 3 });
    if (exclusivityTimerRef.current) window.clearTimeout(exclusivityTimerRef.current);
    exclusivityTimerRef.current = window.setTimeout(() => {
      setExclusivityNotice(null);
      exclusivityTimerRef.current = 0;
    }, 7000);
  }, []);

  useEffect(() => {
    return () => {
      if (exclusivityTimerRef.current) window.clearTimeout(exclusivityTimerRef.current);
    };
  }, []);

  const pluginAnchorsRef = useRef(new Map<string, HTMLElement>());
  const registerPluginAnchor = useCallback((key: string, el: HTMLElement | null) => {
    if (el) pluginAnchorsRef.current.set(key, el);
    else pluginAnchorsRef.current.delete(key);
  }, []);

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
  const devToolsState = activePrefs?.devTools ?? {
    open: false,
    dock: 'right' as DevToolsDockMode,
    size: DEVTOOLS_RIGHT_SIZE.default,
  };
  const hasActiveDownload = activePrefs?.hasActiveDownload ?? false;

  const stageContainerRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const { inspectorOpen, inspectorTab } = useNavigationState();
  const [inspectorMaximized, setInspectorMaximized] = useState(false);
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

  const persistInspectorWidth = useCallback((nextWidth: number) => {
    try {
      localStorage.setItem(INSPECTOR_WIDTH_KEY, String(Math.round(nextWidth)));
    } catch {
      // 忽略存储写入异常
    }
  }, []);

  useEffect(() => {
    onInspectorMaximizedChange?.(inspectorOpen && inspectorMaximized);
  }, [inspectorOpen, inspectorMaximized, onInspectorMaximizedChange]);

  useEffect(() => {
    return () => onInspectorMaximizedChange?.(false);
  }, [onInspectorMaximizedChange]);

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

  const currentId = current?.id;
  useEffect(() => {
    if (!currentId || !running || stageReplaced) return;
    let cancelled = false;
    const pullAll = () => {
      void Promise.all([
        window.envApi.getZoom(currentId, activeSpaceId),
        window.envApi.getViewportPreset(currentId, activeSpaceId),
        window.envApi.getDevToolsState(),
        window.envApi.downloads(currentId),
      ]).then(([z, p, d, dl]) => {
        if (cancelled) return;
        setPagePrefs({
          envId: currentId,
          spaceId: activeSpaceId,
          zoom: z.factor,
          preset: p.preset,
          devTools: d,
          hasActiveDownload: dl.some((item) => item.state === 'progressing'),
        });
      });
    };
    const pullDownloads = () => {
      void window.envApi.downloads(currentId).then((dl) => {
        if (cancelled) return;
        setPagePrefs((prev) =>
          prev && prev.envId === currentId && prev.spaceId === activeSpaceId
            ? { ...prev, hasActiveDownload: dl.some((item) => item.state === 'progressing') }
            : prev,
        );
      });
    };
    pullAll();
    const unsub = window.envApi.onEnvDelta((payload) => {
      if (payload?.reason === 'downloads') pullDownloads();
      else pullAll();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [currentId, running, activeSpaceId, activeTabId, nav?.url, stageReplaced]);

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

  const closeInspector = useCallback(() => {
    dismissExclusivityNotice();
    setInspectorMaximized(false);
    setInspectorOpen(false);
  }, [dismissExclusivityNotice]);

  const toggleInspector = useCallback(() => {
    if (inspectorOpen) {
      closeInspector();
      return;
    }
    if (current && running && devToolsState.open && shouldExcludeRight(devToolsState.dock)) {
      void window.envApi.closeDevTools(current.id, activeSpaceId).then(() => void syncPagePrefs());
      showExclusivityNotice('devtools');
    } else {
      dismissExclusivityNotice();
    }
    setInspectorOpen(true);
  }, [
    inspectorOpen,
    closeInspector,
    current,
    running,
    devToolsState.open,
    devToolsState.dock,
    activeSpaceId,
    shouldExcludeRight,
    syncPagePrefs,
    showExclusivityNotice,
    dismissExclusivityNotice,
  ]);

  const toggleDevTools = useCallback(() => {
    if (!current || !canNavigate) return;
    if (devToolsState.open) {
      dismissExclusivityNotice();
      void window.envApi.closeDevTools(current.id, activeSpaceId).then(() => void syncPagePrefs());
    } else {
      if (inspectorOpen && shouldExcludeRight(devToolsState.dock)) {
        setInspectorMaximized(false);
        setInspectorOpen(false);
        showExclusivityNotice('inspector');
      } else {
        dismissExclusivityNotice();
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
    shouldExcludeRight,
    syncPagePrefs,
    showExclusivityNotice,
    dismissExclusivityNotice,
  ]);

  const changeDevToolsDock = useCallback(
    (dock: DevToolsDockMode) => {
      if (dock === 'right' && devToolsState.open && inspectorOpen && shouldExcludeRight('right')) {
        setInspectorMaximized(false);
        setInspectorOpen(false);
      } else {
        dismissExclusivityNotice();
      }
      void window.envApi.setDevToolsDock(dock).then(() => void syncPagePrefs());
    },
    [devToolsState.open, inspectorOpen, shouldExcludeRight, syncPagePrefs, dismissExclusivityNotice],
  );

  const resizeDevTools = useCallback(
    (dock: DockedDevToolsMode, nextSize: number) => {
      if (!current || !running) return;
      setPagePrefs((prev) =>
        prev && prev.envId === current.id && prev.spaceId === activeSpaceId
          ? { ...prev, devTools: { ...prev.devTools, dock, size: nextSize } }
          : prev,
      );
      void window.envApi.setDevToolsDock(dock, nextSize).then(() => void syncPagePrefs());
    },
    [current, running, activeSpaceId, syncPagePrefs],
  );

  const resetDevToolsSize = useCallback(
    (dock: DockedDevToolsMode) => {
      const viewport = { x: 0, y: 0, width: stageSize.width, height: stageSize.height };
      resizeDevTools(dock, clampDevToolsSize(dock, defaultDevToolsSize(dock), viewport));
    },
    [resizeDevTools, stageSize.width, stageSize.height],
  );

  const resetViewportPreset = useCallback(() => {
    if (!current || !running) return;
    setPagePrefs((prev) =>
      prev && prev.envId === current.id && prev.spaceId === activeSpaceId ? { ...prev, preset: 'auto' } : prev,
    );
    void window.envApi.setViewportPreset(current.id, activeSpaceId, 'auto').then(() => void syncPagePrefs());
  }, [current, running, activeSpaceId, syncPagePrefs]);

  const switchToBottomCoexist = useCallback(() => {
    if (!current || !running) return;
    dismissExclusivityNotice();
    void window.envApi
      .setDevToolsDock('bottom')
      .then(() => window.envApi.openDevTools(current.id, activeSpaceId))
      .then(() => void syncPagePrefs());
    setInspectorMaximized(false);
    setInspectorOpen(true);
  }, [current, running, activeSpaceId, dismissExclusivityNotice, syncPagePrefs]);

  const openPluginPopover = useCallback(
    (
      pluginId: string,
      surfaceId: string,
      anchorRect?: ViewportRect,
      options?: { toggle?: boolean; width?: number; height?: number },
    ) => {
      const key = `${pluginId}:${surfaceId}`;
      if (options?.toggle && activePopoverKey === key) {
        setActivePopoverKey(null);
        void window.envApi.closePopover('plugin-popover');
        return;
      }
      const surface = pluginPopovers.find((pop) => pop.pluginId === pluginId && pop.id === surfaceId);
      const anchorEl = pluginAnchorsRef.current.get(key);
      let resolvedAnchor = anchorRect;
      if (!resolvedAnchor && anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        resolvedAnchor = {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }
      if (!resolvedAnchor) {
        const stageRect = stageRef.current?.getBoundingClientRect();
        resolvedAnchor = stageRect
          ? { x: Math.max(16, Math.round(stageRect.right - 24)), y: Math.round(stageRect.top), width: 1, height: 1 }
          : { x: 400, y: 76, width: 1, height: 1 };
      }
      const width = options?.width ?? surface?.width ?? 360;
      const height = options?.height ?? surface?.height ?? 420;
      setActivePopoverKey(key);
      void window.envApi.openPopover({
        id: 'plugin-popover',
        anchorRect: resolvedAnchor,
        size: { width, height },
        placement: 'bottom-end',
        focusable: true,
        beyondWindow: true,
        props: {
          pluginId,
          surfaceId,
          environmentId: current?.id,
          space: activeSpaceId,
          url: currentUrl,
        },
      });
    },
    [activePopoverKey, pluginPopovers, stageRef, current?.id, activeSpaceId, currentUrl],
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
      if (shortcut === 'quickAutofill') {
        const target =
          pluginPopovers.find((pop) => pop.shortcut && /shift\+l|⇧⌘l/i.test(pop.shortcut)) ??
          pluginPopovers.find((pop) => pop.pluginId === 'com.warren.accounts') ??
          pluginPopovers[0];
        if (target) openPluginPopover(target.pluginId, target.id, undefined, { toggle: true });
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
      if (shortcut === 'find' || shortcut === 'findNext' || shortcut === 'findPrev') {
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
    pluginPopovers,
    openPluginPopover,
    openFindPopover,
    onTabCreate,
    onTabClose,
    onNavigate,
    onTabSelect,
    onTabReopen,
  ]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const sync = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setStageSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    const frame = window.requestAnimationFrame(sync);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [stageRef]);

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

  const openInspectorPluginTab = useCallback(
    (pluginId: string, surfaceId: string) => {
      setInspectorTab(`plugin:${pluginId}:${surfaceId}`);
      if (!inspectorOpen && current && running && devToolsState.open && shouldExcludeRight(devToolsState.dock)) {
        void window.envApi.closeDevTools(current.id, activeSpaceId).then(() => void syncPagePrefs());
      }
      setInspectorOpen(true);
    },
    [
      inspectorOpen,
      current,
      running,
      devToolsState.open,
      devToolsState.dock,
      activeSpaceId,
      shouldExcludeRight,
      syncPagePrefs,
    ],
  );

  const openPluginSurface = useCallback(
    (kind: 'popover' | 'inspectorTab', pluginId: string, surfaceId: string, anchorRect?: ViewportRect) => {
      if (kind === 'popover') {
        openPluginPopover(pluginId, surfaceId, anchorRect, { toggle: true });
        return;
      }
      openInspectorPluginTab(pluginId, surfaceId);
    },
    [openPluginPopover, openInspectorPluginTab],
  );

  useEffect(() => {
    const unsubDismissed = window.envApi.onPopoverDismissed((payload) => {
      if (payload.id === 'plugin-popover') setActivePopoverKey(null);
    });
    const unsubAction = window.envApi.onPopoverAction((event) => {
      if (event.id !== 'plugin-popover') return;
      if (event.action === 'toast') {
        const { kind, title, description } = event.payload;
        if (kind === 'error') toast.error(title, description ? { description } : undefined);
        else if (kind === 'info') toast.info(title, description ? { description } : undefined);
        else toast.success(title, description ? { description } : undefined);
      } else if (event.action === 'openPluginPage') {
        openPluginPage(event.payload.pluginId, event.payload.surfaceId);
      } else if (event.action === 'openInspectorTab') {
        openInspectorPluginTab(event.payload.pluginId, event.payload.surfaceId);
      } else if (event.action === 'openSettings') {
        openSettings(event.payload.section);
      }
    });
    return () => {
      unsubDismissed();
      unsubAction();
    };
  }, [openInspectorPluginTab]);

  useEffect(() => {
    return subscribePluginSurfaceRequests({
      onPopover: (req) =>
        openPluginPopover(req.pluginId, req.surfaceId, undefined, {
          width: req.width,
          height: req.height,
        }),
      onInspector: (req) => openInspectorPluginTab(req.pluginId, req.surfaceId),
    });
  }, [openPluginPopover, openInspectorPluginTab]);

  // 切入全屏设置页/插件页时自动收起悬空浮窗；环境/空间/URL 变化时同步更新已打开的浮窗上下文
  useEffect(() => {
    if (stageReplaced) {
      void window.envApi.closePopover('plugin-popover');
      return;
    }
    if (!activePopoverKey) return;
    void window.envApi.updatePopover('plugin-popover', {
      props: {
        environmentId: current?.id,
        space: activeSpaceId,
        url: currentUrl,
      },
    });
  }, [stageReplaced, activePopoverKey, current?.id, activeSpaceId, currentUrl]);

  const showTargetUrl = running && current?.id === hoverTarget.envId && Boolean(hoverTarget.url);
  const devToolsDocked =
    Boolean(running) && tabs.length > 0 && devToolsState.open && isDockedDevToolsMode(devToolsState.dock);
  const stageViewport = { x: 0, y: 0, width: stageSize.width, height: stageSize.height };
  const devToolsSplit =
    devToolsDocked && stageSize.width > 0 && stageSize.height > 0
      ? computeDevToolsSplitBounds({
          viewport: stageViewport,
          mode: devToolsState.dock,
          size: devToolsState.size,
          docked: true,
        })
      : undefined;
  const splitPageRect = devToolsSplit?.page ?? stageViewport;
  const simLayout =
    running && tabs.length > 0 && stageSize.width > 0 && stageSize.height > 0 && viewportPreset !== 'auto'
      ? computeSimulatedPageBounds(splitPageRect, viewportPreset)
      : undefined;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
      <EnvironmentAddressBar
        envId={current?.id}
        spaceId={activeSpaceId}
        url={currentUrl}
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
        pluginStatusBadges={pluginStatusBadges}
        pluginInspectorTabs={pluginTabs}
        pluginRailPages={pluginRailPages}
        activePluginPopoverKey={activePopoverKey}
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
        onStartAndNavigate={(targetUrl) => {
          if (current) onStartAndNavigate(current.id, activeSpaceId, targetUrl);
        }}
        onOpenPluginPopover={(pluginId, surfaceId, anchorRect) =>
          openPluginPopover(pluginId, surfaceId, anchorRect, { toggle: true })
        }
        onOpenPluginPage={(pluginId, surfaceId) => openPluginPage(pluginId, surfaceId)}
        onOpenPluginSurface={openPluginSurface}
        registerPluginAnchor={registerPluginAnchor}
      />

      {exclusivityNotice && running && (
        <PanelExclusivityNoticeBar
          collapsed={exclusivityNotice.collapsed}
          compact={exclusivityNotice.compact}
          onSwitchToBottomCoexist={switchToBottomCoexist}
          onDismiss={dismissExclusivityNotice}
        />
      )}

      <div ref={stageContainerRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas">
        <div
          className={cn(
            'h-full min-h-0 min-w-0 flex-1 px-1.5 pt-0 pb-1.5',
            inspectorOpen && inspectorMaximized && 'hidden',
          )}
        >
          <div
            ref={stageRef}
            data-slot="stage-placeholder"
            className={cn(
              'relative h-full overflow-hidden rounded-[var(--shell-stage-radius)] border border-border-strong',
              devToolsDocked ? 'bg-sheet-inset' : 'bg-canvas',
            )}
          >
            {(!running || tabs.length === 0) && (
              <StageEmptyPlaceholder
                current={current}
                running={Boolean(running)}
                locked={locked}
                activeSpaceId={activeSpaceId}
                onStart={onStart}
                onTabCreate={onTabCreate}
              />
            )}
            {simLayout?.emulated && (
              <SimulatedViewportBackdrop
                container={splitPageRect}
                layout={simLayout}
                roundedOuter={!devToolsDocked}
                onReset={resetViewportPreset}
              />
            )}
            {devToolsDocked && devToolsSplit?.gap && isDockedDevToolsMode(devToolsState.dock) && (
              <DevToolsResizeHandle
                dock={devToolsState.dock}
                size={devToolsState.size}
                viewport={stageViewport}
                gap={devToolsSplit.gap}
                onResize={resizeDevTools}
                onReset={resetDevToolsSize}
              />
            )}
            {showTargetUrl && <TargetUrlPreviewPill url={hoverTarget.url} />}
          </div>
        </div>

        {inspectorOpen && !inspectorMaximized && (
          <PanelResizer
            label="调整右侧工作台宽度"
            controls="warren-inspector-pane"
            direction="right"
            value={inspectorWidth}
            defaultValue={INSPECTOR_WIDTH.default}
            min={INSPECTOR_WIDTH.min}
            max={INSPECTOR_WIDTH.max}
            onResize={setInspectorWidth}
            onResizeEnd={persistInspectorWidth}
            onReset={() => {
              setInspectorWidth(INSPECTOR_WIDTH.default);
              persistInspectorWidth(INSPECTOR_WIDTH.default);
            }}
          />
        )}

        {inspectorOpen && (
          <div
            id="warren-inspector-pane"
            data-slot="inspector-pane"
            style={inspectorMaximized ? undefined : { width: `${inspectorWidth}px` }}
            className={cn(
              'warren-side-panel-enter h-full min-h-0 min-w-0 shrink-0 overflow-hidden bg-canvas',
              inspectorMaximized ? 'flex-1' : 'border-l border-border',
            )}
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
              onRefreshCookies={() => current && onReadCookies(current.id)}
              cookies={cookies}
              pluginTabs={pluginTabs}
              environmentId={current?.id}
              space={activeSpaceId}
              url={currentUrl}
              onOpenPluginPage={(pluginId, surfaceId) => openPluginPage(pluginId, surfaceId)}
              maximized={inspectorMaximized}
              onToggleMaximize={() => setInspectorMaximized((prev) => !prev)}
              onClose={closeInspector}
            />
          </div>
        )}
      </div>
    </main>
  );
}
