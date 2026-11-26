import { WebContentsView } from 'electron';
import type { WindowLayerManager } from './ui/layer-manager.ts';

export type ShieldMode = 'agent' | 'idle';
export type ShieldTheme = 'dark' | 'light';

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
    cursor: default;
    border-radius: 8px;
  }
  body[data-mode="agent"] #catch {
    cursor: progress;
  }
  #aura {
    position: fixed; inset: 0; pointer-events: none; border-radius: 8px;
    transition: box-shadow 0.24s ease, border-color 0.24s ease;
  }
  body[data-mode="idle"] #aura {
    border: 1.5px dashed rgba(116, 128, 150, 0.58);
    box-shadow: inset 0 0 0 1px rgba(116, 128, 150, 0.14);
  }
  body[data-theme="light"][data-mode="idle"] #aura {
    border: 1.5px dashed rgba(100, 112, 135, 0.55);
    box-shadow: inset 0 0 0 1px rgba(100, 112, 135, 0.14);
  }
  body[data-mode="agent"] #aura {
    border: 0;
    box-shadow:
      inset 0 0 0 2.5px rgba(91, 140, 255, 0.9),
      inset 0 0 28px rgba(56, 189, 248, 0.24);
  }
  body[data-theme="light"][data-mode="agent"] #aura {
    border: 0;
    box-shadow:
      inset 0 0 0 2.5px rgba(59, 91, 219, 0.88),
      inset 0 0 26px rgba(37, 99, 235, 0.18);
  }
  #sweep {
    position: fixed; top: 0; left: 0; right: 0; height: 3px;
    pointer-events: none; opacity: 0; border-radius: 8px 8px 0 0;
    background: linear-gradient(90deg, transparent 0%, #5b8cff 38%, #38bdf8 66%, transparent 100%);
    background-size: 46% 100%; background-repeat: no-repeat;
    box-shadow: 0 1px 12px rgba(91, 140, 255, 0.48);
    transition: opacity 0.2s ease;
  }
  body[data-theme="light"] #sweep {
    background: linear-gradient(90deg, transparent 0%, #3b5bdb 38%, #0284c7 66%, transparent 100%);
    background-size: 46% 100%; background-repeat: no-repeat;
    box-shadow: 0 1px 10px rgba(59, 91, 219, 0.36);
  }
  body[data-mode="agent"] #sweep { opacity: 0.98; }
  @media (prefers-reduced-motion: no-preference) {
    body[data-mode="agent"] #aura {
      animation: haloBreath 2.6s ease-in-out infinite;
    }
    body[data-theme="light"][data-mode="agent"] #aura {
      animation: haloBreathLight 2.6s ease-in-out infinite;
    }
    body[data-mode="agent"] #sweep {
      animation: sweepBar 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
  }
  @keyframes haloBreath {
    0%, 100% {
      box-shadow:
        inset 0 0 0 2px rgba(91, 140, 255, 0.68),
        inset 0 0 20px rgba(56, 189, 248, 0.16);
    }
    50% {
      box-shadow:
        inset 0 0 0 3px rgba(91, 140, 255, 0.96),
        inset 0 0 36px rgba(56, 189, 248, 0.3);
    }
  }
  @keyframes haloBreathLight {
    0%, 100% {
      box-shadow:
        inset 0 0 0 2.5px rgba(59, 91, 219, 0.68),
        inset 0 0 20px rgba(37, 99, 235, 0.14);
    }
    50% {
      box-shadow:
        inset 0 0 0 3px rgba(59, 91, 219, 0.94),
        inset 0 0 32px rgba(37, 99, 235, 0.24);
    }
  }
  @keyframes sweepBar {
    0% { background-position: -60% 0; }
    100% { background-position: 160% 0; }
  }
  #status-chip {
    position: fixed; top: 10px; right: 12px; z-index: 8;
    display: inline-flex; align-items: center; gap: 7px;
    padding: 4px 10px; border-radius: 999px;
    background: rgba(24, 27, 33, 0.88); color: #f4f6fa;
    border: 1px solid rgba(91, 140, 255, 0.42);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(12px);
    font: 500 11.5px/16px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    transition: left 0.26s ease, right 0.26s ease, opacity 0.2s ease;
    pointer-events: auto;
  }
  #status-chip.dodge-left { right: auto; left: 12px; }
  body[data-mode="idle"] #status-chip {
    border-color: rgba(116, 128, 150, 0.38);
    background: rgba(24, 27, 33, 0.82);
  }
  body[data-theme="light"] #status-chip {
    background: rgba(255, 255, 255, 0.92); color: #111621;
    border-color: rgba(59, 91, 219, 0.36);
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  }
  body[data-theme="light"][data-mode="idle"] #status-chip {
    border-color: rgba(100, 112, 135, 0.34);
  }
  #status-dot {
    width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
    background: #748096;
  }
  body[data-mode="agent"] #status-dot {
    background: #5b8cff;
    box-shadow: 0 0 8px rgba(91, 140, 255, 0.8);
  }
  body[data-theme="light"][data-mode="agent"] #status-dot {
    background: #3b5bdb;
  }
  #status-chip a {
    display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px;
    background: rgba(91, 140, 255, 0.22); color: #dbeafe; text-decoration: none;
    border: 1px solid rgba(91, 140, 255, 0.42); font-size: 11px;
  }
  body[data-theme="light"] #status-chip a {
    background: rgba(59, 91, 219, 0.12); color: #1e40af;
    border-color: rgba(59, 91, 219, 0.34);
  }
  #status-chip a:hover { filter: brightness(1.1); }
  #target-box {
    position: fixed; pointer-events: none; opacity: 0;
    border: 2px solid #5b8cff;
    background: rgba(91, 140, 255, 0.12);
    border-radius: 6px;
    transition:
      left 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      top 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      width 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      height 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      opacity 0.22s ease;
  }
  body[data-theme="light"] #target-box {
    border-color: #3b5bdb;
    background: rgba(59, 91, 219, 0.1);
  }
  #target-tag {
    position: fixed; pointer-events: none; opacity: 0;
    padding: 2px 7px; border-radius: 5px;
    background: rgba(59, 91, 219, 0.95); color: #ffffff;
    font: 500 10.5px/15px ui-monospace, SFMono-Regular, Menlo, monospace;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.25);
    white-space: nowrap; max-width: 240px; overflow: hidden; text-overflow: ellipsis;
    transition: left 0.34s cubic-bezier(0.22, 1, 0.36, 1), top 0.34s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease;
  }
  #cursor {
    position: fixed; pointer-events: none; opacity: 0;
    transform: translate(-2px, -2px);
    filter: drop-shadow(0 2px 6px rgba(59, 91, 219, 0.5));
    transition:
      left 0.38s cubic-bezier(0.22, 1, 0.36, 1),
      top 0.38s cubic-bezier(0.22, 1, 0.36, 1),
      opacity 0.25s ease;
  }
  #ripple {
    position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px;
    border-radius: 50%; border: 2px solid #5b8cff;
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
  body[data-theme="light"] #nudge {
    background: rgba(255, 255, 255, 0.94); color: #0f172a;
    border-color: rgba(2, 132, 199, 0.32);
    box-shadow: 0 10px 26px rgba(15, 23, 42, 0.14);
  }
  body[data-theme="light"] #nudge a {
    background: rgba(2, 132, 199, 0.14); color: #0369a1;
    border-color: rgba(2, 132, 199, 0.35);
  }
  body[data-theme="light"] #nudge a:hover { background: rgba(2, 132, 199, 0.24); }
  #nudge a {
    display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
    background: rgba(56, 189, 248, 0.22); color: #bae6fd; text-decoration: none;
    font-weight: 500; border: 1px solid rgba(56, 189, 248, 0.38); cursor: pointer;
  }
  #nudge a:hover { background: rgba(56, 189, 248, 0.36); }
