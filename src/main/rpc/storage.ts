/**
 * 站点记忆 Notes 与事件流域 RPC 端点。
 */
import type { RpcDomainTable } from './types.ts';

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
};
