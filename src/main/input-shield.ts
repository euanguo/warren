import { WebContentsView } from 'electron';
import type { WindowLayerManager } from './ui/layer-manager.ts';

export type ShieldMode = 'agent' | 'idle';

export interface ShieldVisualAction {
  kind: 'click' | 'fill' | 'hover' | 'move';
  x: number;
  y: number;
  rect?: { x: number; y: number; width: number; height: number };
  label?: string;
}

function buildShieldHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%; width: 100%;
    background: transparent; overflow: hidden;
    font: 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  #catch {
    position: fixed; inset: 0;
    cursor: not-allowed;
    border-radius: 8px;
  }
  #aura {
    position: fixed; inset: 0; pointer-events: none; border-radius: 8px;
    transition: box-shadow 0.24s ease;
  }
  body[data-mode="idle"] #aura {
    box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.42);
  }
  body[data-mode="agent"] #aura {
    box-shadow:
      inset 0 0 0 1.5px rgba(56, 189, 248, 0.54),
      inset 0 0 24px rgba(56, 189, 248, 0.16);
  }
  #sweep {
    position: fixed; top: 0; left: 0; right: 0; height: 2px;
    pointer-events: none; opacity: 0;
    background: linear-gradient(90deg, transparent 0%, #38bdf8 46%, #818cf8 66%, transparent 100%);
    background-size: 42% 100%; background-repeat: no-repeat;
    transition: opacity 0.2s ease;
  }
  body[data-mode="agent"] #sweep { opacity: 0.92; }
  @media (prefers-reduced-motion: no-preference) {
    body[data-mode="agent"] #aura {
      animation: haloBreath 2.6s ease-in-out infinite;
    }
    body[data-mode="agent"] #sweep {
      animation: sweepBar 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
  }
  @keyframes haloBreath {
    0%, 100% {
      box-shadow:
        inset 0 0 0 1.5px rgba(56, 189, 248, 0.34),
        inset 0 0 16px rgba(56, 189, 248, 0.08);
    }
    50% {
      box-shadow:
        inset 0 0 0 2px rgba(56, 189, 248, 0.72),
        inset 0 0 30px rgba(56, 189, 248, 0.22);
    }
  }
  @keyframes sweepBar {
    0% { background-position: -60% 0; }
    100% { background-position: 160% 0; }
  }
  #target-box {
    position: fixed; pointer-events: none; opacity: 0;
    border: 1.5px solid #0ea5e9;
    background: rgba(14, 165, 233, 0.08);
    border-radius: 6px;
    transition:
      left 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      top 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      width 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      height 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      opacity 0.22s ease;
  }
  #target-tag {
    position: fixed; pointer-events: none; opacity: 0;
    padding: 1px 6px; border-radius: 4px;
    background: rgba(2, 132, 199, 0.94); color: #ffffff;
    font: 500 10px/15px ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis;
    transition: left 0.34s cubic-bezier(0.22, 1, 0.36, 1), top 0.34s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease;
  }
  #cursor {
    position: fixed; pointer-events: none; opacity: 0;
    transform: translate(-2px, -2px);
    filter: drop-shadow(0 2px 6px rgba(2, 132, 199, 0.45));
    transition:
      left 0.38s cubic-bezier(0.22, 1, 0.36, 1),
      top 0.38s cubic-bezier(0.22, 1, 0.36, 1),
      opacity 0.25s ease;
  }
  #ripple {
    position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px;
    border-radius: 50%; border: 2px solid #0ea5e9;
    pointer-events: none; opacity: 0;
  }
  #ripple.pop {
    animation: rippleOut 0.45s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  @keyframes rippleOut {
    0% { transform: scale(0.3); opacity: 0.9; }
    100% { transform: scale(1.9); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    #target-box, #target-tag, #cursor { transition: opacity 0.15s ease; }
    #ripple.pop { animation: none; opacity: 0; }
  }
  #nudge {
    position: fixed; z-index: 10;
    display: inline-flex; align-items: center; gap: 8px;
    padding: 5px 7px 5px 11px; border-radius: 999px;
    background: rgba(20, 22, 28, 0.92); color: #e5e7eb;
    border: 1px solid rgba(56, 189, 248, 0.35);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(12px);
    white-space: nowrap; opacity: 0; pointer-events: none;
    transform: translate(-50%, -125%);
    transition: opacity 0.16s ease;
  }
  #nudge.show { opacity: 1; pointer-events: auto; }
  #nudge a {
    display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
    background: rgba(56, 189, 248, 0.22); color: #bae6fd; text-decoration: none;
    font-weight: 500; border: 1px solid rgba(56, 189, 248, 0.38); cursor: pointer;
  }
  #nudge a:hover { background: rgba(56, 189, 248, 0.36); }
