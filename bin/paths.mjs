import os from 'node:os';
import path from 'node:path';

/** 与 `src/main/paths.ts` 对齐的数据根计算（纯 ESM，零 `src/` 依赖）。 */
export function warrenHome(env = process.env) {
  const override = env.WARREN_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.warren');
}

export function warrenPaths(env = process.env) {
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
