import { WebContentsView, type WebContents } from 'electron';
import type { WindowLayerManager } from './layer-manager.ts';
import type { DevToolsDockMode, ViewportRect } from '../../shared/types.ts';

interface DockEntry {
  tabId: string;
  targetWc: WebContents;
  dockView?: WebContentsView;
  mode: DevToolsDockMode;
}

const DEFAULT_DOCK_SIZE = 420;
const MIN_DOCK_SIZE = 240;
const MAX_DOCK_RATIO = 0.7;

/**
 * 停靠式原生 Chrome DevTools 宿主。
 *
 * 突破此前 `openDevTools({ mode: 'right' })` 对 `WebContentsView` 不生效的限制：
 * 使用 Electron `wc.setDevToolsWebContents(devToolsView.webContents)` 将原版 DevTools
 * 渲染进专用 `WebContentsView`，纳入 `WindowLayerManager` 的 `'devtools'` 槽位管理，
 * 并严格随 Tab / Environment 销毁，避免官方文档警告的手动释放遗漏。
 */
export class DevToolsHost {
  #layers: WindowLayerManager;
  #dockMode: DevToolsDockMode = 'right';
  #dockSize = DEFAULT_DOCK_SIZE;
  #entries = new Map<string, DockEntry>();
  #activeTabId?: string;
  #viewport: ViewportRect = { x: 0, y: 0, width: 800, height: 600 };
  #onStateChanged: () => void;

  constructor(layers: WindowLayerManager, onStateChanged: () => void) {
    this.#layers = layers;
    this.#onStateChanged = onStateChanged;
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
    if (active && prevMode !== mode) {
      const wc = active.targetWc;
      this.closeForTab(active.tabId);
      if (!wc.isDestroyed()) this.openForTab(active.tabId, wc, mode);
      return;
    }
    this.#layoutActive();
    this.#onStateChanged();
  }

  isOpen(tabId?: string): boolean {
    const id = tabId ?? this.#activeTabId;
    if (!id) return false;
    const entry = this.#entries.get(id);
    if (!entry || entry.targetWc.isDestroyed()) return false;
    return entry.targetWc.isDevToolsOpened();
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
    if (
      entry &&
      entry.mode !== 'detach' &&
      entry.dockView &&
      !entry.targetWc.isDestroyed() &&
      entry.targetWc.isDevToolsOpened()
    ) {
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
    if (existing && !existing.targetWc.isDestroyed() && existing.targetWc.isDevToolsOpened()) {
      if (existing.mode === mode) {
        if (mode === 'detach') existing.targetWc.devToolsWebContents?.focus();
        else this.activateTab(tabId);
        return;
      }
      this.closeForTab(tabId);
    }

    if (mode === 'detach') {
      this.#entries.set(tabId, { tabId, targetWc, mode: 'detach' });
      targetWc.openDevTools({ mode: 'detach' });
      targetWc.once('devtools-closed', () => {
        if (this.#entries.get(tabId)?.mode === 'detach') {
          this.#entries.delete(tabId);
          this.#onStateChanged();
        }
      });
      this.#layers.setSlot('devtools', undefined);
      this.#layoutActive();
      this.#onStateChanged();
      return;
    }

    const dockView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const entry: DockEntry = { tabId, targetWc, dockView, mode };
    this.#entries.set(tabId, entry);

    targetWc.setDevToolsWebContents(dockView.webContents);
    targetWc.openDevTools({ mode: 'detach' });
    targetWc.once('devtools-closed', () => {
      // 用户从 DevTools 右上角点了 ×
      this.#cleanupEntry(tabId, entry);
      this.#onStateChanged();
    });

    this.#layers.setSlot('devtools', dockView, { visible: true });
    this.#layoutActive();
    this.#onStateChanged();
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
      alreadyOpen ? 0 : 120,
    );
  }

  closeForTab(tabId: string): void {
    const entry = this.#entries.get(tabId);
    if (!entry) return;
    this.#cleanupEntry(tabId, entry);
    if (this.#activeTabId === tabId) this.#layoutActive();
    this.#onStateChanged();
  }

  destroyAll(): void {
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
      entry &&
      entry.mode !== 'detach' &&
      entry.dockView &&
      !entry.targetWc.isDestroyed() &&
      entry.targetWc.isDevToolsOpened() &&
      this.#layers.snapshot().devtools.visible,
    );
    if (!docked || !entry) {
      return { page: this.#viewport };
    }
    const { x, y, width, height } = this.#viewport;
    if (entry.mode === 'right') {
      const splitW = Math.min(Math.max(MIN_DOCK_SIZE, this.#dockSize), Math.floor(width * MAX_DOCK_RATIO));
      const pageW = Math.max(200, width - splitW);
      return {
        page: { x, y, width: pageW, height },
        devtools: { x: x + pageW, y, width: width - pageW, height },
      };
    }
    const splitH = Math.min(Math.max(180, this.#dockSize), Math.floor(height * MAX_DOCK_RATIO));
    const pageH = Math.max(160, height - splitH);
    return {
      page: { x, y, width, height: pageH },
      devtools: { x, y: y + pageH, width, height: height - pageH },
    };
  }

  #layoutActive(): void {
    const split = this.computeSplitBounds();
    this.#layers.setBounds('page', split.page);
    if (split.devtools) {
      this.#layers.setBounds('devtools', split.devtools);
    }
  }

  #cleanupEntry(tabId: string, entry: DockEntry): void {
    if (this.#entries.get(tabId) === entry) this.#entries.delete(tabId);
    if (this.#layers.slotView('devtools') === entry.dockView) {
      this.#layers.setSlot('devtools', undefined);
    }
    try {
      if (!entry.targetWc.isDestroyed() && entry.targetWc.isDevToolsOpened()) {
        entry.targetWc.closeDevTools();
      }
    } catch {
      // ignore
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
