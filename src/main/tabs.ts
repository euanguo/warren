import { WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron';
import type { X509Certificate } from 'node:crypto';
import path from 'node:path';
import { TabList, closeSet } from './domain/tabs.ts';
import { leafSignedByCa } from './domain/trusted-ca.ts';
import { browserShortcut } from './browser-shortcuts';
import type { BrowserController } from './browser/controller.ts';
import type { WindowLayerManager } from './ui/layer-manager.ts';
import type { SpaceId, TabRef, TabState, ViewportRect } from '../shared/types';

/** 视图缺省安全设置。和 Environment 原来的一致，不要在这里放松。 */
const VIEW_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  // Agent 在后台操作时，页面仍要跑定时器、保持可见状态，不能被 Chromium 降频。
  backgroundThrottling: false,
  // 环境页的 preload：补 window.chrome 的 API 表面，见该文件顶部注释
  preload: path.join(__dirname, 'page-preload.cjs'),
} as const;

/** 标签状态变化合并到这个窗口再通知渲染层，否则一次加载会触发十几次全量刷新。 */
const CHANGE_THROTTLE_MS = 100;

/** favicon 要转成 data URL 塞进 TabState，所以必须有上限，别让一个巨大响应卡住主进程。 */
const MAX_FAVICON_BYTES = 256 * 1024;
const MAX_FAVICON_CACHE = 128;

/** 「最近关闭」栈的深度（⌘⇧T 用）。Chrome 是 25，我们用不着那么多。 */
const CLOSED_STACK_MAX = 10;

/**
 * 新标签的落地页。
 *
 * 走我们自己的 `warren://` scheme（主进程供给一张静态页），不是 `about:blank`：
 * 空白页在标签条上只剩一行「新标签页」，而这张页能说清「你在哪个环境里」。
 */
export const NEW_TAB_URL = 'warren://newtab';

/** 新标签页带上环境 id，那张静态页才知道自己该显示哪个环境的身份。 */
export function newTabUrl(environmentId: string): string {
  return `${NEW_TAB_URL}/?env=${encodeURIComponent(environmentId)}`;
}

/**
 * `setWindowOpenHandler` 的 `createWindow` 回调实参会多带这两个字段，
 * 但 Electron 的 d.ts 只声明了 `BrowserWindowConstructorOptions`。
 * 官方文档的 BrowserView 示例也是直接解构它们，所以这里显式收窄。
 */
type CreateWindowOptions = Electron.BrowserWindowConstructorOptions & {
  webContents?: WebContents;
  webPreferences?: Electron.WebPreferences;
};

interface TabOptions {
  session: Session;
  space: SpaceId;
  /** 该环境额外信任的 CA 或动态解析器；用于每张 webContents 的证书兜底。 */
  trustedCa?: X509Certificate | (() => X509Certificate | undefined);
  /** `window.open` 场景下 Electron 已经建好的 guest，必须复用它 */
  webContents?: WebContents;
  webPreferences?: Electron.WebPreferences;
  url?: string;
}

/**
 * 一个标签：只持有 `WebContentsView` 和它的生命周期。
 * 顺序/激活在 `TabList`，事件接线和挂载在 `TabManager`。
 */
export class Tab {
  readonly id: string;
  readonly space: SpaceId;
  readonly view: WebContentsView;
  #createdAt = new Date().toISOString();
  #error?: string;

  constructor(id: string, options: TabOptions) {
    this.id = id;
    this.space = options.space;
    // 传了 guest 就必须复用；自己新建会阻塞 opener 的同步 window.open
    // （见 docs/TAB-MODULE-PLAN.md §10 坑 2/3）
    this.view = options.webContents
      ? new WebContentsView({ webContents: options.webContents })
      : new WebContentsView({
          webPreferences: {
            ...VIEW_PREFERENCES,
            ...options.webPreferences,
            session: options.session,
          },
        });
    this.#wireCertificateTrust(options.trustedCa);
  }

