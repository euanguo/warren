/**
 * 插件环境域 host API。
 */
import type { Environment } from '../../../shared/types.ts';
import type { CapabilitySpec } from './types.ts';

/**
 * 插件后端的环境视图：leaseId / leaseExpiresAt 是主进程内部凭据形状，不出边界。
 * storagePath 保留 —— whistle 要把 trusted-ca.pem 放进环境目录。
 */
export type PluginEnvironmentView = Omit<Environment, 'leaseId' | 'leaseExpiresAt'>;

export function toPluginEnvironment(env: Environment): PluginEnvironmentView {
  const copy: Environment = { ...env };
  delete copy.leaseId;
  delete copy.leaseExpiresAt;
  return copy;
}

export const environmentCapabilities: Record<string, CapabilitySpec> = {
  'environment.list': {
    permission: 'environment.read',
    handler: ({ deps }) => deps.manager.list().map(toPluginEnvironment),
  },
  'environment.get': {
    permission: 'environment.read',
    handler: ({ deps, text }, id) => {
      const env = deps.manager.get(text(id));
      return env ? toPluginEnvironment(env) : env;
    },
  },
  /*
   * 改环境配置 / 启停环境。
   * 它们改的是环境的配置，不是「谁在控制这个页面」，所以不挂 lease。
   */
  'environment.update': {
    permission: 'environment.write',
    validate: ({ text }, [input]) => {
      const patch = (input ?? {}) as { id?: unknown };
      if (!text(patch.id)) throw Object.assign(new Error('environment.update 需要 id'), { code: 'BAD_REQUEST' });
    },
    handler: async ({ deps, text }, input) => {
      const patch = (input ?? {}) as { id?: unknown; proxy?: unknown; trustedCa?: unknown };
      const id = text(patch.id);
      const updated = await deps.manager.update(id, {
        // null / '' 都是「清掉」：解绑代理要能表达
        ...(patch.proxy === null || patch.proxy === '' ? { proxy: null } : {}),
        ...(typeof patch.proxy === 'string' && patch.proxy ? { proxy: patch.proxy } : {}),
        ...(patch.trustedCa === null || patch.trustedCa === '' ? { trustedCa: null } : {}),
        ...(typeof patch.trustedCa === 'string' && patch.trustedCa ? { trustedCa: patch.trustedCa } : {}),
      });
      return toPluginEnvironment(updated);
    },
  },
  'environment.start': {
    permission: 'environment.write',
    handler: async ({ deps, text }, id) => toPluginEnvironment(await deps.manager.start(text(id))),
  },
  'environment.stop': {
    permission: 'environment.write',
    handler: ({ deps, text }, id) => {
      deps.manager.stop(text(id));
      return { ok: true };
    },
  },
};
