import type { WebContents, WebContentsView } from 'electron';
import type { WindowLayerManager } from './layer-manager.ts';
import type { DevToolsDockMode, ViewportRect } from '../../shared/types.ts';

export type DockViewFactory = () => WebContentsView;

interface DockEntry {
  tabId: string;
  targetWc: WebContents;
  dockView?: WebContentsView;
  mode: DevToolsDockMode;
  open: boolean;
  closing?: boolean;
  disposeListeners: () => void;
}

const DEFAULT_DOCK_SIZE = 420;
const MIN_DOCK_SIZE = 240;
const MAX_DOCK_RATIO = 0.7;
const DOCK_GAP = 6;
const CLOSE_SETTLE_TIMEOUT_MS = 500;

/**
 * 停靠式原生 Chrome DevTools 宿主。
 *
 * 突破此前 `openDevTools({ mode: 'right' })` 对 `WebContentsView` 不生效的限制：
 * 使用 Electron `wc.setDevToolsWebContents(devToolsView.webContents)` 将原版 DevTools
 * 渲染进专用 `WebContentsView`，纳入 `WindowLayerManager` 的 `'devtools'` 槽位管理，
 * 并严格随 Tab / Environment 销毁，避免官方文档警告的手动释放遗漏。
 *
 * 注意：Electron 对自定义 `setDevToolsWebContents` 的宿主不会让 `targetWc.isDevToolsOpened()`
 * 返回 `true`，因此停靠态的开启判定、分栏裁剪与关闭清理以宿主自身状态为准，仅 `detach`
 * 独立窗口模式才委托原生 `isDevToolsOpened()`。
 */
export class DevToolsHost {
  #layers: WindowLayerManager;
  #createDockView: DockViewFactory;
  #dockMode: DevToolsDockMode = 'right';
  #dockSize = DEFAULT_DOCK_SIZE;
  #entries = new Map<string, DockEntry>();
  #closingByTarget = new WeakMap<WebContents, Promise<void>>();
  #openToken = new Map<string, number>();
  #activeTabId?: string;
  #viewport: ViewportRect = { x: 0, y: 0, width: 800, height: 600 };
  #onStateChanged: () => void;

  constructor(layers: WindowLayerManager, onStateChanged: () => void, createDockView: DockViewFactory) {
    this.#layers = layers;
    this.#onStateChanged = onStateChanged;
    this.#createDockView = createDockView;
  }

  get dockMode(): DevToolsDockMode {
    return this.#dockMode;
  }

  get dockSize(): number {
    return this.#dockSize;
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
    this.#onStateChanged();
  }

