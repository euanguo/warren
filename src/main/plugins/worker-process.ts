/**
 * 统一插件子进程适配器。
 *
 * - Electron 主进程内（`Boolean(process.versions.electron)`）走 `utilityProcess.fork(...)`；
 * - 纯 Node 单测（`node --test`）下走 `child_process.fork(...)`。
 *
 * 屏蔽两者在 IPC 通道（structured clone vs JSON）与信号强杀上的差异：
 * Node IPC 通道会经 `encodeIpc`/`decodeIpc` 保留数组和对象里的 `undefined`，
 * 确保两套环境的边界语义完全一致。
 */
import { fork as forkNode, type ChildProcess, type Serializable } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface WorkerProcessOptions {
  serviceName: string;
  env?: NodeJS.ProcessEnv;
  /** 为 host 插件开启独立进程组（Unix），便于强杀时一并清理衍生子进程。 */
  detached?: boolean;
}

const SANDBOX_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_ENV',
  'WARREN_PLUGIN_TIMEOUT_MS',
]);

export function buildSandboxEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && SANDBOX_ENV_ALLOWLIST.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

export interface WorkerProcess {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number | null) => void): this;
  once(event: 'exit', listener: (code: number | null) => void): this;
  kill(): boolean;
}

const UNDEF_MARKER = '__warren_undef__';

/** Node IPC 默认走 JSON 序列化，会把 `[undefined]` 变成 `[null]`；用标记保真还原。 */
function encodeIpc(value: unknown): unknown {
  if (value === undefined) return { [UNDEF_MARKER]: true };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(encodeIpc);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = encodeIpc(item);
  }
  return out;
}

function decodeIpc(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeIpc);
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, UNDEF_MARKER) && Object.keys(record).length === 1) {
    return undefined;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    out[key] = decodeIpc(item);
  }
  return out;
}

class ElectronWorkerProcess extends EventEmitter implements WorkerProcess {
  #child: import('electron').UtilityProcess;
  #exited = false;

  constructor(child: import('electron').UtilityProcess) {
    super();
    this.#child = child;
    child.on('message', (message) => {
      this.emit('message', message);
    });
    child.on('exit', (code) => {
      this.#exited = true;
      this.emit('exit', code);
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get stdout(): NodeJS.ReadableStream | null {
    return this.#child.stdout;
  }

  get stderr(): NodeJS.ReadableStream | null {
    return this.#child.stderr;
  }

  postMessage(message: unknown): void {
    if (this.#exited) return;
    try {
      this.#child.postMessage(message);
    } catch {
      // 进程正在退出时忽略竞态写失败
    }
  }

  kill(): boolean {
    if (this.#exited) return false;
    const pid = this.#child.pid;
    let killed = false;
    try {
      killed = this.#child.kill();
    } catch {
      killed = false;
    }
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
        killed = true;
      } catch {
        // 进程已退出
      }
    }
    return killed;
  }
}

class NodeWorkerProcess extends EventEmitter implements WorkerProcess {
  #child: ChildProcess;
  #detached: boolean;
  #exited = false;

  constructor(child: ChildProcess, detached = false) {
    super();
    this.#child = child;
    this.#detached = detached;
    child.on('message', (message) => {
      this.emit('message', decodeIpc(message));
    });
    child.on('exit', (code) => {
      this.#exited = true;
      this.emit('exit', code);
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get stdout(): NodeJS.ReadableStream | null {
    return this.#child.stdout;
  }

  get stderr(): NodeJS.ReadableStream | null {
    return this.#child.stderr;
  }

  postMessage(message: unknown): void {
    if (this.#exited || !this.#child.connected) return;
    try {
      this.#child.send(encodeIpc(message) as Serializable);
    } catch {
      // 通道关闭竞态忽略
    }
  }

  kill(): boolean {
    if (this.#exited) return false;
    const pid = this.#child.pid;
    if (this.#detached && pid && process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL');
        return true;
      } catch {
        // 进程组已不存在时退回直接杀子进程
      }
    }
    try {
      return this.#child.kill('SIGKILL');
    } catch {
      return false;
    }
  }
}

export function buildForkEnv(env?: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export async function forkWorkerProcess(modulePath: string, options: WorkerProcessOptions): Promise<WorkerProcess> {
  const cleanEnv = buildForkEnv(options.env);
  if (process.versions.electron) {
    // 懒加载：只在 Electron 主进程下引入，保证 node --test 可直接加载本模块
    const { utilityProcess } = await import('electron');
    const child = utilityProcess.fork(modulePath, [], {
      serviceName: options.serviceName,
      stdio: 'pipe',
      ...(cleanEnv ? { env: cleanEnv } : {}),
    });
    return new ElectronWorkerProcess(child);
  }

  const detached = Boolean(options.detached && process.platform !== 'win32');
  const child = forkNode(modulePath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [],
    detached,
    ...(cleanEnv ? { env: cleanEnv } : {}),
  });
  return new NodeWorkerProcess(child, detached);
}
