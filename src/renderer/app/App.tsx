import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { usePanelRef } from 'react-resizable-panels';
import { EnvironmentSidebar } from '@/features/environments/environment-sidebar';
import type { NewEnvironment } from '@/features/environments/create-environment-dialog';
import { EnvironmentStage } from '@/features/environments/environment-stage';
import { SettingsPage, type SettingsSection } from '@/features/settings/settings-page';
import type { EnvironmentEdit } from '@/features/environments/edit-environment-dialog';
import { AppRail, type RailDestination } from '@/app/app-rail';
import { AppTitlebar } from '@/app/app-titlebar';
import { SidebarProvider } from '@/components/ui/sidebar';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createNativeViewOverlayGuard } from '@/lib/native-view-overlay-guard';
import { loadPluginApps, emptyRegistry, type PluginRegistry } from '@/lib/plugin-runtime';
import { usePluginBadges } from '@/lib/plugin-badges';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
import type {
  ConsoleEntry,
  CookieSummary,
  Environment,
  EventRecord,
  Group,
  NavigationAction,
  NavigationState,
  NetworkEntry,
  NetHit,
  NetRule,
  SnapshotResult,
  InstalledPlugin,
  SpaceId,
} from '@shared/types';

const TELEMETRY_INTERVAL_MS = 1500;

/** 侧栏宽度阶梯。react-resizable-panels v4 里数字即像素。 */
const SIDEBAR_WIDTH = { default: 260, min: 200, max: 420, collapsed: 0 };

