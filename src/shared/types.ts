export type EnvironmentStatus = 'stopped' | 'starting' | 'running' | 'dormant' | 'error';
export type ControlOwner = 'none' | 'agent' | 'human';
export type SpaceId = 'person' | 'agent';

/**
 * 一个标签的运行态。
 *
 * 标签活在 Environment 里面：同一个 Environment 的所有标签共用它的
 * session / 代理 / 登录态。跨 IPC 边界，所以放 shared。
 */
export interface TabState {
  id: string;
  /** 这个标签属于哪个 Space。两个 Space 共享 Environment 的 Session。 */
  space: SpaceId;
  title: string;
  url: string;
  /**
   * 图标，**data URL**（不是远程地址）。
   *
   * 渲染层 CSP 只允许 `img-src 'self' data:`，而且图标要走环境自己的 session
   * （代理 / Cookie）去取，所以由主进程取好再转成 data URL 传过来。
   */
  favicon?: string;
  loading: boolean;
  audible: boolean;
  /** 人把这个标签静音了没。`audible` 是页面在响，这个是我们的开关。 */
  muted: boolean;
  /**
   * 主框架加载失败的原因（`did-fail-load`）。导航重新开始时清掉。
   *
   * 页面挂了但标签还在，所以这是**标签级**的字段：环境从激活标签派生出一个 `error`，
   * 界面才能说清「它在跑，但页面是坏的」。
   */
  error?: string;
  createdAt: string;
}

/** 标签寻址：1-based 序号（和 ⌘1..9 一致）或 tabId。IPC / CLI / UI 共用。 */
export type TabRef = number | string;

/**
 * 分组。只影响界面的组织方式，不影响运行时——
 * 环境与代理的隔离关系不因分组改变。
 */