  /**
   * Session 的 `setCertificateVerifyProc` 仍负责正常链路；这里再给每个 tab 装一层
   * `certificate-error`。原因是 Chromium 会把证书失败按域名缓存在网络服务里：
   * 环境先直连失败、之后才 bind 代理/CA 时，同一个 Session 重启后仍可能直接命中缓存。
   * 实测新 webContents 上的 `certificate-error` 能绕过该缓存；校验仍是同一张 CA 的验签，
   * 不是无脑放行。
   */
  #wireCertificateTrust(trustedCa?: X509Certificate | (() => X509Certificate | undefined)): void {
    if (!trustedCa) return;
    const wc = this.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    const resolveCa = typeof trustedCa === 'function' ? trustedCa : () => trustedCa;
    wc.on('certificate-error', (event, _url, _error, certificate, callback) => {
      const currentCa = resolveCa();
      if (currentCa && leafSignedByCa(certificate.data, currentCa)) {
        event.preventDefault();
        callback(true);
      } else {
        callback(false);
      }
    });
  }

  /**
   * 页面自己调 `window.close()` 之后 `view.webContents` 会变成 `undefined`。
   * 所以每次访问都过这一层，不要直接摸 `view.webContents`。
   */
  get webContents(): WebContents | undefined {
    return this.view.webContents as WebContents | undefined;
  }

  /** 主框架加载失败 / 重新开始加载时由 `TabManager` 调。 */
  setLoadError(message?: string): void {
    this.#error = message;
  }

  get state(): TabState {
    const wc = this.webContents;
    const live = wc && !wc.isDestroyed() ? wc : undefined;
    return {
      id: this.id,
      space: this.space,
      title: live?.getTitle() ?? '',
      url: live?.getURL() ?? '',
      loading: live?.isLoading() ?? false,
      audible: live?.isCurrentlyAudible() ?? false,
      muted: live?.isAudioMuted() ?? false,
      error: this.#error,
      createdAt: this.#createdAt,
    };
  }

  setMuted(muted: boolean): void {
    const wc = this.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.setAudioMuted(muted);
  }

  loadURL(url: string): void {
    const wc = this.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.loadURL(url).catch((error: Error) => {
      // 导航失败页面自己会显示错误页，不打断流程 —— 但**必须留痕**：
      // 静默失败最难查（内置页 / 插件页加载不了时表现就是「标签一片空白」）。
      console.error('[tab] loadURL failed', url, error.message);
    });
  }

  destroy(): void {
    const wc = this.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.close();
  }
}

/** `list()` 的返回比 `TabState` 多一个 `active` —— UI 和 CLI 都要知道哪个是当前标签。 */
export type TabListItem = TabState & { active: boolean };

export interface TabManagerOptions {
  envId: string;
  space: SpaceId;
  window: BrowserWindow;
  /** 窗口原生层管理器 */
  layers: WindowLayerManager;
  /** 读取当前真实页面视口（单一真相源，避免新建或后台 Space 沿用 0,0,800,600 默认值） */
  getViewport?: () => ViewportRect;
  /** 渲染层是否已经上报过有效视口；未就绪前不把默认 800x600 视图画到左上角 */
  isViewportReady?: () => boolean;
  session: Session;
  trustedCa?: X509Certificate | (() => X509Certificate | undefined);
  /** 状态变更通知（已节流）—— 渲染层刷新用 */
  onChanged: () => void;
  /** 挂在窗口里的视图换了（新建/切换/关闭）—— 遮罩与 DevTools 要跟随更新 */
  onViewChanged: () => void;
  /** 最后一个标签被关掉 —— 调用方负责停掉整个环境 */
  onEmpty: () => void;
  onEvent: (type: string, message: string) => void;
  createController: (tabId: string, webContents: WebContents) => BrowserController;
  /** 标签的 webContents 被销毁后调用（遥测/DevTools 等按标签挂的东西要拆掉） */
  onTabDestroyed: (tabId: string) => void;
  /** 页面开出了新标签（`window.open` 收敛处）——环境级 popup 队列据此记录 */
  onPopup?: (tabId: string, url: string) => void;
  /** 主框架发生实际导航（含页内导航），用于跨环境地址历史。 */
  onUrlVisited?: (url: string) => void;
  /** 网页主框架完成切换后恢复按域偏好（例如页面缩放比例）。 */
  onOriginZoomNeeded?: (tab: Tab, url: string) => void;
  /** 网页原生右键菜单请求。 */
  onContextMenu?: (tab: Tab, params: Electron.ContextMenuParams) => void;
  /** 鼠标悬停链接预览 URL 变化。 */
  onTargetUrl?: (url: string) => void;
  /** 页内查找命中进度回调。 */
  onFoundInPage?: (result: Electron.Result) => void;
}

