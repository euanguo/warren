import {
  app,
  clipboard,
  dialog,
  screen,
  session,
  shell,
  webContents,
  type BrowserWindow,
  type Session,
} from 'electron';
import { mkdir, rm } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserController } from './browser/controller.ts';
import {
  clearCookies,
  copyCookies,
  importCookies,
  listCookies,
  type CookieFilter,
  type CookieInput,
  type CookieSummary,
} from './browser/cookies.ts';
import { EnvPending } from './browser/pending.ts';
import { getDownloadPath, listDownloads, wireDownloads } from './browser/downloads.ts';
import { NetInterceptor } from './net/interceptor.ts';
import { EnvironmentNetOps } from './net/ops.ts';
import { InputShield } from './input-shield';
import { WindowLayerManager } from './ui/layer-manager.ts';
import { DevToolsHost } from './ui/devtools-host.ts';
import { popupNativeMenu } from './ui/native-menu.ts';
import { buildPageContextMenu } from './browser-context-menu.ts';
import { newTabPage } from './newtab';
import { TabManager, newTabUrl, type Tab, type TabListItem } from './tabs';
import { Telemetry, type ConsoleEntry, type NetworkEntry } from './telemetry';
import {
  acquireLease,
  diagnoseLease,
  leaseDenialError,
  makeEvent,
  pickEvictions,
  pickDormant,
  releaseLease,
  renewLease,
  revokedReason,
  safeEnvKey,
  toEnvironment,
} from './domain/environment';
import type { EnvironmentPatch } from './domain/environment';
import { controlModeFor } from './domain/approval.ts';
import { leafSignedByCa, parseCa } from './domain/trusted-ca.ts';
import { chromeUserAgent } from './domain/user-agent';
import { addExtension, listExtensions, removeExtension } from './extensions';
import { nextViewTransition } from './environment-view-state';
import type { Store } from './store';
import type {
  EnvironmentConfig,
  BrowserShortcut,
  ControlOwner,
  Creator,
  DevToolsDockMode,
  DownloadItemInfo,
  Environment,
  EnvironmentSpace,
  FindInPageResult,
  Group,
  NavigationAction,
  SpaceId,
  TabRef,
  ViewportPresetId,
  ViewportRect,
} from '../shared/types';

const DEFAULT_LEASE_TTL_MS = 60_000;
const MAX_LEASE_TTL_MS = 10 * 60_000;

/**
 * Lease TTL 可由 `WARREN_LEASE_TTL_MS` 调整（30s..10m）。
 * 长脚本仍应以 `env renew` / CLI 续租器为主；这个开关只是给不同环境调参。
 */
function leaseTtlMs(): number {
  const raw = Number(process.env.WARREN_LEASE_TTL_MS);
  if (!Number.isFinite(raw) || raw < 30_000) return DEFAULT_LEASE_TTL_MS;
  return Math.min(Math.floor(raw), MAX_LEASE_TTL_MS);
}

/**
 * 同时运行的环境上限。超了按 LRU 回收（见 `#evictFor`）。
 *
 * 一个 Environment 就是一套 session + 页面/遮罩等若干 webContents，开几十个会把内存吃光。
 * `WARREN_MAX_RUNNING=0` 关掉回收（不限）。
 */
const DEFAULT_MAX_RUNNING = 8;

/** 闲置多久进入休眠。`WARREN_IDLE_MS=0` 关掉自动休眠。 */
const DEFAULT_IDLE_MS = 10 * 60_000;
/** 扫描间隔：只是掂一下 lastActive，别太勤。 */
const DORMANT_SWEEP_MS = 30_000;

function idleMsFromEnv(): number {
  const raw = Number(process.env.WARREN_IDLE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_IDLE_MS;
  return Math.floor(raw);
}

function maxRunningFromEnv(): number {
  const raw = Number(process.env.WARREN_MAX_RUNNING);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_RUNNING;
  return Math.floor(raw);
}

/**
 * 等第一个标签加载完。和原来 `controller.navigate()` 的等待语义一致。
 *
 * **只有主框架失败才算加载失败**：iframe 和子资源失败不该让它提前返回。
 * 失败原因记在标签自己的 `state.error` 上（见 `tabs.ts`），环境从激活标签派生。
 */
function waitForLoad(tab: Tab, timeoutMs: number): Promise<void> {
  const wc = tab.webContents;
  if (!wc || wc.isDestroyed() || !wc.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.off('did-stop-loading', onStop);
      wc.off('did-fail-load', onFail);
      resolve();
    };
    const onStop = () => finish();
    const onFail = (_event: unknown, _code: number, _desc: string, _url: string, isMainFrame: boolean) => {
      if (isMainFrame) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    wc.once('did-stop-loading', onStop);
    wc.on('did-fail-load', onFail);
  });
}

export interface LeaseHandle {
  environmentId: string;
  space: SpaceId;
  owner: ControlOwner;
  label?: string;
  leaseId: string;
  expiresAt: number;
}

export interface EnvironmentManagerOptions {
  layers?: WindowLayerManager;
  onTargetUrl?: (payload: { envId: string; url: string }) => void;
  onFindResult?: (result: FindInPageResult) => void;
  onDownloadsChanged?: () => void;
}

interface EnvironmentSpaces {
  person: TabManager;
  agent: TabManager;
  active: SpaceId;
}

const SPACE_IDS: readonly SpaceId[] = ['person', 'agent'];

function spaceLabel(space: SpaceId): string {
  return space === 'person' ? '我的空间' : 'Agent 空间';
}

