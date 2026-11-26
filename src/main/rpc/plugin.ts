/**
 * 插件管理与 Skill 合成/同步域 RPC 端点。
 */
import type { Permission } from '../../shared/permissions.ts';
import { composeSkill, installSkill, refreshSkills, skillStatus } from '../agent-integration.ts';
import type { RpcDomainTable } from './types.ts';
import { RpcError } from './types.ts';

function requireSkillSourceDir(sourceDir: string | undefined): string {
  if (!sourceDir) throw new RpcError('SKILL_MISSING', '主进程未提供 skillSourceDir');
  return sourceDir;
}

export const pluginRpcEndpoints: RpcDomainTable = {
  'plugin.list': {
    kind: 'read',
    summary: '列出已安装插件',
    params: [],
    gate: 'read',
    handler: ({ deps }) => deps.plugins.list(),
  },
  'plugin.install': {
    kind: 'change',
    summary: '从本地路径或包源安装插件',
    params: ['source'],
    gate: 'none',
    handler: (ctx) => ctx.deps.plugins.install(ctx.str('source')),
  },
  'plugin.update': {
    kind: 'change',
    summary: '更新已安装插件',
    params: ['id'],
    gate: 'none',
    handler: (ctx) => ctx.deps.plugins.update(ctx.str('id')),
  },
  'plugin.enable': {
    kind: 'change',
    summary: '启用插件',
    params: ['id'],
    gate: 'none',
    handler: (ctx) => ctx.deps.plugins.enable(ctx.str('id')),
  },
  'plugin.disable': {
    kind: 'change',
    summary: '停用插件',
    params: ['id'],
    gate: 'none',
    handler: async (ctx) => {
      await ctx.deps.plugins.disable(ctx.str('id'));
      return { ok: true };
    },
  },
  'plugin.uninstall': {
    kind: 'change',
    summary: '卸载插件',
    params: ['id'],
    gate: 'none',
    handler: async (ctx) => {
      await ctx.deps.plugins.uninstall(ctx.str('id'));
      return { ok: true };
    },
  },
  'plugin.grant': {
    kind: 'change',
    summary: '为插件授予指定权限',
    params: ['id', 'permissions'],
    gate: 'none',
    handler: (ctx) => ctx.deps.plugins.grant(ctx.str('id'), (ctx.params.permissions as Permission[]) ?? []),
  },
  'plugin.reload': {
    kind: 'change',
    summary: '热重载插件',
    params: ['id'],
    gate: 'none',
    handler: (ctx) => ctx.deps.plugins.reload(ctx.str('id')),
  },
  'plugin.logs': {
    kind: 'read',
    summary: '读取插件运行日志',
    params: ['id', 'limit?'],
    gate: 'read',
    handler: (ctx) => ctx.deps.plugins.logs(ctx.str('id'), ctx.num('limit') ?? 200),
  },
  'plugin.config.set': {
    kind: 'change',
    summary: '写入插件配置项',
    params: ['id', 'key', 'value'],
    gate: 'none',
    handler: (ctx) => ctx.deps.plugins.setSetting(ctx.str('id'), ctx.str('key'), ctx.str('value')),
  },
  'plugin.setSkillExposed': {
    kind: 'change',
    summary: '开关指定插件向 Agent 暴露 Skill',
    params: ['id', 'exposed'],
    gate: 'none',
    handler: (ctx) => ctx.deps.plugins.setSkillExposed(ctx.str('id'), Boolean(ctx.params.exposed)),
  },
  'plugin.readSkill': {
    kind: 'read',
    summary: '读取指定插件的完整 Skill 文档',
    params: ['id'],
    gate: 'read',
    handler: (ctx) => ctx.deps.plugins.readSkill(ctx.str('id')),
  },
  'plugin.rpc': {
    kind: 'change',
    summary: '调用插件 RPC',
    params: ['id', 'method', 'input?', 'environmentId?', 'leaseId?'],
    gate: 'none',
    handler: (ctx) =>
      /*
       * 走 RPC 的插件调用一律是 agent：`ui` 只从 `main.ts` 的 `plugin:rpc` IPC 进来。
       * 插件据此把「只给人看」的通道（账号插件的 reveal）关掉。
       */
      ctx.deps.plugins.rpc(ctx.str('id'), ctx.str('method'), ctx.params.input ?? null, {
        leaseId: ctx.leaseId,
        environmentId: ctx.optStr('environmentId'),
        caller: 'agent',
      }),
  },
  'plugin.run': {
    kind: 'change',
    summary: '执行插件注册命令',
    params: ['id', 'command', 'env?', 'input?', 'leaseId?'],
    gate: 'none',
    handler: (ctx) =>
      ctx.deps.plugins.run(ctx.str('id'), ctx.str('command'), {
        environmentId: typeof ctx.params.env === 'string' ? ctx.params.env : '',
        input: ctx.params.input,
        leaseId: ctx.leaseId,
      }),
  },
  'skills.compose': {
    kind: 'read',
    summary: '实时合成含已启用插件索引的 Warren Skill',
    params: ['mode?'],
    gate: 'read',
    handler: async (ctx) => {
      const sourceDir = requireSkillSourceDir(ctx.deps.skillSourceDir);
      const entries = await ctx.deps.plugins.skillEntries();
      const mode =
        ctx.params.mode === 'full' || ctx.params.mode === 'base-only'
          ? (ctx.params.mode as 'full' | 'base-only')
          : 'index';
      const bundle = await composeSkill(sourceDir, entries, { mode });
      return {
        markdown: bundle.markdown,
        baseSha: bundle.baseSha,
        composedSha: bundle.composedSha,
        enabledPlugins: bundle.enabledPlugins.map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          skillSha: p.skillSha,
          summary: p.summary,
          triggers: p.triggers,
          hasExplicitSkill: p.hasExplicitSkill,
        })),
      };
    },
  },
  'skills.plugin': {
    kind: 'read',
    summary: '按需读取指定插件的完整 Skill 手册',
    params: ['id'],
    gate: 'read',
    handler: (ctx) => ctx.deps.plugins.readSkill(ctx.str('id')),
  },
  'skills.status': {
    kind: 'read',
    summary: '查看各外部 Agent 目录的 Skill 安装与同步状态',
    params: [],
    gate: 'read',
    handler: async (ctx) => {
      const sourceDir = requireSkillSourceDir(ctx.deps.skillSourceDir);
      const home = ctx.deps.homeDir ?? process.env.HOME ?? '';
      return skillStatus(home, sourceDir, await ctx.deps.plugins.skillEntries());
    },
  },
  'skills.install': {
    kind: 'change',
    summary: '安装合成版 Skill（含已启用插件）到目标 Agent 目录',
    params: ['target?'],
    gate: 'none',
    handler: async (ctx) => {
      const sourceDir = requireSkillSourceDir(ctx.deps.skillSourceDir);
      const home = ctx.deps.homeDir ?? process.env.HOME ?? '';
      const target = ctx.optStr('target') ?? 'all';
      const entries = await ctx.deps.plugins.skillEntries();
      if (target === 'all') {
        const out = [];
        for (const tid of ['agents', 'claude', 'codex']) {
          out.push({ id: tid, ...(await installSkill(home, sourceDir, tid, entries)) });
        }
        return out;
      }
      return [{ id: target, ...(await installSkill(home, sourceDir, target, entries)) }];
    },
  },
  'skills.refresh': {
    kind: 'change',
    summary: '刷新所有已安装但过期的外部 Agent Skill 目录',
    params: [],
    gate: 'none',
    handler: async (ctx) => {
      const sourceDir = requireSkillSourceDir(ctx.deps.skillSourceDir);
      const home = ctx.deps.homeDir ?? process.env.HOME ?? '';
      return refreshSkills(home, sourceDir, await ctx.deps.plugins.skillEntries());
    },
  },
};
