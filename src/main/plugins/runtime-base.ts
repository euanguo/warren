/**
 * 插件子进程运行时基类与共享 IPC 通信骨架（供 `runtime-host.ts` 与 `runtime-sandbox.ts` 复用）。
 * 统一封装 `init` / `invoke` / `host-call` / `host-result` / `event` / `dispose` 消息协议、
 * 超时强杀、崩溃Fail-Fast与错误序列化还原。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PluginRpcCaller } from '../../shared/types.ts';
import { buildSandboxEnv, forkWorkerProcess, type WorkerProcess } from './worker-process.ts';

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

export function callTimeoutMs(): number {
  const raw = Number(process.env.WARREN_PLUGIN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CALL_TIMEOUT_MS;
}

export function timeoutError(pluginId: string, label: string, ms: number): Error {
  return Object.assign(new Error(`插件 ${pluginId} 的 ${label} 超过 ${ms}ms 没返回（PLUGIN_TIMEOUT）`), {
    code: 'PLUGIN_TIMEOUT',
  });
}

export function serializeError(error: unknown): { message: string; code?: string; name?: string } {
  const err = error as { message?: string; code?: string; name?: string };
  return {
    message: err?.message ?? String(error),
    ...(typeof err?.code === 'string' ? { code: err.code } : {}),
    ...(typeof err?.name === 'string' ? { name: err.name } : {}),
  };
}

export function reconstructError(
  payload: { message?: string; code?: string; name?: string } | undefined,
  fallback: string,
): Error {
  const error = new Error(payload?.message ?? fallback);
  if (payload?.code) (error as Error & { code?: string }).code = payload.code;
  if (payload?.name) error.name = payload.name;
  return error;
}

/** 按点路径从内存 host 对象解析并调用方法（未传 onHostCall 时使用）。 */
export function resolveHostMethod(
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
    process.parentPort.on('close', () => process.exit(0));
  } else {
    process.on('message', (message) => handler(decodeIpc(message)));
    process.on('disconnect', () => process.exit(0));
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

export interface WorkerBootstrapSpec {
  imports: string;
  preamble?: string;
  normalizeArgExpr?: string;
  normalizeFilterExpr?: string;
  normalizeResultExpr?: string;
  specialHostCallExpr?: string;
  extraGlobalsExpr?: string;
  loadEntryBody: string;
}

/**
 * 构建 `host` 与 `sandbox` 共用的 Worker 引导脚本，避免两份 bootstrap 重复实现消息分发与 host Proxy。
 */
export function buildWorkerBootstrap(spec: WorkerBootstrapSpec): string {
  const normArg = spec.normalizeArgExpr ?? '((v) => v)';
  const normFilter = spec.normalizeFilterExpr ?? '((v) => v)';
  const normResult = spec.normalizeResultExpr ?? '((v) => v)';
  return `import { AsyncLocalStorage } from 'node:async_hooks';
${spec.imports}
${WORKER_IPC_SHIM}
${spec.preamble ?? ''}
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
  const normalizedFilter = (${normFilter})(filter ?? {});
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

/** host.storage.kv.get('a') → 路径 'storage.kv.get'，参数数组按策略规范化传回主进程 */
function makeHost(prefix) {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return makeHost(prefix ? prefix + '.' + prop : prop);
    },
    apply(_target, _this, args) {
      ${spec.specialHostCallExpr ?? ''}
      if (prefix === 'events.subscribe') return subscribeEvents(args[0], args[1]);
      return callHost(prefix, args.map(${normArg}));
    },
  });
}

const host = makeHost('');
const writeLog = (level) => (...args) => send({ t: 'log', level, message: args.map(String).join(' ') });
${spec.extraGlobalsExpr ?? ''}

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
      const subId = 'event:' + String(message.subscriptionId);
      callContext
        .run({ id: subId, environmentId: message.event?.environmentId }, () =>
          Promise.resolve().then(() => listener(message.event)),
        )
        .catch((error) => {
          send({ t: 'log', level: 'error', message: '事件处理器失败: ' + String(error?.message || error) });
        });
    }
    return;
  }

  if (message.t === 'init') {
    try {
      ${spec.loadEntryBody}
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
      const value = raw === undefined ? undefined : (${normResult})(raw);
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
}

export abstract class BaseWorkerRuntime implements PluginRuntimeAdapter {
  abstract readonly kind: 'sandbox' | 'host';

  #entryPath: string;
  #bootstrapPath?: string;
  #ownedBootstrapDir?: string;
  #pluginId: string;
  #log: RuntimeOptions['log'];
  #onHostCall: (path: string, args: unknown[], context: PluginInvocationContext) => Promise<unknown>;
  #onCrash?: (info: PluginCrashInfo) => void;
  #child?: WorkerProcess;
  #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #invocations = new Map<string | number, PluginInvocationContext>();
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
      env: this.kind === 'sandbox' ? buildSandboxEnv(process.env) : undefined,
      detached: this.kind === 'host',
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
    // activate 属于系统冷启动阶段，禁止持有 ui 特权（防插件在启动期调用仅限界面的通道）
    this.#invocations.set('activate', { pluginId: this.#pluginId, caller: 'agent' });
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
      this.#invocations.delete('activate');
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
      const id = String(message.id);
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
      const rawParent = message.parent;
      const parent = typeof rawParent === 'number' || typeof rawParent === 'string' ? rawParent : '';
      const context = this.#invocations.get(parent) ?? { pluginId: this.#pluginId, caller: 'agent' as const };
      try {
        const callPath = String(message.path);
        const args = (message.args as unknown[]) ?? [];
        const value = await this.#onHostCall(callPath, args, context);
        if (callPath === 'events.subscribe' && value && typeof value === 'object' && 'subscriptionId' in value) {
          const subId = String((value as { subscriptionId: unknown }).subscriptionId);
          this.#invocations.set(`event:${subId}`, {
            pluginId: this.#pluginId,
            caller: context.caller,
          });
        } else if (callPath === 'events.unsubscribe' && args[0] !== undefined) {
          this.#invocations.delete(`event:${String(args[0])}`);
        }
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
    const id = crypto.randomUUID();
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

  command(name: string, ctx: unknown): Promise<unknown> {
    return this.#invoke({ t: 'invoke', kind: 'command', name, ctx });
  }

  rpc(method: string, input: unknown, ctx: unknown): Promise<unknown> {
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