export class EnvironmentManager {
  #store: Store;
  #window: BrowserWindow;
  #sessions = new Map<string, Session>();
  /** 每个运行中的环境两组标签。两组共用 session / 代理 / 登录态，但控制权独立。 */
  #spaces = new Map<string, EnvironmentSpaces>();
  /** 休眠中的环境：页面已销毁，配置 / session / 标签快照都还在。 */
  #dormant = new Set<string>();
  #leases = new Map<string, LeaseHandle>();
  #shields = new Map<string, InputShield>();
  /** 每个运行中环境的待处理队列（popup / download）与下载句柄表。 */
  #pending = new Map<string, EnvPending>();
  /**
   * 每个环境的网络拦截规则。规则跟着 Environment 存亡：停环境时摘掉 session 上的 handler，
   * 删环境时连规则一起清（不跨环境泄漏）。
   */
  /** 网络拦截的编排（规则 / 录制 / 回放）。实现见 net/ops.ts。 */
  #netOps = new EnvironmentNetOps({
    record: (type, message, actor, envId) => this.#store.record(makeEvent(type, message, actor, envId)),
    onChange: () => this.#onChange(),
    createInterceptor: (_id, record) => new NetInterceptor(record),
  });
  #telemetry: Telemetry;
  #viewport: ViewportRect = { x: 0, y: 0, width: 800, height: 600 };
  #backgroundBounds?: { x: number; y: number; width: number; height: number };
  #selected?: string;
  /** 每个环境最后一次被用到（选中 / 取租约 / agent 操作）。LRU 回收按它排序。 */
  #lastActive = new Map<string, number>();
  /**
   * 上次写进库的标签快照（`*` 前缀表示激活的那个）。
   *
   * 标签的 `onChanged` 会被标题 / 图标 / 加载态**频繁**触发，不去重就变成一路写库；
   * 而标签表只记 URL 与激活位，所以这串字符串一样就没必要写。
   */
  #tabSnapshot = new Map<string, string>();
  /** 唤醒瞬间新标签 URL 还是空的，这期间不许 #rememberTabs 把快照覆盖成空。 */
  #waking = new Set<string>();
  /** hibernate 销毁标签时 #onSpaceEmpty 不该把「休眠」改写成「主动停止」。 */
  #hibernating = new Set<string>();
  #maxRunning = maxRunningFromEnv();
  #idleMs = idleMsFromEnv();
  #sweepTimer?: ReturnType<typeof setInterval>;
  #onChange: () => void;
  #layers: WindowLayerManager;
  #devtools: DevToolsHost;
  #options: EnvironmentManagerOptions;
  #viewVisible = true;
  #presets = new Map<string, ViewportPresetId>();

  constructor(store: Store, window: BrowserWindow, onChange: () => void, options: EnvironmentManagerOptions = {}) {
    this.#store = store;
    this.#window = window;
    this.#onChange = onChange;
    this.#options = options;
    this.#layers = options.layers ?? new WindowLayerManager(window);
    this.#devtools = new DevToolsHost(this.#layers, () => this.#syncAfterDevToolsChange());
    // 遥测也落在同一个库上（console / network 摘要）
    this.#telemetry = new Telemetry(store.database);
    for (const id of store.runningSnapshot().dormant ?? []) {
      if (store.configFor(id)) this.#dormant.add(id);
    }
    if (this.#idleMs > 0) {
      this.#sweepTimer = setInterval(() => this.#sweepIdle(), DORMANT_SWEEP_MS);
      this.#sweepTimer.unref?.();
    }
  }

  #activeSpaceOf(id: string): SpaceId {
    return this.#spaces.get(id)?.active ?? 'person';
  }

  #spaceManager(id: string, space?: SpaceId): TabManager | undefined {
    const spaces = this.#spaces.get(id);
    if (!spaces) return undefined;
    return spaces[space ?? spaces.active];
  }

  #spaceOwner(id: string, space: SpaceId): ControlOwner {
    if (space === 'person') return 'human';
    const lease = this.#leases.get(id);
    return lease && lease.expiresAt > Date.now() && lease.space === 'agent' ? lease.owner : 'none';
  }

  #spaceStates(id: string): EnvironmentSpace[] {
    const spaces = this.#spaces.get(id);
    if (!spaces) return [];
    return SPACE_IDS.map((space) => {
      const manager = spaces[space];
      return {
        id: space,
        label: spaceLabel(space),
        owner: this.#spaceOwner(id, space),
        tabs: manager.list(),
        activeTabId: manager.activeId,
      };
    });
  }

  /** 只切「当前显示哪个 Space」，不等于获取控制权。 */
  selectSpace(id: string, space: SpaceId): void {
    const spaces = this.#spaces.get(id);
    if (!spaces) {
      throw Object.assign(new Error(`environment ${id} is not running`), { code: 'ENV_NOT_RUNNING' });
    }
    if (!SPACE_IDS.includes(space)) {
      throw Object.assign(new Error(`unknown space ${String(space)}`), { code: 'BAD_REQUEST' });
    }
    if (spaces.active === space) return;
    this.#touch(id);
    if (this.#selected === id) spaces[spaces.active].detach();
    spaces.active = space;
    if (this.#selected === id) {
      this.#devtools.activateTab(spaces[space].activeId);
      const split = this.#devtools.computeSplitBounds();
      spaces[space].attach();
      spaces[space].setViewVisible(this.#viewVisible);
      spaces[space].setViewport(split.page);
      this.#layers.setVisible('devtools', this.#viewVisible && this.#devtools.isOpen());
      this.#syncShield(id);
    }
    this.#onChange();
  }

  setViewport(viewport: ViewportRect): void {
    /*
     * 0 尺寸的报告一律忽略。
     *
     * 渲染层是在 ResizeObserver 里量占位区再报过来的，布局过渡（收起面板、切插件页、
     * 窗口被遮挡）那一帧能量到 0×0。真按它设下去，原生视图就变成 0×0，之后**所有输入
     * 事件都被丢掉**——修之前表现为输入类命令挂到 RPC 60s 超时，实测过一次
     * `viewport=0×0` 而 DOM 里占位区其实好好的 1124×790（渲染层之后再没报过，因为尺寸没再变）。
     * 窗口 minWidth 1024，内容区不可能合法地为 0，所以「留着上一次的好值」永远比「设成 0」对。
     */
    if (viewport.width <= 0 || viewport.height <= 0) return;
    this.#viewport = viewport;
    this.#devtools.setViewport(viewport);
    const split = this.#devtools.computeSplitBounds();
    if (this.#selected) this.#spaceManager(this.#selected)?.setViewport(split.page);
    const shield = this.#selected ? this.#shields.get(this.#selected) : undefined;
    if (shield?.attached) shield.setBounds(split.page);
  }

  /** 窗口被拖到屏幕外 / 上次离屏恢复失败时，把工作区拉回主屏可见范围。 */
  #ensureOnScreen(): void {
    const bounds = this.#window.getBounds();
    const area = screen.getPrimaryDisplay().workArea;
    const visible =
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y;
    if (visible) return;
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    this.#window.setBounds({
      x: area.x + Math.max(0, Math.round((area.width - width) / 2)),
      y: area.y + Math.max(0, Math.round((area.height - height) / 2)),
      width,
      height,
    });
  }

  /**
   * 页面当前画面。渲染层在让开原生视图之前取这一帧垫在占位区。
   *
   * 用 JPEG 不用 PNG：这块图只当背景，页面尺寸下 PNG 会到 MB 级。
   */
  async capturePage(): Promise<string | null> {
    const wc = this.#selected ? this.#spaceManager(this.#selected)?.active()?.webContents : undefined;
    if (!wc || wc.isDestroyed()) return null;
    const image = await wc.capturePage();
    if (image.isEmpty()) return null;
    // 92：这块图要铺满页面区当背板，80 的压缩痕在深色背景上一眼能看出来
    return `data:image/jpeg;base64,${image.toJPEG(92).toString('base64')}`;
  }

  /**
   * 让开 / 收回原生视图。
   *
   * 只应在全屏切换（设置页 / 插件独立页）时让开页面，普通弹窗与菜单不再隐藏视图。
   */
  setViewVisible(visible: boolean): void {
    this.#viewVisible = visible;
    if (this.#selected) {
      this.#spaceManager(this.#selected)?.setViewVisible(visible);
      this.#shields.get(this.#selected)?.setVisible(visible);
    }
    this.#layers.setVisible('devtools', visible && this.#devtools.isOpen());
  }

  /** 打开该环境当前标签的 Chrome DevTools（支持 right / bottom / detach 停靠）。 */
  openDevTools(id: string, space: SpaceId = 'agent', dock?: DevToolsDockMode): void {
    if (space === 'agent') {
      const lease = this.#leases.get(id);
      if (lease && lease.space === 'agent' && lease.owner === 'agent' && lease.expiresAt > Date.now()) {
        throw Object.assign(new Error(`ENV_BUSY: Agent 正在操作 ${id}，请先接管控制权再打开开发者工具`), {
          code: 'ENV_BUSY',
        });
      }
    }
    const tab = this.#spaceManager(id, space)?.active();
    const wc = tab?.webContents;
    if (!tab || !wc || wc.isDestroyed()) return;
    if (this.#selected !== id) this.select(id, space);
    else if (this.#activeSpaceOf(id) !== space) this.selectSpace(id, space);
    this.#devtools.openForTab(tab.id, wc, dock);
    this.#reapplySplitBounds(id);
  }

  closeDevTools(id: string, space: SpaceId = 'agent'): void {
    const tab = this.#spaceManager(id, space)?.active();
    if (!tab) return;
    this.#devtools.closeForTab(tab.id);
    this.#reapplySplitBounds(id);
  }

  inspectAt(id: string, space: SpaceId, x: number, y: number): void {
    if (space === 'agent') {
      const lease = this.#leases.get(id);
      if (lease && lease.space === 'agent' && lease.owner === 'agent' && lease.expiresAt > Date.now()) {
        throw Object.assign(new Error(`ENV_BUSY: Agent 正在操作 ${id}，请先接管控制权再检查元素`), {
          code: 'ENV_BUSY',
        });
      }
    }
    const tab = this.#spaceManager(id, space)?.active();
    const wc = tab?.webContents;
    if (!tab || !wc || wc.isDestroyed()) return;
    if (this.#selected !== id) this.select(id, space);
    else if (this.#activeSpaceOf(id) !== space) this.selectSpace(id, space);
    this.#devtools.inspectAt(tab.id, wc, x, y);
    this.#reapplySplitBounds(id);
  }

  setDevToolsDock(dock: DevToolsDockMode, size?: number): void {
    this.#devtools.setDockConfig(dock, size);
    if (this.#selected) this.#reapplySplitBounds(this.#selected);
  }

  getDevToolsState(): { open: boolean; dock: DevToolsDockMode; size: number } {
    return this.#devtools.state();
  }

  findInPage(id: string, space: SpaceId, text: string, options: { forward?: boolean; findNext?: boolean } = {}): void {
    const wc = this.#spaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const trimmed = text;
    if (!trimmed) {
      wc.stopFindInPage('clearSelection');
      this.#options.onFindResult?.({ envId: id, requestId: 0, activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
      return;
    }
    wc.findInPage(trimmed, {
      forward: options.forward ?? true,
      findNext: options.findNext ?? false,
    });
  }

  stopFindInPage(id: string, space: SpaceId): void {
    const wc = this.#spaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.stopFindInPage('clearSelection');
  }

  setZoom(id: string, space: SpaceId, mode: 'in' | 'out' | 'reset' | number): { factor: number } {
    const wc = this.#spaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return { factor: 1 };
    const current = wc.getZoomFactor() || 1;
    let next = current;
    if (mode === 'reset') next = 1;
    else if (mode === 'in') next = Math.min(3, Math.round((current + 0.1) * 100) / 100);
    else if (mode === 'out') next = Math.max(0.5, Math.round((current - 0.1) * 100) / 100);
    else if (typeof mode === 'number' && Number.isFinite(mode)) {
      next = Math.max(0.25, Math.min(5, Math.round(mode * 100) / 100));
    }
    wc.setZoomFactor(next);
    const origin = this.#originOf(wc.getURL());
    if (origin) this.#store.setDomainPref(id, origin, { zoomFactor: next });
    this.#onChange();
    return { factor: next };
  }

  getZoom(id: string, space: SpaceId): { factor: number } {
    const wc = this.#spaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return { factor: 1 };
    return { factor: Math.round((wc.getZoomFactor() || 1) * 100) / 100 };
  }

  async setViewportPreset(id: string, space: SpaceId, preset: ViewportPresetId): Promise<{ preset: ViewportPresetId }> {
    const tabs = this.#spaceManager(id, space);
    const controller = tabs?.controller();
    const wc = tabs?.active()?.webContents;
    if (!controller || !wc || wc.isDestroyed()) {
      throw Object.assign(new Error(`environment ${id} active tab is not ready`), { code: 'ENV_NOT_RUNNING' });
    }
    await controller.setViewportPreset(preset);
    this.#presets.set(`${id}:${space}`, preset);
    const origin = this.#originOf(wc.getURL());
    if (origin) this.#store.setDomainPref(id, origin, { viewportPreset: preset === 'auto' ? null : preset });
    this.#onChange();
    return { preset };
  }

  getViewportPreset(id: string, space: SpaceId): { preset: ViewportPresetId } {
    const wc = this.#spaceManager(id, space)?.active()?.webContents;
    const origin = wc && !wc.isDestroyed() ? this.#originOf(wc.getURL()) : undefined;
    if (origin) {
      const saved = this.#store.domainPref(id, origin)?.viewportPreset;
      if (saved) return { preset: saved };
    }
    return { preset: this.#presets.get(`${id}:${space}`) ?? 'auto' };
  }

  downloads(id?: string): DownloadItemInfo[] {
    return listDownloads(id);
  }

  revealDownload(downloadId: string): void {
    const target = getDownloadPath(downloadId);
    if (target) shell.showItemInFolder(target);
  }

  printPage(id: string, space: SpaceId): void {
    const wc = this.#spaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.print();
  }

  async savePageAs(id: string, space: SpaceId): Promise<{ saved: boolean; path?: string }> {
    const wc = this.#spaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return { saved: false };
    const title = (wc.getTitle() || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 64);
    const result = await dialog.showSaveDialog(this.#window, {
      title: '将页面另存为',
      defaultPath: `${title}.html`,
      filters: [{ name: 'Webpage, Complete', extensions: ['html', 'htm'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await wc.savePage(result.filePath, 'HTMLComplete');
    return { saved: true, path: result.filePath };
  }

  #originOf(rawUrl: string): string | undefined {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
      return u.origin;
    } catch {
      return undefined;
    }
  }

  #syncAfterDevToolsChange(): void {
    if (this.#selected) this.#reapplySplitBounds(this.#selected);
    this.#onChange();
  }

  #reapplySplitBounds(id: string): void {
    if (this.#selected !== id) return;
    const split = this.#devtools.computeSplitBounds();
    this.#spaceManager(id)?.setViewport(split.page);
    const shield = this.#shields.get(id);
    if (shield?.attached) shield.setBounds(split.page);
  }

  consoleEntries(id: string): ConsoleEntry[] {
    return this.#telemetry.consoleEntries(id);
  }

  networkEntries(id: string): NetworkEntry[] {
    return this.#telemetry.networkEntries(id);
  }

  /*
   * ── 网络拦截 ──────────────────────────────────────────────────────
   * 实现搬去了 `net/ops.ts` 的 `EnvironmentNetOps`（那个文件带注入点，所以能单测）。
   * 这里只留**转发**：RPC 派发表和它的假 manager 都按 `manager.netXxx(...)` 调，
   * 保持这层薄门面比改一圈调用点划算。
   */
  netRules(id: string) {
    return this.#netOps.summary(id);
  }
  netHits(id: string, limit?: number) {
    return this.#netOps.hits(id, limit);
  }
  netAddRule(id: string, input: unknown, actor: 'agent' | 'human') {
    return this.#netOps.addRule(id, input, actor);
  }
  netPassthrough(
    id: string,
    input: { match: string; isRegex?: boolean; method?: string; forMs: number },
    actor: 'agent' | 'human',
  ) {
    return this.#netOps.passthrough(id, input, actor);
  }
  netSetRuleEnabled(id: string, ruleId: string, enabled: boolean, actor: 'agent' | 'human') {
    return this.#netOps.setRuleEnabled(id, ruleId, enabled, actor);
  }
  netRemoveRule(id: string, ruleId: string, actor: 'agent' | 'human') {
    return this.#netOps.removeRule(id, ruleId, actor);
  }
  netRecord(id: string, action: string, output: string | undefined, actor: 'agent' | 'human') {
    return this.#netOps.record(id, action, output, actor);
  }
  netReplay(id: string, action: string, file: string | undefined, offline: boolean, actor: 'agent' | 'human') {
    return this.#netOps.replay(id, action, file, offline, actor);
  }
  netBody(id: string, index: number) {
    return this.#netOps.body(id, index);
  }

  /** 返回窗口屏幕坐标（点），供外部按区域截图。不抢前台、不改可见性。 */
  focusWindow(): { x: number; y: number; width: number; height: number } {
    return this.#window.getBounds();
  }

  /** 后台常驻测试/托盘用：隐藏窗口但不销毁任何 WebContentsView。 */
  hideWindow(): void {
    this.#window.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  }

  /**
   * 后台常驻：窗口保持 visible（这样 Chromium 不会把页面当成 hidden 丢输入），
   * 但移到屏幕外并从 Mission Control / 任务栏隐藏。关闭窗口走这条，而不是 hide()。
   */
  backgroundWindow(): void {
    this.#ensureOnScreen();
    this.#backgroundBounds ??= this.#window.getBounds();
    // 关闭窗口时若 Warren 正好在前台，先把窗口焦点交还系统；仅 showInactive 不会主动失焦。
    this.#window.blur();
    this.#window.setSkipTaskbar(true);
    if (process.platform === 'darwin') this.#window.setHiddenInMissionControl(true);
    this.#window.setPosition(-10000, -10000);
    this.#window.setOpacity(0);
    this.#window.setIgnoreMouseEvents(true);
    this.#window.showInactive();
    if (process.platform === 'darwin') app.dock?.hide();
  }

  /**
   * 恢复窗口。默认用 `showInactive()`，不抢用户当前前台应用；
   * 只有托盘点击 / 用户主动启动应用才传 `focus=true`。
   */
  showWindow(focus = false): void {
    if (this.#backgroundBounds) {
      this.#window.setBounds(this.#backgroundBounds);
      this.#backgroundBounds = undefined;
    }
    this.#window.setSkipTaskbar(false);
    if (process.platform === 'darwin') this.#window.setHiddenInMissionControl(false);
    this.#window.setOpacity(1);
    this.#window.setIgnoreMouseEvents(false);
    this.#ensureOnScreen();
    if (focus) {
      if (process.platform === 'darwin') app.dock?.show();
      this.#window.show();
      this.#window.focus();
      this.focusDisplayedPage();
    } else {
      this.#window.showInactive();
      this.#window.blur();
    }
    this.#onChange();
  }

  /**
   * 把 **document 焦点**交给正在显示的那个环境的页面。
   *
   * 为什么需要：**窗口拿到 OS 焦点 ≠ 页面拿到 document 焦点**。Electron 的窗口焦点落在
   * shell 的渲染层上，环境页（`WebContentsView`）的 `document.hasFocus()` 一直是 false。
   * 实测（`scripts/verify/batch1-focus.mjs`）：前台 true → 失焦 false → **拉回前台仍是 false**，
   * 也就是说用户 alt-tab 一次之后，真实站点里常见的 `if (!document.hasFocus()) return`
   * 守卫（编辑器、拖拽库、canvas 应用）会**永久**拦掉 agent 的点击。
   *
   * 传了 `id` 且它不是当前显示的环境就**不动** —— 后台环境不能抢焦点，
   * 那是「agent 并行操作后台环境」这条设计的前提（见 `ensureOperable`）。
   */
  focusDisplayedPage(id?: string): void {
    if (id && id !== this.#selected) return;
    const selected = this.#selected;
    if (!selected) return;
    const tabs = this.#spaceManager(selected);
    const wc = tabs?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (this.#window.isFocused()) wc.focus();
    else
      void tabs
        ?.controller()
        ?.emulateFocus()
        .catch(() => {});
  }

  /**
   * 输入前准备 document 焦点。
   *
   * 窗口在前台且操作的就是当前显示页时才走真实 focus；其余情况一律用 CDP 焦点仿真，
   * 避免后台 agent 操作把 Warren 抢到用户前台。
   */
  async focusForInput(id: string, space: SpaceId = 'agent'): Promise<void> {
    const tabs = this.#spaceManager(id, space);
    const controller = tabs?.controller();
    if (!controller || !tabs?.active()) return;
    if (this.#window.isFocused() && id === this.#selected && space === this.#activeSpaceOf(id)) {
      controller.webContents.focus();
      return;
    }
    await controller.emulateFocus().catch(() => {});
  }

  /**
   * 后台视图刚附到底层时，renderer 可能还没拿到布局尺寸（innerWidth/Height = 0）。
   * 给一次临时视口，动作完成后调用方负责清掉。
   */
  async prepareBackgroundInput(id: string, space: SpaceId = 'agent'): Promise<boolean> {
    const controller = this.#spaceManager(id, space)?.controller();
    if (!controller) return false;
    const size = (await controller.evaluate('({ width: innerWidth, height: innerHeight })').catch(() => null)) as {
      width?: number;
      height?: number;
    } | null;
    if ((size?.width ?? 0) > 0 && (size?.height ?? 0) > 0) return false;
    await controller
      .emulateViewport(Math.max(1, this.#viewport.width), Math.max(1, this.#viewport.height))
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    return true;
  }

  async clearBackgroundInput(id: string, space: SpaceId = 'agent'): Promise<void> {
    await this.#spaceManager(id, space)
      ?.controller()
      ?.clearEmulatedViewport()
      .catch(() => {});
  }

  /**
   * 在渲染层里求值一段 JS，用于程序化验证界面结构。
   *
   * 界面是 DOM，但 agent 看不到它（页面主体是原生 WebContentsView，不参与 DOM）。
   * 没有这个通道，「改完界面对不对」只能靠人眼看，agent 无法自证。
   * 仅用于诊断，不要用它绕过 IPC 去改状态。
   */
  evalInRenderer<T = unknown>(script: string): Promise<T> {
    return this.#window.webContents.executeJavaScript(script, true) as Promise<T>;
  }

  /**
   * 把一条浏览器快捷键按「菜单加速键」的方式送给渲染层。
   *
   * 生产路径是应用菜单的 `click`（见 `main.ts` 的 `installMenu`）。这条通道给
   * `debug.shortcut` 用：本机没开「辅助功能」权限时脚本发不出真按键（osascript 报
   * 「不允许发送按键」），只能这样验证「快捷键 → 界面动作」这半段。
   */
  sendShortcut(shortcut: BrowserShortcut): void {
    this.#window.webContents.send('browser:shortcut', shortcut);
  }

  /** 诊断用：Agent 定位不到元素时，先看视图几何和页面尺寸 */
  layout(): {
    viewport: ViewportRect;
    selected?: string;
    viewBounds?: unknown;
    /**
     * 当前有页面视图挂在窗口上的环境。最多一个，且只会是 selected——
     * 但 selected 的环境**没跑**时这里是空的（选中不等于有视图）。
     */
    showing: string[];
    /**
     * 此刻**临时**挂在窗口最底层的环境（`ensureOperable`）：agent 正在操作一个后台环境，
     * 它的视图临时挂上来了——不抢显示，但让 Chromium 认为它 visible，输入才落得进去。
     */
    attachedBelow: string[];
    /**
     * 此刻键盘落在哪个环境的页面上（webContents 焦点）。
     *
     * 存在的理由：把后台视图临时挂到最底层会**抢走 webContents 焦点**（实测），
     * 所以 `ensureOperable` 挂完必须马上把焦点还给显示中的那个。人打字打到看不见的页面上
     * 是泄露级别的 bug，这个字段让「焦点到底在哪」可查。
     */
    focusedEnv?: string;
    /**
     * 应用窗口是不是前台窗口。**只用于观测，不再拦输入。**
     *
     * 以前输入类命令靠它判 `WINDOW_NOT_FOCUSED`，2026-10-17 实测推翻了那个前提
     * （失焦时输入照样落地）。现在它只用来诊断「为什么用户看不到页面」这类问题。
     */
    windowFocused: boolean;
    windowVisible: boolean;
    windowBounds: { x: number; y: number; width: number; height: number };
    windowOpacity: number;
    /** 遥测写库的累计条数与毫秒（每条请求/日志一把同步 INSERT，量它才知道有没有拖慢页面）。 */
    telemetryWrite: { writes: number; ms: number };
    /** 页面视图此刻画没画出来。渲染层有浮层压到页面区域时会临时变 false。 */
    viewVisible: boolean;
    /** 当前标签的 DevTools 开着没。 */
    devToolsOpen: boolean;
    /**
     * 活着的 webContents 总数（含 shell 窗口）。
     *
     * 关标签之后它必须跟着减：页面用 `beforeunload` 拦住卸载时，标签表已经把标签摘掉了，
     * 而那个 webContents 还活着——**只有这个数看得出来**（实测踩过，见 HANDOFF）。
     */
    webContents: number;
    /** 正在运行的环境数 / 上限（上限 0 = 不限）。LRU 回收的判据。 */
    running: number;
    maxRunning: number;
    shieldAttached: boolean;
    owner: ControlOwner;
    activeSpace?: SpaceId;
    spaces: Array<{ envId: string; space: SpaceId; showing: boolean; attachedBelow: boolean }>;
  } {
    const tabs = this.#selected ? this.#spaceManager(this.#selected) : undefined;
    const shield = this.#selected ? this.#shields.get(this.#selected) : undefined;
    const lease = this.#selected ? this.#leases.get(this.#selected) : undefined;
    const allSpaces = [...this.#spaces.entries()].flatMap(([envId, spaces]) =>
      SPACE_IDS.map((space) => ({
        envId,
        space,
        showing: spaces[space].showing,
        attachedBelow: spaces[space].attachedBelow,
      })),
    );
    return {
      viewport: this.#viewport,
      selected: this.#selected,
      viewBounds: tabs?.active()?.view.getBounds(),
      showing: [...new Set(allSpaces.filter((item) => item.showing).map((item) => item.envId))],
      attachedBelow: [...new Set(allSpaces.filter((item) => item.attachedBelow).map((item) => item.envId))],
      // 窗口失焦时 active webContents 的 isFocused() 可能为 false；用当前显示的环境兜底，
      // 便于回归判断“后台操作结束后焦点是否还给显示中的环境”。
      focusedEnv:
        allSpaces.find((item) => this.#spaces.get(item.envId)?.[item.space].active()?.webContents?.isFocused())
          ?.envId ?? (this.#selected && tabs?.showing ? this.#selected : undefined),
      windowFocused: this.#window.isFocused(),
      windowVisible: this.#window.isVisible(),
      windowBounds: this.#window.getBounds(),
      windowOpacity: this.#window.getOpacity(),
      telemetryWrite: this.#telemetry.writeStats,
      viewVisible: tabs?.viewVisible ?? true,
      devToolsOpen: this.#devtools.isOpen() || (tabs?.devToolsOpen ?? false),
      webContents: webContents.getAllWebContents().length,
      running: this.#spaces.size,
      maxRunning: this.#maxRunning,
      shieldAttached: Boolean(shield?.attached),
      owner: lease && lease.expiresAt > Date.now() ? lease.owner : 'none',
      activeSpace: this.#selected ? this.#activeSpaceOf(this.#selected) : undefined,
      spaces: allSpaces,
    };
  }

  list(): Environment[] {
    return this.#store.list().map((env) => this.#decorate(env));
  }

  get(id: string): Environment | undefined {
    const env = this.#store.get(id);
    return env ? this.#decorate(env) : undefined;
  }

  #decorate(env: Environment): Environment {
    const lease = this.#leases.get(env.id);
    const spaces = this.#spaces.get(env.id);
    const activeSpaceId = spaces?.active ?? 'person';
    const tabs = spaces?.[activeSpaceId];
    const active = tabs?.active()?.state;
    const expired = lease ? lease.expiresAt <= Date.now() : false;
    if (lease && expired) this.#leases.delete(env.id);
    return {
      ...env,
      status: spaces ? 'running' : this.#dormant.has(env.id) ? 'dormant' : 'stopped',
      owner: lease && !expired ? lease.owner : 'none',
      leaseId: lease && !expired ? lease.leaseId : undefined,
      leaseExpiresAt: lease && !expired ? lease.expiresAt : undefined,
      // currentUrl / title 语义收紧为「当前激活标签的」
      currentUrl: active?.url || env.currentUrl,
      title: active?.title || env.title,
      // 页面挂了但环境是「跑着」的（视图、标签都在），所以不改 status——那会让界面把
      // 停止按钮换成启动、遥测停止轮询。错误挂在**标签**上（tabs.ts 的 did-fail-load），
      // 环境从激活标签派生，导航成功时标签自己清掉。
      error: active?.error,
      tabs: tabs?.list(),
      activeTabId: tabs?.activeId,
      activeSpaceId,
      spaces: this.#spaceStates(env.id),
    };
  }

  async create(input: {
    id: string;
    name?: string;
    proxy?: string;
    startUrl?: string;
    headed?: boolean;
    createdBy?: Creator;
  }): Promise<Environment> {
    // 谁建的：走 CLI/RPC 的是 agent，走界面 IPC 的是人。审批策略要按这个判（计划 §3.3）
    const createdBy: Creator = input.createdBy ?? 'human';
    const created = await this.#store.create({ ...input, createdBy });
    this.#store.record(makeEvent('environment.created', `environment ${created.id} created`, createdBy, created.id));
    this.#onChange();
    return this.#decorate(created);
  }

  async remove(id: string): Promise<void> {
    const config = this.#store.configFor(id);
    this.stop(id);
    this.#dormant.delete(id);
    // 环境没了，选中态不能继续指着它——否则会留下一个指向不存在环境的幽灵选中态
    // （实测：`env remove` 后 `debug.layout` 的 selected 仍是那个 id）
    if (this.#selected === id) this.#selected = undefined;
    // 规则随环境一起清：留着会跟着 id 复用的新环境复活，跨环境泄漏
    this.#netOps.drop(id);
    // 标签快照同理（库里的行由 store.remove 删）
    this.#tabSnapshot.delete(id);
    // Session 对象不能从缓存里删：Electron 对同一个 storagePath 返回同一个 Session，
    // 删掉再 fromPath 会二次注册 warren protocol（实测 Failed to register protocol）。
    // 但同名重建不能带回旧登录态，所以删目录前先把这份 Session 的存储数据清掉。
    const ses = this.#sessions.get(id);
    if (ses) {
      try {
        await ses.clearStorageData();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#store.record(
          makeEvent('environment.removeFailed', `environment ${id} clear storage failed: ${message}`, 'system', id),
        );
        throw Object.assign(new Error(`environment ${id} clear storage failed: ${message}`), {
          code: 'ENV_REMOVE_FAILED',
        });
      }
    }
    await this.#store.remove(id);
    if (config) {
      try {
        await rm(config.storagePath, { recursive: true, force: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#store.record(
          makeEvent('environment.removeFailed', `environment ${id} remove failed: ${message}`, 'system', id),
        );
        throw Object.assign(
          new Error(`environment ${id} removed, but failed to delete ${config.storagePath}: ${message}`),
          {
            code: 'ENV_REMOVE_FAILED',
          },
        );
      }
    }
    this.#store.record(makeEvent('environment.removed', `environment ${id} removed`, 'human', id));
    this.#onChange();
  }

  /**
   * 改名 / 换代理 / 换启动 URL。只改配置，不重启已运行的会话。
   *
   * 代理与 CA 的生效点在 `start()`；运行中的会话配置变了但 session 还没换代理，
   * 此时 `env doctor` 若只读配置会显示“ok”，这是假绿。调用方（Whistle bind）
   * 必须随后 stop/start，或者显式提示人重启环境。
   */
  async update(id: string, patch: EnvironmentPatch): Promise<Environment> {
    const updated = await this.#store.update(id, patch);
    this.#store.record(makeEvent('environment.updated', `environment ${id} updated`, 'human', id));
    this.#onChange();
    return this.#decorate(updated);
  }

  // ── 分组 ────────────────────────────────────────────────────────────
  // 分组只影响侧栏组织方式，不碰运行时。但改动要通知渲染层，
  // 所以走 manager 而不是让 rpc 直接操作 store。

  listGroups(): Group[] {
    return this.#store.listGroups();
  }

  async createGroup(input: { id?: string; name: string }): Promise<Group> {
    const group = await this.#store.createGroup(input);
    this.#store.record(makeEvent('group.created', `group ${group.name} created`, 'human'));
    this.#onChange();
    return group;
  }

  async renameGroup(id: string, name: string): Promise<Group> {
    const group = await this.#store.renameGroup(id, name);
    this.#store.record(makeEvent('group.renamed', `group ${id} renamed to ${group.name}`, 'human'));
    this.#onChange();
    return group;
  }

  async setGroupCollapsed(id: string, collapsed: boolean): Promise<Group> {
    const group = await this.#store.setGroupCollapsed(id, collapsed);
    this.#onChange();
    return group;
  }

  /** 删组保留环境：只把它们移出分组。返回被移出的数量。 */
  async removeGroup(id: string): Promise<{ detached: number }> {
    const result = await this.#store.removeGroup(id);
    this.#store.record(
      makeEvent('group.removed', `group ${id} removed, ${result.detached} environment(s) detached`, 'human'),
    );
    this.#onChange();
    return result;
  }

  async reorderGroups(orderedIds: string[]): Promise<void> {
    await this.#store.reorderGroups(orderedIds);
    this.#onChange();
  }

  async moveToGroup(environmentId: string, groupId: string | undefined): Promise<Environment> {
    const moved = await this.#store.moveToGroup(environmentId, groupId);
    this.#store.record(
      makeEvent(
        'environment.moved',
        `environment ${environmentId} moved to ${groupId ?? '未分组'}`,
        'human',
        environmentId,
      ),
    );
    this.#onChange();
    return this.#decorate(moved);
  }

  async reorderEnvironments(groupId: string | undefined, orderedIds: string[]): Promise<void> {
    await this.#store.reorderEnvironments(groupId, orderedIds);
    this.#onChange();
  }

  /**
   * 把这个环境装过的扩展挂到 session 上。
   *
   * `loadExtension` **每次启动都要重调**（Electron 不记住），所以放在 `start()` 里。
   * 单个扩展失败不能拖垮整个环境 —— 坏扩展只记一条事件。
   */
  async #loadExtensions(id: string, ses: Session, storagePath: string): Promise<void> {
    for (const ext of await listExtensions(storagePath)) {
      try {
        await ses.loadExtension(ext.dir);
      } catch (error) {
        this.#store.record(makeEvent('extension.loadFailed', `${ext.id}: ${(error as Error).message}`, 'system', id));
      }
    }
  }

  /** 该环境的存储目录（扩展放在它下面的 `extensions/`）。 */
  #storageOf(id: string): string {
    const config = this.#store.configFor(id);
    if (!config) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    return config.storagePath;
  }

  /** 该环境装了哪些扩展（目录名 + 磁盘路径）。 */
  async extensionsOf(id: string): Promise<{ id: string; dir: string }[]> {
    return listExtensions(this.#storageOf(id));
  }

  /** 装一个解包好的扩展；正在跑的环境**当场**生效，不用重启。 */
  async extensionAdd(id: string, srcDir: string, name?: string): Promise<{ id: string; dir: string }> {
    const storagePath = this.#storageOf(id);
    const added = await addExtension(storagePath, srcDir, name);
    const ses = this.#sessions.get(id);
    if (ses) {
      try {
        await ses.loadExtension(added.dir);
      } catch (error) {
        this.#store.record(makeEvent('extension.loadFailed', `${added.id}: ${(error as Error).message}`, 'system', id));
      }
    }
    this.#onChange();
    return added;
  }

  /** 卸载：删目录。已经挂上的那个要等环境重启才真的消失（Electron 没有 unload 扩展的 API）。 */
  async extensionRemove(id: string, name: string): Promise<{ removed: boolean }> {
    const storagePath = this.#storageOf(id);
    const removed = await removeExtension(storagePath, name);
    this.#onChange();
    return { removed };
  }

  #sessionFor(id: string, storagePath: string): Session {
    const existing = this.#sessions.get(id);
    if (existing) return existing;
    const created = session.fromPath(storagePath);
    created.setUserAgent(chromeUserAgent(created.getUserAgent()));
    /*
     * 内置页面（`warren://newtab`）挂**每环境自己的 session**。
     *
     * 不能挂在 `electron.protocol` 上：那一个只作用于默认 session，而页面跑在环境
     * session 里（实测症状：`loadURL` 报 `ERR_FAILED (-2)`，标签一片空白）。
     * `warren-plugin://` 没踩到这条是因为渲染层在默认 session 里。
     */
    created.protocol.handle('warren', (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'newtab') return new Response('not found', { status: 404 });
      return new Response(newTabPage(this.#store.get(id)), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    });
    this.#sessions.set(id, created);
    return created;
  }

  /**
   * 给这个环境的 Session 装证书校验钩子 —— **全项目唯一的证书放宽点**。
   *
   * 只放行「由 `trustedCa` 那张 CA 签发」的叶子证书，不是无脑 `callback(0)`：
   * 钩子一装，这个 session 的每一张证书都要过它，写成无脑放行等于关掉整个环境的证书校验。
   * CA 读不出来时**不装**（回到 Chromium 默认校验）并记一条事件，不静默放行。
   *
   * 用途见 docs/WHISTLE-PLUGIN-PLAN.md §3.3：代理做 HTTPS 中间人时页面会直接
   * `ERR_CERT_AUTHORITY_INVALID`，靠这张 CA 放行。
   */
  #applyTrustedCa(id: string, ses: Session, pemPath: string | undefined): ReturnType<typeof parseCa> {
    if (!pemPath) {
      ses.setCertificateVerifyProc(null);
      return undefined;
    }
    let ca: ReturnType<typeof parseCa>;
    try {
      ca = parseCa(readFileSync(pemPath, 'utf8'));
    } catch {
      ca = undefined;
    }
    if (!ca) {
      ses.setCertificateVerifyProc(null);
      this.#store.record(
        makeEvent('environment.trustedCaUnreadable', `trustedCa 读不出来，已回到默认校验: ${pemPath}`, 'system', id),
      );
      return undefined;
    }
    ses.setCertificateVerifyProc((request, callback) => {
      // -2 = 拒绝（Electron 文档：callback(0) 接受、callback(-2) 拒绝）
      callback(leafSignedByCa(request.certificate.data, ca) ? 0 : -2);
    });
    return ca;
  }

  // ── Cookie 受控通道（只搬运不返回，见 docs/PLUGIN-CAPABILITY-DESIGN.md §9）──
  // Session 对象不外泄：插件侧只拿得到 summarize 过的元数据与计数。

  /** 列 cookie 元数据（没有值）。环境没在跑也能查——cookie 存在 session 目录里。 */
  async cookieNames(id: string, url?: string): Promise<CookieSummary[]> {
    return listCookies(this.#sessionOf(id), url);
  }

  /** 环境 → 环境搬运。值在主进程内部从 from 读出来直接写进 to。 */
  async cookieCopy(from: string, to: string, filter: CookieFilter = {}): Promise<{ copied: number; names: string[] }> {
    if (from === to) {
      throw Object.assign(new Error('copy 的 from 和 to 不能是同一个环境'), {
        code: 'BAD_REQUEST',
      });
    }
    return copyCookies(this.#sessionOf(from), this.#sessionOf(to), filter);
  }

  async cookieImport(id: string, cookies: CookieInput[]): Promise<{ written: number; names: string[] }> {
    return importCookies(this.#sessionOf(id), cookies);
  }

  async cookieClear(id: string, filter: CookieFilter = {}): Promise<{ removed: number }> {
    return clearCookies(this.#sessionOf(id), filter);
  }

  /** 运行中或没运行的环境都要能拿到 session（cookie 是磁盘上的状态，不依赖页面）。 */
  #sessionOf(id: string): Session {
    const config = this.#store.configFor(id);
    if (!config) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    return this.#sessionFor(id, config.storagePath);
  }

  #createSpaceManager(
    id: string,
    space: SpaceId,
    ses: Session,
    trustedCa: ReturnType<typeof parseCa>,
    pending: EnvPending,
  ): TabManager {
    return new TabManager({
      envId: id,
      space,
      window: this.#window,
      layers: this.#layers,
      session: ses,
      trustedCa,
      onChanged: () => {
        this.#onChange();
        this.#rememberTabs(id);
      },
      onViewChanged: () => {
        if (this.#selected === id && this.#activeSpaceOf(id) === space) {
          this.#devtools.activateTab(this.#spaceManager(id, space)?.activeId);
          this.#reapplySplitBounds(id);
          this.#syncShield(id);
        }
      },
      onEmpty: () => this.#onSpaceEmpty(id, space),
      onEvent: (type, message) => {
        this.#store.record(makeEvent(type, message, 'system', id));
        this.#onChange();
      },
      onPopup: (tabId, url) => {
        const index =
          (this.#spaces
            .get(id)
            ?.[space].list()
            .findIndex((tab) => tab.id === tabId) ?? -1) + 1;
        pending.notePopup({ tabId, index, url, at: new Date().toISOString() });
      },
      onUrlVisited: (url) => this.#store.recordUrlHistory(url),
      onOriginZoomNeeded: (tab, url) => {
        const origin = this.#originOf(url);
        if (!origin) return;
        const pref = this.#store.domainPref(id, origin);
        const wc = tab.webContents;
        if (!wc || wc.isDestroyed()) return;
        if (pref && Math.abs(pref.zoomFactor - 1) > 0.001) {
          wc.setZoomFactor(pref.zoomFactor);
        }
      },
      onTargetUrl: (url) => {
        if (this.#selected === id && this.#activeSpaceOf(id) === space) {
          this.#options.onTargetUrl?.({ envId: id, url });
        }
      },
      onFoundInPage: (result) => {
        this.#options.onFindResult?.({
          envId: id,
          requestId: result.requestId,
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches,
          finalUpdate: result.finalUpdate,
        });
      },
      onContextMenu: (tab, params) => {
        void this.#handlePageContextMenu(id, space, tab, params);
      },
      createController: (tabId, webContents) => {
        try {
          this.#telemetry.attachTab(id, tabId, webContents);
        } catch {
          // 遥测挂不上不能影响环境启动
        }
        const controller = new BrowserController(webContents, {
          envId: id,
          tabId,
          tabIndex: () =>
            this.#spaces
              .get(id)
              ?.[space].list()
              .findIndex((tab) => tab.id === tabId) ?? -1,
          pending: pending.sinkFor(webContents),
          lastActivityAt: () => this.#telemetry.lastActivityAt(tabId),
          downloadById: (downloadId) => pending.downloadById(downloadId),
          record: (type, message) => {
            this.#store.record(makeEvent(type, message, 'agent', id));
          },
        });
        controller.attach();
        return controller;
      },
      onTabDestroyed: (tabId) => {
        this.#telemetry.detachTab(tabId);
        this.#devtools.closeForTab(tabId);
      },
    });
  }

  async #handlePageContextMenu(
    id: string,
    space: SpaceId,
    tab: Tab,
    params: Electron.ContextMenuParams,
  ): Promise<void> {
    const wc = tab.webContents;
    if (!wc || wc.isDestroyed()) return;
    const lease = this.#leases.get(id);
    const canNavigate =
      space === 'person' ||
      Boolean(lease && lease.space === 'agent' && lease.owner === 'human' && lease.expiresAt > Date.now());
    const history = wc.navigationHistory;
    const items = buildPageContextMenu({
      x: params.x,
      y: params.y,
      pageURL: params.pageURL || wc.getURL(),
      linkURL: params.linkURL,
      srcURL: params.srcURL,
      mediaType: params.mediaType,
      selectionText: params.selectionText,
      isEditable: params.isEditable,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      canNavigate,
      editFlags: params.editFlags,
    });
    const picked = await popupNativeMenu(this.#window, items);
    if (!picked || wc.isDestroyed()) return;
    switch (picked) {
      case 'link:openTab':
        if (canNavigate && params.linkURL) this.newTab(id, params.linkURL, { activate: true }, space);
        break;
      case 'link:copy':
        if (params.linkURL) clipboard.writeText(params.linkURL);
        break;
      case 'image:openTab':
        if (canNavigate && params.srcURL) this.newTab(id, params.srcURL, { activate: true }, space);
        break;
      case 'image:copy':
        wc.copyImageAt(params.x, params.y);
        break;
      case 'image:copyUrl':
        if (params.srcURL) clipboard.writeText(params.srcURL);
        break;
      case 'image:saveAs':
        if (params.srcURL) wc.downloadURL(params.srcURL);
        break;
      case 'edit:undo':
        wc.undo();
        break;
      case 'edit:redo':
        wc.redo();
        break;
      case 'edit:cut':
        wc.cut();
        break;
      case 'edit:copy':
        wc.copy();
        break;
      case 'edit:paste':
        wc.paste();
        break;
      case 'edit:selectAll':
        wc.selectAll();
        break;
      case 'nav:back':
        if (canNavigate) this.humanNavigate(id, { kind: 'back' }, space);
        break;
      case 'nav:forward':
        if (canNavigate) this.humanNavigate(id, { kind: 'forward' }, space);
        break;
      case 'nav:reload':
        if (canNavigate) this.humanNavigate(id, { kind: 'reload' }, space);
        break;
      case 'nav:hardReload':
        if (canNavigate) this.humanNavigate(id, { kind: 'hardReload' }, space);
        break;
      case 'page:saveAs':
        await this.savePageAs(id, space);
        break;
      case 'page:print':
        this.printPage(id, space);
        break;
      case 'page:viewSource': {
        const url = params.pageURL || wc.getURL();
        if (canNavigate && url && !url.startsWith('view-source:')) {
          this.newTab(id, `view-source:${url}`, { activate: true }, space);
        }
        break;
      }
      case 'devtools:inspect':
        if (canNavigate) this.inspectAt(id, space, params.x, params.y);
        break;
      default:
        break;
    }
  }

  #onSpaceEmpty(id: string, space: SpaceId): void {
    if (this.#hibernating.has(id)) return;
    const spaces = this.#spaces.get(id);
    if (!spaces) return;
    if (spaces.person.size === 0 && spaces.agent.size === 0) {
      this.stop(id);
      return;
    }
    if (spaces.active === space) this.#onChange();
  }

  async start(id: string): Promise<Environment> {
    const config = this.#store.configFor(id);
    if (!config) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    if (this.#spaces.has(id)) return this.#decorate(toEnvironment(config));
    this.#dormant.delete(id);

    this.#evictFor(id);
    await mkdir(config.storagePath, { recursive: true });
    const ses = this.#sessionFor(id, config.storagePath);
    /*
     * **清掉代理也要显式设一次**。Session 是缓存的（`#sessions`），只在有代理时调
     * `setProxy` 的话，解绑之后这个 session 会**继续用上一次的代理**——配置里写着「直连」，
     * 流量还在走旧代理。实测：`env update --proxy=none` 之后重启环境，页面照样失败。
     */
    await ses.setProxy(config.proxy ? { proxyRules: config.proxy } : { mode: 'direct' });
    // 证书钩子要早于第一次导航：结果会被网络服务缓存，晚装就对已经验过的域名不生效
    const trustedCa = this.#applyTrustedCa(id, ses, config.trustedCa);
    // 拦截器要在第一个页面加载之前挂上：晚挂的请求会走真实网络
    this.#netOps.for(id).attach(ses);
    // 扩展也要在**第一个页面加载之前**装上，否则内容脚本注入不到首个页面
    await this.#loadExtensions(id, ses, config.storagePath);

    const first = this.#materialize(id, config, ses, trustedCa);
    if (first) await waitForLoad(first, 30_000);

    this.#store.record(makeEvent('environment.started', `environment ${id} started`, 'human', id));
    // headed=false：起了但不把人正在看的页面切走（批量拉起环境时界面不该被刷来刷去）
    if (config.headed) this.select(id);
    this.#rememberRunning();
    this.#onChange();
    return this.#decorate(toEnvironment(config));
  }

  /**
   * 按标签快照建出真正的 WebContentsView。同步：透明唤醒要塞进所有同步 RPC 入口，
   * 不能把 120 个 case 都改成 await。session / 代理 / 扩展由调用方先准备好。
   */
  #materialize(
    id: string,
    config: EnvironmentConfig,
    ses: Session,
    trustedCa: ReturnType<typeof parseCa>,
  ): Tab | undefined {
    const pending = new EnvPending();
    this.#pending.set(id, pending);
    wireDownloads(
      ses,
      id,
      (envId) => this.#pending.get(envId),
      (type, message) => this.#store.record(makeEvent(type, message, 'system', id)),
      () => this.#options.onDownloadsChanged?.(),
    );

    const spaces: EnvironmentSpaces = {
      person: this.#createSpaceManager(id, 'person', ses, trustedCa, pending),
      agent: this.#createSpaceManager(id, 'agent', ses, trustedCa, pending),
      active: 'person',
    };
    this.#spaces.set(id, spaces);
    this.#telemetry.attachSession(ses);

    /*
     * 上次那一组标签开回来。
     *
     * 只有 URL 和「哪个是激活的」——标题、图标、滚动位置都跟着页面重新加载，
     * **POST 过的页面恢复不了**（浏览器本来就这样）。没有记录时才退回 startUrl / 新标签页。
     */
    const remembered = this.#store.tabsFor(id).filter((tab) => tab.url);
    let first: Tab | undefined;
    for (const space of SPACE_IDS) {
      const list = remembered.filter((tab) => tab.space === space);
      if (!list.length) continue;
      const activeIndex = Math.max(
        0,
        list.findIndex((tab) => tab.active),
      );
      for (let index = 0; index < list.length; index += 1) {
        const tab = spaces[space].create({ url: list[index].url, activate: index === activeIndex });
        first ??= tab;
      }
    }
    // Person Space 始终至少有一个入口；Agent Space 则等 agent 第一次操作时再懒建。
    if (spaces.person.size === 0) {
      first = spaces.person.create({ url: config.startUrl ?? newTabUrl(id) });
    }
    return first;
  }

  stop(id: string): void {
    this.#dormant.delete(id);
    const spaces = this.#spaces.get(id);
    if (!spaces) {
      this.#rememberRunning();
      this.#onChange();
      return;
    }

    // 停之前记最后一笔：`env stop` → `env start` 要把这一组标签开回来
    this.#rememberTabs(id, { force: true });
    this.#tabSnapshot.delete(id);

    // 先摘网络拦截：session 之后可能被复用，留着 handler 会继续拦真实请求
    this.#netOps.detach(id);

    if (this.#selected === id) {
      spaces[spaces.active].detach();
      // 选中态**保留**：环境还在，只是没跑。丢掉的话界面会说「未选择环境」，
      // 用户分不清是「没选」还是「刚停掉的这个」；保留才显示得出「环境未启动」。
    }
    spaces.person.destroy();
    spaces.agent.destroy();
    this.#closeEnvDevTools(spaces);
    this.#spaces.delete(id);
    // 环境都停了，lease 没有意义了；留着会让下一次操作白等一个 TTL
    this.#leases.delete(id);

    this.#shields.get(id)?.detach(this.#window);
    this.#shields.get(id)?.destroy();
    this.#shields.delete(id);

    // 临时下载区只活到环境停止（`saveAs` 必须在本脚本内调用）
    this.#pending.delete(id);
    rmSync(path.join(os.tmpdir(), 'warren-downloads', safeEnvKey(id)), { recursive: true, force: true });

    const ses = this.#sessions.get(id);
    if (ses) this.#telemetry.detachSession(ses);
    this.#telemetry.clear(id);

    this.#store.record(makeEvent('environment.stopped', `environment ${id} stopped`, 'human', id));
    // 停掉 = 不再「运行中」。正常退出走的就是这条路（`shutdown()` 逐个 stop），
    // 所以下次启动不会把用户主动关掉的环境又拉起来。
    this.#rememberRunning();
    this.#onChange();
  }

  /**
   * 休眠：把页面与 renderer 进程放掉，但保留 session（登录态 / 代理 / CA）、配置、
   * 标签快照与运行态。下次任何一次「用到这个环境」都由 `wake()` 透明复活。
   *
   * 这里**不调 `stop()`**：stop 是人的语义（主动停、不再自动拉起），休眠不是。
   */
  hibernate(id: string, reason = 'manual'): boolean {
    const spaces = this.#spaces.get(id);
    if (!spaces || this.#dormant.has(id)) return false;
    if (this.#selected === id) return false;
    if (this.#hasLiveLease(id)) return false;

    this.#rememberTabs(id, { force: true });
    this.#tabSnapshot.delete(id);
    this.#netOps.detach(id);

    this.#hibernating.add(id);
    if (this.#selected === id) spaces[spaces.active].detach();
    spaces.person.destroy();
    spaces.agent.destroy();
    this.#closeEnvDevTools(spaces);
    this.#hibernating.delete(id);
    this.#spaces.delete(id);
    this.#leases.delete(id);

    this.#shields.get(id)?.detach(this.#window);
    this.#shields.get(id)?.destroy();
    this.#shields.delete(id);
    this.#pending.delete(id);
    rmSync(path.join(os.tmpdir(), 'warren-downloads', safeEnvKey(id)), { recursive: true, force: true });

    const ses = this.#sessions.get(id);
    if (ses) this.#telemetry.detachSession(ses);
    this.#telemetry.clear(id);

    this.#dormant.add(id);
    this.#store.record(makeEvent('env.dormant', `${id} 进入休眠（${reason}）`, 'system', id));
    this.#rememberRunning();
    this.#onChange();
    return true;
  }

  /**
   * 透明唤醒：同步按标签快照把视图建回来。session / 代理 / 扩展在休眠前后都没动过，
   * 所以不需要再 await 一遍；页面会重新加载，JS 状态与未提交表单不保留。
   */
  wake(id: string): boolean {
    if (!this.#dormant.has(id) || this.#spaces.has(id)) return false;
    const config = this.#store.configFor(id);
    if (!config) {
      this.#dormant.delete(id);
      return false;
    }
    const ses = this.#sessionFor(id, config.storagePath);
    const trustedCa = config.trustedCa ? parseCa(readFileSync(config.trustedCa, 'utf8')) : undefined;
    this.#netOps.for(id).attach(ses);
    this.#waking.add(id);
    this.#materialize(id, config, ses, trustedCa);
    this.#waking.delete(id);
    this.#tabSnapshot.delete(id);
    this.#dormant.delete(id);
    this.#touch(id);
    this.#store.record(makeEvent('env.woken', `${id} 从休眠唤醒`, 'system', id));
    this.#rememberRunning();
    this.#onChange();
    return true;
  }

  /** 供 RPC 层判断「要不要先唤醒」；纯读命令不该把休眠环境拉起来。 */
  isDormant(id: string): boolean {
    return this.#dormant.has(id);
  }

  /** 定时扫描：闲置到点且没在被用的环境进休眠。 */
  #sweepIdle(): void {
    if (this.#idleMs <= 0) return;
    const now = Date.now();
    const candidates = [...this.#spaces.keys()].map((id) => ({
      id,
      lastActiveAt: this.#lastActive.get(id) ?? 0,
      selected: this.#selected === id,
      leased: this.#hasLiveLease(id),
      busy: this.#isBusy(id),
    }));
    for (const id of pickDormant(candidates, now, this.#idleMs)) {
      this.hibernate(id, `闲置 ${Math.round((now - (this.#lastActive.get(id) ?? 0)) / 1000)}s`);
    }
  }

  /** 正在加载 / 有声音 / 录 HAR / 回放的环境不能休眠。 */
  #isBusy(id: string): boolean {
    const spaces = this.#spaces.get(id);
    if (!spaces) return false;
    const tabs = SPACE_IDS.flatMap((space) => spaces[space].list());
    if (tabs.some((tab) => tab.loading || tab.audible)) return true;
    const net = this.#netOps.summary(id);
    return net.recording || net.replaying;
  }

  /**
   * 遮罩只跟 lease 走：agent 持有写权限时盖上，人接管/释放时撤掉。
   * 遮罩是原生 View，必须在环境视图之后 addChildView 才能盖在它上面。
   */
  #syncShield(id: string): void {
    const shield = this.#shields.get(id);
    const lease = this.#leases.get(id);
    if (!shield) return;
    // 遮罩只盖**正在显示的那个**环境：agent 持着别的环境的 lease 时，
    // 不该把当前显示的页面盖住（人看到的是「AI 在操作」，但 AI 在别处）。
    const humanOwnsAgent = Boolean(
      lease && lease.space === 'agent' && lease.owner === 'human' && lease.expiresAt > Date.now(),
    );
    const active = this.#selected === id && this.#activeSpaceOf(id) === 'agent' && !humanOwnsAgent;
    if (active) {
      const caller = lease && lease.space === 'agent' && lease.owner === 'agent' ? lease.label : undefined;
      shield.setCallerLabel(caller);
      shield.setVisible(this.#viewVisible);
      shield.attach(this.#window, this.#devtools.computeSplitBounds().page);
      shield.raise(this.#window);
    } else {
      shield.detach(this.#window);
    }
  }

  #closeEnvDevTools(spaces: EnvironmentSpaces): void {
    for (const space of SPACE_IDS) {
      for (const tab of spaces[space].list()) {
        this.#devtools.closeForTab(tab.id);
      }
    }
  }

  /** 选中不等于获得写权限：只负责把该环境的当前标签放进右侧区域 */
  select(id: string, space?: SpaceId): void {
    const spaces = this.#spaces.get(id);
    if (spaces && space && SPACE_IDS.includes(space) && spaces.active !== space) {
      if (this.#selected === id) spaces[spaces.active].detach();
      spaces.active = space;
    }
    const target = spaces?.[spaces.active];
    const { detachCurrent, attachTarget } = nextViewTransition({
      currentSelected: this.#selected,
      targetId: id,
      targetHasView: Boolean(target),
    });
    if (detachCurrent) this.#detachSelected();
    this.#selected = id;
    this.#touch(id);
    this.#rememberRunning();

    if (!attachTarget || !target) {
      this.#devtools.activateTab(undefined);
      // 环境没启动（没有页面视图可挂）。**选中态要保留**：
      // 界面要能说「环境未启动」，而不是退回「未选择环境」。
      // 这里以前直接把 #selected 清成 undefined 且不摘视图，结果是
      // 界面上写着「未选择环境」，屏幕上还留着上一个环境的页面，
      // 而且 #selected 为空后 setViewport 不再生效，页面会永远钉在旧位置。
      this.#onChange();
      return;
    }

    target.attach();
    target.setViewVisible(this.#viewVisible);
    this.#devtools.activateTab(target.activeId);
    target.setViewport(this.#devtools.computeSplitBounds().page);
    this.#layers.setVisible('devtools', this.#viewVisible && this.#devtools.isOpen());

    if (!this.#shields.has(id)) {
      this.#shields.set(
        id,
        new InputShield({
          layers: this.#layers,
          onTakeover: () => {
            try {
              this.takeover(id, 'human', 'agent');
            } catch {
              // ignore
            }
          },
        }),
      );
    }
    this.#syncShield(id);
    this.#onChange();
  }

  /**
   * 把当前挂着的页面视图和遮罩从窗口摘掉。
   * 用 detach 而不是直接 removeChildView：否则 shield.attached 会停在 true，
   * 下次 raise() 会对一个已经不在窗口里的视图做 remove/add。
   */
  #detachSelected(): void {
    if (!this.#selected) return;
    this.#devtools.activateTab(undefined);
    this.#spaceManager(this.#selected)?.detach();
    this.#shields.get(this.#selected)?.detach(this.#window);
  }

  controllerFor(id: string, ref?: TabRef, space: SpaceId = 'agent'): BrowserController {
    // 每一个 agent 操作都会经过这里 —— 这就是「这个环境还在被用」的最好信号
    this.#touch(id);
    const tabs = this.#spaceManager(id, space);
    if (!tabs)
      throw Object.assign(new Error(`environment ${id} is not running`), {
        code: 'ENV_NOT_RUNNING',
      });
    if (space === 'agent' && !tabs.active()) {
      // Agent 第一次接手时从可见页面开一个同地址的 Tab；不要去点 person 的 Tab，
      // 也不要把 agent 扔在一张无关的空白页上。
      const visibleUrl = this.#spaceManager(id, 'person')?.active()?.state.url;
      tabs.create({ url: visibleUrl || newTabUrl(id) });
    }
    const controller = tabs.controllerFor(ref);
    if (!controller)
      throw Object.assign(new Error(`tab not found: ${String(ref ?? 'active')}`), {
        code: 'TAB_NOT_FOUND',
      });
    return controller;
  }

  // ── 标签 ────────────────────────────────────────────────────────────

  tabsOf(id: string, space?: SpaceId): TabListItem[] {
    return this.#spaceManager(id, space)?.list() ?? [];
  }

  newTab(
    id: string,
    url?: string,
    options: { activate?: boolean } = {},
    space: SpaceId = this.#activeSpaceOf(id),
  ): TabListItem {
    const tabs = this.#requireTabs(id, space);
    const target = url ?? newTabUrl(id);
    const tab = tabs.create({ url: target, activate: options.activate ?? true });
    this.#store.record(makeEvent('tab.created', `${id} 新建标签：${target}`, 'human', id));
    this.#afterTabChange(id);
    return tabs.item(tab.id);
  }

  /** 静音开关。不是页面内容变更，所以人 / agent 都能做，但仍是写路径（要 lease）。 */
  muteTab(id: string, space: SpaceId, ref: TabRef, muted: boolean): TabListItem {
    const tab = this.#requireTabs(id, space).setMuted(ref, muted);
    if (!tab) throw Object.assign(new Error(`tab not found: ${String(ref)}`), { code: 'TAB_NOT_FOUND' });
    this.#store.record(makeEvent('tab.muted', `${id} 标签 ${ref} ${muted ? '静音' : '取消静音'}`, 'human', id));
    this.#afterTabChange(id);
    return tab;
  }

  /** 拖拽排序。0-based 下标；越界报 BAD_REQUEST，不静默丢弃。 */
  reorderTab(id: string, space: SpaceId, from: number, to: number): TabListItem[] {
    const tabs = this.#requireTabs(id, space);
    if (!tabs.reorder(from, to)) {
      throw Object.assign(new Error(`tab index out of range: ${from} → ${to}`), {
        code: 'BAD_REQUEST',
      });
    }
    this.#store.record(makeEvent('tab.reordered', `${id} 标签 ${from + 1} → ${to + 1}`, 'human', id));
    this.#afterTabChange(id);
    return tabs.list();
  }

  /** 右键菜单的「关闭其他 / 关闭右侧」。 */
  closeTabs(id: string, space: SpaceId, ref: TabRef, mode: 'others' | 'right'): void {
    this.#requireTabs(id, space).closeMany(ref, mode);
    this.#afterTabChange(id);
  }

  /** ⌘⇧T：重新打开最近关掉的那个标签。栈空时返回 undefined，由调用方报 TAB_NOT_FOUND。 */
  reopenTab(id: string, space: SpaceId = this.#activeSpaceOf(id)): TabListItem {
    const tabs = this.#requireTabs(id, space);
    const tab = tabs.reopen();
    if (!tab) throw Object.assign(new Error('没有可重新打开的标签'), { code: 'TAB_NOT_FOUND' });
    this.#store.record(makeEvent('tab.reopened', `${id} 重新打开标签`, 'human', id));
    this.#afterTabChange(id);
    return tabs.item(tab.id);
  }

  selectTab(id: string, space: SpaceId, ref: TabRef): TabListItem {
    const tabs = this.#requireTabs(id, space);
    const tab = tabs.select(ref);
    if (!tab) throw Object.assign(new Error(`tab not found: ${String(ref)}`), { code: 'TAB_NOT_FOUND' });
    this.#store.record(
      makeEvent(
        'tab.selected',
        `${id} 切到标签 ${tabs.list().findIndex((item) => item.id === tab.id) + 1}`,
        'human',
        id,
      ),
    );
    this.#afterTabChange(id);
    return tabs.item(tab.id);
  }

  closeTab(id: string, space: SpaceId, ref: TabRef): void {
    const tabs = this.#requireTabs(id, space);
    if (!tabs.close(ref)) throw Object.assign(new Error(`tab not found: ${String(ref)}`), { code: 'TAB_NOT_FOUND' });
    this.#afterTabChange(id);
  }

  #requireTabs(id: string, space: SpaceId = this.#activeSpaceOf(id)): TabManager {
    const tabs = this.#spaceManager(id, space);
    if (!tabs)
      throw Object.assign(new Error(`environment ${id} is not running`), {
        code: 'ENV_NOT_RUNNING',
      });
    return tabs;
  }

  /** 标签变化之后：遮罩与 DevTools 跟随激活标签同步 */
  #afterTabChange(id: string): void {
    if (this.#selected === id) {
      this.#devtools.activateTab(this.#spaceManager(id)?.activeId);
      this.#reapplySplitBounds(id);
      this.#syncShield(id);
    }
    this.#onChange();
  }

  /** 当前选中的环境。主进程是唯一真相源，渲染层读它而不是自己记一份。 */
  selectedId(): string | undefined {
    return this.#selected;
  }

  // ── 页面导航（工具栏） ──────────────────────────────────────────────
  // 导航按 PRD 是**写操作**。所以工具栏的前进/后退/刷新只在人持控制权时可用——
  // agent 正在操作时人不能抢页面，否则 lease 就没有意义了。
  // 读取导航状态不算写，不需要 lease。

  navState(
    id: string,
    space: SpaceId = this.#activeSpaceOf(id),
  ): { url: string; canGoBack: boolean; canGoForward: boolean; loading: boolean } | undefined {
    return this.#spaceManager(id, space)?.controller()?.navigationState();
  }

  humanNavigate(
    id: string,
    action: NavigationAction,
    space: SpaceId = this.#activeSpaceOf(id),
  ): { url: string; canGoBack: boolean; canGoForward: boolean; loading: boolean } {
    if (space === 'agent') {
      const lease = this.#leases.get(id);
      if (!lease || lease.expiresAt <= Date.now() || lease.space !== 'agent') {
        throw Object.assign(new Error(`Agent Space ${id} is not leased`), { code: 'ENV_NOT_LEASED' });
      }
      if (lease.owner !== 'human') {
        throw Object.assign(new Error(`Agent Space ${id} is controlled by ${lease.owner}`), {
          code: 'ENV_BUSY',
        });
      }
    }
    const controller = this.controllerFor(id, undefined, space);
    if (action.kind === 'back') controller.goBack();
    else if (action.kind === 'forward') controller.goForward();
    else if (action.kind === 'goto') void controller.navigate(action.url);
    else if (action.kind === 'hardReload') void controller.hardReload();
    else void controller.reload();
    const detail = action.kind === 'goto' ? `goto ${action.url}` : action.kind;
    this.#store.record(makeEvent('browser.navigated', `human ${detail} on ${id}`, 'human', id));
    return controller.navigationState();
  }

  // ── 控制权 ──────────────────────────────────────────────────────────

  /** 这个环境此刻的控制权策略（环境级 > 全局）。判定是纯函数，见 domain/approval.ts。 */
  #controlMode(id: string): 'ask' | 'auto' {
    const config = this.#store.configFor(id);
    return controlModeFor({
      policy: this.#store.appSettings().controlPolicy,
      envApproval: config?.approval,
      createdBy: config?.createdBy ?? 'human',
    });
  }

  acquire(id: string, owner: 'agent' | 'human', label?: string, space: SpaceId = 'agent'): LeaseHandle {
    const env = this.get(id);
    if (!env) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    if (space !== 'agent') {
      throw Object.assign(new Error('Person Space 不需要 lease'), { code: 'BAD_REQUEST' });
    }
    this.#touch(id);
    const current = this.#leases.get(id);
    if (current && current.expiresAt > Date.now()) {
      // 同一 owner 再来一次 = 续租（CLI 的长脚本靠这条续命），leaseId 不变。
      // 换了 owner（人正在用 / 别的 agent 持着）仍然是 ENV_BUSY。
      if (current.owner === owner) {
        // 传的是 Environment（字段叫 leaseExpiresAt），不是 LeaseHandle（字段叫 expiresAt）——
        // 传错了 renewLease 会直接抛 ENV_NOT_LEASED，续租就只剩 catch 兜底在生效。
        const ttl = leaseTtlMs();
        current.expiresAt = renewLease(env, current.leaseId, ttl).leaseExpiresAt ?? Date.now() + ttl;
        if (label) current.label = label;
        this.#syncShield(id);
        this.#onChange();
        return current;
      }
      /*
       * 换了 owner：默认仍然 ENV_BUSY（人点过接管，agent 就该等）。
       *
       * 但审批策略放行时，**agent** 可以直接从人手里接管 —— 这是「AI 自主性」那一档，
       * 默认关。只放行 agent 这一个方向：人抢 agent 是 `takeover()` 的特权，不走这里。
       * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3。
       */
      if (owner !== 'agent' || this.#controlMode(id) !== 'auto') {
        throw Object.assign(new Error(`environment ${id} is controlled by ${current.owner}`), {
          code: 'ENV_BUSY',
        });
      }
      this.#store.record(
        makeEvent('control.autoTakeover', `agent 按审批策略从 ${current.owner} 接管 ${id}`, 'agent', id),
      );
    }
    const lease: LeaseHandle = {
      environmentId: id,
      space,
      owner,
      label,
      leaseId: crypto.randomUUID(),
      expiresAt: Date.now() + leaseTtlMs(),
    };
    this.#leases.set(id, lease);
    this.#store.record(
      makeEvent('control.acquired', `${owner} acquired ${id}${label ? ` (${label})` : ''}`, owner, id),
    );
    this.#syncShield(id);
    this.#onChange();
    return lease;
  }

  release(id: string, leaseId: string, actor: 'agent' | 'human' = 'agent'): void {
    const current = this.#leases.get(id);
    if (!current) return;
    if (current.leaseId !== leaseId) {
      // 释放不看过期（过期租约也要能清掉），只说清「为什么这个 leaseId 不是一个 lease」
      throw Object.assign(new Error('CONTROL_REVOKED'), {
        code: 'CONTROL_REVOKED',
        reason: revokedReason(current.owner),
      });
    }
    this.#leases.delete(id);
    this.#store.record(makeEvent('control.released', `${actor} released ${id}`, actor, id));
    this.#syncShield(id);
    if (actor === 'human' && this.#selected === id && this.#activeSpaceOf(id) === 'agent') {
      this.select(id, 'person');
    }
    this.#onChange();
  }

  takeover(id: string, label = 'human', space: SpaceId = 'agent'): LeaseHandle {
    if (space !== 'agent') {
      throw Object.assign(new Error('只有 Agent Space 需要接管'), { code: 'BAD_REQUEST' });
    }
    const current = this.#leases.get(id);
    if (current) {
      this.#leases.delete(id);
      this.#store.record(makeEvent('control.takeover', `human took over ${id} from ${current.owner}`, 'human', id));
      // 立刻撤掉遮罩，别让人接管完还得再点一次
      this.#syncShield(id);
    }
    const lease = this.acquire(id, 'human', label, space);
    if (this.#selected === id) this.select(id, space);
    return lease;
  }

  /**
   * 输入类操作必须要求页面真的挂在窗口上。
   *
   * 没挂上的视图（后台环境），Chromium 会把 CDP 的输入事件**直接丢掉**：
   * 不报错、什么也没发生。静默失败最难查，所以这里显式拒绝。
   * 导航/读取不受影响——它们不走输入通道。
   */
  /**
   * 让这个环境**此刻收得到输入**。返回 `true` = 是临时挂上去的，调用方用完要 `detachOperable`。
   *
   * 后台环境（视图没挂在窗口上）Chromium 会把输入**直接丢掉**：页面自报 `visibility: hidden`，
   * CDP 的 `Input.*` 和 Electron 原生的 `sendInputEvent` 都丢（实测三次全失败）。
   * 把它的视图**附到窗口最底层**之后页面就自报 visible，**CDP 输入能落进去**（实测），
   * 而人看到的仍然是上面那个视图——所以「agent 并行操作多个环境」不需要换输入栈。
   *
   * 两条不能忘：
   * 1. 附上去会**抢走 webContents 焦点**（实测），必须立刻把焦点还给显示中的那个，
   *    否则人打字会打进一个看不见的页面（会泄露、也会打错地方）；
   * 2. 上面那个视图此刻**被让开**（浮层 / 插件页，`viewVisible=false`）时**不许挂**——
   *    它一藏，挂在底层的后台页面就露出来了。
   */
  ensureOperable(id: string, space: SpaceId = 'agent'): boolean {
    const tabs = this.#spaceManager(id, space);
    if (!tabs)
      throw Object.assign(new Error(`environment ${id} is not running`), {
        code: 'ENV_NOT_RUNNING',
      });
    if (tabs.showing) return false; // 正常路径：它的视图就是显示中的那个

    const selected = this.#selected ? this.#spaceManager(this.#selected) : undefined;
    if (selected && !selected.viewVisible) {
      throw Object.assign(new Error(`界面上有浮层挡着页面区域，这时不能把后台环境挂上来操作；先关掉浮层`), {
        code: 'ENV_NOT_VISIBLE',
      });
    }
    if (!tabs.attachBelow()) return false;
    // 焦点必须马上还给显示中的那个环境。窗口不在前台时用焦点仿真，不能把应用拉上来。
    const wc = selected?.active()?.webContents;
    if (this.#window.isFocused() && wc && !wc.isDestroyed()) wc.focus();
    else
      void selected
        ?.controller()
        ?.emulateFocus()
        .catch(() => {});
    this.#store.record(makeEvent('input.backgroundAttach', `${id} 临时挂到最底层以便接收输入`, 'system', id));
    return true;
  }

  /** 摘掉 `ensureOperable` 临时挂上去的视图。 */
  detachOperable(id: string, space: SpaceId = 'agent'): void {
    this.#spaceManager(id, space)?.detachBelow();
  }

  /**
   * 输入类操作再要求「页面真的画在屏幕上」。
   *
   * 视图挂在窗口上、但被界面**让开**（浮层 / 插件页占了内容区，渲染层调了 `setViewVisible(false)`）
   * 时，Chromium 一样把 CDP 输入丢掉——而这一次不是报错，是**挂到 RPC 60s 超时**
   * （实测：`setViewVisible(false)` 后 `page.click` 返回
   * `TIMEOUT 60007ms: RPC 超时 60000ms: browser.click`）。静默挂死最难查，所以显式拒绝。
   * （另一种「视图 0×0」的成因在 `setViewport()` 那侧堵掉了。）
   *
   * 只给真正发输入的操作用：`acceptDialog/dismissDialog` 是浏览器侧命令，要留一条自救的路。
   */
  assertInputOnScreen(id: string, space: SpaceId = 'agent'): void {
    const tabs = this.#spaceManager(id, space);
    if (!tabs)
      throw Object.assign(new Error(`environment ${id} is not running`), {
        code: 'ENV_NOT_RUNNING',
      });
    // 后台环境不看这个标志：它的含义是「**显示中的那个**被让开了」，
    // 后台环境的这个值可能是它当初被让开时留下的（切走时不会复位），拿它拒绝会是个看不出所以然的错
    if (!tabs.showing) return;
    if (!tabs.viewVisible) {
      throw Object.assign(
        new Error(
          `environment ${id} 的页面视图此刻被界面让开（浮层或插件页挡着），输入会被丢弃；先关掉浮层 / 切回环境页再操作`,
        ),
        { code: 'ENV_NOT_VISIBLE' },
      );
    }
  }

  /*
   * 这里原来有一道 `assertInputFocus()`：窗口不在前台就报 `WINDOW_NOT_FOCUSED`，
   * 理由是「macOS 会把 CDP 输入丢掉」。**2026-10-17 实测推翻了这个前提** ——
   * 窗口失焦时鼠标点击与键盘都正常送达，坐标也和前台一致（`scripts/verify/batch1-focus.mjs`）。
   * 那道守卫拦掉的是本来能成功的操作，所以删掉。
   *
   * 留下的是两件真事：
   *   1. **窗口有焦点 ≠ 页面有 document 焦点** —— 发输入前由 `focusForInput()` 用 CDP 仿真补齐；
   *   2. 视图没挂在窗口上 / 尺寸为 0 时输入才真会丢 —— 那是 `assertInputOnScreen` 守的。
   *
   * 窗口焦点状态仍可从 `layout().windowFocused` 读到，用于观测，不再用于拦截。
   */

  assertWritable(id: string, leaseId?: string, space: SpaceId = 'agent'): LeaseHandle {
    const lease = this.#leases.get(id);
    // 「没租过 / 过期 / 被顶掉 / 被人接管 / space 不对」由 domain 判定并给出下一步命令，
    // 错误码不变（ENV_NOT_LEASED / CONTROL_REVOKED），额外带 reason 与 expiredAt
    const denial = diagnoseLease({ environmentId: id, lease, providedLeaseId: leaseId, space });
    if (denial) throw leaseDenialError(denial);
    return lease as LeaseHandle;
  }

  /** 显式续租：只推到期时间，leaseId 不变。 */
  renew(id: string, leaseId: string): LeaseHandle {
    const env = this.get(id);
    if (!env) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    const current = this.#leases.get(id);
    const denial = diagnoseLease({
      environmentId: id,
      lease: current,
      providedLeaseId: leaseId,
      space: current?.space ?? 'agent',
    });
    if (denial) throw leaseDenialError(denial);
    const lease = current as LeaseHandle;
    const ttl = leaseTtlMs();
    lease.expiresAt = renewLease(env, leaseId, ttl).leaseExpiresAt ?? Date.now() + ttl;
    this.#touch(id);
    this.#syncShield(id);
    this.#onChange();
    return lease;
  }

  /**
   * 输入类操作只能落在**当前激活的标签**上。
   *
   * 输入走 CDP 的 Input 域，作用于「正在显示的那个 webContents」——对非激活标签
   * 发点击，Chromium 会把它送给激活标签，静默点错地方。所以显式拒绝，先 `tab.select`。
   */
  assertActiveTab(id: string, ref?: TabRef, space: SpaceId = 'agent'): void {
    if (ref === undefined) return; // 缺省就是激活标签
    const tabs = this.#spaceManager(id, space);
    if (!tabs)
      throw Object.assign(new Error(`environment ${id} is not running`), {
        code: 'ENV_NOT_RUNNING',
      });
    const resolved = tabs.resolveRef(ref);
    if (!resolved || resolved !== tabs.activeId) {
      throw Object.assign(
        new Error(`tab ${String(ref)} 不是当前激活标签，输入会落到激活标签上；先 tab.select 再操作`),
        {
          code: 'TAB_NOT_VISIBLE',
        },
      );
    }
  }

  shutdown(): void {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
    this.#devtools.destroyAll();
    for (const id of [...this.#spaces.keys()]) this.stop(id);
  }

  // ── 运行态：LRU 回收 + 崩溃恢复 ─────────────────────────────────────

  #touch(id: string): void {
    this.#lastActive.set(id, Date.now());
  }

  #hasLiveLease(id: string): boolean {
    const lease = this.#leases.get(id);
    return Boolean(lease && lease.expiresAt > Date.now());
  }

  hasActiveAgentLease(): boolean {
    const now = Date.now();
    return [...this.#leases.values()].some(
      (lease) => lease.space === 'agent' && lease.owner === 'agent' && lease.expiresAt > now,
    );
  }

  hasRunningEnvironments(): boolean {
    return this.#spaces.size > 0;
  }

  /**
   * 起新环境之前腾位置：按「最后一次被用到」回收最久没用的那几个。
   *
   * 排除项见 `pickEvictions`（选中的 / 持着租约的绝不回收）。
   * 被回收的环境就是 `stopped`——页面关掉、内存还给系统，下次要用手动再启动。
   */
  #evictFor(keep: string): void {
    if (this.#maxRunning <= 0) return;
    const candidates = [...this.#spaces.keys()]
      .filter((id) => id !== keep)
      .map((id) => ({
        id,
        lastActiveAt: this.#lastActive.get(id) ?? 0,
        selected: this.#selected === id,
        leased: this.#hasLiveLease(id),
      }));
    for (const id of pickEvictions(candidates, this.#maxRunning)) {
      this.#store.record(
        makeEvent('env.evicted', `${id} 被 LRU 回收（同时运行上限 ${this.#maxRunning}）`, 'system', id),
      );
      this.stop(id);
    }
  }

  /** 记下「现在哪些环境在跑」，供崩溃恢复用（同步写，退出路径也靠它）。 */
  #rememberRunning(): void {
    this.#store.saveRunning({
      running: [...this.#spaces.keys()],
      selected: this.#selected,
      dormant: [...this.#dormant],
    });
  }

  /** 把当前标签组写进库（同一组只写一次；`force` 用于停环境/退出前补最后一笔）。 */
  #rememberTabs(id: string, options: { force?: boolean } = {}): void {
    if (this.#waking.has(id)) return;
    const spaces = this.#spaces.get(id);
    if (!spaces) return;
    const list = SPACE_IDS.flatMap((space) => spaces[space].list().filter((tab) => tab.url));
    const snapshot = list.map((tab) => `${tab.space}:${tab.active ? '*' : ''}${tab.url}`).join('\n');
    if (!options.force && this.#tabSnapshot.get(id) === snapshot) return;
    this.#tabSnapshot.set(id, snapshot);
    this.#store.saveTabs(
      id,
      list.map((tab) => ({ space: tab.space, url: tab.url, active: tab.active })),
    );
  }

  /**
   * 崩溃恢复：把上次退出时还在跑的环境重新拉起来。
   *
   * **不恢复 URL**：页面回到自己的 startUrl / 新标签页。POST 过的页面本来恢复不了，
   * 而「照搬崩溃前那个 URL」会让人以为表单状态还在。
   * 起不来的（配置没了 / 代理挂了）只记一条事件就跳过，绝不挡住启动。
   */
  async restoreRunning(ids: string[], selected?: string): Promise<string[]> {
    const restored: string[] = [];
    for (const id of ids) {
      // 休眠中的环境不在这里拉起：它会在第一次被用到时由 wake() 透明复活
      if (this.#dormant.has(id)) continue;
      if (!this.#store.configFor(id) || this.#spaces.has(id)) continue;
      try {
        await this.start(id);
        restored.push(id);
      } catch (error) {
        this.#store.record(makeEvent('env.restoreFailed', `${id} 恢复失败：${(error as Error).message}`, 'system', id));
      }
    }
    if (selected && this.#spaces.has(selected)) this.select(selected);
    return restored;
  }

  get maxRunning(): number {
    return this.#maxRunning;
  }

  get selected(): string | undefined {
    return this.#selected;
  }
}

export { acquireLease, releaseLease };
