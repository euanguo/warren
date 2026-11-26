import { useSyncExternalStore } from 'react';
import type { BuiltinSettingsSection } from '@shared/types';

/**
 * 设置分区 ID：内置 6 个系统分节 + 动态插件分节 `plugin:<pluginId>:<surfaceId>`。
 */
export type { BuiltinSettingsSection };
export type SettingsSection = BuiltinSettingsSection | `plugin:${string}:${string}`;

export type StageRoute = 'environments' | 'settings' | 'pluginPage';

export interface PluginPopoverRequest {
  pluginId: string;
  surfaceId: string;
  width?: number;
  height?: number;
}

export interface PluginInspectorRequest {
  pluginId: string;
  surfaceId: string;
}

export interface NavigationSnapshot {
  route: StageRoute;
  settingsSection: SettingsSection;
  settingsQuery: string;
  requestedPage?: { pluginId: string; surfaceId: string };
  inspectorOpen: boolean;
  inspectorTab: string;
}

interface SurfaceRequestHandlers {
  onPopover: (req: PluginPopoverRequest) => void;
  onInspector: (req: PluginInspectorRequest) => void;
}

const INSPECTOR_TAB_KEY = 'warren.inspector.tab';

function readInitialInspectorTab(): string {
  try {
    return localStorage.getItem(INSPECTOR_TAB_KEY) || 'events';
  } catch {
    return 'events';
  }
}

let state: NavigationSnapshot = {
  route: 'environments',
  settingsSection: 'general',
  settingsQuery: '',
  requestedPage: undefined,
  inspectorOpen: false,
  inspectorTab: readInitialInspectorTab(),
};

const listeners = new Set<() => void>();
const surfaceSubscribers = new Set<SurfaceRequestHandlers>();
let pendingPopoverRequest: PluginPopoverRequest | undefined;
let pendingInspectorRequest: PluginInspectorRequest | undefined;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function flushSurfaceRequests(): void {
  if (surfaceSubscribers.size === 0) return;
  if (pendingPopoverRequest) {
    const req = pendingPopoverRequest;
    pendingPopoverRequest = undefined;
    for (const sub of surfaceSubscribers) sub.onPopover(req);
  }
  if (pendingInspectorRequest) {
    const req = pendingInspectorRequest;
    pendingInspectorRequest = undefined;
    for (const sub of surfaceSubscribers) sub.onInspector(req);
  }
}

export function getNavigationSnapshot(): NavigationSnapshot {
  return state;
}

export function useNavigationState(): NavigationSnapshot {
  return useSyncExternalStore(subscribe, getNavigationSnapshot, getNavigationSnapshot);
}

/**
 * 订阅跨视图的插件浮窗 / 工作台 Tab 打开请求，避免从 DOM CustomEvent 或 Effect 内同步 setState 接力。
 */
export function subscribePluginSurfaceRequests(handlers: SurfaceRequestHandlers): () => void {
  surfaceSubscribers.add(handlers);
  if (pendingPopoverRequest || pendingInspectorRequest) {
    queueMicrotask(flushSurfaceRequests);
  }
  return () => {
    surfaceSubscribers.delete(handlers);
  };
}

export function openEnvironments(): void {
  if (state.route === 'environments' && !state.requestedPage) return;
  state = { ...state, route: 'environments', requestedPage: undefined };
  emit();
}

export function openSettings(section?: SettingsSection): void {
  state = {
    ...state,
    route: 'settings',
    requestedPage: undefined,
    settingsSection: section ?? state.settingsSection,
  };
  emit();
}

export function toggleSettings(section?: SettingsSection): void {
  if (state.route === 'settings' && (!section || state.settingsSection === section)) {
    openEnvironments();
    return;
  }
  openSettings(section);
}

export function setSettingsSection(section: SettingsSection): void {
  if (state.settingsSection === section && state.route === 'settings') return;
  state = { ...state, route: 'settings', requestedPage: undefined, settingsSection: section };
  emit();
}

export function setSettingsQuery(settingsQuery: string): void {
  if (state.settingsQuery === settingsQuery) return;
  state = { ...state, settingsQuery };
  emit();
}

export function openPluginPage(pluginId: string, surfaceId: string): void {
  state = {
    ...state,
    route: 'pluginPage',
    requestedPage: { pluginId, surfaceId },
  };
  emit();
}

export function setInspectorOpen(inspectorOpen: boolean): void {
  if (state.inspectorOpen === inspectorOpen) return;
  state = { ...state, inspectorOpen };
  emit();
}

export function setInspectorTab(inspectorTab: string): void {
  if (state.inspectorTab === inspectorTab) return;
  try {
    localStorage.setItem(INSPECTOR_TAB_KEY, inspectorTab);
  } catch {
    // 忽略隐私模式或配额错误
  }
  state = { ...state, inspectorTab };
  emit();
}

/** 从命令栏或插件桥接请求在主工作台打开指定插件浮窗。 */
export function requestPluginPopover(
  pluginId: string,
  surfaceId: string,
  options?: { width?: number; height?: number },
): void {
  state = {
    ...state,
    route: 'environments',
    requestedPage: undefined,
  };
  emit();
  pendingPopoverRequest = { pluginId, surfaceId, ...options };
  queueMicrotask(flushSurfaceRequests);
}

/** 从命令栏、插件整页或插件桥接请求切换到环境右侧检查器的指定插件 Tab。 */
export function requestPluginInspector(pluginId: string, surfaceId: string): void {
  const inspectorTab = `plugin:${pluginId}:${surfaceId}`;
  try {
    localStorage.setItem(INSPECTOR_TAB_KEY, inspectorTab);
  } catch {
    // 忽略隐私模式或配额错误
  }
  state = {
    ...state,
    route: 'environments',
    requestedPage: undefined,
    inspectorOpen: true,
    inspectorTab,
  };
  emit();
  pendingInspectorRequest = { pluginId, surfaceId };
  queueMicrotask(flushSurfaceRequests);
}
