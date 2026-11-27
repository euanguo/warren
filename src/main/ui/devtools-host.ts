import type { WebContents, WebContentsView } from 'electron';
import {
  clampConfiguredDevToolsSize,
  clampDevToolsSize,
  computeDevToolsSplitBounds,
  defaultDevToolsSize,
  DEVTOOLS_BOTTOM_SIZE,
  DEVTOOLS_RIGHT_SIZE,
  isDockedDevToolsMode,
  type DevToolsSplitBounds,
  type DockedDevToolsMode,
} from '../../shared/devtools-layout.ts';
import type { DevToolsDockMode, ViewportRect } from '../../shared/types.ts';
import { buildDevToolsSplitterHtml, type DevToolsSplitterState } from './devtools-splitter.ts';
import type { WindowLayerManager } from './layer-manager.ts';

export type DockViewFactory = () => WebContentsView;
export type SplitterViewFactory = () => WebContentsView;

export type DevToolsSplitterInput =
  | { type: 'start'; screenX: number; screenY: number }
  | { type: 'move'; screenX: number; screenY: number }
  | { type: 'end'; screenX: number; screenY: number; cancel?: boolean }
  | { type: 'reset' };

export interface DevToolsHostOptions {
  createSplitterView?: SplitterViewFactory;
  /** 由外部 ViewCoordinator 统一计算模拟视口（如 mobile-390）并下发 page bounds 时设为 false，防止覆写模拟框尺寸。 */
  managePageBounds?: boolean;
  onLayoutChanged?: () => void;
  onSizeCommitted?: (mode: DockedDevToolsMode, size: number) => void;
  initialSizes?: { right?: number; bottom?: number };
  theme?: 'dark' | 'light';
}

interface DockEntry {
  tabId: string;
  targetWc: WebContents;
  dockView?: WebContentsView;
  mode: DevToolsDockMode;
  open: boolean;
  closing?: boolean;
  disposeListeners: () => void;
}

interface ActiveDragState {
  mode: DockedDevToolsMode;
  startScreenX: number;
  startScreenY: number;
  startSize: number;
  initialRawSize: number;
}

const CLOSE_SETTLE_TIMEOUT_MS = 500;

/**
 * 停靠式原生 Chrome DevTools 宿主。
 *
 * 突破此前 `openDevTools({ mode: 'right' })` 对 `WebContentsView` 不生效的限制：
 * 使用 Electron `wc.setDevToolsWebContents(devToolsView.webContents)` 将原版 DevTools
 * 渲染进专用 `WebContentsView`，纳入 `WindowLayerManager` 的 `'devtools'` 槽位管理，
 * 并通过 `'splitter'` 透明拖拽层承接停靠缝隙处的跨视图拖拽与光标锁定，
 * 严格随 Tab / Environment 销毁，避免官方文档警告的手动释放遗漏。
 *
 * 注意：Electron 对自定义 `setDevToolsWebContents` 的宿主不会让 `targetWc.isDevToolsOpened()`
 * 返回 `true`，因此停靠态的开启判定、分栏裁剪与关闭清理以宿主自身状态为准，仅 `detach`
 * 独立窗口模式才委托原生 `isDevToolsOpened()`。
 */
export class DevToolsHost {
  #layers: WindowLayerManager;
  #createDockView: DockViewFactory;
  #createSplitterView?: SplitterViewFactory;
  #isHostFocused: () => boolean;
  #onStateChanged: () => void;
  #managePageBounds: boolean;
  #onLayoutChanged?: () => void;
  #onSizeCommitted?: (mode: DockedDevToolsMode, size: number) => void;
  #dockMode: DevToolsDockMode = 'right';
  #lastDockedMode: DockedDevToolsMode = 'right';
  #sizes: Record<DockedDevToolsMode, number>;
  #theme: 'dark' | 'light';
  #entries = new Map<string, DockEntry>();
  #closingByTarget = new WeakMap<WebContents, Promise<void>>();
  #openToken = new Map<string, number>();
  #activeTabId?: string;
  #viewport: ViewportRect = { x: 0, y: 0, width: 800, height: 600 };
  #splitterView?: WebContentsView;
  #splitterReady = false;
  #dragState?: ActiveDragState;
  #disposeSplitterListeners?: () => void;