export function App() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('plugins');
  /** 快照带着它属于哪个环境：切环境时旧的自动失效，不需要 effect 去清（见下面 `snapshot`） */
  const [snapshotOf, setSnapshotOf] = useState<{ envId: string; data: SnapshotResult } | undefined>();
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  /**
   * 遥测（console / network / 规则 / 命中 / 导航态）都是主进程侧的状态，打包成一个带环境 id 的值：
   * 切环境、或环境停了，旧的整份失效——不用 effect 去逐个清空（那正是「级联渲染」的来源）。
   */
  const [telemetry, setTelemetry] = useState<
    | {
        envId: string;
        logs: ConsoleEntry[];
        requests: NetworkEntry[];
        rules: NetRule[];
        hits: NetHit[];
        nav: NavigationState | null;
      }
    | undefined
  >();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [registry, setRegistry] = useState<PluginRegistry>(emptyRegistry);
  const pluginBadges = usePluginBadges();
  /** 每次主进程报「状态变了」就 +1：插件清单与界面跟着重取 */
  const [stateTick, setStateTick] = useState(0);
  /** 人点过哪个插件面。插件可能随后被停用 / 卸载，所以真正生效的是派生的 `activePluginPage` */
  const [requestedPage, setRequestedPage] = useState<{ pluginId: string; surfaceId: string } | undefined>();
  const stageRef = useRef<HTMLDivElement>(null);
  const sidebarPanelRef = usePanelRef();
  const sidebarElementRef = useRef<HTMLDivElement>(null);

  // 插件面被停用 / 卸载后就不该再算「当前视图」——派生出来，不用 effect 去清 state
  const activePluginPage = requestedPage
    ? registry.railPages.find((page) => page.pluginId === requestedPage.pluginId && page.id === requestedPage.surfaceId)
    : undefined;

  const pluginPageOpen = Boolean(activePluginPage);

  /*
   * 设置页和插件页都会**把整个 stage 换掉**。两者都是 DOM，而原生页面视图永远画在 DOM 之上，
   * 所以只要有任何一个在，就让页面视图让开。
   */
  const stageReplaced = pluginPageOpen || settingsOpen;

  /**
   * 环境列表只属于「环境」这一个路由 —— 插件页和设置页占满整张卡。
   *
   * 所以它不是常驻的：切走就卸载，切回来重挂（宽度和收起态都跟着重算，
   * 见下面两个 effect 的依赖）。
   */
  const sidebarVisible = !stageReplaced;

  /**
   * 侧栏是否收起。
   *
   * 不用 Panel 的 onResize：实测它对命令式的 collapse() 不触发（宽度确实变了，
   * 回调没来）。直接观察实际渲染宽度——它才是唯一真相，也不依赖库的回调语义。
   */
  useEffect(() => {
    const node = sidebarElementRef.current;
    if (!node) return;
    const sync = () => setSidebarCollapsed(node.getBoundingClientRect().width <= SIDEBAR_WIDTH.collapsed + 1);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
    // 侧栏会被卸载 / 重挂（切到插件页或设置页），依赖它才能重新观察新节点
  }, [sidebarVisible]);

  /**
   * 冷启动时把侧栏宽度按像素重设一次。
   *
   * react-resizable-panels v4 把 `defaultSize` 的像素值换算成百分比时，用的是
   * **首次布局那一刻**的面板组宽度。应用冷启动那次测量会偏：实测 `defaultSize={260}`
   * 被算成 15.399%，渲染出来只有 214px（热重载后重新挂载就是对的 260px）。
   * 首帧之后再按像素设一次，和测量时机无关。宽度没有持久化，所以这里不会覆盖用户的选择。
   */
  useEffect(() => {
    const panel = sidebarPanelRef.current;
    const frame = window.requestAnimationFrame(() => {
      panel?.resize(SIDEBAR_WIDTH.default);
    });
    return () => window.cancelAnimationFrame(frame);
    // ref 对象是稳定的，列进来只是为了让 exhaustive-deps 满意
  }, [sidebarPanelRef, sidebarVisible]);

  // 页面是原生视图，永远在 DOM 之上；浮层压到它就把它让开（见 lib/native-view-overlay-guard.ts）
  useEffect(() => createNativeViewOverlayGuard(), []);

  /** 主进程报「状态变了」。环境列表、插件清单都挂在这个计数上重取。 */
  useEffect(() => window.envApi.onStateChanged(() => setStateTick((tick) => tick + 1)), []);

  /*
   * 主进程是唯一数据源：这里只负责「拉一次」。**改状态的命令不用自己刷新**——
   * EnvironmentManager 的每个变更方法都会 `#onChange()` → `state:changed` → 这个 effect 重跑。
   */
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      const [list, groupList, log, selectedId] = await Promise.all([
        window.envApi.list(),
        window.envApi.groups(),
        window.envApi.events(),
        window.envApi.selected(),
      ]);
      if (cancelled) return;
      setEnvironments(list);
      setGroups(groupList);
      setEvents(log);
      // 选中态以主进程为准——CLI 的 env select 也要能反映到界面上
      setSelected(selectedId ?? undefined);
    };
    void pull();
    return () => {
      cancelled = true;
    };
  }, [stateTick]);

  /**
   * 插件：拉清单 → 载入前端 bundle → 得到可渲染的面。
   *
   * 每次 state 变化都重来一遍（安装 / 启停 / 重载 / 改设置都会触发），
   * bundle 按 (id, version) 缓存，没变不会重复 import。
   */
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      const list = await window.envApi.plugins();
      const loaded = await loadPluginApps(list);
      if (cancelled) return;
      setPlugins(list);
      setRegistry(loaded);
    };
    void pull();
    return () => {
      cancelled = true;
    };
  }, [stateTick]);

  useEffect(() => {
    void window.envApi.setViewVisible(!stageReplaced);
  }, [stageReplaced]);

  /*
   * WebContentsView 是原生视图，不遵守 DOM 布局；把占位区的实际矩形报给主进程。
   *
   * **必须依赖 stageReplaced**：设置页 / 插件页会把整个 stage 换掉（`stage-placeholder` 卸载再重挂），
   * 不重跑这个 effect 的话 ResizeObserver 会盯着**已经脱离文档的旧节点**——之后尺寸怎么变都不再上报。
   * 实测（切一次插件页再切回来，收起侧栏）：DOM 占位区 1384px，主进程 viewport 还停在 1124px，
   * 页面左边露出一条 260px 空白；展开检查器时原生视图直接把那 360px 盖住，检查器看不见。
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

  const current = useMemo(() => environments.find((env) => env.id === selected), [environments, selected]);
  const activeSpaceId = current?.activeSpaceId ?? 'person';

  // 快照属于某个环境：切环境就等于没有快照（派生，不用 effect 去清）
  const snapshot = snapshotOf && snapshotOf.envId === selected ? snapshotOf.data : undefined;

  /**
   * 存储页的 cookie 元数据（**没有值**，见 shared/types 的 CookieSummary）。
   * 和快照一样按需读，不跟着遥测轮询——cookie 不会每秒变。
   */
  const [cookiesOf, setCookiesOf] = useState<{ envId: string; list: CookieSummary[] } | undefined>();
  const cookies = cookiesOf && cookiesOf.envId === selected ? cookiesOf.list : undefined;

  // 遥测同理：不属于「当前这个正在运行的环境」就当作没有
  const live = telemetry && telemetry.envId === selected && current?.status === 'running' ? telemetry : undefined;
  const consoleEntries = live?.logs ?? [];
  const networkEntries = live?.requests ?? [];
  const netRules = live?.rules ?? [];
  const netHits = live?.hits ?? [];
  const nav = live?.nav ?? null;

  // console / network / nav 都是主进程侧的状态，轮询拉取即可
  useEffect(() => {
    if (!selected || current?.status !== 'running') {
      return;
    }
    let cancelled = false;
    const pull = async () => {
      const [logs, requests, navigation, net] = await Promise.all([
        window.envApi.console(selected),
        window.envApi.network(selected),
        window.envApi.navState(selected, activeSpaceId),
        window.envApi.netRules(selected),
      ]);
      const hits = await window.envApi.netHits(selected, 50);
      if (cancelled) return;
      setTelemetry({
        envId: selected,
        logs,
        requests,
        rules: net.rules,
        hits,
        nav: navigation,
      });
    };
    void pull();
    const timer = setInterval(() => void pull(), TELEMETRY_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected, current?.status, activeSpaceId]);

  /** 所有环境操作的统一出口：失败弹提示。**成功不用手动刷新**——主进程会发 `state:changed`。 */
  const run = async (action: () => Promise<unknown>, failureMessage: string) => {
    try {
      await action();
    } catch (error) {
      toast.error(failureMessage, {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const select = (id: string) => void run(() => window.envApi.select(id), '切换环境失败');

  // 表单在弹窗里，这里只收已经填好的值
  const create = (input: NewEnvironment) => void run(() => window.envApi.create(input), '创建环境失败');

  const start = (id: string) => void run(() => window.envApi.start(id), '启动环境失败');

  const stop = (id: string) => void run(() => window.envApi.stop(id), '停止环境失败');
  const remove = (id: string) => void run(() => window.envApi.remove(id), '删除环境失败');
  const takeover = (id: string) => void run(() => window.envApi.takeover(id, 'agent'), '接管失败');
  const release = (id: string) => void run(() => window.envApi.release(id, 'agent'), '交还失败');
  const selectSpace = (id: string, space: SpaceId) =>
    void run(() => window.envApi.spaceSelect(id, space), '切换空间失败');

  /** 插件往环境菜单里加的动作：插件只声明「动作 → 命令」，跑的是它自己的命令。 */
  const runPluginAction = (pluginId: string, command: string, environmentId: string) =>
    void run(async () => {
      return window.envApi.pluginRun(pluginId, command, environmentId);
    }, '插件动作失败');
  /** 编辑环境：显示名 / 代理 / 启动 URL / 自动切换。空串 = 清掉那个字段（代理留空就是直连）。 */
  const editEnvironment = (id: string, patch: EnvironmentEdit) =>
    void run(() => window.envApi.update(id, patch), '保存环境失败');

  const createGroup = (name: string) => void run(() => window.envApi.groupCreate(name), '新建分组失败');
  const renameGroup = (id: string, name: string) =>
    void run(() => window.envApi.groupRename(id, name), '重命名分组失败');
  const removeGroup = (id: string) => void run(() => window.envApi.groupRemove(id), '删除分组失败');
  const toggleGroup = (id: string, collapsed: boolean) =>
    void run(() => window.envApi.groupCollapse(id, collapsed), '折叠分组失败');
  const moveToGroup = (environmentId: string, groupId: string | undefined) =>
    void run(() => window.envApi.moveToGroup(environmentId, groupId), '移动分组失败');

  // 导航是写操作：主进程会校验人是否持控制权，这里只负责发起
  const navigate = (action: NavigationAction) =>
    void run(async () => {
      if (!selected) return;
      const next = await window.envApi.humanNavigate(selected, current?.activeSpaceId ?? 'person', action);
      setTelemetry((prev) => (prev ? { ...prev, nav: next } : prev));
    }, '导航失败');

  // 标签操作。人在界面上点，和 agent 走 CLI 是两条路：这里不受 lease 限制。
  const tabSelect = (id: string, space: SpaceId, ref: number | string) =>
    void run(() => window.envApi.tabSelect(id, space, ref), '切换标签失败');
  const tabClose = (id: string, space: SpaceId, ref: number | string) =>
    void run(() => window.envApi.tabClose(id, space, ref), '关闭标签失败');
  const tabCreate = (id: string, space: SpaceId) => void run(() => window.envApi.tabCreate(id, space), '新建标签失败');
  const tabCloseOthers = (id: string, space: SpaceId, ref: number | string) =>
    void run(() => window.envApi.tabCloseOthers(id, space, ref), '关闭标签失败');
  const tabCloseRight = (id: string, space: SpaceId, ref: number | string) =>
    void run(() => window.envApi.tabCloseRight(id, space, ref), '关闭标签失败');
  const tabReopen = (id: string, space: SpaceId) =>
    void run(() => window.envApi.tabReopen(id, space), '重新打开标签失败');
  const tabReorder = (id: string, space: SpaceId, from: number, to: number) =>
    void run(() => window.envApi.tabReorder(id, space, from, to), '调整标签顺序失败');
  const tabToggleMute = (id: string, space: SpaceId, ref: number | string, muted: boolean) =>
    void run(() => window.envApi.tabMute(id, space, ref, muted), muted ? '静音失败' : '取消静音失败');

  /** 网络规则开关：人关掉一条规则，agent 下一次请求立刻就不生效（规则表在主进程里是唯一真相）。 */
  const setNetRuleEnabled = (id: string, ruleId: string, enabled: boolean) =>
    void run(async () => {
      await window.envApi.netRuleSet(id, ruleId, enabled);
      const rules = (await window.envApi.netRules(id)).rules;
      setTelemetry((prev) => (prev ? { ...prev, rules } : prev));
    }, '改网络规则失败');

  const toggleSidebar = () => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (sidebarCollapsed) panel.expand();
    else panel.collapse();
  };

  const readSnapshot = (id: string) => {
    setSnapshotLoading(true);
    void window.envApi
      .snapshot(id, current?.activeSpaceId ?? 'person')
      .then((data) => setSnapshotOf({ envId: id, data }))
      .catch((error: unknown) => {
        toast.error('读取快照失败', {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setSnapshotLoading(false));
  };

  const readCookies = async (id: string) => {
    try {
      setCookiesOf({ envId: id, list: await window.envApi.cookies(id) });
    } catch (error) {
      toast.error('读取存储失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * rail 的目的地。「环境」和插件页抢 stage，设置也抢（它不再是弹窗）——
   * 三者互斥，所以各自 onSelect 都要把另外两个清掉。
   */
  const railDestinations: RailDestination[] = [
    {
      id: 'environments',
      label: '环境',
      icon: 'Folder',
      active: !activePluginPage && !settingsOpen,
      onSelect: () => {
        setRequestedPage(undefined);
        setSettingsOpen(false);
        if (sidebarCollapsed) sidebarPanelRef.current?.expand();
      },
    },
    ...registry.railPages.map((page) => ({
      id: `${page.pluginId}:${page.id}`,
      label: page.title,
      icon: page.icon ?? 'Puzzle',
      active: activePluginPage?.id === page.id && activePluginPage.pluginId === page.pluginId,
      onSelect: () => {
        setRequestedPage({ pluginId: page.pluginId, surfaceId: page.id });
        setSettingsOpen(false);
      },
    })),
  ];

  return (
    <TooltipProvider>
      {/* Sidebar 用 --sidebar-width 决定自身宽度；这里让它铺满外层可拖拽面板。
          provider 默认只有 min-h-svh，min-height 不能给子元素的 height:100% 提供确定高度，
          所以显式给 h-svh，否则 ResizablePanel 的高度会塌成 0。 */}
      <SidebarProvider className="h-svh" style={{ '--sidebar-width': '100%' } as CSSProperties}>
        {/*
          外壳：凹陷底色 + 标题行 + 右/下的 lip。两张卡片浮在它上面，
          rail 贴在卡片外面、不参与圆角（见 docs/DESKTOP-SHELL-MIGRATION.md）。
        */}
        {/*
          w-full 不能省：SidebarProvider 本身是 flex 行，不给宽度这个外壳会被收缩成内容宽度。
        */}
        <div className="flex h-full w-full flex-col bg-surface-recessed pr-[var(--shell-frame-lip)] pb-[var(--shell-frame-lip)]">
          <AppTitlebar
            environment={current}
            groupName={current?.groupId ? groups.find((g) => g.id === current.groupId)?.name : undefined}
            showSidebarToggle={sidebarVisible}
            sidebarOpen={!sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            onTakeover={takeover}
            onRelease={release}
          />

          <div className="flex min-h-0 flex-1">
            <AppRail
              settingsActive={settingsOpen}
              onOpenSettings={() => {
                setRequestedPage(undefined);
                setSettingsOpen((open) => !open);
              }}
              destinations={railDestinations}
            />

            {/*
              中间那一整块（侧栏 + 内容）是**一张**卡片：圆角套在外面这一层，
              左右两栏内部各自不再圆角。分开圆角会在浏览器区左边凭空出现一个圆角，
              而且侧栏收起时还得给内容区补角，多一处状态。
            */}
            <div className="min-h-0 min-w-0 flex-1 overflow-clip rounded-[var(--shell-card-radius)] border border-border">
              <ResizablePanelGroup orientation="horizontal" className="h-full min-w-0">
                {/*
                  环境列表**只在「环境」路由**。插件页和设置页占满整张卡——
                  它们不需要环境列表，留着只是白占一列。
                */}
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
                        onCreate={create}
                        onSelect={select}
                        onStart={start}
                        onStop={stop}
                        onRemove={remove}
                        onTakeover={takeover}
                        onRelease={release}
                        onEditEnvironment={editEnvironment}
                        onCreateGroup={createGroup}
                        onRenameGroup={renameGroup}
                        onRemoveGroup={removeGroup}
                        onToggleGroup={toggleGroup}
                        onMoveToGroup={moveToGroup}
                        pluginActions={registry.envActions}
                        onRunPluginAction={runPluginAction}
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
                      onSectionChange={setSettingsSection}
                      onChanged={() => setStateTick((tick) => tick + 1)}
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
                      snapshotLoading={snapshotLoading}
                      onRefreshSnapshot={readSnapshot}
                      cookies={cookies}
                      onReadCookies={readCookies}
                      consoleEntries={consoleEntries}
                      networkEntries={networkEntries}
                      netRules={netRules}
                      netHits={netHits}
                      onNetRuleToggle={setNetRuleEnabled}
                      stageRef={stageRef}
                      onSpaceSelect={selectSpace}
                      onTabSelect={tabSelect}
                      onTabClose={tabClose}
                      onTabCreate={tabCreate}
                      onTabCloseOthers={tabCloseOthers}
                      onTabCloseRight={tabCloseRight}
                      onTabReorder={tabReorder}
                      onTabReopen={tabReopen}
                      onTabToggleMute={tabToggleMute}
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
