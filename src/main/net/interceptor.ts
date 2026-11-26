/**
 * 网络拦截接线：把规则挂到 Environment **自己的 session** 上。
 *
 * 入口是 `ses.protocol.handle('http' | 'https')`——它是 per-session 的，所以天然按
 * Environment 隔离，不需要全局钩子（R8 实测，见 docs/NET-INTERCEPT-PLAN.md §1）。
 *
 * 两条不能破的线：
 * 1. 透传必须 `net.fetch(request, { bypassCustomProtocolHandlers: true })`。不带这个开关
 *    会递归拦自己（R10 实测）。
 * 2. **handler 里的异常绝不能抛回 Chromium**：session 一旦被规则全量接管，抛出去的表现是
 *    「页面白屏」，不是报错——最难查的一类。所以透传分支整体 try/catch 兜底 + 记事件。
 */
import { net, type Session } from 'electron';
import { redactSecrets } from '../browser/redact.ts';
import type { HarEntry } from './har.ts';
import { isActive, isExpired, nextExpiry, normalizeRule, pickRule } from './rules.ts';
import type { NetHit, NetRule } from '../../shared/types';

/** 命中记录环形缓冲上限。 */
const MAX_HITS = 200;
/** HAR 只记文本类响应体，且不超过这个大小（二进制/大响应记了也没法回放）。 */
const HAR_BODY_LIMIT = 1024 * 1024;

export class NetInterceptor {
  #rules: NetRule[] = [];
  #hits: NetHit[] = [];
  #session?: Session;
  /** handler 此刻挂着没。挂/摘只由「有没有启用的规则」决定。 */
  #attached = false;
  #record: (type: string, message: string) => void;
  #onHit?: (hit: NetHit) => void;
  /** HAR 录制 / 回放开关（N3 接上）。 */
  #recording = false;
  #replaying = false;
  #har: HarEntry[] = [];
  /** 下一条规则的过期定时器。没有会过期的规则时是 undefined。 */
  #expiryTimer?: ReturnType<typeof setTimeout>;
  /** 注册给 session 的 handler 必须每次都是同一个引用，`unhandle` 才对得上。 */
  #handler = (request: Request): Promise<Response> => this.#handle(request);

  constructor(record: (type: string, message: string) => void, onHit?: (hit: NetHit) => void) {
    this.#record = record;
    this.#onHit = onHit;
  }

  /**
   * 环境启动时告诉拦截器「用哪个 session」（建好之后、页面加载之前）。
   *
   * **有启用的规则才真的挂 handler**（见 #sync）：挂上 `protocol.handle` 会让整个 session
   * 的响应跳过 CORS 检查（实测：跨源请求没有 `access-control-allow-origin` 也读得到 body，
   * 而没挂 handler 时是 `CORS_ERR:Failed to fetch`）。没有规则的环境必须是**真浏览器**，
   * 所以默认不挂。
   */
  attach(session: Session): void {
    if (this.#session === session) return;
    this.detach();
    this.#session = session;
    this.#sync();
  }

  /** 环境停止时摘掉，规则留着（下次 start 重新挂）。 */
  detach(): void {
    const session = this.#session;
    if (!session) return;
    this.#session = undefined;
    this.#sync();
  }

  /** handler 的挂/摘只由「有没有**还在生效**的规则 / 在不在录 HAR」决定。 */
  #sync(): void {
    const session = this.#session;
    const want = Boolean(session) && (this.#recording || this.#rules.some((rule) => isActive(rule)));
    if (want !== this.#attached) {
      this.#attached = want;
      for (const scheme of ['http', 'https'] as const) {
        try {
          if (want) session!.protocol.handle(scheme, this.#handler);
          else session!.protocol.unhandle(scheme);
        } catch {
          // session 可能已经销毁
        }
      }
    }
    this.#scheduleExpiry();
  }

  /**
   * 排下一次「摘掉过期规则」的时刻。
   *
   * 必须真的摘：一条到期的放行规则如果只是不再命中、还挂在表里，`#sync()` 会一直认为
   * 「有启用规则」→ handler 一直挂着 → **整个 session 的响应继续跳过 CORS 检查**。
   * 偏差就是这么漏出去的。
   */
  #scheduleExpiry(): void {
    if (this.#expiryTimer) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    const next = nextExpiry(this.#rules);
    if (next === undefined) return;
    // setTimeout 的上限是 2^31-1 ms（约 24.8 天）；超了先排到上限，醒来时再排一次
    const delay = Math.max(50, Math.min(next - Date.now() + 20, 2 ** 31 - 1));
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = undefined;
      this.#dropExpired();
    }, delay);
  }

