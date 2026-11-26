/**
 * 等待：URL / Selector（含六种 state）/ Function / LoadState / Timeout / Event，
 * 以及 navigate / reload 用的 waitUntil 四态。
 *
 * 取数一律走 `readAxNodes`（只读、不注册 ref），页面内轮询走 `evaluate`。
 */
import type {
  LoadState,
  PageEvent,
  SelectorState,
  TargetInput,
  UrlMatcher,
  WaitEventKind,
  WaitPredicate,
} from '../../shared/types.ts';
import type { PageContext } from './ctx.ts';
import { evaluate } from './escape.ts';
import { ACTION_TIMEOUT_DEFAULT, err, evalOnNode, nodeIdFor } from './page-helpers.ts';
import { matchUrl } from './matcher.ts';
import { readAxNodes } from './snapshot.ts';
import { setFileChooserInterception } from './session.ts';

/** 老三种 predicate 原样保留；新增 url/function/loadState/event。 */
export async function waitFor(
  ctx: PageContext,
  predicate: WaitPredicate,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (predicate.url !== undefined) {
    await waitForURL(ctx, predicate.url, options);
    return;
  }
  if (predicate.function !== undefined) {
    await waitForFunction(ctx, predicate.function, predicate.functionArg, options);
    return;
  }
  if (predicate.loadState !== undefined) {
    await waitForLoadState(ctx, predicate.loadState, options);
    return;
  }
  if (predicate.event !== undefined) {
    await waitForEvent(ctx, predicate.event, options);
    return;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    try {
      if (predicate.text) {
        const nodes = await readAxNodes(ctx, 2000);
        if (nodes.some((node) => node.name.includes(predicate.text!))) return;
      } else if (predicate.role) {
        const nodes = await readAxNodes(ctx, 2000);
        if (nodes.some((node) => node.role.toLowerCase() === predicate.role!.toLowerCase())) return;
      } else if (predicate.selector) {
        const { root } = await ctx.send<{ root: { nodeId: number } }>('DOM.getDocument', {
          depth: 0,
        });
        const { nodeId } = await ctx.send<{ nodeId: number }>('DOM.querySelector', {
          nodeId: root.nodeId,
          selector: predicate.selector,
        });
        if (nodeId) return;
      } else {
        return;
      }
    } catch {
      // 页面正在导航，DOM 会短暂不可用
    }
    if (Date.now() > deadline) {
      throw err('TIMEOUT', `waitFor timed out: ${JSON.stringify(predicate)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export async function waitForURL(
  ctx: PageContext,
  matcher: UrlMatcher,
  options: { timeoutMs?: number } = {},
): Promise<{ url: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    const url = ctx.wc.getURL();
    if (matchUrl(url, matcher)) return { url };
    if (Date.now() > deadline) {
      throw err('TIMEOUT', `waitForURL timed out: ${JSON.stringify(matcher)} (at ${url})`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function waitForSelector(
  ctx: PageContext,
  target: TargetInput,
  options: { state?: SelectorState; timeoutMs?: number } = {},
): Promise<{ ref?: string }> {
  const state = options.state ?? 'visible';
  const deadline = Date.now() + (options.timeoutMs ?? ACTION_TIMEOUT_DEFAULT);
  for (;;) {
    try {
      const found = await resolveQuiet(ctx, target);
      if (found) {
        const ok = await checkState(ctx, found.backendId, state);
        if (ok) return found.ref ? { ref: found.ref } : {};
      } else if (state === 'detached' || state === 'hidden') {
        return {};
      }
    } catch {
      if (state === 'detached' || state === 'hidden') return {};
    }
    if (Date.now() > deadline) {
      throw err('TIMEOUT', `waitForSelector timed out: ${JSON.stringify(target)} state=${state}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function resolveQuiet(
  ctx: PageContext,
  target: TargetInput,
): Promise<{ backendId: number; ref?: string } | null> {
  try {
    return { backendId: await ctx.backendIdFor(target) };
  } catch (e) {
    if ((e as { code?: string }).code === 'TARGET_AMBIGUOUS') throw e;
    return null;
  }
}

async function checkState(ctx: PageContext, backendId: number, state: SelectorState): Promise<boolean> {
  try {
    // 跨源 iframe 里的元素要在它自己的会话里查（见 page-helpers 的 resolveTarget）
    const sessionId = (await ctx.frameOf(backendId).catch(() => undefined))?.sessionId;
    const nodeId = await nodeIdFor(ctx, backendId, sessionId);
    if (state === 'attached') return true;
    if (state === 'detached') return false;
    const { model } = await ctx
      .sendOn<{ model: { content: number[] } }>(sessionId, 'DOM.getBoxModel', { nodeId })
      .catch(() => ({ model: null }) as never);
    const hasBox = Boolean(model && model.content && model.content.length >= 6);
    if (state === 'visible') {
      if (!hasBox) return false;
      // 盒模型非空 + computed style 非隐藏（display:none/零尺寸无盒模型）
      const vis = await evalOnNode(
        ctx,
        nodeId,
        `(el) => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; }`,
        sessionId,
      ).catch(() => true);
      return hasBox && vis !== false;
    }
    if (state === 'hidden') return !hasBox;
    // enabled/disabled：经 DOM 属性 + 原生属性判定
    const disabled = await evalOnNode(
      ctx,
      nodeId,
      `(el) => { const t = el; return !!(t.disabled ?? t.getAttribute?.('disabled') ?? t.getAttribute?.('aria-disabled') === 'true'); }`,
      sessionId,
    ).catch(() => false);
    if (state === 'enabled') return !disabled;
    if (state === 'disabled') return !!disabled;
    return true;
  } catch {
    return state === 'detached' || state === 'hidden';
  }
}

export async function waitForFunction(
  ctx: PageContext,
  fn: string,
  arg?: unknown,
  options: { timeoutMs?: number; polling?: number } = {},
): Promise<unknown> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const polling = options.polling ?? 150;
  for (;;) {
    try {
      const value = await evaluate(ctx, fn, arg, { timeoutMs: 5000 });
      if (value) return value;
    } catch (e) {
      // 页面正在导航 → 下一轮再试；但 dialog 开着要立刻报出来，
      // 吞掉它会变成一条看不出原因的 TIMEOUT
      if ((e as { code?: string }).code === 'DIALOG_OPEN') throw e;
    }
    if (Date.now() > deadline) {
      throw err('TIMEOUT', `waitForFunction timed out: ${fn.slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, polling));
  }
}

export async function waitForLoadState(
  ctx: PageContext,
  state: LoadState = 'load',
  options: { timeoutMs?: number; idleMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (state === 'commit') {
    const url = await waitForCommit(ctx, timeoutMs);
    if (url === null) throw err('TIMEOUT', `waitForLoadState(commit) timed out at ${ctx.wc.getURL()}`);
    return;
  }
  if (state === 'domcontentloaded') {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rs = await readyState(ctx);
      if (rs && rs !== 'loading') return;
      if (!ctx.wc.isLoading() && rs === '') return; // 已处在目标态
      if (Date.now() > deadline) throw err('TIMEOUT', 'waitForLoadState(domcontentloaded) timed out');
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  // load / networkidle
  const loaded = await awaitLoad(ctx, state, timeoutMs);
  if (loaded.timedOut) {
    throw err('TIMEOUT', `waitForLoadState(${state}) timed out: url=${loaded.url} readyState=${await readyState(ctx)}`);
  }
}

export async function waitForTimeout(_ctx: PageContext, ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

export async function waitForEvent(
  ctx: PageContext,
  kind: WaitEventKind,
  options: { timeoutMs?: number } = {},
): Promise<PageEvent> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  // 拦截只在等 fileChooser 期间开启：常开会让「人」点文件框时不再弹原生对话框
  const armed = kind === 'fileChooser';
  if (armed) await setFileChooserInterception(ctx.wc, true).catch(() => {});
  try {
    return await waitForEventLoop(ctx, kind, deadline);
  } finally {
    if (armed) await setFileChooserInterception(ctx.wc, false).catch(() => {});
  }
}

async function waitForEventLoop(ctx: PageContext, kind: WaitEventKind, deadline: number): Promise<PageEvent> {
  for (;;) {
    if (kind === 'dialog') {
      const d = ctx.pending.takeDialogEvent();
      if (d) return d;
    } else if (kind === 'popup') {
      const p = ctx.pending.consumePopup();
      if (p) return { kind: 'popup', tabId: p.tabId, index: p.index, url: p.url, at: p.at };
    } else if (kind === 'download') {
      const dl = ctx.pending.consumeDownload();
      if (dl)
        return {
          kind: 'download',
          downloadId: dl.downloadId,
          url: dl.url,
          filename: dl.filename,
          at: dl.at,
        };
    } else {
      // fileChooser：拦截开启时由 Page.fileChooserOpened 推过来（含触发它的 input）
      const fc = ctx.pending.consumeFileChooser();
      if (fc) return { kind: 'fileChooser', ...fc };
    }
    if (Date.now() > deadline) {
      const hint = kind === 'popup' ? '（被拦的走 popup.denied 事件，可查 events.list）' : '';
      throw err('TIMEOUT', `waitForEvent(${kind}) timed out${hint}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ── 导航用的 waitUntil 四态 ────────────────────────────────────────

/** `timedOut` 为真表示到点还没进入目标态（调用方负责报错）。 */
export async function awaitLoad(
  ctx: PageContext,
  waitUntil: 'commit' | 'domcontentloaded' | 'load' | 'networkidle' | undefined,
  timeoutMs: number,
): Promise<{ url: string; committed: boolean; timedOut: boolean }> {
  const wc = ctx.wc;
  if (waitUntil === 'commit') {
    const url = await waitForCommit(ctx, timeoutMs);
    return { url: url ?? wc.getURL(), committed: url !== null, timedOut: url === null };
  }
  if (waitUntil === 'domcontentloaded' || waitUntil === 'load' || waitUntil === 'networkidle') {
    const loaded = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (byEvent: boolean) => () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.off('did-stop-loading', onDone);
        wc.off('did-fail-load', onDone);
        resolve(byEvent);
      };
      const onDone = finish(true);
      const timer = setTimeout(finish(false), timeoutMs);
      if (!wc.isLoading()) {
        // 已处在目标态直接返回
        if (waitUntil === 'domcontentloaded') {
          void readyState(ctx).then((rs) => {
            if (rs !== 'loading') onDone();
            else {
              wc.once('did-stop-loading', onDone);
              wc.once('did-fail-load', onDone);
            }
          });
        } else {
          onDone();
        }
      } else {
        wc.once('did-stop-loading', onDone);
        wc.once('did-fail-load', onDone);
      }
    });
    const byEvent = await loaded;
    if (byEvent && waitUntil === 'networkidle') await awaitIdle(ctx, timeoutMs);
    return { url: wc.getURL(), committed: true, timedOut: !byEvent };
  }
  return { url: wc.getURL(), committed: true, timedOut: false };
}

export function waitForCommit(ctx: PageContext, timeoutMs: number): Promise<string | null> {
  const wc = ctx.wc;
  const before = wc.getURL();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(wc.getURL() !== before ? wc.getURL() : null);
    }, timeoutMs);
    const onNav = (_e: unknown, url: string) => {
      if (url !== before) {
        cleanup();
        resolve(url);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      wc.off('did-navigate', onNav as never);
    };
    wc.on('did-navigate', onNav as never);
  });
}

export async function readyState(ctx: PageContext): Promise<string> {
  try {
    const r = await ctx.send<{ result: { value: string } }>('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    });
    return String(r.result?.value ?? '');
  } catch {
    return '';
  }
}

/** networkidle：该 tab 在途非流式请求为 0 且最近 idleMs 没有新的网络活动。 */
async function awaitIdle(ctx: PageContext, timeoutMs: number, idleMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const inFlight = ctx.inFlightCount ? ctx.inFlightCount() : 0;
    const since = Date.now() - ctx.lastActivityAt();
    if (inFlight === 0 && since >= idleMs) return;
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, Math.min(100, idleMs)));
  }
}

