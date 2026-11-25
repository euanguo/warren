/**
 * 数据根 —— **应用产生的一切都在这一个目录下**。
 *
 * 默认 `~/.warren`（CLI 也能一行算出来），`WARREN_HOME` 可覆盖。
 *
 * 为什么不是 `app.getPath('userData')`：CLI 与主进程必须算出**同一个**根，
 * 算错就是「应用明明在跑却报没在跑」这种最难查的假象。`~/.warren` 一行就能算出来，
 * 不需要在 CLI 里复刻 Electron 的平台路径规则；也符合 CLI-first 工具的习惯
 * （`~/.docker` / `~/.kube` / `~/.npm`）。
 *
 * 布局：
 * ```
 * <root>/app/        Electron userData（渲染层窗口的 Chromium profile）
 * <root>/core/       warren.db + sessions/<env>/ + plugins/<id>/
 * <root>/runtime/    envd.sock + runtime.json（RPC 端点与 token）
 * <root>/whistle/    WHISTLE_PATH + STARTING_DATA_DIR（whistle 的规则/证书/实例注册表）
 * <root>/logs/       Electron 日志
 * <root>/crashDumps/
 * ```
 *
 * **纯 Node，不 import electron** —— `bin/warren.mjs` 和 `browser/policy.ts` 那条
 * 测试链都要用它。CLI 里那 3 行是它的副本（见 `bin/warren.mjs` 顶部注释）。
 *
 * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §6。
 */
import os from 'node:os';
import path from 'node:path';

export interface WarrenPaths {
  home: string;
  app: string;
  core: string;
  runtime: string;
  whistle: string;
  logs: string;
  crashDumps: string;
}

export function warrenHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WARREN_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.warren');
}

export function warrenPaths(env: NodeJS.ProcessEnv = process.env): WarrenPaths {
  const home = warrenHome(env);
  return {
    home,
    app: path.join(home, 'app'),
    core: path.join(home, 'core'),
    runtime: path.join(home, 'runtime'),
    whistle: path.join(home, 'whistle'),
    logs: path.join(home, 'logs'),
    crashDumps: path.join(home, 'crashDumps'),
  };
}
