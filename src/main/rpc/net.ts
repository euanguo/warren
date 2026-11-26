/**
 * 网络拦截、只读 Saved Flows 与证据采集域 RPC 端点。
 */
import type { SavedFlowSpec } from '../../shared/types.ts';
import { executeSavedFlow, extractFlowCandidates, normalizeFlowName, sanitizeFlowSpec } from '../browser/ops/flow.ts';
import { captureEvidence } from '../evidence.ts';
import type { RpcDomainTable } from './types.ts';
import { RpcError } from './types.ts';

function stringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

export const netRpcEndpoints: RpcDomainTable = {
  'net.rules': {
    kind: 'read',
    summary: '列出环境网络拦截规则',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.deps.manager.netRules(ctx.str('id')),
  },
  'net.body': {
    kind: 'read',
    summary: '读取 HAR 录制期间抓取的响应体（自动脱敏）',
    params: ['id', 'index'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.deps.manager.netBody(ctx.str('id'), ctx.reqNum('index')),
  },
  'net.hits': {
    kind: 'read',
    summary: '读取拦截命中记录',
    params: ['id', 'limit?'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.deps.manager.netHits(ctx.str('id'), ctx.num('limit')),
  },
  'net.rule.add': {
    kind: 'change',
    summary: '添加网络拦截规则',
    params: ['id', 'rule', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.deps.manager.netAddRule(ctx.str('id'), ctx.params.rule, 'agent'),
  },
  'net.rule.set': {
    kind: 'change',
    summary: '启用或停用指定网络拦截规则',
    params: ['id', 'ruleId', 'enabled', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) =>
      ctx.deps.manager.netSetRuleEnabled(ctx.str('id'), ctx.str('ruleId'), Boolean(ctx.params.enabled), 'agent'),
  },
  'net.rule.remove': {
    kind: 'change',
    summary: '移除指定网络拦截规则',
    params: ['id', 'ruleId', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ({ removed: ctx.deps.manager.netRemoveRule(ctx.str('id'), ctx.str('ruleId'), 'agent') }),
  },
  'net.passthrough': {
    kind: 'change',
    summary: '添加限时直通放行规则',
    params: ['id', 'match', 'forMs', 'isRegex?', 'method?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) =>
      ctx.deps.manager.netPassthrough(
        ctx.str('id'),
        {
          match: ctx.str('match'),
          isRegex: Boolean(ctx.params.isRegex),
          method: ctx.optStr('method'),
          forMs: ctx.reqNum('forMs'),
        },
        'agent',
      ),
  },
  'net.record': {
    kind: 'change',
    summary: '启停 HAR 网络录制',
    params: ['id', 'action', 'output?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.deps.manager.netRecord(ctx.str('id'), ctx.str('action'), ctx.optStr('output'), 'agent'),
  },
  'net.replay': {
    kind: 'change',
    summary: '启停 HAR 网络回放',
    params: ['id', 'action', 'file?', 'offline?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) =>
      ctx.deps.manager.netReplay(
        ctx.str('id'),
        ctx.str('action'),
        ctx.optStr('file'),
        Boolean(ctx.params.offline),
        'agent',
      ),
  },
  'evidence.capture': {
    kind: 'change',
    summary: '采集环境页面截图与遥测归档包',
    params: ['id', 'name?', 'screenshot?'],
    gate: 'none',
    wake: true,
    handler: (ctx) =>
      captureEvidence(ctx.deps.manager, ctx.str('id'), {
        name: ctx.optStr('name'),
        screenshot: ctx.params.screenshot !== false,
      }),
  },
  'flow.steps': {
    kind: 'read',
    summary: '从环境遥测筛选只读 GET API 候选流',
    params: ['id'],
    gate: 'read',
    handler: (ctx) => extractFlowCandidates(ctx.deps.manager.networkEntries(ctx.str('id'))),
  },
  'flow.list': {
    kind: 'read',
    summary: '列出所有已保存的只读参数化 Flow',
    params: [],
    gate: 'read',
    handler: ({ deps }) => deps.store.listSavedFlows(),
  },
  'flow.show': {
    kind: 'read',
    summary: '查看指定 Flow 的只读模板定义',
    params: ['name'],
    gate: 'read',
    handler: (ctx) => {
      const flow = ctx.deps.store.getSavedFlow(normalizeFlowName(ctx.str('name')));
      if (!flow) throw new RpcError('NOT_FOUND', `未找到已保存的 flow：${ctx.str('name')}`);
      return flow;
    },
  },
  'flow.save': {
    kind: 'change',
    summary: '保存只读 GET 参数化 Flow（严禁凭据与写请求）',
    params: ['name', 'urlTemplate', 'extractPath?', 'fields?', 'description?'],
    gate: 'none',
    handler: (ctx) => {
      const name = normalizeFlowName(ctx.str('name'));
      const rawSpec = (
        ctx.params.spec && typeof ctx.params.spec === 'object' ? ctx.params.spec : ctx.params
      ) as Partial<SavedFlowSpec>;
      const { site, spec } = sanitizeFlowSpec(rawSpec);
      return ctx.deps.store.saveFlow(name, site, spec, ctx.optStr('updatedBy') ?? 'agent');
    },
  },
  'flow.rm': {
    kind: 'change',
    summary: '删除指定 Flow',
    params: ['name'],
    gate: 'none',
    handler: (ctx) => ({ removed: ctx.deps.store.removeSavedFlow(normalizeFlowName(ctx.str('name'))) }),
  },
  'flow.run': {
    kind: 'read',
    summary: '在指定环境会话内执行只读 Flow 并支持过滤投影与漂移检测',
    params: ['id', 'name', 'params?', 'fields?', 'where?', 'limit?'],
    gate: 'read',
    handler: (ctx) => {
      const id = ctx.str('id');
      const name = normalizeFlowName(ctx.str('name'));
      const record = ctx.deps.store.getSavedFlow(name);
      if (!record) throw new RpcError('NOT_FOUND', `未找到已保存的 flow：${name}`);
      const c = ctx.controller(id);
      const fields = Array.isArray(ctx.params.fields) ? (ctx.params.fields as unknown[]).map(String) : undefined;
      return executeSavedFlow(record, (url, opts) => c.fetch(url, opts), {
        params: stringRecord(ctx.params.params),
        fields,
        where: stringRecord(ctx.params.where),
        limit: ctx.num('limit'),
      });
    },
  },
};
