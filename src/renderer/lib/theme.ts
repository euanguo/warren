import { useEffect } from 'react';
import type { ThemePreference } from '@shared/types';

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
 * 不在 effect 中同步 setState，严格符合 oxlint `react/set-state-in-effect`。
 */
export function useStandaloneThemeSync(): void {
  useEffect(() => {
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
    const unsubState = window.envApi.onStateChanged(pull);

    return () => {
      disposed = true;
      cleanup();
      unsubDelta();
      unsubState();
    };
  }, []);
}
