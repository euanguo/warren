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
  actions: Array<{ kind: string; x: number; y: number }>;
  visible: boolean;
  showPill: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  destroyed: boolean;
  onTakeover?: () => void;
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
  };
  return {
    get showing() {
      return state.showing;
    },
    get viewVisible() {
      return state.viewVisible;
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
      return true;
    },
    detachBelow() {
      state.belowDetached += 1;
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

  // 选中时预建遮罩
  coordinator.syncShield('alpha', { createIfMissing: true });
  assert.equal(shield?.attached, true);

  // Person Space 不允许申请 lease
  assert.throws(() => coordinator.acquire('alpha', 'agent', 'cli', 'person'), { code: 'BAD_REQUEST' });

  // Agent 获取租约并发射 lease.changed
  const first = coordinator.acquire('alpha', 'agent', 'cli', 'agent');
  assert.equal(first.owner, 'agent');
  assert.equal(coordinator.isAgentControlling('alpha'), true);
  assert.throws(() => coordinator.assertHumanAgentWritable('alpha'), { code: 'ENV_BUSY' });
  assert.equal(shield?.label, 'cli');
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

  // agent release 与 human release 都保持当前所在视图（不强行跳回 person space），并重挂空闲遮罩
  coordinator.release('alpha', autoTaken.leaseId, 'agent');
  assert.equal(busEvents.at(-1)?.payload.owner, 'none');
  assert.equal(busEvents.at(-1)?.payload.space, 'agent');
  assert.equal(activeSpace, 'agent');
  assert.equal(shield?.attached, true);

  const humanLease = coordinator.takeover('alpha', 'human', 'agent');
  assert.equal(shield?.attached, false);
  coordinator.release('alpha', humanLease.leaseId, 'human');
  assert.equal(activeSpace, 'agent');
  assert.equal(shield?.attached, true);
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

  // 启动第 3 个环境 c，达到 maxRunning=2：a 被选中不能回收，因此 b 被 LRU 回收
  now += 1_000;
  await lifecycle.start('c');
  lifecycle.touch('c');
  assert.equal(lifecycle.isRunning('a'), true);
  assert.equal(lifecycle.isRunning('b'), false);
  assert.equal(lifecycle.isRunning('c'), true);
  assert.deepEqual(
    busEvents
      .filter((e) => e.type === 'env.status')
      .map((e) => `${e.environmentId}:${e.payload.status}:${e.payload.reason}`),
    ['a:running:start', 'b:running:start', 'b:stopped:evicted', 'c:running:start'],
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

  // restoreRunning 会跳过休眠中的环境、拉起未运行的环境
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

  coordinator.syncShield('alpha', { createIfMissing: true });
  assert.equal(shield?.mode, 'idle');
  // 空闲态不播 AI 动作轨迹
  coordinator.showVisualAction('alpha', { kind: 'click', x: 120, y: 80 });
  assert.equal(shield?.actions.length, 0);

  coordinator.setLeaseTtlMs(120_000);
  const lease = coordinator.acquire('alpha', 'agent', 'Codex', 'agent');
  assert.equal(lease.expiresAt, now + 120_000);
  assert.equal(shield?.mode, 'agent');
  assert.equal(shield?.showPill, true);

  // AI 持锁且可见时，动作坐标准确推给遮罩层
  coordinator.showVisualAction('alpha', { kind: 'click', x: 160, y: 240, label: 'Submit' });
  assert.deepEqual(shield?.actions, [{ kind: 'click', x: 160, y: 240 }]);

  // 人工接管后立即切回 idle 并停止播报
  coordinator.takeover('alpha', 'human', 'agent');
  assert.equal(shield?.attached, false);
  assert.equal(shield?.mode, 'idle');
  coordinator.showVisualAction('alpha', { kind: 'click', x: 200, y: 300 });
  assert.equal(shield?.actions.length, 1);

  coordinator.setShowControlPill(false);
  assert.equal(shield?.showPill, false);
});
