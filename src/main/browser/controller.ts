/**
 * BrowserController：**页面门面**。把页面级上下文（`ctx.ts` 的 PageContext）递给各职责模块，
 * 并保留页面生命周期与高层操控公开方法；`ops/*` 与原始坐标键鼠接口直接经由 `.page` 上下文调用。
 */
import type { WebContents } from 'electron';
import {
  AxNode,
  ClickOptions,
  DragOptions,
  FetchOptions,
  FetchResult,
  FillOptions,
  LoadState,
  NavigateOptions,
  PageEvent,
  PageInfo,
  PressOptions,
  ScreenshotOptions,
  ScreenshotResult,
  SelectValue,
  SelectorState,
  SnapshotOptions,
  TargetInput,
  UrlMatcher,
  ViewportPresetId,
  WaitEventKind,
  WaitPredicate,
} from '../../shared/types.ts';
import { VIEWPORT_PRESET_SPECS } from '../../shared/viewport-presets.ts';
import { acceptDialog, dismissDialog, downloadCancel, downloadSaveAs, downloadStatus } from './actions.ts';
import { readAxFrames } from './ax-tree.ts';
import type { PageContext, PendingSink, VisualActionEvent } from './ctx.ts';
import { richErr } from './errors.ts';
import { cdp, clearDataForOrigin, evaluate, fetchPage } from './escape.ts';
import { fill, focus, press, selectOption, setChecked, setInputFiles } from './form-actions.ts';
import { frameOfBackendId, highlightElement, invalidateAxCache, probePoint, resolveLocatorTarget } from './locator.ts';
import { detectLoginFields as runDetectLoginFields } from './login-fields.ts';
import { clearPendingRelease, setPendingRelease } from './mouse-state.ts';
import {
  ACTION_TIMEOUT_DEFAULT,
  assertNoDialog,
  clearHighlight,
  emptyPending,
  resolveTarget,
  scrollIntoView,
} from './page-helpers.ts';
import { click, dblclick, drag, dropFiles, hover } from './pointer-actions.ts';
import { RefTable } from './refs.ts';
import { screenshot } from './screenshot.ts';
import {
  attachSession,
  childSessions,
  clearChildSessions,
  detachSession,
  markDialogHandled,
  send,
  sendOn,
} from './session.ts';
import { assignRefs, snapshot } from './snapshot.ts';
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

export type { AxNode, PendingSink };

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
  onVisualAction?: (action: VisualActionEvent) => void;
}

