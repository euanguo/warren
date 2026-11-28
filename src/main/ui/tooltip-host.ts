import { BrowserWindow, type WebContents } from 'electron';
import path from 'node:path';
import type { OverlayTooltipRequest } from '../../shared/types.ts';

export interface TooltipHostOptions {
  mainWindow: BrowserWindow;
  preloadPath: string;
  loadUrl: (surface: 'tooltip') => { devUrl?: string; filePath?: string };
}

/**
 * 原生 tooltip 层（一个透明、不可聚焦、不吃鼠标事件的子窗口）。
 *
 * 为什么不是 DOM 也不是 `WebContentsView`：
 * - 主窗 DOM 永远在原生网页视图下方，tooltip 一进网页区域就消失（紧凑侧栏最明显）；
 * - `WebContentsView` 没有 `setIgnoreMouseEvents`，整窗盖住会把页面点击全吃掉。
 *
 * 子窗口与主窗内容区同尺寸同原点，所以主窗的 `getBoundingClientRect()` 可以直接当内部坐标用；
 * 窗口整体穿透，只有视觉留在最上层。
 */
export class TooltipHost {
  #mainWindow: BrowserWindow;
  #preloadPath: string;
  #loadUrl: TooltipHostOptions['loadUrl'];
  #win?: BrowserWindow;
  #ready?: Promise<void>;
  #visible = false;
  #current: OverlayTooltipRequest | null = null;
  #lastUsedAt = Date.now();
  #onMainChanged = () => this.hide();

  constructor(options: TooltipHostOptions) {
    this.#mainWindow = options.mainWindow;
    this.#preloadPath = options.preloadPath;
    this.#loadUrl = options.loadUrl;
    // 锚点是主窗坐标：窗口一动/失焦就撤掉，避免浮层钉在旧位置。
    this.#mainWindow.on('move', this.#onMainChanged);
    this.#mainWindow.on('resize', this.#onMainChanged);
    this.#mainWindow.on('blur', this.#onMainChanged);
  }

  /** 回收空闲隐藏态的 tooltip 窗口，下次悬停时按需重建（与 Overlay/Popover 同一内存策略）。 */
  reclaimIdle(idleMs = 0): number {
    if (this.#visible || !this.#win) return 0;
    if (idleMs > 0 && Date.now() - this.#lastUsedAt < idleMs) return 0;
    this.destroy();
    return 1;
  }

  currentState(): OverlayTooltipRequest | null {
    return this.#visible ? this.#current : null;
  }

  processInfos(): Array<{ pid: number; label: string }> {
    const wc = this.webContents;
    if (!wc) return [];
    const pid = wc.getOSProcessId();
    return Number.isInteger(pid) && pid > 0 ? [{ pid, label: 'Tooltip 原生层' }] : [];
  }

  get webContents(): WebContents | undefined {
    return this.#win && !this.#win.isDestroyed() && !this.#win.webContents.isDestroyed()
      ? this.#win.webContents
      : undefined;
  }

  async show(request: OverlayTooltipRequest): Promise<void> {
    if (this.#mainWindow.isDestroyed()) return;
    const win = this.#ensureWindow();
    await this.#ready;
    if (win.isDestroyed()) return;
    const content = this.#mainWindow.getContentBounds();
    win.setBounds({
      x: Math.round(content.x),
      y: Math.round(content.y),
      width: Math.max(1, content.width),
      height: Math.max(1, content.height),
    });
    this.#current = request;
    this.#lastUsedAt = Date.now();
    win.webContents.send('tooltip:state', request);
    this.#visible = true;
    win.showInactive();
  }

  hide(): void {
    if (!this.#visible) return;
    this.#visible = false;
    this.#current = null;
    this.#lastUsedAt = Date.now();
    const wc = this.webContents;
    if (wc) wc.send('tooltip:state', null);
    if (this.#win && !this.#win.isDestroyed()) this.#win.hide();
  }

  destroy(): void {
    if (!this.#mainWindow.isDestroyed()) {
      this.#mainWindow.off('move', this.#onMainChanged);
      this.#mainWindow.off('resize', this.#onMainChanged);
      this.#mainWindow.off('blur', this.#onMainChanged);
    }
    if (this.#win && !this.#win.isDestroyed()) this.#win.destroy();
    this.#win = undefined;
    this.#ready = undefined;
    this.#visible = false;
  }

  #ensureWindow(): BrowserWindow {
    if (this.#win && !this.#win.isDestroyed()) return this.#win;
    const win = new BrowserWindow({
      parent: this.#mainWindow,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.#preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    // 只画不接：点击/悬停全部落到下面主窗的网页视图与 chrome。
    win.setIgnoreMouseEvents(true);
    const source = this.#loadUrl('tooltip');
    this.#ready = (
      source.devUrl
        ? win.webContents.loadURL(source.devUrl)
        : win.webContents.loadFile(source.filePath ?? path.resolve('index.html'), { search: 'surface=tooltip' })
    ).catch(() => {});
    this.#win = win;
    return win;
  }
}
