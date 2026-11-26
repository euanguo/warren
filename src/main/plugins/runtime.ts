/**
 * 插件的两种运行时（统一跑在可强杀的子进程边界内）。
 *
 * - `sandbox`：独立子进程内的受限 `vm.createContext` 能力插件。只有 JSON-RPC `host` Proxy、
 *   `log`、`events` 订阅回调及安全純 JS 辅助，没有 `require`/`process`/`fs`/`child_process`/`Buffer`/`fetch`/`setImmediate`。
 * - `host`：独立子进程内的全权 Node 插件。能直接用 fs / child_process / 第三方依赖，
 *   host API 仍然通过 JSON-RPC 代理回主进程 —— **权限门控在主进程这一侧**。
 *
 * 超时（`PLUGIN_TIMEOUT`）或 `dispose()` 超限都会强制 `child.kill()` 杀掉底层子进程；
 * 异常退出时对在途调用 fail-fast，标记 `crashed` 状态并触发 `onCrash`。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { forkWorkerProcess, type WorkerProcess } from './worker-process.ts';
import type { PluginRpcCaller } from '../../shared/types.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PluginCrashInfo {
  code: number | null;
  reason: 'timeout' | 'exit';
  message: string;
}

export interface PluginRuntimeAdapter {
  readonly kind: 'sandbox' | 'host';
  readonly pid?: number;
  readonly crashed?: boolean;
  start(): Promise<void>;
  command(name: string, ctx: unknown): Promise<unknown>;
  rpc(method: string, input: unknown, ctx: unknown): Promise<unknown>;
  notifyEvent?(subscriptionId: string, event: unknown): void;
  dispose(): Promise<void>;
}

/** 一次插件调用的上下文；运行时靠它把子进程的 host-call 关联回正确的调用。 */
export interface PluginInvocationContext {
  pluginId: string;
  environmentId?: string;
  leaseId?: string;
  /** 权威调用方（由主进程在派发时登记，子进程不可伪造）。 */
  caller?: PluginRpcCaller;
}

export interface RuntimeOptions {
  entryPath: string;
  pluginId: string;
  log: (level: LogLevel, message: string) => void;
  /** 子进程发来的 host API 调用 */
  onHostCall?: (path: string, args: unknown[], context: PluginInvocationContext) => Promise<unknown>;
  /** 兼容测试直接传内存 host 对象 */
  host?: unknown;
  bootstrapPath?: string;
  /** 子进程异常退出或超时强杀后的回调 */
  onCrash?: (info: PluginCrashInfo) => void;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DISPOSE_GRACE_MAX_MS = 1500;
const KILL_REAP_WAIT_MS = 500;

function callTimeoutMs(): number {
  const raw = Number(process.env.WARREN_PLUGIN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CALL_TIMEOUT_MS;
}

function timeoutError(pluginId: string, label: string, ms: number): Error {
  return Object.assign(new Error(`插件 ${pluginId} 的 ${label} 超过 ${ms}ms 没返回（PLUGIN_TIMEOUT）`), {
    code: 'PLUGIN_TIMEOUT',
  });
}

function serializeError(error: unknown): { message: string; code?: string; name?: string } {
  const err = error as { message?: string; code?: string; name?: string };
  return {
    message: err?.message ?? String(error),
    ...(typeof err?.code === 'string' ? { code: err.code } : {}),
    ...(typeof err?.name === 'string' ? { name: err.name } : {}),
  };
}

function reconstructError(
  payload: { message?: string; code?: string; name?: string } | undefined,
  fallback: string,
): Error {
  const error = new Error(payload?.message ?? fallback);
  if (payload?.code) (error as Error & { code?: string }).code = payload.code;
  if (payload?.name) error.name = payload.name;
  return error;
}

/** 按点路径从内存 host 对象解析并调用方法（未传 onHostCall 时使用）。 */
function resolveHostMethod(
  host: unknown,
  callPath: string,
): { target: unknown; fn: (...args: unknown[]) => unknown } | null {
  const parts = callPath.split('.');
  let parent: unknown = undefined;
  let current: unknown = host;
  for (const part of parts) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) return null;
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return null;
    parent = current;
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== 'function') return null;
  return { target: parent, fn: current as (...args: unknown[]) => unknown };
}

