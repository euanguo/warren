// ---------------------------------------------------------------------------
// 审批策略与应用设置（docs/APPROVAL-EMBED-MEMORY-PLAN.md）
// ---------------------------------------------------------------------------

import type { SkinColorOverrides } from '../skin.ts';
import type { DevToolsDockMode, ViewportPresetId } from './common.ts';
import type { LruEvictAction } from './memory.ts';

/**
 * 全局控制权策略。
 *
 * - `ask`：人持控制权时，agent 的写操作报 ENV_BUSY（默认，也是本项目一贯的行为）
 * - `agent-created`：**AI 建的环境**上，agent 可以直接从人手里接管
 * - `auto`：任何环境上 agent 都能接管
 */
export type ControlPolicy = 'ask' | 'agent-created' | 'auto';

/** 插件能力确认策略。`auto` = confirm 层的权限视同已授予。 */
export type PluginPolicy = 'ask' | 'auto';

export type ThemePreference = 'dark' | 'light' | 'system';

/**
 * 应用级设置。
 *
 * **只有界面（IPC）能写** —— agent 能给自己放行的话，审批这道门就等于不存在。
 * CLI / RPC 只能读。见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3.4。
 */
export interface AppSettings {
  controlPolicy: ControlPolicy;
  pluginPolicy: PluginPolicy;
  theme?: ThemePreference;
  /** 配色皮肤 ID（仅影响配色板，不改变基础结构 Token）。 */
  skin?: string;
  /** 可选配色微调覆写（仅允许 12 个 Hex 配色键，任何结构键均会被忽略）。 */
  skinOverrides?: SkinColorOverrides;
  compactTopbar?: boolean;
  pageBorderRadius?: boolean;
  devtoolsDefaultDock?: DevToolsDockMode;
  devtoolsDefaultViewport?: ViewportPresetId;
  devtoolsRightSize?: number;
  devtoolsBottomSize?: number;
  maxRunning?: number;
  idleHibernateMinutes?: number;
  /** 内存软水位阈值（MB，0 = 不限；超出后按压力策略优先休眠后台非保护环境）。 */
  memorySoftLimitMb?: number;
  /** 后台非激活标签闲置自动睡眠阈值（分钟，0 = 关闭）。 */
  tabSleepMinutes?: number;
  /** 启动或唤醒环境时仅实例化当前激活标签，其余保持休眠占位。 */
  lazyRestoreTabs?: boolean;
  /** 后台不可见且无 Agent 租约的标签启用 Chromium 降频。 */
  throttleBackgroundTabs?: boolean;
  /** 并发运行环境达到上限时的 LRU 动作：优先休眠（保无缝唤醒）或直接停止。 */
  lruEvictAction?: LruEvictAction;
  /** 永不自动休眠/回收的环境 ID 白名单。 */
  pinnedEnvIds?: string[];
  leaseTtlMs?: number;
  showControlPill?: boolean;
}

export interface SystemDiagnosticCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export interface SystemDiagnosticsReport {
  generatedAt: string;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  dataDir: string;
  checks: SystemDiagnosticCheck[];
}

/** 自带 Skill 在一个 agent 目录里的状态。跨 IPC 边界，所以放这里。 */
export interface AgentSkillStatus {
  id: string;
  label: string;
  /** 装到哪儿（绝对路径，界面上要显示给人看） */
  path: string;
  installed: boolean;
  /** 与当前合成版 SKILL.md（含已启用插件）的 SHA-256 是否一致 */
  upToDate?: boolean;
  /** 已安装版本的 SHA-256 摘要 */
  sha256?: string;
  /** 当前已注入的启用插件 Skill 列表 */
  enabledPlugins?: Array<{ id: string; name: string; version: string; skillSha: string }>;
}
