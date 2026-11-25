/**
 * 插件前端可直连的宿主只读能力。
 *
 * 这张表是**独立于 createHandlers() 全量表**的：只放白名单里的读路径，且返回窄 DTO。
 * 不要在 `PLUGIN_HOST_READ_METHODS` 之外偷偷加路径；加一条要同时改 shared 常量和测试。
 */
import type { Permission } from '../../shared/permissions.ts';
import type { Environment, HostEnvironmentSummary } from '../../shared/types.ts';
import { isPluginHostReadMethod, type PluginHostReadMethod } from '../../shared/plugin-host-api.ts';
import type { EnvironmentManager } from '../environments';

export interface HostReadDeps {
  manager: EnvironmentManager;
  require: (permission: Permission) => void;
}

interface HostReadCapability {
  permission: Permission;
  run: (deps: HostReadDeps, environmentId: string | undefined, args: unknown[]) => Promise<unknown> | unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function hostReadError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/**
 * 窄 DTO 的投影：字段一个个挑，不用 spread。
 *
 * 用 conditional spread 是为了让可选字段真的「不存在」，而不是 `undefined`——
 * 这些结果会经过 `PluginHost.hostRead` 的 toJson（拒绝 undefined）。
 */
function toSummary(env: Environment): HostEnvironmentSummary {
  return {
    id: env.id,
    name: env.name,
    status: env.status,
    owner: env.owner,
    ...(env.proxy ? { proxy: env.proxy } : {}),
    ...(env.groupId ? { groupId: env.groupId } : {}),
    ...(env.currentUrl ? { currentUrl: env.currentUrl } : {}),
    ...(env.title ? { title: env.title } : {}),
    ...(env.error ? { error: env.error } : {}),
  };
}

const HOST_READ_CAPABILITIES: Record<PluginHostReadMethod, HostReadCapability> = {
  'environment.list': {
    permission: 'environment.read',
    run: (deps) => deps.manager.list().map(toSummary),
  },
  'environment.get': {
    permission: 'environment.read',
    run: (deps, _environmentId, args) => {
      const env = deps.manager.get(text(args[0]));
      return env ? toSummary(env) : null;
    },
  },
  'browser.info': {
    permission: 'browser.dom.read',
    run: async (deps, environmentId) => {
      if (!environmentId) hostReadError('PLUGIN_NO_ENVIRONMENT', 'browser.info 需要 environmentId');
      const controller = deps.manager.controllerFor(environmentId);
      return { url: controller.currentUrl(), title: await controller.title() };
    },
  },
};

export async function dispatchHostRead(
  deps: HostReadDeps,
  method: string,
  environmentId: string | undefined,
  args: unknown[],
): Promise<unknown> {
  if (!isPluginHostReadMethod(method)) {
    hostReadError('PLUGIN_HOST_METHOD_UNKNOWN', `未知的宿主只读方法: ${method}`);
  }
  const capability = HOST_READ_CAPABILITIES[method];
  deps.require(capability.permission);
  return capability.run(deps, environmentId, Array.isArray(args) ? args : []);
}
