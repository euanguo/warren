/**
 * BrowserController：**页面门面**。把页面级上下文（`ctx.ts` 的 PageContext）递给各职责模块，
 * 并保留调用方用到的公开方法名。
 *
 * 职责划分（按 job，不是按行数）：
 * - `snapshot.ts`   AX 取树 + snapshot/ref 分配 + 截图
 * - `waits.ts`      七种等待 + navigate/reload 的 waitUntil 四态
 * - `actions.ts`    元素动作 + 弹窗/下载
 * - `escape.ts`     evaluate / fetch / cdp / clearDataForOrigin
 * - `keymouse.ts`   坐标鼠标 + 键盘
 * - `target.ts`     选择器解析（纯函数）；本文件保留需要 CDP 的 `#backendIdFor*`
 * - 导航、info/events、dialog 守卫与收据留在这里
 */
import type { WebContents } from 'electron';
import {
  attachSession,
  childSessions,
  clearChildSessions,
  detachSession,
  markDialogHandled,
  send,
  sendOn,
} from './session.ts';
import { RefTable } from './refs.ts';
import { normalizeTarget, pickNth, assertUnique, type NormalizedTarget } from './target.ts';
import type { MouseButton } from './input.ts';
import { clearPendingRelease, setPendingRelease } from './mouse-state.ts';
import {
  assignRefs,
  frameOfBackendId,
  invalidateAxCache,
  readAxFrames,
  readAxNodes,
  screenshot,
  snapshot,
} from './snapshot.ts';
import {
  ACTION_TIMEOUT_DEFAULT,
  assertNoDialog,
  emptyPending,
  err,
  evalOnNode,
  nodeIdFor,
  pageError,
  peekDialog,
  probePoint,
  clearHighlight,
  highlightElement,
  resolveTarget,
  scrollIntoView,
} from './page-helpers.ts';
import type { PageContext, PendingSink } from './ctx.ts';
import { checkTargetState, readTargetProperty, type InspectProp, type InspectState } from './ops/inspector.ts';
import { applyEmulationSetting, type EmulationSetting } from './ops/emulation.ts';
import { callWebMcpTool, listWebMcpTools } from './ops/webmcp.ts';
import { auditAccessibility, collectVitals, inspectReactTree, printPdf, type PdfOptions } from './ops/diagnostics.ts';
import {
  awaitLoad,
  readyState,
  smartSettle,
  waitFor,
  waitForEvent,
  waitForFunction,
  waitForLoadState,
  waitForSelector,
  waitForTimeout,
  waitForURL,
} from './waits.ts';
import { cdp, clearDataForOrigin, evaluate, fetchPage } from './escape.ts';
import {
  acceptDialog,
  click,
  dblclick,
  dismissDialog,
  downloadCancel,
  downloadSaveAs,
  downloadStatus,
  drag,
  dropFiles,
  fill,
  focus,
  hover,
  press,
  selectOption,
  setChecked,
  setInputFiles,
} from './actions.ts';
import {
  keyboardDown,
  keyboardInsert,
  keyboardPaste,
  keyboardPress,
  keyboardType,
  keyboardUp,
  mouseClick,
  mouseDown,
  mouseMove,
  mouseUp,
  mouseWheel,
} from './keymouse.ts';
import type {
  AxNode,
  TargetInput,
  SnapshotOptions,
  ScreenshotOptions,
  NavigateOptions,
  UrlMatcher,
  SelectorState,
  LoadState,
  WaitPredicate,
  WaitEventKind,
  ClickOptions,
  DragOptions,
  FillOptions,
  SelectValue,
  PressOptions,
  FetchOptions,
  FetchResult,
  PageInfo,
  PageEvent,
} from '../../shared/types.ts';

export type { AxNode };
/** 老 Target 对象名保留，老路径引用不断。 */
export type Target = Exclude<TargetInput, string | { kind: 'ref' } | { kind: 'xpath' }>;

export type { PendingSink };

interface Ctx {
  envId: string;
  tabId: string;
  tabIndex: () => number;
  pending: PendingSink;
  lastActivityAt: () => number;
  inFlightCount: () => number;
  lastNavigationError: () => { url: string; error: string; at: string } | null;
  noteActivity: () => void;
  downloadById: (id: string) => { item: Electron.DownloadItem; url: string; filename: string; path: string } | null;
  record: (type: string, message: string) => void;
}

/** 选择器遍历在页面内的返回值。`error` 有值 = 求值失败，`errorKind` 说明是不是语法错。 */
interface SelectorWalkResult {
  count?: number;
  skipped?: number;
  errorKind?: 'syntax' | 'other';
  error?: string;
}

/**
 * 选择器遍历的页面内脚本。
 *
 * 分类是这段代码的主要职责，不是副作用：
 * - `document.querySelector` 抛 SyntaxError → 选择器真的非法（`errorKind: 'syntax'`）；
 * - `shadowRoot` / `contentDocument` 单个子树上取不到 → 跳过，不牵连整次查询；
 * - 其它异常原样带回（`errorKind: 'other'`），由调用方报 `SELECTOR_EVAL_FAILED`，
 *   绝不再冒充「CSS 非法」。
 */
function selectorWalkScript(selector: string): string {
  return `(() => {
    const sel = ${JSON.stringify(selector)};
    const describe = (e) => String((e && (e.message || e.name)) || e);
    try {
      document.querySelector(sel);
    } catch (e) {
      return { errorKind: e && e.name === 'SyntaxError' ? 'syntax' : 'other', error: describe(e) };
    }
    const out = [];
    const skipped = [];
    const walk = (root) => {
      let matches;
      try {
        matches = root.querySelectorAll(sel);
      } catch (e) {
        skipped.push(describe(e));
        return;
      }
      // 逐个 push，不用 push(...matches)：匹配数上十万时展开实参会撑爆调用栈（实测 RangeError）
      for (const el of matches) out.push(el);
      let all;
      try {
        all = root.querySelectorAll('*');
      } catch (e) {
        skipped.push(describe(e));
        return;
      }
      for (const el of all) {
        // 同源 iframe 才拿得到 contentDocument；跨源返回 null，受沙箱限制的 frame 可能直接抛
        let shadow = null;
        try {
          shadow = el.shadowRoot;
        } catch (e) {
          skipped.push(describe(e));
        }
        if (shadow) walk(shadow);
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch (e) {
          skipped.push(describe(e));
        }
        if (doc) walk(doc);
      }
    };
    try {
      walk(document);
    } catch (e) {
      return { errorKind: 'other', error: describe(e) };
    }
    window.__warrenMatches = out;
    return { count: out.length, skipped: skipped.length };
  })()`;
}

