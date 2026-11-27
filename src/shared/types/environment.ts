import type { ApprovalMode, ControlOwner, Creator, EnvironmentStatus, SpaceId, ViewportPresetId } from './common.ts';

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
  /** 是否处于标签级休眠/惰性占位态（已释放 WebContentsView 与渲染进程，点击或操作时透明重载）。 */
  sleeping?: boolean;
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
  leaseLabel?: string;
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

export interface DomainPref {
  envId: string;
  origin: string;
  zoomFactor: number;
  viewportPreset?: ViewportPresetId;
  updatedAt: string;
}

/** 站点级记忆笔记（按域名或路径前缀关联，仅存非凭据结构/流程提示）。 */
export interface SiteNote {
  site: string;
  content: string;
  updatedBy: string;
  updatedAt: string;
}
