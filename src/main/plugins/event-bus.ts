/**
 * 主进程 → 插件的只读事件总线（`events.subscribe`）。
 *
 * 设计不变量：
 * 1. 只放行白名单事件类型，不支持任意主题，避免内部事件泄露；
 * 2. 所有 payload 经过 `sanitizeEvent` 防御过滤，严禁 Cookie 值、凭据明文或网页正文流出；
 * 3. 每个插件积压上限 256 条（超限丢最老保最新），单向微批异步投递，绝不阻塞主进程事件循环；
 * 4. 只要插件被 `disable`、`reload` 或底层子进程崩溃 `exit`，一次性清空该插件全部订阅与待投递队列。
 */

export const PLUGIN_EVENT_TYPES = ['nav.committed', 'lease.changed', 'tab.created', 'env.status', 'net.hit'] as const;

export type PluginBusEventType = (typeof PLUGIN_EVENT_TYPES)[number];

export interface PluginEventFilter {
  environmentId?: string;
  types?: PluginBusEventType[];
}

export interface PluginBusEvent {
  type: PluginBusEventType;
  environmentId: string;
  at: string;
  payload: Record<string, unknown>;
}

export const EVENT_BUS_MAX_QUEUE_PER_PLUGIN = 256;
const FLUSH_BATCH_SIZE = 64;
const MAX_PAYLOAD_STRING_LENGTH = 2048;

const SENSITIVE_KEYS = new Set([
  'cookie',
  'cookies',
  'setcookie',
  'cookievalue',
  'cookieheader',
  'password',
  'passwd',
  'secret',
  'secretvalue',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'totp',
  'apikey',
  'authorization',
  'proxyauthorization',
  'credential',
  'credentials',
  'cipher',
  'privatekey',
  'body',
  'html',
  'pagebody',
  'requestbody',
  'responsebody',
  'rawbody',
  'textbody',
  'innerhtml',
  'outerhtml',
  'documenthtml',
  'pagecontent',
  'webpage',
]);

const HEADER_CONTAINER_KEYS = new Set(['headers', 'requestheaders', 'responseheaders']);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isPluginBusEventType(value: string): value is PluginBusEventType {
  return (PLUGIN_EVENT_TYPES as readonly string[]).includes(value);
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>, insideHeaders = false): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return value.length > MAX_PAYLOAD_STRING_LENGTH ? value.slice(0, MAX_PAYLOAD_STRING_LENGTH) : value;
  }
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (depth > 8) return undefined;

  const object = value as object;
  if (seen.has(object)) return undefined;
  seen.add(object);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const cleaned = sanitizeValue(item, depth + 1, seen, false);
      if (cleaned !== undefined) out.push(cleaned);
    }
    return out;
  }

  const proto = Object.getPrototypeOf(object) as { constructor?: { name?: string } } | null;
  const ctorName = proto === null ? 'Object' : proto.constructor?.name;
  if (ctorName !== 'Object') return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeKey(key);
    if (SENSITIVE_KEYS.has(normalized)) continue;
    if (insideHeaders && (normalized === 'cookie' || normalized === 'setcookie' || normalized === 'authorization')) {
      continue;
    }
    const cleaned = sanitizeValue(item, depth + 1, seen, HEADER_CONTAINER_KEYS.has(normalized));
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** 对事件载荷做防御性脱敏：移除 Cookie、凭据明文及网页正文等敏感字段。 */
export function sanitizeEvent(event: {
  type: PluginBusEventType;
  environmentId: string;
  at: string;
  payload: Record<string, unknown>;
}): PluginBusEvent {
  const seen = new WeakSet<object>();
  const sanitizedPayload = sanitizeValue(event.payload ?? {}, 0, seen, false);
  return {
    type: event.type,
    environmentId: String(event.environmentId ?? ''),
    at: String(event.at || new Date().toISOString()),
    payload:
      sanitizedPayload && typeof sanitizedPayload === 'object' && !Array.isArray(sanitizedPayload)
        ? (sanitizedPayload as Record<string, unknown>)
        : {},
  };
}

interface SubscriptionEntry {
  subscriptionId: string;
  pluginId: string;
  instanceId?: string;
  environmentId?: string;
  types: Set<PluginBusEventType> | null;
}

interface QueuedDelivery {
  subscriptionId: string;
  event: PluginBusEvent;
}

export type EventDeliverFn = (pluginId: string, subscriptionId: string, event: PluginBusEvent) => void;

