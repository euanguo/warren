import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import type {
  AppSettings,
  EnvApi,
  Environment,
  Group,
  InstalledPlugin,
  MemorySnapshot,
  NavigationState,
  PopoverActionEvent,
  SystemDiagnosticsReport,
  TabState,
} from '@shared/types';

export interface MockEnvApiControls {
  api: EnvApi;
  openPopover: ReturnType<typeof vi.fn>;
  updatePopover: ReturnType<typeof vi.fn>;
  closePopover: ReturnType<typeof vi.fn>;
  dispatchPopoverAction: ReturnType<typeof vi.fn>;
  historySuggest: ReturnType<typeof vi.fn>;
  popupMenu: ReturnType<typeof vi.fn>;
  openOverlay: ReturnType<typeof vi.fn>;
  emitPopoverAction: (event: PopoverActionEvent) => void;
}

const DEFAULT_SETTINGS: AppSettings = {
  controlPolicy: 'ask',
  pluginPolicy: 'ask',
  theme: 'dark',
  skin: 'neutral',
  skinOverrides: {},
  compactTopbar: false,
  pageBorderRadius: true,
  devtoolsDefaultDock: 'right',
  devtoolsDefaultViewport: 'auto',
  devtoolsRightSize: 420,
  devtoolsBottomSize: 300,
  maxRunning: 8,
  idleHibernateMinutes: 10,
  memorySoftLimitMb: 6144,
  tabSleepMinutes: 20,
  lazyRestoreTabs: true,
  throttleBackgroundTabs: true,
  lruEvictAction: 'hibernate',
  pinnedEnvIds: [],
  leaseTtlMs: 60_000,
  showControlPill: true,
};

const DEFAULT_MEMORY_SNAPSHOT = (): MemorySnapshot => ({
  capturedAt: new Date().toISOString(),
  totalMemoryKb: 512 * 1024,
  systemTotalKb: 16 * 1024 * 1024,
  systemFreeKb: 8 * 1024 * 1024,
  softLimitMb: 6144,
  pressure: 'normal',
  reclaimableMemoryKb: 0,
  breakdown: {
    environmentsKb: 256 * 1024,
    pluginsKb: 64 * 1024,
    shellKb: 96 * 1024,
    systemKb: 96 * 1024,
  },
  counts: {
    totalEnvs: 0,
    runningEnvs: 0,
    dormantEnvs: 0,
    activeTabs: 0,
    sleepingTabs: 0,
    runningPlugins: 0,
    processCount: 3,
  },
  environments: [],
  plugins: [],
  processes: [],
});

const DEFAULT_DIAGNOSTICS: SystemDiagnosticsReport = {
  generatedAt: new Date().toISOString(),
  appVersion: '0.2.0',
  electronVersion: '45.5.0',
  nodeVersion: '24.22.0',
  platform: 'darwin-arm64',
  dataDir: '/Users/test/.warren',
  checks: [],
};

const EMPTY_TAB: TabState = {
  id: 'tab-1',
  url: 'about:blank',
  title: '新标签页',
  loading: false,
  audible: false,
  muted: false,
  space: 'person',
  createdAt: new Date().toISOString(),
};

const EMPTY_NAV: NavigationState = {
  url: 'about:blank',
  canGoBack: false,
  canGoForward: false,
  loading: false,
};

const EMPTY_ENV = (id = 'mock-env'): Environment => ({
  id,
  name: id,
  storagePath: `/tmp/${id}`,
  createdBy: 'human',
  status: 'stopped',
  headed: true,
  order: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  owner: 'none',
  activeSpaceId: 'person',
  spaces: [],
});