export class BrowserController {
  #wc: WebContents;
  #ctx: Ctx;
  #pageCtx?: PageContext;
  #refs = new RefTable();
  #holding = false;
  /** 当前限定的活动 frameId（空表示全部/主文档）。 */
  #activeFrameId?: string;
  /** 自动弹窗处理策略（`none` 默认显式报错由调用方处理；`accept`/`dismiss` 自动应答）。 */
  #dialogPolicy: 'none' | 'accept' | 'dismiss' = 'none';
  #emulatedPreset: ViewportPresetId = 'auto';
  #emulatedScale = 1;
  #temporaryViewport = false;

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
      onVisualAction: ctx?.onVisualAction,
    };
    wc.on('did-start-navigation', ((_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      clearChildSessions(wc);
      clearPendingRelease(wc);
      this.#resetForNewDocument();
      this.#activeFrameId = undefined;
    }) as never);
  }

  /** 对外暴露只读页面上下文，供 `rpc/*`、`ops/*` 与 `keymouse.ts` 直接编排。 */
  get page(): PageContext {
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
      backendIdFor: async (target: TargetInput) => (await resolveLocatorTarget(this.page, target)).backendNodeId,
      resolveTarget: (target: TargetInput) => resolveLocatorTarget(this.page, target),
      frameOf: (backendNodeId: number) => frameOfBackendId(this.page, backendNodeId),
      downloadById: (downloadId: string) => this.#ctx.downloadById(downloadId),
      pending: this.#ctx.pending,
      tabIndex: this.#ctx.tabIndex,
      lastActivityAt: this.#ctx.lastActivityAt,
      inFlightCount: this.#ctx.inFlightCount,
      lastNavigationError: this.#ctx.lastNavigationError,
      activeFrameId: () => this.#activeFrameId,
      record: this.#ctx.record,
      onVisualAction: this.#ctx.onVisualAction,
    };
    return this.#pageCtx;
  }

  get webContents(): WebContents {
    return this.#wc;
  }

  attach(): void {
    if (this.#holding) return;
    this.#holding = true;
    void attachSession(this.#wc).catch(() => {});
  }

  /** 让页面相信自己有 document 焦点，但不激活 Electron 窗口（供后台 Agent 输入通过 `document.hasFocus()` 守卫）。 */
  async emulateFocus(): Promise<void> {
    this.attach();
    await this.#send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }

  /** 后台视图尚未拿到布局尺寸时，给页面一个可点击的视口。 */
  async emulateViewport(width: number, height: number): Promise<void> {
    this.attach();
    this.#temporaryViewport = true;
    await this.#send('Emulation.setDeviceMetricsOverride', {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async clearEmulatedViewport(): Promise<void> {
    this.#temporaryViewport = false;
    if (this.#emulatedPreset !== 'auto') {
      await this.setViewportPreset(this.#emulatedPreset, this.#emulatedScale, { force: true });
      return;
    }
    this.attach();
    await this.#send('Emulation.clearDeviceMetricsOverride');
    await this.#send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
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
   * 发输入命令（`Input.*`），并与「dialog 是否已打开」赛跑避免点击触发 `alert()` 时永久挂起。
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
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
          setPendingRelease(this.#wc, {
            x: Number(params.x ?? 0),
            y: Number(params.y ?? 0),
            button: String(params.button ?? 'left'),
            clickCount: Number(params.clickCount ?? 1),
          });
        }
        return;
      }
      if (Date.now() > deadline) {
        throw richErr('TIMEOUT', `输入命令 ${method} 超时（>${ACTION_TIMEOUT_DEFAULT}ms）`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  #resetForNewDocument(): void {
    markDialogHandled(this.#wc);
    invalidateAxCache(this.#wc.id);
    this.#refs.bump();
  }

  // ── 导航与视口 ──────────────────────────────────────────────────────────

  async navigate(url: string, opts: NavigateOptions = {}): Promise<{ url: string }> {
    this.assertNoDialog();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const waitUntil = opts.waitUntil ?? 'load';
    if (opts.referer !== undefined) await this.#send('Page.navigate', { url, referrer: opts.referer });
    else await this.#send('Page.navigate', { url });
    const loaded = await awaitLoad(this.page, waitUntil, timeoutMs);
    if (loaded.timedOut) {
      throw richErr(
        'TIMEOUT',
        `navigate timed out after ${timeoutMs}ms: committed=${loaded.committed} url=${loaded.url} readyState=${await readyState(this.page)}`,
      );
    }
    this.#resetForNewDocument();
    return { url: loaded.url || this.#wc.getURL() };
  }

  async #performReload(opts: NavigateOptions, ignoreCache: boolean): Promise<{ url: string }> {
    this.assertNoDialog();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    if (ignoreCache) this.#wc.reloadIgnoringCache();
    else this.#wc.reload();
    const loaded = await awaitLoad(this.page, opts.waitUntil ?? 'load', timeoutMs);
    if (loaded.timedOut) {
      const verb = ignoreCache ? 'hardReload' : 'reload';
      throw richErr(
        'TIMEOUT',
        `${verb} timed out after ${timeoutMs}ms: url=${loaded.url} readyState=${await readyState(this.page)}`,
      );
    }
    this.#resetForNewDocument();
    return { url: this.#wc.getURL() };
  }

  reload(opts: NavigateOptions = {}): Promise<{ url: string }> {
    return this.#performReload(opts, false);
  }

  hardReload(opts: NavigateOptions = {}): Promise<{ url: string }> {
    return this.#performReload(opts, true);
  }

  async setViewportPreset(preset: ViewportPresetId, scale = 1, options: { force?: boolean } = {}): Promise<void> {
    const normalizedScale = Number.isFinite(scale) ? Math.max(0.1, Math.min(1, scale)) : 1;
    if (
      !options.force &&
      !this.#temporaryViewport &&
      this.#emulatedPreset === preset &&
      (preset === 'auto' || Math.abs(this.#emulatedScale - normalizedScale) < 0.002)
    ) {
      return;
    }
    if (preset === 'auto') {
      this.#emulatedPreset = 'auto';
      this.#emulatedScale = 1;
      this.#temporaryViewport = false;
      this.attach();
      await this.#send('Emulation.clearDeviceMetricsOverride');
      await this.#send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      return;
    }
    const spec = VIEWPORT_PRESET_SPECS[preset];
    this.#emulatedPreset = preset;
    this.#emulatedScale = normalizedScale;
    this.#temporaryViewport = false;
    this.attach();
    await this.#send('Emulation.setDeviceMetricsOverride', {
      width: spec.width,
      height: spec.height,
      deviceScaleFactor: spec.deviceScaleFactor,
      mobile: spec.mobile,
      scale: normalizedScale,
    });
    await this.#send('Emulation.setTouchEmulationEnabled', { enabled: spec.mobile }).catch(() => {});
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
    if (this.#wc.navigationHistory.canGoBack()) this.#wc.navigationHistory.goBack();
  }

  goForward(): void {
    if (this.#wc.navigationHistory.canGoForward()) this.#wc.navigationHistory.goForward();
  }

  async title(): Promise<string> {
    return this.#wc.getTitle();
  }

  currentUrl(): string {
    return this.#wc.getURL();
  }

  // ── 观察、Frame 与 弹窗 ──────────────────────────────────────────────

  snapshot(options: SnapshotOptions & { limit?: number; interestingOnly?: boolean } = {}): Promise<AxNode[]> {
    return snapshot(this.page, options);
  }

  /** agent 专用：取快照并分配 `@N`。 */
  async snapshotWithRefs(options: SnapshotOptions & { limit?: number } = {}): Promise<AxNode[]> {
    const nodes = await snapshot(this.page, options);
    assignRefs(this.page, nodes, { includeStableLocator: options.includeStableLocator });
    return nodes;
  }

  screenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    return screenshot(this.page, opts, this.#ctx.envId);
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

  async listFrames(): Promise<
    Array<{ index: number; frameId: string; url: string; name?: string; crossOrigin: boolean; active: boolean }>
  > {
    const frames = await readAxFrames(this.page);
    return frames.map((f, index) => ({
      index,
      frameId: f.frameId,
      url: f.url ?? '',
      ...(f.name ? { name: f.name } : {}),
      crossOrigin: Boolean(f.sessionId),
      active: this.#activeFrameId ? f.frameId === this.#activeFrameId : index === 0,
    }));
  }

  async selectFrame(ref: string): Promise<{ activeFrameId: string | null; url?: string }> {
    const trimmed = ref.trim();
    if (!trimmed || trimmed.toLowerCase() === 'main' || trimmed === '0') {
      this.#activeFrameId = undefined;
      return { activeFrameId: null, url: this.#wc.getURL() };
    }
    const frames = await readAxFrames(this.page);
    let picked = frames.find((f) => f.frameId === trimmed);
    if (!picked && /^\d+$/.test(trimmed)) picked = frames[Number(trimmed)];
    if (!picked) {
      const lower = trimmed.toLowerCase();
      picked = frames.find(
        (f) => (f.name && f.name.toLowerCase() === lower) || (f.url && f.url.toLowerCase().includes(lower)),
      );
    }
    if (!picked) {
      throw richErr('TARGET_NOT_FOUND', `找不到 frame：${ref}（可用 browser frame <env> list 查看）`);
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

  async handleAutoDialogIfNeeded(): Promise<{ handled: boolean; action?: 'accept' | 'dismiss'; type?: string }> {
    if (this.#dialogPolicy === 'none' || !this.#peekDialog()) return { handled: false };
    const r = this.#dialogPolicy === 'accept' ? await acceptDialog(this.page) : await dismissDialog(this.page);
    return { handled: true, action: this.#dialogPolicy, type: r.type };
  }

  smartSettle(opts?: { maxWaitMs?: number; quietMs?: number }) {
    return smartSettle(this.page, opts);
  }

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

  // ── 等待与目标探针 ──────────────────────────────────────────────────

  waitFor(predicate: WaitPredicate, options: { timeoutMs?: number } = {}) {
    return waitFor(this.page, predicate, options);
  }

  waitForURL(matcher: UrlMatcher, options: { timeoutMs?: number } = {}) {
    return waitForURL(this.page, matcher, options);
  }

  waitForSelector(target: TargetInput, options: { state?: SelectorState; timeoutMs?: number } = {}) {
    return waitForSelector(this.page, target, options);
  }

  waitForFunction(fn: string, arg?: unknown, options: { timeoutMs?: number; polling?: number } = {}) {
    return waitForFunction(this.page, fn, arg, options);
  }

  waitForLoadState(state: LoadState = 'load', options: { timeoutMs?: number; idleMs?: number } = {}) {
    return waitForLoadState(this.page, state, options);
  }

  waitForTimeout(ms: number) {
    return waitForTimeout(this.page, ms);
  }

  waitForEvent(kind: WaitEventKind, options: { timeoutMs?: number } = {}) {
    return waitForEvent(this.page, kind, options);
  }

  probePoint(target: TargetInput) {
    return probePoint(this.page, target);
  }

  detectLoginFields() {
    return runDetectLoginFields(this.page);
  }

  async highlight(target?: TargetInput): Promise<{
    highlighted: boolean;
    rect?: { x: number; y: number; width: number; height: number };
  }> {
    if (target === undefined) {
      await clearHighlight(this.page);
      return { highlighted: false };
    }
    const { backendNodeId, sessionId } = await resolveTarget(this.page, target);
    const rect = await highlightElement(this.page, backendNodeId, sessionId);
    return { highlighted: true, rect };
  }

  #peekDialog(): { type: string; message: string; url: string } | null {
    return this.#ctx.pending.dialogOpen();
  }

  assertNoDialog(): void {
    assertNoDialog(this.page);
  }

  // ── 动作 / 弹窗下载 / 逃生舱 ───────────────────────────────────────

  async #mutating<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      invalidateAxCache(this.#wc.id);
    }
  }

  click(target: TargetInput, opts: ClickOptions = {}) {
    return this.#mutating(() => click(this.page, target, opts));
  }

  dblclick(target: TargetInput, opts: ClickOptions = {}) {
    return this.#mutating(() => dblclick(this.page, target, opts));
  }

  hover(target: TargetInput, opts: ClickOptions = {}) {
    return this.#mutating(() => hover(this.page, target, opts));
  }

  drag(source: TargetInput, target: TargetInput, opts: DragOptions = {}) {
    return this.#mutating(() => drag(this.page, source, target, opts));
  }

  dropFiles(target: TargetInput, paths: string | string[], opts: { timeoutMs?: number } = {}) {
    return this.#mutating(() => dropFiles(this.page, target, paths, opts));
  }

  fill(target: TargetInput, value: string, opts: FillOptions = {}) {
    return this.#mutating(() => fill(this.page, target, value, opts));
  }

  selectOption(
    target: TargetInput,
    value: SelectValue,
    opts: { timeoutMs?: number; by?: 'auto' | 'value' | 'label' | 'index' } = {},
  ) {
    return this.#mutating(() => selectOption(this.page, target, value, opts));
  }

  check(target: TargetInput, opts: { timeoutMs?: number } = {}) {
    return this.#mutating(() => setChecked(this.page, target, true, opts));
  }

  uncheck(target: TargetInput, opts: { timeoutMs?: number } = {}) {
    return this.#mutating(() => setChecked(this.page, target, false, opts));
  }

  async scrollIntoView(target: TargetInput): Promise<{ ok: true }> {
    const { backendNodeId, sessionId } = await resolveTarget(this.page, target);
    await scrollIntoView(this.page, backendNodeId, 1, sessionId);
    return { ok: true };
  }

  focus(target: TargetInput, opts: { timeoutMs?: number } = {}) {
    return this.#mutating(() => focus(this.page, target, opts));
  }

  press(selOrChord: string | TargetInput, chordOrOpts?: string | PressOptions, maybeOpts?: PressOptions) {
    return this.#mutating(() => press(this.page, selOrChord, chordOrOpts, maybeOpts));
  }

  setInputFiles(target: TargetInput, paths: string | string[]) {
    return this.#mutating(() => setInputFiles(this.page, target, paths));
  }

  acceptDialog(promptText?: string) {
    return this.#mutating(() => acceptDialog(this.page, promptText));
  }

  dismissDialog() {
    return this.#mutating(() => dismissDialog(this.page));
  }

  downloadSaveAs(downloadId: string, dest: string) {
    return downloadSaveAs(this.page, downloadId, dest);
  }

  downloadCancel(downloadId: string) {
    return downloadCancel(this.page, downloadId);
  }

  downloadStatus(downloadId: string) {
    return downloadStatus(this.page, downloadId);
  }

  evaluate(fn: string, arg?: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    return evaluate(this.page, fn, arg, opts);
  }

  fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    return fetchPage(this.page, url, opts);
  }

  cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return cdp(this.page, method, params);
  }

  clearDataForOrigin(origin: string, storageTypes?: string): Promise<{ ok: true }> {
    return clearDataForOrigin(this.page, origin, storageTypes);
  }
}
