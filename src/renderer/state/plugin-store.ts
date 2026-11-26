import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { loadPluginApps } from '@/lib/plugin-runtime';
import { emptyRegistry, type PluginRegistry } from '@/lib/plugin-sdk-types';
import { applyTheme } from '@/lib/theme';
import type { AppSettings, InstalledPlugin } from '@shared/types';

export interface PluginStoreSnapshot {
  plugins: InstalledPlugin[];
  settings: AppSettings;
  registry: PluginRegistry;
  loaded: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  controlPolicy: 'ask',
  pluginPolicy: 'ask',
  theme: 'dark',
  compactTopbar: false,
  pageBorderRadius: true,
  devtoolsDefaultDock: 'right',
  devtoolsDefaultViewport: 'auto',
  maxRunning: 8,
  idleHibernateMinutes: 10,
  leaseTtlMs: 60_000,
  showControlPill: true,
};

let state: PluginStoreSnapshot = {
  plugins: [],
  settings: DEFAULT_SETTINGS,
  registry: emptyRegistry(),
  loaded: false,
};

let started = false;
let themeCleanup: () => void = () => {};
let refreshSeq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  ensurePluginStoreStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function syncTheme(settings: AppSettings): void {
  themeCleanup();
  themeCleanup = applyTheme(settings.theme ?? 'dark');
}

export async function refreshSettingsOnly(): Promise<void> {
  if (typeof window === 'undefined' || !window.envApi) return;
  const settings = await window.envApi.settings();
  syncTheme(settings);
  state = { ...state, settings };
  emit();
}

export async function refreshPluginsAndSettings(reloadPlugins = true): Promise<void> {
  if (typeof window === 'undefined' || !window.envApi) return;
  const seq = ++refreshSeq;
  try {
    const [plugins, settings] = await Promise.all([
      reloadPlugins ? window.envApi.plugins() : Promise.resolve(state.plugins),
      window.envApi.settings(),
    ]);
    const registry = reloadPlugins ? await loadPluginApps(plugins) : state.registry;
    if (seq !== refreshSeq) return;
    syncTheme(settings);
    state = {
      plugins,
      settings,
      registry,
      loaded: true,
    };
    emit();
  } catch {
    // 打包冷启动早期 IPC 可能尚未完成注册；等待主进程就绪后的 plugin:changed 广播自动重试
  }
}

export function ensurePluginStoreStarted(): void {
  if (started || typeof window === 'undefined' || !window.envApi) return;
  started = true;
  void refreshPluginsAndSettings(true);
  window.envApi.onPluginChanged((payload) => {
    if (payload?.reason === 'settings') {
      void refreshSettingsOnly();
      return;
    }
    void refreshPluginsAndSettings(true);
  });
}

export function getPluginSnapshot(): PluginStoreSnapshot {
  return state;
}

export function usePluginState(): PluginStoreSnapshot {
  return useSyncExternalStore(subscribe, getPluginSnapshot, getPluginSnapshot);
}

export const pluginActions = {
  updateSettings: async (patch: Partial<AppSettings>): Promise<AppSettings> => {
    const next = await window.envApi.setSettings(patch);
    syncTheme(next);
    state = { ...state, settings: next };
    emit();
    return next;
  },
  refreshAll: () => refreshPluginsAndSettings(true),
  runAction: async (pluginId: string, command: string, environmentId: string): Promise<void> => {
    try {
      await window.envApi.pluginRun(pluginId, command, environmentId);
    } catch (error) {
      toast.error('插件动作执行失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