/**
 * 一个 Environment 的标签集合。
 *
 * **这里是创建 `WebContentsView` 的唯一入口**：新窗口分流、事件接线、视图挂载
 * 全收在这里，Environment 只跟它打交道。
 *
 * 关键约束（实测记录见 docs/TAB-MODULE-PLAN.md §10）：
 * - `createWindow` 必须复用 Electron 给的 `opts.webContents`，否则主进程死锁
 * - `background-tab` / `new-window` 时 `opts.webContents` 可能是 undefined，要自己建并手动 loadURL
 * - 页面 `window.close()` 会真的销毁 webContents，之后 `view.webContents` 是 undefined
 */
export class TabManager {
  #options: TabManagerOptions;
  #list = new TabList();
  #tabs = new Map<string, Tab>();
  #controllers = new Map<string, BrowserController>();
  #viewport: ViewportRect = { x: 0, y: 0, width: 800, height: 600 };
  #attached: WebContentsView | undefined;
  /** `attachBelow()` 挂上去的那个视图（临时「让后台环境收得到输入」用）。 */
  #below: WebContentsView | undefined;
  /** 这个环境的页面是否正在右侧区域显示。**没显示就绝不往窗口里塞视图**。 */
  #visible = false;
  /**
   * 原生视图要不要真的画出来。和 `#visible` 分开：`#visible` 是「这个环境的页面
   * 归不归这个窗口」，这个是「这一刻让不让它露脸」——渲染层有浮层压到页面区域时
   * 要临时让开，因为原生视图永远在 DOM 之上。
   */
  #viewVisible = true;
  #changeTimer?: ReturnType<typeof setTimeout>;
  /** favicon URL → data URL。undefined 表示取过一次、失败了。 */
  #favicons = new Map<string, string | undefined>();
  /**
   * 最近关掉的标签（⌘⇧T 用），新的在前。
   *
   * 只在**人关掉 / 页面自己 close** 时入栈；环境停掉（`destroy()`）不算——
   * 那是「环境没了」，不是「手滑关了个标签」。
   */
  #closed: Array<{ url: string; title: string }> = [];

  constructor(options: TabManagerOptions) {
    this.#options = options;
    if (options.getViewport) {
      this.#viewport = options.getViewport();
    }
  }

  get activeId(): string | undefined {
    return this.#list.activeId;
  }

  get space(): SpaceId {
    return this.#options.space;
  }

  get size(): number {
    return this.#list.size;
  }

  /** 当前标签的视图是否挂在窗口上。用来断言「窗口里同时只有一个环境的页面」。 */
  get showing(): boolean {
    return this.#attached !== undefined;
  }

  /** 视图挂在窗口上、但可能正为渲染层浮层让位。诊断用。 */
  get viewVisible(): boolean {
    return this.#viewVisible;
  }

  /** 当前标签的 DevTools 开着没。诊断用。 */
  get devToolsOpen(): boolean {
    const wc = this.active()?.view.webContents;
    return Boolean(wc && !wc.isDestroyed() && wc.isDevToolsOpened());
  }

  list(): TabListItem[] {
    return this.#list.list.map((tab) => ({ ...tab, active: tab.id === this.#list.activeId }));
  }

