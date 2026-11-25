/**
 * 网络拦截的**编排层**：环境级拦截器的持有者 + 规则/录制/回放的门面。
 *
 * 从 `environments.ts` 拆出来的（那个文件 1300+ 行，是个 God object）。拆的时候**带上了注入点** ——
 * 依赖只有「记事件」和「通知界面」两个回调，所以 `tests/net-ops.test.ts` 能喂假 NetInterceptor
 * 直接跑，不需要 Electron。**光搬代码不产生测试覆盖，注入点才是这一步的意义。**
 *
 * 规则只在内存里，随 Environment 生命周期走（`drop` 在环境被删时调）。
 */
import { readFile } from 'node:fs/promises';
import type { NetHit, NetRule } from '../../shared/types';
import { guardSavePath } from '../browser/policy.ts';
import { isSensitiveKey, redactSecrets } from '../browser/redact.ts';
import { rulesFromHar, toHarDocument } from './har.ts';
import { writeArtifact } from '../artifacts.ts';
// **type-only**：真货 interceptor.ts 在运行时 import electron，node:test 加载不了。
// 用类型 + 工厂注入，这个模块就完全不碰 electron，单测才能直接跑。
import type { NetInterceptor } from './interceptor.ts';
import { PASSTHROUGH_PRIORITY } from './rules.ts';

/**
 * 本模块真正用到的拦截器方法。**用 `Pick` 而不是手抄一份接口** ——
 * 真货 `NetInterceptor` 加/改方法时这里会编译报错，不会悄悄脱节。
 */
export type NetInterceptable = Pick<
  NetInterceptor,
  | 'summary'
  | 'hits'
  | 'rules'
  | 'addRule'
  | 'setRuleEnabled'
  | 'removeRule'
  | 'startRecording'
  | 'stopRecording'
  | 'capturedBodies'
  | 'installReplay'
  | 'stopReplay'
  | 'attach'
  | 'detach'
>;

export interface NetOpsDeps {
  /** 记一条环境事件。`envId` 由本模块给，`actor` 由调用方给。 */
  record: (type: string, message: string, actor: 'agent' | 'human' | 'system', envId: string) => void;
  /** 规则表 / 录制状态变了，通知界面刷新。 */
  onChange: () => void;
  /**
   * 建一个拦截器。默认实现是 `new NetInterceptor(...)`（由 environments.ts 传进来）。
   * 单测传假对象 —— 这就是本模块能被测的原因。
   */
  createInterceptor: (id: string, record: (type: string, message: string) => void) => NetInterceptable;
}

export class EnvironmentNetOps {
  #net = new Map<string, NetInterceptable>();
  /*
   * 不用 TS 的**参数属性**（`constructor(private readonly deps: …)`）：
   * `node --test` 直接加载 .ts 走的是 strip-only 模式，参数属性会抛
   * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。必须写成显式字段。
   */
  #deps: NetOpsDeps;

  constructor(deps: NetOpsDeps) {
    this.#deps = deps;
  }

  /** 该环境的拦截器（惰性建）。环境启动时用它 `attach`，停止时 `detach`。 */
  for(id: string): NetInterceptable {
    const existing = this.#net.get(id);
    if (existing) return existing;
    const created = this.#deps.createInterceptor(id, (type, message) => this.#deps.record(type, message, 'system', id));
    this.#net.set(id, created);
    return created;
  }

  /** 环境停止：摘掉 handler，规则留着（下次 start 重新挂）。 */
  detach(id: string): void {
    this.#net.get(id)?.detach();
  }

  /** 环境被删：连拦截器一起丢。 */
  drop(id: string): void {
    this.#net.delete(id);
  }

  // ── 规则 ──────────────────────────────────────────────────────────
  // 读规则 / 读命中是读操作；改规则是写操作（RPC 层走 assertWritable）。

  summary(id: string): { rules: NetRule[]; hits: number; recording: boolean; replaying: boolean } {
    return this.for(id).summary();
  }

  hits(id: string, limit?: number): NetHit[] {
    return this.for(id).hits(limit);
  }

