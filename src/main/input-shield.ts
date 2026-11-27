import { WebContentsView } from 'electron';
import {
  buildShieldHtml,
  type ShieldMode,
  type ShieldTheme,
  type ShieldVisualAction,
} from './domain/input-shield-view.ts';
import type { WindowLayerManager } from './ui/layer-manager.ts';

export type { ShieldMode, ShieldTheme, ShieldVisualAction } from './domain/input-shield-view.ts';

/**
 * Agent 空间透明输入遮罩与实时动作轨迹动画层（渲染于 `'shield'` 原生槽位，零注入目标网页 DOM）。
 *
 * - `mode === 'agent'`：三层 EGO 风格 WebGL 着色器（流光面纱 + 点阵星火轨迹 + Poisson 滚动流光边框）及 AI 光标/锚框；
 * - `mode === 'idle'` / 隐藏 / 卸载：静默细灰边并彻底停止 WebGL rAF 循环，避免后台 GPU 持续占用；
 * - 仅在用户误点遮罩时在光标附近弹 1.8s 轻提示，WebGL 不可用时自动降级回 CSS 呼吸边框。
 */
export class InputShield {
  #view: WebContentsView;
  #attached = false;
  #visible = true;
  #ready = false;
  #layers: WindowLayerManager;
  #callerLabel = 'Agent';
  #mode: ShieldMode = 'idle';
  #theme: ShieldTheme = 'dark';
  #showControlPill = true;
  #onTakeover?: () => void;

  constructor(options: {
    layers: WindowLayerManager;
    showControlPill?: boolean;
    theme?: ShieldTheme;
    onTakeover?: () => void;
  }) {
    this.#layers = options.layers;
    this.#showControlPill = options.showControlPill ?? true;
    this.#theme = options.theme ?? 'dark';
    this.#onTakeover = options.onTakeover;
    this.#view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.#view.setBackgroundColor('#00000000');
    this.#view.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('warren-action://takeover')) {
        event.preventDefault();
        this.#onTakeover?.();
      }
    });
    this.#view.webContents.on('dom-ready', () => {
      this.#ready = true;
      this.#pushState();
    });
    void this.#view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildShieldHtml())}`);
  }

  get view(): WebContentsView {
    return this.#view;
  }

  get attached(): boolean {
    return this.#attached;
  }

  get mode(): ShieldMode {
    return this.#mode;
  }

  setCallerLabel(label?: string): void {
    const next = label?.trim() || 'Agent';
    if (next === this.#callerLabel) return;
    this.#callerLabel = next;
    this.#pushState();
  }

  setMode(mode: ShieldMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#pushState();
  }

  setTheme(theme: ShieldTheme): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#pushState();
  }

  setShowControlPill(show: boolean): void {
    if (this.#showControlPill === show) return;
    this.#showControlPill = show;
    this.#pushState();
  }

  showAction(action: ShieldVisualAction): void {
    if (!this.#attached || !this.#visible || !this.#ready || this.#mode !== 'agent') return;
    if (this.#view.webContents.isDestroyed()) return;
    const payload = JSON.stringify(action);
    void this.#view.webContents
      .executeJavaScript(`window.__warrenShieldAction?.(${payload});`)
      .then(() => {
        if (!this.#view.webContents.isDestroyed()) this.#view.webContents.invalidate();
      })
      .catch(() => {});
  }

  #pushState(): void {
    if (!this.#ready || this.#view.webContents.isDestroyed()) return;
    const payload = JSON.stringify({
      caller: this.#callerLabel,
      mode: this.#mode,
      theme: this.#theme,
      showControlPill: this.#showControlPill,
      attached: this.#attached,
      visible: this.#visible,
    });
    void this.#view.webContents
      .executeJavaScript(`window.__warrenShieldState?.(${payload});`)
      .then(() => {
        if (!this.#view.webContents.isDestroyed()) this.#view.webContents.invalidate();
      })
      .catch(() => {});
  }

  attach(_window: Electron.BaseWindow, bounds: { x: number; y: number; width: number; height: number }): void {
    this.#attached = true;
    this.#layers.setSlot('shield', this.#view, { visible: this.#visible, bounds });
    this.#pushState();
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    if (!this.#attached) return;
    this.#layers.setBounds('shield', bounds);
  }

  raise(_window: Electron.BaseWindow): void {
    if (!this.#attached) return;
    this.#layers.restack();
  }

  setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    if (this.#attached) {
      this.#layers.setVisible('shield', visible);
      this.#pushState();
    }
  }

  detach(_window: Electron.BaseWindow): void {
    if (!this.#attached) return;
    this.#attached = false;
    this.#pushState();
    if (this.#layers.slotView('shield') === this.#view) {
      this.#layers.setSlot('shield', undefined);
    }
  }

  destroy(): void {
    if (!this.#view.webContents.isDestroyed()) this.#view.webContents.close();
  }
}