/** 共用子进程 IPC 引导段（同时支持 Electron utilityProcess.parentPort 与 Node IPC）。 */
const WORKER_IPC_SHIM = `
const UNDEF_MARKER = '__warren_undef__';

function encodeIpc(value) {
  if (value === undefined) return { [UNDEF_MARKER]: true };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(encodeIpc);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = encodeIpc(item);
  return out;
}

function decodeIpc(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeIpc);
  if (Object.prototype.hasOwnProperty.call(value, UNDEF_MARKER) && Object.keys(value).length === 1) return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = decodeIpc(item);
  return out;
}

const send = process.parentPort
  ? (message) => process.parentPort.postMessage(message)
  : (message) => {
      if (typeof process.send === 'function') process.send(encodeIpc(message));
    };

const onMessage = (handler) => {
  if (process.parentPort) {
    process.parentPort.on('message', (event) => handler(event?.data));
  } else {
    process.on('message', (message) => handler(decodeIpc(message)));
  }
};

function serializeWorkerError(error) {
  if (error && typeof error === 'object') {
    return {
      message: typeof error.message === 'string' ? error.message : String(error),
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(typeof error.name === 'string' ? { name: error.name } : {}),
    };
  }
  return { message: String(error ?? '未知错误') };
}
`;

/**
 * 全权 `host` 运行时引导脚本。
 */
export const HOST_BOOTSTRAP = `import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
${WORKER_IPC_SHIM}
let entry = null;
const pending = new Map();
const eventListeners = new Map();
let seq = 0;
const callContext = new AsyncLocalStorage();

function callHost(path, args) {
  const id = ++seq;
  // 带上当前 invoke 的 id，主进程才能把这次 host-call 放回正确的调用上下文。
  const parent = callContext.getStore()?.id;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: 'host-call', id, path, args, parent });
  });
}

async function subscribeEvents(filter, handler) {
  if (typeof handler !== 'function') {
    const error = new Error('events.subscribe 需要回调函数');
    error.code = 'PLUGIN_BAD_REQUEST';
    throw error;
  }
  const result = await callHost('events.subscribe', [filter ?? {}]);
  const subscriptionId = result && result.subscriptionId ? String(result.subscriptionId) : String(result);
  eventListeners.set(subscriptionId, handler);
  let unsubscribed = false;
  return async function unsubscribe() {
    if (unsubscribed) return;
    unsubscribed = true;
    eventListeners.delete(subscriptionId);
    await callHost('events.unsubscribe', [subscriptionId]);
  };
}

/** host.storage.kv.get('a') → 路径 'storage.kv.get'，参数数组原样传回主进程 */
function makeHost(prefix) {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return makeHost(prefix ? prefix + '.' + prop : prop);
    },
    apply(_target, _this, args) {
      if (prefix === 'events.subscribe') return subscribeEvents(args[0], args[1]);
      return callHost(prefix, args);
    },
  });
}

const host = makeHost('');
const writeLog = (level) => (...args) => send({ t: 'log', level, message: args.map(String).join(' ') });

globalThis.host = host;
globalThis.log = { debug: writeLog('debug'), info: writeLog('info'), warn: writeLog('warn'), error: writeLog('error') };

async function loadEntry(entryPath) {
  const module = await import(pathToFileURL(entryPath).href);
  return module.default ?? module;
}

onMessage(async (message) => {
  if (!message) return;

  if (message.t === 'host-result') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.value);
    else {
      const error = new Error(message.error?.message || 'host call failed');
      if (message.error?.code) error.code = message.error.code;
      if (message.error?.name) error.name = message.error.name;
      waiting.reject(error);
    }
    return;
  }

  if (message.t === 'event') {
    const listener = eventListeners.get(message.subscriptionId);
    if (typeof listener === 'function') {
      Promise.resolve()
        .then(() => listener(message.event))
        .catch((error) => {
          send({ t: 'log', level: 'error', message: '事件处理器失败: ' + String(error?.message || error) });
        });
    }
    return;
  }

  if (message.t === 'init') {
    try {
      entry = await loadEntry(message.entry);
      if (typeof entry?.activate === 'function') {
        await callContext.run(
          { id: 'activate', environmentId: message.ctx?.environmentId },
          () => entry.activate({ host, ...(message.ctx || {}) }),
        );
      }
      send({ t: 'ready', ok: true });
    } catch (error) {
      send({ t: 'ready', ok: false, error: serializeWorkerError(error) });
    }
    return;
  }

  if (message.t === 'invoke') {
    try {
      const handler =
        message.kind === 'rpc'
          ? entry?.rpc?.[message.name] ?? entry?.[message.name]
          : entry?.[message.name];
      if (typeof handler !== 'function') {
        const code = message.kind === 'rpc' ? 'PLUGIN_RPC_NOT_FOUND' : 'PLUGIN_COMMAND_NOT_FOUND';
        const error = new Error('插件没有导出 ' + (message.kind === 'rpc' ? 'rpc 方法 ' : '命令 ') + message.name);
        error.code = code;
        throw error;
      }
      const ctx = { host, ...(message.ctx || {}) };
      const value = await callContext.run(
        { id: message.id, environmentId: message.ctx?.environmentId },
        () => (message.kind === 'rpc' ? handler.call(entry, message.input, ctx) : handler.call(entry, ctx)),
      );
      send({ t: 'result', id: message.id, ok: true, value });
    } catch (error) {
      send({ t: 'result', id: message.id, ok: false, error: serializeWorkerError(error) });
    }
    return;
  }

  if (message.t === 'dispose') {
    try {
      if (typeof entry?.dispose === 'function') await entry.dispose({ host, ...(message.ctx || {}) });
    } catch (error) {
      send({ t: 'log', level: 'error', message: 'dispose 失败: ' + String(error?.message || error) });
    }
    process.exit(0);
  }
});
`;