  /** 单个标签的对外状态。调用方刚建好/刚切过它，所以标签一定在。 */
  item(id: string): TabListItem {
    const tab = this.#tabs.get(id);
    if (!tab) throw new Error(`unknown tab: ${id}`);
    return { ...tab.state, active: id === this.#list.activeId };
  }

  active(): Tab | undefined {
    return this.#list.activeId ? this.#tabs.get(this.#list.activeId) : undefined;
  }

  /** 当前激活标签的 CDP 控制层。Agent 的读写都落在这里。 */
  controller(): BrowserController | undefined {
    const id = this.#list.activeId;
    return id ? this.#controllers.get(id) : undefined;
  }

  controllerFor(ref?: TabRef): BrowserController | undefined {
    if (ref === undefined) return this.controller();
    const id = this.#list.resolve(ref);
    return id ? this.#controllers.get(id) : undefined;
  }

  /** 把 UI / CLI 给的引用解析成 tabId。输入类操作要靠它判断「是不是当前激活标签」。 */
  resolveRef(ref: TabRef): string | undefined {
    return this.#list.resolve(ref);
  }

  /**
   * 新建标签。`window.open` 分流和 UI / CLI 的新建都走这里。
   * **必须同步返回**：`setWindowOpenHandler` 的 `createWindow` 要同步拿到 webContents。
   */
  create(options: Partial<TabOptions> & { activate?: boolean } = {}): Tab {
    const id = crypto.randomUUID();
    const tab = new Tab(id, {
      session: this.#options.session,
      space: this.#options.space,
      trustedCa: this.#options.trustedCa,
      webContents: options.webContents,
      webPreferences: options.webPreferences,
      url: options.url,
    });

    this.#tabs.set(id, tab);
    this.#wire(tab);
    this.#list.add(tab.state, { activate: options.activate ?? true });

    const wc = tab.webContents;
    if (wc) this.#controllers.set(id, this.#options.createController(id, wc));

    // guest 是 Electron 建的、它自己会导航（也才带得上 POST body）；我们自己建的必须手动加载
    if (!options.webContents && options.url) tab.loadURL(options.url);

    if (this.#list.activeId === id) this.#showActive();
    this.#notify();
    return tab;
  }

  select(ref: TabRef): Tab | undefined {
    const id = this.#list.resolve(ref);
    if (!id || !this.#list.select(id)) return undefined;
    this.#showActive();
    this.#notify();
    return this.#tabs.get(id);
  }

  /** 关标签。UI、CLI、最后一个标签触发 onEmpty，都走这里。 */
  close(ref: TabRef): boolean {
    const id = this.#list.resolve(ref);
    if (!id || !this.#tabs.has(id)) return false;
    this.#remove(id, true);
    return true;
  }

  /** 拖拽排序：只改顺序，**不重新挂视图**（重挂会让页面闪一下）。 */
  reorder(from: number, to: number): boolean {
    if (!this.#list.reorder(from, to)) return false;
    this.#notify();
    return true;
  }

  /** 右键菜单的「关闭其他 / 关闭右侧」，返回真的关掉了几个。 */
  closeMany(ref: TabRef, mode: 'others' | 'right'): number {
    const id = this.#list.resolve(ref);
    if (!id) return 0;
    const targets = closeSet(this.#list.list, id, mode);
    for (const target of targets) this.#remove(target, true);
    return targets.length;
  }

  /** 静音开关。返回更新后的标签；标签不在时 undefined，由调用方报 TAB_NOT_FOUND。 */
  setMuted(ref: TabRef, muted: boolean): TabListItem | undefined {
    const id = this.#list.resolve(ref);
    if (!id) return undefined;
    const tab = this.#tabs.get(id);
    if (!tab) return undefined;
    tab.setMuted(muted);
    this.#list.update(id, { muted });
    this.#notify();
    return this.item(id);
  }

  /**
   * ⌘⇧T：重新打开最近关掉的那个标签。
   *
   * **不还原到原来的位置**，直接追加到末尾——`TabList` 只支持尾部追加，
   * 而「位置」在这件事上不重要（Chrome 也是插回原位，但我们不做拖拽排序，差异看不出来）。
   * 空 URL（about:blank）不入栈，所以这里一定有个地址可开。
   */
  reopen(): Tab | undefined {
    const entry = this.#closed.shift();
    if (!entry) return undefined;
    const tab = this.create({ url: entry.url, activate: true });
    this.#options.onEvent('tab.reopened', `重新打开 ${entry.title || entry.url}`);
    return tab;
  }

  /** 最近关闭栈（诊断 / 测试用）。 */
  get recentlyClosed(): ReadonlyArray<{ url: string; title: string }> {
    return this.#closed;
  }

  /**
   * 把当前标签的视图附到窗口**最底层**：不抢显示，但让 Chromium 认为它是 visible 的。
   *
   * 为什么需要它：视图没附到窗口上时（后台环境），页面自报 `visibility: hidden`，
   * Chromium 会把输入事件**直接丢掉**（CDP 的和原生的都丢）——实测三次全失败。
   * 附到最底层之后页面自报 visible，**CDP 输入能落进去**，而人看到的仍是上面那个视图。
   *
   * 附上去会**抢走 webContents 焦点**（实测），所以调用方必须马上把焦点还给正在显示的那个
   * （见 `EnvironmentManager.ensureOperable`）——不然人打字会打进一个看不见的页面。
   */
  attachBelow(): boolean {
    const tab = this.active();
    if (!tab) return false;
    if (this.#attached === tab.view) return false; // 已经挂着了（就是被显示的那个）
    const view = tab.view;
    const bounds = this.#effectiveViewport();
    this.#viewport = bounds;
    this.#options.layers.setSlot('below', view, { visible: true, bounds });
    this.#below = view;
    return true;
  }

  /** 摘掉 `attachBelow` 挂上去的那个视图（只摘它，不动正在显示的那个）。 */
  detachBelow(): void {
    if (!this.#below) return;
    if (this.#options.layers.slotView('below') === this.#below) {
      this.#options.layers.setSlot('below', undefined);
    }
    this.#below = undefined;
  }

  get attachedBelow(): boolean {
    return this.#below !== undefined;
  }

  setViewport(bounds: ViewportRect): void {
    this.#viewport = bounds;
    const tab = this.active();
    const visible = this.#viewVisible && this.#viewportReady();
    if (tab && this.#attached === tab.view) {
      this.#options.layers.setBounds('page', bounds);
      this.#options.layers.setVisible('page', visible);
    }
    if (this.#below) {
      this.#options.layers.setBounds('below', bounds);
    }
  }

  /**
   * 让开 / 收回页面视图。不改变 attach 状态——只是画不画的问题，
   * 所以浮层关掉后页面还在原位，不会重新加载。
   */
  setViewVisible(visible: boolean): void {
    this.#viewVisible = visible;
    if (!this.#attached) return;
    const effective = visible && this.#viewportReady();
    if (this.#options.layers.slotView('page') === this.#attached) {
      this.#options.layers.setVisible('page', effective);
    }
  }

  /** 把当前标签的视图放进窗口。切换环境时由 EnvironmentManager 调用。 */
  attach(): void {
    // 从 attachBelow 的临时宿主升级成显示中的视图时，先清掉底层引用，
    // 否则之后 detachBelow 会把刚提到顶层的同一个视图再摘掉。
    this.detachBelow();
    this.#visible = true;
    this.#showActive();
  }

  detach(): void {
    this.#visible = false;
    // 切走之后「被界面让开」这个状态就没意义了：下次再挂上来应当从不让开开始
    // （不复位的话，后台环境会因为一个陈旧的 false 被 assertInputOnScreen 拒绝）
    this.#viewVisible = true;
    this.detachBelow();
    if (!this.#attached) return;
    if (this.#options.layers.slotView('page') === this.#attached) {
      this.#options.layers.setSlot('page', undefined);
    }
    this.#attached = undefined;
  }

  destroy(): void {
    if (this.#changeTimer) {
      clearTimeout(this.#changeTimer);
      this.#changeTimer = undefined;
    }
    for (const id of [...this.#tabs.keys()]) this.#remove(id, true, { silent: true });
    this.#favicons.clear();
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  #wire(tab: Tab): void {
    const wc = tab.webContents;
    if (!wc) return;
    const id = tab.id;

    wc.setWindowOpenHandler((details) => this.#onWindowOpen(details));

    // 页面获得焦点时键盘事件只发给它自己的 webContents，不会经过 app shell。
    wc.on('before-input-event', (event, input) => {
      const shortcut = browserShortcut(input);
      if (!shortcut) return;
      event.preventDefault();
      this.#options.window.webContents.send('browser:shortcut', shortcut);
    });

    const sync = (patch: Partial<TabState> = {}) => {
      this.#list.update(id, { ...tab.state, ...patch });
      this.#notify();
    };

    wc.on('page-title-updated', () => sync());
    wc.on('did-navigate', (_event, url) => {
      this.#options.onEvent('browser.navigated', `标签 ${this.#list.indexOf(id) + 1} → ${url}`);
      this.#options.onUrlVisited?.(url);
      this.#options.onOriginZoomNeeded?.(tab, url);
      // 换了页面，上一个页面的图标就不是这个标签的了（和 Chrome 一致）
      sync({ url, favicon: undefined });
    });
    wc.on('context-menu', (_event, params) => {
      this.#options.onContextMenu?.(tab, params);
    });
    wc.on('update-target-url', (_event, url) => {
      this.#options.onTargetUrl?.(url);
    });
    wc.on('found-in-page', (_event, result) => {
      this.#options.onFoundInPage?.(result);
    });
    wc.on('did-navigate-in-page', (_event, url) => {
      this.#options.onUrlVisited?.(url);
      sync({ url });
    });
    wc.on('page-favicon-updated', (_event, favicons) => {
      const url = favicons[0];
      if (url) void this.#loadFavicon(id, url);
    });
    // 重新开始加载就清掉上一次的错误——不然「换了个好地址」之后界面还挂着旧报错
    wc.on('did-start-loading', () => {
      tab.setLoadError(undefined);
      sync({ loading: true });
    });
    wc.on('did-stop-loading', () => sync({ loading: false }));
    // 只有主框架失败才算这个标签是坏的；iframe / 子资源失败不该把整个页面标红
    wc.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.setLoadError(`${errorDescription || 'ERR_FAILED'} (${errorCode})`);
      sync();
    });
    wc.on('media-started-playing', () => sync({ audible: true }));
    wc.on('media-paused', () => sync({ audible: false }));

    // 页面自己调 window.close() 会走到这里：Electron 已经把 webContents 销毁了，
    // 我们只把它当成「这个标签被关掉了」，绝不再去碰 view.webContents。
    wc.on('destroyed', () => this.#remove(id, false));
  }

  /**
   * 取 favicon 并转成 data URL。
   *
   * 必须在这里取，不能让渲染层直接 `<img src="http://...">`：
   * 1. 渲染层的 CSP 只允许 `img-src 'self' data:`（`src/renderer/index.html`），
   *    远程图标会被静默拦掉，标签条永远只剩地球占位图；
   * 2. 图标请求必须走**这个环境的** session（代理 / Cookie），否则要代理才连得上的
   *    站点取不到图标，还会把请求从应用自己的出口发出去。
   */
  async #loadFavicon(tabId: string, url: string): Promise<void> {
    const dataUrl = await this.#fetchFavicon(url);
    // 取的过程中标签可能已经关了、或者又导航到别处了
    if (!this.#tabs.has(tabId)) return;
    this.#list.update(tabId, { favicon: dataUrl });
    this.#notify();
  }

  async #fetchFavicon(url: string): Promise<string | undefined> {
    if (this.#favicons.has(url)) {
      const cached = this.#favicons.get(url);
      this.#favicons.delete(url);
      this.#favicons.set(url, cached);
      return cached;
    }
    let dataUrl: string | undefined;
    try {
      const response = await this.#options.session.fetch(url);
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !type.startsWith('image/')) throw new Error(`favicon ${response.status} ${type}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_FAVICON_BYTES) throw new Error('favicon too large');
      dataUrl = `data:${type};base64,${bytes.toString('base64')}`;
    } catch {
      // 取不到就当没有图标，UI 退回占位图标
    }
    if (this.#favicons.size >= MAX_FAVICON_CACHE) {
      const oldest = this.#favicons.keys().next().value;
      if (oldest !== undefined) this.#favicons.delete(oldest);
    }
    this.#favicons.set(url, dataUrl);
    return dataUrl;
  }

  /**
   * 新窗口分流。只有三档会真的进来 —— `default`（`_self`/`_parent`）由 Electron
   * 自己原地导航，具名窗口由 Electron 自己复用，都不会调到 handler（见计划文档 §7.2）。
   */
  #onWindowOpen(details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse {
    switch (details.disposition) {
      case 'foreground-tab':
      case 'background-tab':
      case 'new-window': {
        const activate = details.disposition !== 'background-tab';
        return {
          action: 'allow',
          outlivesOpener: true,
          createWindow: (rawOptions) => {
            const opts = rawOptions as CreateWindowOptions;
            const tab = this.create({
              webContents: opts.webContents,
              webPreferences: opts.webPreferences,
              url: details.url,
              activate,
            });
            const collapsed = details.disposition === 'new-window' ? '（弹窗收敛成标签）' : '';
            this.#options.onEvent(
              'tab.opened',
              `${details.disposition} → 标签 ${this.#list.indexOf(tab.id) + 1}${collapsed} ${details.url}`,
            );
            this.#options.onPopup?.(tab.id, details.url);
            const wc = tab.webContents;
            if (!wc) throw new Error('新标签没有可用的 webContents');
            return wc;
          },
        };
      }
      default:
        // 实测到不了这里。纯防御：绝不让页面开出不受 Environment 管控的窗口。
        this.#options.onEvent('popup.denied', `${details.disposition} ${details.url}`);
        return { action: 'deny' };
    }
  }

  #remove(id: string, destroyWebContents: boolean, options: { silent?: boolean } = {}): void {
    const tab = this.#tabs.get(id);
    if (!tab) return; // 已经处理过（用户关的 / 页面自己关的）

    const wasActive = this.#list.activeId === id;
    // 入「最近关闭」栈：⌘⇧T 靠它。环境整体停掉走的是 silent 那条（`destroy()`），不入栈。
    if (!options.silent) this.#rememberClosed(tab);
    this.#tabs.delete(id);
    this.#controllers.get(id)?.detach();
    this.#controllers.delete(id);
    this.#options.onTabDestroyed(id);
    const { empty } = this.#list.remove(id);

    if (wasActive && this.#attached === tab.view) {
      if (this.#options.layers.slotView('page') === tab.view) {
        this.#options.layers.setSlot('page', undefined);
      }
      this.#attached = undefined;
    }
    if (this.#below === tab.view) this.detachBelow();
    if (destroyWebContents) tab.destroy();

    if (options.silent) return;

    if (empty) {
      this.#notify();
      this.#options.onEmpty();
      return;
    }
    if (wasActive) this.#showActive();
    this.#notify();
  }

  /** 记一条「刚关掉的标签」。没有地址的标签（about:blank）不入栈——重开一个空白页没意义。 */
  #rememberClosed(tab: Tab): void {
    const state = tab.state;
    if (!state.url || state.url === 'about:blank') return;
    this.#closed.unshift({ url: state.url, title: state.title });
    if (this.#closed.length > CLOSED_STACK_MAX) this.#closed.length = CLOSED_STACK_MAX;
  }

  #effectiveViewport(): ViewportRect {
    return this.#options.getViewport?.() ?? this.#viewport;
  }

  #viewportReady(): boolean {
    return this.#options.isViewportReady ? this.#options.isViewportReady() : true;
  }

  #showActive(): void {
    // 没显示在右侧区域就不要往窗口里加视图。
    // 否则后台环境的页面自己开标签时，新视图会盖到当前显示的页面上面。
    if (!this.#visible) return;

    const tab = this.active();
    if (!tab) return;

    const bounds = this.#effectiveViewport();
    this.#viewport = bounds;
    const visible = this.#viewVisible && this.#viewportReady();

    this.#attached = tab.view;
    this.#options.layers.setSlot('page', tab.view, {
      visible,
      bounds,
    });
    this.#options.onViewChanged();
  }

  #notify(): void {
    if (this.#changeTimer) return;
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = undefined;
      this.#options.onChanged();
    }, CHANGE_THROTTLE_MS);
  }
}
