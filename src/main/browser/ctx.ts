/**
 * 页面级共享上下文：拆开的模块（snapshot / waits / actions / escape / keymouse）
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

export interface VisualActionEvent {
  kind: 'click' | 'fill' | 'hover' | 'move';
  x: number;
  y: number;
  rect?: { x: number; y: number; width: number; height: number };
  label?: string;
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
  record: (type: string, message: string) => void;
  /** 可选：上报 AI 动作在主 frame 视口内的坐标与控件框，供透明遮罩渲染轨迹动画（绝不携带输入明文）。 */
  onVisualAction?: (action: VisualActionEvent) => void;
}

export interface AxFrame {
  frameId: string;
  /** 跨源 frame 才有：它自己的 CDP 子会话 id。主 frame 与同源子 frame 都是 `undefined`（都在主会话里）。 */
  sessionId?: string;
  nodes: Array<Record<string, unknown>>;
}
