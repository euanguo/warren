import type {
  ConsoleEntry,
  CookieSummary,
  NavigationAction,
  NavigationState,
  NetHit,
  NetRule,
  NetworkEntry,
  SnapshotResult,
} from './browser.ts';
import type { ApprovalMode, DevToolsDockMode, SpaceId, ViewportPresetId, ViewportRect } from './common.ts';
import type { DomainPref, Environment, EventRecord, Group, TabRef, TabState, UrlHistoryEntry } from './environment.ts';
import type {
  InstalledPlugin,
  PluginLogEntry,
  PluginRpcResponse,
  PluginSignal,
  PluginSkillDocument,
} from './plugin.ts';
import type { AgentSkillStatus, AppSettings, CredentialSummary, SystemDiagnosticsReport } from './settings.ts';
import type {
  BrowserShortcut,
  DownloadItemInfo,
  FindInPageResult,
  NativeMenuItem,
  OverlayRequest,
  PopoverActionEvent,
  PopoverId,
  PopoverOpenOptions,
  PopoverState,
  PopoverUpdateOptions,
} from './ui.ts';

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

export interface RpcErrorDetails {
  /** 给人类或 Agent 看的简明纠错提示。 */
  hint?: string;
  /** 单条合法可执行的 `warren ...` 自愈命令。 */
  remedy?: string;
  /** 结构化上下文（如 `availableOptions`、`blocker`、`truncation` 等，严禁包含凭据明文）。 */
  data?: Record<string, unknown>;
}

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
    /** 机器可读的自愈指引与结构化诊断详情。 */
    details?: RpcErrorDetails;
  };
}

// ---------------------------------------------------------------------------
// preload 暴露给渲染层的 IPC 面
// ---------------------------------------------------------------------------

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
  takeover(id: string, space?: SpaceId): Promise<unknown>;
  release(id: string, space?: SpaceId): Promise<void>;
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
  highlightElement(id: string, space: SpaceId, target?: string): Promise<void>;
  popupMenu(items: NativeMenuItem[], position?: { x: number; y: number }): Promise<string | null>;
  openOverlay<T = unknown>(request: OverlayRequest): Promise<T | null>;
  getOverlayState(): Promise<OverlayRequest | null>;
  resolveOverlay(result: unknown): Promise<void>;
  onOverlayState(callback: (request: OverlayRequest | null) => void): () => void;
  openPopover(options: PopoverOpenOptions): Promise<void>;
  updatePopover<K extends PopoverId>(id: K, options: PopoverUpdateOptions<K>): Promise<void>;
  closePopover(id?: PopoverId): Promise<void>;
  getPopoverState(): Promise<PopoverState | null>;
  dispatchPopoverAction(event: PopoverActionEvent): Promise<void>;
  onPopoverState(callback: (payload: PopoverState | null) => void): () => void;
  onPopoverAction(callback: (event: PopoverActionEvent) => void): () => void;
  onPopoverDismissed(callback: (payload: { id: PopoverId; reason: string }) => void): () => void;
  onBrowserShortcut(callback: (shortcut: BrowserShortcut) => void): () => void;
  spaceSelect(id: string, space: SpaceId): Promise<void>;
  tabCreate(id: string, space: SpaceId, url?: string, activate?: boolean): Promise<TabState>;
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
  vaultAdd(input: {
    provider: string;
    label: string;
    username?: string;
    password?: string;
    token?: string;
  }): Promise<CredentialSummary>;
  vaultRemove(ref: string): Promise<{ removed: boolean }>;
  domainPrefs(envId?: string): Promise<DomainPref[]>;
  clearDomainPref(envId: string, origin: string): Promise<{ removed: boolean }>;
  clearUrlHistory(): Promise<{ cleared: number }>;
  systemDoctor(): Promise<SystemDiagnosticsReport>;
  openDataDir(): Promise<{ opened: boolean }>;
  /** 自带 Skill 在各个 agent 目录里的安装状态（见 src/main/agent-integration.ts）。 */
  agentSkills(): Promise<AgentSkillStatus[]>;
  /** 把自带 Skill（含已启用插件 Skill）装进指定的 agent 目录。返回落盘路径。 */
  agentInstallSkill(targetId: string): Promise<{ path: string; sha256?: string }>;
  /** 刷新所有已安装但过期的 Agent Skill 目录。 */
  agentRefreshSkills(): Promise<Array<{ id: string; path: string; sha256: string }>>;
  plugins(): Promise<InstalledPlugin[]>;
  pluginEnable(id: string): Promise<InstalledPlugin>;
  pluginDisable(id: string): Promise<void>;
  pluginGrant(id: string, permissions: string[]): Promise<InstalledPlugin>;
  pluginInstall(source?: string): Promise<{ cancelled: boolean; plugin?: InstalledPlugin }>;
  pluginReload(id: string): Promise<InstalledPlugin>;
  pluginLogs(id: string, limit?: number): Promise<PluginLogEntry[]>;
  pluginConfigSet(id: string, key: string, value: string): Promise<InstalledPlugin>;
  pluginSetSkillExposed(id: string, exposed: boolean): Promise<InstalledPlugin>;
  pluginReadSkill(id: string): Promise<PluginSkillDocument>;
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
    environmentId?: string,
  ): Promise<{ pluginId: string; command: string; result: unknown }>;
  onPluginSignal(cb: (signal: PluginSignal) => void): () => void;
  setViewport(v: ViewportRect): Promise<void>;
  /**
   * 让开 / 收回原生页面视图。原生 `WebContentsView` 永远画在渲染层 DOM 之上，
   * 所以渲染层一开右键菜单 / 下拉 / 对话框，压到页面区域的部分会被它盖住。
   * 渲染层检测到重叠时调这里藏起来，关掉再放回去。
   */
  setViewVisible(visible: boolean): Promise<void>;
  onEnvDelta(cb: (payload: { reason?: string }) => void): () => void;
  onPluginChanged(cb: (payload: { reason?: string }) => void): () => void;
}
