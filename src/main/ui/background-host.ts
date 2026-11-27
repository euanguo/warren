import { BrowserWindow, type WebContentsView } from 'electron';
import type { ViewportRect } from '../../shared/types.ts';

/**
 * 后台/非激活视图的永久隐藏宿主抽象。
 *
 * 与主窗口的 `'below'` 槽位解耦，供 `TabManager` 在无 Electron 环境下可单测注入。
 */
export interface BackgroundHostLike {
  attach(view: WebContentsView, bounds: ViewportRect): void;
  setSize(view: WebContentsView, bounds: ViewportRect): void;
  detach(view: WebContentsView): void;
  has(view: WebContentsView): boolean;
  destroy(): void;
}

function normalizeSize(bounds: ViewportRect): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(bounds.width || 800)),
    height: Math.max(1, Math.round(bounds.height || 600)),
  };
}

/**
 * 懒创建的永久原生隐藏宿主窗口（`show: false`、`focusable: false`、`skipTaskbar: true`）。
 *
 * 复用 Electron 45.5.0 已验证通过的原生隐藏态 + CDP 焦点仿真原语：
 * - 永不 `show()`、永不挪到 `-10000` 离屏坐标、永不进入 Dock / Mission Control、永不抢前台焦点；
 * - 支持多后台环境并发挂载，互不踩踏；
 * - 主窗口打开设置页、插件全屏页或浮层（`viewVisible === false`）甚至主窗口 `win.hide()` 时，
 *   后台 Agent 的输入与截图仍落在这个真实合成器表面上，消除 `ENV_NOT_VISIBLE` 阻断。
 */
export class BackgroundHostWindow implements BackgroundHostLike {
  #window?: BrowserWindow;
  #views = new Set<WebContentsView>();
  #destroyed = false;

  attach(view: WebContentsView, bounds: ViewportRect): void {
    if (this.#destroyed || !this.#isLive(view)) return;
    const size = normalizeSize(bounds);
    const win = this.#ensureWindow(size);
    if (!win) return;
    this.#growWindowToFit(win, size);
    const children = win.contentView.children as WebContentsView[];
    if (!children.includes(view)) {
      win.contentView.addChildView(view);
    }
    view.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
    view.setVisible(true);
    view.webContents.invalidate?.();
    this.#views.add(view);
  }

  setSize(view: WebContentsView, bounds: ViewportRect): void {
    if (this.#destroyed || !this.#views.has(view) || !this.#isLive(view)) return;
    const win = this.#window;
    if (!win || win.isDestroyed()) return;
    const size = normalizeSize(bounds);
    this.#growWindowToFit(win, size);
    view.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
    view.webContents.invalidate?.();
  }

  detach(view: WebContentsView): void {
    this.#views.delete(view);
    const win = this.#window;
    if (!win || win.isDestroyed()) return;
    try {
      win.contentView.removeChildView(view);
    } catch {
      // 视图未挂在宿主窗口或已销毁时忽略
    }
  }

  has(view: WebContentsView): boolean {
    return this.#views.has(view);
  }

  destroy(): void {
    this.#destroyed = true;
    const win = this.#window;
    this.#window = undefined;
    if (win && !win.isDestroyed()) {
      for (const view of [...this.#views]) {
        try {
          win.contentView.removeChildView(view);
        } catch {
          // 忽略已移除/已销毁视图
        }
      }
      this.#views.clear();
      try {
        win.destroy();
      } catch {
        // 退出阶段忽略窗口销毁异常
      }
      return;
    }
    this.#views.clear();
  }

  #ensureWindow(size: { width: number; height: number }): BrowserWindow | undefined {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      show: false,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      minimizable: false,
      maximizable: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.on('closed', () => {
      if (this.#window === win) this.#window = undefined;
      this.#views.clear();
    });
    this.#window = win;
    return win;
  }

  #growWindowToFit(win: BrowserWindow, size: { width: number; height: number }): void {
    try {
      const [curW, curH] = win.getContentSize();
      const nextW = Math.max(curW, size.width);
      const nextH = Math.max(curH, size.height);
      if (nextW !== curW || nextH !== curH) {
        win.setContentSize(nextW, nextH);
      }
    } catch {
      // 忽略最小窗口尺寸异常
    }
  }

  #isLive(view: WebContentsView): boolean {
    try {
      const wc = view.webContents as Electron.WebContents | undefined;
      return Boolean(wc && !wc.isDestroyed());
    } catch {
      return false;
    }
  }
}