export class BrowserController {
  #wc: WebContents;
  #ctx: Ctx;
  #pageCtx?: PageContext;
  #refs = new RefTable();
  #holding = false;
  /** 按会话缓存隔离世界上下文（`''` 表示主会话，其余为 OOPIF `sessionId`）。 */
  #worldCtxMap = new Map<string, number>();
  /** 当前限定的活动 frameId（空表示全部/主文档）。 */
  #activeFrameId?: string;
  /** 自动弹窗处理策略（`none` 默认显式报错由调用方处理；`accept`/`dismiss` 自动应答）。 */
  #dialogPolicy: 'none' | 'accept' | 'dismiss' = 'none';

  constructor(wc: WebContents, ctx?: Partial<Ctx>) {
    this.#wc = wc;
    this.#ctx = {
      envId: ctx?.envId ?? '',
      tabId: ctx?.tabId ?? '',
      tabIndex: ctx?.tabIndex ?? (() => 0),
      pending: ctx?.pending ?? emptyPending(),
      lastActivityAt: ctx?.lastActivityAt ?? (() => 0),
      inFlightCount: ctx?.inFlightCount ?? (() => 0),
      lastNavigationError: ctx?.lastNavigationError ?? (() => null),
      noteActivity: ctx?.noteActivity ?? (() => {}),
      downloadById: ctx?.downloadById ?? (() => null),
      record: ctx?.record ?? (() => {}),
    };
    wc.on('did-start-navigation', ((_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      clearChildSessions(wc);
      clearPendingRelease(wc.id);
      invalidateAxCache(wc.id);
      this.#worldCtxMap.clear();
      this.#activeFrameId = undefined;
    }) as never);
  }

  #page(): PageContext {
    this.#pageCtx ??= {
      wc: this.#wc,
      send: <T = unknown>(method: string, params: Record<string, unknown> = {}) => this.#send<T>(method, params),
      sendOn: <T = unknown>(sessionId: string | undefined, method: string, params: Record<string, unknown> = {}) => {
        this.attach();
        return sendOn<T>(this.#wc, sessionId, method, params);
      },
      childSessions: () => childSessions(this.#wc),
      sendInput: (method: string, params: Record<string, unknown>) => this.#sendInput(method, params),
      refs: this.#refs,
      backendIdFor: (target: TargetInput) => this.#backendIdFor(target),
      frameOf: (backendNodeId: number) => frameOfBackendId(this.#page(), backendNodeId),
      downloadById: (downloadId: string) => this.#ctx.downloadById(downloadId),
      pending: this.#ctx.pending,
      tabIndex: this.#ctx.tabIndex,
      lastActivityAt: this.#ctx.lastActivityAt,
      inFlightCount: this.#ctx.inFlightCount,
      lastNavigationError: this.#ctx.lastNavigationError,
      activeFrameId: () => this.#activeFrameId,
      record: this.#ctx.record,
    };
    return this.#pageCtx;
  }

  get webContents(): WebContents {
    return this.#wc;
  }

  /** 老 attach/detach 语义保留（幂等）。 */
  attach(): void {
    if (this.#holding) return;
    this.#holding = true;
    void attachSession(this.#wc).catch(() => {});
  }

  /**
   * 让页面相信自己有 document 焦点，但不激活 Electron 窗口。
   * 后台 agent 输入需要真实站点的 `document.hasFocus()` 守卫通过；`wc.focus()` 会抢前台。
   */
  async emulateFocus(): Promise<void> {
    this.attach();
    await this.#send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }

  /** 后台视图尚未拿到布局尺寸时，给页面一个可点击的视口。 */
  async emulateViewport(width: number, height: number): Promise<void> {
    this.attach();
    await this.#send('Emulation.setDeviceMetricsOverride', {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async clearEmulatedViewport(): Promise<void> {
    this.attach();
    await this.#send('Emulation.clearDeviceMetricsOverride');
  }

  detach(): void {
    if (!this.#holding) return;
    this.#holding = false;
    try {
      detachSession(this.#wc);
    } catch {
      // webContents 可能已销毁
    }
  }

  get attached(): boolean {
    return this.#holding;
  }

  #send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.attach();
    return send<T>(this.#wc, method, params);
  }

  /**
   * 发输入命令（`Input.*`）。
   *
   * JS dialog 打开时渲染进程会**挂住**输入命令的应答——点击触发 `alert()` 的那一次
   * `mouseReleased` 永远不返回，脚本就死在这里。所以这里和「dialog 是否已打开」赛跑：
   * dialog 一出现就把控制权交回调用方（由它 accept/dismiss），其余情况等命令真正完成。
   */
  async #sendInput(method: string, params: Record<string, unknown>): Promise<void> {
    let outcome: 'pending' | 'ok' | Error = 'pending';
    this.#send(method, params).then(
      () => {
        outcome = 'ok';
      },
      (error: Error) => {
        outcome = error;
      },
    );
    const deadline = Date.now() + ACTION_TIMEOUT_DEFAULT;
    for (;;) {
      if (outcome !== 'pending') {
        if (typeof outcome === 'string') return;
        throw outcome;
      }
      if (this.#peekDialog()) {
        // mousePressed 触发 JS Dialog 时记录未闭合按压态，待弹窗处理完毕自动补发 mouseReleased
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
          setPendingRelease(this.#wc.id, {
            x: Number(params.x ?? 0),
            y: Number(params.y ?? 0),
            button: String(params.button ?? 'left'),
            clickCount: Number(params.clickCount ?? 1),
          });
        }
        return;
      }
      if (Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // ── 导航 ──────────────────────────────────────────────────────────

  async navigate(url: string, opts: NavigateOptions = {}): Promise<{ url: string }> {
    // 有未处理的 dialog 时 Page.navigate 会被渲染进程挂住，一直等到 RPC 超时
    this.assertNoDialog();
    const wc = this.#wc;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const waitUntil = opts.waitUntil ?? 'load';
    if (opts.referer !== undefined) {
      await this.#send('Page.navigate', { url, referrer: opts.referer });
    } else {
      await this.#send('Page.navigate', { url });
    }
    const loaded = await awaitLoad(this.#page(), waitUntil, timeoutMs);
    if (loaded.timedOut) {
      // 超时要带够诊断信息，否则「为什么没等到」只能靠猜
      throw err(
        'TIMEOUT',
        `navigate timed out after ${timeoutMs}ms: committed=${loaded.committed} url=${loaded.url} readyState=${await readyState(this.#page())}`,
      );
    }
    markDialogHandled(this.#wc); // 新文档不可能还挂着旧 dialog
    invalidateAxCache(this.#wc.id); // 上一页的 AX 结构不能喂给下一步
    this.#worldCtxMap.clear(); // 隔离世界跟着文档走
    this.#refs.bump();
    return { url: loaded.url || wc.getURL() };
  }

  async reload(opts: NavigateOptions = {}): Promise<{ url: string }> {
    this.assertNoDialog();
    const wc = this.#wc;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    wc.reload();
    const loaded = await awaitLoad(this.#page(), opts.waitUntil ?? 'load', timeoutMs);
    if (loaded.timedOut) {
      throw err(
        'TIMEOUT',
        `reload timed out after ${timeoutMs}ms: url=${loaded.url} readyState=${await readyState(this.#page())}`,
      );
    }
    markDialogHandled(this.#wc);
    invalidateAxCache(this.#wc.id);
    this.#worldCtxMap.clear();
    this.#refs.bump();
    return { url: wc.getURL() };
  }

  async hardReload(opts: NavigateOptions = {}): Promise<{ url: string }> {
    this.assertNoDialog();
    const wc = this.#wc;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    wc.reloadIgnoringCache();
    const loaded = await awaitLoad(this.#page(), opts.waitUntil ?? 'load', timeoutMs);
    if (loaded.timedOut) {
      throw err(
        'TIMEOUT',
        `hardReload timed out after ${timeoutMs}ms: url=${loaded.url} readyState=${await readyState(this.#page())}`,
      );
    }
    markDialogHandled(this.#wc);
    invalidateAxCache(this.#wc.id);
    this.#worldCtxMap.clear();
    this.#refs.bump();
    return { url: wc.getURL() };
  }

  async setViewportPreset(preset: 'auto' | 'desktop-1440' | 'laptop-1280' | 'mobile-390'): Promise<void> {
    if (preset === 'auto') {
      await this.clearEmulatedViewport();
      return;
    }
    const specs: Record<
      'desktop-1440' | 'laptop-1280' | 'mobile-390',
      { width: number; height: number; mobile: boolean; scale: number }
    > = {
      'desktop-1440': { width: 1440, height: 900, mobile: false, scale: 1 },
      'laptop-1280': { width: 1280, height: 800, mobile: false, scale: 1 },
      'mobile-390': { width: 390, height: 844, mobile: true, scale: 2 },
    };
    const spec = specs[preset];
    this.attach();
    await this.#send('Emulation.setDeviceMetricsOverride', {
      width: spec.width,
      height: spec.height,
      deviceScaleFactor: spec.scale,
      mobile: spec.mobile,
    });
  }

  navigationState(): { url: string; canGoBack: boolean; canGoForward: boolean; loading: boolean } {
    const history = this.#wc.navigationHistory;
    return {
      url: this.#wc.getURL(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      loading: this.#wc.isLoading(),
    };
  }

  goBack(): void {
    const history = this.#wc.navigationHistory;
    if (history.canGoBack()) history.goBack();
  }

  goForward(): void {
    const history = this.#wc.navigationHistory;
    if (history.canGoForward()) history.goForward();
  }

  async title(): Promise<string> {
    return this.#wc.getTitle();
  }

  currentUrl(): string {
    return this.#wc.getURL();
  }

  // ── 观察 ──────────────────────────────────────────────────────────
  // AX 取树与截图在 snapshot.ts。
  // ref 表是 agent 的会话状态：**只有 snapshotWithRefs() 会写它**。内部解析走
  // readAxNodes()、别的调用方走 snapshot()——两者都不动 ref 表，否则一次「顺手看一眼」
  // 就把 agent 手上的 @N 重编号（元素集变了就指到别的元素），而且不报 TARGET_STALE。

  async snapshot(options: SnapshotOptions & { limit?: number; interestingOnly?: boolean } = {}): Promise<AxNode[]> {
    return snapshot(this.#page(), options);
  }

  /** agent 专用：取快照并分配 `@N`。别的调用方一律用 `snapshot()`，别动 ref 表。 */
  async snapshotWithRefs(options: SnapshotOptions & { limit?: number } = {}): Promise<AxNode[]> {
    const nodes = await snapshot(this.#page(), options);
    assignRefs(this.#page(), nodes, { includeStableLocator: options.includeStableLocator });
    return nodes;
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<import('../../shared/types.ts').ScreenshotResult> {
    return screenshot(this.#page(), opts, this.#ctx.envId);
  }

  async info(): Promise<
    PageInfo & { lastNavigationError?: { url: string; error: string; at: string } | null; activeFrameId?: string }
  > {
    const navError = this.#ctx.lastNavigationError();
    return {
      url: this.#wc.getURL(),
      title: this.#wc.getTitle(),
      loading: this.#wc.isLoading(),
      dialog: this.#ctx.pending.dialogOpen(),
      tab: { id: this.#ctx.tabId, index: this.#ctx.tabIndex() },
      env: this.#ctx.envId,
      ...(navError ? { lastNavigationError: navError } : {}),
      ...(this.#activeFrameId ? { activeFrameId: this.#activeFrameId } : {}),
    };
  }

  /** 列出当前页面的所有 frame（主文档 + 同源 iframe + OOPIF 跨源子会话）。 */
  async listFrames(): Promise<
    Array<{ index: number; frameId: string; url: string; name?: string; crossOrigin: boolean; active: boolean }>
  > {
    const frames = await readAxFrames(this.#page());
    return frames.map((f, index) => ({
      index,
      frameId: f.frameId,
      url: f.url ?? '',
      ...(f.name ? { name: f.name } : {}),
      crossOrigin: Boolean(f.sessionId),
      active: this.#activeFrameId ? f.frameId === this.#activeFrameId : index === 0,
    }));
  }

  /** 切换当前聚焦的 frame 作用域（`main` / 序号 / `frameId` / URL 子串）。 */
  async selectFrame(ref: string): Promise<{ activeFrameId: string | null; url?: string }> {
    const trimmed = ref.trim();
    if (!trimmed || trimmed.toLowerCase() === 'main' || trimmed === '0') {
      this.#activeFrameId = undefined;
      return { activeFrameId: null, url: this.#wc.getURL() };
    }
    const frames = await readAxFrames(this.#page());
    let picked = frames.find((f) => f.frameId === trimmed);
    if (!picked && /^\d+$/.test(trimmed)) {
      picked = frames[Number(trimmed)];
    }
    if (!picked) {
      const lower = trimmed.toLowerCase();
      picked = frames.find(
        (f) => (f.name && f.name.toLowerCase() === lower) || (f.url && f.url.toLowerCase().includes(lower)),
      );
    }
    if (!picked) {
      throw err('TARGET_NOT_FOUND', `找不到 frame：${ref}（可用 browser frame <env> list 查看）`);
    }
    this.#activeFrameId = picked.frameId;
    return { activeFrameId: picked.frameId, url: picked.url };
  }

  get activeFrameId(): string | undefined {
    return this.#activeFrameId;
  }

  setDialogPolicy(policy: 'none' | 'accept' | 'dismiss'): { policy: 'none' | 'accept' | 'dismiss' } {
    this.#dialogPolicy = policy;
    return { policy };
  }

  get dialogPolicy(): 'none' | 'accept' | 'dismiss' {
    return this.#dialogPolicy;
  }

  /** 若启用了 `--auto-dialog`，自动处理当前阻塞弹窗并返回处理结果。 */
  async handleAutoDialogIfNeeded(): Promise<{ handled: boolean; action?: 'accept' | 'dismiss'; type?: string }> {
    if (this.#dialogPolicy === 'none' || !this.#peekDialog()) return { handled: false };
    if (this.#dialogPolicy === 'accept') {
      const r = await acceptDialog(this.#page());
      return { handled: true, action: 'accept', type: r.type };
    }
    const r = await dismissDialog(this.#page());
    return { handled: true, action: 'dismiss', type: r.type };
  }

  async smartSettle(opts?: { maxWaitMs?: number; quietMs?: number }) {
    return smartSettle(this.#page(), opts);
  }

  /** 读并清空本 tab 缓冲：dialog/popup/download。 */
  async events(): Promise<PageEvent[]> {
    const out: PageEvent[] = [];
    const d = this.#ctx.pending.takeDialogEvent();
    if (d) out.push(d);
    let p: ReturnType<PendingSink['consumePopup']>;
    while ((p = this.#ctx.pending.consumePopup())) {
      out.push({ kind: 'popup', tabId: p.tabId, index: p.index, url: p.url, at: p.at });
    }
    let dl: ReturnType<PendingSink['consumeDownload']>;
    while ((dl = this.#ctx.pending.consumeDownload())) {
      out.push({
        kind: 'download',
        downloadId: dl.downloadId,
        url: dl.url,
        filename: dl.filename,
        at: dl.at,
      });
    }
    return out;
  }

  // ── 等待 ──────────────────────────────────────────────────────────
  // 实现都在 waits.ts；这里只把页面上下文递过去。

  async waitFor(predicate: WaitPredicate, options: { timeoutMs?: number } = {}): Promise<void> {
    return waitFor(this.#page(), predicate, options);
  }

  async waitForURL(matcher: UrlMatcher, options: { timeoutMs?: number } = {}): Promise<{ url: string }> {
    return waitForURL(this.#page(), matcher, options);
  }

  async waitForSelector(
    target: TargetInput,
    options: { state?: SelectorState; timeoutMs?: number } = {},
  ): Promise<{ ref?: string }> {
    return waitForSelector(this.#page(), target, options);
  }

  async waitForFunction(
    fn: string,
    arg?: unknown,
    options: { timeoutMs?: number; polling?: number } = {},
  ): Promise<unknown> {
    return waitForFunction(this.#page(), fn, arg, options);
  }

  async waitForLoadState(
    state: LoadState = 'load',
    options: { timeoutMs?: number; idleMs?: number } = {},
  ): Promise<void> {
    return waitForLoadState(this.#page(), state, options);
  }

  async waitForTimeout(ms: number): Promise<void> {
    return waitForTimeout(this.#page(), ms);
  }

  async waitForEvent(kind: WaitEventKind, options: { timeoutMs?: number } = {}): Promise<PageEvent> {
    return waitForEvent(this.#page(), kind, options);
  }

  // ── 目标解析 ──────────────────────────────────────────────────────

  /** 诊断用：把目标的点击点和「页面自己算的点」并排返回（跨源 iframe 坐标换算的验收口）。 */
  async probePoint(target: TargetInput): ReturnType<typeof probePoint> {
    return probePoint(this.#page(), target);
  }

  /**
   * 高亮元素（产品能力：人机同视的窗口里让人看见 agent 要操作哪里）。
   * 不传 target 就是清除。返回主 frame 视口里的矩形，调用方可以据此裁剪截图。
   */
  async highlight(target?: TargetInput): Promise<{
    highlighted: boolean;
    rect?: { x: number; y: number; width: number; height: number };
  }> {
    const page = this.#page();
    if (target === undefined) {
      await clearHighlight(page);
      return { highlighted: false };
    }
    const { backendNodeId, sessionId } = await resolveTarget(page, target);
    const rect = await highlightElement(page, backendNodeId, sessionId);
    return { highlighted: true, rect };
  }

  async #backendIdFor(target: TargetInput): Promise<number> {
    const norm: NormalizedTarget = normalizeTarget(target);
    if (norm.kind === 'ref') {
      const resolved = this.#refs.resolve(norm.ref);
      // 校验节点是否仍附着于 DOM；若因 React 局部重绘脱离，尝试按 (frameId, role, name) 唯一自愈
      const sessionId =
        resolved.entry?.sessionId ??
        (await frameOfBackendId(this.#page(), resolved.backendId).catch(() => undefined))?.sessionId;
      const alive = await this.#page()
        .sendOn<{ node?: { backendNodeId?: number } }>(sessionId, 'DOM.describeNode', {
          backendNodeId: resolved.backendId,
        })
        .catch(() => null);
      if (alive?.node?.backendNodeId) return resolved.backendId;
      const freshNodes = await readAxNodes(this.#page(), 2000).catch(() => []);
      const healed = this.#refs.tryHeal(norm.ref, freshNodes);
      if (healed) return healed.backendId;
      return resolved.backendId;
    }
    if (norm.kind === 'xpath') {
      return this.#backendIdForXpath(norm.xpath, norm.nth);
    }
    if (norm.kind === 'selector' || norm.kind === 'href') {
      return this.#backendIdForCss(norm);
    }
    if (norm.kind === 'role' || norm.kind === 'text' || norm.kind === 'label') {
      return this.#backendIdForAria(norm);
    }
    throw err('BAD_SELECTOR', `未知 Target: ${JSON.stringify(target)}`);
  }

  async #backendIdForCss(norm: {
    selector?: string;
    href?: string;
    hasText?: string;
    textIs?: string;
    nth?: number;
  }): Promise<number> {
    let selector = norm.selector ?? '';
    if (norm.href !== undefined) selector = `a[href*="${norm.href.replace(/"/g, '\\"')}"]`;
    const backendIds = await this.#backendIdsBySelector(selector);
    if (backendIds.length === 0) throw err('TARGET_NOT_FOUND', `selector not found: ${selector}`);
    let filtered = backendIds;
    if (norm.hasText || norm.textIs) {
      filtered = [];
      for (const id of backendIds) {
        const nodeId = await nodeIdFor(this.#page(), id).catch(() => 0);
        const text = nodeId
          ? await evalOnNode(this.#page(), nodeId, '(el) => (el.innerText ?? el.textContent ?? "")').catch(() => '')
          : '';
        const t = String(text ?? '');
        if (norm.hasText && t.includes(norm.hasText)) filtered.push(id);
        else if (norm.textIs && t.trim() === norm.textIs) filtered.push(id);
      }
      if (filtered.length === 0) throw err('TARGET_NOT_FOUND', `selector 文本过滤无匹配: ${selector}`);
    }
    if (filtered.length > 1 && norm.nth === undefined) {
      // 多匹配报歧义（带前 3 候选的描述）
      const preview: string[] = [];
      for (const id of filtered.slice(0, 3)) {
        const desc = await this.#send<{ node: { nodeName: string } }>('DOM.describeNode', {
          backendNodeId: id,
        }).catch(() => null);
        preview.push(desc ? String(desc.node.nodeName ?? '?').toLowerCase() : '?');
      }
      throw Object.assign(
        new Error(
          `target ambiguous: ${filtered.length} 个匹配（${preview.join(' / ')}），加 >> nth=N 或换定位：${selector}`,
        ),
        { code: 'TARGET_AMBIGUOUS' },
      );
    }
    return pickNth(filtered, norm.nth, selector);
  }

  /**
   * 枚举当前要搜索的会话列表：
   * - 未限定 `#activeFrameId` 时搜索主会话 + 全部 OOPIF 跨源子会话；
   * - 限定 `#activeFrameId` 时优先只搜目标 frame 所属会话。
   */
  #targetSessions(): Array<string | undefined> {
    const children = childSessions(this.#wc);
    if (this.#activeFrameId) {
      const matchedChild = children.find((c) => c.frameId === this.#activeFrameId);
      if (matchedChild) return [matchedChild.sessionId];
      return [undefined];
    }
    return [undefined, ...children.map((c) => c.sessionId)];
  }

  /**
   * CSS 选择器 → backendNodeId 列表。
   * 覆盖主文档、Open Shadow Root、同源 iframe、全部 OOPIF 跨源子会话，
   * 并在常规遍历 0 命中时通过 `DOM.getDocument({ depth: -1, pierce: true })` 兜底搜索 Closed Shadow Root。
   */
  async #backendIdsBySelector(selector: string): Promise<number[]> {
    const all: number[] = [];
    let firstSyntaxError: unknown;
    for (const sessionId of this.#targetSessions()) {
      try {
        const { contextId, count } = await this.#runSelectorWalk(selector, true, sessionId);
        if (count > 0) {
          const ids = await this.#backendIdsFromWorldArray(contextId, '__warrenMatches', count, sessionId);
          all.push(...ids);
        }
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === 'BAD_SELECTOR') {
          firstSyntaxError = error;
          break;
        }
        // 单个 OOPIF 会话销毁不影响主文档或其他会话
        if (!sessionId) throw error;
      }
    }
    if (firstSyntaxError) throw firstSyntaxError;
    if (all.length === 0) {
      const pierced = await this.#pierceClosedShadowSelector(selector);
      all.push(...pierced);
    }
    return all;
  }

  /**
   * Closed Shadow Root 兜底检索：利用 CDP `DOM.getDocument({ depth: -1, pierce: true })`
   * 遍历包含 `shadowRoots`（含 closed）的完整节点树，支持 `#id`、`.class`、`[attr="val"]` 与标签名匹配。
   */
  async #pierceClosedShadowSelector(selector: string): Promise<number[]> {
    const trimmed = selector.trim();
    if (!trimmed || /[\s>+~:,]/.test(trimmed)) return [];
    const idMatch = trimmed.match(/^#([A-Za-z0-9_-]+)$/);
    const classMatch = trimmed.match(/^\.([A-Za-z0-9_-]+)$/);
    const attrMatch = trimmed.match(/^\[([A-Za-z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/);
    const tagMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9-]*)$/);
    if (!idMatch && !classMatch && !attrMatch && !tagMatch) return [];

    const out: number[] = [];
    for (const sessionId of this.#targetSessions()) {
      const doc = await this.#page()
        .sendOn<{ root?: Record<string, unknown> }>(sessionId, 'DOM.getDocument', { depth: -1, pierce: true })
        .catch(() => null);
      if (!doc?.root) continue;
      const walk = (node: Record<string, unknown> | undefined) => {
        if (!node || out.length >= 20) return;
        const nodeType = Number(node.nodeType ?? 0);
        if (nodeType === 1) {
          const nodeName = String(node.nodeName ?? '').toLowerCase();
          const attrs = Array.isArray(node.attributes) ? (node.attributes as string[]) : [];
          const getAttr = (k: string): string | undefined => {
            for (let i = 0; i < attrs.length - 1; i += 2) {
              if (attrs[i]?.toLowerCase() === k.toLowerCase()) return attrs[i + 1];
            }
            return undefined;
          };
          let matched = false;
          if (idMatch) matched = getAttr('id') === idMatch[1];
          else if (classMatch) matched = (getAttr('class') ?? '').split(/\s+/).includes(classMatch[1]!);
          else if (tagMatch) matched = nodeName === tagMatch[1]!.toLowerCase();
          else if (attrMatch) {
            const val = getAttr(attrMatch[1]!);
            const expected = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
            matched = expected === undefined ? val !== undefined : val === expected;
          }
          if (matched && typeof node.backendNodeId === 'number') {
            out.push(node.backendNodeId);
          }
        }
        const children = Array.isArray(node.children) ? (node.children as Array<Record<string, unknown>>) : [];
        for (const c of children) walk(c);
        const shadows = Array.isArray(node.shadowRoots) ? (node.shadowRoots as Array<Record<string, unknown>>) : [];
        for (const s of shadows) walk(s);
        if (node.contentDocument && typeof node.contentDocument === 'object') {
          walk(node.contentDocument as Record<string, unknown>);
        }
      };
      walk(doc.root);
    }
    return out;
  }

  async #runSelectorWalk(
    selector: string,
    allowRetry: boolean,
    sessionId?: string,
  ): Promise<{ contextId: number; count: number }> {
    const contextId = await this.#isolatedContext(sessionId);
    let result: SelectorWalkResult;
    try {
      result = await this.#evalInWorld<SelectorWalkResult>(contextId, selectorWalkScript(selector), sessionId);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (allowRetry && /context|destroyed|cannot find|target closed|session closed/i.test(message)) {
        this.#worldCtxMap.delete(sessionId ?? '');
        return await this.#runSelectorWalk(selector, false, sessionId);
      }
      throw err('SELECTOR_EVAL_FAILED', `选择器求值失败（不是选择器非法）：${selector}；原始错误：${message}`);
    }
    if (typeof result?.error === 'string') {
      if (result.errorKind === 'syntax') throw err('BAD_SELECTOR', `CSS 非法: ${selector}（${result.error}）`);
      throw err('SELECTOR_EVAL_FAILED', `选择器求值失败（不是选择器非法）：${selector}；原始错误：${result.error}`);
    }
    if (!result || typeof result.count !== 'number') {
      throw err('SELECTOR_EVAL_FAILED', `选择器求值失败（不是选择器非法）：${selector}；隔离世界没有返回值`);
    }
    return { contextId, count: result.count };
  }

  async #backendIdForXpath(xpath: string, nth?: number): Promise<number> {
    const ids = await this.#xpathBackendIds(xpath);
    if (ids.length === 0) throw err('TARGET_NOT_FOUND', `xpath not found: ${xpath}`);
    if (ids.length > 1 && nth === undefined) {
      throw Object.assign(new Error(`target ambiguous: ${ids.length} 个匹配，加 >> nth=N：${xpath}`), {
        code: 'TARGET_AMBIGUOUS',
      });
    }
    return pickNth(ids, nth, xpath);
  }

  /** XPath → backendNodeId 列表。跨主会话与 OOPIF 子会话在隔离世界内求值。 */
  async #xpathBackendIds(xpath: string): Promise<number[]> {
    const all: number[] = [];
    for (const sessionId of this.#targetSessions()) {
      let contextId: number;
      try {
        contextId = await this.#isolatedContext(sessionId);
      } catch {
        if (!sessionId) throw err('BAD_SELECTOR', `xpath 非法: ${xpath}`);
        continue;
      }
      const count = await this.#evalInWorld<number>(
        contextId,
        `(() => {
           const xp = ${JSON.stringify(xpath)};
           try {
             const it = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
             const out = [];
             for (let i = 0; i < Math.min(it.snapshotLength, 50); i++) {
               const el = it.snapshotItem(i);
               if (el instanceof Element) out.push(el);
             }
             window.__warrenXpath = out;
             return out.length;
           } catch { return -1; }
         })()`,
        sessionId,
      ).catch(() => -1);
      if (typeof count !== 'number' || count < 0) {
        if (!sessionId) throw err('BAD_SELECTOR', `xpath 非法: ${xpath}`);
        continue;
      }
      if (count > 0) {
        const ids = await this.#backendIdsFromWorldArray(contextId, '__warrenXpath', count, sessionId);
        all.push(...ids);
      }
    }
    return all;
  }

  /** 隔离世界里的一个 JS 元素数组 → backendNodeId 列表。 */
  async #backendIdsFromWorldArray(
    contextId: number,
    name: string,
    count: number,
    sessionId?: string,
  ): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const ref = await this.#page()
        .sendOn<{ result: { objectId?: string } }>(sessionId, 'Runtime.evaluate', {
          contextId,
          expression: `window.${name}[${i}]`,
          returnByValue: false,
        })
        .catch(() => null);
      const objectId = ref?.result?.objectId;
      if (!objectId) continue;
      try {
        const node = await this.#page()
          .sendOn<{ node: { backendNodeId: number } }>(sessionId, 'DOM.describeNode', {
            objectId,
          })
          .catch(() => null);
        if (node?.node.backendNodeId) out.push(node.node.backendNodeId);
      } finally {
        await this.#page()
          .sendOn(sessionId, 'Runtime.releaseObject', { objectId })
          .catch(() => {});
      }
    }
    await this.#page()
      .sendOn(sessionId, 'Runtime.evaluate', {
        contextId,
        expression: `delete window.${name}`,
        returnByValue: true,
      })
      .catch(() => {});
    return out;
  }

  /** 按会话缓存隔离世界上下文。导航后失效，所以要跟着导航清掉。 */
  async #isolatedContext(sessionId?: string): Promise<number> {
    const key = sessionId ?? '';
    const cached = this.#worldCtxMap.get(key);
    if (cached !== undefined) return cached;
    const { frameTree } = await this.#page().sendOn<{ frameTree: { frame: { id: string } } }>(
      sessionId,
      'Page.getFrameTree',
    );
    const { executionContextId } = await this.#page().sendOn<{ executionContextId: number }>(
      sessionId,
      'Page.createIsolatedWorld',
      {
        frameId: frameTree.frame.id,
        worldName: 'warren',
      },
    );
    this.#worldCtxMap.set(key, executionContextId);
    return executionContextId;
  }

  async #evalInWorld<T>(contextId: number, expression: string, sessionId?: string): Promise<T> {
    const r = await this.#page().sendOn<{
      result: { value: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(sessionId, 'Runtime.evaluate', { contextId, expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw err('BAD_REQUEST', `页面内求值抛错: ${pageError(r.exceptionDetails)}`);
    return r.result?.value;
  }

  async #backendIdForAria(norm: NormalizedTarget): Promise<number> {
    // 只读 AX 树，**不注册 ref**：否则每次用 text=/role=/label= 定位都会把
    // agent 手上的 @N 重新编号，且不报错（点错元素最难查）。
    const nodes = await readAxNodes(this.#page(), 2000);
    const normText = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const isRole = norm.kind === 'role';
    const isLabel = norm.kind === 'label';
    const wanted =
      norm.kind === 'text'
        ? normText(norm.text)
        : isLabel
          ? normText((norm as { text: string }).text)
          : normText((norm as { name?: string }).name ?? '');
    const exact =
      norm.kind === 'text'
        ? (norm as { exact?: boolean }).exact
        : isRole
          ? (norm as { nameExact?: boolean }).nameExact
          : false;
    const nth = (norm as { nth?: number }).nth;
    const raw = nodes.filter((node) => {
      if (!node.backendNodeId) return false;
      const nodeName = normText(node.name);
      if (isRole) {
        if (node.role.toLowerCase() !== (norm as { role: string }).role.toLowerCase()) return false;
        if (!wanted) return true;
        return exact ? nodeName === wanted : nodeName === wanted || nodeName.includes(wanted);
      }
      if (isLabel) {
        return /textbox|searchbox|combobox/i.test(node.role) && nodeName.includes(wanted);
      }
      // text：老行为子串；引号精确
      return exact ? nodeName === wanted : nodeName.includes(wanted);
    });
    // AX 树里同一 DOM 元素会有多个节点（button 及其 StaticText 子节点），
    // 按 backendNodeId 去重——否则 `text=提交` 这类查询必然报歧义。
    const seen = new Set<number>();
    let matches = raw.filter((node) => {
      if (seen.has(node.backendNodeId!)) return false;
      seen.add(node.backendNodeId!);
      return true;
    });
    // `text=` 优先命中可交互节点：AX 树里每个按钮都会再挂一个 StaticText 同名子节点，
    // 不去掉的话任何 `text=xxx` 查询都必然报歧义。真正的歧义（两个同名按钮）仍然报。
    if (!isRole) {
      const actionable = matches.filter((node) => !/^(StaticText|InlineTextBox|LineBreak)$/.test(node.role));
      if (actionable.length > 0) matches = actionable;
    }
    if (matches.length === 0) throw err('TARGET_NOT_FOUND', `target not found: ${JSON.stringify(norm)}`);
    if (matches.length > 1 && nth === undefined) {
      assertUnique(matches, JSON.stringify(norm));
    }
    const picked = nth === undefined ? matches[0] : pickNth(matches, nth, JSON.stringify(norm));
    if (!picked.backendNodeId) throw err('TARGET_NOT_FOUND', `target not attached: ${JSON.stringify(norm)}`);
    return picked.backendNodeId;
  }

  #peekDialog(): { type: string; message: string; url: string } | null {
    return peekDialog(this.#page());
  }

  /**
   * 有未处理 dialog 时先报 DIALOG_OPEN。
   *
   * 公开给 RPC 层：macOS 上 alert 打开会让窗口失去 key 焦点，而页面此时收不到输入；
   * 不先报 DIALOG_OPEN，agent 只会看到「点了没反应」，查不出是对话框卡着。
   */
  assertNoDialog(): void {
    assertNoDialog(this.#page());
  }

  // ── 动作 / 弹窗下载 / 逃生舱 / 键鼠 ─────────────────────────────────
  // 实现分别在 actions.ts / keymouse.ts / escape.ts；这里只递页面上下文。

  async click(target: TargetInput, opts: ClickOptions = {}) {
    return click(this.#page(), target, opts);
  }

  async dblclick(target: TargetInput, opts: ClickOptions = {}) {
    return dblclick(this.#page(), target, opts);
  }

  async hover(target: TargetInput, opts: ClickOptions = {}) {
    return hover(this.#page(), target, opts);
  }

  async drag(source: TargetInput, target: TargetInput, opts: DragOptions = {}) {
    return drag(this.#page(), source, target, opts);
  }

  async dropFiles(target: TargetInput, paths: string | string[], opts: { timeoutMs?: number } = {}) {
    return dropFiles(this.#page(), target, paths, opts);
  }

  async fill(target: TargetInput, value: string, opts: FillOptions = {}) {
    return fill(this.#page(), target, value, opts);
  }

  async selectOption(
    target: TargetInput,
    value: SelectValue,
    opts: { timeoutMs?: number; by?: 'auto' | 'value' | 'label' | 'index' } = {},
  ) {
    return selectOption(this.#page(), target, value, opts);
  }

  async check(target: TargetInput, opts: { timeoutMs?: number } = {}) {
    return setChecked(this.#page(), target, true, opts);
  }

  async uncheck(target: TargetInput, opts: { timeoutMs?: number } = {}) {
    return setChecked(this.#page(), target, false, opts);
  }

  async scrollIntoView(target: TargetInput): Promise<{ ok: true }> {
    const { backendNodeId, sessionId } = await resolveTarget(this.#page(), target);
    await scrollIntoView(this.#page(), backendNodeId, 1, sessionId);
    return { ok: true };
  }

  async applySetting(setting: EmulationSetting) {
    return applyEmulationSetting(this.#page(), setting);
  }

  async listWebMcp() {
    return listWebMcpTools(this.#page());
  }

  async callWebMcp(toolName: string, args?: Record<string, unknown>) {
    return callWebMcpTool(this.#page(), toolName, args);
  }

  async printPdf(opts: PdfOptions) {
    return printPdf(this.#page(), opts);
  }

  async vitals() {
    return collectVitals(this.#page());
  }

  async a11y() {
    return auditAccessibility(this.#page());
  }

  async reactTree(opts?: { maxNodes?: number }) {
    return inspectReactTree(this.#page(), opts);
  }

  async focus(target: TargetInput, opts: { timeoutMs?: number } = {}) {
    return focus(this.#page(), target, opts);
  }

  async press(selOrChord: string | TargetInput, chordOrOpts?: string | PressOptions, maybeOpts?: PressOptions) {
    return press(this.#page(), selOrChord, chordOrOpts, maybeOpts);
  }

  async setInputFiles(target: TargetInput, paths: string | string[]) {
    return setInputFiles(this.#page(), target, paths);
  }

  async acceptDialog(promptText?: string) {
    return acceptDialog(this.#page(), promptText);
  }

  async dismissDialog() {
    return dismissDialog(this.#page());
  }

  async downloadSaveAs(downloadId: string, dest: string) {
    return downloadSaveAs(this.#page(), downloadId, dest);
  }

  downloadCancel(downloadId: string) {
    return downloadCancel(this.#page(), downloadId);
  }

  downloadStatus(downloadId: string) {
    return downloadStatus(this.#page(), downloadId);
  }

  async evaluate(fn: string, arg?: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    return evaluate(this.#page(), fn, arg, opts);
  }

  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    return fetchPage(this.#page(), url, opts);
  }

  async getProp(prop: InspectProp, target?: TargetInput, attr?: string): Promise<unknown> {
    return readTargetProperty(this.#page(), prop, target, attr);
  }

  async checkState(state: InspectState, target: TargetInput): Promise<boolean> {
    return checkTargetState(this.#page(), state, target);
  }

  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return cdp(this.#page(), method, params);
  }

  async clearDataForOrigin(origin: string, storageTypes?: string): Promise<{ ok: true }> {
    return clearDataForOrigin(this.#page(), origin, storageTypes);
  }

  async mouseClick(
    x: number,
    y: number,
    opts: { button?: MouseButton; clickCount?: number; delay?: number; label?: string } = {},
  ) {
    return mouseClick(this.#page(), x, y, opts);
  }

  async mouseMove(x: number, y: number, opts: { label?: string } = {}) {
    return mouseMove(this.#page(), x, y, opts);
  }

  async mouseDown(opts: { button?: MouseButton; x?: number; y?: number } = {}) {
    return mouseDown(this.#page(), opts);
  }

  async mouseUp(opts: { button?: MouseButton; x?: number; y?: number } = {}) {
    return mouseUp(this.#page(), opts);
  }

  async mouseWheel(deltaX: number, deltaY: number, opts: { label?: string } = {}) {
    return mouseWheel(this.#page(), deltaX, deltaY, opts);
  }

  async keyboardDown(key: string) {
    return keyboardDown(this.#page(), key);
  }

  async keyboardUp(key: string) {
    return keyboardUp(this.#page(), key);
  }

  async keyboardPress(chord: string, opts: { delay?: number } = {}) {
    return keyboardPress(this.#page(), chord, opts);
  }

  async keyboardType(text: string, opts: { delay?: number } = {}) {
    return keyboardType(this.#page(), text, opts);
  }

  async keyboardInsert(text: string) {
    return keyboardInsert(this.#page(), text);
  }

  async keyboardPaste(content: string | { text: string; html?: string }) {
    return keyboardPaste(this.#page(), content);
  }
}

/** 页面内抛错的摘要。CDP 的 `text` 常常只是 "Uncaught"，真正的信息在 `exception.description`。 */
