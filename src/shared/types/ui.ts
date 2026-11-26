import type { Environment } from './environment.ts';

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
  | 'quickAutofill'
  | { selectTab: number };

export type DevToolsDockMode = 'right' | 'bottom' | 'detach';

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
