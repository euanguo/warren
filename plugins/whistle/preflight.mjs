/**
 * Whistle 实例启动前的环境自检。
 *
 * 审计（thr_4upuc888cu）里 `fork` 连撞四关：`w2Path` 指向已失效的 `/tmp` 副本、
 * `PATH` 里没有 `node`（Finder 启动的 app 只有 `/usr/bin:/bin`）、根证书解析失败。
 * 每一关都要 4 分钟试错，而且报错只说「起不来」。
 *
 * 这个文件**不碰 fs、不碰进程**：所有 IO 由调用方注入（host.mjs 传真货，
 * tests 传假货），所以能直接离线测。每项失败给独立错误码 + 「改哪个设置」。
 */

/** 重启后不会保留的路径：`/tmp` 的 w2Path 是「这次能用，下次就没了」的典型陷阱。 */
const VOLATILE_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'];

export function isVolatilePath(file) {
  const value = String(file ?? '').trim();
  if (!value) return false;
  // macOS 的 /tmp 就是 /private/tmp，两种写法都要认
  const candidates = [value, value.startsWith('/private') ? value.slice('/private'.length) : `/private${value}`];
  return VOLATILE_PREFIXES.some((prefix) => candidates.some((candidate) => candidate.startsWith(prefix)));
}

/**
 * 解析 shebang 需要的解释器。
 *
 * - `#!/usr/bin/env node` → 必须在 PATH 里找到 node（homebrew 的 w2 就是这种壳脚本，
 *   app 从 Finder 启动时 PATH 里没有 node，报错是 `env: node: No such file or directory`）
 * - `#!/usr/local/bin/node` → 这个绝对路径必须存在
 * - 没有 shebang（原生二进制 / 我们的 bundled whistle.js 走 process.execPath）→ 不检查
 */
export function interpreterOf(head) {
  const first = String(head ?? '')
    .split('\n', 1)[0]
    .trim();
  if (!first.startsWith('#!')) return { kind: 'none' };
  const tokens = first.slice(2).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { kind: 'none' };
  const command = tokens[0];
  const base = command.split('/').pop();
  if (base === 'env' && tokens[1]) {
    const target = tokens[1];
    if (!target.split('/').pop().startsWith('node')) return { kind: 'other', command: target };
    return { kind: 'node-from-path', command: target };
  }
  if (base.startsWith('node')) {
    return command.startsWith('/') ? { kind: 'node-absolute', command } : { kind: 'node-from-path', command };
  }
  return { kind: 'other', command };
}

/**
 * 检查 `w2` 可执行文件本身。
 *
 * @param {object} options
 * @param {string} options.file        要执行的路径
 * @param {string} options.label       展示名（设置值 / bundled:... / PATH 命中）
 * @param {boolean} options.exists
 * @param {boolean} options.executable 有执行位（或对 .js 用当前解释器跑）
 * @param {string} [options.head]      文件头（读不到就省略，只跳过解释器检查）
 * @param {string|null} options.nodeOnPath  PATH 里 node 的绝对路径
 * @param {(file: string) => boolean} options.fileExists
 * @param {boolean} options.runsWithExecPath 是否由 process.execPath 执行（bundled / .js）
 */
