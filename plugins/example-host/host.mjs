/**
 * runtime=host 的示例插件。
 *
 * 这份代码跑在 `utilityProcess.fork` 起的独立 Node 进程里，**全权**：
 * fs / child_process / fetch / npm 依赖都能用。
 * host API 仍然通过 JSON-RPC 代理回核心，权限门控在主进程那一侧。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { cwd, versions } from 'node:process';

export default {
  async activate(ctx) {
    await ctx.host.log.info(`host 运行时启动，node ${versions.node}`);
  },

  /** 证明「真的在独立进程里、真的能用 Node」 */
  async probe() {
    return {
      pid: process.pid,
      node: versions.node,
      electron: versions.electron || null,
      cwd: cwd(),
      cwdEntries: readdirSync(cwd()).slice(0, 5),
      gitHead: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    };
  },
};
