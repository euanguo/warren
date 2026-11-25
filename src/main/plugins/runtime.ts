/**
 * 插件的两种运行时。
 *
 * - `sandbox`：`vm.createContext` 里的能力插件。只有注入的 host API，没有 fs/进程/网络。
 * - `host`：`utilityProcess.fork` 起的独立 Node 进程。全权（fs / child_process / 依赖），
 *   host API 通过 JSON-RPC 代理回核心 —— **权限门控仍然在主进程这一侧**，
 *   子进程只是「有 Node 能力」，不是「有核心权限」。
 *
 * 两种运行时的插件入口形状相同：
 *   module.exports = { activate?(ctx), dispose?(ctx), rpc: { method(input, ctx) }, <command>(ctx) }
 */
import type { UtilityProcess } from 'electron';
import vm from 'node:vm';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PluginRuntimeAdapter {
  readonly kind: 'sandbox' | 'host';
  start(): Promise<void>;
  command(name: string, ctx: unknown): Promise<unknown>;
  rpc(method: string, input: unknown, ctx: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

/** 一次插件调用的上下文；host 运行时靠它把子进程的 host-call 关联回正确的调用。 */
export interface PluginInvocationContext {
  pluginId: string;
  environmentId?: string;
  leaseId?: string;
}

export interface RuntimeOptions {
  entryPath: string;
  pluginId: string;
  log: (level: LogLevel, message: string) => void;
  /** host 运行时：子进程发来的 host API 调用 */
  onHostCall?: (path: string, args: unknown[], context: PluginInvocationContext) => Promise<unknown>;
  bootstrapPath?: string;
}

/**
 * 单次插件调用（命令 / rpc / 生命周期钩子）的上限。
 *
 * `node:vm` 的 timeout **只覆盖模块求值**：插件里的 `await` 链完全不受它管，
 * 一个 `await new Promise(() => {})` 就能让 core 一直等下去——agent 那边看到的是 RPC 超时，
 * 而 core 自己也卡在这一轮里（这就是「sandbox 插件的异步执行无时限」那条边界）。
 *
 * **这不是强隔离**：超时只是把控制权还给调用方，插件那个 Promise 还在跑（vm 里没法取消）。
 * 要能真杀掉就用 `runtime: "host"`（独立进程）。
 */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

function callTimeoutMs(): number {
  const raw = Number(process.env.WARREN_PLUGIN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CALL_TIMEOUT_MS;
}

function timeoutError(pluginId: string, label: string, ms: number): Error {
  return Object.assign(new Error(`插件 ${pluginId} 的 ${label} 超过 ${ms}ms 没返回（PLUGIN_TIMEOUT）`), {
    code: 'PLUGIN_TIMEOUT',
  });
}

function serializeError(error: unknown): { message: string; code?: string } {
  const err = error as { message?: string; code?: string };
  return { message: err?.message ?? String(error), code: err?.code };
}

/**
 * 子进程里的引导脚本。
 *
 * 写成字符串落盘，而不是单独加一个 vite 构建目标 —— 它是纯 JS，没有依赖，
 * 没必要为它动打包配置。
 */
export const HOST_BOOTSTRAP = `import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';

let entry = null;
const pending = new Map();
let seq = 0;
const callContext = new AsyncLocalStorage();

const send = (message) => process.parentPort.postMessage(message);

function callHost(path, args) {
  const id = ++seq;
  // 带上当前 invoke 的 id，主进程才能把这次 host-call 放回正确的调用上下文。
  const parent = callContext.getStore()?.id;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: 'host-call', id, path, args, parent });
  });
}

/** host.storage.kv.get('a') → 路径 'storage.kv.get'，参数数组原样传回主进程 */
function makeHost(prefix) {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return makeHost(prefix ? prefix + '.' + prop : prop);
    },
    apply(_target, _this, args) {
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

process.parentPort.on('message', async (event) => {
  const message = event?.data;
  if (!message) return;

  if (message.t === 'host-result') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.value);
    else {
      const error = new Error(message.error?.message || 'host call failed');
      if (message.error?.code) error.code = message.error.code;
      waiting.reject(error);
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
      send({ t: 'ready', ok: false, error: { message: String(error?.message || error), code: error?.code } });
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
        const error = new Error('插件没有导出 ' + (message.kind === 'rpc' ? 'rpc 方法 ' : '命令 ') + message.name);
        error.code = 'PLUGIN_METHOD_NOT_FOUND';
        throw error;
      }
      const ctx = { host, ...(message.ctx || {}) };
      const value = await callContext.run(
        { id: message.id, environmentId: message.ctx?.environmentId },
        () => message.kind === 'rpc'
          ? handler.call(entry, message.input, ctx)
          : handler.call(entry, ctx),
      );
      send({ t: 'result', id: message.id, ok: true, value });
    } catch (error) {
      send({ t: 'result', id: message.id, ok: false, error: { message: String(error?.message || error), code: error?.code } });
    }
    return;
  }

  if (message.t === 'dispose') {
    try {
      if (typeof entry?.dispose === 'function') await entry.dispose(message.ctx);
    } catch (error) {
      send({ t: 'log', level: 'error', message: 'dispose 失败: ' + String(error?.message || error) });
    }
    process.exit(0);
  }
});
`;

export class SandboxRuntime implements PluginRuntimeAdapter {
  readonly kind = 'sandbox' as const;
  #entryPath: string;
  #code: string;
  #host: unknown;
  #pluginId: string;
  #log: RuntimeOptions['log'];
  #exports: Record<string, unknown> = {};
  #started = false;

  constructor(options: RuntimeOptions & { code: string; host: unknown }) {
    this.#entryPath = options.entryPath;
    this.#code = options.code;
    this.#host = options.host;
    this.#pluginId = options.pluginId;
    this.#log = options.log;
  }

  async start(): Promise<void> {
    const scopedConsole = {
      log: (...args: unknown[]) => this.#log('info', args.map(String).join(' ')),
      info: (...args: unknown[]) => this.#log('info', args.map(String).join(' ')),
      warn: (...args: unknown[]) => this.#log('warn', args.map(String).join(' ')),
      error: (...args: unknown[]) => this.#log('error', args.map(String).join(' ')),
      debug: (...args: unknown[]) => this.#log('debug', args.map(String).join(' ')),
    };
    const sandbox: Record<string, unknown> = {
      module: { exports: {} },
      host: this.#host,
      console: scopedConsole,
      setTimeout,
      clearTimeout,
      globalThis: undefined,
    };
    sandbox.exports = (sandbox.module as { exports: unknown }).exports;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // 超时只覆盖模块求值；插件的异步代码不在 vm 超时内（已知边界，见插件 README）
    vm.runInContext(this.#code, sandbox, { filename: this.#entryPath, timeout: 10_000 });
    this.#exports = (sandbox.module as { exports: Record<string, unknown> }).exports ?? {};
    this.#started = true;
    const activate = this.#exports.activate;
    if (typeof activate === 'function') {
      await this.#call(
        'activate',
        (activate as (ctx: unknown) => Promise<unknown>).call(this.#exports, this.#context()),
      );
    }
  }

  /**
   * 给一次调用套上限，超时记一条错误日志再抛。
   *
   * 记日志是必须的：超时之后插件那个 Promise 还在跑，可能稍后自己抛错——没有这条日志，
   * 排查时只能看到「agent 说插件超时了」。
   */
  async #call<T>(label: string, work: Promise<T>): Promise<T> {
    const ms = callTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeoutError(this.#pluginId, label, ms)), ms);
        }),
      ]);
    } catch (error) {
      if ((error as { code?: string }).code === 'PLUGIN_TIMEOUT') this.#log('error', (error as Error).message);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 每次调用都带上 host 与 pluginId，插件不用自己去别处捞 */
  #context(extra: object = {}): Record<string, unknown> {
    return { host: this.#host, pluginId: this.#pluginId, ...(extra as Record<string, unknown>) };
  }

  async command(name: string, ctx: unknown): Promise<unknown> {
    const handler = this.#exports[name];
    if (typeof handler !== 'function') {
      throw Object.assign(new Error(`插件没有导出命令 ${name}`), {
        code: 'PLUGIN_COMMAND_NOT_FOUND',
      });
    }
    return this.#call(
      `命令 ${name}`,
      (handler as (ctx: unknown) => Promise<unknown>).call(this.#exports, this.#context(ctx as object)),
    );
  }

  async rpc(method: string, input: unknown, ctx: unknown): Promise<unknown> {
    const table = this.#exports.rpc as Record<string, unknown> | undefined;
    const handler = table?.[method] ?? this.#exports[method];
    if (typeof handler !== 'function') {
      throw Object.assign(new Error(`插件没有导出 rpc 方法 ${method}`), {
        code: 'PLUGIN_RPC_NOT_FOUND',
      });
    }
    return this.#call(
      `rpc ${method}`,
      (handler as (input: unknown, ctx: unknown) => Promise<unknown>).call(
        this.#exports,
        input,
        this.#context(ctx as object),
      ),
    );
  }

  async dispose(): Promise<void> {
    if (!this.#started) return;
    const dispose = this.#exports.dispose;
    if (typeof dispose === 'function') {
      await this.#call('dispose', (dispose as (ctx: unknown) => Promise<unknown>).call(this.#exports, this.#context()));
    }
    this.#started = false;
  }
}

export class HostRuntime implements PluginRuntimeAdapter {
  readonly kind = 'host' as const;
  #entryPath: string;
  #bootstrapPath: string;
  #pluginId: string;
  #log: RuntimeOptions['log'];
  #onHostCall: (path: string, args: unknown[], context: PluginInvocationContext) => Promise<unknown>;
  #child?: UtilityProcess;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #invocations = new Map<number, PluginInvocationContext>();
  #seq = 0;

  constructor(
    options: RuntimeOptions & {
      onHostCall: (path: string, args: unknown[], context: PluginInvocationContext) => Promise<unknown>;
    },
  ) {
    this.#entryPath = options.entryPath;
    this.#bootstrapPath = options.bootstrapPath!;
    this.#pluginId = options.pluginId;
    this.#log = options.log;
    this.#onHostCall = options.onHostCall;
  }

  async start(): Promise<void> {
    // 懒加载：只有 host 运行时需要 electron，模块本身要能在纯 Node 下被单测加载
    const { utilityProcess } = await import('electron');
    const child = utilityProcess.fork(this.#bootstrapPath, [], {
      serviceName: `warren-plugin-${this.#pluginId}`,
      stdio: 'pipe',
    });
    this.#child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.#log('info', chunk.toString().trimEnd()));
    child.stderr?.on('data', (chunk: Buffer) => this.#log('error', chunk.toString().trimEnd()));
    child.on('message', (message: Record<string, unknown>) => void this.#handle(message));
    child.on('exit', (code) => {
      for (const [, waiting] of this.#pending) waiting.reject(new Error(`插件子进程退出（code ${code}）`));
      this.#pending.clear();
      this.#invocations.clear();
    });

    const ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    child.postMessage({ t: 'init', entry: this.#entryPath, ctx: this.#context() });
    const ms = callTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 子进程不报 ready 也不能把 core 等死（同 sandbox 那条上限）
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeoutError(this.#pluginId, '启动', ms)), ms);
        }),
      ]);
    } catch (error) {
      this.#log('error', (error as Error).message);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #readyResolve?: () => void;
  #readyReject?: (error: Error) => void;

  #context(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { pluginId: this.#pluginId, ...extra };
  }

  async #handle(message: Record<string, unknown>): Promise<void> {
    const type = message.t;
    if (type === 'ready') {
      if (message.ok) this.#readyResolve?.();
      else {
        const error = new Error((message.error as { message?: string })?.message ?? '插件子进程加载失败');
        this.#readyReject?.(error);
      }
      return;
    }
    if (type === 'log') {
      this.#log((message.level as LogLevel) ?? 'info', String(message.message ?? ''));
      return;
    }
    if (type === 'result') {
      const waiting = this.#pending.get(Number(message.id));
      if (!waiting) return;
      this.#pending.delete(Number(message.id));
      this.#invocations.delete(Number(message.id));
      if (message.ok) waiting.resolve(message.value);
      else
        waiting.reject(
          Object.assign(new Error((message.error as { message?: string })?.message ?? '调用失败'), {
            code: (message.error as { code?: string })?.code,
          }),
        );
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
    if (!child) return Promise.reject(new Error('插件子进程没有启动'));
    const id = ++this.#seq;
    const ms = callTimeoutMs();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时就把这一条摘掉：子进程之后回来的 result 找不到等待者，会被静默丢弃
        this.#pending.delete(id);
        this.#invocations.delete(id);
        const error = timeoutError(this.#pluginId, String(payload.name ?? payload.t ?? '调用'), ms);
        this.#log('error', error.message);
        reject(error);
      }, ms);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      /*
       * 命令的 ctx 由调用方给全（`input` / `environmentId` / `command` 都在里面），**原样带过去**；
       * rpc 的输入是独立参数，这里补进 ctx 让插件也能从 ctx.input 拿到。
       *
       * 以前两种都写成 `{ input: payload.input }`，命令那条路上 payload 里根本没有 input，
       * 于是 ctx 被整个覆盖成 `{pluginId, input: undefined}` —— host 运行时的命令**永远收不到
       * 参数和环境**（sandbox 那条路是对的，所以一直没暴露）。
       */
      const ctx: Record<string, unknown> = { ...(payload.ctx as Record<string, unknown>) };
      if (payload.kind === 'rpc') ctx.input = payload.input;
      const environmentId = typeof ctx.environmentId === 'string' ? ctx.environmentId : undefined;
      const leaseId = typeof ctx.leaseId === 'string' ? ctx.leaseId : undefined;
      this.#invocations.set(id, { pluginId: this.#pluginId, environmentId, leaseId });
      child.postMessage({ ...payload, id, ctx: this.#context(ctx) });
    });
  }

  async command(name: string, ctx: unknown): Promise<unknown> {
    return this.#invoke({ t: 'invoke', kind: 'command', name, ctx });
  }

  async rpc(method: string, input: unknown, ctx: unknown): Promise<unknown> {
    return this.#invoke({ t: 'invoke', kind: 'rpc', name: method, input, ctx });
  }

  async dispose(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    child.postMessage({ t: 'dispose', ctx: this.#context() });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已经退了
        }
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
