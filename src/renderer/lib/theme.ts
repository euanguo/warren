import { useEffect, useSyncExternalStore } from 'react';
import type { ThemePreference } from '@shared/types';

export type ResolvedTheme = 'dark' | 'light';

function getDocumentTheme(): ResolvedTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function subscribeDocumentTheme(listener: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  return () => observer.disconnect();
}

/** 订阅当前生效的深/浅色主题，供 Toaster 等外部组件自动同步。 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeDocumentTheme, getDocumentTheme, () => 'dark');
}

function resolveIsDark(preference: ThemePreference): boolean {
  if (preference === 'light') return false;
  if (preference === 'dark') return true;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function setDocumentTheme(isDark: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', isDark);
  root.dataset.theme = isDark ? 'dark' : 'light';
}

/**
 * 将主题偏好应用到当前渲染表面（`main` / `overlay` / `popover`）。
 * 当选择 `system` 时自动监听系统浅/深色切换，返回清理函数。
 */
export function applyTheme(preference: ThemePreference = 'dark'): () => void {
  setDocumentTheme(resolveIsDark(preference));
  if (preference !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => setDocumentTheme(media.matches);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/**
 * 在独立渲染表面（Overlay / Popover）中监听设置变更并自动同步主题类。
 * 仅响应显式 settings 变更广播，不绑定全局 `state:changed` 或重复挂载完整 plugin-store。
 */
export function useStandaloneThemeSync(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let cleanup = () => {};
    let disposed = false;

    const pull = () => {
      void window.envApi.settings().then((settings) => {
        if (disposed) return;
        cleanup();
        cleanup = applyTheme(settings.theme ?? 'dark');
      });
    };

    pull();
    const unsubDelta = window.envApi.onEnvDelta((payload) => {
      if (payload?.reason === 'settings') pull();
    });
    const unsubPlugin = window.envApi.onPluginChanged((payload) => {
      if (payload?.reason === 'settings') pull();
    });

    return () => {
      disposed = true;
      cleanup();
      unsubDelta();
      unsubPlugin();
    };
  }, [enabled]);
}
