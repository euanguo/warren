/**
 * preload 通过 contextBridge 暴露的 IPC 面。
 *
 * 类型定义在 `@shared/types`（跨进程单一来源），这里只做全局声明，
 * 让渲染层可以 `window.envApi.xxx()` 而不用到处 import。
 */
import type { EnvApi } from '@shared/types';

declare global {
  interface Window {
    envApi: EnvApi;
  }
}

export type { EnvApi };