  addRule(id: string, input: unknown, actor: 'agent' | 'human'): NetRule {
    const rule = this.for(id).addRule(input);
    // 带过期的规则要说清什么时候自己消失，否则「拦截怎么突然好了」没人查得出来
    const ttl = rule.expiresAt ? `（${Math.round((rule.expiresAt - Date.now()) / 1000)}s 后自动摘掉）` : '';
    this.#deps.record(
      'net.rule.added',
      `${id} 新增规则 ${rule.id} ${rule.action.type} ${rule.match.url}${ttl}`,
      actor,
      id,
    );
    this.#deps.onChange();
    return rule;
  }

  /**
   * 临时放行：加一条到点自动摘掉的 `passthrough` 规则。
   *
   * 时长在这里卡（CLI 和 RPC 都走这条路）：1 秒 ~ 1 小时。既不能是负数，
   * 也不接受「放到世界末日」——那条规则会永远把 handler 挂着（CORS 偏差也就一直留着）。
   */
  passthrough(
    id: string,
    input: { match: string; isRegex?: boolean; method?: string; forMs: number },
    actor: 'agent' | 'human',
  ): NetRule {
    if (!Number.isFinite(input.forMs) || input.forMs < 1000 || input.forMs > 3_600_000) {
      throw Object.assign(new Error('forMs 必须在 1000..3600000（1 秒 ~ 1 小时）之间'), {
        code: 'BAD_REQUEST',
      });
    }
    /*
     * 同一条匹配串只留最新的那条：`net passthrough` 是「临时开个口子」，
     * 连点两次不该把规则表堆成两条同模式的口子（谁先到期、谁还在拦，人会看不懂）。
     */
    const net = this.for(id);
    for (const rule of net.rules()) {
      if (rule.action.type !== 'passthrough') continue;
      if (rule.match.url !== input.match) continue;
      if (Boolean(rule.match.isRegex) !== Boolean(input.isRegex)) continue;
      if ((rule.match.method ?? '') !== (input.method ?? '')) continue;
      net.removeRule(rule.id);
    }
    return this.addRule(
      id,
      {
        match: { url: input.match, isRegex: input.isRegex, method: input.method },
        priority: PASSTHROUGH_PRIORITY,
        action: { type: 'passthrough' },
        expiresAt: Date.now() + input.forMs,
      },
      actor,
    );
  }

  setRuleEnabled(id: string, ruleId: string, enabled: boolean, actor: 'agent' | 'human'): NetRule {
    const rule = this.for(id).setRuleEnabled(ruleId, enabled);
    this.#deps.record('net.rule.updated', `${id} ${enabled ? '启用' : '关闭'}规则 ${ruleId}`, actor, id);
    this.#deps.onChange();
    return rule;
  }

  removeRule(id: string, ruleId: string, actor: 'agent' | 'human'): boolean {
    const removed = this.for(id).removeRule(ruleId);
    if (removed) {
      this.#deps.record('net.rule.removed', `${id} 删除规则 ${ruleId}`, actor, id);
      this.#deps.onChange();
    }
    return removed;
  }

  /**
   * 读录制期间抓到的**响应体**（按序）。这就是「联调时看接口返回」那条路。
   *
   * ⚠️ 响应体只在 **HAR 录制期间**才有 —— 抓它要靠 `protocol.handle` 挂上整个 session，
   * 而那会让跨源响应**跳过 CORS 检查**（见 `interceptor.ts` 的 `attach()` 注释）。
   * 所以「随时能看 body」和「CORS 语义真实」在 Electron 里是互斥的，只能按需开。
   * 没录制时直接报错并把下一步命令写进消息里，别让人对着空数组猜。
   */
  body(
    id: string,
    index: number,
  ): {
    url: string;
    status: number;
    contentType?: string;
    body: string;
    redacted: boolean;
  } {
    const all = this.for(id).capturedBodies();
    if (!all.length) {
      throw Object.assign(
        new Error(
          '这个环境还没抓过响应体。响应体**只在 HAR 录制期间**抓（抓它会让跨源响应跳过 CORS 检查，所以不常开）——' +
            `先 \`warren net record start ${id}\`，操作页面，再用这条命令读。停录之后仍然读得到最近一次的那批。`,
        ),
        { code: 'NET_BODY_NEEDS_RECORDING' },
      );
    }
    const entry = all[index];
    if (!entry) {
      throw Object.assign(new Error(`没有第 ${index} 条（录制中一共抓到 ${all.length} 条响应体）`), {
        code: 'BAD_REQUEST',
      });
    }
    const { text, redacted } = redactBody(entry.body ?? '');
    return {
      url: redactUrl(entry.url),
      status: entry.status,
      contentType: entry.contentType,
      body: text,
      redacted,
    };
  }

  // ── HAR 录制 / 回放 ───────────────────────────────────────────────

  /**
   * HAR 录制。`stop` 时把这一轮录到的往返写成 HAR 文件。
   * 路径走 `guardSavePath` 护栏（和下载的 saveAs 同一套），不接受相对路径。
   */
  async record(
    id: string,
    action: string,
    output: string | undefined,
    actor: 'agent' | 'human',
  ): Promise<{ recording: boolean; entries: number; path?: string; bytes?: number; sha256?: string }> {
    const net = this.for(id);
    if (action === 'start') {
      net.startRecording();
      this.#deps.record('net.record.started', `${id} 开始录 HAR`, actor, id);
      this.#deps.onChange();
      return { recording: true, entries: 0 };
    }
    if (action !== 'stop') {
      throw Object.assign(new Error(`未知动作 ${action}（start|stop）`), { code: 'BAD_REQUEST' });
    }
    const entries = net.stopRecording();
    let artifact: { path: string; bytes: number; sha256: string } | undefined;
    if (output) {
      const target = guardSavePath(output, 'saveAs');
      artifact = await writeArtifact(target, JSON.stringify(toHarDocument(entries), null, 2) + '\n');
    }
    this.#deps.record(
      'net.record.stopped',
      `${id} 录到 ${entries.length} 条${artifact ? ` → ${artifact.path}` : ''}`,
      actor,
      id,
    );
    this.#deps.onChange();
    return {
      recording: false,
      entries: entries.length,
      path: artifact?.path,
      bytes: artifact?.bytes,
      sha256: artifact?.sha256,
    };
  }

  /** HAR 回放：把 HAR 里的响应装成规则。`stop` 整体摘掉（回到直连）。 */
  async replay(
    id: string,
    action: string,
    file: string | undefined,
    offline: boolean,
    actor: 'agent' | 'human',
  ): Promise<{ replaying: boolean; rules: number }> {
    const net = this.for(id);
    if (action === 'stop') {
      const removed = net.stopReplay();
      this.#deps.record('net.replay.stopped', `${id} 停止回放（摘掉 ${removed} 条规则）`, actor, id);
      this.#deps.onChange();
      return { replaying: false, rules: removed };
    }
    if (action !== 'start') {
      throw Object.assign(new Error(`未知动作 ${action}（start|stop）`), { code: 'BAD_REQUEST' });
    }
    if (!file) throw Object.assign(new Error('replay 需要 har 文件路径'), { code: 'BAD_REQUEST' });
    const path = guardSavePath(file, 'saveAs');
    let document: unknown;
    try {
      document = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      throw Object.assign(new Error(`读不了 HAR ${path}：${error instanceof Error ? error.message : String(error)}`), {
        code: 'BAD_REQUEST',
      });
    }
    const rules = rulesFromHar(document, offline);
    if (!rules.length) throw Object.assign(new Error('HAR 里没有可回放的响应体'), { code: 'BAD_REQUEST' });
    net.installReplay(rules);
    this.#deps.record(
      'net.replay.started',
      `${id} 回放 ${path}（${rules.length} 条规则${offline ? '，offline' : ''}）`,
      actor,
      id,
    );
    this.#deps.onChange();
    return { replaying: true, rules: rules.length };
  }
}

/**
 * 响应体脱敏：JSON 按 key 走 `redactSecrets`；**非 JSON 原样返回**并把 `redacted` 标成 false。
 *
 * 这里不做正则猜文本 —— 猜不准还给人「已经安全了」的错觉。非 JSON 的那条路要显式告诉调用方。
 */
function redactBody(body: string): { text: string; redacted: boolean } {
  const trimmed = body.trim();
  if (!/^[[{]/.test(trimmed)) return { text: body, redacted: false };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const { value, redacted } = redactSecrets(parsed);
    return { text: JSON.stringify(value, null, 2), redacted };
  } catch {
    return { text: body, redacted: false };
  }
}

/** URL 的 query 里命中敏感词的参数值也脱敏（`?token=…` 这种太常见了）。 */
function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    let hit = false;
    for (const [key] of [...url.searchParams]) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, '[REDACTED]');
        hit = true;
      }
    }
    return hit ? url.toString() : raw;
  } catch {
    return raw;
  }
}
