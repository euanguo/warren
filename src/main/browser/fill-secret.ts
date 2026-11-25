/**
 * 「把秘密填进页面字段」的共用实现。
 *
 * 两条路都要用：`vault.fill`（RPC，人/agent 从 Vault 取值）和
 * 插件的 `browser.fillSecret`（账号插件按 id 取自己的明文再填）。
 *
 * 为什么要共用：这一段真正容易错的地方不是 `controller.fill`，而是前面的四道准备
 * （临时挂到窗口最底层 → 校验在屏 → 校验是激活标签 → CDP 焦点仿真）和 finally 的摘除。
 * 抄两份必然漂移，症状又是最难查的那种——命令成功、页面没反应。
 *
 * 值只在这一层流动：不回传、不打日志、不进事件。
 */
import { hostAllowed } from './policy.ts';
import type { BrowserController } from './controller.ts';
import type { EnvironmentManager } from '../environments';
import type { SpaceId, TabRef } from '../../shared/types';

export interface SecretFillContext {
  manager: EnvironmentManager;
  environmentId: string;
  space: SpaceId;
  controller: BrowserController;
  /** 目标标签；不传就是该 Space 当前激活标签 */
  tab?: TabRef;
}

export interface SecretFillOptions {
  /** 域名名单（抄 Browser Use secret_bindings）：不在名单的 origin 拒绝填充 */
  allowedDomains?: string[];
  /** 名单外的域；调用方用它记事件（谁被拒、拒在哪） */
  onDenied?: (host: string) => void;
}

/** 域名名单校验。单独导出，让调用方能在真正准备输入之前就拒掉。 */
export function assertSecretDomain(context: SecretFillContext, options: SecretFillOptions = {}): void {
  const domains = options.allowedDomains;
  if (!domains || domains.length === 0) return;
  let host = '';
  try {
    host = new URL(context.controller.currentUrl()).hostname;
  } catch {
    host = '';
  }
  if (hostAllowed(host, domains)) return;
  options.onDenied?.(host);
  throw Object.assign(new Error(`不允许把凭据填到 ${host || '当前页面'}`), { code: 'PATH_DENIED' });
}

/**
 * 填充一次。调用方负责 `assertWritable`（拿 lease 是调用方的事，这一层只碰页面）。
 */
export async function fillSecretInto(
  context: SecretFillContext,
  target: unknown,
  value: string,
  options: SecretFillOptions = {},
): Promise<void> {
  assertSecretDomain(context, options);
  const { manager, environmentId, space, controller, tab } = context;
  // 后台环境（视图没挂在窗口上）Chromium 会把输入丢掉，先临时挂到窗口最底层
  const temporary = manager.ensureOperable(environmentId, space);
  let emulatedViewport = false;
  try {
    manager.assertInputOnScreen(environmentId, space);
    manager.assertActiveTab(environmentId, tab, space);
    await manager.focusForInput(environmentId, space);
    if (temporary) emulatedViewport = await manager.prepareBackgroundInput(environmentId, space);
    await controller.fill(target as never, value);
  } finally {
    if (emulatedViewport) await manager.clearBackgroundInput(environmentId, space);
    if (temporary) manager.detachOperable(environmentId, space);
  }
}