const EMPTY_GROUP = (name = '分组'): Group => ({
  id: 'grp-1',
  name,
  collapsed: false,
  order: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const EMPTY_PLUGIN = (id = 'com.warren.mock'): InstalledPlugin => ({
  id,
  name: id,
  version: '0.1.0',
  apiVersion: '4',
  packageName: id,
  runtime: 'sandbox',
  enabled: false,
  status: 'disabled',
  permissions: [],
  granted: [],
  needsConfirmation: [],
  settings: [],
  skillExposed: false,
  contributes: { commands: [], settings: [], surfaces: [], rpc: [] },
  dir: `/tmp/plugins/${id}`,
  installedAt: new Date().toISOString(),
  digest: '0'.repeat(64),
  source: `path:/tmp/plugins/${id}`,
  resolved: `/tmp/plugins/${id}`,
});

const noopUnsub = () => () => {};

/**
 * 严格类型化的 `EnvApi` 无头测试桩（移除盲目 Proxy 与失效影子 API 名称），
 * 若主进程/Preload `EnvApi` 增删改方法，此处将在 `tsc` 阶段即时报错。
 */
export function installMockEnvApi(overrides: Partial<EnvApi> = {}): MockEnvApiControls {
  const popoverActionListeners = new Set<(event: PopoverActionEvent) => void>();

  const openPopover = vi.fn(async () => {});
  const updatePopover = vi.fn(async () => {});
  const closePopover = vi.fn(async () => {});
  const dispatchPopoverAction = vi.fn(async () => {});
  const historySuggest = vi.fn(async () => []);
  const popupMenu = vi.fn(async () => null);
  const openOverlay = vi.fn(async () => null);

  const base = {
    platform: 'darwin',
    list: vi.fn(async () => []),
    create: vi.fn(async (input) => EMPTY_ENV(input.id)),
    start: vi.fn(async (id) => ({ ...EMPTY_ENV(id), status: 'running' as const })),
    stop: vi.fn(async () => {}),
    hibernate: vi.fn(async () => ({ ok: true })),
    hibernateBackground: vi.fn(async () => ({ hibernated: [], count: 0 })),
    wake: vi.fn(async () => ({ ok: true })),
    clearEnvCache: vi.fn(async () => ({ ok: true })),
    clearAllCaches: vi.fn(async () => ({ cleared: 0 })),
    remove: vi.fn(async () => {}),
    update: vi.fn(async (id) => EMPTY_ENV(id)),
    settings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    setSettings: vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch })),
    moveToGroup: vi.fn(async (id) => EMPTY_ENV(id)),
    groups: vi.fn(async () => []),
    groupCreate: vi.fn(async (name) => EMPTY_GROUP(name)),
    groupRename: vi.fn(async (_id, name) => EMPTY_GROUP(name)),
    groupRemove: vi.fn(async () => ({ detached: 0 })),
    groupCollapse: vi.fn(async () => EMPTY_GROUP()),
    select: vi.fn(async () => {}),
    selected: vi.fn(async () => null),
    takeover: vi.fn(async () => ({})),
    release: vi.fn(async () => {}),
    finishAgentSession: vi.fn(async () => {}),
    events: vi.fn(async () => []),
    snapshot: vi.fn(async () => ({ url: 'about:blank', title: '', nodes: [] })),
    console: vi.fn(async () => []),
    network: vi.fn(async () => []),
    cookies: vi.fn(async () => []),
    netRules: vi.fn(async () => ({ rules: [], hits: 0, recording: false, replaying: false })),
    netHits: vi.fn(async () => []),
    netRuleSet: vi.fn(async (_id, ruleId, enabled) => ({
      id: ruleId,
      enabled,
      match: { url: '*' },
      action: { type: 'passthrough' as const },
    })),
    navState: vi.fn(async () => EMPTY_NAV),
    humanNavigate: vi.fn(async () => EMPTY_NAV),
    historySuggest,
    openDevTools: vi.fn(async () => {}),
    closeDevTools: vi.fn(async () => {}),
    setDevToolsDock: vi.fn(async () => {}),
    getDevToolsState: vi.fn(async () => ({ open: false, dock: 'right' as const, size: 420 })),
    findInPage: vi.fn(async () => {}),
    stopFindInPage: vi.fn(async () => {}),
    onFindResult: vi.fn(noopUnsub),
    setZoom: vi.fn(async () => ({ factor: 1 })),
    getZoom: vi.fn(async () => ({ factor: 1 })),
    setViewportPreset: vi.fn(async (_id, _space, preset) => ({ preset })),
    getViewportPreset: vi.fn(async () => ({ preset: 'auto' as const })),
    onTargetUrl: vi.fn(noopUnsub),
    downloads: vi.fn(async () => []),
    revealDownload: vi.fn(async () => {}),
    printPage: vi.fn(async () => {}),
    savePage: vi.fn(async () => ({ saved: false })),
    highlightElement: vi.fn(async () => {}),
    popupMenu,
    openOverlay: openOverlay as EnvApi['openOverlay'],
    getOverlayState: vi.fn(async () => null),
    resolveOverlay: vi.fn(async () => {}),
    onOverlayState: vi.fn(noopUnsub),
    openPopover,
    updatePopover: updatePopover as EnvApi['updatePopover'],
    closePopover,
    getPopoverState: vi.fn(async () => null),
    dispatchPopoverAction,
    onPopoverState: vi.fn(noopUnsub),
    onPopoverAction: vi.fn((cb: (event: PopoverActionEvent) => void) => {
      popoverActionListeners.add(cb);
      return () => popoverActionListeners.delete(cb);
    }),
    onPopoverDismissed: vi.fn(noopUnsub),
    onBrowserShortcut: vi.fn(noopUnsub),
    spaceSelect: vi.fn(async () => {}),
    tabCreate: vi.fn(async () => EMPTY_TAB),
    tabSelect: vi.fn(async () => EMPTY_TAB),
    tabClose: vi.fn(async () => {}),
    tabCloseOthers: vi.fn(async () => {}),
    tabCloseRight: vi.fn(async () => {}),
    tabReorder: vi.fn(async () => [EMPTY_TAB]),
    tabReopen: vi.fn(async () => EMPTY_TAB),
    tabMute: vi.fn(async () => EMPTY_TAB),
    tabSleep: vi.fn(async () => ({ ok: true })),
    sleepIdleTabs: vi.fn(async () => ({ slept: 0 })),
    domainPrefs: vi.fn(async () => []),
    clearDomainPref: vi.fn(async () => ({ removed: true })),
    clearUrlHistory: vi.fn(async () => ({ cleared: 0 })),
    systemDoctor: vi.fn(async () => ({ ...DEFAULT_DIAGNOSTICS })),
    memorySnapshot: vi.fn(async () => DEFAULT_MEMORY_SNAPSHOT()),
    reclaimShellSurfaces: vi.fn(async () => ({ reclaimed: 0 })),
    openDataDir: vi.fn(async () => ({ opened: true })),
    agentSkills: vi.fn(async () => []),
    agentInstallSkill: vi.fn(async () => ({ path: '/tmp/SKILL.md' })),
    agentRefreshSkills: vi.fn(async () => []),
    plugins: vi.fn(async () => []),
    pluginEnable: vi.fn(async (id) => ({ ...EMPTY_PLUGIN(id), enabled: true, status: 'running' as const })),
    pluginDisable: vi.fn(async () => {}),
    pluginUninstall: vi.fn(async () => {}),
    pluginGrant: vi.fn(async (id) => EMPTY_PLUGIN(id)),
    pluginInstall: vi.fn(async () => ({ cancelled: true })),
    pluginReload: vi.fn(async (id) => EMPTY_PLUGIN(id)),
    pluginLogs: vi.fn(async () => []),
    pluginConfigSet: vi.fn(async (id) => EMPTY_PLUGIN(id)),
    pluginSetSkillExposed: vi.fn(async (id) => EMPTY_PLUGIN(id)),
    pluginReadSkill: vi.fn(async (id) => ({
      pluginId: id,
      pluginName: id,
      version: '0.1.0',
      summary: '',
      triggers: [],
      references: [],
      hasExplicitSkill: false,
      exposed: false,
      markdown: '',
      bytes: 0,
      sha256: '',
    })),
    pluginRpc: vi.fn(async () => ({ ok: true as const, data: null })),
    pluginHostRead: vi.fn(async () => ({ ok: true as const, data: null })),
    pluginRun: vi.fn(async (id, command) => ({ pluginId: id, command, result: null })),
    onPluginSignal: vi.fn(noopUnsub),
    setViewport: vi.fn(async () => {}),
    setViewVisible: vi.fn(async () => {}),
    onEnvDelta: vi.fn(noopUnsub),
    onPluginChanged: vi.fn(noopUnsub),
    ...overrides,
  } satisfies EnvApi;

  Object.defineProperty(window, 'envApi', {
    value: base,
    configurable: true,
    writable: true,
  });

  return {
    api: base,
    openPopover,
    updatePopover,
    closePopover,
    dispatchPopoverAction,
    historySuggest,
    popupMenu,
    openOverlay,
    emitPopoverAction: (event) => {
      for (const listener of popoverActionListeners) listener(event);
    },
  };
}

class StubResizeObserver {
  #callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }
  observe(target: Element): void {
    this.#callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

installMockEnvApi();

afterEach(() => {
  cleanup();
  installMockEnvApi();
});
