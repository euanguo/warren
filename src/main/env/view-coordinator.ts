import {
  app,
  clipboard,
  dialog,
  ipcMain,
  screen,
  shell,
  webContents,
  WebContentsView,
  type BrowserWindow,
  type Session,
} from 'electron';
import type { X509Certificate } from 'node:crypto';
import path from 'node:path';
import { buildPageContextMenu } from '../browser-context-menu.ts';
import { BrowserController } from '../browser/controller.ts';
import { getDownloadPath, listDownloads } from '../browser/downloads.ts';
import type { EnvPending } from '../browser/pending.ts';
import { redactUrl } from '../browser/redact.ts';
import { makeEvent } from '../domain/environment.ts';
import { nextViewTransition } from '../environment-view-state.ts';
import type { Store } from '../store.ts';
import { TabManager, newTabUrl, type Tab, type TabListItem } from '../tabs.ts';
import { BackgroundHostWindow, type BackgroundHostLike } from '../ui/background-host.ts';
import { DevToolsHost, type DevToolsSplitterInput } from '../ui/devtools-host.ts';
import { WindowLayerManager } from '../ui/layer-manager.ts';
import { popupNativeMenu } from '../ui/native-menu.ts';
import { placeWindowOnItsDisplay, shouldEmulateRenderFocus } from '../ui/window-visibility.ts';
import type {
  BrowserShortcut,
  ControlOwner,
  DevToolsDockMode,
  DownloadItemInfo,
  FindInPageResult,
  NavigationAction,
  NavigationState,
  PluginBusEventType,
  SpaceId,
  TabRef,
  ViewportPresetId,
  ViewportRect,
} from '../../shared/types.ts';
import { computeSimulatedPageBounds, type SimulatedPageLayout } from '../../shared/viewport-presets.ts';
import type { EnvSessionFactory } from './session-factory.ts';
import { SPACE_IDS, type EnvironmentSpaces, type EnvLifecycle } from './lifecycle.ts';
import type { LeaseCoordinator, TabManagerLike } from './lease-coordinator.ts';

export interface ViewCoordinatorDeps {
  window: BrowserWindow;
  layers?: WindowLayerManager;
  backgroundHost?: BackgroundHostLike;
  store: Pick<Store, 'domainPref' | 'setDomainPref' | 'record' | 'recordUrlHistory'>;
  sessions: Pick<
    EnvSessionFactory,
    | 'attachTabTelemetry'
    | 'detachTabTelemetry'
    | 'lastActivityAt'
    | 'inFlightCount'
    | 'lastNavigationError'
    | 'telemetryWriteStats'
  >;
  getLifecycle: () => Pick<
    EnvLifecycle,
    | 'spacesFor'
    | 'allSpacesEntries'
    | 'spaceManager'
    | 'activeSpaceOf'
    | 'touch'
    | 'rememberRunning'
    | 'rememberTabs'
    | 'onSpaceEmpty'
    | 'maxRunning'
    | 'isTabThrottlingEnabled'
  >;
  getLeases: () => Pick<
    LeaseCoordinator,
    | 'syncShield'
    | 'detachShieldOnly'
    | 'repositionShield'
    | 'setShieldVisible'
    | 'isAgentControlling'
    | 'canHumanNavigate'
    | 'assertHumanAgentWritable'
    | 'showVisualAction'
    | 'touchAgentSession'
    | 'rawLease'
    | 'shieldAttached'
  >;
  onChange: () => void;
  onTargetUrl?: (payload: { envId: string; url: string }) => void;
  onFindResult?: (result: FindInPageResult) => void;
  onDevToolsSizeCommitted?: (mode: 'right' | 'bottom', size: number) => void;
  emitBusEvent: (type: PluginBusEventType, environmentId: string, payload: Record<string, unknown>) => void;
}

/**
 * 视图、标签、窗口与页面交互编排器：
 * 负责 `select` / `selectSpace`、标签创建/切换/关闭/导航、`WindowLayerManager` 槽位编排、
 * `DevToolsHost` 停靠/分割与视口同步、窗口显隐与后台常驻、页内查找/缩放/视口预设/下载/打印/另存为与网页右键原生菜单编排。
 */
export class EnvViewCoordinator {
  #deps: ViewCoordinatorDeps;
  #window: BrowserWindow;
  #layers: WindowLayerManager;
  #backgroundHost: BackgroundHostLike;
  #devtools: DevToolsHost;
  #selected?: string;
  #presets = new Map<string, ViewportPresetId>();
  #defaultViewport: ViewportPresetId = 'auto';
  #disposeWindowListeners?: () => void;

