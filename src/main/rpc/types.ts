/**
 * RPC 协议注册表共享类型与入参上下文。
 */
import type { TabRef, SpaceId } from '../../shared/types.ts';
import type { BrowserController } from '../browser/controller.ts';
import type { EnvironmentManager } from '../environments.ts';
import type { PluginHost } from '../plugins/host.ts';
import type { Store } from '../store.ts';
import type { VaultStore } from '../vault/store.ts';

export class RpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DispatchDeps {
  manager: EnvironmentManager;
  store: Store;
  vault: VaultStore;
  saveVault: () => Promise<void>;
  plugins: PluginHost;
  skillSourceDir?: string;
  homeDir?: string;
  isPackaged: boolean;
  /** 允许 debug.* 里改窗口位置/可见性/前台的命令。默认 false：回归不碰用户的窗口。 */
  allowWindowCommands?: boolean;
  quit: () => void;
}

export interface RpcMethodMeta {
  name: string;
  kind: 'read' | 'change';
  summary: string;
  params: string[];
}

/**
 * 门控策略：
 * - `read`: 纯读，不取租约
 * - `write`: 自动调用 `manager.assertWritable(id, leaseId, space)`
 * - `input`: `write` + `manager.withInputContext(...)` + 弹窗处理与防阻塞校验
 * - `dialog`: `write`（但允许在阻塞 dialog 存在、视图不可见或后台 tab 上执行）
 * - `tab`: 仅当 `space === 'agent'` 时校验 `assertWritable`
 * - `none`: 环境创建/启停/配置/分组/事件等不依赖页面租约的操作
 * - `custom`: 自控细粒度门控（如 `browser.find`、`browser.batch` 按子动作判别）
 */
export type RpcGate = 'read' | 'write' | 'input' | 'dialog' | 'tab' | 'none' | 'custom';

export interface RpcContext {
  deps: DispatchDeps;
  method: string;
  params: Record<string, unknown>;
  space: SpaceId;
  leaseId?: string;
  tab?: TabRef;
  str(key: string): string;
  optStr(key: string): string | undefined;
  num(key: string): number | undefined;
  reqNum(key: string): number;
  tabRef(key: string): TabRef;
  controller(id?: string): BrowserController;
  assertWritable(id?: string): string;
  runWithInput<T>(id: string, fn: (c: BrowserController) => Promise<T> | T): Promise<T>;
}

export interface RpcEndpointDef {
  kind: 'read' | 'change';
  summary: string;
  params: string[];
  gate: RpcGate;
  /** 命中休眠环境时先透明唤醒再派发。 */
  wake?: boolean;
  handler: (ctx: RpcContext) => unknown | Promise<unknown>;
}

export type RpcDomainTable = Record<string, RpcEndpointDef>;