  setDockConfig(mode: DevToolsDockMode, size?: number): void {
    const prevMode = this.#dockMode;
    this.#dockMode = mode;
    if (typeof size === 'number' && Number.isFinite(size)) {
      this.#dockSize = Math.max(MIN_DOCK_SIZE, Math.round(size));
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
        this.#layers.setSlot('devtools', active.dockView, { visible: true });
        this.#layoutActive();
        this.#onStateChanged();
        return;
      }
      const wc = active.targetWc;
      this.closeForTab(active.tabId);
      if (!wc.isDestroyed()) this.openForTab(active.tabId, wc, mode);
      return;
    }
    if (prevMode !== mode || typeof size === 'number') {
      this.#layoutActive();
      this.#onStateChanged();
    }
  }

  isOpen(tabId?: string): boolean {
    const id = tabId ?? this.#activeTabId;
    if (!id) return false;
    return this.#isEntryOpen(this.#entries.get(id));
  }

  state(): { open: boolean; dock: DevToolsDockMode; size: number } {
    return {
      open: this.isOpen(),
      dock: this.#dockMode,
      size: this.#dockSize,
    };
  }

  /** 将某个 Tab 设为当前展示舞台上的激活 Tab（隐藏其余 Tab 的 DevTools 视图）。 */
  activateTab(tabId: string | undefined): void {
    if (this.#activeTabId === tabId) {
      this.#layoutActive();
      return;
    }
    this.#activeTabId = tabId;
    const entry = tabId ? this.#entries.get(tabId) : undefined;
    if (this.#isEntryOpen(entry) && entry && entry.mode !== 'detach' && entry.dockView) {
      this.#layers.setSlot('devtools', entry.dockView, { visible: true });
    } else {
      this.#layers.setSlot('devtools', undefined);
    }
    this.#layoutActive();
  }

  openForTab(tabId: string, targetWc: WebContents, overrideMode?: DevToolsDockMode): void {
    if (targetWc.isDestroyed()) return;
    const mode = overrideMode ?? this.#dockMode;
    this.#dockMode = mode;
    this.#activeTabId = tabId;

    const existing = this.#entries.get(tabId);
    if (this.#isEntryOpen(existing) && existing) {
      if (existing.mode === mode) {
        if (mode === 'detach') existing.targetWc.devToolsWebContents?.focus();
        else this.activateTab(tabId);
        return;
      }
      if (existing.mode !== 'detach' && mode !== 'detach' && existing.dockView) {
        existing.mode = mode;
        this.#layers.setSlot('devtools', existing.dockView, { visible: true });
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
    this.#openToken.set(tabId, (this.#openToken.get(tabId) ?? 0) + 1);
    const entry = this.#entries.get(tabId);
    if (!entry) return;
    this.#cleanupEntry(tabId, entry);
    if (this.#activeTabId === tabId) this.#layoutActive();
    this.#onStateChanged();
  }

  destroyAll(): void {
    for (const tabId of [...this.#entries.keys()]) {
      this.#openToken.set(tabId, (this.#openToken.get(tabId) ?? 0) + 1);
    }
    for (const [tabId, entry] of [...this.#entries.entries()]) {
      this.#cleanupEntry(tabId, entry);
    }
    this.#activeTabId = undefined;
    this.#layers.setSlot('devtools', undefined);
  }

  /** 计算当前 `'page'` 与 `'devtools'` 槽位应占据的矩形（当隐藏或独立窗时整块归 page）。 */
  computeSplitBounds(): { page: ViewportRect; devtools?: ViewportRect } {
    const entry = this.#activeTabId ? this.#entries.get(this.#activeTabId) : undefined;
    const docked = Boolean(
      this.#isEntryOpen(entry) &&
      entry &&
      entry.mode !== 'detach' &&
      entry.dockView &&
      this.#layers.snapshot().devtools.visible,
    );
    if (!docked || !entry) {
      return { page: this.#viewport };
    }
    const { x, y, width, height } = this.#viewport;
    if (entry.mode === 'right') {
      const splitW = Math.min(Math.max(MIN_DOCK_SIZE, this.#dockSize), Math.floor(width * MAX_DOCK_RATIO));
      const pageW = Math.max(200, width - splitW - DOCK_GAP);
      const dtX = x + pageW + DOCK_GAP;
      return {
        page: { x, y, width: pageW, height },
        devtools: { x: dtX, y, width: Math.max(120, x + width - dtX), height },
      };
    }
    const splitH = Math.min(Math.max(180, this.#dockSize), Math.floor(height * MAX_DOCK_RATIO));
    const pageH = Math.max(160, height - splitH - DOCK_GAP);
    const dtY = y + pageH + DOCK_GAP;
    return {
      page: { x, y, width, height: pageH },
      devtools: { x, y: dtY, width, height: Math.max(120, y + height - dtY) },
    };
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
      targetWc.openDevTools({ mode: 'detach' });
      this.#layers.setSlot('devtools', undefined);
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
    targetWc.openDevTools({ mode: 'detach' });

    if (this.#activeTabId === tabId) {
      this.#layers.setSlot('devtools', dockView, { visible: true });
    }
    this.#layoutActive();
    this.#onStateChanged();
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
    this.#layers.setBounds('page', split.page);
    if (split.devtools) {
      this.#layers.setBounds('devtools', split.devtools);
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