</style></head>
<body data-mode="idle">
  <div id="catch"></div>
  <div id="aura"></div>
  <div id="sweep"></div>
  <div id="target-box"></div>
  <div id="target-tag"></div>
  <div id="ripple"></div>
  <svg id="cursor" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 2l15 10.5-6.6 1.5L9.5 20 4 2z" fill="#0ea5e9" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>
  <div id="nudge"><span id="nudge-text"></span><a id="nudge-takeover" href="warren-action://takeover">接管</a></div>
  <script>
    (() => {
      const state = { caller: 'Agent', mode: 'idle', showControlPill: true };
      const catchEl = document.getElementById('catch');
      const targetBox = document.getElementById('target-box');
      const targetTag = document.getElementById('target-tag');
      const cursor = document.getElementById('cursor');
      const ripple = document.getElementById('ripple');
      const nudge = document.getElementById('nudge');
      const nudgeText = document.getElementById('nudge-text');
      const nudgeAction = document.getElementById('nudge-takeover');
      let boxTimer = 0;
      let cursorTimer = 0;
      let nudgeTimer = 0;

      function hideTraces() {
        clearTimeout(boxTimer);
        clearTimeout(cursorTimer);
        targetBox.style.opacity = '0';
        targetTag.style.opacity = '0';
        cursor.style.opacity = '0';
      }

      window.__warrenShieldState = (next) => {
        if (!next) return;
        if (typeof next.caller === 'string') state.caller = next.caller || 'Agent';
        if (next.mode === 'agent' || next.mode === 'idle') state.mode = next.mode;
        if (typeof next.showControlPill === 'boolean') state.showControlPill = next.showControlPill;
        document.body.dataset.mode = state.mode;
        if (state.mode !== 'agent') hideTraces();
      };

      window.__warrenShieldAction = (act) => {
        if (!act || state.mode !== 'agent') return;
        const x = Number(act.x);
        const y = Number(act.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        cursor.style.left = x + 'px';
        cursor.style.top = y + 'px';
        cursor.style.opacity = '1';
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(() => { cursor.style.opacity = '0'; }, 2600);

        if (act.rect && act.rect.width > 0 && act.rect.height > 0) {
          const rx = Math.max(0, act.rect.x - 2);
          const ry = Math.max(0, act.rect.y - 2);
          targetBox.style.left = rx + 'px';
          targetBox.style.top = ry + 'px';
          targetBox.style.width = (act.rect.width + 4) + 'px';
          targetBox.style.height = (act.rect.height + 4) + 'px';
          targetBox.style.opacity = '1';
          const tagText = state.caller + ' · ' + (act.label || act.kind);
          targetTag.textContent = tagText;
          targetTag.style.left = Math.min(rx, Math.max(8, window.innerWidth - 180)) + 'px';
          targetTag.style.top = Math.max(6, ry - 20) + 'px';
          targetTag.style.opacity = '1';
          clearTimeout(boxTimer);
          boxTimer = setTimeout(() => {
            targetBox.style.opacity = '0';
            targetTag.style.opacity = '0';
          }, 2100);
        }

        if (act.kind === 'click') {
          ripple.style.left = x + 'px';
          ripple.style.top = y + 'px';
          ripple.classList.remove('pop');
          void ripple.offsetWidth;
          ripple.classList.add('pop');
        }
      };

      catchEl.addEventListener('pointerdown', (event) => {
        if (!state.showControlPill) return;
        nudgeText.textContent = state.mode === 'agent'
          ? state.caller + ' 正在操作'
          : 'Agent 空间只读';
        nudgeAction.textContent = state.mode === 'agent' ? '接管' : '接管编辑';
        const left = Math.min(Math.max(event.clientX, 120), Math.max(120, window.innerWidth - 120));
        const top = Math.max(event.clientY, 44);
        nudge.style.left = left + 'px';
        nudge.style.top = top + 'px';
        nudge.classList.add('show');
        clearTimeout(nudgeTimer);
        nudgeTimer = setTimeout(() => { nudge.classList.remove('show'); }, 1800);
      });
    })();
  </script>
</body></html>`;
}

/**
 * Agent 空间透明输入遮罩与实时动作轨迹动画层（渲染于 `'shield'` 原生槽位，零注入目标网页 DOM）。
 *
 * - `mode === 'agent'`：边缘呼吸光晕（中心 100% 通透）+ 顶部轻流光 + AI 虚拟光标/目标锚框/点击波纹；
 * - `mode === 'idle'`：静默细灰边 + 只读防误触，绝不播动画误导用户；
 * - 默认不在底部常驻黑药丸遮挡页面按钮，仅用户误点时在光标附近弹 1.8s 轻提示。
 */
export class InputShield {
  #view: WebContentsView;
  #attached = false;
  #visible = true;
  #ready = false;
  #layers?: WindowLayerManager;
  #callerLabel = 'Agent';
  #mode: ShieldMode = 'idle';
  #showControlPill = true;
  #onTakeover?: () => void;

  constructor(options: { layers?: WindowLayerManager; showControlPill?: boolean; onTakeover?: () => void } = {}) {
    this.#layers = options.layers;
    this.#showControlPill = options.showControlPill ?? true;
    this.#onTakeover = options.onTakeover;
    this.#view = new WebContentsView({
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
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

  setShowControlPill(show: boolean): void {
    if (this.#showControlPill === show) return;
    this.#showControlPill = show;
    this.#pushState();
  }

  showAction(action: ShieldVisualAction): void {
    if (!this.#attached || !this.#visible || !this.#ready || this.#mode !== 'agent') return;
    if (this.#view.webContents.isDestroyed()) return;
    const payload = JSON.stringify(action);
    void this.#view.webContents.executeJavaScript(`window.__warrenShieldAction?.(${payload});`).catch(() => {});
  }

  #pushState(): void {
    if (!this.#ready || this.#view.webContents.isDestroyed()) return;
    const payload = JSON.stringify({
      caller: this.#callerLabel,
      mode: this.#mode,
      showControlPill: this.#showControlPill,
    });
    void this.#view.webContents.executeJavaScript(`window.__warrenShieldState?.(${payload});`).catch(() => {});
  }

  attach(window: Electron.BaseWindow, bounds: { x: number; y: number; width: number; height: number }): void {
    this.#attached = true;
    if (this.#layers) {
      this.#layers.setSlot('shield', this.#view, { visible: this.#visible, bounds });
      this.#pushState();
      return;
    }
    window.contentView.addChildView(this.#view);
    this.#view.setBounds(bounds);
    this.#view.setVisible(this.#visible);
    this.#pushState();
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    if (!this.#attached) return;
    if (this.#layers) this.#layers.setBounds('shield', bounds);
    else this.#view.setBounds(bounds);
  }

  raise(window: Electron.BaseWindow): void {
    if (!this.#attached) return;
    if (this.#layers) {
      this.#layers.restack();
      return;
    }
    window.contentView.removeChildView(this.#view);
    window.contentView.addChildView(this.#view);
  }

  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (this.#layers && this.#attached) {
      this.#layers.setVisible('shield', visible);
      return;
    }
    this.#view.setVisible(visible);
  }

  detach(window: Electron.BaseWindow): void {
    if (!this.#attached) return;
    this.#attached = false;
    if (this.#layers) {
      if (this.#layers.slotView('shield') === this.#view) {
        this.#layers.setSlot('shield', undefined);
      }
      return;
    }
    window.contentView.removeChildView(this.#view);
  }

  destroy(): void {
    if (!this.#view.webContents.isDestroyed()) this.#view.webContents.close();
  }
}
