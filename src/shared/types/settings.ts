// ---------------------------------------------------------------------------
// 审批策略与应用设置（docs/APPROVAL-EMBED-MEMORY-PLAN.md）
// ---------------------------------------------------------------------------

/** 谁建的这个环境。 */
export type Creator = 'human' | 'agent';

/** 环境级审批策略。`inherit` = 跟随全局。 */
export type ApprovalMode = 'inherit' | 'ask' | 'auto';

/**
 * 全局控制权策略。
 *
 * - `ask`：人持控制权时，agent 的写操作报 ENV_BUSY（默认，也是本项目一贯的行为）
 * - `agent-created`：**AI 建的环境**上，agent 可以直接从人手里接管
 * - `auto`：任何环境上 agent 都能接管
 */
export type ControlPolicy = 'ask' | 'agent-created' | 'auto';

import type { DevToolsDockMode } from './ui.ts';
import type { ViewportPresetId } from './browser.ts';

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
  compactTopbar?: boolean;
  pageBorderRadius?: boolean;
  devtoolsDefaultDock?: DevToolsDockMode;
  devtoolsDefaultViewport?: ViewportPresetId;
  maxRunning?: number;
  idleHibernateMinutes?: number;
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

/** Vault 对外只给这个摘要，没有读取明文的通道。 */
export interface CredentialSummary {
  ref: string;
  provider: string;
  label: string;
  usernameHint: string;
  /** 这条凭据现在还能不能解开（旧密钥写的记录永远解不开，见 vault/store.ts）。 */
  available: boolean;
  createdAt: string;
  updatedAt: string;
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
