/**
 * 插件调用调度器（`run` / `rpc` / `hostRead`）与插件日志。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { EnvironmentManager } from '../environments';
import type { Store } from '../store';
import { runWithPluginContext } from './call-context.ts';
import { dispatchHostRead } from './host-read.ts';
import { pluginError } from './installer.ts';
import { isNeedsConfiguration, type ActivePlugin } from './lifecycle.ts';
import type { Permission } from '../../shared/permissions.ts';
import type { PluginPackage } from './package.ts';
import { appendPluginLog, readPluginLogs, type PluginState } from './registry.ts';
import type { LogLevel } from './runtime-base.ts';
import type { PluginLogEntry, PluginRpcCaller, PluginRpcResponse, PluginStatus } from '../../shared/types.ts';

export interface RunResult {
  pluginId: string;
  command: string;
  result: unknown;
}

export interface InvokerDeps {
  db: DatabaseSync;
  manager: EnvironmentManager;
  store: Store;
  getState: () => PluginState;
  readPackage: (id: string) => Promise<PluginPackage>;
  activeOf: (id: string) => ActivePlugin | undefined;
  statusOf: (id: string) => { status: PluginStatus; detail?: string };
  setStatus: (id: string, status: { status: PluginStatus; detail?: string }) => void;
  requirePermission: (id: string, permission: Permission) => void;
  waitReady?: (id: string) => Promise<void>;
}

export class PluginInvoker {
  #deps: InvokerDeps;

  constructor(deps: InvokerDeps) {
    this.#deps = deps;
  }

  async #ensureActive(id: string): Promise<ActivePlugin | undefined> {
    const existing = this.#deps.activeOf(id);
    if (existing) return existing;
    await this.#deps.waitReady?.(id);
    return this.#deps.activeOf(id);
  }

  #notActiveMessage(id: string): string {
    const { status, detail } = this.#deps.statusOf(id);
    return detail ? `插件 ${id} 没有激活（状态 ${status}: ${detail}）` : `插件 ${id} 没有激活（状态 ${status}）`;
  }

  async log(id: string, level: LogLevel, message: string): Promise<void> {
    appendPluginLog(this.#deps.db, id, level, message);
  }

  async logs(id: string, limit = 200): Promise<PluginLogEntry[]> {
    return readPluginLogs(this.#deps.db, id, Math.max(1, Math.min(limit, 1000)));
  }

  /** 命令：一次性调用（v1 兼容）。 */
  async run(
    id: string,
    command: string,
    options: { environmentId?: string; input?: unknown; leaseId?: string; caller?: PluginRpcCaller },
  ): Promise<RunResult> {
    if (!this.#deps.getState().enabled.includes(id)) pluginError('PLUGIN_DISABLED', `插件 ${id} 未启用`);
    await this.#deps.readPackage(id); // 顺带校验清单还在、没被改坏
    const active = await this.#ensureActive(id);
    if (!this.#deps.getState().enabled.includes(id)) pluginError('PLUGIN_DISABLED', `插件 ${id} 未启用`);
    if (!active) {
      pluginError('PLUGIN_NOT_ACTIVE', this.#notActiveMessage(id));
    }

    const environmentId = options.environmentId || undefined;
    const caller: PluginRpcCaller = options.caller ?? 'agent';
    const ctx = {
      pluginId: id,
      environmentId: options.environmentId ?? '',
      command,
      input: options.input,
      leaseId: options.leaseId,
      caller,
    };
    try {
      const result = await runWithPluginContext({ pluginId: id, environmentId, leaseId: options.leaseId, caller }, () =>
        active.adapter.command(command, ctx),
      );
      this.#deps.store.record({
        id: crypto.randomUUID(),
        environmentId,
        type: 'plugin.ran',
        actor: 'agent',
        message: `[${id}] ${command} ok`,
        createdAt: new Date().toISOString(),
      });
      return { pluginId: id, command, result };
    } catch (error) {
      const err = error as Error & { code?: string };
      await this.log(id, 'error', `${command} 失败: ${err.message}`);
      this.#deps.store.record({
        id: crypto.randomUUID(),
        environmentId,
        type: 'plugin.failed',
        actor: 'agent',
        message: `[${id}] ${command} failed: ${err.message}`,
        createdAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  /** 插件前端或 agent 调插件后端方法，经严格 JSON 与白名单校验。 */
  async rpc(
    id: string,
    method: string,
    input: unknown,
    options: { leaseId?: string; environmentId?: string; caller?: PluginRpcCaller } = {},
  ): Promise<PluginRpcResponse> {
    const caller: PluginRpcCaller = options.caller === 'ui' ? 'ui' : 'agent';
    const leaseId = options.leaseId;
    const pkg = await this.#deps.readPackage(id);
    if (!this.#deps.getState().enabled.includes(id)) {
      return { ok: false, code: 'PLUGIN_DISABLED', message: `插件 ${id} 未启用` };
    }
    if (!pkg.contributes.rpc.includes(method)) {
      return {
        ok: false,
        code: 'PLUGIN_RPC_UNKNOWN',
        message: `${method} 不在清单声明的 rpc 白名单里`,
      };
    }
    const active = await this.#ensureActive(id);
    if (!this.#deps.getState().enabled.includes(id)) {
      return { ok: false, code: 'PLUGIN_DISABLED', message: `插件 ${id} 未启用` };
    }
    if (!active) {
      return {
        ok: false,
        code: 'PLUGIN_NOT_ACTIVE',
        message: this.#notActiveMessage(id),
      };
    }
    const environmentId =
      options.environmentId ??
      (typeof (input as { environmentId?: unknown })?.environmentId === 'string'
        ? (input as { environmentId: string }).environmentId
        : undefined);
    return runWithPluginContext({ pluginId: id, environmentId, leaseId, caller }, async () => {
      try {
        const result = await active.adapter.rpc(method, input ?? null, {
          pluginId: id,
          environmentId,
          input,
          leaseId,
          caller,
        });
        return { ok: true, result: toJson(result) };
      } catch (error) {
        const err = error as Error & { code?: string };
        await this.log(id, 'error', `rpc ${method} 失败: ${err.message}`);
        if (isNeedsConfiguration(error)) {
          this.#deps.setStatus(id, { status: 'needs-configuration', detail: err.message });
        }
        return { ok: false, code: err.code ?? 'PLUGIN_RPC_HANDLER_ERROR', message: err.message };
      }
    });
  }

  /** 插件前端直连宿主只读能力。 */
  async hostRead(
    id: string,
    method: string,
    environmentId: string | undefined,
    args: unknown[],
  ): Promise<PluginRpcResponse> {
    await this.#deps.readPackage(id);
    if (!this.#deps.getState().enabled.includes(id)) {
      return { ok: false, code: 'PLUGIN_DISABLED', message: `插件 ${id} 未启用` };
    }
    const active = await this.#ensureActive(id);
    if (!this.#deps.getState().enabled.includes(id)) {
      return { ok: false, code: 'PLUGIN_DISABLED', message: `插件 ${id} 未启用` };
    }
    if (!active) {
      return {
        ok: false,
        code: 'PLUGIN_NOT_ACTIVE',
        message: this.#notActiveMessage(id),
      };
    }
    try {
      const result = await dispatchHostRead(
        { manager: this.#deps.manager, require: (permission) => this.#deps.requirePermission(id, permission) },
        method,
        environmentId,
        args,
      );
      return { ok: true, result: toJson(result) };
    } catch (error) {
      const err = error as Error & { code?: string };
      await this.log(id, 'error', `hostRead ${method} 失败: ${err.message}`);
      return { ok: false, code: err.code ?? 'PLUGIN_HOST_READ_ERROR', message: err.message };
    }
  }
}

/** 结果必须是严格 JSON：循环引用 / bigint / 函数一律拒绝，不静默丢弃。 */
export function toJson(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) {
        throw Object.assign(new Error('插件返回值里有非法数字'), { code: 'PLUGIN_RPC_NON_JSON' });
      }
      return node;
    }
    if (typeof node === 'bigint' || typeof node === 'function' || typeof node === 'symbol') {
      throw Object.assign(new Error(`插件返回值里有 ${typeof node}，不能过 JSON`), {
        code: 'PLUGIN_RPC_NON_JSON',
      });
    }
    if (typeof node === 'undefined') {
      throw Object.assign(new Error('插件返回值里有 undefined，不能过 JSON'), {
        code: 'PLUGIN_RPC_NON_JSON',
      });
    }
    if (depth > 32) throw Object.assign(new Error('插件返回值嵌套过深'), { code: 'PLUGIN_RPC_NON_JSON' });
    const object = node as object;
    if (seen.has(object)) throw Object.assign(new Error('插件返回值里有循环引用'), { code: 'PLUGIN_RPC_NON_JSON' });
    seen.add(object);
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    // 用构造器名判断「普通对象」，跨 realm 也成立。
    const proto = Object.getPrototypeOf(object) as { constructor?: { name?: string } } | null;
    const constructorName = proto === null ? 'Object' : proto.constructor?.name;
    if (constructorName !== 'Object') {
      throw Object.assign(new Error(`插件返回值里有 ${constructorName ?? '未知类型'} 实例，不能过 JSON`), {
        code: 'PLUGIN_RPC_NON_JSON',
      });
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object as Record<string, unknown>)) {
      result[key] = walk(item, depth + 1);
    }
    return result;
  };
  const json = walk(value ?? null, 0);
  const encoded = JSON.stringify(json);
  if (encoded && encoded.length > 1024 * 1024) {
    throw Object.assign(new Error('插件返回值超过 1MB'), { code: 'PLUGIN_RPC_TOO_LARGE' });
  }
  return json;
}