  constructor(
    layers: WindowLayerManager,
    onStateChanged: () => void,
    createDockView: DockViewFactory,
    isHostFocused: () => boolean = () => true,
    options?: DevToolsHostOptions,
  ) {
    this.#layers = layers;
    this.#onStateChanged = onStateChanged;
    this.#createDockView = createDockView;
    this.#isHostFocused = isHostFocused;
    this.#createSplitterView = options?.createSplitterView;
    this.#managePageBounds = options?.managePageBounds ?? true;
    this.#onLayoutChanged = options?.onLayoutChanged;
    this.#onSizeCommitted = options?.onSizeCommitted;
    this.#theme = options?.theme ?? 'dark';
    this.#sizes = {
      right: clampConfiguredDevToolsSize('right', options?.initialSizes?.right ?? DEVTOOLS_RIGHT_SIZE.default),
      bottom: clampConfiguredDevToolsSize('bottom', options?.initialSizes?.bottom ?? DEVTOOLS_BOTTOM_SIZE.default),
    };
  }

  get dockMode(): DevToolsDockMode {
    return this.#dockMode;
  }

  get dockSize(): number {
    return this.#currentDockSize();
  }

  get isDragging(): boolean {
    return Boolean(this.#dragState);
  }

  splitterWebContents(): WebContents | undefined {
    if (!this.#splitterView) return undefined;
    const wc = this.#splitterView.webContents as WebContents | undefined;
    return wc && !wc.isDestroyed() ? wc : undefined;
  }

  setTheme(theme: 'dark' | 'light'): void {
    if (this.#theme === theme) return;
    this.#theme = theme;
    this.#syncSplitterUi();
  }

  setDefaultSizes(sizes: { right?: number; bottom?: number }): void {
    if (this.#dragState) return;
    let changed = false;
    if (typeof sizes.right === 'number' && Number.isFinite(sizes.right)) {
      const next = clampConfiguredDevToolsSize('right', sizes.right);
      if (next !== this.#sizes.right) {
        this.#sizes.right = next;
        changed = true;
      }
    }
    if (typeof sizes.bottom === 'number' && Number.isFinite(sizes.bottom)) {
      const next = clampConfiguredDevToolsSize('bottom', sizes.bottom);
      if (next !== this.#sizes.bottom) {
        this.#sizes.bottom = next;
        changed = true;
      }
    }
    if (changed) {
      this.#layoutActive();
    }
  }

  setViewport(viewport: ViewportRect): void {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    this.#viewport = viewport;
    this.#layoutActive();
  }

  /** 更新默认停靠方向；若当前未开启任何 DevTools 则同步切过去，不影响正在使用中的会话。 */
  setDefaultDock(mode: DevToolsDockMode): void {
    if (this.isOpen() || this.#dockMode === mode) return;
    this.#dockMode = mode;
    if (isDockedDevToolsMode(mode)) this.#lastDockedMode = mode;
    this.#onStateChanged();
  }

  setDockConfig(mode: DevToolsDockMode, size?: number): void {
    this.cancelDrag();
    const prevMode = this.#dockMode;
    this.#dockMode = mode;
    if (isDockedDevToolsMode(mode)) {
      this.#lastDockedMode = mode;
    }
    let sizeChanged = false;
    if (typeof size === 'number' && Number.isFinite(size)) {
      const targetMode = isDockedDevToolsMode(mode) ? mode : this.#lastDockedMode;
      const nextSize = clampConfiguredDevToolsSize(targetMode, size);
      if (nextSize !== this.#sizes[targetMode]) {
        this.#sizes[targetMode] = nextSize;
        sizeChanged = true;
      }
    }
    const active = this.#activeTabId ? this.#entries.get(this.#activeTabId) : undefined;
    if (active && this.#isEntryOpen(active) && active.mode !== mode) {
      // right <-> bottom 直接复用现有 dockView 重算分栏，避免销毁重建与页面闪烁
      if (
        active.mode !== 'detach' &&
        mode !== 'detach' &&
        active.dockView &&
        !active.dockView.webContents.isDestroyed()
      ) {
        active.mode = mode;
        this.#layers.setSlot('devtools', active.dockView, { visible: this.#desiredSlotVisible() });
        this.#ensureSplitterAttached();
        this.#layoutActive();
        this.#onStateChanged();
        return;
      }
      const wc = active.targetWc;
      this.closeForTab(active.tabId);
      if (!wc.isDestroyed()) this.openForTab(active.tabId, wc, mode);
      return;
    }
    if (prevMode !== mode || sizeChanged || typeof size === 'number') {
      this.#layoutActive();
      this.#onStateChanged();
    }
  }

  isOpen(tabId?: string): boolean {
    const id = tabId ?? this.#activeTabId;
    if (!id) return false;
    return this.#isEntryOpen(this.#entries.get(id));
  }

  isDockedOpen(tabId?: string): boolean {
    const id = tabId ?? this.#activeTabId;
    if (!id) return false;
    const entry = this.#entries.get(id);
    return Boolean(this.#isEntryOpen(entry) && entry && entry.mode !== 'detach' && entry.dockView);
  }

  state(): { open: boolean; dock: DevToolsDockMode; size: number } {
    return {
      open: this.isOpen(),
      dock: this.#dockMode,
      size: this.#currentDockSize(),
    };
  }

  /** 同步 `'devtools'` 与 `'splitter'` 槽位可见态；隐藏时自动中止拖拽避免透明遮罩残留。 */
  syncVisibility(): void {
    const visible = this.#desiredSlotVisible();
    if (!visible && this.#dragState) {
      this.cancelDrag();
    }
    const docked = this.isDockedOpen();
    this.#layers.setVisible('devtools', visible && docked);
    this.#layers.setVisible('splitter', visible && docked);
    this.#layoutActive();
  }

  /** 将某个 Tab 设为当前展示舞台上的激活 Tab（隐藏其余 Tab 的 DevTools 视图）。 */
  activateTab(tabId: string | undefined): void {
    if (this.#activeTabId === tabId) {
      this.#layoutActive();
      return;
    }
    this.cancelDrag();
    this.#activeTabId = tabId;
    const entry = tabId ? this.#entries.get(tabId) : undefined;
    if (this.#isEntryOpen(entry) && entry && entry.mode !== 'detach' && entry.dockView) {
      this.#layers.setSlot('devtools', entry.dockView, { visible: this.#desiredSlotVisible() });
      this.#ensureSplitterAttached();
    } else {
      this.#layers.setSlot('devtools', undefined);
      this.#detachSplitter();
    }
    this.#layoutActive();
  }

  openForTab(tabId: string, targetWc: WebContents, overrideMode?: DevToolsDockMode): void {
    if (targetWc.isDestroyed()) return;
    this.cancelDrag();
    const mode = overrideMode ?? this.#dockMode;
    this.#dockMode = mode;
    if (isDockedDevToolsMode(mode)) this.#lastDockedMode = mode;
    this.#activeTabId = tabId;

    const existing = this.#entries.get(tabId);
    if (this.#isEntryOpen(existing) && existing) {
      if (existing.mode === mode) {
        if (mode === 'detach') {
          if (this.#isHostFocused()) existing.targetWc.devToolsWebContents?.focus();
        } else {
          this.activateTab(tabId);
        }
        return;
      }
      if (existing.mode !== 'detach' && mode !== 'detach' && existing.dockView) {
        existing.mode = mode;
        this.#layers.setSlot('devtools', existing.dockView, { visible: this.#desiredSlotVisible() });
        this.#ensureSplitterAttached();
        this.#layoutActive();
        this.#onStateChanged();
        return;
      }
      this.closeForTab(tabId);
    }

    const token = (this.#openToken.get(tabId) ?? 0) + 1;
    this.#openToken.set(tabId, token);

    const pendingClose = this.#closingByTarget.get(targetWc);
    if (pendingClose) {
      void pendingClose.then(() => {
        if (this.#openToken.get(tabId) !== token || targetWc.isDestroyed()) return;
        this.#finishOpen(tabId, targetWc, mode);
      });
      return;
    }
    this.#finishOpen(tabId, targetWc, mode);
  }

  /** 在指定像素坐标打开停靠/独立 DevTools 并选中 DOM 元素。 */
  inspectAt(tabId: string, targetWc: WebContents, x: number, y: number): void {
    if (targetWc.isDestroyed()) return;
    const alreadyOpen = this.isOpen(tabId);
    if (!alreadyOpen) this.openForTab(tabId, targetWc);
    setTimeout(
      () => {
        if (!targetWc.isDestroyed()) targetWc.inspectElement(Math.round(x), Math.round(y));
      },
      alreadyOpen ? 0 : 160,
    );
  }

  closeForTab(tabId: string): void {
    if (this.#activeTabId === tabId) this.cancelDrag();
    this.#openToken.set(tabId, (this.#openToken.get(tabId) ?? 0) + 1);
    const entry = this.#entries.get(tabId);
    if (!entry) return;
    this.#cleanupEntry(tabId, entry);
    if (this.#activeTabId === tabId) this.#layoutActive();
    this.#onStateChanged();
  }

  destroyAll(): void {
    this.#dragState = undefined;
    for (const tabId of [...this.#entries.keys()]) {
      this.#openToken.set(tabId, (this.#openToken.get(tabId) ?? 0) + 1);
    }
    for (const [tabId, entry] of [...this.#entries.entries()]) {
      this.#cleanupEntry(tabId, entry);
    }
    this.#activeTabId = undefined;
    this.#layers.setSlot('devtools', undefined);
    this.#detachSplitter();
    this.#destroySplitterView();
  }

  handleSplitterInput(input: DevToolsSplitterInput): void {
    switch (input.type) {
      case 'start':
        this.startDrag(input.screenX, input.screenY);
        break;
      case 'move':
        this.moveDrag(input.screenX, input.screenY);
        break;
      case 'end':
        this.endDrag(input.screenX, input.screenY, Boolean(input.cancel));
        break;
      case 'reset':
        this.resetDockSize();
        break;
    }
  }

  startDrag(screenX: number, screenY: number): void {
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
    const entry = this.#activeTabId ? this.#entries.get(this.#activeTabId) : undefined;
    if (!this.#isEntryOpen(entry) || !entry || !isDockedDevToolsMode(entry.mode)) return;
    const mode = entry.mode;
    const initialRawSize = this.#sizes[mode];
    const startSize = clampDevToolsSize(mode, initialRawSize, this.#viewport);
    this.#dragState = {
      mode,
      startScreenX: screenX,
      startScreenY: screenY,
      startSize,
      initialRawSize,
    };
    this.#layoutActive();
  }

  moveDrag(screenX: number, screenY: number): void {
    if (!this.#dragState) return;
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
    const nextSize = this.#computeDragSize(this.#dragState, screenX, screenY);
    if (nextSize === this.#sizes[this.#dragState.mode]) return;
    this.#sizes[this.#dragState.mode] = nextSize;
    this.#layoutActive();
    this.#onLayoutChanged?.();
  }

  endDrag(screenX: number, screenY: number, cancel = false): void {
    const drag = this.#dragState;
    if (!drag) return;
    this.#dragState = undefined;
    if (cancel) {
      this.#sizes[drag.mode] = drag.initialRawSize;
    } else if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
      this.#sizes[drag.mode] = this.#computeDragSize(drag, screenX, screenY);
    }
    const finalSize = this.#sizes[drag.mode];
    this.#layoutActive();
    this.#onLayoutChanged?.();
    if (!cancel && finalSize !== drag.startSize) {
      this.#onSizeCommitted?.(drag.mode, finalSize);
      this.#onStateChanged();
    }
  }

  cancelDrag(): void {
    if (!this.#dragState) return;
    this.endDrag(0, 0, true);
  }

  resetDockSize(): void {
    this.cancelDrag();
    const entry = this.#activeTabId ? this.#entries.get(this.#activeTabId) : undefined;
    if (!this.#isEntryOpen(entry) || !entry || !isDockedDevToolsMode(entry.mode)) return;
    const mode = entry.mode;
    const nextSize = clampDevToolsSize(mode, defaultDevToolsSize(mode), this.#viewport);
    if (nextSize === this.#sizes[mode]) return;
    this.#sizes[mode] = nextSize;
    this.#layoutActive();
    this.#onLayoutChanged?.();
    this.#onSizeCommitted?.(mode, nextSize);
    this.#onStateChanged();
  }

  /** 计算当前 `'page'`、`'devtools'` 与 `'splitter'` 槽位应占据的矩形（隐藏或独立窗时整块归 page）。 */
  computeSplitBounds(): DevToolsSplitBounds {
    const entry = this.#activeTabId ? this.#entries.get(this.#activeTabId) : undefined;
    const docked = Boolean(
      this.#isEntryOpen(entry) &&
      entry &&
      entry.mode !== 'detach' &&
      entry.dockView &&
      this.#layers.snapshot().devtools.visible,
    );
    const activeMode = entry?.mode ?? this.#dockMode;
    const activeSize = isDockedDevToolsMode(activeMode) ? this.#sizes[activeMode] : this.#currentDockSize();
    return computeDevToolsSplitBounds({
      viewport: this.#viewport,
      mode: activeMode,
      size: activeSize,
      docked,
      dragging: Boolean(this.#dragState),
    });
  }

  #computeDragSize(drag: ActiveDragState, screenX: number, screenY: number): number {
    const delta = drag.mode === 'right' ? drag.startScreenX - screenX : drag.startScreenY - screenY;
    return clampDevToolsSize(drag.mode, drag.startSize + delta, this.#viewport);
  }

  #currentDockSize(): number {
    if (isDockedDevToolsMode(this.#dockMode)) return this.#sizes[this.#dockMode];
    return this.#sizes[this.#lastDockedMode];
  }

  #desiredSlotVisible(): boolean {
    const viewVisible = this.#layers.viewVisible?.() ?? true;
    const viewportReady = this.#layers.isViewportReady?.() ?? true;
    return viewVisible && viewportReady;
  }

  #finishOpen(tabId: string, targetWc: WebContents, mode: DevToolsDockMode): void {
    if (targetWc.isDestroyed()) return;

    if (mode === 'detach') {
      const onClosed = () => {
        this.#cleanupEntry(tabId, entry, true);
        if (this.#activeTabId === tabId) this.#layoutActive();
        this.#onStateChanged();
      };
      const onTargetDestroyed = () => {
        this.#cleanupEntry(tabId, entry, true);
        if (this.#activeTabId === tabId) this.#layoutActive();
        this.#onStateChanged();
      };
      const entry: DockEntry = {
        tabId,
        targetWc,
        mode: 'detach',
        open: true,
        disposeListeners: () => {
          targetWc.removeListener('devtools-closed', onClosed);
          targetWc.removeListener('destroyed', onTargetDestroyed);
        },
      };
      this.#entries.set(tabId, entry);
      targetWc.once('devtools-closed', onClosed);
      targetWc.once('destroyed', onTargetDestroyed);
      targetWc.openDevTools({ mode: 'detach', activate: this.#isHostFocused() });
      this.#layers.setSlot('devtools', undefined);
      this.#detachSplitter();
      this.#layoutActive();
      this.#onStateChanged();
      return;
    }

    const dockView = this.#createDockView();
    const dockWc = dockView.webContents;
    const onClosed = () => {
      this.#cleanupEntry(tabId, entry, true);
      if (this.#activeTabId === tabId) this.#layoutActive();
      this.#onStateChanged();
    };
    const onDockDestroyed = () => {
      this.#cleanupEntry(tabId, entry, true);
      if (this.#activeTabId === tabId) this.#layoutActive();
      this.#onStateChanged();
    };
    const onTargetDestroyed = () => {
      this.#cleanupEntry(tabId, entry, true);
      if (this.#activeTabId === tabId) this.#layoutActive();
      this.#onStateChanged();
    };
    const onOpened = () => {
      if (entry.closing) return;
      if (this.#activeTabId === tabId) this.#layoutActive();
      this.#onStateChanged();
    };
    const entry: DockEntry = {
      tabId,
      targetWc,
      dockView,
      mode,
      open: true,
      disposeListeners: () => {
        targetWc.removeListener('devtools-opened', onOpened);
        targetWc.removeListener('devtools-closed', onClosed);
        targetWc.removeListener('destroyed', onTargetDestroyed);
        dockWc.removeListener('destroyed', onDockDestroyed);
      },
    };
    this.#entries.set(tabId, entry);

    targetWc.once('devtools-opened', onOpened);
    targetWc.once('devtools-closed', onClosed);
    targetWc.once('destroyed', onTargetDestroyed);
    dockWc.once('destroyed', onDockDestroyed);

    targetWc.setDevToolsWebContents(dockWc);
    targetWc.openDevTools({ mode: 'detach', activate: this.#isHostFocused() });

    if (this.#activeTabId === tabId) {
      this.#layers.setSlot('devtools', dockView, { visible: this.#desiredSlotVisible() });
      this.#ensureSplitterAttached();
    }
    this.#layoutActive();
    this.#onStateChanged();
  }

  #ensureSplitterAttached(): void {
    if (!this.#createSplitterView) return;
    if (!this.#splitterView || this.#splitterView.webContents.isDestroyed()) {
      this.#disposeSplitterListeners?.();
      this.#disposeSplitterListeners = undefined;
      this.#splitterReady = false;
      const view = this.#createSplitterView();
      this.#splitterView = view;
      view.setBackgroundColor?.('#00000000');
      const wc = view.webContents;
      const onDomReady = () => {
        this.#splitterReady = true;
        void wc.setVisualZoomLevelLimits?.(1, 1);
        wc.setZoomFactor?.(1);
        this.#syncSplitterUi();
      };
      const onBeforeInput = (event: Electron.Event, input: Electron.Input) => {
        if (this.#dragState && input.type === 'keyDown' && input.key === 'Escape') {
          event.preventDefault();
          this.cancelDrag();
        }
      };
      const onDestroyed = () => {
        if (this.#splitterView === view) {
          this.#splitterView = undefined;
          this.#splitterReady = false;
        }
      };
      wc.on('dom-ready', onDomReady);
      wc.on('before-input-event', onBeforeInput);
      wc.once('destroyed', onDestroyed);
      this.#disposeSplitterListeners = () => {
        wc.removeListener('dom-ready', onDomReady);
        wc.removeListener('before-input-event', onBeforeInput);
        wc.removeListener('destroyed', onDestroyed);
      };
      void wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildDevToolsSplitterHtml())}`);
    }
    if (this.#layers.slotView('splitter') !== this.#splitterView) {
      this.#layers.setSlot('splitter', this.#splitterView, { visible: this.#desiredSlotVisible() });
    }
  }

  #detachSplitter(): void {
    if (this.#layers.slotView('splitter')) {
      this.#layers.setSlot('splitter', undefined);
    }
  }

  #destroySplitterView(): void {
    this.#disposeSplitterListeners?.();
    this.#disposeSplitterListeners = undefined;
    const view = this.#splitterView;
    this.#splitterView = undefined;
    this.#splitterReady = false;
    try {
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    } catch {
      // ignore
    }
  }

  #syncSplitterUi(split?: DevToolsSplitBounds): void {
    const wc = this.splitterWebContents();
    if (!wc || !this.#splitterReady) return;
    const entry = this.#activeTabId ? this.#entries.get(this.#activeTabId) : undefined;
    const dock = entry && isDockedDevToolsMode(entry.mode) ? entry.mode : this.#lastDockedMode;
    const lineOffset = split?.lineOffset ?? this.computeSplitBounds().lineOffset ?? 0;
    const payload: DevToolsSplitterState = {
      dock,
      dragging: Boolean(this.#dragState),
      lineOffset,
      theme: this.#theme,
    };
    try {
      wc.send('devtools:splitterSync', payload);
    } catch {
      // ignore
    }
  }

  #isEntryOpen(entry: DockEntry | undefined): boolean {
    if (!entry || entry.closing || entry.targetWc.isDestroyed() || !entry.open) return false;
    if (entry.mode === 'detach') {
      return entry.open;
    }
    return Boolean(entry.dockView && !entry.dockView.webContents.isDestroyed());
  }

  #layoutActive(): void {
    const split = this.computeSplitBounds();
    if (this.#managePageBounds) {
      this.#layers.setBounds('page', split.page);
    }
    if (split.devtools) {
      this.#layers.setBounds('devtools', split.devtools);
    }
    if (split.splitter && this.#layers.slotView('splitter')) {
      this.#layers.setBounds('splitter', split.splitter);
      this.#syncSplitterUi(split);
    }
  }

  #cleanupEntry(tabId: string, entry: DockEntry, alreadyClosed = false): void {
    if (entry.closing) return;
    entry.closing = true;
    entry.open = false;
    entry.disposeListeners();
    if (this.#entries.get(tabId) === entry) this.#entries.delete(tabId);
    if (this.#layers.slotView('devtools') === entry.dockView) {
      this.#layers.setSlot('devtools', undefined);
      this.#detachSplitter();
    }
    if (!alreadyClosed && !entry.targetWc.isDestroyed()) {
      const closing = new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          entry.targetWc.removeListener('devtools-closed', finish);
          entry.targetWc.removeListener('destroyed', finish);
          if (this.#closingByTarget.get(entry.targetWc) === closing) {
            this.#closingByTarget.delete(entry.targetWc);
          }
          resolve();
        };
        const timer = setTimeout(finish, CLOSE_SETTLE_TIMEOUT_MS);
        timer.unref?.();
        entry.targetWc.once('devtools-closed', finish);
        entry.targetWc.once('destroyed', finish);
      });
      this.#closingByTarget.set(entry.targetWc, closing);
      try {
        entry.targetWc.closeDevTools();
      } catch {
        // ignore
      }
    }
    try {
      if (entry.dockView && !entry.dockView.webContents.isDestroyed()) {
        entry.dockView.webContents.close();
      }
    } catch {
      // ignore
    }
  }
}
