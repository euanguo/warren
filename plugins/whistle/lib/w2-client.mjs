/**
 * Whistle CLI 定位、预检、本地 HTTP API 客户端与运行实例诊断。
 */
import { execFile } from 'node:child_process';
import { accessSync, closeSync, constants as fsConstants, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRootCa, checkW2, combine } from '../preflight.mjs';
import { INSPECT_TIMEOUT_MS, PROBE_TIMEOUT_MS, fail, requireInstance, sleep } from './shared.mjs';

export function findOnPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 打包后的应用从 Finder 启动，PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，所以要兜底几个常见位置。 */
export async function resolveW2(host) {
  const asCommand = (file, label, source) => {
    const isScript = /\.(?:c?js|mjs)$/i.test(file) || file.includes('node_modules');
    return {
      file: isScript ? process.execPath : file,
      // 真正要检查/执行的东西：脚本用 app 自带的 node 跑，二进制直接 execFile
      scriptFile: file,
      isScript,
      prefixArgs: isScript ? [file] : [],
      env: isScript ? { ELECTRON_RUN_AS_NODE: '1' } : {},
      display: label,
      source,
    };
  };
  const settings = await host.settings.get();
  const configured = String(settings.w2Path || '').trim();
  // 内置 whistle 永远优先：外部 w2Path 只是内置缺失时的兜底。
  // 否则一个已经失效的 /tmp 脚本或机器上残留的旧版 whistle 就能让插件整体起不来。
  const bundled = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'node_modules',
    'whistle',
    'bin',
    'whistle.js',
  );
  if (existsSync(bundled)) {
    if (configured) {
      await host.log.warn(`设置里的 w2Path（${configured}）已忽略：插件优先使用内置 Whistle`);
    }
    return asCommand(bundled, `bundled:${bundled}`, 'bundled');
  }
  if (configured) {
    if (!existsSync(configured)) fail('WHISTLE_W2_NOT_FOUND', `设置里的 w2Path 不存在: ${configured}`);
    return asCommand(configured, configured, 'configured');
  }
  const found = findOnPath('w2');
  if (found) return asCommand(found, found, 'path');
  for (const candidate of [
    path.join(os.homedir(), '.local/bin/w2'),
    '/usr/local/bin/w2',
    '/opt/homebrew/bin/w2',
    path.join(os.homedir(), '.n/bin/w2'),
  ]) {
    if (existsSync(candidate)) return asCommand(candidate, candidate, 'path');
  }
  fail('WHISTLE_W2_NOT_FOUND', '找不到内置 Whistle；重新安装插件，或在设置里填外部 w2Path。');
}

/** 读文件头（判断 shebang）。只读前 200 字节，避免把大二进制整个读进来。 */
export function readHead(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(200);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 读不到文件头只影响 shebang 检查，不影响执行
      }
    }
  }
}

