/**
 * 插件 host API 注册与分发器（声明式 `CapabilitySpec`）。
 *
 * 同一份实现供两种运行时使用：
 * - `sandbox` / `host`：子进程通过 JSON-RPC 按路径调用，统一落到编译后的 handlers 表；
 * - 所有方法通过 `CapabilitySpec` 统一声明权限与 lease 规则，不散落手写守卫。
 */
import type { Permission } from '../../../shared/permissions.ts';
import type { PluginSettingDescriptor } from '../../../shared/types.ts';
import type { EnvironmentManager } from '../../environments';
import type { PluginSettings } from '../settings.ts';
import type { PluginStorage } from '../storage.ts';
import { browserCapabilities } from './browser.ts';
import { environmentCapabilities } from './environment.ts';
import { eventsCapabilities } from './events.ts';
import { netCapabilities } from './net.ts';
import { storageCapabilities } from './storage.ts';
import { vaultCapabilities } from './vault.ts';

export interface HostApiDeps {
  pluginId: string;
  /**
   * 当前这次调用绑定的环境。由核心的调用级上下文提供（AsyncLocalStorage），
   * 不是插件级共享状态——否则同一插件的并发调用会互相覆盖环境。
   */
  currentEnvironmentId: () => string | undefined;
  require: (permission: Permission) => void;
  manager: EnvironmentManager;
  vault: {
    available: boolean;
    list(): Array<{ ref: string; provider: string; label: string; usernameHint: string }>;
    reveal(ref: string): { username?: string; password?: string; token?: string; totp?: string };
  };
  storage: PluginStorage;
  settings: PluginSettings;
  descriptors: PluginSettingDescriptor[];
  record: (type: string, message: string) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  signal: (channel: string, payload: unknown) => void;
  /** 写操作惰性取 lease：读操作不再把控制权从人手里抢走 */
  withLease: <T>(envId: string, fn: (leaseId: string) => Promise<T>) => Promise<T>;
  subscribeEvents?: (filter: unknown) => { subscriptionId: string } | Promise<{ subscriptionId: string }>;
  unsubscribeEvents?: (subscriptionId: string) => void | Promise<void>;
}

export type HostHandler = (...args: unknown[]) => Promise<unknown> | unknown;

export interface CapabilityContext {
  deps: HostApiDeps;
  env: () => string;
  text: (value: unknown) => string;
}

export interface CapabilitySpec {
  permission?: Permission | readonly Permission[];
  needsLease?: boolean | ((ctx: CapabilityContext, args: unknown[]) => string);
  validate?: (ctx: CapabilityContext, args: unknown[]) => void;
  handler: (ctx: CapabilityContext, ...args: unknown[]) => Promise<unknown> | unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

export function createCapabilitySpecs(): Record<string, CapabilitySpec> {
  return {
    ...eventsCapabilities,
    ...environmentCapabilities,
    ...browserCapabilities,
    ...vaultCapabilities,
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

  const ctx: CapabilityContext = { deps, env, text };
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
        return deps.withLease(targetEnv, async (leaseId) => {
          (deps.manager as { assertWritable?: (id: string, lease: string) => unknown }).assertWritable?.(
            targetEnv,
            leaseId,
          );
          return spec.handler(ctx, ...args);
        });
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
