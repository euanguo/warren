/**
 * 审批策略的判定。
 *
 * 纯函数、不 import electron —— 所以 `node --test` 能直接加载（真正用它的
 * `environments.ts` 和 `plugins/host.ts` 都在 electron 那条链上，测不了）。
 *
 * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3。
 */
import { DEVTOOLS_BOTTOM_SIZE, DEVTOOLS_RIGHT_SIZE } from '../../shared/devtools-layout.ts';
import type {
  AppSettings,
  ApprovalMode,
  ControlPolicy,
  Creator,
  DevToolsDockMode,
  PluginPolicy,
  ThemePreference,
  ViewportPresetId,
} from '../../shared/types';

export const DEFAULT_APP_SETTINGS: Required<AppSettings> = {
  controlPolicy: 'ask',
  pluginPolicy: 'ask',
  theme: 'dark',
  compactTopbar: false,
  pageBorderRadius: true,
  devtoolsDefaultDock: 'right',
  devtoolsDefaultViewport: 'auto',
  devtoolsRightSize: DEVTOOLS_RIGHT_SIZE.default,
  devtoolsBottomSize: DEVTOOLS_BOTTOM_SIZE.default,
  maxRunning: 8,
  idleHibernateMinutes: 10,
  leaseTtlMs: 60_000,
  showControlPill: true,
};

const CONTROL_POLICIES: readonly ControlPolicy[] = ['ask', 'agent-created', 'auto'];
const PLUGIN_POLICIES: readonly PluginPolicy[] = ['ask', 'auto'];
const APPROVAL_MODES: readonly ApprovalMode[] = ['inherit', 'ask', 'auto'];
const THEMES: readonly ThemePreference[] = ['dark', 'light', 'system'];
const DOCKS: readonly DevToolsDockMode[] = ['right', 'bottom', 'detach'];
const VIEWPORTS: readonly ViewportPresetId[] = ['auto', 'desktop-1440', 'laptop-1280', 'mobile-390'];

function boolPref(raw: string | undefined, fallback: boolean): boolean {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

function intPref(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

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
    theme:
      typeof raw.theme === 'string' && (THEMES as readonly string[]).includes(raw.theme)
        ? (raw.theme as ThemePreference)
        : DEFAULT_APP_SETTINGS.theme,
    compactTopbar: boolPref(raw.compactTopbar, DEFAULT_APP_SETTINGS.compactTopbar),
    pageBorderRadius: boolPref(raw.pageBorderRadius, DEFAULT_APP_SETTINGS.pageBorderRadius),
    devtoolsDefaultDock:
      typeof raw.devtoolsDefaultDock === 'string' && (DOCKS as readonly string[]).includes(raw.devtoolsDefaultDock)
        ? (raw.devtoolsDefaultDock as DevToolsDockMode)
        : DEFAULT_APP_SETTINGS.devtoolsDefaultDock,
    devtoolsDefaultViewport:
      typeof raw.devtoolsDefaultViewport === 'string' &&
      (VIEWPORTS as readonly string[]).includes(raw.devtoolsDefaultViewport)
        ? (raw.devtoolsDefaultViewport as ViewportPresetId)
        : DEFAULT_APP_SETTINGS.devtoolsDefaultViewport,
    devtoolsRightSize: intPref(
      raw.devtoolsRightSize,
      DEFAULT_APP_SETTINGS.devtoolsRightSize,
      DEVTOOLS_RIGHT_SIZE.min,
      DEVTOOLS_RIGHT_SIZE.maxConfig,
    ),
    devtoolsBottomSize: intPref(
      raw.devtoolsBottomSize,
      DEFAULT_APP_SETTINGS.devtoolsBottomSize,
      DEVTOOLS_BOTTOM_SIZE.min,
      DEVTOOLS_BOTTOM_SIZE.maxConfig,
    ),
    maxRunning: intPref(raw.maxRunning, DEFAULT_APP_SETTINGS.maxRunning, 0, 32),
    idleHibernateMinutes: intPref(raw.idleHibernateMinutes, DEFAULT_APP_SETTINGS.idleHibernateMinutes, 0, 240),
    leaseTtlMs: intPref(raw.leaseTtlMs, DEFAULT_APP_SETTINGS.leaseTtlMs, 30_000, 600_000),
    showControlPill: boolPref(raw.showControlPill, DEFAULT_APP_SETTINGS.showControlPill),
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
