import { app, clipboard, dialog, screen, shell, webContents, type BrowserWindow, type Session } from 'electron';
import type { X509Certificate } from 'node:crypto';
import { buildPageContextMenu } from '../browser-context-menu.ts';
import { BrowserController } from '../browser/controller.ts';
import { getDownloadPath, listDownloads } from '../browser/downloads.ts';
import type { EnvPending } from '../browser/pending.ts';
import { makeEvent } from '../domain/environment.ts';
import { nextViewTransition } from '../environment-view-state.ts';
import type { Store } from '../store.ts';
import { TabManager, newTabUrl, type Tab, type TabListItem } from '../tabs.ts';
import { DevToolsHost } from '../ui/devtools-host.ts';
import { WindowLayerManager } from '../ui/layer-manager.ts';
import { popupNativeMenu } from '../ui/native-menu.ts';
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
import { SPACE_IDS, redactBusUrl, type EnvironmentSpaces } from './lifecycle.ts';
import type { TabManagerLike } from './lease-coordinator.ts';

export interface ViewCoordinatorDeps {
  window: BrowserWindow;
  layers?: WindowLayerManager;
  store: Pick<Store, 'domainPref' | 'setDomainPref' | 'record' | 'recordUrlHistory'>;
  getSpaces: (id: string) => EnvironmentSpaces | undefined;
  allSpacesEntries: () => Array<[string, EnvironmentSpaces]>;
  getSpaceManager: (id: string, space?: SpaceId) => TabManager | undefined;
  getActiveSpace: (id: string) => SpaceId;
  touch: (id: string) => void;
  rememberRunning: () => void;
  rememberTabs: (id: string) => void;
  onSpaceEmpty: (id: string, space: SpaceId) => void;
  onChange: () => void;
  onTargetUrl?: (payload: { envId: string; url: string }) => void;
  onFindResult?: (result: FindInPageResult) => void;
  emitBusEvent: (type: PluginBusEventType, environmentId: string, payload: Record<string, unknown>) => void;
  attachTabTelemetry: (envId: string, tabId: string, wc: Electron.WebContents) => void;
  detachTabTelemetry: (tabId: string) => void;
  lastActivityAt: (tabId: string) => number;
  syncShield: (id: string, options?: { createIfMissing?: boolean }) => void;
  detachShieldOnly: (id: string) => void;
  repositionShield: (id: string, bounds: ViewportRect) => void;
  setShieldVisible: (id: string, visible: boolean) => void;
  isAgentControlling: (id: string) => boolean;
  canHumanNavigate: (id: string, space: SpaceId) => boolean;
  assertAgentHumanWritable: (id: string) => void;
  getLayoutExtra: (selected?: string) => {
    telemetryWrite: { writes: number; ms: number };
    maxRunning: number;
    shieldAttached: boolean;
    owner: ControlOwner;
  };
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
  #devtools: DevToolsHost;
  #viewport: ViewportRect = { x: 0, y: 0, width: 800, height: 600 };
  #backgroundBounds?: { x: number; y: number; width: number; height: number };
  #selected?: string;
  #viewVisible = true;
  #presets = new Map<string, ViewportPresetId>();

  constructor(deps: ViewCoordinatorDeps) {
    this.#deps = deps;
    this.#window = deps.window;
    this.#layers = deps.layers ?? new WindowLayerManager(deps.window);
    this.#devtools = new DevToolsHost(this.#layers, () => this.#syncAfterDevToolsChange());
  }

  get layers(): WindowLayerManager {
    return this.#layers;
  }

  get selected(): string | undefined {
    return this.#selected;
  }

  get viewVisible(): boolean {
    return this.#viewVisible;
  }

  get viewport(): ViewportRect {
    return this.#viewport;
  }

  pageBounds(): ViewportRect {
    return this.#devtools.computeSplitBounds().page;
  }

