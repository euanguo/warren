/**
 * Whistle 插件后端共享常量、错误与实例存储/环境绑定 helper。
 */

export async function withSqlTx(host, fn) {
  await host.storage.sql.exec('BEGIN');
  try {
    const out = await fn();
    await host.storage.sql.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      await host.storage.sql.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

export const INSTANCES_KEY = 'instances';
export const DEFAULT_PORT_BASE = 8900;
/** 每个实例里放规则的文件名。一个实例一份规则，正是「一个 worktree 一套」。 */
export const RULE_NAME = 'warren';
export const PROBE_TIMEOUT_MS = 1500;
export const INSPECT_TIMEOUT_MS = 20000;
export const COMPOSE_TIMEOUT_MS = 30000;
export const STORAGE_RE = /^[a-z0-9][a-z0-9-]*$/;

export function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function notifyChanged(host, action, extra = {}) {
  if (host?.signal && typeof host.signal.publish === 'function') {
    try {
      await host.signal.publish('changed', { action, ...extra });
    } catch {}
  }
}

// ── 实例表（插件的 kv） ───────────────────────────────────────────────

export async function readInstances(host) {
  const raw = await host.storage.kv.get(INSTANCES_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item.storage === 'string' && typeof item.port === 'number');
}

export async function writeInstances(host, list) {
  await host.storage.kv.set(INSTANCES_KEY, list);
}

export async function requireInstance(host, storage) {
  const name = String(storage || '').trim();
  if (!name) fail('BAD_REQUEST', '需要 storage（实例名）');
  const instance = (await readInstances(host)).find((item) => item.storage === name);
  if (!instance) fail('WHISTLE_INSTANCE_UNKNOWN', `没有登记过叫 ${name} 的实例`);
  return instance;
}

// ── 实例视图 ─────────────────────────────────────────────────────────

/** 环境绑的就是「proxy 指向这个实例端口」，所以绑定关系不用另存一份状态。 */
export function envBoundTo(environments, port) {
  return environments.find((env) => typeof env.proxy === 'string' && loopbackPortOf(env.proxy) === port);
}

export function loopbackPortOf(proxy) {
  try {
    const url = new URL(proxy);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return undefined;
    return Number(url.port) || undefined;
  } catch {
    return undefined;
  }
}
