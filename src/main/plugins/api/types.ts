/**
 * 插件 host API 内部契约（叶子类型模块，打破 `api/index.ts` ↔ 域模块环依赖）。
 */
import type { Permission } from '../../../shared/permissions.ts';
import type { PluginRpcCaller, PluginSettingDescriptor } from '../../../shared/types.ts';
import type { EnvironmentManager } from '../../environments';
import type { PluginSettings } from '../settings.ts';
import type { PluginStorage } from '../storage.ts';

export interface HostApiDeps {
  pluginId: string;
  /**
   * 当前这次调用绑定的环境。由核心的调用级上下文提供（AsyncLocalStorage），
   * 不是插件级共享状态——否则同一插件的并发调用会互相覆盖环境。
   */
  currentEnvironmentId: () => string | undefined;
  /** 本次调用的权威来源（ui / agent）。默认按 agent 兜底（更保守）。 */
  currentCaller?: () => PluginRpcCaller;
  require: (permission: Permission) => void;
  manager: EnvironmentManager;
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
  caller: () => PluginRpcCaller;
  text: (value: unknown) => string;
}

export interface CapabilitySpec {
  permission?: Permission | readonly Permission[];
  needsLease?: boolean | ((ctx: CapabilityContext, args: unknown[]) => string | false);
  validate?: (ctx: CapabilityContext, args: unknown[]) => void;
  handler: (ctx: CapabilityContext, ...args: unknown[]) => Promise<unknown> | unknown;
}