</style></head>
<body data-mode="idle" data-theme="dark">
  <div id="catch"></div>
  <div id="aura"></div>
  <div id="sweep"></div>
  <div id="status-chip"><span id="status-dot"></span><span id="status-text">Agent 空间只读</span><a id="status-takeover" href="warren-action://takeover">接管编辑</a></div>
  <div id="target-box"></div>
  <div id="target-tag"></div>
  <div id="ripple"></div>
  <svg id="cursor" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 2l15 10.5-6.6 1.5L9.5 20 4 2z" fill="#3b5bdb" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>
  <div id="nudge"><span id="nudge-text"></span><a id="nudge-takeover" href="warren-action://takeover">接管</a></div>
  <script>
    (() => {
      const state = { caller: 'Agent', mode: 'idle', theme: 'dark', showControlPill: true };
      const catchEl = document.getElementById('catch');
      const statusChip = document.getElementById('status-chip');
      const statusText = document.getElementById('status-text');
      const statusTakeover = document.getElementById('status-takeover');
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
      let chipTimer = 0;

      function syncChip(actionLabel) {
        statusChip.style.display = state.showControlPill ? 'inline-flex' : 'none';
        if (state.mode === 'agent') {
          statusText.textContent = actionLabel
            ? state.caller + ' · ' + actionLabel
            : state.caller + ' 操作中';
          statusTakeover.textContent = '接管';
        } else {
          statusText.textContent = 'Agent 空间空闲（只读）';
          statusTakeover.textContent = '接管编辑';
          statusChip.classList.remove('dodge-left');
        }
      }

      function hideTraces() {
        clearTimeout(boxTimer);
        clearTimeout(cursorTimer);
        clearTimeout(chipTimer);
        targetBox.style.opacity = '0';
        targetTag.style.opacity = '0';
        cursor.style.opacity = '0';
      }

      window.__warrenShieldState = (next) => {
        if (!next) return;
        if (typeof next.caller === 'string') state.caller = next.caller || 'Agent';
        if (next.mode === 'agent' || next.mode === 'idle') state.mode = next.mode;
        if (next.theme === 'dark' || next.theme === 'light') state.theme = next.theme;
        if (typeof next.showControlPill === 'boolean') state.showControlPill = next.showControlPill;
        document.body.dataset.mode = state.mode;
        document.body.dataset.theme = state.theme;
        syncChip();
        if (state.mode !== 'agent') hideTraces();
      };

      window.__warrenShieldAction = (act) => {
        if (!act || state.mode !== 'agent') return;
        const x = Number(act.x);
        const y = Number(act.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const nearTopRight = y < 84 && x > Math.max(260, window.innerWidth - 280);
        statusChip.classList.toggle('dodge-left', nearTopRight);
        syncChip(act.label || act.kind);
        clearTimeout(chipTimer);
        chipTimer = setTimeout(() => { if (state.mode === 'agent') syncChip(); }, 2800);
        cursor.style.left = x + 'px';
        cursor.style.top = y + 'px';
        cursor.style.opacity = '1';
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(() => { cursor.style.opacity = state.mode === 'agent' ? '0.48' : '0'; }, 2600);

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
          targetTag.style.top = Math.max(6, ry - 22) + 'px';
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
  #theme: ShieldTheme = 'dark';
  #showControlPill = true;
  #onTakeover?: () => void;

  constructor(
    options: {
      layers?: WindowLayerManager;
      showControlPill?: boolean;
      theme?: ShieldTheme;
      onTakeover?: () => void;
    } = {},
  ) {
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
    });
    void this.#view.webContents
      .executeJavaScript(`window.__warrenShieldState?.(${payload});`)
      .then(() => {
        if (!this.#view.webContents.isDestroyed()) this.#view.webContents.invalidate();
      })
      .catch(() => {});
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
