import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { EnvironmentTabstrip } from './environment-tabstrip';
import { EnvironmentSpaceSwitcher } from './environment-space-switcher';
import { EnvironmentAddressBar } from './environment-address-bar';
import { EnvironmentInspector } from './environment-inspector';
import type { PluginInspectorTab } from '@/lib/plugin-runtime';
import { WarrenMark } from '@/components/warren-mark';
import type {
  ConsoleEntry,
  CookieSummary,
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
} from '@shared/types';

interface Props {
  current?: Environment;
  events: EventRecord[];
  snapshot?: SnapshotResult;
  snapshotLoading: boolean;
  onRefreshSnapshot: (id: string) => void;
  /** 存储页的数据（cookie 元数据，**没有值**）；undefined = 还没读过 */
  cookies?: CookieSummary[];
  onReadCookies: (id: string) => void;
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  netRules: NetRule[];
  netHits: NetHit[];
  onNetRuleToggle: (id: string, ruleId: string, enabled: boolean) => void;
  stageRef: RefObject<HTMLDivElement | null>;
  /** 侧栏收起时环境行不可见，空态就不能再说「点左侧的启动」 */
  sidebarCollapsed: boolean;
  onSpaceSelect: (id: string, space: SpaceId) => void;
  /** 标签操作。标签活在 Environment 里面，所以都要带环境 id。 */
  onTabSelect: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabClose: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabCreate: (id: string, space: SpaceId) => void;
  onTabCloseOthers: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabCloseRight: (id: string, space: SpaceId, ref: TabRef) => void;
  onTabReorder: (id: string, space: SpaceId, from: number, to: number) => void;
  onTabReopen: (id: string, space: SpaceId) => void;
  onTabToggleMute: (id: string, space: SpaceId, ref: TabRef, muted: boolean) => void;
  /** 页面导航状态。读取不需要控制权。 */
  nav?: NavigationState | null;
  onNavigate: (action: NavigationAction) => void;
  /** 插件往检查器里加的页（每个插件自己的面） */
  pluginTabs?: PluginInspectorTab[];
}

/** 检查器宽度阶梯。react-resizable-panels v4 里数字即像素。 */
const INSPECTOR_WIDTH = { default: 360, min: 260, max: 720 };
const INSPECTOR_WIDTH_KEY = 'warren.inspector.width';
const INSPECTOR_TAB_KEY = 'warren.inspector.tab';
const INSPECTOR_TABS = ['events', 'snapshot', 'console', 'network', 'rules', 'storage'] as const;

