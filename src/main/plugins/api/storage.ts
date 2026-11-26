/**
 * 插件存储与 Cookie 受控通道 / 设置 host API。
 */
import { asCookieInputs, asSqlParams } from '../../browser/parse-params.ts';
import type { CapabilitySpec } from './types.ts';

export const storageCapabilities: Record<string, CapabilitySpec> = {
  // ── Cookie 受控通道（只搬运不返回，宽形状 read/write 留在 denied 层）────
  'cookie.names': {
    permission: 'storage.cookie.port',
    handler: ({ deps, env, text }, options) => {
      const url =
        typeof (options as { url?: unknown })?.url === 'string' ? text((options as { url: string }).url) : undefined;
      return deps.manager.cookieNames(env(), url);
    },
  },
  'cookie.copy': {
    permission: 'storage.cookie.port',
    needsLease: ({ env, text }, [input]) => text((input as { to?: unknown } | undefined)?.to) || env(),
    validate: ({ text }, [input]) => {
      const from = text((input as { from?: unknown } | undefined)?.from);
      if (!from) throw Object.assign(new Error('cookie.copy 需要 from'), { code: 'BAD_REQUEST' });
    },
    handler: ({ deps, env, text }, input) => {
      const params = (input ?? {}) as { from?: unknown; to?: unknown; domain?: unknown; name?: unknown };
      const from = text(params.from);
      const to = text(params.to) || env();
      return deps.manager.cookieCopy(from, to, {
        domain: typeof params.domain === 'string' ? params.domain : undefined,
        name: typeof params.name === 'string' ? params.name : undefined,
      });
    },
  },
  'cookie.import': {
    permission: 'storage.cookie.port',
    needsLease: true,
    handler: ({ deps, env }, input) => {
      const cookies = (input as { cookies?: unknown } | undefined)?.cookies;
      return deps.manager.cookieImport(env(), asCookieInputs(cookies));
    },
  },
  'cookie.clear': {
    permission: 'storage.cookie.port',
    needsLease: true,
    handler: ({ deps, env }, input) => {
      const params = (input ?? {}) as { domain?: unknown; name?: unknown };
      return deps.manager.cookieClear(env(), {
        domain: typeof params.domain === 'string' ? params.domain : undefined,
        name: typeof params.name === 'string' ? params.name : undefined,
      });
    },
  },

  // ── KV & SQLite ─────────────────────────────────────────────────
  'storage.kv.get': {
    handler: ({ deps, text }, key) => deps.storage.get(text(key)),
  },
  'storage.kv.set': {
    permission: 'storage.write',
    handler: async ({ deps, text }, key, value) => {
      await deps.storage.set(text(key), value);
      return { ok: true };
    },
  },
  'storage.kv.delete': {
    permission: 'storage.write',
    handler: async ({ deps, text }, key) => ({ deleted: await deps.storage.delete(text(key)) }),
  },
  'storage.kv.list': {
    handler: ({ deps, text }, prefix) => deps.storage.list(prefix ? text(prefix) : ''),
  },
  'storage.sql.exec': {
    permission: 'storage.write',
    handler: ({ deps, text }, sql) => {
      deps.storage.db().exec(text(sql));
      return { ok: true };
    },
  },
  'storage.sql.run': {
    permission: 'storage.write',
    handler: ({ deps, text }, sql, params) => {
      const statement = deps.storage.db().prepare(text(sql));
      return statement.run(...asSqlParams(params));
    },
  },
  'storage.sql.query': {
    handler: ({ deps, text }, sql, params) => {
      const statement = deps.storage.db().prepare(text(sql));
      return statement.all(...asSqlParams(params));
    },
  },
  'storage.sql.migrate': {
    permission: 'storage.write',
    validate: (_ctx, [statements]) => {
      if (!Array.isArray(statements)) {
        throw Object.assign(new Error('migrate 需要字符串数组'), { code: 'PLUGIN_BAD_REQUEST' });
      }
    },
    handler: ({ deps, text }, statements) => ({
      applied: deps.storage.migrate((statements as unknown[]).map(text)),
    }),
  },

  // ── 插件设置 ────────────────────────────────────────────────────
  'settings.get': {
    handler: ({ deps }) => deps.settings.get(deps.descriptors),
  },
};
