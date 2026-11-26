/**
 * 插件网络域 host API。
 */
import type { CapabilitySpec } from './types.ts';

export const netCapabilities: Record<string, CapabilitySpec> = {
  'browser.network': {
    permission: 'network.observe',
    handler: ({ deps, env }) => deps.manager.networkEntries(env()),
  },
};