export function isExecutable(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 数据根：`WHISTLE_PATH` 优先，否则 `WARREN_HOME/whistle`。所有实例共用一张根证书。 */
export function whistleRoot(settings) {
  const configured = String(settings?.whistlePath || '').trim();
  if (configured) return configured;
  const home = process.env.WARREN_HOME ? path.resolve(process.env.WARREN_HOME) : path.join(os.homedir(), '.warren');
  return path.join(home, 'whistle');
}

/**
 * 起实例前的自检：w2 可执行、node 可解析、根证书可解析。
 *
 * 审计 thr_4upuc888cu 里 fork 连撞这四关，每一步都要重新试错；这里一次报清，
 * 且每项带独立错误码 + 「改哪个设置」。
 */
export async function preflight(host) {
  const settings = await host.settings.get();
  const w2 = await resolveW2(host);
  const caFile = path.join(whistleRoot(settings), '.whistle', 'certs', 'root.crt');
  const result = combine([
    checkW2({
      file: w2.scriptFile,
      label: w2.display,
      exists: existsSync(w2.scriptFile),
      executable: isExecutable(w2.scriptFile),
      runsWithExecPath: w2.isScript,
      head: w2.isScript ? '' : readHead(w2.scriptFile),
      // 只有「用户自己在设置里填的路径」才谈得上临时目录；插件内置路径跟着安装目录走
      checkVolatile: w2.source === 'configured',
      nodeOnPath: findOnPath('node'),
      pathEnv: process.env.PATH,
      fileExists: existsSync,
    }),
    checkRootCa({
      file: caFile,
      exists: existsSync(caFile),
      readFile: (file) => readFileSync(file, 'utf8'),
      // 用 Node 自带的 X509 解析，和 whistle 自己用 node-forge 读的是同一个 PEM
      parse: (pem) => new X509Certificate(pem),
    }),
  ]);
  if (!result.ok) {
    const first = result.errors[0];
    fail(first.code, `${first.message}\n提示：${first.hint}`);
  }
  for (const warning of result.warnings) {
    await host.log.warn(`${warning.code}: ${warning.message}（${warning.hint}）`);
  }
  return { w2, rootCa: caFile, warnings: result.warnings };
}

export async function whistleEnv(host) {
  const settings = await host.settings.get();
  const env = { ...process.env };
  /*
   * 数据根（和 src/main/paths.ts 一致，默认 `~/.warren`）：
   * - `WHISTLE_PATH` 决定规则 / 值 / 根证书放哪（不是 `.` 开头的值按原样当路径用）
   * - `STARTING_DATA_DIR` 决定实例注册表放哪（`starting` 包会在它下面再建 `.startingAppData`）
   *
   * 两个都设，实例才是「自洽的」：`w2 stop -S <storage>` 读的是同一个注册表。
   * 代价是用户手敲 `w2 status` 看不到我们起的实例（除非他也设 STARTING_DATA_DIR）。
   */
  const dir = whistleRoot(settings);
  env.WHISTLE_PATH = dir;
  env.STARTING_DATA_DIR = dir;
  return env;
}

// 单次调用的上限是 30s（WARREN_PLUGIN_TIMEOUT_MS），下面这些等待之和必须留在它以内
export function runW2(w2, args, env, timeoutMs = 12000) {
  // whistle 的 `starting` 守护进程用 `spawn(process.env.STARTING_EXEC_PATH || 'node')` 拉起自己。
  // 打包后的 app PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，没有 node；脚本模式必须显式把
  // app 自带的 Node（Electron + ELECTRON_RUN_AS_NODE）传下去，否则即使内置了 whistle 也会 ENOENT。
  const launchEnv = { ...env, ...w2.env };
  if (w2.isScript) {
    launchEnv.STARTING_EXEC_PATH = process.execPath;
    launchEnv.ELECTRON_RUN_AS_NODE = '1';
  }
  return new Promise((resolve) => {
    execFile(w2.file, [...w2.prefixArgs, ...args], { env: launchEnv, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ error, output: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });
}

// ── whistle 的 HTTP API（本地无鉴权） ─────────────────────────────────

export async function call(port, pathname, options = {}) {
  const { timeoutMs = PROBE_TIMEOUT_MS, signal, ...fetchOptions } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...fetchOptions,
    signal: combinedSignal,
  });
  return response;
}

/** 活着就回 `{storage, version}`，否则 null。这是「实例是否在跑」的唯一判据。 */
export async function statusOf(port, options = {}) {
  try {
    const response = await call(port, '/cgi-bin/status', options);
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.name === 'whistle' ? data : null;
  } catch {
    return null;
  }
}

export async function callJson(port, pathname, options = {}, timeout = INSPECT_TIMEOUT_MS) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail('WHISTLE_NON_JSON', `${pathname} 返回非 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) fail('WHISTLE_HTTP_ERROR', `${pathname} HTTP ${response.status}`);
  if (!data || data.ec !== 0) {
    fail('WHISTLE_API_ERROR', `${pathname} 返回失败：${JSON.stringify(data).slice(0, 800)}`);
  }
  return data;
}

export function form(data) {
  return new URLSearchParams(data).toString();
}

export async function postForm(port, pathname, data) {
  const response = await call(port, pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(data),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ec: response.ok ? 0 : -1, raw: text };
  }
}

/**
 * 打开 HTTPS 解密。
 *
 * whistle 默认**只做 CONNECT 隧道**，那样它看不到路径，规则根本无从匹配
 * （实测：不解密时客户端拿到的是真证书）。所以这一步是规则生效的前置条件。
 */
export async function enableHttpsCapture(port) {
  await postForm(port, '/cgi-bin/intercept-https-connects', { interceptHttpsConnects: '1' });
}

/**
 * 允许同时选中多个规则组。
 *
 * Whistle 默认是单选：选中新规则会把旧规则取消。Warren 的实例需要同时承载
 * backendMap / 本地资源 / 预设等规则组，所以新实例启动后显式打开这个开关，
 * 并回读确认；只写配置不回读会把「接口成功但实际没生效」留给人去猜。
 */
export async function enableMultipleChoice(port) {
  const before = await readRulesData(port);
  if (before.allowMultipleChoice === true) return { changed: false };
  const result = await postForm(port, '/cgi-bin/rules/allow-multiple-choice', { allowMultipleChoice: '1' });
  if (result.ec !== 0) fail('WHISTLE_MULTI_CHOICE_FAILED', `打开多选规则失败：${JSON.stringify(result)}`);
  const after = await readRulesData(port);
  if (after.allowMultipleChoice !== true) {
    fail('WHISTLE_MULTI_CHOICE_UNCONFIRMED', '打开多选规则后回读 allowMultipleChoice 仍不是 true');
  }
  return { changed: true };
}

export async function waitForStatus(port, storage, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await statusOf(port);
    if (status && (!storage || status.storage === storage)) return status;
    await sleep(300);
  }
  return null;
}

export async function waitUntilGone(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await statusOf(port))) return true;
    await sleep(300);
  }
  return false;
}

// ── 端口 ─────────────────────────────────────────────────────────────

export function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

export async function pickPort(base) {
  for (let port = base; port < base + 200; port += 1) {
    // 8899 是 whistle 的默认端口，也是 scripts/serve-fixture.mjs 的默认端口，别用
    if (port === 8899) continue;
    if (await canBind(port)) return port;
  }
  fail('WHISTLE_NO_FREE_PORT', `从 ${base} 往后 200 个端口都被占了`);
}

// ── 规则 ─────────────────────────────────────────────────────────────

export async function readRulesData(port) {
  const response = await call(port, '/cgi-bin/rules/list');
  return response.json();
}

export function rulesFromData(data) {
  const list = Array.isArray(data.list) ? data.list : [];
  // whistle 的字段不保证齐全（selected 可能缺），而插件 rpc 的返回值过不了 JSON 里的 undefined
  return list.map((rule) => ({
    name: String(rule.name ?? ''),
    data: String(rule.data ?? ''),
    selected: Boolean(rule.selected),
  }));
}

export async function readRules(port) {
  return rulesFromData(await readRulesData(port));
}

/** 规则 `rules/list` 事实视图：多选、query、选中态都以 live API 回读为准。 */
export async function readRulesView(port) {
  const data = await readRulesData(port);
  return {
    rules: rulesFromData(data),
    allowMultipleChoice: data.allowMultipleChoice === true,
    selected: (Array.isArray(data.list) ? data.list : [])
      .filter((rule) => Boolean(rule.selected) && !isGroupRuleName(rule.name))
      .map((rule) => String(rule.name)),
  };
}

export function isGroupRuleName(name) {
  return typeof name === 'string' && name.startsWith('\r');
}

/** `rules` 的共用视图：命令和 rpc 读同一份 live 回读，实例没跑时给确定状态而不是抛 API 错误。 */
export async function rulesView(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const status = await statusOf(instance.port);
  const view = status ? await readRulesView(instance.port) : { rules: [], allowMultipleChoice: false, selected: [] };
  return { storage: instance.storage, port: instance.port, alive: Boolean(status), ...view };
}

export async function readRule(port, name) {
  const rules = await readRules(port);
  return rules.find((rule) => rule.name === name) ?? null;
}

export async function readFrames(port, input) {
  const query = new URLSearchParams();
  if (input && input.reqId) query.set('curReqId', String(input.reqId));
  if (input && input.lastFrameId) query.set('lastFrameId', String(input.lastFrameId));
  return callJson(port, `/cgi-bin/get-frames?${query.toString()}`);
}

/**
 * 从 Warren 自己的 starting 注册表读实例 pid。
 *
 * `statusOf()` 仍是存活的唯一判据；这里只补 pid 元数据给需要直接调用
 * whistle live API 的自动化。注册表缺失/冲突时返回 null，不把它当成存活依据。
 */
export async function instancePid(instance, settings) {
  // 注册表跟着 STARTING_DATA_DIR 走，也就是 whistleRoot（设置里的 whistlePath 优先）
  const root = path.join(whistleRoot(settings), '.startingAppData');
  for (const name of [`#${instance.storage}#`, `%23${instance.storage}%23`]) {
    const file = path.join(root, name);
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (
        data?.options?.storage === instance.storage &&
        Number(data?.options?.port) === instance.port &&
        Number.isInteger(data?.pid)
      ) {
        return data.pid;
      }
    } catch {
      // 注册表不是存活判据；statusOf 已经负责 alive。
    }
  }
  return null;
}

export async function requireRunningInstance(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const status = await statusOf(instance.port);
  if (!status) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  return { instance, status };
}
