import { WebContentsView } from 'electron';
import type { WindowLayerManager } from './ui/layer-manager.ts';

function buildShieldHtml(callerLabel: string, showControlPill: boolean): string {
  const safe = callerLabel.replace(
    /[<>&"]/g,
    (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch] ?? ch,
  );
  const pillHtml = showControlPill
    ? `<div id="pill"><span id="dot"></span><span><b>${safe}</b> 正在操作</span><a id="takeover" href="warren-action://takeover">接管</a></div>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;
    font:12px -apple-system,BlinkMacSystemFont,sans-serif;-webkit-user-select:none}
  #catch{position:fixed;inset:0;cursor:not-allowed;box-shadow:inset 0 0 0 1.5px rgba(88,166,255,.35);border-radius:8px;
    animation:framePulse 2.4s ease-in-out infinite}
  @keyframes framePulse{0%,100%{box-shadow:inset 0 0 0 1.5px rgba(88,166,255,.38)}50%{box-shadow:inset 0 0 0 1.5px rgba(88,166,255,.16)}}
  #pill{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);
    display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;border-radius:999px;
    background:rgba(24,26,30,.92);color:#e6edf3;border:1px solid rgba(255,255,255,.12);
    box-shadow:0 8px 24px rgba(0,0,0,.38);white-space:nowrap;backdrop-filter:blur(14px)}
  #dot{width:6px;height:6px;border-radius:50%;background:#58a6ff;animation:pulse 1.4s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
  b{color:#fff;font-weight:500}
  a#takeover{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;
    background:rgba(88,166,255,.18);color:#8cc4ff;text-decoration:none;font-weight:500;cursor:pointer;
    border:1px solid rgba(88,166,255,.3)}
  a#takeover:hover{background:rgba(88,166,255,.3)}
</style></head><body>
  <div id="catch"></div>
  ${pillHtml}
</body></html>`;
}

/**
 * Agent 持有控制权时盖在环境页面上的输入遮罩与底部控制胶囊。
 */
export class InputShield {
  #view: WebContentsView;
  #attached = false;
  #visible = true;
  #layers?: WindowLayerManager;
  #callerLabel = 'Agent';
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
    this.#reloadHtml();
  }

  get view(): WebContentsView {
    return this.#view;
  }

  get attached(): boolean {
    return this.#attached;
  }

  setCallerLabel(label?: string): void {
    const next = label?.trim() || 'Agent';
    if (next === this.#callerLabel) return;
    this.#callerLabel = next;
    this.#reloadHtml();
  }

  setShowControlPill(show: boolean): void {
    if (this.#showControlPill === show) return;
    this.#showControlPill = show;
    this.#reloadHtml();
  }

  #reloadHtml(): void {
    if (this.#view.webContents.isDestroyed()) return;
    void this.#view.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(buildShieldHtml(this.#callerLabel, this.#showControlPill))}`,
    );
  }

  attach(window: Electron.BaseWindow, bounds: { x: number; y: number; width: number; height: number }): void {
    this.#attached = true;
    if (this.#layers) {
      this.#layers.setSlot('shield', this.#view, { visible: this.#visible, bounds });
      return;
    }
    window.contentView.addChildView(this.#view);
    this.#view.setBounds(bounds);
    this.#view.setVisible(this.#visible);
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