export function checkW2(options) {
  const errors = [];
  const warnings = [];
  const file = String(options?.file ?? '');
  const label = String(options?.label ?? file);
  if (!options?.exists) {
    errors.push({
      code: 'WHISTLE_W2_NOT_FOUND',
      message: `找不到 w2: ${label}`,
      hint: '在插件设置 w2Path 填一个长期存在的 w2 绝对路径，或重新安装插件用内置 Whistle。',
    });
    return { ok: false, errors, warnings };
  }
  if (options.checkVolatile !== false && isVolatilePath(file)) {
    warnings.push({
      code: 'WHISTLE_W2_PATH_VOLATILE',
      message: `w2Path 在临时目录里（${file}），重启系统后可能消失`,
      hint: '把 w2 放到 ~/.local/bin 或插件内置目录，再把设置 w2Path 指过去。',
    });
  }
  if (options.runsWithExecPath !== true && options.executable !== true) {
    errors.push({
      code: 'WHISTLE_W2_NOT_EXECUTABLE',
      message: `w2 没有执行权限: ${file}`,
      hint: `chmod +x ${file}，或改设置 w2Path 指向可执行的 w2。`,
    });
  }
  const interpreter = interpreterOf(options.head);
  if (interpreter.kind === 'node-from-path' && !options.nodeOnPath) {
    errors.push({
      code: 'WHISTLE_NODE_NOT_FOUND',
      message: `${label} 是 node 脚本，但 PATH 里没有 node（当前 PATH: ${String(options.pathEnv ?? '').slice(0, 200) || '(空)'}）`,
      hint: '安装 Node 并确保 warren 能看见它；或把设置 w2Path 指向仓库内置的 whistle.js（用 app 自带的 node 执行）。',
    });
  }
  if (interpreter.kind === 'node-absolute' && !options.fileExists?.(interpreter.command)) {
    errors.push({
      code: 'WHISTLE_NODE_NOT_FOUND',
      message: `${label} 的解释器不存在: ${interpreter.command}`,
      hint: '重装 Node，或改设置 w2Path 指向仓库内置的 whistle.js。',
    });
  }
  return { ok: errors.length === 0, errors, warnings, interpreter };
}

/**
 * 检查根证书。
 *
 * whistle 第一次启动会自己生成根证书，所以「文件不存在」只是提示；
 * 「文件存在但解析不了」才是硬错误——那种实例能起来但所有 HTTPS 解密都失败。
 */
export function checkRootCa(options) {
  const errors = [];
  const warnings = [];
  const file = String(options?.file ?? '');
  if (!file) {
    warnings.push({
      code: 'WHISTLE_ROOT_CA_UNKNOWN',
      message: '没有解析出根证书路径（WHISTLE_PATH 为空），跳过检查',
      hint: '在插件设置 whistlePath 填一个持久目录。',
    });
    return { ok: true, errors, warnings };
  }
  if (!options?.exists) {
    warnings.push({
      code: 'WHISTLE_ROOT_CA_PENDING',
      message: `还没有根证书（${file}）；首次启动会生成`,
      hint: '启动一次实例后再跑 doctor 确认。',
    });
    return { ok: true, errors, warnings };
  }
  let text = '';
  try {
    text = String(options.readFile?.(file) ?? '');
  } catch (error) {
    errors.push({
      code: 'WHISTLE_ROOT_CA_INVALID',
      message: `读不到根证书 ${file}: ${error instanceof Error ? error.message : String(error)}`,
      hint: `检查 ${file} 的权限；损坏就删掉它，下次启动会重新生成。`,
    });
    return { ok: false, errors, warnings };
  }
  if (!text.includes('BEGIN CERTIFICATE')) {
    errors.push({
      code: 'WHISTLE_ROOT_CA_INVALID',
      message: `根证书不是 PEM: ${file}`,
      hint: `删掉 ${file} 后重启实例，whistle 会重新生成。`,
    });
    return { ok: false, errors, warnings };
  }
  try {
    options.parse?.(text);
  } catch (error) {
    errors.push({
      code: 'WHISTLE_ROOT_CA_INVALID',
      message: `根证书无法解析 ${file}: ${error instanceof Error ? error.message : String(error)}`,
      hint: `删掉 ${file} 后重启实例；若换了 whistlePath，请把旧目录整个换掉。`,
    });
    return { ok: false, errors, warnings };
  }
  return { ok: true, errors, warnings };
}

/** 把多段自检结果合成一个可 throw 的形状；errors 优先，warnings 只返回给调用方记日志。 */
export function combine(results) {
  const errors = results.flatMap((item) => item.errors ?? []);
  const warnings = results.flatMap((item) => item.warnings ?? []);
  return { ok: errors.length === 0, errors, warnings };
}

export function describeFailure(codes) {
  const first = codes[0];
  if (!first) return null;
  return `${first.code}: ${first.message}${first.hint ? `\n提示：${first.hint}` : ''}`;
}
