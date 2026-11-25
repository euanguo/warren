/**
 * 插件调用的调用级上下文。
 *
 * 以前 host.ts 用 per-plugin 的可变对象保存「当前环境」，同一插件的并发调用会互相覆盖。
 * 现在统一走 AsyncLocalStorage：sandbox 的 host API 直接继承上下文；host 运行时靠
 * host-call 上的 invocation id 把子进程调用关联回来。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PluginRpcCaller } from '../../shared/types.ts';

export interface PluginCallContext {
  pluginId: string;
  environmentId?: string;
  leaseId?: string;
  /** 谁调的：渲染层的插件界面（ui）还是 CLI / agent（agent）。默认 agent，失败姿势更保守。 */
  caller?: PluginRpcCaller;
}

const storage = new AsyncLocalStorage<PluginCallContext>();

export function runWithPluginContext<T>(context: PluginCallContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentEnvironmentId(): string | undefined {
  return storage.getStore()?.environmentId;
}

/** 调用方显式带入的 lease（plugin run/rpc 的 --lease）。写操作优先复用它。 */
export function currentLeaseId(): string | undefined {
  return storage.getStore()?.leaseId;
}

/**
 * 这次调用是谁发起的。
 *
 * 默认 `agent`：没显式标 ui 的路径（漏传、新入口）都必须按 agent 处理，
 * 反过来会把「只给 UI 的通道」误开给 agent。
 */
export function currentCaller(): PluginRpcCaller {
  return storage.getStore()?.caller === 'ui' ? 'ui' : 'agent';
}
