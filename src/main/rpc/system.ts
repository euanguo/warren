/**
 * 系统探针、只读设置与开发期 debug.* 诊断域 RPC 端点。
 */
import type { BrowserShortcut } from '../../shared/types.ts';
import { asTargetInput } from '../browser/parse-params.ts';
import type { RpcContext, RpcDomainTable, RpcEndpointDef } from './types.ts';
import { RpcError } from './types.ts';

function debugEndpoint(spec: Omit<RpcEndpointDef, 'gate'> & { windowCommand?: boolean }): RpcEndpointDef {
  return {
    kind: spec.kind,
    summary: spec.summary,
    params: spec.params,
    wake: spec.wake,
    gate: 'read',
    handler: (ctx: RpcContext) => {
      if (ctx.deps.isPackaged) {
        throw new RpcError('UNAUTHORIZED', 'debug.* is unavailable in packaged builds');
      }
      if (spec.windowCommand && ctx.deps.allowWindowCommands !== true) {
        throw new RpcError('WINDOW_COMMANDS_DISABLED', `${ctx.method} 默认禁用（WARREN_ALLOW_WINDOW_COMMANDS=1 开启）`);
      }
      return spec.handler(ctx);
    },
  };
}

export const systemRpcEndpoints: RpcDomainTable = {
  ping: {
    kind: 'read',
    summary: '健康探针',
    params: [],
    gate: 'read',
    handler: () => ({ pong: true, pid: process.pid }),
  },
  'settings.get': {
    kind: 'read',
    summary: '读取只读应用设置与审批策略',
    params: [],
    gate: 'read',
    handler: ({ deps }) => deps.store.appSettings(),
  },
  'debug.layout': debugEndpoint({
    kind: 'read',
    summary: '诊断主窗口布局与视口尺寸',
    params: [],
    handler: ({ deps }) => deps.manager.layout(),
  }),
  'debug.focusWindow': debugEndpoint({
    kind: 'change',
    summary: '强制激活并聚焦主窗口（回归专用）',
    params: [],
    windowCommand: true,
    handler: ({ deps }) => deps.manager.focusWindow(),
  }),
  'debug.hideWindow': debugEndpoint({
    kind: 'change',
    summary: '隐藏主窗口（回归专用）',
    params: [],
    windowCommand: true,
    handler: ({ deps }) => {
      deps.manager.hideWindow();
      return { hidden: true };
    },
  }),
  'debug.backgroundWindow': debugEndpoint({
    kind: 'change',
    summary: '将主窗口退回后台（回归专用）',
    params: [],
    windowCommand: true,
    handler: ({ deps }) => {
      deps.manager.backgroundWindow();
      return { background: true };
    },
  }),
  'debug.showWindow': debugEndpoint({
    kind: 'change',
    summary: '显示主窗口（回归专用）',
    params: [],
    windowCommand: true,
    handler: ({ deps }) => {
      deps.manager.showWindow(false);
      return { hidden: false, focused: false };
    },
  }),
  'debug.rendererEval': debugEndpoint({
    kind: 'change',
    summary: '在渲染层执行 JS 探针（仅非打包开发期）',
    params: ['script'],
    wake: true,
    handler: async (ctx) => ({ value: await ctx.deps.manager.evalInRenderer(ctx.str('script')) }),
  }),
  'debug.shortcut': debugEndpoint({
    kind: 'change',
    summary: '向外壳分发应用级快捷键动作',
    params: ['shortcut'],
    wake: true,
    handler: (ctx) => {
      ctx.deps.manager.sendShortcut(ctx.params.shortcut as BrowserShortcut);
      return { ok: true };
    },
  }),
  'debug.point': debugEndpoint({
    kind: 'read',
    summary: '诊断元素视口落点与 OOPIF 偏移真值',
    params: ['id', 'target'],
    wake: true,
    handler: (ctx) => ctx.controller().probePoint(asTargetInput(ctx.params.target)),
  }),
  'debug.sendInput': debugEndpoint({
    kind: 'change',
    summary: '原生 webContents.sendInputEvent 点击探针',
    params: ['id', 'x', 'y'],
    wake: true,
    handler: async (ctx) => {
      const wc = ctx.controller().webContents;
      const x = ctx.reqNum('x');
      const y = ctx.reqNum('y');
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      return {
        ok: true,
        focused: wc.isFocused(),
        visibility: await wc.executeJavaScript('document.visibilityState', true).catch(() => 'unknown'),
      };
    },
  }),
  'debug.quit': debugEndpoint({
    kind: 'change',
    summary: '优雅触发应用退出（验收专用）',
    params: [],
    handler: ({ deps }) => {
      setTimeout(() => deps.quit(), 50);
      return { ok: true };
    },
  }),
};
