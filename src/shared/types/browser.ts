// ---------------------------------------------------------------------------
// 浏览器观察、遥测、操控与网络拦截
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
  /** 语义树真实缩进深度（从 0 起算，区分于 heading `level`）。 */
  depth?: number;
  readonly?: boolean;
  required?: boolean;
  focused?: boolean;
  valuetext?: string;
  /** `urls: true` 时为链接节点补充的真实 href。 */
  url?: string;
  /** 同 `(role, name)` 重复项的 0-based 消歧序号（仅重复时设置）。 */
  nth?: number;
  /** 由 DOM 补盲发现的 cursor:pointer / onclick / tabindex 可点击元素。 */
  cursorInteractive?: boolean;
  /** 被隐藏但救回的可操作控件（如隐藏的 `<input type="file">`）。 */
  hiddenInput?: boolean;
  /** `<select>` 等下拉控件的选项摘要。 */
  optionsSummary?: string[];
  /** 密码或敏感输入字段标记：value 一律以固定宽度脱敏占位展示。 */
  sensitive?: boolean;
  /** 跨快照稳定引用对比中，本次新出现的节点。 */
  isNew?: boolean;
  /** 所属文档的 `loaderId`，用于按 frame 精确失效旧 ref。 */
  loaderId?: string;
  /** `boxes: true` 时附带的视口坐标盒。 */
  box?: { x: number; y: number; width: number; height: number };
  /** `includeActionMarks` 打开时按 role 标注的可执行动作。 */
  actions?: Array<'click' | 'fill' | 'select' | 'focus'>;
  /** `includeStableLocator` 打开时的稳定定位串（`loc=role:…` 或 `@ref` 回退）。 */
  locator?: string;
  /** 节点所属 frame（多 frame 时才有，便于判断它在不在主文档里）。 */
  frameId?: string;
  /** 节点当前是否位于视口内（带边缘缓冲）；由真视口感知探针填充。 */
  inViewport?: boolean;
  /** 最近命名语义容器作用域（如 `dialog:"编辑用户"`），用于防误跨容器自愈。 */
  containerScope?: string;
}

/** 视口与滚动空间几何指标。 */
export interface ViewportMetrics {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  scrollWidth: number;
  scrollHeight: number;
  abovePx: number;
  belowPx: number;
  scrollPercentY: number;
  omittedAbove?: number;
  omittedBelow?: number;
}

export interface SnapshotResult {
  url: string;
  title: string;
  nodes: AxNode[];
  viewport?: ViewportMetrics;
}

export interface ConsoleEntry {
  /** SQLite 自增游标（增量读取用）。 */
  id?: number;
  level: string;
  message: string;
  line: number;
  source: string;
  at: string;
  /** 哪条标签记的（加法，老数据没有）。 */
  tabId?: string;
}

export interface NetworkEntry {
  /** SQLite 自增游标（增量读取用，避免 300 条上限后 slice 错位）。 */
  id?: number;
  method: string;
  url: string;
  status: number;
  resourceType: string;
  at: string;
  /** 哪条标签记的（加法，老数据没有）。 */
  tabId?: string;
  /** 失败请求的网络错误码（如 `net::ERR_CONNECTION_REFUSED`）。 */
  error?: string;
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
  /** 为链接节点附加真实 `href`。 */
  urls?: boolean;
  /** 扫描 `cursor:pointer` / `onclick` / `tabindex>=0` / `[contenteditable]` 补盲节点。 */
  includeCursor?: boolean;
  /** 为可交互节点附加视口包围盒。 */
  boxes?: boolean;
  /** 语义树最大缩进深度（从 0 起算）。 */
  maxDepth?: number;
  /** 分层输出 Token 预算上限（按 4 字符 ≈ 1 token 估算）。 */
  maxTokens?: number;
  /** 按子串或 `/regex/` 过滤节点（保留祖先链）。 */
  filter?: string;
  /** 限定只采集某个 frameId（为空时按当前激活 frame 或全部 frame）。 */
  frame?: string;
  /** 关闭同类长列表与禁用控件折叠。 */
  noFold?: boolean;
}

export interface ScreenshotAnnotation {
  ref: string;
  role: string;
  name: string;
  box: { x: number; y: number; width: number; height: number };
}

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  /** 默认落盘路径。给了它就不再返回 base64，只返回文件元数据。 */
  path?: string;
  /** 显式要求把内容带回调用方。默认 false，避免 agent 输出几十万 token。 */
  encoding?: 'base64';
  /** 在截屏前叠加临时 `@N` 编号标签框，拍完立刻清除，并返回标注坐标清单。 */
  annotate?: boolean;
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
  /** `annotate: true` 时返回的元素编号标注表。 */
  annotations?: ScreenshotAnnotation[];
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
  /** 是否开启拟人化鼠标曲线移动（默认直达，避免后台 tab 多步移动拖慢）。 */
  humanize?: boolean;
  /** 在新标签页中打开（带 Meta/Control 修饰键点击）。 */
  newTab?: boolean;
}

