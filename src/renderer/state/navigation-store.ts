import { useSyncExternalStore } from 'react';

/**
 * 设置分区 ID：内置 6 个系统分节 + 动态插件分节 `plugin:<pluginId>:<surfaceId>`。
 */
export type BuiltinSettingsSection = 'general' | 'browser' | 'agent' | 'vault' | 'plugins' | 'diagnostics';
export type SettingsSection = BuiltinSettingsSection | `plugin:${string}:${string}`;

export type StageRoute = 'environments' | 'settings' | 'pluginPage';

export interface NavigationSnapshot {
  route: StageRoute;
  settingsSection: SettingsSection;
  settingsQuery: string;
  requestedPage?: { pluginId: string; surfaceId: string };
  inspectorOpen: boolean;
  inspectorTab: string;
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

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNavigationSnapshot(): NavigationSnapshot {
  return state;
}

export function useNavigationState(): NavigationSnapshot {
  return useSyncExternalStore(subscribe, getNavigationSnapshot, getNavigationSnapshot);
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
