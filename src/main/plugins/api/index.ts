/**
 * 插件 host API 注册与分发器（声明式 `CapabilitySpec`）。
 *
 * 同一份实现供两种运行时使用：
 * - `sandbox` / `host`：子进程通过 JSON-RPC 按路径调用，统一落到编译后的 handlers 表；
 * - 所有方法通过 `CapabilitySpec` 统一声明权限与 lease 规则，不散落手写守卫。
 */
import type { PluginRpcCaller } from '../../../shared/types.ts';
import type { CapabilityContext, CapabilitySpec, HostApiDeps, HostHandler } from './types.ts';
import { browserCapabilities } from './browser.ts';
import { environmentCapabilities } from './environment.ts';
import { eventsCapabilities } from './events.ts';
import { netCapabilities } from './net.ts';
import { storageCapabilities } from './storage.ts';

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

export function createCapabilitySpecs(): Record<string, CapabilitySpec> {
  return {
    ...eventsCapabilities,
    ...environmentCapabilities,
    ...browserCapabilities,
    ...storageCapabilities,
    ...netCapabilities,
  };
}

export function createHandlers(deps: HostApiDeps): Record<string, HostHandler> {
  const env = (): string => {
    const id = deps.currentEnvironmentId();
    if (!id) {
      throw Object.assign(new Error('这个命令没有绑定环境，不能操作浏览器'), {
        code: 'PLUGIN_NO_ENVIRONMENT',
      });
    }
    return id;
  };

  const caller = (): PluginRpcCaller => (deps.currentCaller?.() === 'ui' ? 'ui' : 'agent');
  const ctx: CapabilityContext = { deps, env, caller, text };
  const specs = createCapabilitySpecs();
  const handlers: Record<string, HostHandler> = {};

  for (const [path, spec] of Object.entries(specs)) {
    handlers[path] = (...args) => {
      const permissions = Array.isArray(spec.permission) ? spec.permission : spec.permission ? [spec.permission] : [];
      for (const permission of permissions) {
        deps.require(permission);
      }
      spec.validate?.(ctx, args);
      if (spec.needsLease) {
        const targetEnv = typeof spec.needsLease === 'function' ? spec.needsLease(ctx, args) : env();
        if (targetEnv !== false) {
          return deps.withLease(targetEnv, async (leaseId) => {
            (deps.manager as { assertWritable?: (id: string, lease: string) => unknown }).assertWritable?.(
              targetEnv,
              leaseId,
            );
            return spec.handler(ctx, ...args);
          });
        }
      }
      return spec.handler(ctx, ...args);
    };
  }

  return handlers;
}

/** 把 `a.b.c` 形状的处理器表变成嵌套对象。 */
export function buildHostApi(handlers: Record<string, HostHandler>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, handler] of Object.entries(handlers)) {
    const parts = path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = (node[part] ??= {}) as Record<string, unknown>;
      node = next;
    }
    node[parts[parts.length - 1]] = handler;
  }
  return root;
}

/** 子进程来的调用：按路径查表。 */
export async function dispatchHostCall(
  handlers: Record<string, HostHandler>,
  path: string,
  args: unknown[],
): Promise<unknown> {
  const handler = handlers[path];
  if (!handler) {
    throw Object.assign(new Error(`未知的 host API: ${path}`), { code: 'PLUGIN_HOST_API_UNKNOWN' });
  }
  return handler(...(Array.isArray(args) ? args : []));
}
