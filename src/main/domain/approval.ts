/**
 * 审批策略的判定。
 *
 * 纯函数、不 import electron —— 所以 `node --test` 能直接加载（真正用它的
 * `environments.ts` 和 `plugins/host.ts` 都在 electron 那条链上，测不了）。
 *
 * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3。
 */
import type { AppSettings, ApprovalMode, ControlPolicy, Creator, PluginPolicy } from '../../shared/types';

export const DEFAULT_APP_SETTINGS: AppSettings = { controlPolicy: 'ask', pluginPolicy: 'ask' };

const CONTROL_POLICIES: readonly ControlPolicy[] = ['ask', 'agent-created', 'auto'];
const PLUGIN_POLICIES: readonly PluginPolicy[] = ['ask', 'auto'];
const APPROVAL_MODES: readonly ApprovalMode[] = ['inherit', 'ask', 'auto'];

export function isControlPolicy(value: unknown): value is ControlPolicy {
  return typeof value === 'string' && (CONTROL_POLICIES as readonly string[]).includes(value);
}

export function isPluginPolicy(value: unknown): value is PluginPolicy {
  return typeof value === 'string' && (PLUGIN_POLICIES as readonly string[]).includes(value);
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value);
}

/** 从库里读出来的原始字符串 → 设置对象。认不出来的值退回默认，不抛。 */
export function toAppSettings(raw: Record<string, string | undefined>): AppSettings {
  return {
    controlPolicy: isControlPolicy(raw.controlPolicy) ? raw.controlPolicy : DEFAULT_APP_SETTINGS.controlPolicy,
    pluginPolicy: isPluginPolicy(raw.pluginPolicy) ? raw.pluginPolicy : DEFAULT_APP_SETTINGS.pluginPolicy,
  };
}

/**
 * 这个环境此刻的控制权策略。
 *
 * 优先级 **环境级 > 全局**：环境上显式写了 `ask` / `auto` 就照它，
 * 只有 `inherit`（或没写）才看全局。
 */
export function controlModeFor(input: {
  policy: ControlPolicy;
  envApproval?: ApprovalMode;
  createdBy: Creator;
}): 'ask' | 'auto' {
  if (input.envApproval === 'ask' || input.envApproval === 'auto') return input.envApproval;
  if (input.policy === 'auto') return 'auto';
  if (input.policy === 'agent-created' && input.createdBy === 'agent') return 'auto';
  return 'ask';
}

/**
 * `confirm` 层的权限此刻算不算已授予。
 *
 * **不落库**：策略是 `auto` 就当场放行，切回 `ask` 立刻恢复拦截。
 * 落库的话会留下「曾经批准过」的痕迹，切回去还得反向清理，那种状态最容易漂。
 */
export function pluginAutoApproves(settings: AppSettings): boolean {
  return settings.pluginPolicy === 'auto';
}
