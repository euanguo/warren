import type { X509Certificate } from 'node:crypto';
import { session, type Session, type WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import {
  clearCookies,
  copyCookies,
  importCookies,
  listCookies,
  type CookieFilter,
  type CookieInput,
} from '../browser/cookies.ts';
import { makeEvent } from '../domain/environment.ts';
import { leafSignedByCa, parseCa } from '../domain/trusted-ca.ts';
import { chromeUserAgent } from '../domain/user-agent.ts';
import { addExtension, listExtensions, removeExtension } from '../extensions.ts';
import { NetInterceptor } from '../net/interceptor.ts';
import { EnvironmentNetOps, type NetInterceptable } from '../net/ops.ts';
import { newTabPage } from '../newtab.ts';
import { redactUrl } from '../browser/redact.ts';
import type { Store } from '../store.ts';
import { Telemetry, type ConsoleEntry, type NetworkEntry } from '../telemetry.ts';
import type { CookieSummary, EnvironmentConfig, PluginBusEventType } from '../../shared/types.ts';

export interface SessionFactoryDeps {
  store: Store;
  onChange: () => void;
  emitBusEvent?: (type: PluginBusEventType, environmentId: string, payload: Record<string, unknown>) => void;
  createInterceptor?: (id: string, record: (type: string, message: string) => void) => NetInterceptable;
}

const ALLOWED_ENV_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write']);

/**
 * 环境 Session 工厂与运行时资源管理：
 * 负责 Session 创建、代理配置、`trustedCa` X509 验证、`warren://newtab` 协议注册、
 * `chromeUserAgent` 绑定、扩展加载、`#netOps` 与 `telemetry` 挂载及 Cookie 受控通道。
 */
export class EnvSessionFactory {
  #store: Store;
  #onChange: () => void;
  #sessions = new Map<string, Session>();
  #trustedCas = new Map<string, X509Certificate | undefined>();
  #netOps: EnvironmentNetOps;
  #telemetry: Telemetry;

  constructor(deps: SessionFactoryDeps) {
    this.#store = deps.store;
    this.#onChange = deps.onChange;
    this.#netOps = new EnvironmentNetOps({
      record: (type, message, actor, envId) => this.#store.record(makeEvent(type, message, actor, envId)),
      onChange: () => this.#onChange(),
      createInterceptor:
        deps.createInterceptor ??
        ((id, record) =>
          new NetInterceptor(record, (hit) =>
            deps.emitBusEvent?.('net.hit', id, {
              ruleId: hit.ruleId,
              action: hit.action,
              method: hit.method,
              url: redactUrl(hit.url),
              status: hit.status,
            }),
          )),
    });
    // 遥测也落在同一个库上（console / network 摘要）
    this.#telemetry = new Telemetry(this.#store.database);
  }

  get telemetryWriteStats(): { writes: number; ms: number } {
    return this.#telemetry.writeStats;
  }

  existingSession(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  trustedCaFor(id: string): X509Certificate | undefined {
    return this.#trustedCas.get(id);
  }

  sessionFor(id: string, storagePath: string): Session {
    const existing = this.#sessions.get(id);
    if (existing) return existing;
    const created = session.fromPath(storagePath);
    created.setUserAgent(chromeUserAgent(created.getUserAgent()));
    created.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_ENV_PERMISSIONS.has(permission));
    });
    /*
     * 内置页面（`warren://newtab`）挂**每环境自己的 session**。
     *
     * 不能挂在 `electron.protocol` 上：那一个只作用于默认 session，而页面跑在环境
     * session 里（实测症状：`loadURL` 报 `ERR_FAILED (-2)`，标签一片空白）。
     * `warren-plugin://` 没踩到这条是因为渲染层在默认 session 里。
     */
    created.protocol.handle('warren', (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'newtab') return new Response('not found', { status: 404 });
      return new Response(newTabPage(this.#store.get(id)), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    });
    this.#sessions.set(id, created);
    return created;
  }

  /** 运行中或没运行的环境都要能拿到 session（cookie 是磁盘上的状态，不依赖页面）。 */
  sessionOf(id: string): Session {
    const config = this.#store.configFor(id);
    if (!config) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    return this.sessionFor(id, config.storagePath);
  }

  /** 同步环境网络出口（代理与自定义 CA）到已创建的 Session，避免配置变更或休眠唤醒后分裂。 */
  async syncSessionNetwork(
    id: string,
    config: EnvironmentConfig,
    ses: Session | undefined = this.#sessions.get(id),
  ): Promise<ReturnType<typeof parseCa>> {
    if (!ses) return undefined;
    /*
     * **清掉代理也要显式设一次**。Session 是缓存的（`#sessions`），只在有代理时调
     * `setProxy` 的话，解绑之后这个 session 会**继续用上一次的代理**——配置里写着「直连」，
     * 流量还在走旧代理。实测：`env update --proxy=none` 之后重启环境，页面照样失败。
     */
    await ses.setProxy(config.proxy ? { proxyRules: config.proxy } : { mode: 'direct' });
    // 证书钩子要早于第一次导航：结果会被网络服务缓存，晚装就对已经验过的域名不生效
    return this.applyTrustedCa(id, ses, config.trustedCa);
  }

  /** 启动环境前准备 Session：落目录、清/设代理、装 CA 验签、挂拦截器与扩展。 */
  async prepareSession(
    id: string,
    config: EnvironmentConfig,
  ): Promise<{ session: Session; trustedCa: ReturnType<typeof parseCa> }> {
    await mkdir(config.storagePath, { recursive: true });
    const ses = this.sessionFor(id, config.storagePath);
    const trustedCa = await this.syncSessionNetwork(id, config, ses);
    // 拦截器要在第一个页面加载之前挂上：晚挂的请求会走真实网络
    this.#netOps.for(id).attach(ses);
    // 扩展也要在**第一个页面加载之前**装上，否则内容脚本注入不到首个页面
    await this.#loadExtensions(id, ses, config.storagePath);
    return { session: ses, trustedCa };
  }

  /** 透明唤醒用的同步准备：重挂拦截器并按当前配置同步 CA 验签钩子。 */
  prepareWakeSession(
    id: string,
    config: EnvironmentConfig,
  ): { session: Session; trustedCa: ReturnType<typeof parseCa> } {
    const ses = this.sessionFor(id, config.storagePath);
    const trustedCa = this.applyTrustedCa(id, ses, config.trustedCa);
    this.#netOps.for(id).attach(ses);
    return { session: ses, trustedCa };
  }

  /**
   * 给这个环境的 Session 装证书校验钩子 —— **全项目唯一的证书放宽点**。
   *
   * 只放行「由 `trustedCa` 那张 CA 签发」的叶子证书，不是无脑 `callback(0)`：
   * 钩子一装，这个 session 的每一张证书都要过它，写成无脑放行等于关掉整个环境的证书校验。
   * CA 读不出来时**不装**（回到 Chromium 默认校验）并记一条事件，不静默放行。
   *
   * 用途见 docs/WHISTLE-PLUGIN-PLAN.md §3.3：代理做 HTTPS 中间人时页面会直接
   * `ERR_CERT_AUTHORITY_INVALID`，靠这张 CA 放行。
   */
  applyTrustedCa(id: string, ses: Session, pemPath: string | undefined): ReturnType<typeof parseCa> {
    if (!pemPath) {
      ses.setCertificateVerifyProc(null);
      this.#trustedCas.delete(id);
      return undefined;
    }
    let ca: ReturnType<typeof parseCa>;
    try {
      ca = parseCa(readFileSync(pemPath, 'utf8'));
    } catch {
      ca = undefined;
    }
    if (!ca) {
      ses.setCertificateVerifyProc(null);
      this.#trustedCas.delete(id);
      this.#store.record(
        makeEvent('environment.trustedCaUnreadable', `trustedCa 读不出来，已回到默认校验: ${pemPath}`, 'system', id),
      );
      return undefined;
    }
    this.#trustedCas.set(id, ca);
    ses.setCertificateVerifyProc((request, callback) => {
      // -2 = 拒绝（Electron 文档：callback(0) 接受、callback(-2) 拒绝）
      callback(leafSignedByCa(request.certificate.data, ca) ? 0 : -2);
    });
    return ca;
  }

  attachSessionTelemetry(ses: Session): void {
    this.#telemetry.attachSession(ses);
  }

  detachNet(id: string): void {
    this.#netOps.detach(id);
  }

  detachTelemetry(id: string): void {
    const ses = this.#sessions.get(id);
    if (ses) this.#telemetry.detachSession(ses);
    // 停/休眠只清理运行期内存映射，保留 console/network SQLite 历史便于事后排查
    this.#telemetry.forgetEnv(id);
  }

  clearTelemetry(id: string): void {
    const ses = this.#sessions.get(id);
    if (ses) this.#telemetry.detachSession(ses);
    this.#telemetry.clear(id);
  }

  drop(id: string): void {
    this.#netOps.drop(id);
  }

  /**
   * 删环境前清掉这份 Session 的存储数据，但保留 `#sessions` 缓存条目：
   * Electron 对同一个 storagePath 返回同一个 Session，删掉再 fromPath 会二次注册 `warren` 协议。
   */
  async clearStorageData(id: string): Promise<void> {
    const ses = this.#sessions.get(id);
    if (!ses) return;
    try {
      await ses.clearStorageData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#store.record(
        makeEvent('environment.removeFailed', `environment ${id} clear storage failed: ${message}`, 'system', id),
      );
      throw Object.assign(new Error(`environment ${id} clear storage failed: ${message}`), {
        code: 'ENV_REMOVE_FAILED',
      });
    }
  }

  attachTabTelemetry(envId: string, tabId: string, wc: WebContents): void {
    this.#telemetry.attachTab(envId, tabId, wc);
  }

  detachTabTelemetry(tabId: string): void {
    this.#telemetry.detachTab(tabId);
  }

  lastActivityAt(tabId: string): number {
    return this.#telemetry.lastActivityAt(tabId);
  }

  inFlightCount(tabId: string): number {
    return this.#telemetry.inFlightCount(tabId);
  }

  lastNavigationError(tabId: string) {
    return this.#telemetry.lastNavigationError(tabId);
  }

  consoleEntries(id: string): ConsoleEntry[] {
    return this.#telemetry.consoleEntries(id);
  }

  networkEntries(id: string): NetworkEntry[] {
    return this.#telemetry.networkEntries(id);
  }

  networkEntriesSince(id: string, afterId: number, limit?: number): NetworkEntry[] {
    return this.#telemetry.networkEntriesSince(id, afterId, limit);
  }

  // ── 扩展 ────────────────────────────────────────────────────────────

  /**
   * 把这个环境装过的扩展挂到 session 上。
   *
   * `loadExtension` **每次启动都要重调**（Electron 不记住），所以放在 `start()` 里。
   * 单个扩展失败不能拖垮整个环境 —— 坏扩展只记一条事件。
   */
  async #loadExtensions(id: string, ses: Session, storagePath: string): Promise<void> {
    for (const ext of await listExtensions(storagePath)) {
      try {
        await ses.loadExtension(ext.dir);
      } catch (error) {
        this.#store.record(makeEvent('extension.loadFailed', `${ext.id}: ${(error as Error).message}`, 'system', id));
      }
    }
  }

  /** 该环境的存储目录（扩展放在它下面的 `extensions/`）。 */
  #storageOf(id: string): string {
    const config = this.#store.configFor(id);
    if (!config) throw Object.assign(new Error(`unknown environment ${id}`), { code: 'ENV_NOT_FOUND' });
    return config.storagePath;
  }

  /** 该环境装了哪些扩展（目录名 + 磁盘路径）。 */
  async extensionsOf(id: string): Promise<{ id: string; dir: string }[]> {
    return listExtensions(this.#storageOf(id));
  }

  /** 装一个解包好的扩展；正在跑的环境**当场**生效，不用重启。 */
  async extensionAdd(id: string, srcDir: string, name?: string): Promise<{ id: string; dir: string }> {
    const storagePath = this.#storageOf(id);
    const added = await addExtension(storagePath, srcDir, name);
    const ses = this.#sessions.get(id);
    if (ses) {
      try {
        await ses.loadExtension(added.dir);
      } catch (error) {
        this.#store.record(makeEvent('extension.loadFailed', `${added.id}: ${(error as Error).message}`, 'system', id));
      }
    }
    this.#onChange();
    return added;
  }

  /** 卸载：删目录。已经挂上的那个要等环境重启才真的消失（Electron 没有 unload 扩展的 API）。 */
  async extensionRemove(id: string, name: string): Promise<{ removed: boolean }> {
    const storagePath = this.#storageOf(id);
    const removed = await removeExtension(storagePath, name);
    this.#onChange();
    return { removed };
  }

  // ── Cookie 受控通道（只搬运不返回，见 docs/PLUGIN-CAPABILITY-DESIGN.md §9）──
  // Session 对象不外泄：插件侧只拿得到 summarize 过的元数据与计数。

  /** 列 cookie 元数据（没有值）。环境没在跑也能查——cookie 存在 session 目录里。 */
  async cookieNames(id: string, url?: string): Promise<CookieSummary[]> {
    return listCookies(this.sessionOf(id), url);
  }

  /** 环境 → 环境搬运。值在主进程内部从 from 读出来直接写进 to。 */
  async cookieCopy(from: string, to: string, filter: CookieFilter = {}): Promise<{ copied: number; names: string[] }> {
    if (from === to) {
      throw Object.assign(new Error('copy 的 from 和 to 不能是同一个环境'), {
        code: 'BAD_REQUEST',
      });
    }
    return copyCookies(this.sessionOf(from), this.sessionOf(to), filter);
  }

  async cookieImport(id: string, cookies: CookieInput[]): Promise<{ written: number; names: string[] }> {
    return importCookies(this.sessionOf(id), cookies);
  }

  async cookieClear(id: string, filter: CookieFilter = {}): Promise<{ removed: number }> {
    return clearCookies(this.sessionOf(id), filter);
  }

  // ── 网络拦截（委托给 EnvironmentNetOps）───────────────────────────

  isNetBusy(id: string): boolean {
    const net = this.#netOps.summary(id);
    return net.recording || net.replaying;
  }

  netRules(id: string) {
    return this.#netOps.summary(id);
  }
  netHits(id: string, limit?: number) {
    return this.#netOps.hits(id, limit);
  }
  netAddRule(id: string, input: unknown, actor: 'agent' | 'human') {
    return this.#netOps.addRule(id, input, actor);
  }
  netPassthrough(
    id: string,
    input: { match: string; isRegex?: boolean; method?: string; forMs: number },
    actor: 'agent' | 'human',
  ) {
    return this.#netOps.passthrough(id, input, actor);
  }
  netSetRuleEnabled(id: string, ruleId: string, enabled: boolean, actor: 'agent' | 'human') {
    return this.#netOps.setRuleEnabled(id, ruleId, enabled, actor);
  }
  netRemoveRule(id: string, ruleId: string, actor: 'agent' | 'human') {
    return this.#netOps.removeRule(id, ruleId, actor);
  }
  netRecord(id: string, action: string, output: string | undefined, actor: 'agent' | 'human') {
    return this.#netOps.record(id, action, output, actor);
  }
  netReplay(id: string, action: string, file: string | undefined, offline: boolean, actor: 'agent' | 'human') {
    return this.#netOps.replay(id, action, file, offline, actor);
  }
  netBody(id: string, index: number) {
    return this.#netOps.body(id, index);
  }
}
