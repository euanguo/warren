// ---------------------------------------------------------------------------
// 插件清单、运行时、挂载点与事件总线
// ---------------------------------------------------------------------------

/** 插件运行时。`sandbox` 是 vm 里的能力插件，`host` 是独立 Node 进程里的全权插件。 */
export type PluginRuntime = 'sandbox' | 'host';

/** 插件状态机。`starting` 表示后台激活中，`needs-configuration` 由插件自己抛 NeedsConfiguration 触发。 */
export type PluginStatus = 'disabled' | 'starting' | 'running' | 'error' | 'needs-configuration';

export type PluginSettingType = 'string' | 'number' | 'boolean' | 'select' | 'secret';

export interface PluginSettingDescriptor {
  key: string;
  type: PluginSettingType;
  label: string;
  description?: string;
  default?: string | number | boolean;
  /** type=select 的候选值 */
  options?: string[];
}

/** 设置项的当前值。secret 永远只有 configured，没有 value。 */
export interface PluginSettingValue {
  key: string;
  label: string;
  type: PluginSettingType;
  description?: string;
  options?: string[];
  value?: string | number | boolean;
  configured: boolean;
}

/** 插件声明要挂到界面的位置。界面由 warren 自己的组件渲染，插件只声明。 */
export type PluginSurfaceKind =
  | 'railPage'
  | 'settingsSection'
  | 'envAction'
  | 'inspectorTab'
  | 'envBadge'
  | 'popover'
  | 'commandBarAction'
  | 'statusBadge';

export interface PluginSurfaceDecl {
  kind: PluginSurfaceKind;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  /** kind=envAction 时：点击后执行的插件命令 */
  command?: string;
  /** kind=railPage 时：`warren-plugin://<id>/<path>` 的路径段 */
  path?: string;
  /** 可选快捷键提示（例如 commandBarAction / popover） */
  shortcut?: string;
}

export interface PluginCommandDecl {
  name: string;
  summary: string;
}

export interface PluginContributes {
  commands: PluginCommandDecl[];
  settings: PluginSettingDescriptor[];
  surfaces: PluginSurfaceDecl[];
  /** 插件前端允许调用的后端方法白名单 */
  rpc: string[];
}

export interface PluginSkillDecl {
  /** 包内相对路径，默认指向插件的 SKILL.md */
  entry: string;
  /** 给主 Skill 索引表用的一句话摘要（≤240 字符） */
  summary?: string;
  /** 触发场景/关键词，帮助外部 Agent 决定何时按需读取本插件 Skill */
  triggers?: string[];
  /** 可选附带参考文档（包内相对路径，最多 8 个） */
  references?: string[];
}

export interface PluginSkillSummary {
  entry?: string;
  summary: string;
  triggers: string[];
  references: string[];
  hasExplicitSkill: boolean;
  exposed: boolean;
  bytes: number;
  sha256: string;
}

export interface PluginSkillDocument extends PluginSkillSummary {
  pluginId: string;
  pluginName: string;
  version: string;
  markdown: string;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  /** npm 包名；插件代码的唯一来源 */
  packageName: string;
  description?: string;
  /** runtime=sandbox 的后端入口 */
  server?: string;
  runtime: PluginRuntime;
  /** runtime=host 时的子进程入口 */
  host?: string;
  /** 插件前端 bundle（P1 的挂载页面靠它） */
  app?: string;
  icon?: string;
  permissions: string[];
  granted: string[];
  needsConfirmation: string[];
  enabled: boolean;
  /** 是否允许将该插件的 Skill 自动注入到外部 Agent 的 Warren Skill 目录（默认 true）。 */
  skillExposed: boolean;
  /** 插件自带或兜底生成的 Skill 摘要（元数据，不含完整正文）。 */
  skill?: PluginSkillSummary;
  status: PluginStatus;
  statusDetail?: string;
  contributes: PluginContributes;
  settings: PluginSettingValue[];
  dir: string;
  installedAt: string;
  /** 插件目录内容的 sha256（安装时算，加载时校验） */
  digest: string;
  /** 安装源：path: / npm: / git: */
  source: string;
  /** 实际解析结果：版本号 / commit / 绝对路径 */
  resolved: string;
}

export interface PluginLogEntry {
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/** 插件后端推给渲染层的即时消息（不落盘，前端收到后自己重新取数）。 */
export interface PluginSignal {
  pluginId: string;
  channel: string;
  payload: unknown;
}

export interface PluginRpcResponse {
  ok: boolean;
  result?: unknown;
  code?: string;
  message?: string;
}

/**
 * 插件 rpc 的**调用方**。
 *
 * 出现在 RPC 边界上（渲染层经 `plugin:rpc` IPC 是 `ui`，CLI / agent 经 `plugin.rpc`
 * 是 `agent`），所以放 shared。插件可以用它做「只给人看的通道」——
 * 账号插件的 `reveal` 就只允许 `ui`，agent 通道永远拿不到明文。
 *
 * 这不是安全边界（同用户的进程本来就能调 IPC），它防的是「agent 顺手把明文写进上下文」。
 */
export type PluginRpcCaller = 'ui' | 'agent';

export type PluginBusEventType =
  'nav.committed' | 'lease.changed' | 'tab.created' | 'tab.activated' | 'space.switched' | 'env.status' | 'net.hit';

export interface PluginEventFilter {
  environmentId?: string;
  types?: PluginBusEventType[];
}

export interface PluginBusEvent {
  type: PluginBusEventType;
  environmentId: string;
  at: string;
  payload: Record<string, unknown>;
}
