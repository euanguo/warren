/**
 * 环境页（`WebContentsView`）的 preload —— 把主世界补成真 Chrome 的形状。
 *
 * 为什么要它：Electron 的 `window.chrome` 是**空对象**，而真 Chrome 有
 * `loadTimes` / `csi` / `app` 三个成员。`Object.keys(window.chrome).length === 0`
 * 是一条一眼就能命中的检测（两边实测见 `docs/CHROME-SHELL-PLAN.md` §2.7）。
 *
 * 只补 API 表面，**不伪造数值语义** —— 那三个函数的返回值是 Chrome 内部实现细节，
 * 深查一定露馅，本文件不追这个（记在该文档 §6 未决问题）。同理不做
 * `Function.prototype.toString` 那种全局覆盖：那比不补还显眼。
 *
 * 注入走 `contextBridge.executeInMainWorld`（官方 API）。**不要**改用 CDP 的
 * `Page.addScriptToEvaluateOnNewDocument` —— 那是自动化痕迹，得不偿失。
 * 实测：注入发生在 `document.readyState === 'loading'`，早于页面自己的脚本。
 */
import { contextBridge } from 'electron';

contextBridge.executeInMainWorld({
  func: () => {
    const target = window as Window & { chrome?: Record<string, unknown> };
    const chrome = target.chrome;
    // 真 Chrome 里这三个本来就有，别覆盖用户/页面自己的定义
    if (!chrome || 'csi' in chrome) return;

    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const sec = (ms: number | undefined) => (ms ?? 0) / 1000;

    Object.assign(chrome, {
      loadTimes: () => ({
        requestTime: sec(nav?.startTime),
        startLoadTime: sec(nav?.startTime),
        commitLoadTime: sec(nav?.responseStart),
        finishDocumentLoadTime: sec(nav?.domContentLoadedEventEnd),
        finishLoadTime: sec(nav?.loadEventEnd),
        firstPaintTime: 0,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2',
      }),
      csi: () => ({
        onloadT: nav?.loadEventEnd ?? 0,
        startE: performance.timeOrigin / 1000 + performance.now() / 1000,
        pageT: performance.now() / 1000,
        tran: 15,
      }),
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: () => null,
        getIsInstalled: () => false,
      },
    });
  },
});