  clearSelectedIf(id: string): void {
    if (this.#selected === id) this.#selected = undefined;
  }

  /** 为指定环境与 Space 构建 `TabManager`，接入遥测、总线事件、缩放到位与右键菜单。 */
  createSpaceManager(
    id: string,
    space: SpaceId,
    ses: Session,
    trustedCa: X509Certificate | undefined,
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
        this.#deps.onChange();
        this.#deps.rememberTabs(id);
      },
      onViewChanged: () => {
        if (this.#selected === id && this.#deps.getActiveSpace(id) === space) {
          this.#devtools.activateTab(this.#deps.getSpaceManager(id, space)?.activeId);
          this.reapplySplitBounds(id);
          this.#deps.syncShield(id);
        }
      },
      onEmpty: () => this.#deps.onSpaceEmpty(id, space),
      onEvent: (type, message) => {
        this.#deps.store.record(makeEvent(type, message, 'system', id));
        this.#deps.onChange();
      },
      onPopup: (tabId, url) => {
        const index =
          (this.#deps
            .getSpaceManager(id, space)
            ?.list()
            .findIndex((tab) => tab.id === tabId) ?? -1) + 1;
        pending.notePopup({ tabId, index, url, at: new Date().toISOString() });
        this.#deps.emitBusEvent('tab.created', id, { tabId, space, url: redactBusUrl(url) });
      },
      onUrlVisited: (url) => this.#deps.store.recordUrlHistory(url),
      onOriginZoomNeeded: (tab, url) => this.applyOriginZoom(id, tab, url),
      onTargetUrl: (url) => {
        if (this.#selected === id && this.#deps.getActiveSpace(id) === space) {
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
          this.#deps.attachTabTelemetry(id, tabId, wc);
        } catch {
          // 遥测挂不上不能影响环境启动
        }
        wc.on('did-navigate', (_event, url) => {
          this.#deps.emitBusEvent('nav.committed', id, { tabId, space, url: redactBusUrl(url) });
        });
        wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
          if (isMainFrame) {
            this.#deps.emitBusEvent('nav.committed', id, { tabId, space, url: redactBusUrl(url) });
          }
        });
        const controller = new BrowserController(wc, {
          envId: id,
          tabId,
          tabIndex: () =>
            this.#deps
              .getSpaceManager(id, space)
              ?.list()
              .findIndex((tab) => tab.id === tabId) ?? -1,
          pending: pending.sinkFor(wc),
          lastActivityAt: () => this.#deps.lastActivityAt(tabId),
          downloadById: (downloadId) => pending.downloadById(downloadId),
          record: (type, message) => {
            this.#deps.store.record(makeEvent(type, message, 'agent', id));
          },
        });
        controller.attach();
        return controller;
      },
      onTabDestroyed: (tabId) => {
        this.#deps.detachTabTelemetry(tabId);
        this.#devtools.closeForTab(tabId);
      },
    });
  }

  // ── 标签与导航 ─────────────────────────────────────────────────────

  controllerFor(id: string, ref?: TabRef, space: SpaceId = 'agent'): BrowserController {
    this.#deps.touch(id);
    const tabs = this.#deps.getSpaceManager(id, space);
    if (!tabs) {
      throw Object.assign(new Error(`environment ${id} is not running`), { code: 'ENV_NOT_RUNNING' });
    }
    if (space === 'agent' && !tabs.active()) {
      const visibleUrl = this.#deps.getSpaceManager(id, 'person')?.active()?.state.url;
      tabs.create({ url: visibleUrl || newTabUrl(id) });
    }
    const controller = tabs.controllerFor(ref);
    if (!controller) {
      throw Object.assign(new Error(`tab not found: ${String(ref ?? 'active')}`), { code: 'TAB_NOT_FOUND' });
    }
    return controller;
  }

  tabsOf(id: string, space?: SpaceId): TabListItem[] {
    return this.#deps.getSpaceManager(id, space)?.list() ?? [];
  }

  newTab(
    id: string,
    url?: string,
    options: { activate?: boolean } = {},
    space: SpaceId = this.#deps.getActiveSpace(id),
  ): TabListItem {
    const tabs = this.#requireTabs(id, space);
    const target = url ?? newTabUrl(id);
    const tab = tabs.create({ url: target, activate: options.activate ?? true });
    this.#deps.store.record(makeEvent('tab.created', `${id} 新建标签：${target}`, 'human', id));
    this.#deps.emitBusEvent('tab.created', id, { tabId: tab.id, space, url: redactBusUrl(target) });
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

  reopenTab(id: string, space: SpaceId = this.#deps.getActiveSpace(id)): TabListItem {
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
    return tabs.item(tab.id);
  }

  closeTab(id: string, space: SpaceId, ref: TabRef): void {
    const tabs = this.#requireTabs(id, space);
    if (!tabs.close(ref)) throw Object.assign(new Error(`tab not found: ${String(ref)}`), { code: 'TAB_NOT_FOUND' });
    this.#afterTabChange(id);
  }

  navState(id: string, space: SpaceId = this.#deps.getActiveSpace(id)): NavigationState | undefined {
    return this.#deps.getSpaceManager(id, space)?.controller()?.navigationState();
  }

  humanNavigate(id: string, action: NavigationAction, space: SpaceId = this.#deps.getActiveSpace(id)): NavigationState {
    if (space === 'agent') this.#deps.assertAgentHumanWritable(id);
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
    const spaces = this.#deps.getSpaces(id);
    if (!spaces) {
      throw Object.assign(new Error(`environment ${id} is not running`), { code: 'ENV_NOT_RUNNING' });
    }
    if (!SPACE_IDS.includes(space)) {
      throw Object.assign(new Error(`unknown space ${String(space)}`), { code: 'BAD_REQUEST' });
    }
    if (spaces.active === space) return;
    this.#deps.touch(id);
    if (this.#selected === id) spaces[spaces.active].detach();
    spaces.active = space;
    if (this.#selected === id) {
      this.#devtools.activateTab(spaces[space].activeId);
      const split = this.#devtools.computeSplitBounds();
      spaces[space].attach();
      spaces[space].setViewVisible(this.#viewVisible);
      spaces[space].setViewport(split.page);
      this.#layers.setVisible('devtools', this.#viewVisible && this.#devtools.isOpen());
      this.#deps.syncShield(id);
    }
    this.#deps.onChange();
  }

  /** 选中不等于获得写权限：只负责把该环境的当前标签放进右侧区域。 */
  select(id: string, space?: SpaceId): void {
    const spaces = this.#deps.getSpaces(id);
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
    this.#deps.touch(id);
    this.#deps.rememberRunning();

    if (!attachTarget || !target) {
      this.#devtools.activateTab(undefined);
      this.#deps.onChange();
      return;
    }

    target.attach();
    target.setViewVisible(this.#viewVisible);
    this.#devtools.activateTab(target.activeId);
    target.setViewport(this.#devtools.computeSplitBounds().page);
    this.#layers.setVisible('devtools', this.#viewVisible && this.#devtools.isOpen());

    this.#deps.syncShield(id, { createIfMissing: true });
    this.#deps.onChange();
  }

  setViewport(viewport: ViewportRect): void {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    this.#viewport = viewport;
    this.#devtools.setViewport(viewport);
    const split = this.#devtools.computeSplitBounds();
    if (this.#selected) {
      this.#deps.getSpaceManager(this.#selected)?.setViewport(split.page);
      this.#deps.repositionShield(this.#selected, split.page);
    }
  }

  async capturePage(): Promise<string | null> {
    const wc = this.#selected ? this.#deps.getSpaceManager(this.#selected)?.active()?.webContents : undefined;
    if (!wc || wc.isDestroyed()) return null;
    const image = await wc.capturePage();
    if (image.isEmpty()) return null;
    return `data:image/jpeg;base64,${image.toJPEG(92).toString('base64')}`;
  }

  setViewVisible(visible: boolean): void {
    this.#viewVisible = visible;
    if (this.#selected) {
      this.#deps.getSpaceManager(this.#selected)?.setViewVisible(visible);
      this.#deps.setShieldVisible(this.#selected, visible);
    }
    this.#layers.setVisible('devtools', visible && this.#devtools.isOpen());
  }

  reapplySplitBounds(id: string): void {
    if (this.#selected !== id) return;
    const split = this.#devtools.computeSplitBounds();
    this.#deps.getSpaceManager(id)?.setViewport(split.page);
    this.#deps.repositionShield(id, split.page);
  }

  closeEnvDevTools(spaces: EnvironmentSpaces): void {
    for (const space of SPACE_IDS) {
      for (const tab of spaces[space].list()) {
        this.#devtools.closeForTab(tab.id);
      }
    }
  }

  destroyAllDevTools(): void {
    this.#devtools.destroyAll();
  }

  openDevTools(id: string, space: SpaceId = 'agent', dock?: DevToolsDockMode): void {
    const target = this.#prepareDevToolsTarget(id, space, '打开开发者工具');
    if (!target) return;
    this.#devtools.openForTab(target.tab.id, target.wc, dock);
    this.reapplySplitBounds(id);
  }

  closeDevTools(id: string, space: SpaceId = 'agent'): void {
    const tab = this.#deps.getSpaceManager(id, space)?.active();
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
  }

  getDevToolsState(): { open: boolean; dock: DevToolsDockMode; size: number } {
    return this.#devtools.state();
  }

  findInPage(id: string, space: SpaceId, text: string, options: { forward?: boolean; findNext?: boolean } = {}): void {
    const wc = this.#deps.getSpaceManager(id, space)?.active()?.webContents;
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
    const wc = this.#deps.getSpaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.stopFindInPage('clearSelection');
  }

  setZoom(id: string, space: SpaceId, mode: 'in' | 'out' | 'reset' | number): { factor: number } {
    const wc = this.#deps.getSpaceManager(id, space)?.active()?.webContents;
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
    const wc = this.#deps.getSpaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return { factor: 1 };
    return { factor: Math.round((wc.getZoomFactor() || 1) * 100) / 100 };
  }

  applyOriginZoom(id: string, tab: Tab, url: string): void {
    const origin = this.#originOf(url);
    if (!origin) return;
    const pref = this.#deps.store.domainPref(id, origin);
    const wc = tab.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (pref && Math.abs(pref.zoomFactor - 1) > 0.001) {
      wc.setZoomFactor(pref.zoomFactor);
    }
  }

  async setViewportPreset(id: string, space: SpaceId, preset: ViewportPresetId): Promise<{ preset: ViewportPresetId }> {
    const tabs = this.#deps.getSpaceManager(id, space);
    const controller = tabs?.controller();
    const wc = tabs?.active()?.webContents;
    if (!controller || !wc || wc.isDestroyed()) {
      throw Object.assign(new Error(`environment ${id} active tab is not ready`), { code: 'ENV_NOT_RUNNING' });
    }
    await controller.setViewportPreset(preset);
    this.#presets.set(`${id}:${space}`, preset);
    const origin = this.#originOf(wc.getURL());
    if (origin) this.#deps.store.setDomainPref(id, origin, { viewportPreset: preset === 'auto' ? null : preset });
    this.#deps.onChange();
    return { preset };
  }

  getViewportPreset(id: string, space: SpaceId): { preset: ViewportPresetId } {
    const wc = this.#deps.getSpaceManager(id, space)?.active()?.webContents;
    const origin = wc && !wc.isDestroyed() ? this.#originOf(wc.getURL()) : undefined;
    if (origin) {
      const saved = this.#deps.store.domainPref(id, origin)?.viewportPreset;
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
    const wc = this.#deps.getSpaceManager(id, space)?.active()?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.print();
  }

  async savePageAs(id: string, space: SpaceId): Promise<{ saved: boolean; path?: string }> {
    const wc = this.#deps.getSpaceManager(id, space)?.active()?.webContents;
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
    const canNavigate = this.#deps.canHumanNavigate(id, space);
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
  }

  backgroundWindow(): void {
    this.#ensureOnScreen();
    this.#backgroundBounds ??= this.#window.getBounds();
    this.#window.blur();
    this.#window.setSkipTaskbar(true);
    if (process.platform === 'darwin') this.#window.setHiddenInMissionControl(true);
    this.#window.setPosition(-10000, -10000);
    this.#window.setOpacity(0);
    this.#window.setIgnoreMouseEvents(true);
    this.#window.showInactive();
    if (process.platform === 'darwin') app.dock?.hide();
  }

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
    this.#deps.onChange();
  }

  focusDisplayedPage(id?: string): void {
    if (id && id !== this.#selected) return;
    const selected = this.#selected;
    if (!selected) return;
    this.restoreDisplayedFocus(this.#deps.getSpaceManager(selected));
  }

  restoreDisplayedFocus(tabs: TabManagerLike | undefined): void {
    const wc = tabs?.active()?.webContents;
    if (this.#window.isFocused() && wc && !wc.isDestroyed()) {
      wc.focus();
      return;
    }
    void tabs
      ?.controller()
      ?.emulateFocus()
      .catch(() => {});
  }

  async focusForInput(id: string, space: SpaceId = 'agent'): Promise<void> {
    const tabs = this.#deps.getSpaceManager(id, space);
    const controller = tabs?.controller();
    if (!controller || !tabs?.active()) return;
    if (this.#window.isFocused() && id === this.#selected && space === this.#deps.getActiveSpace(id)) {
      controller.webContents.focus();
      return;
    }
    await controller.emulateFocus().catch(() => {});
  }

  evalInRenderer<T = unknown>(script: string): Promise<T> {
    return this.#window.webContents.executeJavaScript(script, true) as Promise<T>;
  }

  sendShortcut(shortcut: BrowserShortcut): void {
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
    const tabs = this.#selected ? this.#deps.getSpaceManager(this.#selected) : undefined;
    const entries = this.#deps.allSpacesEntries();
    const allSpaces = entries.flatMap(([envId, spaces]) =>
      SPACE_IDS.map((space) => ({
        envId,
        space,
        showing: spaces[space].showing,
        attachedBelow: spaces[space].attachedBelow,
      })),
    );
    const extra = this.#deps.getLayoutExtra(this.#selected);
    const entryMap = new Map(entries);
    return {
      viewport: this.#viewport,
      selected: this.#selected,
      viewBounds: tabs?.active()?.view.getBounds(),
      showing: [...new Set(allSpaces.filter((item) => item.showing).map((item) => item.envId))],
      attachedBelow: [...new Set(allSpaces.filter((item) => item.attachedBelow).map((item) => item.envId))],
      focusedEnv:
        allSpaces.find((item) => entryMap.get(item.envId)?.[item.space].active()?.webContents?.isFocused())?.envId ??
        (this.#selected && tabs?.showing ? this.#selected : undefined),
      windowFocused: this.#window.isFocused(),
      windowVisible: this.#window.isVisible(),
      windowBounds: this.#window.getBounds(),
      windowOpacity: this.#window.getOpacity(),
      telemetryWrite: extra.telemetryWrite,
      viewVisible: tabs?.viewVisible ?? true,
      devToolsOpen: this.#devtools.isOpen() || (tabs?.devToolsOpen ?? false),
      webContents: webContents.getAllWebContents().length,
      running: entries.length,
      maxRunning: extra.maxRunning,
      shieldAttached: extra.shieldAttached,
      owner: extra.owner,
      activeSpace: this.#selected ? this.#deps.getActiveSpace(this.#selected) : undefined,
      spaces: allSpaces,
    };
  }

  #requireTabs(id: string, space: SpaceId = this.#deps.getActiveSpace(id)): TabManager {
    const tabs = this.#deps.getSpaceManager(id, space);
    if (!tabs) {
      throw Object.assign(new Error(`environment ${id} is not running`), { code: 'ENV_NOT_RUNNING' });
    }
    return tabs;
  }

  #afterTabChange(id: string): void {
    if (this.#selected === id) {
      this.#devtools.activateTab(this.#deps.getSpaceManager(id)?.activeId);
      this.reapplySplitBounds(id);
      this.#deps.syncShield(id);
    }
    this.#deps.onChange();
  }

  #prepareDevToolsTarget(
    id: string,
    space: SpaceId,
    busyVerb: string,
  ): { tab: Tab; wc: Electron.WebContents } | undefined {
    if (space === 'agent' && this.#deps.isAgentControlling(id)) {
      throw Object.assign(new Error(`ENV_BUSY: Agent 正在操作 ${id}，请先接管控制权再${busyVerb}`), {
        code: 'ENV_BUSY',
      });
    }
    const tab = this.#deps.getSpaceManager(id, space)?.active();
    const wc = tab?.webContents;
    if (!tab || !wc || wc.isDestroyed()) return undefined;
    if (this.#selected !== id) this.select(id, space);
    else if (this.#deps.getActiveSpace(id) !== space) this.selectSpace(id, space);
    return { tab, wc };
  }

  #detachSelected(): void {
    if (!this.#selected) return;
    this.#devtools.activateTab(undefined);
    this.#deps.getSpaceManager(this.#selected)?.detach();
    this.#deps.detachShieldOnly(this.#selected);
  }

  #syncAfterDevToolsChange(): void {
    if (this.#selected) this.reapplySplitBounds(this.#selected);
    this.#deps.onChange();
  }

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
