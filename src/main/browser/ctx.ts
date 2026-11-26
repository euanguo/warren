/**
 * 页面级共享上下文：拆开的模块（snapshot / waits / actions / escape / keymouse / ops）
 * 都只依赖这个接口，不依赖 controller 类本身，避免模块之间互相 import。
 */
import type { WebContents } from 'electron';
import type { RefTable } from './refs.ts';
import type { TargetInput, ActionReceipt, PageEvent } from '../../shared/types.ts';

/**
 * 环境级待处理队列（popup / download）与 dialog 的读取口。
 * 实现见 `pending.ts`；队列在环境级，所以别的标签开的 popup 也能被这一条等出来。
 */
export interface PendingSink {
  consumePopup(): { tabId: string; index: number; url: string; title?: string; at: string } | null;
  consumeDownload(): { downloadId: string; url: string; filename: string; at: string } | null;
  dialogOpen(): { type: string; message: string; url: string; sessionId?: string } | null;
  takeDialogEvent(): PageEvent | null;
  /** fileChooser 事件（只在拦截开启期间产生）。 */
  consumeFileChooser(): {
    frameId?: string;
    mode?: string;
    backendNodeId?: number;
    at: string;
  } | null;
  /** `since` 是 `Date.now()` 毫秒；只报动作开始之后产生的 popup/dialog。 */
  receiptSince(since: number): ActionReceipt;
}

export interface PageContext {
  wc: WebContents;
  /** 发 CDP 命令（会话已 attach）。 */
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * 在**指定会话**里发命令（`undefined` = 主会话）。
   *
   * 跨源 iframe 是独立渲染进程，它的 DOM / 盒模型只能在它自己的子会话里问
   * （见 `session.ts` 的 `ChildSession`）。
   */
  sendOn<T = unknown>(sessionId: string | undefined, method: string, params?: Record<string, unknown>): Promise<T>;
  /** 当前挂着的 OOPIF 子会话。 */
  childSessions(): Array<{ sessionId: string; frameId?: string; url: string }>;
  /** 输入类命令与「dialog 是否已打开」赛跑，见 controller 的注释。 */
  sendInput(method: string, params: Record<string, unknown>): Promise<void>;
  refs: RefTable;
  /** 选择器 → backendNodeId（`@N` / css / xpath / text= / role= …）。 */
  backendIdFor(target: TargetInput): Promise<number>;
  /** 这个 backendNodeId 属于哪个 frame / 会话（跨源元素才有 sessionId）。 */
  frameOf(backendNodeId: number): Promise<{ frameId: string; sessionId?: string } | undefined>;
  /** 环境级下载句柄（saveAs / cancel / status 用）。 */
  downloadById: (
    downloadId: string,
  ) => { item: Electron.DownloadItem; url: string; filename: string; path: string } | null;
  pending: PendingSink;
  tabIndex: () => number;
  lastActivityAt: () => number;
  /** 当前 tab 的在途非流式请求数（用于精确 networkidle 与 smartSettle）。 */
  inFlightCount?: () => number;
  /** 当前 tab 最近一次主文档导航失败错误（用于诊断 `chrome-error://` 页）。 */
  lastNavigationError?: () => { url: string; error: string; at: string } | null;
  /** 当前限定的活动 frameId（空表示全部/主文档）。 */
  activeFrameId?: () => string | undefined;
  record: (type: string, message: string) => void;
}

export interface AxFrame {
  frameId: string;
  /** 跨源 frame 才有：它自己的 CDP 子会话 id。主 frame 与同源子 frame 都是 `undefined`（都在主会话里）。 */
  sessionId?: string;
  /** 文档加载代号，用于按 frame 精准判定 ref 是否过期。 */
  loaderId?: string;
  url?: string;
  name?: string;
  nodes: Array<Record<string, unknown>>;
}