  constructor(deps: ViewCoordinatorDeps) {
    this.#deps = deps;
    this.#window = deps.window;
    this.#layers = deps.layers ?? new WindowLayerManager(deps.window);
    this.#backgroundHost = deps.backgroundHost ?? new BackgroundHostWindow();
    this.#devtools = new DevToolsHost(
      this.#layers,
      () => this.#syncAfterDevToolsChange(),
      () =>
        new WebContentsView({
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        }),
      () => !this.#window.isDestroyed() && this.#window.isFocused(),
      {
        createSplitterView: () =>
          new WebContentsView({
            webPreferences: {
              preload: path.join(__dirname, 'splitter-preload.cjs'),
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false,
              backgroundThrottling: false,
            },
          }),
        // 页面槽位尺寸由 ViewCoordinator 结合模拟视口预设统一计算，禁止 DevToolsHost 直接覆盖 page bounds
        managePageBounds: false,
        onLayoutChanged: () => {
          if (this.#selected) this.reapplySplitBounds(this.#selected, { syncEmulation: false });
        },
        onSizeCommitted: (mode, size) => {
          if (this.#selected) this.reapplySplitBounds(this.#selected);
          this.#deps.onDevToolsSizeCommitted?.(mode, size);
        },
      },
    );
    const onSplitterMessage = (event: Electron.IpcMainEvent, raw: unknown) => {
      const splitterWc = this.#devtools.splitterWebContents();
      if (!splitterWc || event.sender !== splitterWc) return;
      const parsed = parseSplitterInput(raw);
      if (parsed) this.#devtools.handleSplitterInput(parsed);
    };
    const onWindowBlur = () => {
      this.#devtools.cancelDrag();
    };
    const onWindowFocus = () => {
      this.#clearDisplayedEmulatedFocus();
    };
    const onWindowHide = () => {
      this.#syncHiddenFocus();
    };
    ipcMain?.on('devtools:splitter', onSplitterMessage);
    this.#window.on?.('blur', onWindowBlur);
    this.#window.on?.('focus', onWindowFocus);
    this.#window.on?.('hide', onWindowHide);
    this.#disposeWindowListeners = () => {
      ipcMain?.removeListener('devtools:splitter', onSplitterMessage);
      this.#window.removeListener?.('blur', onWindowBlur);
      this.#window.removeListener?.('focus', onWindowFocus);
      this.#window.removeListener?.('hide', onWindowHide);
    };
  }

  get layers(): WindowLayerManager {
    return this.#layers;
  }

  hasBackgroundHost(): boolean {
    return Boolean(this.#backgroundHost);
  }

  get selected(): string | undefined {
    return this.#selected;
  }

  get viewVisible(): boolean {
    return this.#layers.viewVisible();
  }

  get viewport(): ViewportRect {
    return this.#layers.viewport();
  }

  #splitPageContainer(): ViewportRect {
    if (!this.#layers.isViewportReady()) {
      const [winW, winH] = this.#window.isDestroyed() ? [1440, 920] : this.#window.getContentSize();
      const x = Math.min(318, Math.max(0, Math.floor(winW * 0.25)));
      const y = Math.min(128, Math.max(0, Math.floor(winH * 0.15)));
      return {
        x,
        y,
        width: Math.max(200, winW - x - 6),
        height: Math.max(160, winH - y - 6),
      };
    }
    return this.#devtools.computeSplitBounds().page;
  }