export interface Group {
  id: string;
  name: string;
  /** 分组在侧栏中的排序，升序 */
  order: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 审批策略（docs/APPROVAL-EMBED-MEMORY-PLAN.md）
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

/** 插件能力确认策略。`auto` = confirm 层的权限视同已授予。 */
export type PluginPolicy = 'ask' | 'auto';

/**
 * 应用级设置。
 *
 * **只有界面（IPC）能写** —— agent 能给自己放行的话，审批这道门就等于不存在。
 * CLI / RPC 只能读。见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3.4。
 */
export interface AppSettings {
  controlPolicy: ControlPolicy;
  pluginPolicy: PluginPolicy;
}

export interface Environment {
  id: string;
  name: string;
  status: EnvironmentStatus;
  storagePath: string;
  proxy?: string;
  /** 这个环境额外信任的 CA（PEM 文件路径）。见 docs/WHISTLE-PLUGIN-PLAN.md §3.3 */
  trustedCa?: string;
  /** 谁建的。审批策略里的「AI 创建的环境自动放行」看它。 */
  createdBy: Creator;
  /** 这个环境的审批策略；undefined = 跟随全局。见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3 */
  approval?: ApprovalMode;
  startUrl?: string;
  headed: boolean;
  currentUrl?: string;
  title?: string;
  owner: ControlOwner;
  leaseId?: string;
  leaseExpiresAt?: number;
  error?: string;
  /** 所属分组；undefined = 未分组 */
  groupId?: string;
  /** 组内排序，升序 */
  order: number;
  /** 运行中时的标签列表；未运行时 undefined */
  tabs?: TabState[];
  /** 运行中时当前激活的标签 */
  activeTabId?: string;
  /** 当前显示的 Space（主进程是唯一真相源） */
  activeSpaceId: SpaceId;
  /** 两个 Space 的运行态；环境未启动时为空数组 */
  spaces: EnvironmentSpace[];
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentSpace {
  id: SpaceId;
  label: string;
  owner: ControlOwner;
  tabs: TabState[];
  activeTabId?: string;
}

/**
 * 插件前端只读 host API 的窄视图。
 *
 * **不要加** leaseId / leaseExpiresAt / storagePath / tabs：这些是主进程内部状态，
 * 插件前端只需要看环境的身份和当前页面。加字段等于改这条边界，想清楚再加。
 */
export interface HostEnvironmentSummary {
  id: string;
  name: string;
  status: EnvironmentStatus;
  proxy?: string;
  owner: ControlOwner;
  groupId?: string;
  currentUrl?: string;
  title?: string;
  error?: string;
}

export interface EnvironmentConfig {
  id: string;
  name: string;
  storagePath: string;
  proxy?: string;
  /**
   * 这个环境额外信任的 CA（PEM 文件路径）。
   *
   * 只有**这个环境**的 Session 会装 `setCertificateVerifyProc`，且只放行由这张 CA
   * 签发的叶子证书——不是「关掉证书校验」。用途是让代理的 MITM 生效（见
   * docs/WHISTLE-PLUGIN-PLAN.md §3.3）。空 = 走 Chromium 默认校验。
   */
  trustedCa?: string;
  /** 谁建的。`env.create` 走 RPC 记 agent、走界面 IPC 记 human。 */
  createdBy: Creator;
  /** `undefined` = 跟随全局策略。**只有界面能改**（见计划 §3.4）。 */
  approval?: ApprovalMode;
  startUrl?: string;
  headed: boolean;
  groupId?: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventRecord {
  id: string;
  environmentId?: string;
  type: string;
  actor: 'system' | 'agent' | 'human';
  message: string;
  createdAt: string;
}

/** 跨环境共享的地址历史；候选列表与主进程 SQLite 用同一形状。 */
export interface UrlHistoryEntry {
  url: string;
  visitCount: number;
  lastVisitedAt: string;
}

export interface RpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * lease 被拒的原因。
 *
 * `ENV_NOT_LEASED` / `CONTROL_REVOKED` 这两个码以前盖住五种情况，agent 分不清「重取」还是「等人交还」。
 * 错误码保持不变（老调用方在用），额外带这个 reason。出现在 RPC 边界上，所以放 shared。
 */
export type LeaseDenialReason = 'never_leased' | 'expired' | 'superseded' | 'user_takeover' | 'wrong_space';

export interface RpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    /** 只有 lease 类错误带。 */
    reason?: LeaseDenialReason;
    /** 只有 `reason === 'expired'` 带：过期时刻（epoch ms）。 */
    expiredAt?: number;
  };
}

// ---------------------------------------------------------------------------
// 浏览器观察与遥测
// ---------------------------------------------------------------------------

/** 可访问性树节点。Agent 的主观察通道，比截图便宜且结构化。 */
export interface AxNode {
  role: string;
  name: string;
  backendNodeId?: number;
  value?: string;
  /** 本次 snapshot 分配的稳定引用（如 `@21`）。导航后失效，见 `TARGET_STALE`。 */
  ref?: string;
  description?: string;
  disabled?: boolean;
  /** AX 的状态都在 `properties[]` 里（顶层只有 role/name/value），见 snapshot.ts 的 statesOf。 */
  checked?: boolean | 'mixed';
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean | 'mixed';
  level?: number;
  readonly?: boolean;
  required?: boolean;
  focused?: boolean;
  valuetext?: string;
  /** `includeActionMarks` 打开时按 role 标注的可执行动作。 */
  actions?: Array<'click' | 'fill' | 'select' | 'focus'>;
  /** `includeStableLocator` 打开时的稳定定位串（`loc=role:…` 或 `@ref` 回退）。 */
  locator?: string;
  /** 节点所属 frame（多 frame 时才有，便于判断它在不在主文档里）。 */
  frameId?: string;
}

export interface SnapshotResult {
  url: string;
  title: string;
  nodes: AxNode[];
}

export interface ConsoleEntry {
  level: string;
  message: string;
  line: number;
  source: string;
  at: string;
  /** 哪条标签记的（加法，老数据没有）。 */
  tabId?: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  resourceType: string;
  at: string;
  /** 哪条标签记的（加法，老数据没有）。 */
  tabId?: string;
}

/** 页面导航状态。工具栏据此决定前进/后退是否可用。 */
export interface NavigationState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/**
 * 页面导航。导航是写操作，所以这些动作全部走控制权门控（见 PRD 5.3）。
 *
 * 用可辨识联合而不是 `action + url?`：`goto` 必须带 URL，类型上就排除掉
 * 「goto 但没给地址」这种非法组合。
 */
export type NavigationAction =
  { kind: 'back' } | { kind: 'forward' } | { kind: 'reload' } | { kind: 'hardReload' } | { kind: 'goto'; url: string };

/**
 * 应用自有的浏览器快捷键。
 *
 * `devtools` / `inspector` / `find` / `zoom*` 等由主进程统一收集（页面 `before-input-event`
 * 与应用菜单加速键双通道归一），渲染层与协调器只认 shortcut 本身。
 */
export type BrowserShortcut =
  | 'devtools'
  | 'inspector'
  | 'newTab'
  | 'closeTab'
  | 'reopenTab'
  | 'reload'
  | 'hardReload'
  | 'focusAddress'
  | 'commandBar'
  | 'find'
  | 'findNext'
  | 'findPrev'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'print'
  | 'savePage'
  | { selectTab: number };

export type DevToolsDockMode = 'right' | 'bottom' | 'detach';

export type ViewportPresetId = 'auto' | 'desktop-1440' | 'laptop-1280' | 'mobile-390';

export interface NativeMenuItem {
  id?: string;
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox' | 'submenu';
  enabled?: boolean;
  checked?: boolean;
  accelerator?: string;
  submenu?: NativeMenuItem[];
}

export type OverlayRequest =
  | { kind: 'create-env'; initialGroupId?: string }
  | { kind: 'edit-env'; environment: Environment }
  | { kind: 'create-group' }
  | { kind: 'rename'; title: string; label: string; initialValue: string }
  | { kind: 'confirm'; title: string; description: string; confirmLabel?: string; destructive?: boolean }
  | { kind: 'command-bar'; initialQuery?: string };

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-end' | 'top-start';

export interface PopoverOpenOptions {
  id: string;
  anchorRect: ViewportRect;
  size: { width: number; height: number };
  placement?: PopoverPlacement;
  /** 地址栏联想设为 false，避免抢走输入框键盘焦点；⌘F 查找条设为 true 接收打字。 */
  focusable?: boolean;
  beyondWindow?: boolean;
  props?: Record<string, unknown>;
}

export interface PopoverActionEvent {
  id: string;
  action: string;
  payload?: unknown;
}

export interface FindInPageResult {
  envId: string;
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

export interface DownloadItemInfo {
  downloadId: string;
  envId: string;
  filename: string;
  url: string;
  savePath: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  startedAt: string;
}

export interface DomainPref {
  envId: string;
  origin: string;
  zoomFactor: number;
  viewportPreset?: ViewportPresetId;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 浏览器能力（Ego / Playwright 对标，全量一次落地）
// ---------------------------------------------------------------------------

/** Agent 元素定位。老对象形式全保留；字符串走选择器解析（见 `browser/target.ts`）。 */
export type TargetInput =
  | { kind: 'role'; role: string; name?: string }
  | { kind: 'text'; text: string }
  | { kind: 'label'; text: string }
  | { kind: 'selector'; selector: string }
  | { kind: 'ref'; ref: string }
  | { kind: 'xpath'; xpath: string }
  | string;

export type SnapshotScope = 'viewport' | 'full_page' | 'subtree';

export interface SnapshotOptions {
  scope?: SnapshotScope;
  /** subtree 的根（snapshot ref，如 `@12`）。 */
  root?: string;
  limit?: number;
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  /** 只返回可交互角色（button/link/textbox/...）。 */
  interactiveOnly?: boolean;
  /** 角色白名单；与 interactiveOnly 同时给时取交集。 */
  roles?: string[];
  /** CSS 选择器范围：返回该元素所在 AX 子树的节点。 */
  selector?: string;
}

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  /** 默认落盘路径。给了它就不再返回 base64，只返回文件元数据。 */
  path?: string;
  /** 显式要求把内容带回调用方。默认 false，避免 agent 输出几十万 token。 */
  encoding?: 'base64';
}

export interface ScreenshotResult {
  path?: string;
  bytes: number;
  sha256: string;
  format: 'png' | 'jpeg';
  width?: number;
  height?: number;
  base64?: string;
  /** 实际取图通道；老调用方可忽略。 */
  source?: 'cdp' | 'electron';
}

export type WaitUntil = 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

export interface NavigateOptions {
  referer?: string;
  timeoutMs?: number;
  waitUntil?: WaitUntil;
}

export type UrlMatcher = string | { regex: string } | { glob: string };

export type SelectorState = 'attached' | 'detached' | 'visible' | 'hidden' | 'enabled' | 'disabled';

export type LoadState = 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

export type WaitEventKind = 'popup' | 'download' | 'dialog' | 'fileChooser';

/** 老三种 predicate 原样保留；新增四种。 */
export interface WaitPredicate {
  text?: string;
  role?: string;
  selector?: string;
  url?: UrlMatcher;
  function?: string;
  functionArg?: unknown;
  loadState?: LoadState;
  event?: WaitEventKind;
}

export interface ClickOptions {
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  delay?: number;
  position?: { x: number; y: number };
  /** click/drag 路径合成的步数；`mouseMove` 不认这个字段（见 F10）。 */
  steps?: number;
  timeoutMs?: number;
  label?: string;
  /** 不等待本次点击触发的导航。SPA 链接用它避免 60s RPC 超时。 */
  noWaitAfter?: boolean;
  /** 等待导航提交的上限；只在 noWaitAfter=false 时生效。 */
  navigationTimeoutMs?: number;
}

export type NavigationReceipt = 'none' | 'started' | 'navigated' | 'timeout';

export interface FillOptions {
  clearFirst?: boolean;
  timeoutMs?: number;
}

export type SelectValue =
  | string
  | { value?: string; label?: string; index?: number }
  | Array<string | { value?: string; label?: string; index?: number }>
  | null;

export interface PressOptions {
  delay?: number;
  timeoutMs?: number;
}

/** 写动作统一收据：只报派发 + 即时 popup/dialog，不验证应用态。 */
export interface ActionReceipt {
  popups?: Array<{ tabId: string; index: number; url: string; title?: string }>;
  dialog?: { type: string; message: string; url: string } | null;
}

export interface PageInfo {
  url: string;
  title: string;
  loading: boolean;
  dialog: { type: string; message: string; url: string } | null;
  tab: { id: string; index: number };
  env: string;
}

export type PageEvent =
  | { kind: 'dialog'; type: string; message: string; url: string; at: string }
  | { kind: 'popup'; tabId: string; index: number; url: string; at: string }
  | { kind: 'download'; downloadId: string; url: string; filename: string; at: string }
  | { kind: 'fileChooser'; frameId?: string; mode?: string; backendNodeId?: number; at: string };

export interface DownloadStatus {
  downloadId: string;
  url: string;
  filename: string;
  state: 'pending' | 'completed' | 'cancelled' | 'failed';
  receivedBytes: number;
  totalBytes: number;
  path?: string;
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  cache?: RequestCache;
  timeoutMs?: number;
  credentials?: 'omit' | 'include';
  saveAs?: string;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

// ---------------------------------------------------------------------------
// Vault 与插件
// ---------------------------------------------------------------------------

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

/** 插件运行时。`sandbox` 是 vm 里的能力插件，`host` 是独立 Node 进程里的全权插件。 */
export type PluginRuntime = 'sandbox' | 'host';

/** 插件状态机。`needs-configuration` 由插件自己抛 NeedsConfiguration 触发。 */
export type PluginStatus = 'disabled' | 'running' | 'error' | 'needs-configuration';

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
export type PluginSurfaceKind = 'railPage' | 'settingsSection' | 'envAction' | 'inspectorTab' | 'envBadge';

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

// ---------------------------------------------------------------------------
// 网络拦截（docs/NET-INTERCEPT-PLAN.md）
// ---------------------------------------------------------------------------

/**
 * 命中规则后对请求做的事。规则挂在 Environment 自己的 session 上（per-session），
 * 所以这些类型只在主进程与渲染层之间流动，放 shared。
 */
export type NetAction =
  | {
      type: 'mock';
      status: number;
      body: string;
      contentType?: string;
      headers?: Record<string, string>;
    }
  | { type: 'block' }
  | { type: 'redirect'; to: string }
  | { type: 'setRequestHeaders'; headers: Record<string, string> }
  | { type: 'setResponseHeaders'; headers: Record<string, string> }
  | { type: 'delay'; ms: number }
  /** 临时放行：什么都不改，直接走真实网络。用来在别的规则命中的时候开一个口子。 */
  | { type: 'passthrough' };

export interface NetRule {
  id: string;
  enabled: boolean;
  /** 大的先命中；相同则按规则表顺序。 */
  priority?: number;
  match: { url: string; isRegex?: boolean; method?: string };
  action: NetAction;
  /**
   * 过期时间（epoch ms）。到了就不再命中，并**从规则表里摘掉**。
   *
   * 只有「临时放行」会带它：`warren net passthrough` 的意义就是「这 30 秒别拦」，
   * 留一条永远不生效的规则在表里只会让人以为拦截坏了。
   */
  expiresAt?: number;
}

/** 一条命中记录。请求/响应头一律脱敏后才落进这里（见 interceptor.ts 的 redactHeaders）。 */
export interface NetHit {
  at: string;
  method: string;
  url: string;
  status: number;
  /** 命中的规则 id；没有命中（透传）时为 undefined。 */
  ruleId?: string;
  /** 规则动作类型，或 `passthrough`。 */
  action: string;
  /** 出错时的说明（透传失败 / 规则执行失败）。 */
  note?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// preload 暴露给渲染层的 IPC 面
// ---------------------------------------------------------------------------

/**
 * 页面视图的矩形。原生视图不遵守 DOM 布局，位置只能由渲染层实测后报给主进程。
 */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Cookie 的**窄视图**：只有元数据，**没有 value**。
 *
 * 这是 `storage.cookie.port` 那条「只搬运不返回」通道的对外形状，
 * 也是检查器「存储」页显示的东西。**加字段等于改这道边界**，想清楚再加。
 */
export interface CookieSummary {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** 会话 cookie（没有过期时间）。 */
  session: boolean;
  expirationDate?: number;
}

/** 自带 Skill 在一个 agent 目录里的状态。跨 IPC 边界，所以放这里。 */
export interface AgentSkillStatus {
  id: string;
  label: string;
  /** 装到哪儿（绝对路径，界面上要显示给人看） */
  path: string;
  installed: boolean;
}

export interface EnvApi {
  /**
   * 宿主平台。渲染层用它决定要不要给 macOS 红绿灯留位——窗口是
   * `titleBarStyle: 'hiddenInset'`，红绿灯浮在内容上，不留位就会被盖住。
   */
  readonly platform: NodeJS.Platform;
  list(): Promise<Environment[]>;
  create(input: { id: string; proxy?: string; startUrl?: string; headed?: boolean }): Promise<Environment>;
  start(id: string): Promise<Environment>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  update(
    id: string,
    patch: {
      name?: string;
      proxy?: string;
      startUrl?: string;
      headed?: boolean;
      /** `null` = 恢复「跟随全局」。**只有这条 IPC 能带它**（计划 §3.4）。 */
      approval?: ApprovalMode | null;
    },
  ): Promise<Environment>;
  /** 审批策略。读谁都行；写只有这条 IPC —— RPC 那边没有写通道。 */
  settings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  moveToGroup(id: string, groupId?: string): Promise<Environment>;
  groups(): Promise<Group[]>;
  groupCreate(name: string): Promise<Group>;
  groupRename(id: string, name: string): Promise<Group>;
  groupRemove(id: string): Promise<{ detached: number }>;
  groupCollapse(id: string, collapsed: boolean): Promise<Group>;
  select(id: string): Promise<void>;
  selected(): Promise<string | null>;
  takeover(id: string, space: SpaceId): Promise<unknown>;
  release(id: string, space: SpaceId): Promise<void>;
  events(id?: string): Promise<EventRecord[]>;
  snapshot(id: string, space: SpaceId): Promise<SnapshotResult>;
  console(id: string): Promise<ConsoleEntry[]>;
  network(id: string): Promise<NetworkEntry[]>;
  /** 当前环境的 cookie 元数据（没有值）。检查器的「存储」页用。 */
  cookies(id: string): Promise<CookieSummary[]>;
  /** 网络拦截：规则表 + 命中数（读，不需要控制权）。 */
  netRules(id: string): Promise<{ rules: NetRule[]; hits: number; recording: boolean; replaying: boolean }>;
  netHits(id: string, limit?: number): Promise<NetHit[]>;
  /** 人在界面上开关规则。写操作，走主进程的写门控。 */
  netRuleSet(id: string, ruleId: string, enabled: boolean): Promise<NetRule>;
  netRuleRemove(id: string, ruleId: string): Promise<{ removed: boolean }>;
  navState(id: string, space: SpaceId): Promise<NavigationState | null>;
  humanNavigate(id: string, space: SpaceId, action: NavigationAction): Promise<NavigationState>;
  /** 所有环境共用的地址历史联想。空 query 返回最近访问。 */
  historySuggest(query: string, limit?: number): Promise<UrlHistoryEntry[]>;
  /** 打开或切换该环境当前标签的 Chrome DevTools（支持停靠或独立窗）。 */
  openDevTools(id: string, space: SpaceId, dock?: DevToolsDockMode): Promise<void>;
  closeDevTools(id: string, space: SpaceId): Promise<void>;
  setDevToolsDock(dock: DevToolsDockMode, size?: number): Promise<void>;
  getDevToolsState(): Promise<{ open: boolean; dock: DevToolsDockMode; size: number }>;
  findInPage(
    id: string,
    space: SpaceId,
    text: string,
    options?: { forward?: boolean; findNext?: boolean },
  ): Promise<void>;
  stopFindInPage(id: string, space: SpaceId): Promise<void>;
  onFindResult(callback: (result: FindInPageResult) => void): () => void;
  setZoom(id: string, space: SpaceId, mode: 'in' | 'out' | 'reset' | number): Promise<{ factor: number }>;
  getZoom(id: string, space: SpaceId): Promise<{ factor: number }>;
  setViewportPreset(id: string, space: SpaceId, preset: ViewportPresetId): Promise<{ preset: ViewportPresetId }>;
  getViewportPreset(id: string, space: SpaceId): Promise<{ preset: ViewportPresetId }>;
  onTargetUrl(callback: (payload: { envId: string; url: string }) => void): () => void;
  downloads(id?: string): Promise<DownloadItemInfo[]>;
  revealDownload(downloadId: string): Promise<void>;
  printPage(id: string, space: SpaceId): Promise<void>;
  savePage(id: string, space: SpaceId): Promise<{ saved: boolean; path?: string }>;
  popupMenu(items: NativeMenuItem[], position?: { x: number; y: number }): Promise<string | null>;
  openOverlay<T = unknown>(request: OverlayRequest): Promise<T | null>;
  getOverlayState(): Promise<OverlayRequest | null>;
  resolveOverlay(result: unknown): Promise<void>;
  onOverlayState(callback: (request: OverlayRequest | null) => void): () => void;
  openPopover(options: PopoverOpenOptions): Promise<void>;
  updatePopover(id: string, options: Partial<PopoverOpenOptions>): Promise<void>;
  closePopover(id?: string): Promise<void>;
  getPopoverState(): Promise<{ id: string; props: Record<string, unknown> } | null>;
  dispatchPopoverAction(event: PopoverActionEvent): Promise<void>;
  onPopoverState(callback: (payload: { id: string; props: Record<string, unknown> } | null) => void): () => void;
  onPopoverAction(callback: (event: PopoverActionEvent) => void): () => void;
  onPopoverDismissed(callback: (payload: { id: string; reason: string }) => void): () => void;
  onBrowserShortcut(callback: (shortcut: BrowserShortcut) => void): () => void;
  spaceSelect(id: string, space: SpaceId): Promise<void>;
  tabCreate(id: string, space: SpaceId, url?: string): Promise<TabState>;
  tabSelect(id: string, space: SpaceId, ref: TabRef): Promise<TabState>;
  tabClose(id: string, space: SpaceId, ref: TabRef): Promise<void>;
  /** 关掉除这个标签以外的全部（右键菜单「关闭其他」）。 */
  tabCloseOthers(id: string, space: SpaceId, ref: TabRef): Promise<void>;
  /** 关掉这个标签右边的全部（右键菜单「关闭右侧」）。 */
  tabCloseRight(id: string, space: SpaceId, ref: TabRef): Promise<void>;
  /** 拖拽排序：把第 from 个（0-based）挪到第 to 个。 */
  tabReorder(id: string, space: SpaceId, from: number, to: number): Promise<TabState[]>;
  /** ⌘⇧T：重新打开最近关掉的那个标签。 */
  tabReopen(id: string, space: SpaceId): Promise<TabState>;
  /** 静音开关。不是页面内容变更，所以不受控制权限制。 */
  tabMute(id: string, space: SpaceId, ref: TabRef, muted: boolean): Promise<TabState>;
  vault(): Promise<{ available: boolean; credentials: CredentialSummary[] }>;
  vaultRemove(ref: string): Promise<{ removed: boolean }>;
  /** 自带 Skill 在各个 agent 目录里的安装状态（见 src/main/agent-integration.ts）。 */
  agentSkills(): Promise<AgentSkillStatus[]>;
  /** 把自带 Skill 装进指定的 agent 目录。返回落盘路径。 */
  agentInstallSkill(targetId: string): Promise<{ path: string }>;
  plugins(): Promise<InstalledPlugin[]>;
  pluginEnable(id: string): Promise<InstalledPlugin>;
  pluginDisable(id: string): Promise<void>;
  pluginGrant(id: string, permissions: string[]): Promise<InstalledPlugin>;
  pluginInstall(source?: string): Promise<{ cancelled: boolean; plugin?: InstalledPlugin }>;
  pluginReload(id: string): Promise<InstalledPlugin>;
  pluginLogs(id: string, limit?: number): Promise<PluginLogEntry[]>;
  pluginConfigSet(id: string, key: string, value: string): Promise<InstalledPlugin>;
  /** 调插件后端的方法（白名单在清单的 contributes.rpc 里）。 */
  pluginRpc(id: string, method: string, input?: unknown): Promise<PluginRpcResponse>;
  /**
   * 插件前端只读宿主能力的窄通道（白名单在 shared/plugin-host-api.ts）。
   *
   * 和 `pluginRpc` 一样：主进程只校验目标插件，不校验调用方身份——
   * 插件前端同 realm，不是安全边界。见 plugins/README.md 的信任说明。
   */
  pluginHostRead(id: string, method: string, environmentId?: string, args?: unknown[]): Promise<PluginRpcResponse>;
  /** 跑插件的一次性命令（环境菜单里的插件动作走这条）。 */
  pluginRun(
    id: string,
    command: string,
    environmentId: string,
  ): Promise<{ pluginId: string; command: string; result: unknown }>;
  onPluginSignal(cb: (signal: PluginSignal) => void): () => void;
  setViewport(v: ViewportRect): Promise<void>;
  /**
   * 页面当前画面（`data:image/jpeg` data URL），没有页面时是 null。
   *
   * 让开原生视图之前先取这一帧垫在占位区，否则整块页面会突然变成一个空底色。
   */
  pageSnapshot(): Promise<string | null>;
  /**
   * 让开 / 收回原生页面视图。原生 `WebContentsView` 永远画在渲染层 DOM 之上，
   * 所以渲染层一开右键菜单 / 下拉 / 对话框，压到页面区域的部分会被它盖住。
   * 渲染层检测到重叠时调这里藏起来，关掉再放回去。
   */
  setViewVisible(visible: boolean): Promise<void>;
  onStateChanged(cb: () => void): () => void;
}
