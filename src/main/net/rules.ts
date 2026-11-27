/**
 * 网络拦截规则：模型 + 匹配 + 决策。
 *
 * **纯函数，不碰 Electron 的 session**——接线在 `interceptor.ts`，这样规则逻辑能直接单测。
 * 对标 Playwright 的 `page.route`，但规则是 Environment 级的、人能看见能改（见 NET-INTERCEPT-PLAN）。
 */
import { globToRegExp } from '../browser/matcher.ts';
// 类型走 shared（RPC / IPC 边界都用它）；`import type` 会被擦除，所以不用带扩展名
import type { NetAction, NetRule } from '../../shared/types';

export type { NetAction, NetRule };

/**
 * 临时放行的优先级。
 *
 * 高到压过任何手工规则：它的用途就是「在所有规则之上开一个口子」——
 * 被 mock / 阻断拦住的请求要能临时看真响应，被别的规则抢先命中就没意义了。
 */
export const PASSTHROUGH_PRIORITY = 1_000_000;

const MAX_COMPILED_PATTERNS = 512;
const compiledPatterns = new Map<string, RegExp | null>();

function getCompiledPattern(pattern: string, isRegex: boolean): RegExp | null {
  const key = `${isRegex ? 'r' : 'g'}:${pattern}`;
  const cached = compiledPatterns.get(key);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  try {
    compiled = isRegex ? new RegExp(pattern) : globToRegExp(pattern);
  } catch {
    compiled = null;
  }
  if (compiledPatterns.size >= MAX_COMPILED_PATTERNS) {
    const oldest = compiledPatterns.keys().next().value;
    if (oldest !== undefined) compiledPatterns.delete(oldest);
  }
  compiledPatterns.set(key, compiled);
  return compiled;
}

/** URL 是否命中模式。默认 glob **全匹配**（要部分匹配就两端写 `*`），`isRegex` 时按正则；编译结果带上限缓存。 */
export function matchUrl(pattern: string, url: string, isRegex = false): boolean {
  if (typeof pattern !== 'string' || !pattern) return false;
  const compiled = getCompiledPattern(pattern, isRegex);
  return compiled ? compiled.test(url) : false;
}

/** 规则过期了没。没有 `expiresAt` 的规则永不过期。 */
export function isExpired(rule: NetRule, now = Date.now()): boolean {
  return rule.expiresAt !== undefined && rule.expiresAt <= now;
}

/** 这条规则此刻算不算数（启用且没过期）。挂/摘 handler、挑规则都用它。 */
export function isActive(rule: NetRule, now = Date.now()): boolean {
  return rule.enabled && !isExpired(rule, now);
}

/**
 * 最近一条规则的过期时刻，用来定时摘 handler。
 *
 * 返回 undefined 表示「没有会过期的规则」——那时不需要定时器。
 * 只看**启用且未过期**的规则：已经过期的马上会被清掉，不用再为它排一次。
 */
export function nextExpiry(rules: NetRule[], now = Date.now()): number | undefined {
  let next: number | undefined;
  for (const rule of rules) {
    if (!isActive(rule, now) || rule.expiresAt === undefined) continue;
    if (next === undefined || rule.expiresAt < next) next = rule.expiresAt;
  }
  return next;
}

/** 挑出命中的规则：单趟零分配扫描（enabled + 未过期 + method 匹配 + URL 命中，priority 降序，同级先加优先）。 */
export function pickRule(rules: NetRule[], url: string, method = 'GET', now = Date.now()): NetRule | null {
  const upper = method.toUpperCase();
  let best: NetRule | null = null;
  let bestPriority = -Infinity;
  for (const rule of rules) {
    const priority = rule.priority ?? 0;
    if (best !== null && priority <= bestPriority) continue;
    if (!isActive(rule, now)) continue;
    if (rule.match.method && rule.match.method.toUpperCase() !== upper) continue;
    if (!matchUrl(rule.match.url, url, rule.match.isRegex)) continue;
    best = rule;
    bestPriority = priority;
  }
  return best;
}

/** 正则里用的字面量转义。HAR 回放要按**精确 URL** 匹配（glob 会把 `?` 当单字符通配）。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bad(message: string): Error {
  // 校验失败要在 RPC 边界报成 BAD_REQUEST，不能是 INTERNAL
  return Object.assign(new Error(message), { code: 'BAD_REQUEST' });
}

function headerRecord(input: unknown, field: string): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad(`${field} 必须是对象`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key) throw bad(`${field} 的键不能为空`);
    if (typeof value !== 'string') throw bad(`${field}.${key} 必须是字符串`);
    out[key] = value;
  }
  if (Object.keys(out).length === 0) throw bad(`${field} 不能为空`);
  return out;
}

/** action 归一 + 校验。RPC / CLI 是信任边界，坏规则在这里被挡住，不落到 session 上。 */
export function normalizeAction(input: unknown): NetAction {
  const raw = (input ?? {}) as Record<string, unknown>;
  switch (raw.type) {
    case 'mock': {
      const status = raw.status === undefined ? 200 : Number(raw.status);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw bad('mock.status 必须是 100..599');
      // body 允许传字符串（CLI 就是字符串）或任意 JSON（RPC 调用方便）
      const body = typeof raw.body === 'string' ? raw.body : JSON.stringify(raw.body ?? null);
      const action: NetAction = { type: 'mock', status, body };
      if (raw.contentType !== undefined) action.contentType = String(raw.contentType);
      if (raw.headers !== undefined) action.headers = headerRecord(raw.headers, 'mock.headers');
      return action;
    }
    case 'block':
      return { type: 'block' };
    case 'redirect': {
      if (typeof raw.to !== 'string' || !raw.to) throw bad('redirect.to 必填');
      return { type: 'redirect', to: raw.to };
    }
    case 'setRequestHeaders':
      return { type: 'setRequestHeaders', headers: headerRecord(raw.headers, 'headers') };
    case 'setResponseHeaders':
      return { type: 'setResponseHeaders', headers: headerRecord(raw.headers, 'headers') };
    case 'delay': {
      const ms = Number(raw.ms);
      if (!Number.isFinite(ms) || ms < 0) throw bad('delay.ms 必须是非负数');
      return { type: 'delay', ms };
    }
    case 'passthrough':
      return { type: 'passthrough' };
    default:
      throw bad(`未知的 action.type: ${String(raw.type)}`);
  }
}

/** 规则归一 + 校验。id 缺省时留空，由调用方（interceptor）补一个 UUID。 */
export function normalizeRule(input: unknown, now = Date.now()): NetRule {
  const raw = (input ?? {}) as Record<string, unknown>;
  const match = raw.match as Record<string, unknown> | undefined;
  if (!match || typeof match.url !== 'string' || !match.url) throw bad('match.url 必填');
  const rule: NetRule = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : '',
    enabled: raw.enabled !== false,
    match: {
      url: match.url,
      isRegex: Boolean(match.isRegex),
      method: typeof match.method === 'string' && match.method ? match.method.toUpperCase() : undefined,
    },
    action: normalizeAction(raw.action),
  };
  if (typeof raw.priority === 'number' && Number.isFinite(raw.priority)) rule.priority = raw.priority;
  if (raw.expiresAt !== undefined) {
    const expiresAt = Number(raw.expiresAt);
    // 已经过期的规则加进来等于「加了一条永远不生效的规则」，直接拒绝（静默接受最难查）
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw bad('expiresAt 必须是未来的时间戳');
    rule.expiresAt = expiresAt;
  }
  return rule;
}
