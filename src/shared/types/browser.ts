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

export type ViewportPresetId = 'auto' | 'desktop-1440' | 'laptop-1280' | 'mobile-390';

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
