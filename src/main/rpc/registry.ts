/**
 * 统一 RPC 注册表与派发器。
 *
 * 将原本分裂在 `rpc-methods.ts` 与 `rpc-dispatch.ts` 的能力清单、唤醒条件、
 * 写/输入/弹窗门控与处理器收敛为单一事实源 `RPC_REGISTRY`，彻底消除契约漂移与 `as never` 绕过。
 * 本模块仅使用 type-only Electron 引用，可由 `node --test` 直接加载测试。
 */
import type { SpaceId, TabRef } from '../../shared/types.ts';
import { browserRpcEndpoints } from './browser.ts';
import { envRpcEndpoints } from './env.ts';
import { netRpcEndpoints } from './net.ts';
import { pluginRpcEndpoints } from './plugin.ts';
import { storageRpcEndpoints } from './storage.ts';
import { systemRpcEndpoints } from './system.ts';
import { RpcError, type DispatchDeps, type RpcContext, type RpcEndpointDef, type RpcMethodMeta } from './types.ts';

export { RpcError, type DispatchDeps, type RpcEndpointDef, type RpcGate, type RpcMethodMeta } from './types.ts';

const baseEndpoints: Record<string, RpcEndpointDef> = {
  ...systemRpcEndpoints,
  ...envRpcEndpoints,
  ...browserRpcEndpoints,
  ...netRpcEndpoints,
  ...storageRpcEndpoints,
  ...pluginRpcEndpoints,
};

export const RPC_REGISTRY: Readonly<Record<string, RpcEndpointDef>> = {
  ...baseEndpoints,
  'rpc.methods': {
    kind: 'read',
    summary: '列出所有可用 RPC 方法与参数',
    params: ['name?'],
    gate: 'read',
    handler: (ctx) => findRpcMethods(ctx.optStr('name')),
  },
};

export const RPC_METHODS: readonly RpcMethodMeta[] = Object.entries(RPC_REGISTRY).map(([name, def]) => ({
  name,
  kind: def.kind,
  summary: def.summary,
  params: def.params,
}));

export function findRpcMethods(query?: string): RpcMethodMeta[] {
  const q = query?.trim().toLowerCase();
  if (!q) return [...RPC_METHODS];
  return RPC_METHODS.filter((m) => m.name.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q));
}

function buildContext(deps: DispatchDeps, method: string, params: Record<string, unknown>): RpcContext {
  const str = (key: string): string => {
    const value = params[key];
    if (typeof value !== 'string' || !value) throw new RpcError('BAD_REQUEST', `missing string param: ${key}`);
    return value;
  };
  const optStr = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;
  const num = (key: string): number | undefined =>
    typeof params[key] === 'number' && Number.isFinite(params[key]) ? (params[key] as number) : undefined;
  const reqNum = (key: string): number => {
    const value = num(key);
    if (value === undefined) throw new RpcError('BAD_REQUEST', `missing number param: ${key}`);
    return value;
  };
  const tabRef = (key: string): TabRef => {
    const value = params[key];
    if (typeof value === 'number' || (typeof value === 'string' && value)) return value;
    throw new RpcError('BAD_REQUEST', `missing tab ref param: ${key}`);
  };
  const tab: TabRef | undefined =
    typeof params.tabId === 'number' || (typeof params.tabId === 'string' && params.tabId)
      ? (params.tabId as TabRef)
      : undefined;
  const leaseId = typeof params.leaseId === 'string' ? params.leaseId : undefined;
  const space: SpaceId = params.space === 'person' ? 'person' : 'agent';

  const assertWritable = (envId?: string): string => {
    const id = envId ?? str('id');
    deps.manager.assertWritable(id, leaseId, space);
    return id;
  };

  const controller = (envId?: string) => deps.manager.controllerFor(envId ?? str('id'), tab, space);

  const runWithInput: RpcContext['runWithInput'] = async (id, fn) => {
    const c = controller(id);
    return deps.manager.withInputContext(id, space, tab, async () => {
      if (params.autoDialog === 'accept') await c.acceptDialog().catch(() => {});
      else if (params.autoDialog === 'dismiss') await c.dismissDialog().catch(() => {});
      else if (typeof c.handleAutoDialogIfNeeded === 'function') await c.handleAutoDialogIfNeeded();
      c.assertNoDialog();
      return fn(c);
    });
  };

  return {
    deps,
    method,
    params,
    space,
    leaseId,
    tab,
    str,
    optStr,
    num,
    reqNum,
    tabRef,
    controller,
    assertWritable,
    runWithInput,
  };
}

export async function dispatchRpc(
  deps: DispatchDeps,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const endpoint = RPC_REGISTRY[method];
  if (!endpoint) throw new RpcError('METHOD_NOT_FOUND', `unknown method: ${method}`);

  if (endpoint.wake && typeof params.id === 'string' && deps.manager.isDormant(params.id)) {
    deps.manager.wake(params.id);
  }

  const ctx = buildContext(deps, method, params);
  switch (endpoint.gate) {
    case 'write':
    case 'dialog':
      ctx.assertWritable();
      return endpoint.handler(ctx);
    case 'input': {
      const id = ctx.assertWritable();
      return ctx.runWithInput(id, () => endpoint.handler(ctx));
    }
    case 'tab':
      if (ctx.space === 'agent') ctx.assertWritable();
      return endpoint.handler(ctx);
    case 'read':
    case 'none':
    case 'custom':
      return endpoint.handler(ctx);
  }
}