function parseFilter(rawFilter: unknown): { environmentId?: string; types: Set<PluginBusEventType> | null } {
  if (rawFilter !== undefined && rawFilter !== null && typeof rawFilter !== 'object') {
    throw Object.assign(new Error('events.subscribe 的 filter 必须是对象'), { code: 'PLUGIN_BAD_REQUEST' });
  }
  const filter = (rawFilter ?? {}) as { environmentId?: unknown; types?: unknown; type?: unknown };
  let environmentId: string | undefined;
  if (filter.environmentId !== undefined && filter.environmentId !== null) {
    if (typeof filter.environmentId !== 'string') {
      throw Object.assign(new Error('filter.environmentId 必须是字符串'), { code: 'PLUGIN_BAD_REQUEST' });
    }
    if (filter.environmentId) environmentId = filter.environmentId;
  }

  let types: Set<PluginBusEventType> | null = null;
  if (filter.types !== undefined) {
    if (!Array.isArray(filter.types)) {
      throw Object.assign(new Error('filter.types 必须是数组'), { code: 'PLUGIN_BAD_REQUEST' });
    }
    types = new Set<PluginBusEventType>();
    for (const item of filter.types) {
      if (typeof item !== 'string' || !isPluginBusEventType(item)) {
        throw Object.assign(new Error(`未知的事件类型: ${String(item)}`), { code: 'PLUGIN_BAD_REQUEST' });
      }
      types.add(item);
    }
  } else if (filter.type !== undefined) {
    if (typeof filter.type !== 'string' || !isPluginBusEventType(filter.type)) {
      throw Object.assign(new Error(`未知的事件类型: ${String(filter.type)}`), { code: 'PLUGIN_BAD_REQUEST' });
    }
    types = new Set([filter.type]);
  }

  return { environmentId, types };
}

export class PluginEventBus {
  #subscriptions = new Map<string, Map<string, SubscriptionEntry>>();
  #queues = new Map<string, QueuedDelivery[]>();
  #scheduled = new Set<string>();
  #deliver: EventDeliverFn;

  constructor(deliver: EventDeliverFn) {
    this.#deliver = deliver;
  }

  subscribe(pluginId: string, rawFilter: unknown = {}, instanceId?: string): { subscriptionId: string } {
    const parsed = parseFilter(rawFilter);
    const subscriptionId = crypto.randomUUID();
    let pluginSubs = this.#subscriptions.get(pluginId);
    if (!pluginSubs) {
      pluginSubs = new Map();
      this.#subscriptions.set(pluginId, pluginSubs);
    }
    pluginSubs.set(subscriptionId, {
      subscriptionId,
      pluginId,
      instanceId,
      environmentId: parsed.environmentId,
      types: parsed.types,
    });
    return { subscriptionId };
  }

  unsubscribe(pluginId: string, subscriptionId: string): boolean {
    const pluginSubs = this.#subscriptions.get(pluginId);
    if (!pluginSubs) return false;
    const deleted = pluginSubs.delete(subscriptionId);
    if (pluginSubs.size === 0) {
      this.#subscriptions.delete(pluginId);
      this.#queues.delete(pluginId);
    } else if (deleted) {
      const queue = this.#queues.get(pluginId);
      if (queue) {
        const filtered = queue.filter((item) => item.subscriptionId !== subscriptionId);
        if (filtered.length) this.#queues.set(pluginId, filtered);
        else this.#queues.delete(pluginId);
      }
    }
    return deleted;
  }

  /** 停用 / 崩溃退出时一次性清空该插件的全部订阅与积压队列。 */
  unsubscribePlugin(pluginId: string): void {
    this.#subscriptions.delete(pluginId);
    this.#queues.delete(pluginId);
    this.#scheduled.delete(pluginId);
  }

  /** 清理某个旧实例的订阅（reload 失败回滚时使用）。 */
  unsubscribeInstance(pluginId: string, instanceId: string): void {
    const pluginSubs = this.#subscriptions.get(pluginId);
    if (!pluginSubs) return;
    const removedIds = new Set<string>();
    for (const [subId, entry] of pluginSubs) {
      if (entry.instanceId === instanceId) {
        pluginSubs.delete(subId);
        removedIds.add(subId);
      }
    }
    if (pluginSubs.size === 0) {
      this.#subscriptions.delete(pluginId);
      this.#queues.delete(pluginId);
      return;
    }
    if (removedIds.size) {
      const queue = this.#queues.get(pluginId);
      if (queue) {
        const remaining = queue.filter((item) => !removedIds.has(item.subscriptionId));
        if (remaining.length) this.#queues.set(pluginId, remaining);
        else this.#queues.delete(pluginId);
      }
    }
  }

