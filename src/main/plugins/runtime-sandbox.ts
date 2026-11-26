/**
 * 受限 `sandbox` 插件运行时（独立子进程内的 `vm.createContext`）。
 * 绝对禁止向 VM 上下文暴露 require / process / fs / child_process / Buffer / 原生 fetch / setImmediate。
 */
import { readFile } from 'node:fs/promises';
import { BaseWorkerRuntime, buildWorkerBootstrap, type RuntimeOptions } from './runtime-base.ts';

export const SANDBOX_BOOTSTRAP = buildWorkerBootstrap({
  imports: `import nodeCrypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';`,
  preamble: `
let syncMaskHint = true;

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

const scopedConsole = {
  log: (...args) => send({ t: 'log', level: 'info', message: args.map(String).join(' ') }),
  info: (...args) => send({ t: 'log', level: 'info', message: args.map(String).join(' ') }),
  warn: (...args) => send({ t: 'log', level: 'warn', message: args.map(String).join(' ') }),
  error: (...args) => send({ t: 'log', level: 'error', message: args.map(String).join(' ') }),
  debug: (...args) => send({ t: 'log', level: 'debug', message: args.map(String).join(' ') }),
};
const scopedLog = {
  debug: (...args) => send({ t: 'log', level: 'debug', message: args.map(String).join(' ') }),
  info: (...args) => send({ t: 'log', level: 'info', message: args.map(String).join(' ') }),
  warn: (...args) => send({ t: 'log', level: 'warn', message: args.map(String).join(' ') }),
  error: (...args) => send({ t: 'log', level: 'error', message: args.map(String).join(' ') }),
};
const safeCrypto = {
  randomUUID: () => nodeCrypto.randomUUID(),
  getRandomValues: (array) => nodeCrypto.getRandomValues(array),
};
`,
  normalizeArgExpr: '((item) => normalizeIpcValue(item))',
  normalizeFilterExpr: '((item) => normalizeIpcValue(item))',
  normalizeResultExpr: '((item) => normalizeIpcValue(item))',
  specialHostCallExpr: `if (prefix === 'vault.maskHint' && syncMaskHint) return maskHint(args[0]);`,
  loadEntryBody: `
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
`,
});

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
