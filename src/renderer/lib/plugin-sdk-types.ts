import type { ComponentType } from 'react';
import type * as React from 'react';
import type { PluginEnvBadgeSetter, PluginEnvBadgeSurface } from '@/lib/plugin-badges';
import type { PluginUi } from '@/lib/plugin-ui';
import type { BuiltinSettingsSection } from '@/state/navigation-store';
import type { HostEnvironmentSummary, PluginSettingValue, SpaceId } from '@shared/types';

export interface PluginSurfaceProps {
  pluginId: string;
  /** inspectorTab / popover / envAction / statusBadge 这类跟环境相关的面会拿到 */
  environmentId?: string;
  /** 当前环境激活的 Space（person / agent） */
  space?: SpaceId;
  /** 当前激活标签页的 URL */
  url?: string;
  /** popover 面用于主动关闭独立浮窗 */
  closePopover?: () => void;
  /** 跳转到本插件的全屏 railPage */
  openPluginPage?: (surfaceId?: string) => void;
  /** 打开右侧工作台并切到本插件的 inspectorTab */
  openInspectorTab?: (surfaceId?: string) => void;
}

export interface PluginRailPage {
  kind: 'railPage';
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  path?: string;
  component: ComponentType<PluginSurfaceProps>;
}

export interface PluginSettingsSection {
  kind: 'settingsSection';
  pluginId: string;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  component: ComponentType<PluginSurfaceProps>;
}

export interface PluginInspectorTab {
  kind: 'inspectorTab';
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  component: ComponentType<PluginSurfaceProps>;
}

/** envAction 是声明式的：界面由 warren 的环境菜单渲染，插件只给「动作 → 命令」。 */
export interface PluginEnvAction {
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  command: string;
}

export interface PluginPopoverSurface {
  kind: 'popover';
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  shortcut?: string;
  width?: number;
  height?: number;
  component: ComponentType<PluginSurfaceProps>;
}

export interface PluginCommandBarAction {
  kind: 'commandBarAction';
  pluginId: string;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  shortcut?: string;
  command?: string;
  onTrigger?: (environmentId?: string) => Promise<void> | void;
}

export interface PluginStatusBadge {
  kind: 'statusBadge';
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  component?: ComponentType<PluginSurfaceProps>;
}

export interface PluginRegistry {
  railPages: PluginRailPage[];
  settingsSections: PluginSettingsSection[];
  inspectorTabs: PluginInspectorTab[];
  envActions: PluginEnvAction[];
  popovers: PluginPopoverSurface[];
  commandBarActions: PluginCommandBarAction[];
  statusBadges: PluginStatusBadge[];
  errors: Array<{ pluginId: string; message: string }>;
}

/** 插件前端能直连的宿主只读能力（白名单见 shared/plugin-host-api.ts）。 */
export interface PluginHostApi {
  environment: {
    list(): Promise<HostEnvironmentSummary[]>;
    get(id: string): Promise<HostEnvironmentSummary | null>;
    activeContext(): Promise<{
      environmentId: string | null;
      space: SpaceId;
      tabId: string | null;
      url: string;
      title: string;
    }>;
  };
  browser: {
    info(environmentId: string, options?: { space?: SpaceId }): Promise<{ url: string; title: string }>;
  };
}

/** 插件前端可用的外壳交互动作（统一兼容主窗与独立 PopoverHost 子窗）。 */
export interface PluginShellApi {
  closePopover(): Promise<void>;
  resizePopover(size: { width: number; height: number }): Promise<void>;
  openPopover(surfaceId: string, options?: { width?: number; height?: number }): void;
  openPage(surfaceId?: string): void;
  openSettings(section?: BuiltinSettingsSection): void;
  openInspectorTab(surfaceId?: string): void;
  openTab(environmentId: string, url: string, space?: SpaceId): Promise<void>;
  highlight(environmentId: string, selector?: string, space?: SpaceId): Promise<void>;
  notify(kind: 'success' | 'error' | 'info', title: string, description?: string): void;
}

export interface PluginSettingsHook {
  values: PluginSettingValue[];
  isLoading: boolean;
  refresh(): Promise<void>;
}

export function emptyRegistry(): PluginRegistry {
  return {
    railPages: [],
    settingsSections: [],
    inspectorTabs: [],
    envActions: [],
    popovers: [],
    commandBarActions: [],
    statusBadges: [],
    errors: [],
  };
}

export interface PluginAppApi {
  pluginId: string;
  React: typeof React;
  /** `React.createElement` 的短名——插件 bundle 没有构建步骤，用 h(...) 写界面 */
  h: typeof React.createElement;
  /** 宿主的通用组件库（见 `PLUGIN_UI` 的注释）。插件界面用它，不要手写 chrome。 */
  ui: PluginUi;
  rpc: { call<T = unknown>(method: string, input?: unknown): Promise<T> };
  /** 只读宿主能力；写操作和插件自己的数据走 `rpc`。 */
  host: PluginHostApi;
  /** 宿主外壳协同能力（关闭/调整浮窗、切页、开设置、开标签、高亮页面元素、跨窗通知）。 */
  shell: PluginShellApi;
  /** 当前插件自己的设置快照；secret 只有 configured，没有 value。 */
  settings: PluginSettingValue[];
  /** 便利 hook：返回 settings 快照，并可走现有 `plugins()` 刷新。 */
  useSettings(): PluginSettingsHook;
  useSignal(channel: string, handler: (payload: unknown) => void): void;
  log(message: string): void;
  surfaces: {
    railPage(surface: Omit<PluginRailPage, 'kind' | 'pluginId'>): void;
    settingsSection(surface: Omit<PluginSettingsSection, 'kind' | 'pluginId'>): void;
    inspectorTab(surface: Omit<PluginInspectorTab, 'kind' | 'pluginId'>): void;
    popover(surface: Omit<PluginPopoverSurface, 'kind' | 'pluginId'>): void;
    commandBarAction(surface: Omit<PluginCommandBarAction, 'kind' | 'pluginId'>): void;
    statusBadge(surface: Omit<PluginStatusBadge, 'kind' | 'pluginId'>): void;
    /** 环境行状态芯片：清单声明 + 返回 setter；宿主只负责一个槽的渲染。 */
    envBadge(surface: PluginEnvBadgeSurface): PluginEnvBadgeSetter;
  };
}