/**
 * 内容卡片：标签行 + 地址行 + 页面 / 检查器。
 *
 * 检查器（事件 / 快照 / 控制台 / 网络）**默认收起**：它是旁路调试信息，
 * 常驻在底部会一直吃掉页面高度（实测 208px，占页面区三分之一）。
 * 现在是右侧可拖拽面板，由地址行右端的面板按钮唤起。
 */
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
  onSpaceSelect,
  onTabSelect,
  onTabClose,
  onTabCreate,
  onTabCloseOthers,
  onTabCloseRight,
  onTabReorder,
  onTabReopen,
  onTabToggleMute,
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
  // Person Space 永远由人控制；Agent Space 只有接管后才能导航。
  const canNavigate = running && (activeSpaceId === 'person' || activeSpace?.owner === 'human');
  /** ⌘L：地址栏要自己抢焦点，用一个自增令牌通知它（组件在检查器那层，够不着 ref）。 */
  const [addressFocusToken, setAddressFocusToken] = useState(0);

  const inspectorPanelRef = usePanelRef();
  const inspectorElementRef = useRef<HTMLDivElement>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorTabIds = [...INSPECTOR_TABS, ...pluginTabs.map((tab) => `plugin:${tab.pluginId}:${tab.id}`)];
  const [inspectorTab, setInspectorTab] = useState(() => {
    const saved = localStorage.getItem(INSPECTOR_TAB_KEY);
    return saved && inspectorTabIds.includes(saved) ? saved : 'events';
  });
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0
      ? Math.min(INSPECTOR_WIDTH.max, Math.max(INSPECTOR_WIDTH.min, saved))
      : INSPECTOR_WIDTH.default;
  });
  // 收起/展开的初始化 effect 只跑一次，用 ref 读「当前」宽度而不把它列进依赖——
  // 否则拖拽改宽度会反过来触发一次收起。
  const inspectorWidthRef = useRef(inspectorWidth);
  useEffect(() => {
    inspectorWidthRef.current = inspectorWidth;
  }, [inspectorWidth]);

  // 拖拽时每帧都 onResize；写盘等停下来再做，别在拖动过程中狂写 localStorage。
  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth)), 250);
    return () => window.clearTimeout(timer);
  }, [inspectorWidth]);

  const toggleInspector = useCallback(() => {
    const panel = inspectorPanelRef.current;
    if (!panel) return;
    if (inspectorOpen) panel.collapse();
    else panel.expand();
  }, [inspectorOpen, inspectorPanelRef]);
  const openDevTools = useCallback(() => {
    if (current) void window.envApi.openDevTools(current.id, activeSpaceId);
  }, [current, activeSpaceId]);
  useEffect(() => {
    localStorage.setItem(INSPECTOR_TAB_KEY, inspectorTab);
  }, [inspectorTab]);
  /**
   * 浏览器快捷键的唯一落点。
   *
   * 两条来路：页面里的 `before-input-event`（⌥⌘I / ⌥⌘J / ⌘1..9，键事件只到页面的
   * webContents）和应用菜单的加速键（⌘T / ⌘W / ⌘R / ⌘L，macOS 上菜单先拿到按键）。
   * 主进程两边都转成同一条 IPC，所以这里只认 shortcut 本身。
   */
  useEffect(() => {
    return window.envApi.onBrowserShortcut((shortcut) => {
      if (shortcut === 'devtools') {
        if (canNavigate && current) openDevTools();
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
      if (shortcut === 'focusAddress') {
        setAddressFocusToken((token) => token + 1);
        return;
      }
      if (typeof shortcut === 'object' && 'selectTab' in shortcut) {
        // 序号越界就什么都不做：标签不够多时按 ⌘7 不该报错
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
    openDevTools,
    toggleInspector,
    onTabCreate,
    onTabClose,
    onNavigate,
    onTabSelect,
    onTabReopen,
  ]);

  /**
   * 检查器默认收起。
   *
   * 首帧先 `resize(当前宽度)` 再 `collapse()`：`resize` 是按**当时的真实宽度**换算
   * px→% 的，而 `defaultSize` 走的是首次布局那一刻的测量（冷启动会算歪，
   * 实测 360 被算成 260）。校准完再塌下去，之后 `expand()` 才会回到这个宽度。
   * 见 HANDOFF「踩过的坑」里 v4 的那条。
   */
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const panel = inspectorPanelRef.current;
      if (!panel) return;
      panel.resize(inspectorWidthRef.current);
      panel.collapse();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inspectorPanelRef]);

  // 收起态以**实际渲染宽度**为准：拖拽也能把它拖到 0，状态不能只靠按钮记
  useEffect(() => {
    const node = inspectorElementRef.current;
    if (!node) return;
    const sync = () => setInspectorOpen(node.getBoundingClientRect().width > 1);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      {/*
        标签行。高度和 rail 顶格、侧栏 chrome 行一致——三列横向才是一条线。
        标签是渲染层的 DOM，不是原生视图；占位区的矩形由 ResizeObserver 实测，
        所以这一行压矮页面多少，主进程会自动跟上。
      */}
      <div className="flex h-[var(--shell-chrome-row-height)] shrink-0 items-center gap-1 px-2">
        {current ? (
          <>
            <EnvironmentSpaceSwitcher
              spaces={current.spaces ?? []}
              activeSpaceId={activeSpaceId}
              onSelect={(space) => onSpaceSelect(current.id, space)}
            />
            <EnvironmentTabstrip
              tabs={tabs}
              activeTabId={activeTabId}
              disabled={!running}
              locked={locked}
              canReload={canNavigate}
              onSelect={(ref) => onTabSelect(current.id, activeSpaceId, ref)}
              onClose={(ref) => onTabClose(current.id, activeSpaceId, ref)}
              onCreate={() => onTabCreate(current.id, activeSpaceId)}
              onReload={() => onNavigate({ kind: 'reload' })}
              onCloseOthers={(ref) => onTabCloseOthers(current.id, activeSpaceId, ref)}
              onCloseRight={(ref) => onTabCloseRight(current.id, activeSpaceId, ref)}
              onReorder={(from, to) => onTabReorder(current.id, activeSpaceId, from, to)}
              onToggleMute={(ref, muted) => onTabToggleMute(current.id, activeSpaceId, ref, muted)}
            />
          </>
        ) : null}
      </div>

      {/*
        地址行。导航是写操作（见 PRD 5.3），所以前进/后退/刷新只在人持控制权时可用——
        agent 正在操作时人不能抢页面，否则 lease 没有意义。
      */}
      <EnvironmentAddressBar
        url={nav?.url || current?.currentUrl || ''}
        loading={nav?.loading ?? false}
        editable={canNavigate}
        running={running}
        canGoBack={nav?.canGoBack ?? false}
        canGoForward={nav?.canGoForward ?? false}
        inspectorOpen={inspectorOpen}
        focusToken={addressFocusToken}
        onToggleInspector={toggleInspector}
        onOpenDevTools={openDevTools}
        onNavigate={onNavigate}
      />

      {/*
        页面和检查器同属一张卡片的横向分栏。检查器面板**始终挂在树上**、只靠
        collapse/expand 收放——换成条件渲染会让 stageRef 那个 div 重新挂载，
        原来的 ResizeObserver 会盯着一个已经脱离文档的节点，原生视图就不跟了。
      */}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="page" className="min-w-0">
          {/* WebContentsView 是原生视图，这里只留占位并把矩形报给主进程 */}
          <div ref={stageRef} data-slot="stage-placeholder" className="relative h-full bg-muted/20">
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
            activeTab={inspectorTab}
            onTabChange={(tab) => {
              setInspectorTab(tab);
              // 存储页按需读：切过去时才查一次 cookie（不跟着遥测轮询）
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