/**
 * 受限 `sandbox` 运行时引导脚本（独立子进程内的 `vm.createContext`）。
 *
 * 绝对禁止向 VM 上下文暴露 require / process / fs / child_process / Buffer / 原生 fetch / setImmediate。
 */
export const SANDBOX_BOOTSTRAP = `import { AsyncLocalStorage } from 'node:async_hooks';
import nodeCrypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
${WORKER_IPC_SHIM}
let entry = null;
let syncMaskHint = true;
const pending = new Map();
const eventListeners = new Map();
let seq = 0;
const callContext = new AsyncLocalStorage();

function maskHint(username) {
  const text = typeof username === 'string' ? username : String(username ?? '');
  if (!text) return '';
  const [local, domain] = text.split('@');
  if (domain) return local.slice(0, 1) + '***@' + domain;
  return text.slice(0, 1) + '***';
}

/** 跨 vm realm 对象规范化：转成宿主 realm 的纯值，避免 Promise/Error/原型跨界丢失或克隆失败。 */
function normalizeIpcValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      const error = new Error('插件返回值里有非法数字');
      error.code = 'PLUGIN_RPC_NON_JSON';
      throw error;
    }
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    const error = new Error('插件返回值里有 ' + typeof value + '，不能跨进程传递');
    error.code = 'PLUGIN_RPC_NON_JSON';
    throw error;
  }
  if (depth > 64) {
    const error = new Error('插件返回值嵌套过深');
    error.code = 'PLUGIN_RPC_NON_JSON';
    throw error;
  }
  const object = value;
  if (seen.has(object)) {
    const error = new Error('插件返回值里有循环引用');
    error.code = 'PLUGIN_RPC_NON_JSON';
    throw error;
  }
  seen.add(object);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeIpcValue(item, depth + 1, seen));
  }
  if (typeof value.then === 'function') {
    const error = new Error('插件返回值里有未解出的 Promise');
    error.code = 'PLUGIN_RPC_NON_JSON';
    throw error;
  }
  const proto = Object.getPrototypeOf(object);
  const ctorName = proto === null ? 'Object' : proto.constructor?.name;
  if (ctorName !== 'Object') {
    const error = new Error('插件返回值里有 ' + (ctorName ?? '未知类型') + ' 实例，不能跨进程传递');
    error.code = 'PLUGIN_RPC_NON_JSON';
    throw error;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = normalizeIpcValue(item, depth + 1, seen);
  }
  return out;
}

function callHost(path, args) {
  const id = ++seq;
  const parent = callContext.getStore()?.id;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: 'host-call', id, path, args, parent });
  });
}

async function subscribeEvents(filter, handler) {
  if (typeof handler !== 'function') {
    const error = new Error('events.subscribe 需要回调函数');
    error.code = 'PLUGIN_BAD_REQUEST';
    throw error;
  }
  const normalizedFilter = normalizeIpcValue(filter ?? {});
  const result = await callHost('events.subscribe', [normalizedFilter]);
  const subscriptionId = result && result.subscriptionId ? String(result.subscriptionId) : String(result);
  eventListeners.set(subscriptionId, handler);
  let unsubscribed = false;
  return async function unsubscribe() {
    if (unsubscribed) return;
    unsubscribed = true;
    eventListeners.delete(subscriptionId);
    await callHost('events.unsubscribe', [subscriptionId]);
  };
}

function makeHost(prefix) {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return makeHost(prefix ? prefix + '.' + prop : prop);
    },
    apply(_target, _this, args) {
      if (prefix === 'vault.maskHint' && syncMaskHint) {
        return maskHint(args[0]);
      }
      if (prefix === 'events.subscribe') {
        return subscribeEvents(args[0], args[1]);
      }
      return callHost(prefix, args.map((item) => normalizeIpcValue(item)));
    },
  });
}

const host = makeHost('');
const writeLog = (level) => (...args) => send({ t: 'log', level, message: args.map(String).join(' ') });
const scopedConsole = {
  log: writeLog('info'),
  info: writeLog('info'),
  warn: writeLog('warn'),
  error: writeLog('error'),
  debug: writeLog('debug'),
};
const scopedLog = {
  debug: writeLog('debug'),
  info: writeLog('info'),
  warn: writeLog('warn'),
  error: writeLog('error'),
};
const safeCrypto = {
  randomUUID: () => nodeCrypto.randomUUID(),
  getRandomValues: (array) => nodeCrypto.getRandomValues(array),
};

onMessage(async (message) => {
  if (!message) return;

  if (message.t === 'host-result') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.value);
    else {
      const error = new Error(message.error?.message || 'host call failed');
      if (message.error?.code) error.code = message.error.code;
      if (message.error?.name) error.name = message.error.name;
      waiting.reject(error);
    }
    return;
  }

  if (message.t === 'event') {
    const listener = eventListeners.get(message.subscriptionId);
    if (typeof listener === 'function') {
      Promise.resolve()
        .then(() => listener(message.event))
        .catch((error) => {
          send({ t: 'log', level: 'error', message: '事件处理器失败: ' + String(error?.message || error) });
        });
    }
    return;
  }

  if (message.t === 'init') {
    try {
      syncMaskHint = message.syncMaskHint !== false;
      const source = typeof message.code === 'string' ? message.code : await readFile(message.entry, 'utf8');
      const sandbox = {
        module: { exports: {} },
        exports: undefined,
        host,
        log: scopedLog,
        console: scopedConsole,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        queueMicrotask,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        crypto: safeCrypto,
        globalThis: undefined,
      };
      sandbox.exports = sandbox.module.exports;
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(source, sandbox, { filename: message.entry, timeout: 10_000 });
      entry = sandbox.module?.exports ?? {};
      if (typeof entry?.activate === 'function') {
        await callContext.run(
          { id: 'activate', environmentId: message.ctx?.environmentId },
          () => entry.activate({ host, ...(message.ctx || {}) }),
        );
      }
      send({ t: 'ready', ok: true });
    } catch (error) {
      send({ t: 'ready', ok: false, error: serializeWorkerError(error) });
    }
    return;
  }

  if (message.t === 'invoke') {
    try {
      const handler =
        message.kind === 'rpc'
          ? entry?.rpc?.[message.name] ?? entry?.[message.name]
          : entry?.[message.name];
      if (typeof handler !== 'function') {
        const code = message.kind === 'rpc' ? 'PLUGIN_RPC_NOT_FOUND' : 'PLUGIN_COMMAND_NOT_FOUND';
        const error = new Error('插件没有导出 ' + (message.kind === 'rpc' ? 'rpc 方法 ' : '命令 ') + message.name);
        error.code = code;
        throw error;
      }
      const ctx = { host, ...(message.ctx || {}) };
      const raw = await callContext.run(
        { id: message.id, environmentId: message.ctx?.environmentId },
        () => (message.kind === 'rpc' ? handler.call(entry, message.input, ctx) : handler.call(entry, ctx)),
      );
      const value = raw === undefined ? undefined : normalizeIpcValue(raw);
      send({ t: 'result', id: message.id, ok: true, value });
    } catch (error) {
      send({ t: 'result', id: message.id, ok: false, error: serializeWorkerError(error) });
    }
    return;
  }

  if (message.t === 'dispose') {
    try {
      if (typeof entry?.dispose === 'function') {
        await entry.dispose({ host, ...(message.ctx || {}) });
      }
    } catch (error) {
      send({ t: 'log', level: 'error', message: 'dispose 失败: ' + String(error?.message || error) });
    }
    process.exit(0);
  }
});
`;

