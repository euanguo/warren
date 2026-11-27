import { WebContentsView } from 'electron';
import {
  buildShieldHtml,
  type ShieldMode,
  type ShieldPhase,
  type ShieldSessionSnapshot,
  type ShieldTheme,
  type ShieldVisualAction,
} from './ui/input-shield-view.ts';
import type { WindowLayerManager } from './ui/layer-manager.ts';

export type {
  ShieldMode,
  ShieldPhase,
  ShieldSessionSnapshot,
  ShieldTheme,
  ShieldVisualAction,
} from './ui/input-shield-view.ts';

/**
 * Agent 空间轻量纯 CSS 透明输入护盾（渲染于 `'shield'` 原生槽位，零注入目标网页 DOM、零 WebGL 开销）。
 *
 * - 仅在 Agent 实际持有租约控制页面时挂载（`mode === 'agent'`），展示边缘流光、元素锚框与点击波纹；
 * - Agent Space 空闲或人工接管时不挂载护盾，人工可直接自由交互与导航；
 * - 即使关闭底部控制胶囊，误点护盾仍闪出非阻塞提示，杜绝静默吞点击。
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
  #phase: ShieldPhase = 'acting';
  #startedAt = 0;
  #lastActivityAt = 0;
  #lastAction?: string;
  #actionCount = 0;
  #onTakeover?: () => void;
  #onFinish?: () => void;

  constructor(options: {
    layers: WindowLayerManager;
    showControlPill?: boolean;
    theme?: ShieldTheme;
    onTakeover?: () => void;
    onFinish?: () => void;
  }) {
    this.#layers = options.layers;
    this.#showControlPill = options.showControlPill ?? true;
    this.#theme = options.theme ?? 'dark';
    this.#onTakeover = options.onTakeover;
    this.#onFinish = options.onFinish;
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
      } else if (url.startsWith('warren-action://finish')) {
        event.preventDefault();
        this.#onFinish?.();
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

  get osProcessId(): number | undefined {
    if (this.#view.webContents.isDestroyed()) return undefined;
    const pid = this.#view.webContents.getOSProcessId();
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
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

  setSession(session: ShieldSessionSnapshot): void {
    const unchanged =
      this.#phase === session.phase &&
      this.#startedAt === session.startedAt &&
      this.#lastActivityAt === session.lastActivityAt &&
      this.#lastAction === session.lastAction &&
      this.#actionCount === session.actionCount;
    if (unchanged) return;
    this.#phase = session.phase;
    this.#startedAt = session.startedAt;
    this.#lastActivityAt = session.lastActivityAt;
    this.#lastAction = session.lastAction;
    this.#actionCount = session.actionCount;
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
      phase: this.#phase,
      startedAt: this.#startedAt,
      lastActivityAt: this.#lastActivityAt,
      lastAction: this.#lastAction ?? '',
      actionCount: this.#actionCount,
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
