/**
 * Vault 凭据、站点记忆 Notes 与事件流域 RPC 端点。
 */
import { fillSecretInto } from '../browser/fill-secret.ts';
import { makeEvent } from '../domain/environment.ts';
import { isSecretField, sanitizeCredentialSecret } from '../vault/store.ts';
import type { RpcDomainTable } from './types.ts';
import { RpcError } from './types.ts';

export const storageRpcEndpoints: RpcDomainTable = {
  'events.list': {
    kind: 'read',
    summary: '读取环境或全局事件流',
    params: ['environmentId?'],
    gate: 'read',
    handler: (ctx) => ctx.deps.store.events(ctx.optStr('environmentId')),
  },
  'events.since': {
    kind: 'read',
    summary: '按游标/时间增量读取事件',
    params: ['environmentId?', 'afterId?', 'since?', 'limit?'],
    gate: 'read',
    handler: (ctx) =>
      ctx.deps.store.eventsSince({
        environmentId: ctx.optStr('environmentId'),
        afterId: ctx.optStr('afterId'),
        since: ctx.optStr('since'),
        limit: ctx.num('limit'),
      }),
  },
  'notes.list': {
    kind: 'read',
    summary: '列出所有站点记忆笔记',
    params: [],
    gate: 'read',
    handler: ({ deps }) => deps.store.listSiteNotes(),
  },
  'notes.get': {
    kind: 'read',
    summary: '读取指定站点记忆',
    params: ['site'],
    gate: 'read',
    handler: (ctx) => ctx.deps.store.getSiteNote(ctx.str('site')) ?? null,
  },
  'notes.set': {
    kind: 'change',
    summary: '写入或覆盖站点记忆（严禁凭据明文）',
    params: ['site', 'content', 'updatedBy?'],
    gate: 'none',
    handler: (ctx) =>
      ctx.deps.store.setSiteNote(ctx.str('site'), ctx.str('content'), ctx.optStr('updatedBy') ?? 'agent'),
  },
  'notes.append': {
    kind: 'change',
    summary: '追加一行站点记忆',
    params: ['site', 'text', 'updatedBy?'],
    gate: 'none',
    handler: (ctx) =>
      ctx.deps.store.appendSiteNote(ctx.str('site'), ctx.str('text'), ctx.optStr('updatedBy') ?? 'agent'),
  },
  'notes.rm': {
    kind: 'change',
    summary: '删除站点记忆',
    params: ['site'],
    gate: 'none',
    handler: (ctx) => ({ removed: ctx.deps.store.removeSiteNote(ctx.str('site')) }),
  },
  'vault.list': {
    kind: 'read',
    summary: '列出打码凭据摘要（永不返回明文）',
    params: [],
    gate: 'read',
    handler: ({ deps }) => ({ available: deps.vault.available, credentials: deps.vault.list() }),
  },
  'vault.add': {
    kind: 'change',
    summary: '向本地 safeStorage Vault 写入凭据',
    params: ['provider', 'secret', 'label?'],
    gate: 'none',
    handler: async (ctx) => {
      const provider = ctx.str('provider').trim();
      const label = typeof ctx.params.label === 'string' ? ctx.params.label.trim() : '';
      const secret = sanitizeCredentialSecret(ctx.params.secret);
      const summary = ctx.deps.vault.add({ provider, label, secret });
      await ctx.deps.saveVault();
      ctx.deps.store.record(makeEvent('vault.added', `新增凭据 ${summary.provider}（${summary.label}）`, 'agent'));
      return summary;
    },
  },
  'vault.remove': {
    kind: 'change',
    summary: '从 Vault 删除指定凭据',
    params: ['ref'],
    gate: 'none',
    handler: async (ctx) => {
      const removed = ctx.deps.vault.remove(ctx.str('ref'));
      await ctx.deps.saveVault();
      return { removed };
    },
  },
  'vault.fill': {
    kind: 'change',
    summary: '直接向页面填充 Vault 凭据（不回传明文）',
    params: ['id', 'ref', 'field', 'target', 'allowedDomains?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: async (ctx) => {
      const id = ctx.str('id');
      const ref = ctx.str('ref');
      const rawField = ctx.params.field === undefined ? 'password' : ctx.params.field;
      if (!isSecretField(rawField)) {
        throw new RpcError('BAD_REQUEST', `非法的凭据字段: ${String(rawField)}`);
      }
      const secret = ctx.deps.vault.reveal(ref);
      const value = secret[rawField];
      if (!value) throw new RpcError('CREDENTIAL_FIELD_MISSING', `${ref} 没有 ${rawField}`);
      const controller = ctx.controller(id);
      const allowedDomains = Array.isArray(ctx.params.allowedDomains)
        ? (ctx.params.allowedDomains as unknown[]).map(String)
        : undefined;
      await fillSecretInto(
        {
          manager: ctx.deps.manager,
          environmentId: id,
          space: ctx.space,
          controller,
          tab: ctx.tab,
        },
        ctx.params.target,
        value,
        {
          allowedDomains,
          onDenied: (host) => {
            ctx.deps.store.record(
              makeEvent('vault.fillDenied', `${ref} 不在 ${host || '未知域'} 的允许名单内`, 'system', id),
            );
          },
        },
      );
      return { filled: true, ref, field: rawField };
    },
  },
};
