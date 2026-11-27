import { WebContentsView, type BrowserWindow } from 'electron';
import path from 'node:path';
import type { WindowLayerManager } from './layer-manager.ts';
import type { OverlayRequest } from '../../shared/types.ts';

export interface OverlayHostOptions {
  window: BrowserWindow;
  layers: WindowLayerManager;
  preloadPath: string;
  loadUrl: (surface: 'overlay') => { devUrl?: string; filePath?: string };
  onResolved?: () => void;
}

/**
 * 常驻预热的顶层透明模态宿主。
 *
 * 承载需要全窗半透明遮罩接管点击的场景（新建/编辑环境、分组、重命名、确认删除、⌘K 命令栏）。
 * 它处于 `WindowLayerManager` 最高层 `'overlay'` 槽位：弹出零延迟，且**底层网页永不隐藏或节流**。
 */
export class OverlayHost {
  #window: BrowserWindow;
  #layers: WindowLayerManager;
  #preloadPath: string;
  #loadUrl: OverlayHostOptions['loadUrl'];
  #view?: WebContentsView;
  #ready?: Promise<void>;
  #open = false;
  #currentRequest: OverlayRequest | null = null;
  #pendingResolve?: (value: unknown) => void;
  #onResolved?: () => void;

  constructor(options: OverlayHostOptions) {
    this.#window = options.window;
    this.#layers = options.layers;
    this.#preloadPath = options.preloadPath;
    this.#loadUrl = options.loadUrl;
    this.#onResolved = options.onResolved;
  }

  /** 预热透明模态层；主窗口首绘完成后再调用，避免冷启动瞬间争抢渲染资源。 */
  warmup(): void {
    this.#ensureView();
  }

  #ensureView(): WebContentsView {
    if (this.#view && !this.#view.webContents.isDestroyed()) return this.#view;
    const view = new WebContentsView({
      webPreferences: {
        preload: this.#preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#00000000');
    const source = this.#loadUrl('overlay');
    const loaded = source.devUrl
      ? view.webContents.loadURL(source.devUrl)
      : view.webContents.loadFile(source.filePath ?? path.resolve('index.html'), {
          search: 'surface=overlay',
        });
    this.#view = view;
    this.#ready = loaded.catch(() => {});
    this.#layers.setSlot('overlay', view, {
      visible: false,
      bounds: this.#fullBounds(),
    });
    return view;
  }

  get webContents() {
    return this.#view && !this.#view.webContents.isDestroyed() ? this.#view.webContents : undefined;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  currentState(): OverlayRequest | null {
    return this.#open ? this.#currentRequest : null;
  }

  syncBounds(): void {
    if (!this.#open || !this.#view) return;
    this.#layers.setBounds('overlay', this.#fullBounds());
  }

  async open<T = unknown>(request: OverlayRequest): Promise<T | null> {
    const view = this.#ensureView();
    await this.#ready;
    if (this.#pendingResolve) {
      this.#pendingResolve(null);
      this.#pendingResolve = undefined;
    }
    this.#open = true;
    this.#currentRequest = request;
    this.#layers.setBounds('overlay', this.#fullBounds());
    this.#layers.setVisible('overlay', true);
    this.#layers.restack();
    view.webContents.send('overlay:state', request);
    if (!view.webContents.isDestroyed()) view.webContents.invalidate();
    if (!this.#window.isDestroyed() && this.#window.isFocused()) {
      view.webContents.focus();
    }
    return new Promise<T | null>((resolve) => {
      this.#pendingResolve = (val) => resolve((val as T | undefined) ?? null);
    });
  }

  resolve(result: unknown): void {
    const done = this.#pendingResolve;
    this.#pendingResolve = undefined;
    this.#open = false;
    this.#currentRequest = null;
    this.#layers.setVisible('overlay', false);
    if (this.#view && !this.#view.webContents.isDestroyed()) {
      this.#view.webContents.send('overlay:state', null);
    }
    done?.(result ?? null);
    this.#onResolved?.();
  }

  destroy(): void {
    if (this.#pendingResolve) {
      this.#pendingResolve(null);
      this.#pendingResolve = undefined;
    }
    this.#currentRequest = null;
    this.#layers.setSlot('overlay', undefined);
    if (this.#view && !this.#view.webContents.isDestroyed()) this.#view.webContents.close();
    this.#view = undefined;
    this.#ready = undefined;
  }

  #fullBounds() {
    const [, height] = this.#window.getContentSize();
    const [width] = this.#window.getContentSize();
    return { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) };
  }
}