/**
 * 事件驱动页面稳定等待（`smartSettle`，对标 Chrome DevTools MCP + Ardia）：
 * 1. 若页面正在导航，先等 `did-stop-loading` 或 `readyState !== 'loading'`；
 * 2. 等待在途非长轮询请求清零（上限受 `maxWaitMs` 约束）；
 * 3. 在隔离世界挂短暂 `MutationObserver`（自动过滤 `oldValue === newValue` 噪声、
 *    200ms 持续样式动画循环，并递归观察同源 iframe），DOM 安静 `quietMs` 即返回；
 * 4. 严控总上限（默认 3000ms），绝不因动画/轮询无限阻塞。
 */
export async function smartSettle(
  ctx: PageContext,
  opts: { maxWaitMs?: number; quietMs?: number } = {},
): Promise<{ settledMs: number; inFlightRemaining: number }> {
  const started = Date.now();
  const maxWaitMs = Math.max(100, Math.min(8000, opts.maxWaitMs ?? 3000));
  const quietMs = Math.max(50, Math.min(1000, opts.quietMs ?? 180));
  const deadline = started + maxWaitMs;

  // 1) 若正在加载主文档，等一次加载收敛
  if (ctx.wc.isLoading()) {
    await awaitLoad(ctx, 'domcontentloaded', Math.max(200, deadline - Date.now())).catch(() => {});
  }

  // 2) 短暂等待在途请求清零（最多占总预算一半）
  const netDeadline = Math.min(deadline, started + Math.floor(maxWaitMs * 0.6));
  while (Date.now() < netDeadline) {
    const inFlight = ctx.inFlightCount ? ctx.inFlightCount() : 0;
    if (inFlight === 0) break;
    await new Promise((r) => setTimeout(r, 60));
  }

  // 3) DOM Mutation 安静窗口检测（隔离世界，不污染页面）
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining >= quietMs && !ctx.wc.isDestroyed()) {
    try {
      const tree = await ctx.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree');
      const fid = tree?.frameTree?.frame?.id;
      if (fid) {
        const world = await ctx.send<{ executionContextId?: number }>('Page.createIsolatedWorld', {
          frameId: fid,
          worldName: 'warren-settle',
        });
        if (world?.executionContextId) {
          await ctx.send('Runtime.evaluate', {
            contextId: world.executionContextId,
            returnByValue: true,
            awaitPromise: true,
            expression: `new Promise((resolve) => {
              const quietMs = ${quietMs};
              const capMs = ${Math.min(remaining, 1500)};
              const startedAt = Date.now();
              let timer = null;
              const observers = [];
              const finish = () => {
                clearTimeout(timer);
                clearTimeout(hardTimer);
                for (const ob of observers) { try { ob.disconnect(); } catch {} }
                resolve(true);
              };
              const bump = () => {
                clearTimeout(timer);
                timer = setTimeout(finish, quietMs);
              };
              const isMeaningful = (records) => {
                const elapsed = Date.now() - startedAt;
                for (const m of records) {
                  if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) return true;
                  if (m.type === 'characterData' && m.oldValue !== m.target.nodeValue) return true;
                  if (m.type === 'attributes') {
                    const attr = m.attributeName;
                    // 超过 200ms 仍在频繁改 style/class 通常是骨架屏或 CSS 动画循环，忽略
                    if ((attr === 'style' || attr === 'class') && elapsed > 200) continue;
                    const cur = m.target instanceof Element ? m.target.getAttribute(attr || '') : null;
                    if (cur !== m.oldValue) return true;
                  }
                }
                return false;
              };
              const attach = (doc) => {
                if (!doc || !doc.documentElement) return;
                const ob = new MutationObserver((records) => {
                  if (isMeaningful(records)) bump();
                });
                try {
                  ob.observe(doc.documentElement, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeOldValue: true,
                    characterData: true,
                    characterDataOldValue: true,
                  });
                  observers.push(ob);
                } catch {}
                for (const frame of doc.querySelectorAll('iframe')) {
                  try {
                    if (frame.contentDocument) attach(frame.contentDocument);
                  } catch {}
                }
              };
              attach(document);
              const hardTimer = setTimeout(finish, capMs);
              bump();
            })`,
          });
        }
      }
    } catch {
      // 隔离世界创建失败（如页面刚导航）直接跳过
    }
  }

  return {
    settledMs: Date.now() - started,
    inFlightRemaining: ctx.inFlightCount ? ctx.inFlightCount() : 0,
  };
}
