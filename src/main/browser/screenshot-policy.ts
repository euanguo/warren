import type { ScreenshotOptions } from '../../shared/types.ts';

/**
 * Electron `capturePage()` 只捕获可见视口，不实现整页和裁剪语义。
 *
 * 这些请求在 CDP 拿不到 surface 时必须继续失败，不能返回一张语义不同的图。
 */
export function canFallbackToElectronScreenshot(opts: ScreenshotOptions): boolean {
  return !opts.fullPage && !opts.clip;
}

/** CDP 在后台窗口上可能永远等不到 surface；可见视口必须快速切到 Electron。 */
export const SCREENSHOT_CDP_TIMEOUT_MS = 3000;

export function screenshotFallbackError(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return Object.assign(new Error(`CDP 未拿到 surface，Electron capturePage 也未返回图像：${detail}`), {
    code: 'SCREENSHOT_UNAVAILABLE',
  });
}