abstract class BaseWorkerRuntime implements PluginRuntimeAdapter {
  abstract readonly kind: 'sandbox' | 'host';

  #entryPath: string;
  #bootstrapPath?: string;
  #ownedBootstrapDir?: string;
  #pluginId: string;
  #log: RuntimeOptions['log'];
  #onHostCall: (path: string, args: unknown[], context: PluginInvocationContext) => Promise<unknown>;
  #onCrash?: (info: PluginCrashInfo) => void;
  #child?: WorkerProcess;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #invocations = new Map<number, PluginInvocationContext>();
  #seq = 0;
  #readyResolve?: () => void;
  #readyReject?: (error: Error) => void;
  #started = false;
  #disposing = false;
  #exited = false;
  #crashed = false;
  #crashNotified = false;
  #suppressCrashCallback = false;

  constructor(options: RuntimeOptions) {
    this.#entryPath = options.entryPath;
    this.#bootstrapPath = options.bootstrapPath;
    this.#pluginId = options.pluginId;
    this.#log = options.log;
    this.#onCrash = options.onCrash;
    this.#onHostCall =
      options.onHostCall ??
      (async (callPath, args) => {
        if (!options.host) {
          throw Object.assign(new Error(`未知的 host API: ${callPath}`), { code: 'PLUGIN_HOST_API_UNKNOWN' });
        }
        const resolved = resolveHostMethod(options.host, callPath);
        if (!resolved) {
          throw Object.assign(new Error(`未知的 host API: ${callPath}`), { code: 'PLUGIN_HOST_API_UNKNOWN' });
        }
        return resolved.fn.apply(resolved.target, args);
      });
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get crashed(): boolean {
    return this.#crashed;
  }

  protected get entryPath(): string {
    return this.#entryPath;
  }

  protected abstract bootstrapSource(): string;

  protected abstract bootstrapFilename(): string;

  protected abstract buildInitPayload(): Promise<Record<string, unknown>>;

  async #resolveBootstrap(): Promise<string> {
    if (this.#bootstrapPath) return this.#bootstrapPath;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'warren-plugin-worker-'));
    this.#ownedBootstrapDir = dir;
    const file = path.join(dir, this.bootstrapFilename());
    await writeFile(file, this.bootstrapSource(), 'utf8');
    return file;
  }

  async #cleanupOwnedBootstrap(): Promise<void> {
    const dir = this.#ownedBootstrapDir;
    this.#ownedBootstrapDir = undefined;
    if (!dir) return;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  async start(): Promise<void> {
    this.#exited = false;
    this.#disposing = false;
    this.#crashed = false;
    this.#crashNotified = false;
    this.#suppressCrashCallback = false;

    const bootstrap = await this.#resolveBootstrap();
    let initPayload: Record<string, unknown>;
    try {
      initPayload = await this.buildInitPayload();
    } catch (error) {
      await this.#cleanupOwnedBootstrap();
      throw error;
    }

    const child = await forkWorkerProcess(bootstrap, {
      serviceName: `warren-plugin-${this.#pluginId}`,
    });
    this.#child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.#log('info', chunk.toString().trimEnd()));
    child.stderr?.on('data', (chunk: Buffer) => this.#log('error', chunk.toString().trimEnd()));
    child.on('message', (message) => {
      if (message && typeof message === 'object') {
        void this.#handle(message as Record<string, unknown>);
      }
    });
    child.on('exit', (code) => {
      this.#handleExit(code, 'exit');
    });

    const ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    child.postMessage({ t: 'init', ...initPayload, ctx: this.#context() });

    const ms = callTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(timeoutError(this.#pluginId, '启动', ms));
          }, ms);
        }),
      ]);
      this.#started = true;
    } catch (error) {
      this.#log('error', (error as Error).message);
      if (timedOut) {
        this.#suppressCrashCallback = true;
        this.#crashed = true;
        await this.#killAndWait(child);
      } else {
        await this.dispose();
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.#readyResolve = undefined;
      this.#readyReject = undefined;
    }
  }

