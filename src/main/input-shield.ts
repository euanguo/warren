import { WebContentsView } from 'electron';

/**
 * Agent 持有控制权时盖在环境页面上的输入遮罩。
 *
 * 为什么必须是原生 View 而不是渲染层的 div：
 * 环境的页面本身就是 WebContentsView（原生视图），它不参与 DOM 层叠，
 * 渲染层放什么都会被它盖住。要挡住它，只能在它上面再放一个原生视图。
 *
 * 遮罩只拦人。Agent 走 CDP 直接对目标渲染进程发输入事件，不经过这里。
 */
const SHIELD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;
    font:13px -apple-system,BlinkMacSystemFont,sans-serif;-webkit-user-select:none}
  #catch{position:fixed;inset:0;cursor:not-allowed}
  #banner{position:fixed;left:50%;top:14px;transform:translateX(-50%);
    display:flex;align-items:center;gap:10px;padding:7px 14px;border-radius:999px;
    background:rgba(20,24,30,.92);color:#e6edf3;border:1px solid rgba(88,166,255,.45);
    box-shadow:0 4px 20px rgba(0,0,0,.35);white-space:nowrap}
  #dot{width:7px;height:7px;border-radius:50%;background:#58a6ff;animation:pulse 1.4s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
  b{color:#58a6ff;font-weight:600}
</style></head><body>
  <div id="catch"></div>
  <div id="banner"><span id="dot"></span><span><b>Agent Space 已锁定</b> · 点顶部「接管 Agent」可手动操作</span></div>
</body></html>`;

export class InputShield {
  #view: WebContentsView;
  #attached = false;

  constructor() {
    this.#view = new WebContentsView({
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.#view.setBackgroundColor('#00000000');
    void this.#view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SHIELD_HTML)}`);
  }

  get view(): WebContentsView {
    return this.#view;
  }

  get attached(): boolean {
    return this.#attached;
  }

  attach(window: Electron.BaseWindow, bounds: { x: number; y: number; width: number; height: number }): void {
    if (!this.#attached) {
      window.contentView.addChildView(this.#view);
      this.#attached = true;
    }
    this.#view.setBounds(bounds);
  }

  /**
   * 把遮罩重新提到最上层。
   *
   * `addChildView` 是**后加的在上面**，而切标签 / 新建标签会往 contentView 里
   * 加一个页面视图，那一下就把遮罩盖住了。所以每次视图变化都要 raise 一次。
   */
  raise(window: Electron.BaseWindow): void {
    if (!this.#attached) return;
    window.contentView.removeChildView(this.#view);
    window.contentView.addChildView(this.#view);
  }

  /**
   * 临时藏起遮罩。原生视图永远画在渲染层 DOM 之上，所以右键菜单压到页面区域时
   * 会被它盖住；那种时候要把原生视图（页面 + 遮罩）一起让开。
   */
  setVisible(visible: boolean): void {
    this.#view.setVisible(visible);
  }

  detach(window: Electron.BaseWindow): void {
    if (!this.#attached) return;
    window.contentView.removeChildView(this.#view);
    this.#attached = false;
  }

  destroy(): void {
    if (!this.#view.webContents.isDestroyed()) this.#view.webContents.close();
  }
}
