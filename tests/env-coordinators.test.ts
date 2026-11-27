import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from 'electron';
import { redactUrl } from '../src/main/browser/redact.ts';
import { createEnvironmentConfig, toEnvironment } from '../src/main/domain/environment.ts';
import { LeaseCoordinator, type ShieldLike, type TabManagerLike } from '../src/main/env/lease-coordinator.ts';
import { EnvLifecycle, type EnvironmentSpaces } from '../src/main/env/lifecycle.ts';
import type { RunningSnapshot, RememberedTab } from '../src/main/store.ts';
import type { Tab, TabManager } from '../src/main/tabs.ts';
import type {
  ControlPolicy,
  EnvironmentConfig,
  EventRecord,
  PluginBusEvent,
  PluginBusEventType,
  PluginEventFilter,
  PluginSurfaceDecl,
  PluginSurfaceKind,
  SpaceId,
  TabState,
} from '../src/shared/types.ts';

function makeTabState(id: string, space: SpaceId, url: string, over: Partial<TabState> = {}): TabState {
  return {
    id,
    space,
    title: id,
    url,
    loading: false,
    audible: false,
    muted: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeFakeShield(): ShieldLike & {
  label?: string;
  mode?: 'agent' | 'idle';
  session?: {
    phase: 'acting' | 'thinking';
    startedAt: number;
    lastActivityAt: number;
    lastAction?: string;
    actionCount: number;
  };
  actions: Array<{ kind: string; x: number; y: number }>;
  visible: boolean;
  showPill: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  destroyed: boolean;
  onTakeover?: () => void;
  onFinish?: () => void;
} {
  return {
    attached: false,
    visible: true,
    showPill: true,
    destroyed: false,
    actions: [],
    setCallerLabel(label?: string) {
      this.label = label;
    },
    setMode(mode: 'agent' | 'idle') {
      this.mode = mode;
    },
    setSession(session) {
      this.session = { ...session };
    },
    showAction(action: { kind: string; x: number; y: number }) {
      this.actions.push({ kind: action.kind, x: action.x, y: action.y });
    },
    setVisible(visible: boolean) {
      this.visible = visible;
    },
    setShowControlPill(show: boolean) {
      this.showPill = show;
    },
    setBounds(bounds: { x: number; y: number; width: number; height: number }) {
      this.bounds = bounds;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

function makeFakeTabManager(
  space: SpaceId,
  options: { showing?: boolean; viewVisible?: boolean } = {},
): TabManagerLike & {
  tabs: TabState[];
  belowAttached: number;
  belowDetached: number;
  setViewVisible(visible: boolean): void;
  setActive(id: string): void;
  setTabs(tabs: TabState[]): void;
} {
  const state = {
    showing: options.showing ?? false,
    viewVisible: options.viewVisible ?? true,
    activeId: 't1' as string | undefined,
    tabs: [makeTabState('t1', space, 'https://example.test/')],
    belowAttached: 0,
    belowDetached: 0,
    attachedBelowNow: false,
  };
  return {
    get showing() {
      return state.showing;
    },
    get viewVisible() {
      return state.viewVisible;
    },
    get attachedBelow() {
      return state.attachedBelowNow;
    },
    setViewVisible(visible: boolean) {
      state.viewVisible = visible;
    },
    get activeId() {
      return state.activeId;
    },
    get tabs() {
      return state.tabs;
    },
    get belowAttached() {
      return state.belowAttached;
    },
    get belowDetached() {
      return state.belowDetached;
    },
    setActive(id: string) {
      state.activeId = id;
    },
    setTabs(tabs: TabState[]) {
      state.tabs = tabs;
    },
    attachBelow() {
      state.belowAttached += 1;
      state.attachedBelowNow = true;
      return true;
    },
    detachBelow() {
      state.belowDetached += 1;
      state.attachedBelowNow = false;
    },
    resolveRef(ref) {
      if (typeof ref === 'number') return state.tabs[ref - 1]?.id;
      return state.tabs.find((t) => t.id === ref)?.id;
    },
    controller() {
      return undefined;
    },
    active() {
      return undefined;
    },
  };
}

// ── LeaseCoordinator 单测 ─────────────────────────────────────────────────────

test('LeaseCoordinator：acquire / renew / release / takeover 完整流转与 bus 事件', () => {
  let now = 10_000;
  let selectedId: string | undefined = 'alpha';
  let activeSpace: SpaceId = 'agent';
  let policy: ControlPolicy = 'ask';
  const configs = new Map<string, EnvironmentConfig>([
    ['alpha', createEnvironmentConfig({ id: 'alpha', storagePath: '/tmp/alpha', createdBy: 'human' })],
  ]);
  const spaceManagers = new Map<string, ReturnType<typeof makeFakeTabManager>>([
    ['alpha:person', makeFakeTabManager('person', { showing: false })],
    ['alpha:agent', makeFakeTabManager('agent', { showing: true })],
  ]);
  const busEvents: Array<{ type: PluginBusEventType; id: string; payload: Record<string, unknown> }> = [];
  const events: Array<{ type: string; actor: string }> = [];
  let shield: ReturnType<typeof makeFakeShield> | undefined;
  let raiseCount = 0;

  const coordinator = new LeaseCoordinator({
    getEnvironment: (id) => {
      const cfg = configs.get(id);
      if (!cfg) return undefined;
      const lease = coordinator.rawLease(id);
      return toEnvironment(cfg, {
        owner: lease && lease.expiresAt > now ? lease.owner : 'none',
        leaseId: lease?.leaseId,
        leaseExpiresAt: lease?.expiresAt,
      });
    },
    getConfig: (id) => configs.get(id),
    getControlPolicy: () => policy,
    getSpaceManager: (id, space = activeSpace) => spaceManagers.get(`${id}:${space}`),
    getSelectedId: () => selectedId,
    getActiveSpace: () => activeSpace,
    getViewVisible: () => true,
    getPageBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    getViewportSize: () => ({ width: 800, height: 600 }),
    selectSpaceView: (_id, space) => {
      activeSpace = space;
    },
    restoreDisplayedFocus: () => {},
    touch: () => {},
    recordEvent: (type, _message, actor) => {
      events.push({ type, actor });
    },
    onChange: () => {},
    emitBusEvent: (type, id, payload) => {
      busEvents.push({ type, id, payload });
    },
    createShield: (_id, onTakeover) => {
      shield = makeFakeShield();
      shield.onTakeover = onTakeover;
      return shield;
    },
    attachAndRaiseShield: (s, bounds) => {
      (s as { attached: boolean }).attached = true;
      s.setBounds(bounds);
      raiseCount += 1;
    },
    detachShield: (s) => {
      (s as { attached: boolean }).attached = false;
    },
    leaseTtlMs: () => 30_000,
    now: () => now,
  });

  // 人机协作 2.0：Agent Space 空闲时绝不挂载护盾，允许人工直接导航和写入
  const getShield = () => shield;
  coordinator.syncShield('alpha', { createIfMissing: true });
  assert.equal(getShield(), undefined);
  assert.equal(coordinator.canHumanNavigate('alpha', 'agent'), true);
  coordinator.assertHumanAgentWritable('alpha');

  // Person Space 不允许申请 lease
  assert.throws(() => coordinator.acquire('alpha', 'agent', 'cli', 'person'), { code: 'BAD_REQUEST' });

  // Agent 获取租约并发射 lease.changed，此时才按需创建并挂载护盾、锁定人工写入
  const first = coordinator.acquire('alpha', 'agent', 'cli', 'agent');
  assert.equal(first.owner, 'agent');
  assert.equal(coordinator.isAgentControlling('alpha'), true);
  assert.equal(coordinator.canHumanNavigate('alpha', 'agent'), false);
  assert.throws(() => coordinator.assertHumanAgentWritable('alpha'), { code: 'ENV_BUSY' });
  assert.equal(getShield()?.attached, true);
  assert.equal(getShield()?.label, 'cli');
  assert.ok(raiseCount >= 1);
  assert.equal(busEvents.at(-1)?.type, 'lease.changed');
  assert.deepEqual(busEvents.at(-1)?.payload, {
    owner: 'agent',
    space: 'agent',
    leaseId: first.leaseId,
    label: 'cli',
  });

  // 另一 agent 未出示匹配 leaseId 时拒绝抢占（防止多 Agent 共享同一 leaseId）
  now += 5_000;
  assert.throws(() => coordinator.acquire('alpha', 'agent', 'other-cli', 'agent'), { code: 'ENV_BUSY' });

  // 持有者出示匹配 leaseId 再 acquire = 续租，leaseId 不变且不重复发 acquired 事件
  const renewedSame = coordinator.acquire('alpha', 'agent', 'cli', 'agent', first.leaseId);
  assert.equal(renewedSame.leaseId, first.leaseId);
  assert.equal(renewedSame.expiresAt, 45_000);
  assert.equal(busEvents.length, 1);

  // 显式 renew 推迟到期时间
  now += 5_000;
  const renewed = coordinator.renew('alpha', first.leaseId);
  assert.equal(renewed.expiresAt, 50_000);

  // 不同 owner 在 ask 策略下被拒绝
  assert.throws(() => coordinator.acquire('alpha', 'human', 'ui', 'agent'), { code: 'ENV_BUSY' });

  // 人工 takeover 抢回控制权，撤除遮罩并发射 lease.changed
  const taken = coordinator.takeover('alpha', 'human', 'agent');
  assert.equal(taken.owner, 'human');
  assert.equal(coordinator.isAgentControlling('alpha'), false);
  coordinator.assertHumanAgentWritable('alpha');
  assert.equal(shield?.attached, false);
  assert.equal(busEvents.at(-1)?.payload.owner, 'human');
  assert.equal(busEvents.at(-1)?.payload.leaseId, taken.leaseId);

  // 旧 leaseId 在 assertWritable 与 release 上都准确报 user_takeover
  assert.throws(
    () => coordinator.assertWritable('alpha', first.leaseId, 'agent'),
    (error: Error & { code?: string; reason?: string }) =>
      error.code === 'CONTROL_REVOKED' && error.reason === 'user_takeover',
  );
  assert.throws(
    () => coordinator.release('alpha', first.leaseId, 'agent'),
    (error: Error & { code?: string; reason?: string }) =>
      error.code === 'CONTROL_REVOKED' && error.reason === 'user_takeover',
  );

  // auto 策略下 agent 可以从人手里自动接管
  policy = 'auto';
  const autoTaken = coordinator.acquire('alpha', 'agent', 'bot', 'agent');
  assert.equal(autoTaken.owner, 'agent');
  assert.equal(shield?.attached, true);
  assert.equal(
    events.some((e) => e.type === 'control.autoTakeover'),
    true,
  );

  // agent release 与 human release 都保持当前所在视图（不强行跳回 person space），且空闲态绝不重挂遮罩
  coordinator.release('alpha', autoTaken.leaseId, 'agent');
  assert.equal(busEvents.at(-1)?.payload.owner, 'none');
  assert.equal(busEvents.at(-1)?.payload.space, 'agent');
  assert.equal(activeSpace, 'agent');
  assert.equal(getShield()?.attached, false);
  assert.equal(coordinator.canHumanNavigate('alpha', 'agent'), true);

  const humanLease = coordinator.takeover('alpha', 'human', 'agent');
  assert.equal(getShield()?.attached, false);
  coordinator.release('alpha', humanLease.leaseId, 'human');
  assert.equal(activeSpace, 'agent');
  assert.equal(getShield()?.attached, false);
});

test('LeaseCoordinator：ensureOperable / assertInputOnScreen / assertActiveTab 护栏', () => {
  const selectedId = 'front';
  const frontTabs = makeFakeTabManager('person', { showing: true, viewVisible: true });
  const backTabs = makeFakeTabManager('agent', { showing: false, viewVisible: false });
  backTabs.setTabs([makeTabState('t1', 'agent', 'https://a.test'), makeTabState('t2', 'agent', 'https://b.test')]);
  let restoredFocus = 0;

  const coordinator = new LeaseCoordinator({
    getEnvironment: () => undefined,
    getConfig: () => undefined,
    getControlPolicy: () => 'ask',
    getSpaceManager: (id, space = 'person') => {
      if (id === 'front') return frontTabs;
      if (id === 'back' && space === 'agent') return backTabs;
      return undefined;
    },
    getSelectedId: () => selectedId,
    getActiveSpace: () => 'person',
    getViewVisible: () => true,
    getPageBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    getViewportSize: () => ({ width: 800, height: 600 }),
    selectSpaceView: () => {},
    restoreDisplayedFocus: () => {
      restoredFocus += 1;
    },
    touch: () => {},
    recordEvent: () => {},
    onChange: () => {},
    emitBusEvent: () => {},
    createShield: () => makeFakeShield(),
    attachAndRaiseShield: () => {},
    detachShield: () => {},
  });

  // 前台环境不需要 attachBelow
  assert.equal(coordinator.ensureOperable('front', 'person'), false);

  // 后台环境即使之前留着 viewVisible=false，也不应误拒 assertInputOnScreen
  coordinator.assertInputOnScreen('back', 'agent');

  // 后台环境可以临时挂到底层，并立刻把焦点还给前台
  assert.equal(coordinator.ensureOperable('back', 'agent'), true);
  assert.equal(backTabs.belowAttached, 1);
  assert.equal(restoredFocus, 1);
  coordinator.detachOperable('back', 'agent');
  assert.equal(backTabs.belowDetached, 1);

  // 前台被浮层让开时，拒绝输入与后台临时挂载
  frontTabs.setViewVisible(false);
  assert.throws(() => coordinator.assertInputOnScreen('front', 'person'), { code: 'ENV_NOT_VISIBLE' });
  assert.throws(() => coordinator.ensureOperable('back', 'agent'), { code: 'ENV_NOT_VISIBLE' });

  // 非激活标签禁止输入操作
  assert.throws(() => coordinator.assertActiveTab('back', 2, 'agent'), { code: 'TAB_NOT_VISIBLE' });
  coordinator.assertActiveTab('back', 1, 'agent');
});

test('LeaseCoordinator：启用永久隐藏宿主窗时消除浮层/插件页触发的 ENV_NOT_VISIBLE，且 withScreenshotContext 统一唤醒与回收', async () => {
  const frontTabs = makeFakeTabManager('agent', { showing: true, viewVisible: false });
  const backTabs = makeFakeTabManager('agent', { showing: false, viewVisible: false });
  let restoredFocus = 0;
  const renderFocusCalls: Array<{ id: string; space: SpaceId }> = [];

  const coordinator = new LeaseCoordinator({
    getEnvironment: () => undefined,
    getConfig: () => undefined,
    getControlPolicy: () => 'ask',
    getSpaceManager: (id) => {
      if (id === 'front') return frontTabs;
      if (id === 'back') return backTabs;
      return undefined;
    },
    getSelectedId: () => 'front',
    getActiveSpace: () => 'agent',
    getViewVisible: () => false,
    getPageBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    getViewportSize: () => ({ width: 800, height: 600 }),
    selectSpaceView: () => {},
    restoreDisplayedFocus: () => {
      restoredFocus += 1;
    },
    touch: () => {},
    recordEvent: () => {},
    onChange: () => {},
    emitBusEvent: () => {},
    createShield: () => makeFakeShield(),
    attachAndRaiseShield: () => {},
    detachShield: () => {},
    hasBackgroundHost: () => true,
    ensureRenderFocus: async (id, space) => {
      renderFocusCalls.push({ id, space });
    },
  });

  // 即使前台正开着设置页/插件全屏页（viewVisible=false），后台环境也直接挂入隐藏宿主窗，不报 ENV_NOT_VISIBLE 且不惊动主窗口焦点
  assert.equal(coordinator.ensureOperable('back', 'agent'), true);
  assert.equal(backTabs.belowAttached, 1);
  assert.equal(restoredFocus, 0);
  coordinator.assertInputOnScreen('back', 'agent');
  coordinator.detachOperable('back', 'agent');
  assert.equal(backTabs.belowDetached, 1);

  // 前台当前 Space 被浮层让开时，也可借挂到隐藏宿主窗完成输入与截图，并在结束后归还
  const shot = await coordinator.withScreenshotContext('front', 'agent', async () => {
    assert.equal(frontTabs.attachedBelow, true);
    coordinator.assertInputOnScreen('front', 'agent');
    return 'captured';
  });
  assert.equal(shot, 'captured');
  assert.equal(frontTabs.attachedBelow, false);
  assert.equal(frontTabs.belowAttached, 1);
  assert.equal(frontTabs.belowDetached, 1);
  assert.deepEqual(renderFocusCalls, [{ id: 'front', space: 'agent' }]);

  // 回调抛错也必须释放隐藏宿主窗借挂
  await assert.rejects(
    () =>
      coordinator.withScreenshotContext('back', 'agent', async () => {
        assert.equal(backTabs.attachedBelow, true);
        throw new Error('shot-fail');
      }),
    /shot-fail/,
  );
  assert.equal(backTabs.attachedBelow, false);
});

// ── EnvLifecycle 单测 ─────────────────────────────────────────────────────────

function makeFakeStore(configs: EnvironmentConfig[], snapshot: RunningSnapshot = { running: [], dormant: [] }) {
  const byId = new Map(configs.map((c) => [c.id, c]));
  const tabs = new Map<string, RememberedTab[]>();
  const events: EventRecord[] = [];
  let runningSnapshot = snapshot;

  return {
    events,
    get runningState() {
      return runningSnapshot;
    },
    create(input: {
      id: string;
      name?: string;
      proxy?: string;
      startUrl?: string;
      headed?: boolean;
      createdBy?: 'human' | 'agent';
    }) {
      const cfg = createEnvironmentConfig({ ...input, storagePath: `/tmp/warren-test-${input.id}` });
      byId.set(cfg.id, cfg);
      return toEnvironment(cfg);
    },
    remove(id: string) {
      byId.delete(id);
      tabs.delete(id);
    },
    update(id: string, patch: { name?: string }) {
      const prev = byId.get(id)!;
      const next = { ...prev, ...(patch.name ? { name: patch.name } : {}) };
      byId.set(id, next);
      return toEnvironment(next);
    },
    configFor(id: string) {
      return byId.get(id);
    },
    runningSnapshot() {
      return runningSnapshot;
    },
    saveRunning(next: RunningSnapshot) {
      runningSnapshot = next;
    },
    tabsFor(id: string) {
      return tabs.get(id) ?? [];
    },
    saveTabs(id: string, next: RememberedTab[]) {
      tabs.set(id, next);
    },
    record(event: EventRecord) {
      events.push(event);
      return event;
    },
  };
}

function makeLifecycleTabManager(space: SpaceId, onEmpty: () => void) {
  let list: TabState[] = [];
  let activeId: string | undefined;
  let seq = 0;
  const destroyed = { value: false };
  const detached = { value: false };

  const tm = {
    get size() {
      return list.length;
    },
    get activeId() {
      return activeId;
    },
    get showing() {
      return !detached.value;
    },
    get attachedBelow() {
      return false;
    },
    get viewVisible() {
      return true;
    },
    get devToolsOpen() {
      return false;
    },
    list() {
      return list.map((item) => ({ ...item, active: item.id === activeId }));
    },
    create(opts: { url?: string; activate?: boolean } = {}) {
      seq += 1;
      const id = `${space}-tab-${seq}`;
      const tabState = makeTabState(id, space, opts.url ?? 'warren://newtab');
      list.push(tabState);
      if (opts.activate ?? true) activeId = id;
      return {
        id,
        space,
        state: tabState,
        webContents: undefined,
      } as unknown as Tab;
    },
    detach() {
      detached.value = true;
    },
    destroy() {
      destroyed.value = true;
      list = [];
      activeId = undefined;
    },
    triggerEmpty() {
      list = [];
      activeId = undefined;
      onEmpty();
    },
    setLoading(loading: boolean) {
      list = list.map((t) => ({ ...t, loading }));
    },
    destroyed,
  };
  return tm;
}

test('EnvLifecycle：start / LRU 回收 / hibernate / wake / sweepIdle / stop', async () => {
  let now = 100_000;
  let selectedId: string | undefined;
  const leased = new Set<string>();
  const configs = ['a', 'b', 'c'].map((id) =>
    createEnvironmentConfig({ id, storagePath: `/tmp/warren-test-${id}`, headed: false }),
  );
  const store = makeFakeStore(configs);
  const busEvents: PluginBusEvent[] = [];
  const clearedLeases: string[] = [];
  const detachedNet: string[] = [];
  const detachedTelemetry: string[] = [];
  const clearedTelemetry: string[] = [];
  const createdTabs = new Map<string, ReturnType<typeof makeLifecycleTabManager>>();
  let netBusyId: string | undefined;

  const droppedNet: string[] = [];
  const clearedStorage: string[] = [];
  const clearedSelected: string[] = [];
  const removedDirs: string[] = [];
  let lifecycle: EnvLifecycle;
  lifecycle = new EnvLifecycle({
    store,
    prepareSession: async () => ({ session: {} as Session, trustedCa: undefined }),
    prepareWakeSession: () => ({ session: {} as Session, trustedCa: undefined }),
    clearStorageData: async (id) => {
      clearedStorage.push(id);
    },
    dropNet: (id) => {
      droppedNet.push(id);
    },
    ensureDirectory: async () => {},
    removeDirectory: async (dir) => {
      removedDirs.push(dir);
    },
    wireDownloads: () => {},
    attachSessionTelemetry: () => {},
    detachNet: (id) => {
      detachedNet.push(id);
    },
    detachTelemetry: (id) => {
      detachedTelemetry.push(id);
    },
    clearTelemetry: (id) => {
      clearedTelemetry.push(id);
    },
    isNetBusy: (id) => netBusyId === id,
    createSpaceManager: (id, space) => {
      const tm = makeLifecycleTabManager(space, () => lifecycle.onSpaceEmpty(id, space));
      createdTabs.set(`${id}:${space}`, tm);
      return tm as unknown as TabManager;
    },
    newTabUrl: (id) => `warren://newtab/?env=${id}`,
    decorate: (env) => env,
    selectEnv: (id) => {
      selectedId = id;
    },
    clearSelectedIf: (id) => {
      clearedSelected.push(id);
      if (selectedId === id) selectedId = undefined;
    },
    getSelectedId: () => selectedId,
    hasLiveLease: (id) => leased.has(id),
    clearLeaseAndShield: (id) => {
      clearedLeases.push(id);
    },
    closeEnvDevTools: () => {},
    destroyAllDevTools: () => {},
    onChange: () => {},
    emitBusEvent: (type, environmentId, payload) => {
      busEvents.push({ type, environmentId, at: new Date(now).toISOString(), payload });
    },
    maxRunning: 2,
    idleMs: 60_000,
    now: () => now,
  });

  // 启动 a 和 b，其中 a 被选中保护、b 最近活跃于 t=100_000
  await lifecycle.start('a');
  lifecycle.touch('a');
  selectedId = 'a';
  now += 1_000;
  await lifecycle.start('b');
  lifecycle.touch('b');

  // 启动第 3 个环境 c，达到 maxRunning=2：a 被选中不能回收，因此 b 默认优先休眠（保留登录态）
  now += 1_000;
  await lifecycle.start('c');
  lifecycle.touch('c');
  assert.equal(lifecycle.isRunning('a'), true);
  assert.equal(lifecycle.isRunning('b'), false);
  assert.equal(lifecycle.isDormant('b'), true);
  assert.equal(lifecycle.isRunning('c'), true);
  assert.deepEqual(
    busEvents
      .filter((e) => e.type === 'env.status')
      .map((e) => `${e.environmentId}:${e.payload.status}:${e.payload.reason}`),
    ['a:running:start', 'b:running:start', 'b:dormant:LRU 并发上限 2', 'c:running:start'],
  );

  // c 正在忙碌（netBusy）时，sweepIdle 不休眠它
  now += 70_000;
  netBusyId = 'c';
  lifecycle.sweepIdle();
  assert.equal(lifecycle.isRunning('c'), true);
  assert.equal(lifecycle.isDormant('c'), false);

  // c 不再忙碌后，sweepIdle 将 c 休眠，而选中中的 a 保持运行
  netBusyId = undefined;
  lifecycle.sweepIdle();
  assert.equal(lifecycle.isRunning('c'), false);
  assert.equal(lifecycle.isDormant('c'), true);
  assert.equal(lifecycle.isRunning('a'), true);
  assert.equal(busEvents.at(-1)?.type, 'env.status');
  assert.equal(busEvents.at(-1)?.environmentId, 'c');
  assert.equal(busEvents.at(-1)?.payload.status, 'dormant');

  // wake(c) 同步恢复并还原标签快照
  assert.equal(lifecycle.wake('c'), true);
  assert.equal(lifecycle.isRunning('c'), true);
  assert.equal(lifecycle.isDormant('c'), false);
  assert.equal(createdTabs.get('c:person')?.list()[0]?.url, 'warren://newtab/?env=c');
  assert.equal(busEvents.at(-1)?.payload.status, 'running');
  assert.equal(busEvents.at(-1)?.payload.reason, 'wake');

  // restoreRunning 会跳过休眠中的环境、拉起已停止的环境
  lifecycle.stop('b');
  lifecycle.hibernate('c', 'manual');
  const restored = await lifecycle.restoreRunning(['b', 'c', 'missing']);
  assert.deepEqual(restored, ['b']);
  assert.equal(lifecycle.isDormant('c'), true);

  // stop 对休眠环境也会清掉 dormant 状态并发射 stopped
  lifecycle.stop('c');
  assert.equal(lifecycle.isDormant('c'), false);
  assert.equal(busEvents.at(-1)?.payload.status, 'stopped');
  assert.ok(clearedLeases.includes('c'));
  assert.ok(detachedNet.includes('c'));
  assert.ok(detachedTelemetry.includes('c'));
  assert.deepEqual(clearedTelemetry, [] as string[], 'stop 与 hibernate 必须保留遥测历史');

  // create / update / remove 也由 EnvLifecycle 协调
  const createdD = lifecycle.create({ id: 'd', name: 'Delta', createdBy: 'agent' });
  assert.equal(createdD.id, 'd');
  const updatedD = await lifecycle.update('d', { name: 'Delta-2' });
  assert.equal(updatedD.name, 'Delta-2');
  await lifecycle.remove('d');
  assert.ok(droppedNet.includes('d'));
  assert.ok(clearedTelemetry.includes('d'), '仅 remove(id) 清理遥测历史');
  assert.ok(clearedStorage.includes('d'));
  assert.ok(clearedSelected.includes('d'));
  assert.ok(removedDirs.includes('/tmp/warren-test-d'));

  lifecycle.shutdown();
  assert.equal(lifecycle.hasRunningEnvironments(), false);
});

test('redactBusUrl：脱敏 URL 密码与敏感 query 参数且保留普通参数', () => {
  assert.equal(redactUrl('warren://newtab/?env=alpha'), 'warren://newtab/?env=alpha');
  assert.equal(
    redactUrl('https://example.test/callback?token=sec-123&tab=1'),
    'https://example.test/callback?token=%5BREDACTED%5D&tab=1',
  );
  assert.equal(
    redactUrl('https://alice:topsecret@example.test/path'),
    'https://alice:%5BREDACTED%5D@example.test/path',
  );
  assert.equal(redactUrl('not a url'), 'not a url');
});

test('EnvLifecycle：EnvironmentSpaces 与 shared/types 扩充导出正确', () => {
  const space: EnvironmentSpaces = {
    person: makeLifecycleTabManager('person', () => {}) as unknown as TabManager,
    agent: makeLifecycleTabManager('agent', () => {}) as unknown as TabManager,
    active: 'person',
  };
  assert.equal(space.active, 'person');

  const kinds: PluginSurfaceKind[] = [
    'railPage',
    'settingsSection',
    'envAction',
    'inspectorTab',
    'envBadge',
    'popover',
    'commandBarAction',
    'statusBadge',
  ];
  const surface: PluginSurfaceDecl = {
    kind: 'commandBarAction',
    id: 'quick-open',
    title: 'Quick Open',
    shortcut: 'Mod+K',
  };
  const filter: PluginEventFilter = {
    environmentId: 'alpha',
    types: ['nav.committed', 'lease.changed', 'tab.created', 'env.status', 'net.hit'],
  };
  assert.equal(kinds.length, 8);
  assert.equal(surface.shortcut, 'Mod+K');
  assert.equal(filter.types?.length, 5);
});

test('LeaseCoordinator：运行期调整租约时长与控制胶囊显隐', () => {
  const configs = new Map<string, EnvironmentConfig>([
    ['alpha', createEnvironmentConfig({ id: 'alpha', storagePath: '/tmp/alpha', createdBy: 'human' })],
  ]);
  const spaceManagers = new Map<string, ReturnType<typeof makeFakeTabManager>>([
    ['alpha:person', makeFakeTabManager('person', { showing: false })],
    ['alpha:agent', makeFakeTabManager('agent', { showing: true })],
  ]);
  let shield: ReturnType<typeof makeFakeShield> | undefined;
  const now = 50_000;
  const coordinator = new LeaseCoordinator({
    getEnvironment: (id) => {
      const cfg = configs.get(id);
      return cfg ? toEnvironment(cfg, { owner: 'none' }) : undefined;
    },
    getConfig: (id) => configs.get(id),
    getControlPolicy: () => 'ask',
    getSpaceManager: (id, space = 'agent') => spaceManagers.get(`${id}:${space}`),
    getSelectedId: () => 'alpha',
    getActiveSpace: () => 'agent',
    getViewVisible: () => true,
    getPageBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    getViewportSize: () => ({ width: 800, height: 600 }),
    selectSpaceView: () => {},
    restoreDisplayedFocus: () => {},
    touch: () => {},
    recordEvent: () => {},
    onChange: () => {},
    emitBusEvent: () => {},
    createShield: () => {
      shield = makeFakeShield();
      return shield;
    },
    attachAndRaiseShield: (s) => {
      (s as { attached: boolean }).attached = true;
    },
    detachShield: (s) => {
      (s as { attached: boolean }).attached = false;
    },
    now: () => now,
  });

  // 人机协作 2.0：空闲态不建护盾也不播 AI 动作轨迹
  const getShield = () => shield;
  coordinator.syncShield('alpha', { createIfMissing: true });
  assert.equal(getShield(), undefined);
  coordinator.showVisualAction('alpha', { kind: 'click', x: 120, y: 80 });
  assert.equal(getShield(), undefined);

  coordinator.setLeaseTtlMs(120_000);
  const lease = coordinator.acquire('alpha', 'agent', 'Codex', 'agent');
  assert.equal(lease.expiresAt, now + 120_000);
  assert.equal(getShield()?.mode, 'agent');
  assert.equal(getShield()?.showPill, true);

  // AI 持锁且可见时，动作坐标准确推给遮罩层
  coordinator.showVisualAction('alpha', { kind: 'click', x: 160, y: 240, label: 'Submit' });
  assert.deepEqual(getShield()?.actions, [{ kind: 'click', x: 160, y: 240 }]);

  // 人工接管后立即切回 idle 并停止播报
  coordinator.takeover('alpha', 'human', 'agent');
  assert.equal(getShield()?.attached, false);
  assert.equal(getShield()?.mode, 'idle');
  coordinator.showVisualAction('alpha', { kind: 'click', x: 200, y: 300 });
  assert.equal(getShield()?.actions.length, 1);

  coordinator.setShowControlPill(false);
  assert.equal(getShield()?.showPill, false);
});

test('LeaseCoordinator：Agent 空间托管会话态（acting → thinking 常驻 → finish / takeover 退出）', () => {
  const configs = new Map<string, EnvironmentConfig>([
    ['alpha', createEnvironmentConfig({ id: 'alpha', storagePath: '/tmp/alpha', createdBy: 'human' })],
  ]);
  const spaceManagers = new Map<string, ReturnType<typeof makeFakeTabManager>>([
    ['alpha:person', makeFakeTabManager('person', { showing: false })],
    ['alpha:agent', makeFakeTabManager('agent', { showing: true })],
  ]);
  let shield: ReturnType<typeof makeFakeShield> | undefined;
  let now = 100_000;
  const coordinator = new LeaseCoordinator({
    getEnvironment: (id) => {
      const cfg = configs.get(id);
      return cfg ? toEnvironment(cfg, { owner: 'none' }) : undefined;
    },
    getConfig: (id) => configs.get(id),
    getControlPolicy: () => 'ask',
    getSpaceManager: (id, space = 'agent') => spaceManagers.get(`${id}:${space}`),
    getSelectedId: () => 'alpha',
    getActiveSpace: () => 'agent',
    getViewVisible: () => true,
    getPageBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    getViewportSize: () => ({ width: 800, height: 600 }),
    selectSpaceView: () => {},
    restoreDisplayedFocus: () => {},
    touch: () => {},
    recordEvent: () => {},
    onChange: () => {},
    emitBusEvent: () => {},
    createShield: (_id, onTakeover, onFinish) => {
      shield = makeFakeShield();
      shield.onTakeover = onTakeover;
      shield.onFinish = onFinish;
      return shield;
    },
    attachAndRaiseShield: (s) => {
      (s as { attached: boolean }).attached = true;
    },
    detachShield: (s) => {
      (s as { attached: boolean }).attached = false;
    },
    leaseTtlMs: () => 30_000,
    now: () => now,
  });

  // 1. 首次 AI 写入自动进入 Agent 空间托管态（acting）并挂载护盾
  const first = coordinator.acquire('alpha', 'agent', 'Codex', 'agent');
  assert.equal(coordinator.isAgentOperating('alpha'), true);
  assert.equal(coordinator.agentSession('alpha')?.phase, 'acting');
  assert.equal(shield?.attached, true);
  assert.equal(shield?.session?.phase, 'acting');
  assert.equal(coordinator.canHumanNavigate('alpha', 'agent'), false);

  // 2. 单条 CLI 命令以 keepSession=true 释放瞬时写锁：底层锁已空，但托管态切入 thinking 且护盾常驻不闪灭
  now += 2_000;
  coordinator.release('alpha', first.leaseId, 'agent', { keepSession: true });
  assert.equal(coordinator.spaceOwner('alpha', 'agent'), 'none');
  assert.equal(coordinator.isAgentOperating('alpha'), true);
  assert.equal(coordinator.agentSession('alpha')?.phase, 'thinking');
  assert.equal(shield?.attached, true);
  assert.equal(shield?.session?.phase, 'thinking');
  assert.equal(coordinator.canHumanNavigate('alpha', 'agent'), false);

  // 3. 只读观测刷新活跃时间，且下一条 CLI 写命令无缝复用不会触发 ENV_BUSY
  now += 5_000;
  coordinator.touchAgentSession('alpha', 'snapshot');
  assert.equal(coordinator.agentSession('alpha')?.lastActivityAt, now);
  assert.equal(coordinator.agentSession('alpha')?.lastAction, 'snapshot');
  const second = coordinator.acquire('alpha', 'agent', 'Codex', 'agent');
  assert.equal(coordinator.agentSession('alpha')?.phase, 'acting');
  assert.equal(coordinator.agentSession('alpha')?.actionCount, 2);

  // 4. 底层租约自然超时也只平滑切入 thinking，护盾不闪灭
  now += 31_000;
  assert.equal(coordinator.pruneExpiredLeases(), 1);
  assert.equal(coordinator.isAgentOperating('alpha'), true);
  assert.equal(coordinator.agentSession('alpha')?.phase, 'thinking');
  assert.equal(shield?.attached, true);

  // 5. 显式调用 finishAgentSession（或护盾上的「结束」按钮）立即退出托管态并撤除护盾
  shield?.onFinish?.();
  assert.equal(coordinator.isAgentOperating('alpha'), false);
  assert.equal(coordinator.agentSession('alpha'), undefined);
  assert.equal(shield?.attached, false);
  assert.equal(coordinator.canHumanNavigate('alpha', 'agent'), true);

  // 6. 人工 takeover 同样清空托管态并保持原有 CONTROL_REVOKED 契约
  const third = coordinator.acquire('alpha', 'agent', 'Codex', 'agent');
  assert.equal(coordinator.isAgentOperating('alpha'), true);
  coordinator.takeover('alpha', 'human', 'agent');
  assert.equal(coordinator.agentSession('alpha'), undefined);
  assert.equal(shield?.attached, false);
  assert.throws(
    () => coordinator.assertWritable('alpha', third.leaseId, 'agent'),
    (error: Error & { code?: string; reason?: string }) =>
      error.code === 'CONTROL_REVOKED' && error.reason === 'user_takeover',
  );
  // 防止 unused warning
  assert.ok(second.leaseId);
});

test('LeaseCoordinator：在 Person Space 完成首条 AI 命令进入 thinking 后，切入 Agent Space 立即创建并挂载护盾', () => {
  const configs = new Map<string, EnvironmentConfig>([
    ['alpha', createEnvironmentConfig({ id: 'alpha', storagePath: '/tmp/alpha', createdBy: 'human' })],
  ]);
  let activeSpace: SpaceId = 'person';
  let shield: ReturnType<typeof makeFakeShield> | undefined;
  const now = 200_000;
  const coordinator = new LeaseCoordinator({
    getEnvironment: (id) => {
      const cfg = configs.get(id);
      return cfg ? toEnvironment(cfg, { owner: 'none' }) : undefined;
    },
    getConfig: (id) => configs.get(id),
    getControlPolicy: () => 'ask',
    getSpaceManager: () => makeFakeTabManager('agent', { showing: true }),
    getSelectedId: () => 'alpha',
    getActiveSpace: () => activeSpace,
    getViewVisible: () => true,
    getPageBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    getViewportSize: () => ({ width: 800, height: 600 }),
    selectSpaceView: () => {},
    restoreDisplayedFocus: () => {},
    touch: () => {},
    recordEvent: () => {},
    onChange: () => {},
    emitBusEvent: () => {},
    createShield: (_id, onTakeover, onFinish) => {
      shield = makeFakeShield();
      shield.onTakeover = onTakeover;
      shield.onFinish = onFinish;
      return shield;
    },
    attachAndRaiseShield: (s) => {
      (s as { attached: boolean }).attached = true;
    },
    detachShield: (s) => {
      (s as { attached: boolean }).attached = false;
    },
    now: () => now,
  });

  const getShield = () => shield;
  // 用户停留在 Person Space 时，AI 执行完一条命令并进入 thinking：此时不建多余护盾进程
  const lease = coordinator.acquire('alpha', 'agent', 'Antigravity', 'agent');
  coordinator.release('alpha', lease.leaseId, 'agent', { keepSession: true });
  assert.equal(getShield(), undefined);
  assert.equal(coordinator.agentSession('alpha')?.phase, 'thinking');

  // 用户手动点击切到 Agent Space（selectSpace 触发 syncShield）：必须立即补建并挂载 thinking 态护盾
  activeSpace = 'agent';
  coordinator.syncShield('alpha');
  assert.ok(getShield(), '切入 thinking 态 Agent Space 时必须按需创建护盾');
  assert.equal(getShield()?.attached, true);
  assert.equal(getShield()?.mode, 'agent');
  assert.equal(getShield()?.session?.phase, 'thinking');
});