  #layoutForContainer(id: string, space: SpaceId, container: ViewportRect): SimulatedPageLayout {
    const preset = this.getViewportPreset(id, space).preset;
    return computeSimulatedPageBounds(container, preset);
  }

  #layoutFor(id: string, space?: SpaceId): SimulatedPageLayout {
    const targetSpace = space ?? this.#deps.getLifecycle().activeSpaceOf(id);
    return this.#layoutForContainer(id, targetSpace, this.#splitPageContainer());
  }

  #syncControllerViewport(id: string, space: SpaceId, layout: SimulatedPageLayout): void {
    const controller = this.#deps.getLifecycle().spaceManager(id, space)?.peekController();
    if (controller) void controller.setViewportPreset(layout.preset, layout.scale).catch(() => {});
  }

  pageBounds(): ViewportRect {
    if (this.#selected) return this.#layoutFor(this.#selected).bounds;
    return this.#splitPageContainer();
  }

  clearSelectedIf(id: string): void {
    if (this.#selected === id) this.#selected = undefined;
  }

  /** 为指定环境与 Space 构建 `TabManager`，接入遥测、总线事件、缩放到位与右键菜单。 */
  createSpaceManager(
    id: string,
    space: SpaceId,
    ses: Session,
    trustedCa: X509Certificate | (() => X509Certificate | undefined) | undefined,
    pending: EnvPending,
  ): TabManager {
    return new TabManager({
      envId: id,
      space,
      window: this.#window,
      layers: this.#layers,
      backgroundHost: this.#backgroundHost,
      getViewport: () => this.#layoutFor(id, space).bounds,
      isViewportReady: () => this.#layers.isViewportReady(),
      session: ses,
      trustedCa,
      throttleBackgroundTabs: this.#deps.getLifecycle().isTabThrottlingEnabled?.() ?? true,
      onChanged: () => {
        this.#deps.onChange();
        this.#deps.getLifecycle().rememberTabs(id);
      },
      onViewChanged: () => {
        if (this.#selected === id && this.#deps.getLifecycle().activeSpaceOf(id) === space) {
          this.#devtools.activateTab(this.#deps.getLifecycle().spaceManager(id, space)?.activeId);
          this.reapplySplitBounds(id);
          this.#deps.getLeases().syncShield(id);
        }
      },
      onEmpty: () => this.#deps.getLifecycle().onSpaceEmpty(id, space),
      onEvent: (type, message) => {
        this.#deps.store.record(makeEvent(type, message, 'system', id));
        this.#deps.onChange();
      },
      onPopup: (tabId, url) => {
        const index =
          (this.#deps
            .getLifecycle()
            .spaceManager(id, space)
            ?.list()
            .findIndex((tab) => tab.id === tabId) ?? -1) + 1;
        pending.notePopup({ tabId, index, url, at: new Date().toISOString() });
        this.#deps.emitBusEvent('tab.created', id, { tabId, space, url: redactUrl(url) });
      },
      onUrlVisited: (url) => this.#deps.store.recordUrlHistory(url),
      onOriginZoomNeeded: (tab, url) => this.applyOriginZoom(id, tab, url),
      onTargetUrl: (url) => {
        if (this.#selected === id && this.#deps.getLifecycle().activeSpaceOf(id) === space) {
          this.#deps.onTargetUrl?.({ envId: id, url });
        }
      },
      onFoundInPage: (result) => {
        this.#deps.onFindResult?.({
          envId: id,
          requestId: result.requestId,
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches,
          finalUpdate: result.finalUpdate,
        });
      },
      onContextMenu: (tab, params) => {
        void this.handlePageContextMenu(id, space, tab, params);
      },
      createController: (tabId, wc) => {
        try {
          this.#deps.sessions.attachTabTelemetry(id, tabId, wc);
        } catch {
          // 遥测挂不上不能影响环境启动
        }
        wc.on('did-navigate', (_event, url) => {
          this.#deps.emitBusEvent('nav.committed', id, { tabId, space, url: redactUrl(url) });
        });
        wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
          if (isMainFrame) {
            this.#deps.emitBusEvent('nav.committed', id, { tabId, space, url: redactUrl(url) });
          }
        });
        const controller = new BrowserController(wc, {
          envId: id,
          tabId,
          tabIndex: () =>
            this.#deps
              .getLifecycle()
              .spaceManager(id, space)
              ?.list()
              .findIndex((tab) => tab.id === tabId) ?? -1,
          pending: pending.sinkFor(wc),
          lastActivityAt: () => this.#deps.sessions.lastActivityAt(tabId),
          inFlightCount: () => this.#deps.sessions.inFlightCount(tabId),
          lastNavigationError: () => this.#deps.sessions.lastNavigationError(tabId),
          downloadById: (downloadId) => pending.downloadById(downloadId),
          record: (type, message) => {
            this.#deps.store.record(makeEvent(type, message, 'agent', id));
          },
          onVisualAction: (action) => {
            if (space === 'agent') this.#deps.getLeases().showVisualAction(id, action);
          },
        });
        controller.attach();
        return controller;
      },
      onTabDestroyed: (tabId) => {
        this.#deps.sessions.detachTabTelemetry(tabId);
        this.#devtools.closeForTab(tabId);
      },
    });
  }

  // ── 标签与导航 ─────────────────────────────────────────────────────

  controllerFor(id: string, ref?: TabRef, space: SpaceId = 'agent'): BrowserController {
    this.#deps.getLifecycle().touch(id);
    if (space === 'agent') this.#deps.getLeases().touchAgentSession?.(id);
    const tabs = this.#deps.getLifecycle().spaceManager(id, space);
    if (!tabs) {
      throw Object.assign(new Error(`environment ${id} is not running`), { code: 'ENV_NOT_RUNNING' });
    }
    if (space === 'agent' && !tabs.active()) {
      const visibleUrl = this.#deps.getLifecycle().spaceManager(id, 'person')?.active()?.state.url;
      tabs.create({ url: visibleUrl || newTabUrl(id) });
    }
    const controller = tabs.controllerFor(ref);
    if (!controller) {
      throw Object.assign(new Error(`tab not found: ${String(ref ?? 'active')}`), { code: 'TAB_NOT_FOUND' });
    }
    return controller;
  }

  tabsOf(id: string, space?: SpaceId): TabListItem[] {
    return this.#deps.getLifecycle().spaceManager(id, space)?.list() ?? [];
  }

  newTab(
    id: string,
    url?: string,
    options: { activate?: boolean } = {},
    space: SpaceId = this.#deps.getLifecycle().activeSpaceOf(id),
  ): TabListItem {
    const tabs = this.#requireTabs(id, space);
    const target = url ?? newTabUrl(id);
    const tab = tabs.create({ url: target, activate: options.activate ?? true });
    this.#deps.store.record(makeEvent('tab.created', `${id} 新建标签：${target}`, 'human', id));
    this.#deps.emitBusEvent('tab.created', id, { tabId: tab.id, space, url: redactUrl(target) });
    this.#afterTabChange(id);
    return tabs.item(tab.id);
  }

  muteTab(id: string, space: SpaceId, ref: TabRef, muted: boolean): TabListItem {
    const tab = this.#requireTabs(id, space).setMuted(ref, muted);
    if (!tab) throw Object.assign(new Error(`tab not found: ${String(ref)}`), { code: 'TAB_NOT_FOUND' });
    this.#deps.store.record(makeEvent('tab.muted', `${id} 标签 ${ref} ${muted ? '静音' : '取消静音'}`, 'human', id));
    this.#afterTabChange(id);
    return tab;
  }

  sleepTab(id: string, space: SpaceId, ref: TabRef): boolean {
    const slept = this.#requireTabs(id, space).sleep(ref);
    if (slept) {
      this.#deps.store.record(makeEvent('tab.slept', `${id} 标签 ${ref} 进入休眠释放内存`, 'human', id));
      this.#afterTabChange(id);
    }
    return slept;
  }

  reorderTab(id: string, space: SpaceId, from: number, to: number): TabListItem[] {
    const tabs = this.#requireTabs(id, space);
    if (!tabs.reorder(from, to)) {
      throw Object.assign(new Error(`tab index out of range: ${from} → ${to}`), { code: 'BAD_REQUEST' });
    }
    this.#deps.store.record(makeEvent('tab.reordered', `${id} 标签 ${from + 1} → ${to + 1}`, 'human', id));
    this.#afterTabChange(id);
    return tabs.list();
  }

  closeTabs(id: string, space: SpaceId, ref: TabRef, mode: 'others' | 'right'): void {
    this.#requireTabs(id, space).closeMany(ref, mode);
    this.#afterTabChange(id);
  }

  reopenTab(id: string, space: SpaceId = this.#deps.getLifecycle().activeSpaceOf(id)): TabListItem {
    const tabs = this.#requireTabs(id, space);
    const tab = tabs.reopen();
    if (!tab) throw Object.assign(new Error('没有可重新打开的标签'), { code: 'TAB_NOT_FOUND' });
    this.#deps.store.record(makeEvent('tab.reopened', `${id} 重新打开标签`, 'human', id));
    this.#afterTabChange(id);
    return tabs.item(tab.id);
  }

  selectTab(id: string, space: SpaceId, ref: TabRef): TabListItem {
    const tabs = this.#requireTabs(id, space);
    const tab = tabs.select(ref);
    if (!tab) throw Object.assign(new Error(`tab not found: ${String(ref)}`), { code: 'TAB_NOT_FOUND' });
    this.#deps.store.record(
      makeEvent(
        'tab.selected',
        `${id} 切到标签 ${tabs.list().findIndex((item) => item.id === tab.id) + 1}`,
        'human',
        id,
      ),
    );
    this.#afterTabChange(id);
    const item = tabs.item(tab.id);
    this.#deps.emitBusEvent('tab.activated', id, {
      tabId: tab.id,
      space,
      url: redactUrl(item.url),
      title: item.title,
    });
    return item;
  }

  closeTab(id: string, space: SpaceId, ref: TabRef): void {
    const tabs = this.#requireTabs(id, space);
    if (!tabs.close(ref)) throw Object.assign(new Error(`tab not found: ${String(ref)}`), { code: 'TAB_NOT_FOUND' });
    this.#afterTabChange(id);
  }

  navState(id: string, space: SpaceId = this.#deps.getLifecycle().activeSpaceOf(id)): NavigationState | undefined {
    const tabs = this.#deps.getLifecycle().spaceManager(id, space);
    if (!tabs) return undefined;
    const controller = tabs.peekController();
    if (controller) return controller.navigationState();
    const state = tabs.activeState();
    if (!state) return undefined;
    return {
      url: state.url,
      canGoBack: false,
      canGoForward: false,
      loading: false,
    };
  }

  humanNavigate(
    id: string,
    action: NavigationAction,
    space: SpaceId = this.#deps.getLifecycle().activeSpaceOf(id),
  ): NavigationState {
    if (space === 'agent') this.#deps.getLeases().assertHumanAgentWritable(id);
    const controller = this.controllerFor(id, undefined, space);
    if (action.kind === 'back') controller.goBack();
    else if (action.kind === 'forward') controller.goForward();
    else if (action.kind === 'goto') void controller.navigate(action.url);
    else if (action.kind === 'hardReload') void controller.hardReload();
    else void controller.reload();
    const detail = action.kind === 'goto' ? `goto ${action.url}` : action.kind;
    this.#deps.store.record(makeEvent('browser.navigated', `human ${detail} on ${id}`, 'human', id));
    return controller.navigationState();
  }

  // ── 视图切换、窗口与 DevTools ──────────────────────────────────────

  /** 只切「当前显示哪个 Space」，不等于获取控制权。 */
  selectSpace(id: string, space: SpaceId): void {
    const spaces = this.#deps.getLifecycle().spacesFor(id);
    if (!spaces) {
      throw Object.assign(new Error(`environment ${id} is not running`), { code: 'ENV_NOT_RUNNING' });
    }
    if (!SPACE_IDS.includes(space)) {
      throw Object.assign(new Error(`unknown space ${String(space)}`), { code: 'BAD_REQUEST' });
    }
    if (spaces.active === space) return;
    this.#deps.getLifecycle().touch(id);
    if (this.#selected === id) spaces[spaces.active].detach();
    spaces.active = space;
    if (this.#selected === id) {
      this.#devtools.activateTab(spaces[space].activeId);
      const layout = this.#layoutFor(id, space);
      spaces[space].setViewport(layout.bounds);
      spaces[space].setViewVisible(this.#layers.viewVisible());
      spaces[space].attach();
      this.#syncControllerViewport(id, space, layout);
      this.#devtools.syncVisibility();
      this.#deps.getLeases().syncShield(id);
      this.#syncDisplayedVisibilityFocus();
    }
    this.#deps.emitBusEvent('space.switched', id, {
      space,
      activeTabId: spaces[space].activeId ?? '',
      url: redactUrl(spaces[space].activeState()?.url ?? ''),
    });
    this.#deps.onChange();
  }

  /** 选中不等于获得写权限：只负责把该环境的当前标签放进右侧区域。 */
  select(id: string, space?: SpaceId): void {
    const spaces = this.#deps.getLifecycle().spacesFor(id);
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
    this.#deps.getLifecycle().touch(id);
    this.#deps.getLifecycle().rememberRunning();

    if (!attachTarget || !target) {
      this.#devtools.activateTab(undefined);
      this.#deps.onChange();
      return;
    }

    this.#devtools.activateTab(target.activeId);
    const layout = this.#layoutFor(id, spaces.active);
    target.setViewport(layout.bounds);
    target.setViewVisible(this.#layers.viewVisible());
    target.attach();
    this.#syncControllerViewport(id, spaces.active, layout);
    this.#devtools.syncVisibility();

    this.#deps.getLeases().syncShield(id, { createIfMissing: true });
    this.#syncDisplayedVisibilityFocus();
    this.#deps.onChange();
  }

  setViewport(viewport: ViewportRect): void {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    this.#layers.setViewport(viewport);
    this.#devtools.setViewport(viewport);
    const split = this.#devtools.computeSplitBounds();
    // 同步全部运行中环境的双 Space 视口，确保后台/非激活 Space attachBelow 绝不回退到 0,0,800,600
    for (const [envId, spaces] of this.#deps.getLifecycle().allSpacesEntries()) {
      for (const space of SPACE_IDS) {
        const layout = this.#layoutForContainer(envId, space, split.page);
        spaces[space].setViewport(layout.bounds);
      }
    }
    if (this.#selected) {
      const activeSpace = this.#deps.getLifecycle().activeSpaceOf(this.#selected);
      const selectedLayout = this.#layoutForContainer(this.#selected, activeSpace, split.page);
      this.#deps.getLifecycle().spaceManager(this.#selected, activeSpace)?.setViewVisible(this.#layers.viewVisible());
      this.#deps.getLeases().repositionShield(this.#selected, selectedLayout.bounds);
      this.#syncControllerViewport(this.#selected, activeSpace, selectedLayout);
    }
    this.#devtools.syncVisibility();
  }

  setViewVisible(visible: boolean): void {
    this.#layers.setViewVisible(visible);
    if (this.#selected) {
      this.#deps.getLifecycle().spaceManager(this.#selected)?.setViewVisible(visible);
      this.#deps.getLeases().setShieldVisible(this.#selected, visible);
    }
    this.#devtools.syncVisibility();
  }

  reapplySplitBounds(id: string, options: { syncEmulation?: boolean } = {}): void {
    if (this.#selected !== id) return;
    const split = this.#devtools.computeSplitBounds();
    const activeSpace = this.#deps.getLifecycle().activeSpaceOf(id);
    const layout = this.#layoutForContainer(id, activeSpace, split.page);
    this.#deps.getLifecycle().spaceManager(id, activeSpace)?.setViewport(layout.bounds);
    this.#deps.getLeases().repositionShield(id, layout.bounds);
    if (options.syncEmulation !== false) {
      this.#syncControllerViewport(id, activeSpace, layout);
    }
  }

  closeEnvDevTools(spaces: EnvironmentSpaces): void {
    for (const space of SPACE_IDS) {
      for (const tab of spaces[space].list()) {
        this.#devtools.closeForTab(tab.id);
      }
    }
  }

  destroyAllDevTools(): void {
    this.#disposeWindowListeners?.();
    this.#disposeWindowListeners = undefined;
    this.#devtools.destroyAll();
    this.#backgroundHost.destroy();
  }

  openDevTools(id: string, space: SpaceId = 'agent', dock?: DevToolsDockMode): void {
    const target = this.#prepareDevToolsTarget(id, space, '打开开发者工具');
    if (!target) return;
    this.#devtools.openForTab(target.tab.id, target.wc, dock);
    this.reapplySplitBounds(id);
  }

  closeDevTools(id: string, space: SpaceId = 'agent'): void {
    const tab = this.#deps.getLifecycle().spaceManager(id, space)?.peekActive();
    if (!tab) return;
    this.#devtools.closeForTab(tab.id);
    this.reapplySplitBounds(id);
  }

  inspectAt(id: string, space: SpaceId, x: number, y: number): void {
    const target = this.#prepareDevToolsTarget(id, space, '检查元素');
    if (!target) return;
    this.#devtools.inspectAt(target.tab.id, target.wc, x, y);
    this.reapplySplitBounds(id);
  }

  setDevToolsDock(dock: DevToolsDockMode, size?: number): void {
    this.#devtools.setDockConfig(dock, size);
    if (this.#selected) this.reapplySplitBounds(this.#selected);
    if (typeof size === 'number' && Number.isFinite(size) && (dock === 'right' || dock === 'bottom')) {
      this.#deps.onDevToolsSizeCommitted?.(dock, this.#devtools.dockSize);
    }
  }

  setDevToolsTheme(theme: 'dark' | 'light'): void {
    this.#devtools.setTheme(theme);
  }

  getDevToolsState(): { open: boolean; dock: DevToolsDockMode; size: number } {
    return this.#devtools.state();
  }

  findInPage(id: string, space: SpaceId, text: string, options: { forward?: boolean; findNext?: boolean } = {}): void {
    const wc = this.#deps.getLifecycle().spaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (!text) {
      wc.stopFindInPage('clearSelection');
      this.#deps.onFindResult?.({ envId: id, requestId: 0, activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
      return;
    }
    wc.findInPage(text, {
      forward: options.forward ?? true,
      findNext: options.findNext ?? false,
    });
  }

  stopFindInPage(id: string, space: SpaceId): void {
    const wc = this.#deps.getLifecycle().spaceManager(id, space)?.peekActive()?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.stopFindInPage('clearSelection');
  }

  setZoom(id: string, space: SpaceId, mode: 'in' | 'out' | 'reset' | number): { factor: number } {
    const wc = this.#deps.getLifecycle().spaceManager(id, space)?.active()?.webContents;
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
    if (origin) this.#deps.store.setDomainPref(id, origin, { zoomFactor: next });
    this.#deps.onChange();
    return { factor: next };
  }

  getZoom(id: string, space: SpaceId): { factor: number } {
    const wc = this.#deps.getLifecycle().spaceManager(id, space)?.peekActive()?.webContents;
    if (!wc || wc.isDestroyed()) return { factor: 1 };
    return { factor: Math.round((wc.getZoomFactor() || 1) * 100) / 100 };
  }

  applyOriginZoom(id: string, tab: Tab, url: string): void {
    const origin = this.#originOf(url);
    const pref = origin ? this.#deps.store.domainPref(id, origin) : undefined;
    const wc = tab.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (pref && Math.abs(pref.zoomFactor - 1) > 0.001) {
      wc.setZoomFactor(pref.zoomFactor);
    }
    const targetPreset = pref?.viewportPreset ?? this.#presets.get(`${id}:${tab.space}`) ?? this.#defaultViewport;
    const layout = computeSimulatedPageBounds(this.#splitPageContainer(), targetPreset);
    const tabs = this.#deps.getLifecycle().spaceManager(id, tab.space);
    const controller = tabs?.controllerFor(tab.id);
    if (controller) void controller.setViewportPreset(layout.preset, layout.scale).catch(() => {});
    if (tabs && tabs.activeId === tab.id) {
      tabs.setViewport(layout.bounds);
      if (this.#selected === id && this.#deps.getLifecycle().activeSpaceOf(id) === tab.space) {
        this.#deps.getLeases().repositionShield(id, layout.bounds);
      }
      this.#deps.onChange();
    }
  }

  async setViewportPreset(id: string, space: SpaceId, preset: ViewportPresetId): Promise<{ preset: ViewportPresetId }> {
    const tabs = this.#deps.getLifecycle().spaceManager(id, space);
    const controller = tabs?.controller();
    const wc = tabs?.active()?.webContents;
    if (!tabs || !controller || !wc || wc.isDestroyed()) {
      throw Object.assign(new Error(`environment ${id} active tab is not ready`), { code: 'ENV_NOT_RUNNING' });
    }
    const layout = computeSimulatedPageBounds(this.#splitPageContainer(), preset);
    await controller.setViewportPreset(layout.preset, layout.scale);
    this.#presets.set(`${id}:${space}`, preset);
    const origin = this.#originOf(wc.getURL());
    if (origin) this.#deps.store.setDomainPref(id, origin, { viewportPreset: preset === 'auto' ? null : preset });
    tabs.setViewport(layout.bounds);
    if (this.#selected === id && this.#deps.getLifecycle().activeSpaceOf(id) === space) {
      this.#deps.getLeases().repositionShield(id, layout.bounds);
    }
    this.#deps.onChange();
    return { preset };
  }

  clearEnvPresets(id: string): void {
    this.#presets.delete(`${id}:person`);
    this.#presets.delete(`${id}:agent`);
  }

  getViewportPreset(id: string, space: SpaceId): { preset: ViewportPresetId } {
    const tabs = this.#deps.getLifecycle().spaceManager(id, space);
    const liveWc = tabs?.peekActive()?.webContents;
    const url = liveWc && !liveWc.isDestroyed() ? liveWc.getURL() : tabs?.activeState()?.url;
    const origin = url ? this.#originOf(url) : undefined;
    if (origin) {
      const saved = this.#deps.store.domainPref(id, origin)?.viewportPreset;
      if (saved) return { preset: saved };
    }
    return { preset: this.#presets.get(`${id}:${space}`) ?? this.#defaultViewport };
  }

  setDefaultPreferences(options: {
    dock?: DevToolsDockMode;
    defaultViewport?: ViewportPresetId;
    pageBorderRadius?: boolean;
    devtoolsRightSize?: number;
    devtoolsBottomSize?: number;
  }): void {
    if (options.dock) this.#devtools.setDefaultDock(options.dock);
    if (options.devtoolsRightSize !== undefined || options.devtoolsBottomSize !== undefined) {
      this.#devtools.setDefaultSizes({ right: options.devtoolsRightSize, bottom: options.devtoolsBottomSize });
    }
    if (options.defaultViewport) {
      this.#defaultViewport = options.defaultViewport;
      if (this.#selected) this.reapplySplitBounds(this.#selected);
    }
    if (typeof options.pageBorderRadius === 'boolean') {
      this.#layers.setPageRadius(options.pageBorderRadius ? 8 : 0);
    }
  }

  downloads(id?: string): DownloadItemInfo[] {
    return listDownloads(id);
  }

  revealDownload(downloadId: string): void {
    const target = getDownloadPath(downloadId);
    if (target) shell.showItemInFolder(target);
  }

  printPage(id: string, space: SpaceId): void {
    const wc = this.#deps.getLifecycle().spaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.print();
  }

  async savePageAs(id: string, space: SpaceId): Promise<{ saved: boolean; path?: string }> {
    const wc = this.#deps.getLifecycle().spaceManager(id, space)?.active()?.webContents;
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

  async handlePageContextMenu(id: string, space: SpaceId, tab: Tab, params: Electron.ContextMenuParams): Promise<void> {
    const wc = tab.webContents;
    if (!wc || wc.isDestroyed()) return;
    const canNavigate = this.#deps.getLeases().canHumanNavigate(id, space);
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

  focusWindow(): { x: number; y: number; width: number; height: number } {
    return this.#window.getBounds();
  }

  hideWindow(): void {
    this.#window.hide();
    if (process.platform === 'darwin') app.dock?.hide();
    this.#syncHiddenFocus();
    this.#deps.onChange();
  }

  showWindow(focus = false): void {
    this.#ensureOnScreen();
    if (focus) {
      if (process.platform === 'darwin') app.dock?.show();
      this.#window.show();
      this.#window.focus();
      this.focusDisplayedPage(undefined, { forceRealFocus: true });
    } else {
      this.#window.showInactive();
      this.#window.blur();
    }
    this.#deps.onChange();
  }

  focusDisplayedPage(id?: string, options?: { forceRealFocus?: boolean }): void {
    if (id && id !== this.#selected) return;
    const selected = this.#selected;
    if (!selected) return;
    this.restoreDisplayedFocus(this.#deps.getLifecycle().spaceManager(selected), options);
  }

  restoreDisplayedFocus(tabs: TabManagerLike | undefined, options?: { forceRealFocus?: boolean }): void {
    const liveTab = tabs?.peekActive ? tabs.peekActive() : tabs?.active();
    const wc = liveTab?.webContents;
    const ctrl = tabs?.peekController ? tabs.peekController() : tabs?.controller();
    const winVisible = !this.#window.isDestroyed() && this.#window.isVisible();
    const winFocused = !this.#window.isDestroyed() && this.#window.isFocused();
    if ((options?.forceRealFocus || (winVisible && winFocused)) && wc && !wc.isDestroyed()) {
      void ctrl?.clearEmulatedFocus().catch(() => {});
      wc.focus();
      return;
    }
    void ctrl?.emulateFocus().catch(() => {});
  }

  async focusForInput(id: string, space: SpaceId = 'agent'): Promise<void> {
    const tabs = this.#deps.getLifecycle().spaceManager(id, space);
    const controller = tabs?.controller();
    if (!controller || !tabs?.active()) return;
    const emulate = shouldEmulateRenderFocus({
      windowVisible: !this.#window.isDestroyed() && this.#window.isVisible(),
      windowFocused: !this.#window.isDestroyed() && this.#window.isFocused(),
      isSelected: id === this.#selected,
      isActiveSpace: space === this.#deps.getLifecycle().activeSpaceOf(id),
      mountedInHiddenHost: tabs.attachedBelow,
    });
    if (!emulate) {
      void controller.clearEmulatedFocus().catch(() => {});
      controller.webContents.focus();
      return;
    }
    await controller.emulateFocus().catch(() => {});
  }

  /** 确保隐藏/失焦/后台视图的合成器与 rAF 保持唤醒以便截图；不抢前台且不夺取地址栏键盘焦点。 */
  async ensureRenderFocus(id: string, space: SpaceId = 'agent'): Promise<void> {
    const tabs = this.#deps.getLifecycle().spaceManager(id, space);
    const controller = tabs?.controller();
    if (!controller || !tabs?.active()) return;
    const emulate = shouldEmulateRenderFocus({
      windowVisible: !this.#window.isDestroyed() && this.#window.isVisible(),
      windowFocused: !this.#window.isDestroyed() && this.#window.isFocused(),
      isSelected: id === this.#selected,
      isActiveSpace: space === this.#deps.getLifecycle().activeSpaceOf(id),
      mountedInHiddenHost: tabs.attachedBelow,
    });
    if (!emulate) return;
    await controller.emulateFocus().catch(() => {});
  }

  evalInRenderer<T = unknown>(script: string): Promise<T> {
    return this.#window.webContents.executeJavaScript(script, true) as Promise<T>;
  }

  sendShortcut(shortcut: BrowserShortcut): void {
    if (shortcut === 'focusAddress' && !this.#window.isDestroyed()) {
      this.#window.webContents.focus();
    }
    this.#window.webContents.send('browser:shortcut', shortcut);
  }

  layout(): {
    viewport: ViewportRect;
    selected?: string;
    viewBounds?: unknown;
    showing: string[];
    attachedBelow: string[];
    focusedEnv?: string;
    windowFocused: boolean;
    windowVisible: boolean;
    windowBounds: { x: number; y: number; width: number; height: number };
    windowOpacity: number;
    telemetryWrite: { writes: number; ms: number };
    viewVisible: boolean;
    devToolsOpen: boolean;
    webContents: number;
    running: number;
    maxRunning: number;
    shieldAttached: boolean;
    owner: ControlOwner;
    activeSpace?: SpaceId;
    spaces: Array<{ envId: string; space: SpaceId; showing: boolean; attachedBelow: boolean }>;
  } {
    const lifecycle = this.#deps.getLifecycle();
    const leases = this.#deps.getLeases();
    const tabs = this.#selected ? lifecycle.spaceManager(this.#selected) : undefined;
    const entries = lifecycle.allSpacesEntries();
    const allSpaces = entries.flatMap(([envId, spaces]) =>
      SPACE_IDS.map((space) => ({
        envId,
        space,
        showing: spaces[space].showing,
        attachedBelow: spaces[space].attachedBelow,
      })),
    );
    const entryMap = new Map(entries);
    const owner: ControlOwner = this.#selected ? (leases.rawLease(this.#selected)?.owner ?? 'none') : 'none';
    return {
      viewport: this.#layers.viewport(),
      selected: this.#selected,
      viewBounds: tabs?.peekActive()?.view.getBounds(),
      showing: [...new Set(allSpaces.filter((item) => item.showing).map((item) => item.envId))],
      attachedBelow: [...new Set(allSpaces.filter((item) => item.attachedBelow).map((item) => item.envId))],
      focusedEnv:
        allSpaces.find((item) => entryMap.get(item.envId)?.[item.space].peekActive()?.webContents?.isFocused())
          ?.envId ?? (this.#selected && tabs?.showing ? this.#selected : undefined),
      windowFocused: this.#window.isFocused(),
      windowVisible: this.#window.isVisible(),
      windowBounds: this.#window.getBounds(),
      windowOpacity: this.#window.getOpacity(),
      telemetryWrite: this.#deps.sessions.telemetryWriteStats,
      viewVisible: tabs?.viewVisible ?? true,
      devToolsOpen: this.#devtools.isOpen() || (tabs?.devToolsOpen ?? false),
      webContents: webContents.getAllWebContents().length,
      running: entries.length,
      maxRunning: lifecycle.maxRunning,
      shieldAttached: this.#selected ? leases.shieldAttached(this.#selected) : false,
      owner,
      activeSpace: this.#selected ? lifecycle.activeSpaceOf(this.#selected) : undefined,
      spaces: allSpaces,
    };
  }

  #requireTabs(id: string, space: SpaceId = this.#deps.getLifecycle().activeSpaceOf(id)): TabManager {
    const tabs = this.#deps.getLifecycle().spaceManager(id, space);
    if (!tabs) {
      throw Object.assign(new Error(`environment ${id} is not running`), { code: 'ENV_NOT_RUNNING' });
    }
    return tabs;
  }

  #afterTabChange(id: string): void {
    if (this.#selected === id) {
      this.#devtools.activateTab(this.#deps.getLifecycle().spaceManager(id)?.activeId);
      this.reapplySplitBounds(id);
      this.#deps.getLeases().syncShield(id);
      this.#syncDisplayedVisibilityFocus();
    }
    this.#deps.onChange();
  }

  #prepareDevToolsTarget(
    id: string,
    space: SpaceId,
    busyVerb: string,
  ): { tab: Tab; wc: Electron.WebContents } | undefined {
    if (space === 'agent' && this.#deps.getLeases().isAgentControlling(id)) {
      throw Object.assign(new Error(`ENV_BUSY: Agent 正在操作 ${id}，请先接管控制权再${busyVerb}`), {
        code: 'ENV_BUSY',
      });
    }
    const tab = this.#deps.getLifecycle().spaceManager(id, space)?.active();
    const wc = tab?.webContents;
    if (!tab || !wc || wc.isDestroyed()) return undefined;
    if (this.#selected !== id) this.select(id, space);
    else if (this.#deps.getLifecycle().activeSpaceOf(id) !== space) this.selectSpace(id, space);
    return { tab, wc };
  }

  #detachSelected(): void {
    if (!this.#selected) return;
    this.#devtools.activateTab(undefined);
    this.#deps.getLifecycle().spaceManager(this.#selected)?.detach();
    this.#deps.getLeases().detachShieldOnly(this.#selected);
  }

  #syncAfterDevToolsChange(): void {
    if (this.#selected) this.reapplySplitBounds(this.#selected);
    this.#deps.onChange();
  }

  /**
   * 仅在窗口坐标完全脱离所有现存显示器（例如外接屏被物理拔掉）时，
   * 将窗口贴回距它最近的那块屏的工作区中央；窗口仍在任一显示器工作区内时保持原位不动。
   */
  #ensureOnScreen(): void {
    const bounds = this.#window.getBounds();
    const next = placeWindowOnItsDisplay(
      bounds,
      screen.getAllDisplays().map((display) => ({ bounds: display.bounds, workArea: display.workArea })),
    );
    if (next.x === bounds.x && next.y === bounds.y && next.width === bounds.width && next.height === bounds.height) {
      return;
    }
    this.#window.setBounds(next);
  }

  #syncHiddenFocus(): void {
    if (this.#window.isDestroyed() || !this.#selected) return;
    const tabs = this.#deps.getLifecycle().spaceManager(this.#selected);
    const ctrl = tabs?.peekController ? tabs.peekController() : tabs?.controller();
    void ctrl?.emulateFocus().catch(() => {});
  }

  #clearDisplayedEmulatedFocus(): void {
    if (this.#window.isDestroyed() || !this.#selected) return;
    const tabs = this.#deps.getLifecycle().spaceManager(this.#selected);
    const ctrl = tabs?.peekController ? tabs.peekController() : tabs?.controller();
    void ctrl?.clearEmulatedFocus().catch(() => {});
  }

  #syncDisplayedVisibilityFocus(): void {
    if (this.#window.isDestroyed() || !this.#selected) return;
    if (!this.#window.isVisible()) this.#syncHiddenFocus();
    else if (this.#window.isFocused()) this.#clearDisplayedEmulatedFocus();
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
}

function parseSplitterInput(raw: unknown): DevToolsSplitterInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const msg = raw as Record<string, unknown>;
  if (msg.type === 'reset') return { type: 'reset' };
  if (msg.type !== 'start' && msg.type !== 'move' && msg.type !== 'end') return undefined;
  const screenX = Number(msg.screenX);
  const screenY = Number(msg.screenY);
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return undefined;
  if (msg.type === 'end') {
    return { type: 'end', screenX, screenY, cancel: Boolean(msg.cancel) };
  }
  return { type: msg.type, screenX, screenY };
}