  #dropExpired(): void {
    const now = Date.now();
    const expired = this.#rules.filter((rule) => isExpired(rule, now));
    if (!expired.length) {
      this.#sync();
      return;
    }
    this.#rules = this.#rules.filter((rule) => !isExpired(rule, now));
    for (const rule of expired) {
      this.#record('net.rule.expired', `临时放行到期，自动摘掉 ${rule.id}（${rule.match.url}）`);
    }
    this.#sync();
  }

  // ── 规则表 ──────────────────────────────────────────────────────────

  rules(): NetRule[] {
    return this.#rules.map((rule) => ({ ...rule }));
  }

  addRule(input: unknown): NetRule {
    const rule = normalizeRule(input);
    if (!rule.id) rule.id = crypto.randomUUID();
    if (this.#rules.some((item) => item.id === rule.id)) {
      throw Object.assign(new Error(`规则 ${rule.id} 已存在`), { code: 'BAD_REQUEST' });
    }
    this.#rules.push(rule);
    this.#sync();
    return { ...rule };
  }

  setRuleEnabled(ruleId: string, enabled: boolean): NetRule {
    const rule = this.#rules.find((item) => item.id === ruleId);
    if (!rule) throw Object.assign(new Error(`未知规则 ${ruleId}`), { code: 'BAD_REQUEST' });
    rule.enabled = enabled;
    this.#sync();
    return { ...rule };
  }

  removeRule(ruleId: string): boolean {
    const before = this.#rules.length;
    this.#rules = this.#rules.filter((rule) => rule.id !== ruleId);
    this.#sync();
    return this.#rules.length !== before;
  }

  hits(limit = 50): NetHit[] {
    return this.#hits.slice(-Math.max(1, limit)).reverse();
  }

  hitCount(): number {
    return this.#hits.length;
  }

  clearHits(): void {
    this.#hits = [];
  }

  // ── HAR 录制 / 回放 ────────────────────────────────────────────────

  startRecording(): void {
    this.#har = [];
    this.#recording = true;
    // 录制也要经过 handler 才录得到：没有规则时它本来是摘着的
    this.#sync();
  }

  /**
   * **最近一次录制**抓到的响应体（只有文本类、且没超上限的才会被 `#capture` 留下）。
   *
   * 停录之后仍然返回 —— `#har` 要留着写 HAR 文件，顺手让「录完再回来读」也能用；
   * 下一次 `startRecording()` 会清空它，所以内存占用不会累积。
   *
   * 响应体只在录制期间抓 —— 因为抓它要靠 `protocol.handle` 挂上整个 session，
   * 而那会让跨源响应跳过 CORS 检查（见 `attach()` 的注释）。所以「想看 body」和
   * 「CORS 语义真实」在 Electron 里是互斥的，只能按需开。
   */
  capturedBodies(): HarEntry[] {
    return this.#har.filter((entry) => typeof entry.body === 'string');
  }

  stopRecording(): HarEntry[] {
    this.#recording = false;
    this.#sync();
    return this.#har;
  }

  /** 装上回放规则（`har:` 前缀，和人的规则分开，stop 时整体摘掉）。 */
  installReplay(rules: NetRule[]): number {
    this.#rules = this.#rules.filter((rule) => !rule.id.startsWith('har:'));
    this.#rules.push(...rules);
    this.#replaying = true;
    this.#sync();
    return rules.length;
  }

  stopReplay(): number {
    const before = this.#rules.length;
    this.#rules = this.#rules.filter((rule) => !rule.id.startsWith('har:'));
    this.#replaying = false;
    this.#sync();
    return before - this.#rules.length;
  }

  summary(): { rules: NetRule[]; hits: number; recording: boolean; replaying: boolean } {
    return {
      rules: this.rules(),
      hits: this.hitCount(),
      recording: this.#recording,
      replaying: this.#replaying,
    };
  }

  // ── handler ────────────────────────────────────────────────────────

  async #handle(request: Request): Promise<Response> {
    const rule = pickRule(this.#rules, request.url, request.method);
    if (!rule) return this.#passthrough(request);
    try {
      const response = await this.#apply(rule, request);
      this.#note(rule, request, response);
      this.#capture(request, response);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#record('net.ruleFailed', `${rule.id} ${rule.action.type} 执行失败：${message}（回退透传）`);
      return this.#passthrough(request, rule, `规则执行失败：${message}`);
    }
  }

  async #apply(rule: NetRule, request: Request): Promise<Response> {
    const action = rule.action;
    switch (action.type) {
      case 'mock': {
        // 204/205/304 和 1xx 不许带 body，Response 构造器会直接抛
        const bodyless = action.status < 200 || action.status === 204 || action.status === 205 || action.status === 304;
        const headers = new Headers(action.headers);
        if (!headers.has('content-type')) headers.set('content-type', action.contentType ?? 'application/json');
        return new Response(bodyless ? null : action.body, { status: action.status, headers });
      }
      case 'block':
        // 用 403 而不是断连：页面照常跑（该资源失败），人在 DevTools 里也看得见
        return new Response(null, {
          status: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      case 'redirect':
        return new Response(null, {
          status: 302,
          headers: { location: new URL(action.to, request.url).toString() },
        });
      case 'setRequestHeaders': {
        // Headers 自己就是大小写不敏感的单值表，直接 set 覆盖同名头（不用手写合并）
        const headers = new Headers(request.headers);
        for (const [key, value] of Object.entries(action.headers)) headers.set(key, value);
        return net.fetch(new Request(request, { headers }), { bypassCustomProtocolHandlers: true });
      }
      case 'setResponseHeaders': {
        const upstream = await net.fetch(request, { bypassCustomProtocolHandlers: true });
        const headers = new Headers(upstream.headers);
        for (const [key, value] of Object.entries(action.headers)) headers.set(key, value);
        // 包一层 Response 不改流：body 直接透传（V21 验流式 / 5MB）
        const bodyless = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
        return new Response(bodyless ? null : upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        });
      }
      case 'delay':
        await new Promise((resolve) => setTimeout(resolve, action.ms));
        return net.fetch(request, { bypassCustomProtocolHandlers: true });
      case 'passthrough':
        // 命中就是「别管它」，走正常网络栈。仍然记一条命中——人能看出这条口子被用过。
        return net.fetch(request, { bypassCustomProtocolHandlers: true });
    }
  }

  /** 未命中规则（或规则失败后的回退）的透传。**这里抛异常 = 页面白屏**，所以整体兜底。 */
  async #passthrough(request: Request, rule?: NetRule, note?: string): Promise<Response> {
    try {
      const response = await net.fetch(request, { bypassCustomProtocolHandlers: true });
      if (rule) this.#note(rule, request, response, note);
      this.#capture(request, response);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#record('net.passthroughFailed', `${request.method} ${request.url} 透传失败：${message}`);
      this.#push({
        at: new Date().toISOString(),
        method: request.method,
        url: request.url,
        status: 502,
        ruleId: rule?.id,
        action: 'passthrough',
        note: note ?? `透传失败：${message}`,
      });
      return new Response(`warren: 透传失败 ${message}`, {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  }

  #note(rule: NetRule, request: Request, response: Response, note?: string): void {
    try {
      this.#push({
        at: new Date().toISOString(),
        method: request.method,
        url: request.url,
        status: response.status,
        ruleId: rule.id,
        action: rule.action.type,
        note,
        requestHeaders: redactHeaders(request.headers),
        responseHeaders: redactHeaders(response.headers),
      });
    } catch {
      // 记录失败不能影响请求本身
    }
  }

  #push(hit: NetHit): void {
    this.#hits.push(hit);
    if (this.#hits.length > MAX_HITS) this.#hits.splice(0, this.#hits.length - MAX_HITS);
    this.#onHit?.(hit);
  }

  /**
   * 录一条往返。
   *
   * 用 `clone()` 读副本，绝不消费真正要返回给页面的那个 body；只记文本类，
   * 二进制和超限的直接跳过（记了也回放不了，还会把内存吃满）。
   */
  #capture(request: Request, response: Response): void {
    if (!this.#recording) return;
    try {
      const contentType = response.headers.get('content-type') ?? '';
      const length = Number(response.headers.get('content-length') ?? '0');
      if (!/^text\/|application\/(json|javascript|xml|x-www-form-urlencoded)/i.test(contentType)) return;
      if (Number.isFinite(length) && length > HAR_BODY_LIMIT) return;
      const clone = response.clone();
      void clone
        .text()
        .then((body) => {
          this.#har.push({
            at: new Date().toISOString(),
            method: request.method,
            url: request.url,
            status: response.status,
            contentType,
            body: body.slice(0, HAR_BODY_LIMIT),
          });
        })
        .catch(() => {
          // 录制永远不能影响请求
        });
    } catch {
      // 同上
    }
  }
}

/**
 * 命中记录里的头一律脱敏。
 *
 * 复用 `browser/redact.ts` 的 `redactSecrets`（词表含 cookie / token / secret…），再补一道
 * `authorization`：它不在那个词表里，而 `browser/` 是另一条线的成果，不在这里改。
 */
function redactHeaders(headers: Headers): Record<string, string> {
  const plain: Record<string, string> = {};
  headers.forEach((value, key) => {
    plain[key] = value;
  });
  const redacted = redactSecrets(plain).value as Record<string, string>;
  for (const key of Object.keys(redacted)) {
    if (/^authorization$/i.test(key) || /^proxy-authorization$/i.test(key)) redacted[key] = '[REDACTED]';
  }
  return redacted;
}