export type DragPlacement = 'center' | 'before' | 'after';

export interface DragOptions extends ClickOptions {
  /** 放置落点相对于目标中心的位置：`before`（前 15%）、`after`（后 85%）、`center`。 */
  placement?: DragPlacement;
}

export type NavigationReceipt = 'none' | 'started' | 'navigated' | 'timeout';

export interface FillOptions {
  clearFirst?: boolean;
  timeoutMs?: number;
  /** 填完后立即按 Enter 提交。 */
  submit?: boolean;
  /** 是否为凭据/秘密填充（跳过回读校验与尾字符拆分）。 */
  isSecret?: boolean;
}

export interface FillWarning {
  kind: 'truncated' | 'formatted';
  expectedLength: number;
  actualLength: number;
  message: string;
}

export interface SavedFlowSpec {
  /** 固定为只读 GET，安全边界禁止保存写请求。 */
  method: 'GET';
  /** 允许使用 `{{param}}` 占位符的 URL 模板。 */
  urlTemplate: string;
  /** 仅允许安全非认证请求头（如 Accept）。 */
  headers?: Record<string, string>;
  /** 可选提取数组路径（点分路径，如 `data.items`）。 */
  extractPath?: string;
  /** 默认导出字段列表，同时用于漂移检测。 */
  fields?: string[];
  /** 说明文字。 */
  description?: string;
}

export interface SavedFlowRecord {
  name: string;
  site: string;
  spec: SavedFlowSpec;
  updatedBy: string;
  updatedAt: string;
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

/** 目标 ref 在页面重绘后自动自愈的通知。 */
export interface RefHealNotice {
  ref: string;
  role: string;
  name: string;
  containerScope?: string;
}

/** 动作 Delta 中的单个交互节点摘要。 */
export interface CompactDeltaItem {
  role: string;
  name: string;
  ref?: string;
  value?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  selected?: boolean;
  beforeValue?: string;
  beforeChecked?: boolean | 'mixed';
  beforeDisabled?: boolean;
}

/** 未处理页面副作用快照（只读窥视，不消费事件队列）。 */
export interface ActionSideEffects {
  unhandledPopups?: Array<{ tabId: string; index: number; url: string; title?: string }>;
  activeDownloads?: Array<{ downloadId: string; url: string; filename: string }>;
  openDialog?: { type: string; message: string; url: string } | null;
}

/** 供上下文主动注入的已保存 Flow 摘要。 */
export interface SavedFlowSummary {
  name: string;
  site: string;
  params: string[];
  description?: string;
}

/** 统一动作变化回执（单步写动作与 batch 共享）。 */
export interface ActionDelta {
  changed: boolean;
  urlChanged: boolean;
  titleChanged: boolean;
  url: string;
  title: string;
  navError?: string;
  healed?: RefHealNotice[];
  nodes: {
    added: CompactDeltaItem[];
    changed: CompactDeltaItem[];
    removed: CompactDeltaItem[];
    foldedGroups?: string[];
  };
  network: string[];
  openedText?: string;
  contextHints?: {
    siteNotes?: Array<{ site: string; content: string }>;
    savedFlows?: SavedFlowSummary[];
  };
  sideEffects: ActionSideEffects;
  loopWarning?: string;
}

/** 写动作统一收据：派发结果 + 即时 popup/download/dialog/自愈 + 可选 ActionDelta。 */
export interface ActionReceipt {
  popups?: Array<{ tabId: string; index: number; url: string; title?: string }>;
  downloads?: Array<{ downloadId: string; url: string; filename: string }>;
  dialog?: { type: string; message: string; url: string } | null;
  healed?: RefHealNotice[];
  delta?: ActionDelta;
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

export type LoginFieldKind = 'username' | 'password' | 'totp' | 'submit';

export type LoginStepKind = 'single' | 'username-only' | 'password-only' | 'totp-only' | 'none';

/** 隔离世界探测到的登录相关控件（只含定位与元数据，不含输入值）。 */
export interface DetectedLoginField {
  kind: LoginFieldKind;
  selector: string;
  /** 可直接喂给 `controller.fill` / `controller.click` / `fillSecret` 的目标。 */
  target: TargetInput;
  confidence: number;
  label?: string;
  autocomplete?: string;
  inputType?: string;
  frameId?: string;
  inShadow?: boolean;
  inSameOriginFrame?: boolean;
  inCrossOriginFrame?: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface DetectedLoginFieldsResult {
  url: string;
  host: string;
  step: LoginStepKind;
  fields: {
    username?: DetectedLoginField;
    password?: DetectedLoginField;
    totp?: DetectedLoginField;
    submit?: DetectedLoginField;
  };
  candidates: DetectedLoginField[];
}
