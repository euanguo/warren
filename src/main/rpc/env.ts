/**
 * 环境、扩展、标签与分组域 RPC 端点。
 */
import { actionTraceRing } from '../browser/ops/action-trace.ts';
import { sessionContextTracker } from '../browser/ops/context-tracker.ts';
import { actionLoopDetector } from '../browser/ops/loop-detector.ts';
import type { EnvironmentPatch } from '../domain/environment.ts';
import { runDoctor } from '../doctor.ts';
import { execStateStore } from '../env/exec-state.ts';
import type { RpcContext, RpcDomainTable } from './types.ts';
import { RpcError } from './types.ts';

function groupIdParam(ctx: RpcContext): string | undefined {
  return typeof ctx.params.groupId === 'string' && ctx.params.groupId ? ctx.params.groupId : undefined;
}

export const envRpcEndpoints: RpcDomainTable = {
  'env.list': {
    kind: 'read',
    summary: '列出全部浏览器环境',
    params: [],
    gate: 'read',
    handler: ({ deps }) => deps.manager.list(),
  },
  'env.get': {
    kind: 'read',
    summary: '读取单个环境详情',
    params: ['id'],
    gate: 'read',
    handler: (ctx) => ctx.deps.manager.get(ctx.str('id')) ?? null,
  },
  'env.create': {
    kind: 'change',
    summary: '创建新环境',
    params: ['id', 'name?', 'proxy?', 'startUrl?', 'headed?'],
    gate: 'none',
    handler: (ctx) =>
      ctx.deps.manager.create({
        id: ctx.str('id'),
        name: ctx.optStr('name'),
        proxy: ctx.optStr('proxy'),
        startUrl: ctx.optStr('startUrl'),
        headed: typeof ctx.params.headed === 'boolean' ? ctx.params.headed : undefined,
        // 走 RPC 的一定是 agent（CLI）。人那条路是 main.ts 的 IPC。
        createdBy: 'agent',
      }),
  },
  'env.remove': {
    kind: 'change',
    summary: '删除环境及其存储目录',
    params: ['id'],
    gate: 'none',
    handler: async (ctx) => {
      const id = ctx.str('id');
      await ctx.deps.manager.remove(id);
      sessionContextTracker.resetByPrefix(`${id}:`);
      actionLoopDetector.resetByPrefix(`${id}:`);
      execStateStore.clearEnv(id);
      actionTraceRing.clear(id);
      return { ok: true };
    },
  },
  'env.update': {
    kind: 'change',
    summary: '更新环境配置（name/proxy/trustedCa/startUrl/headed）',
    params: ['id', 'name?', 'proxy?', 'trustedCa?', 'startUrl?', 'headed?'],
    gate: 'none',
    handler: (ctx) => {
      const { params } = ctx;
      const patch: EnvironmentPatch = {};
      /*
       * **故意不读 `params.approval`**：审批策略是信任决定，agent 能给自己放行的话这道门
       * 就等于不存在。只有界面那条 IPC（`main.ts` 的 `env:update`）能带这个字段。
       * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3.4 —— 别顺手把它加进来。
       */
      if (typeof params.name === 'string') patch.name = params.name;
      if (params.proxy === null || params.proxy === 'none' || params.proxy === '') patch.proxy = null;
      else if (typeof params.proxy === 'string') patch.proxy = params.proxy;
      if (params.trustedCa === null || params.trustedCa === 'none' || params.trustedCa === '') patch.trustedCa = null;
      else if (typeof params.trustedCa === 'string') patch.trustedCa = params.trustedCa;
      if (typeof params.startUrl === 'string') patch.startUrl = params.startUrl;
      if (typeof params.headed === 'boolean') patch.headed = params.headed;
      return ctx.deps.manager.update(ctx.str('id'), patch);
    },
  },
  'env.start': {
    kind: 'change',
    summary: '启动环境',
    params: ['id'],
    gate: 'none',
    wake: true,
    handler: (ctx) => ctx.deps.manager.start(ctx.str('id')),
  },
  'env.stop': {
    kind: 'change',
    summary: '停止环境',
    params: ['id'],
    gate: 'none',
    handler: (ctx) => {
      const id = ctx.str('id');
      ctx.deps.manager.stop(id);
      sessionContextTracker.resetByPrefix(`${id}:`);
      actionLoopDetector.resetByPrefix(`${id}:`);
      execStateStore.clearEnv(id);
      actionTraceRing.clear(id);
      return { ok: true };
    },
  },
  'env.hibernate': {
    kind: 'change',
    summary: '休眠单个环境或全部可安全回收的后台环境以释放渲染进程内存',
    params: ['id?', 'idle?'],
    gate: 'none',
    handler: (ctx) => {
      if (ctx.params.idle === true) {
        const hibernated = ctx.deps.manager.hibernateBackground('cli-idle');
        return { ok: true, hibernated };
      }
      return { ok: ctx.deps.manager.hibernate(ctx.str('id'), 'manual') };
    },
  },
  'env.clearCache': {
    kind: 'change',
    summary: '清理指定环境或全部环境的 HTTP 磁盘缓存（保留 Cookie 与登录态）',
    params: ['id?'],
    gate: 'none',
    handler: (ctx) => {
      const id = ctx.optStr('id');
      return id ? ctx.deps.manager.clearCache(id) : ctx.deps.manager.clearAllCaches();
    },
  },
  'env.wake': {
    kind: 'change',
    summary: '从休眠唤醒环境',
    params: ['id'],
    gate: 'none',
    handler: (ctx) => ({ ok: ctx.deps.manager.wake(ctx.str('id')) }),
  },
  'env.select': {
    kind: 'change',
    summary: '在界面中选中指定环境',
    params: ['id'],
    gate: 'none',
    wake: true,
    handler: (ctx) => {
      ctx.deps.manager.select(ctx.str('id'));
      return { ok: true };
    },
  },
  'env.acquire': {
    kind: 'change',
    summary: '申请 Agent Space 控制权租约',
    params: ['id', 'label?', 'space?', 'leaseId?'],
    gate: 'none',
    wake: true,
    handler: (ctx) => ctx.deps.manager.acquire(ctx.str('id'), 'agent', ctx.optStr('label'), ctx.space, ctx.leaseId),
  },
  'env.takeover': {
    kind: 'change',
    summary: '人工强接管 Agent Space',
    params: ['id', 'space?'],
    gate: 'none',
    wake: true,
    handler: (ctx) => ctx.deps.manager.takeover(ctx.str('id'), 'human', ctx.space),
  },
  'env.release': {
    kind: 'change',
    summary: '归还控制权（keepSession=true 时仅释放底层写锁，保持 Agent 托管蒙层常驻）',
    params: ['id', 'leaseId', 'keepSession?'],
    gate: 'none',
    wake: true,
    handler: (ctx) => {
      ctx.deps.manager.release(ctx.str('id'), ctx.str('leaseId'), 'agent', {
        keepSession: typeof ctx.params.keepSession === 'boolean' ? ctx.params.keepSession : undefined,
      });
      return { ok: true };
    },
  },
  'env.finish': {
    kind: 'change',
    summary: '显式结束 Agent Space 托管操作会话并撤除蒙层',
    params: ['id'],
    gate: 'none',
    wake: true,
    handler: (ctx) => {
      const result = ctx.deps.manager.finishAgentSession(ctx.str('id'), 'agent');
      return { ok: true, ...result };
    },
  },
  'env.renew': {
    kind: 'change',
    summary: '续租当前控制权 leaseId',
    params: ['id', 'leaseId'],
    gate: 'none',
    wake: true,
    handler: (ctx) => ctx.deps.manager.renew(ctx.str('id'), ctx.str('leaseId')),
  },
  'env.egress': {
    kind: 'read',
    summary: '查看环境出口与实时页面摘要',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: async (ctx) => {
      const id = ctx.str('id');
      const controller = ctx.deps.manager.controllerFor(id, undefined, ctx.space);
      const snapshot = await controller.snapshot({ limit: 200 });
      const environment = ctx.deps.store.get(id);
      return {
        environmentId: id,
        proxy: environment?.proxy ?? null,
        trustedCa: environment?.trustedCa ?? null,
        url: controller.currentUrl(),
        title: await controller.title(),
        nodes: snapshot.length,
      };
    },
  },
  'env.doctor': {
    kind: 'read',
    summary: '运行环境代理与端口预检',
    params: ['id', 'localPorts?'],
    gate: 'read',
    wake: true,
    handler: (ctx) => {
      const id = ctx.str('id');
      const localPorts = Array.isArray(ctx.params.localPorts)
        ? ctx.params.localPorts.filter((port): port is number => typeof port === 'number')
        : undefined;
      return runDoctor(ctx.deps.manager, id, { localPorts });
    },
  },
  'env.moveToGroup': {
    kind: 'change',
    summary: '移动环境到指定分组或移出分组',
    params: ['id', 'groupId?'],
    gate: 'none',
    wake: true,
    handler: (ctx) => ctx.deps.manager.moveToGroup(ctx.str('id'), groupIdParam(ctx)),
  },
  'env.reorder': {
    kind: 'change',
    summary: '调整组内或未分组环境排序',
    params: ['ids', 'groupId?'],
    gate: 'none',
    handler: async (ctx) => {
      if (!Array.isArray(ctx.params.ids)) throw new RpcError('BAD_REQUEST', 'ids must be an array');
      await ctx.deps.manager.reorderEnvironments(groupIdParam(ctx), ctx.params.ids.map(String));
      return { ok: true };
    },
  },
  'extension.list': {
    kind: 'read',
    summary: '列出环境已加载扩展',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.deps.manager.extensionsOf(ctx.str('id')),
  },
  'extension.add': {
    kind: 'change',
    summary: '向环境安装未打包扩展',
    params: ['id', 'dir', 'name?'],
    gate: 'none',
    wake: true,
    handler: (ctx) => ctx.deps.manager.extensionAdd(ctx.str('id'), ctx.str('dir'), ctx.optStr('name')),
  },
  'extension.remove': {
    kind: 'change',
    summary: '移除环境已安装扩展',
    params: ['id', 'name'],
    gate: 'none',
    wake: true,
    handler: (ctx) => ctx.deps.manager.extensionRemove(ctx.str('id'), ctx.str('name')),
  },
  'tab.list': {
    kind: 'read',
    summary: '列出环境当前或指定 Space 标签',
    params: ['id', 'space?'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.deps.manager.tabsOf(ctx.str('id'), ctx.space),
  },
  'tab.new': {
    kind: 'change',
    summary: '新建标签页',
    params: ['id', 'url?', 'background?', 'leaseId?', 'space?'],
    gate: 'tab',
    wake: true,
    handler: (ctx) =>
      ctx.deps.manager.newTab(
        ctx.str('id'),
        ctx.optStr('url'),
        {
          activate: ctx.params.background !== true,
          openedBy: ctx.space === 'agent' ? 'agent' : 'human',
        },
        ctx.space,
      ),
  },
  'tab.select': {
    kind: 'change',
    summary: '切换激活标签',
    params: ['id', 'ref', 'leaseId?', 'space?'],
    gate: 'tab',
    wake: true,
    handler: (ctx) => ctx.deps.manager.selectTab(ctx.str('id'), ctx.space, ctx.tabRef('ref')),
  },
  'tab.close': {
    kind: 'change',
    summary: '关闭指定标签（或通过 agentOnly=true 一键清理 Agent/Popup 打开的临时标签）',
    params: ['id', 'ref?', 'agentOnly?', 'leaseId?', 'space?'],
    gate: 'tab',
    wake: true,
    handler: (ctx) => {
      if (ctx.params.agentOnly === true) {
        const closed = ctx.deps.manager.closeAgentTabs?.(ctx.str('id'), ctx.space) ?? 0;
        return { ok: true, closed };
      }
      ctx.deps.manager.closeTab(ctx.str('id'), ctx.space, ctx.tabRef('ref'));
      return { ok: true };
    },
  },
  'tab.closeOthers': {
    kind: 'change',
    summary: '关闭指定标签之外的全部标签',
    params: ['id', 'ref', 'leaseId?', 'space?'],
    gate: 'tab',
    wake: true,
    handler: (ctx) => {
      ctx.deps.manager.closeTabs(ctx.str('id'), ctx.space, ctx.tabRef('ref'), 'others');
      return { ok: true };
    },
  },
  'tab.closeRight': {
    kind: 'change',
    summary: '关闭指定标签右侧的全部标签',
    params: ['id', 'ref', 'leaseId?', 'space?'],
    gate: 'tab',
    wake: true,
    handler: (ctx) => {
      ctx.deps.manager.closeTabs(ctx.str('id'), ctx.space, ctx.tabRef('ref'), 'right');
      return { ok: true };
    },
  },
  'tab.reorder': {
    kind: 'change',
    summary: '拖拽重排 Space 内标签顺序',
    params: ['id', 'from', 'to', 'leaseId?', 'space?'],
    gate: 'tab',
    wake: true,
    handler: (ctx) => ctx.deps.manager.reorderTab(ctx.str('id'), ctx.space, ctx.reqNum('from'), ctx.reqNum('to')),
  },
  'tab.mute': {
    kind: 'change',
    summary: '切换标签静音状态',
    params: ['id', 'ref', 'muted?', 'leaseId?', 'space?'],
    gate: 'tab',
    wake: true,
    handler: (ctx) => ctx.deps.manager.muteTab(ctx.str('id'), ctx.space, ctx.tabRef('ref'), ctx.params.muted !== false),
  },
  'tab.reopen': {
    kind: 'change',
    summary: '恢复最近关闭的标签',
    params: ['id', 'leaseId?', 'space?'],
    gate: 'tab',
    wake: true,
    handler: (ctx) => ctx.deps.manager.reopenTab(ctx.str('id'), ctx.space),
  },
  'group.list': {
    kind: 'read',
    summary: '列出所有环境分组',
    params: [],
    gate: 'read',
    handler: ({ deps }) => deps.manager.listGroups(),
  },
  'group.create': {
    kind: 'change',
    summary: '创建环境分组',
    params: ['name', 'id?'],
    gate: 'none',
    handler: (ctx) =>
      ctx.deps.manager.createGroup({
        id: typeof ctx.params.id === 'string' && ctx.params.id ? ctx.params.id : undefined,
        name: ctx.str('name'),
      }),
  },
  'group.rename': {
    kind: 'change',
    summary: '重命名环境分组',
    params: ['id', 'name'],
    gate: 'none',
    handler: (ctx) => ctx.deps.manager.renameGroup(ctx.str('id'), ctx.str('name')),
  },
  'group.remove': {
    kind: 'change',
    summary: '删除环境分组并将环境移出',
    params: ['id'],
    gate: 'none',
    handler: (ctx) => ctx.deps.manager.removeGroup(ctx.str('id')),
  },
  'group.collapse': {
    kind: 'change',
    summary: '折叠或展开环境分组',
    params: ['id', 'collapsed'],
    gate: 'none',
    handler: (ctx) => ctx.deps.manager.setGroupCollapsed(ctx.str('id'), Boolean(ctx.params.collapsed)),
  },
  'group.reorder': {
    kind: 'change',
    summary: '重排环境分组顺序',
    params: ['ids'],
    gate: 'none',
    handler: async (ctx) => {
      if (!Array.isArray(ctx.params.ids)) throw new RpcError('BAD_REQUEST', 'ids must be an array');
      await ctx.deps.manager.reorderGroups(ctx.params.ids.map(String));
      return { ok: true };
    },
  },
};
