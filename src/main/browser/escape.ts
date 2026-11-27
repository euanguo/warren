/**
 * 逃生舱：evaluate / fetch / cdp / clearDataForOrigin。
 *
 * 这三个都**改页面状态**，所以走写门控（要 lease），但允许落在后台标签上
 * （后台标签的读与算不受 Chromium 输入限制）。
 */
import type { FetchOptions, FetchResult } from '../../shared/types.ts';
import { redactSecrets } from './redact.ts';
import type { PageContext } from './ctx.ts';
import { richErr } from './errors.ts';
import { assertNoDialog, pageError } from './page-helpers.ts';
import { checkCdpAllowed, defaultCredentials, guardSavePath, isSameOrigin } from './policy.ts';
import { withTimeout } from './timeout.ts';

export async function evaluate(
  ctx: PageContext,
  fn: string,
  arg?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<unknown> {
  assertNoDialog(ctx);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (typeof fn !== 'string' || !fn.trim()) throw richErr('BAD_REQUEST', 'evaluate 需要函数或表达式字符串');
  const t = fn.trim();
  type EvalResult = {
    result: { type: string; value?: unknown; objectId?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  const evaluateOnce = (returnByValue: boolean) =>
    withTimeout(
      ctx.send<EvalResult>('Runtime.evaluate', {
        expression: t,
        returnByValue,
        awaitPromise: true,
        userGesture: false,
      }),
      timeoutMs,
      'evaluate timed out（页面侧不保证停下，必要时 reload/close，见 Ego 同款 mayHaveLateEffects）',
    );

  // 先按表达式求值；拿到函数就再取一次引用调用它。
  // 不靠字符串猜「这是函数还是表达式」——猜错会把 IIFE 二次调用（实测踩过）。
  // 也不靠 returnByValue 拿 objectId：那个组合下 CDP 只回 `{type:'function', value:{}}`（实测）。
  const r = await evaluateOnce(true);
  if (r.exceptionDetails) throw richErr('BAD_REQUEST', `evaluate 抛错: ${pageError(r.exceptionDetails)}`);
  let value: unknown = r.result?.type === 'undefined' ? null : (r.result?.value ?? null);
  if (r.result?.type === 'function') {
    const byRef = await evaluateOnce(false);
    const objectId = byRef.result?.objectId;
    if (objectId) {
      try {
        const called = await withTimeout(
          ctx.send<EvalResult>('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: 'function (arg) { return this(arg); }',
            arguments: [{ value: arg }],
            returnByValue: true,
            awaitPromise: true,
          }),
          timeoutMs,
          'evaluate 函数调用超时',
        );
        if (called.exceptionDetails) {
          throw richErr('BAD_REQUEST', `evaluate 抛错: ${pageError(called.exceptionDetails)}`);
        }
        value = called.result?.type === 'undefined' ? null : (called.result?.value ?? null);
      } finally {
        await ctx.send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }
  }
  return redactSecrets(value).value;
}

export async function fetchPage(ctx: PageContext, url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  if (typeof url !== 'string' || !url) throw richErr('BAD_REQUEST', 'fetch 需要 url');
  const pageUrl = ctx.wc.getURL();
  const credentials = defaultCredentials(pageUrl, url, opts.credentials);
  if (credentials === 'include' && !isSameOrigin(pageUrl, url)) {
    ctx.record('browser.fetch', `跨站显式带凭据: ${url.slice(0, 120)}`);
  }
  const resolved = new URL(url, pageUrl).toString();
  const result = (await evaluate(
    ctx,
    `(async ({ u, m, h, b, cache, cred }) => {
      const res = await fetch(u, { method: m, headers: h, body: b, cache, credentials: cred });
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const ct = res.headers.get('content-type') ?? '';
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { ok: res.ok, status: res.status, statusText: res.statusText, url: res.url, headers, ct, b64: btoa(bin) };
    })`,
    {
      u: resolved,
      m: opts.method ?? 'GET',
      h: opts.headers ?? {},
      b: opts.body,
      cache: opts.cache,
      cred: credentials,
    },
    { timeoutMs: opts.timeoutMs ?? 30_000 },
  )) as {
    ok: boolean;
    status: number;
    statusText: string;
    url: string;
    headers: Record<string, string>;
    ct: string;
    b64: string;
  };
  const bytes = Buffer.from(result.b64, 'base64');
  const text = bytes.toString('utf8');
  if (opts.saveAs) {
    const target = guardSavePath(opts.saveAs);
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return {
      ok: result.ok,
      status: result.status,
      statusText: result.statusText,
      url: result.url,
      headers: result.headers,
      body: undefined,
    };
  }
  if (text.length > 2 * 1024 * 1024 && !/json|text|xml|html|javascript/i.test(result.ct)) {
    throw richErr('BAD_REQUEST', `二进制 ${text.length} 字节请用 saveAs 落盘（不转文本）`);
  }
  const redacted = redactSecrets({
    ...result,
    body: text.slice(0, 2 * 1024 * 1024),
    b64: undefined,
  }).value as {
    ok: boolean;
    status: number;
    statusText: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
  return {
    ok: redacted.ok,
    status: redacted.status,
    statusText: redacted.statusText,
    url: redacted.url,
    headers: redacted.headers,
    body: redacted.body,
  };
}

export async function cdp(ctx: PageContext, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  try {
    checkCdpAllowed(method);
  } catch (e) {
    ctx.record('browser.cdpBlocked', `${method} 被拒`);
    throw e;
  }
  const result = await ctx.send(method, params);
  return redactSecrets(result).value;
}

export async function clearDataForOrigin(
  ctx: PageContext,
  origin: string,
  storageTypes?: string,
): Promise<{ ok: true }> {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    throw richErr('BAD_REQUEST', `origin 非法: ${origin}`);
  }
  if (!/^https?:$/.test(o.protocol)) throw richErr('BAD_REQUEST', '只支持 http/https origin');
  await ctx.send('Storage.clearDataForOrigin', {
    origin: o.origin,
    storageTypes: storageTypes ?? 'cookies,local_storage',
  });
  ctx.record('browser.clearData', `清 ${o.origin}（单 origin，不碰整 profile）`);
  return { ok: true };
}
