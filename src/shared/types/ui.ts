import type { BuiltinSettingsSection, SpaceId, ViewportPresetId, ViewportRect } from './common.ts';
import type { Environment, UrlHistoryEntry } from './environment.ts';

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

export interface PopoverPropsMap {
  'address-suggest': { query: string; entries: UrlHistoryEntry[]; highlighted: number; width: number };
  'find-in-page': { envId: string; space: SpaceId; initialQuery?: string };
  downloads: { envId?: string };
  viewport: { envId: string; space: SpaceId; preset: ViewportPresetId };
  'memory-quick': Record<string, never>;
  'plugin-popover': { pluginId: string; surfaceId: string; environmentId?: string; space: SpaceId; url: string };
}

export type PopoverId = keyof PopoverPropsMap;

export interface PopoverGeometry {
  anchorRect: ViewportRect;
  size: { width: number; height: number };
  placement?: PopoverPlacement;
  /** 地址栏联想设为 false，避免抢走输入框键盘焦点；⌘F 查找条设为 true 接收打字。 */
  focusable?: boolean;
  beyondWindow?: boolean;
}

export type PopoverOpenOptions = {
  [K in PopoverId]: PopoverGeometry & { id: K; props: PopoverPropsMap[K] };
}[PopoverId];

export type PopoverUpdateOptions<K extends PopoverId = PopoverId> = Partial<PopoverGeometry> & {
  props?: Partial<PopoverPropsMap[K]>;
};

export type PopoverState = {
  [K in PopoverId]: { id: K; props: PopoverPropsMap[K] };
}[PopoverId];

export type PopoverActionEvent =
  | { id: 'address-suggest'; action: 'hover'; payload: number }
  | { id: 'address-suggest'; action: 'pick'; payload: string }
  | { id: 'viewport'; action: 'preset'; payload: ViewportPresetId }
  | { id: 'memory-quick'; action: 'openMemoryPanel' }
  | { id: 'plugin-popover'; action: 'openPluginPage'; payload: { pluginId: string; surfaceId: string } }
  | { id: 'plugin-popover'; action: 'openInspectorTab'; payload: { pluginId: string; surfaceId: string } }
  | { id: 'plugin-popover'; action: 'openSettings'; payload: { section?: BuiltinSettingsSection } }
  | {
      id: 'plugin-popover';
      action: 'toast';
      payload: { kind: 'success' | 'error' | 'info'; title: string; description?: string };
    };

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