  #handleExit(code: number | null, reason: 'timeout' | 'exit'): void {
    this.#exited = true;
    this.#child = undefined;
    const wasStarted = this.#started;
    this.#started = false;

    const exitError = Object.assign(new Error(`插件 ${this.#pluginId} 子进程退出（code ${code ?? 'killed'}）`), {
      code: 'PLUGIN_CRASHED',
    });

    if (this.#readyReject) {
      const reject = this.#readyReject;
      this.#readyResolve = undefined;
      this.#readyReject = undefined;
      reject(exitError);
    }

    for (const [, waiting] of this.#pending) {
      waiting.reject(exitError);
    }
    this.#pending.clear();
    this.#invocations.clear();
    void this.#cleanupOwnedBootstrap();

    if (!this.#disposing && !this.#suppressCrashCallback && wasStarted) {
      this.#crashed = true;
      if (!this.#crashNotified) {
        this.#crashNotified = true;
        this.#onCrash?.({
          code,
          reason,
          message: exitError.message,
        });
      }
    }
  }

  async #killAndWait(child: WorkerProcess): Promise<void> {
    if (this.#exited) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', done);
      const guard = setTimeout(done, KILL_REAP_WAIT_MS);
      guard.unref();
      child.kill();
    });
  }

  #context(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { pluginId: this.#pluginId, ...extra };
  }

  async #handle(message: Record<string, unknown>): Promise<void> {
    const type = message.t;
    if (type === 'ready') {
      if (message.ok) {
        this.#readyResolve?.();
      } else {
        const error = reconstructError(
          message.error as { message?: string; code?: string; name?: string } | undefined,
          '插件子进程加载失败',
        );
        this.#readyReject?.(error);
      }
      return;
    }
    if (type === 'log') {
      this.#log((message.level as LogLevel) ?? 'info', String(message.message ?? ''));
      return;
    }
    if (type === 'result') {
      const id = Number(message.id);
      const waiting = this.#pending.get(id);
      if (!waiting) return;
      this.#pending.delete(id);
      this.#invocations.delete(id);
      if (message.ok) waiting.resolve(message.value);
      else {
        waiting.reject(
          reconstructError(message.error as { message?: string; code?: string; name?: string } | undefined, '调用失败'),
        );
      }
      return;
    }
    if (type === 'host-call') {
      const id = Number(message.id);
      const parent = Number(message.parent);
      const context = this.#invocations.get(parent) ?? { pluginId: this.#pluginId };
      try {
        const value = await this.#onHostCall(String(message.path), (message.args as unknown[]) ?? [], context);
        this.#child?.postMessage({ t: 'host-result', id, ok: true, value });
      } catch (error) {
        this.#child?.postMessage({ t: 'host-result', id, ok: false, error: serializeError(error) });
      }
    }
  }

  #invoke(payload: Record<string, unknown>): Promise<unknown> {
    const child = this.#child;
    if (!child || this.#exited || !this.#started) {
      return Promise.reject(
        Object.assign(new Error(this.#crashed ? `插件 ${this.#pluginId} 子进程已崩溃` : '插件子进程没有启动'), {
          code: this.#crashed ? 'PLUGIN_CRASHED' : 'PLUGIN_NOT_ACTIVE',
        }),
      );
    }
    const id = ++this.#seq;
    const ms = callTimeoutMs();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#pending.delete(id);
        this.#invocations.delete(id);
        const label =
          payload.kind === 'rpc'
            ? `rpc ${String(payload.name ?? '')}`
            : `命令 ${String(payload.name ?? payload.t ?? '调用')}`;
        const error = timeoutError(this.#pluginId, label, ms);
        this.#log('error', error.message);
        this.#crashed = true;
        this.#suppressCrashCallback = true;
        void this.#killAndWait(child).finally(() => {
          if (!this.#crashNotified) {
            this.#crashNotified = true;
            this.#onCrash?.({ code: null, reason: 'timeout', message: error.message });
          }
          reject(error);
        });
      }, ms);

      this.#pending.set(id, {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      });

      const ctx: Record<string, unknown> = { ...(payload.ctx as Record<string, unknown> | undefined) };
      if (payload.kind === 'rpc') ctx.input = payload.input;
      const environmentId = typeof ctx.environmentId === 'string' ? ctx.environmentId : undefined;
      const leaseId = typeof ctx.leaseId === 'string' ? ctx.leaseId : undefined;
      const caller: PluginRpcCaller = ctx.caller === 'ui' ? 'ui' : 'agent';
      this.#invocations.set(id, { pluginId: this.#pluginId, environmentId, leaseId, caller });
      child.postMessage({ ...payload, id, ctx: this.#context(ctx) });
    });
  }

  async command(name: string, ctx: unknown): Promise<unknown> {
    return this.#invoke({ t: 'invoke', kind: 'command', name, ctx });
  }

  async rpc(method: string, input: unknown, ctx: unknown): Promise<unknown> {
    return this.#invoke({ t: 'invoke', kind: 'rpc', name: method, input, ctx });
  }

  notifyEvent(subscriptionId: string, event: unknown): void {
    const child = this.#child;
    if (!child || this.#exited || !this.#started || this.#disposing) return;
    child.postMessage({ t: 'event', subscriptionId, event });
  }

  async dispose(): Promise<void> {
    this.#disposing = true;
    this.#started = false;
    const child = this.#child;
    if (child && !this.#exited) {
      const disposeMs = Math.min(DISPOSE_GRACE_MAX_MS, Math.max(200, callTimeoutMs()));
      child.postMessage({ t: 'dispose', ctx: this.#context() });
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(() => {
          void this.#killAndWait(child).finally(done);
        }, disposeMs);
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    this.#child = undefined;
    await this.#cleanupOwnedBootstrap();
  }
}

export class SandboxRuntime extends BaseWorkerRuntime {
  readonly kind = 'sandbox' as const;
  #code?: string;

  constructor(options: RuntimeOptions & { code?: string }) {
    super(options);
    this.#code = options.code;
  }

  protected bootstrapSource(): string {
    return SANDBOX_BOOTSTRAP;
  }

  protected bootstrapFilename(): string {
    return 'sandbox-bootstrap.mjs';
  }

  protected async buildInitPayload(): Promise<Record<string, unknown>> {
    const code = this.#code ?? (await readFile(this.entryPath, 'utf8'));
    return {
      entry: this.entryPath,
      code,
      syncMaskHint: true,
    };
  }
}

export class HostRuntime extends BaseWorkerRuntime {
  readonly kind = 'host' as const;

  protected bootstrapSource(): string {
    return HOST_BOOTSTRAP;
  }

  protected bootstrapFilename(): string {
    return 'host-bootstrap.mjs';
  }

  protected async buildInitPayload(): Promise<Record<string, unknown>> {
    return {
      entry: this.entryPath,
    };
  }
}
