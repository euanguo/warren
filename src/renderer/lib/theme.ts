import { useEffect, useSyncExternalStore } from 'react';
import {
  DEFAULT_SKIN_ID,
  deriveSkinCssVars,
  resolveSkinDefinition,
  resolveSkinPalette,
  type SkinColorOverrides,
} from '@shared/skin';
import type { ThemePreference } from '@shared/types';

export type ResolvedTheme = 'dark' | 'light';

export interface ApplyThemeOptions {
  /** 是否在支持 View Transition 的浏览器中播放径向换肤波纹（默认首次加载不播放）。 */
  animate?: boolean;
  /** 径向换肤波纹原点（视口坐标 px），缺省从窗口中下方展开。 */
  origin?: { x: number; y: number };
}

let appliedSkinVarNames: string[] = [];

function getDocumentTheme(): ResolvedTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function subscribeDocumentTheme(listener: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-skin', 'class'],
  });
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

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function applySkinVariablesToRoot(scheme: ResolvedTheme, skinId: string, overrides?: SkinColorOverrides): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const style = root.style;
  for (const name of appliedSkinVarNames) {
    style.removeProperty(name);
  }
  appliedSkinVarNames = [];

  const resolvedSkin = resolveSkinDefinition(skinId);
  root.dataset.skin = resolvedSkin.id;

  const palette = resolveSkinPalette(resolvedSkin.id, scheme, overrides);
  const vars = deriveSkinCssVars(palette, scheme);
  for (const [name, value] of Object.entries(vars)) {
    style.setProperty(name, value);
    appliedSkinVarNames.push(name);
  }
}

function commitDocumentThemeAndSkin(isDark: boolean, skinId: string, overrides?: SkinColorOverrides): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const scheme: ResolvedTheme = isDark ? 'dark' : 'light';
  root.classList.toggle('dark', isDark);
  root.dataset.theme = scheme;
  applySkinVariablesToRoot(scheme, skinId, overrides);
}

function commitWithOptionalSweep(
  isDark: boolean,
  skinId: string,
  overrides: SkinColorOverrides | undefined,
  options?: ApplyThemeOptions,
): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const startViewTransition = (
    document as Document & {
      startViewTransition?: (cb: () => void) => { finished?: Promise<void> };
    }
  ).startViewTransition;

  const isMainSurface = !root.dataset.surface || root.dataset.surface === 'main';
  if (!options?.animate || !isMainSurface || prefersReducedMotion() || typeof startViewTransition !== 'function') {
    commitDocumentThemeAndSkin(isDark, skinId, overrides);
    return;
  }

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const ox = options.origin?.x ?? vw * 0.5;
  const oy = options.origin?.y ?? vh * 0.92;
  const radius = Math.hypot(Math.max(ox, vw - ox), Math.max(oy, vh - oy));

  root.style.setProperty('--theme-sweep-x', `${Math.round(ox)}px`);
  root.style.setProperty('--theme-sweep-y', `${Math.round(oy)}px`);
  root.style.setProperty('--theme-sweep-r', `${Math.ceil(radius)}px`);
  root.dataset.themeSweep = 'active';

  try {
    const transition = startViewTransition.call(document, () => {
      commitDocumentThemeAndSkin(isDark, skinId, overrides);
    });
    void transition?.finished?.finally(() => {
      delete root.dataset.themeSweep;
    });
  } catch {
    delete root.dataset.themeSweep;
    commitDocumentThemeAndSkin(isDark, skinId, overrides);
  }
}

/**
 * 将明暗主题 + 配色皮肤应用到当前渲染表面（`main` / `overlay` / `popover`）。
 * 皮肤仅覆盖配色变量，基础结构 Token 锁定在 CSS Foundation 层。
 * 当选择 `system` 时自动监听系统浅/深色切换，返回清理函数。
 */
export function applyTheme(
  preference: ThemePreference = 'dark',
  skinId: string = DEFAULT_SKIN_ID,
  overrides?: SkinColorOverrides,
  options?: ApplyThemeOptions,
): () => void {
  commitWithOptionalSweep(resolveIsDark(preference), skinId, overrides, options);
  if (preference !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => commitDocumentThemeAndSkin(media.matches, skinId, overrides);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/**
 * 在独立渲染表面（Overlay / Popover）中监听设置变更并自动同步主题与配色皮肤。
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
        cleanup = applyTheme(settings.theme ?? 'dark', settings.skin ?? DEFAULT_SKIN_ID, settings.skinOverrides);
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