  /** reload 成功切换新实例后：一次性清理除新实例外的全部历史订阅。 */
  clearExceptInstance(pluginId: string, keepInstanceId: string): void {
    const pluginSubs = this.#subscriptions.get(pluginId);
    if (!pluginSubs) return;
    const removedIds = new Set<string>();
    for (const [subId, entry] of pluginSubs) {
      if (entry.instanceId !== keepInstanceId) {
        pluginSubs.delete(subId);
        removedIds.add(subId);
      }
    }
    if (pluginSubs.size === 0) {
      this.#subscriptions.delete(pluginId);
      this.#queues.delete(pluginId);
      return;
    }
    if (removedIds.size) {
      const queue = this.#queues.get(pluginId);
      if (queue) {
        const remaining = queue.filter((item) => !removedIds.has(item.subscriptionId));
        if (remaining.length) this.#queues.set(pluginId, remaining);
        else this.#queues.delete(pluginId);
      }
    }
  }

  subscriptionCount(pluginId?: string): number {
    if (pluginId !== undefined) {
      return this.#subscriptions.get(pluginId)?.size ?? 0;
    }
    let total = 0;
    for (const pluginSubs of this.#subscriptions.values()) {
      total += pluginSubs.size;
    }
    return total;
  }

  queuedCount(pluginId?: string): number {
    if (pluginId !== undefined) {
      return this.#queues.get(pluginId)?.length ?? 0;
    }
    let total = 0;
    for (const queue of this.#queues.values()) {
      total += queue.length;
    }
    return total;
  }

  dispatchEvent(event: { type: string; environmentId: string; at: string; payload: Record<string, unknown> }): void {
    if (!isPluginBusEventType(event.type)) return;
    if (this.#subscriptions.size === 0) return;

    const sanitized = sanitizeEvent({
      type: event.type,
      environmentId: event.environmentId,
      at: event.at,
      payload: event.payload,
    });

    for (const [pluginId, pluginSubs] of this.#subscriptions) {
      for (const entry of pluginSubs.values()) {
        if (entry.environmentId && entry.environmentId !== sanitized.environmentId) continue;
        if (entry.types && !entry.types.has(sanitized.type)) continue;
        this.#enqueue(pluginId, { subscriptionId: entry.subscriptionId, event: sanitized });
      }
    }
  }

  #enqueue(pluginId: string, delivery: QueuedDelivery): void {
    let queue = this.#queues.get(pluginId);
    if (!queue) {
      queue = [];
      this.#queues.set(pluginId, queue);
    }
    if (queue.length >= EVENT_BUS_MAX_QUEUE_PER_PLUGIN) {
      // 背压上限：超过 256 条时丢最老保最新
      queue.shift();
    }
    queue.push(delivery);
    this.#scheduleFlush(pluginId);
  }

  #scheduleFlush(pluginId: string): void {
    if (this.#scheduled.has(pluginId)) return;
    this.#scheduled.add(pluginId);
    queueMicrotask(() => this.#flush(pluginId));
  }

  #flush(pluginId: string): void {
    this.#scheduled.delete(pluginId);
    const pluginSubs = this.#subscriptions.get(pluginId);
    const queue = this.#queues.get(pluginId);
    if (!pluginSubs || !queue || queue.length === 0) {
      this.#queues.delete(pluginId);
      return;
    }

    const count = Math.min(queue.length, FLUSH_BATCH_SIZE);
    const batch = queue.splice(0, count);
    if (queue.length === 0) this.#queues.delete(pluginId);

    for (const item of batch) {
      if (!pluginSubs.has(item.subscriptionId)) continue;
      try {
        this.#deliver(pluginId, item.subscriptionId, item.event);
      } catch {
        // 单条事件投递异常不能阻断其它订阅或主进程事件循环
      }
    }

    const remaining = this.#queues.get(pluginId);
    if (remaining && remaining.length > 0 && !this.#scheduled.has(pluginId)) {
      this.#scheduled.add(pluginId);
      const timer = setTimeout(() => this.#flush(pluginId), 0);
      timer.unref();
    }
  }
}
