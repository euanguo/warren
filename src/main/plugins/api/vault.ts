/**
 * 插件 Vault 域 host API。
 */
import { fillSecretInto } from '../../browser/fill-secret.ts';
import { maskHint } from '../../vault/store.ts';
import type { CapabilitySpec } from './index.ts';

export const vaultCapabilities: Record<string, CapabilitySpec> = {
  'vault.listRefs': {
    permission: 'environment.read',
    handler: ({ deps, text }, provider) =>
      deps.vault.list().filter((item) => !provider || item.provider === text(provider)),
  },
  /**
   * 只把秘密填进页面字段，绝不返回明文。
   * 和 RPC 的 `vault.fill` 共用 `browser/fill-secret.ts`。
   */
  'vault.fill': {
    permission: ['vault.fill', 'browser.input'],
    needsLease: true,
    handler: async ({ deps, env, text }, ref, target, field) => {
      const secret = deps.vault.reveal(text(ref));
      const key = (text(field) || 'password') as 'username' | 'password' | 'token' | 'totp';
      const value = secret[key];
      if (!value) {
        throw Object.assign(new Error(`${ref} 没有 ${key}`), {
          code: 'CREDENTIAL_FIELD_MISSING',
        });
      }
      await fillSecretInto(
        {
          manager: deps.manager,
          environmentId: env(),
          space: 'agent',
          controller: deps.manager.controllerFor(env(), undefined, 'agent'),
        },
        target,
        value,
      );
      return { filled: true, field: key };
    },
  },
  /**
   * 与 Vault 同一个打码规则（首字符 + 域名）。只对入参做纯函数变换，不读存储。
   */
  'vault.maskHint': {
    handler: ({ text }, username) => maskHint(text(username)),
  },
};
