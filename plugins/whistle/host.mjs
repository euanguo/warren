/**
 * Whistle 代理插件后端（`runtime: "host"`）。
 *
 * 这份代码跑在 `utilityProcess.fork` 起的独立 Node 进程里，所以能用
 * `child_process` / `fs` / `fetch`；**环境配置仍然只能通过 host API 改**
 * （`environment.update` / `start` / `stop` 要 `environment.write` 权限）。
 *
 * 分工（见 docs/WHISTLE-PLUGIN-PLAN.md）：
 * - **实例由本插件托管**：whistle 自己守护化，插件禁用/卸载后实例照跑。
 * - **环境绑定** = 把 `env.proxy` 指向实例端口 + 让这个环境信任实例的根证书。
 *   后者的判定在主进程（`setCertificateVerifyProc`），插件只负责把 PEM 落到环境目录。
 *
 * 实例存活一律靠探 `GET /cgi-bin/status` 并比对 `storage` —— 不把 starting
 * 注册表或 `w2 status` 当作存活依据；注册表只补 pid 元数据给自动化使用。
 */
import { execFile } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { X509Certificate } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendStaticOnlyLayer,
  composePreset,
  diffRules,
  importRulesText,
  mergePresets,
  normalizeText,
  resolvePresetVariables,
  SCENARIOS,
  scenarioLayers,
  scenarioPresetIds,
  sha256,
  validatePreset,
  validateRulesText,
} from './presets.mjs';
import { checkRootCa, checkW2, combine } from './preflight.mjs';
import { agentApiFor, agentApiRequirements } from './agent-api.mjs';

const INSTANCES_KEY = 'instances';
const DEFAULT_PORT_BASE = 8900;
/** 每个实例里放规则的文件名。一个实例一份规则，正是「一个 worktree 一套」。 */
const RULE_NAME = 'warren';
const PROBE_TIMEOUT_MS = 1500;
const INSPECT_TIMEOUT_MS = 20000;
const COMPOSE_TIMEOUT_MS = 30000;
const STORAGE_RE = /^[a-z0-9][a-z0-9-]*$/;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 实例表（插件的 kv） ───────────────────────────────────────────────

async function readInstances(host) {
  const raw = await host.storage.kv.get(INSTANCES_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item.storage === 'string' && typeof item.port === 'number');
}

async function writeInstances(host, list) {
  await host.storage.kv.set(INSTANCES_KEY, list);
}

async function requireInstance(host, storage) {
  const name = String(storage || '').trim();
  if (!name) fail('BAD_REQUEST', '需要 storage（实例名）');
  const instance = (await readInstances(host)).find((item) => item.storage === name);
  if (!instance) fail('WHISTLE_INSTANCE_UNKNOWN', `没有登记过叫 ${name} 的实例`);
  return instance;
}

// ── w2 定位 ───────────────────────────────────────────────────────────

function findOnPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 打包后的应用从 Finder 启动，PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，所以要兜底几个常见位置。 */
async function resolveW2(host) {
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
function readHead(file) {
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

function isExecutable(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 数据根：`WHISTLE_PATH` 优先，否则 `WARREN_HOME/whistle`。所有实例共用一张根证书。 */
function whistleRoot(settings) {
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
async function preflight(host) {
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

async function whistleEnv(host) {
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
function runW2(w2, args, env, timeoutMs = 12000) {
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

async function call(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return response;
}

/** 活着就回 `{storage, version}`，否则 null。这是「实例是否在跑」的唯一判据。 */
async function statusOf(port) {
  try {
    const response = await call(port, '/cgi-bin/status');
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.name === 'whistle' ? data : null;
  } catch {
    return null;
  }
}

async function callJson(port, pathname, options = {}, timeout = INSPECT_TIMEOUT_MS) {
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

function form(data) {
  return new URLSearchParams(data).toString();
}

async function postForm(port, pathname, data) {
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
async function enableHttpsCapture(port) {
  await postForm(port, '/cgi-bin/intercept-https-connects', { interceptHttpsConnects: '1' });
}

/**
 * 允许同时选中多个规则组。
 *
 * Whistle 默认是单选：选中新规则会把旧规则取消。Warren 的实例需要同时承载
 * backendMap / 本地资源 / 预设等规则组，所以新实例启动后显式打开这个开关，
 * 并回读确认；只写配置不回读会把「接口成功但实际没生效」留给人去猜。
 */
async function enableMultipleChoice(port) {
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

async function waitForStatus(port, storage, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await statusOf(port);
    if (status && (!storage || status.storage === storage)) return status;
    await sleep(300);
  }
  return null;
}

async function waitUntilGone(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await statusOf(port))) return true;
    await sleep(300);
  }
  return false;
}

// ── 端口 ─────────────────────────────────────────────────────────────

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(base) {
  for (let port = base; port < base + 200; port += 1) {
    // 8899 是 whistle 的默认端口，也是 scripts/serve-fixture.mjs 的默认端口，别用
    if (port === 8899) continue;
    if (await canBind(port)) return port;
  }
  fail('WHISTLE_NO_FREE_PORT', `从 ${base} 往后 200 个端口都被占了`);
}

// ── 规则 ─────────────────────────────────────────────────────────────

async function readRulesData(port) {
  const response = await call(port, '/cgi-bin/rules/list');
  return response.json();
}

function rulesFromData(data) {
  const list = Array.isArray(data.list) ? data.list : [];
  // whistle 的字段不保证齐全（selected 可能缺），而插件 rpc 的返回值过不了 JSON 里的 undefined
  return list.map((rule) => ({
    name: String(rule.name ?? ''),
    data: String(rule.data ?? ''),
    selected: Boolean(rule.selected),
  }));
}

async function readRules(port) {
  return rulesFromData(await readRulesData(port));
}

/** 规则 `rules/list` 事实视图：多选、query、选中态都以 live API 回读为准。 */
async function readRulesView(port) {
  const data = await readRulesData(port);
  return {
    rules: rulesFromData(data),
    allowMultipleChoice: data.allowMultipleChoice === true,
    selected: (Array.isArray(data.list) ? data.list : [])
      .filter((rule) => Boolean(rule.selected) && !isGroupRuleName(rule.name))
      .map((rule) => String(rule.name)),
  };
}

function isGroupRuleName(name) {
  return typeof name === 'string' && name.startsWith('\r');
}

/** `rules` 的共用视图：命令和 rpc 读同一份 live 回读，实例没跑时给确定状态而不是抛 API 错误。 */
async function rulesView(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const status = await statusOf(instance.port);
  const view = status ? await readRulesView(instance.port) : { rules: [], allowMultipleChoice: false, selected: [] };
  return { storage: instance.storage, port: instance.port, alive: Boolean(status), ...view };
}

async function readRule(port, name) {
  const rules = await readRules(port);
  return rules.find((rule) => rule.name === name) ?? null;
}

async function readFrames(port, input) {
  const query = new URLSearchParams();
  if (input && input.reqId) query.set('curReqId', String(input.reqId));
  if (input && input.lastFrameId) query.set('lastFrameId', String(input.lastFrameId));
  return callJson(port, `/cgi-bin/get-frames?${query.toString()}`);
}

function sensitiveHeader(name) {
  return [
    'authorization',
    'cookie',
    'proxy-authorization',
    'set-cookie',
    'x-csrfcode',
    'x-csrf-token',
    'x-xsrf-token',
    'saas_token',
    'saas-token',
  ].includes(String(name || '').toLowerCase());
}

function decodeBody(part, limit = 128 * 1024) {
  if (!part || typeof part !== 'object') return { body: '', encoding: null };
  const raw = typeof part.base64 === 'string' ? part.base64 : '';
  let text = '';
  if (raw) text = Buffer.from(raw, 'base64').toString('utf8');
  else if (typeof part.body === 'string') text = part.body;
  const truncated = Boolean(limit && text.length > limit);
  const body = truncated ? text.slice(0, limit) : text;
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : '';
  } catch {
    parsed = body;
  }
  return { body: parsed, encoding: raw ? 'base64' : 'text', truncated };
}

function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (
        [
          'authorization',
          'cookie',
          'password',
          'passwd',
          'secret',
          'csrftoken',
          'saastoken',
          'accesstoken',
          'refreshtoken',
          'ticket',
        ].includes(normalized)
      ) {
        return [key, item ? '[REDACTED]' : ''];
      }
      return [key, redactJson(item)];
    }),
  );
}

function requestIdOf(req, res, body) {
  for (const source of [body, res, req]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['RequestId', 'requestId', 'request_id', 'reqId', 'req_id']) {
      if (source[key]) return String(source[key]);
    }
  }
  for (const source of [body, res]) {
    const data = source && source.data;
    if (!data || typeof data !== 'object') continue;
    for (const key of ['RequestId', 'requestId', 'request_id', 'reqId', 'req_id']) {
      if (data[key]) return String(data[key]);
    }
    const response = data.Response;
    if (response && typeof response === 'object') {
      for (const key of ['RequestId', 'requestId', 'request_id', 'reqId', 'req_id']) {
        if (response[key]) return String(response[key]);
      }
    }
  }
  return null;
}

function normalizeTrafficEntry(id, item, input = {}) {
  const raw = item && item.raw && typeof item.raw === 'object' ? item.raw : null;
  const req =
    raw?.req && typeof raw.req === 'object'
      ? raw.req
      : item && item.req && typeof item.req === 'object'
        ? item.req
        : {};
  const res =
    raw?.res && typeof raw.res === 'object'
      ? raw.res
      : item && item.res && typeof item.res === 'object'
        ? item.res
        : {};
  const reqDecoded = decodeBody(req, Number(input.payloadLimit ?? 128 * 1024));
  const resDecoded = decodeBody(res, Number(input.payloadLimit ?? 128 * 1024));
  const redact = input.includeSensitive !== true;
  const reqHeaders = req.headers && typeof req.headers === 'object' ? req.headers : {};
  const resHeaders = res.headers && typeof res.headers === 'object' ? res.headers : {};
  const requestHeaders = Object.fromEntries(
    Object.entries(reqHeaders).map(([key, value]) => [key, redact && sensitiveHeader(key) ? '[REDACTED]' : value]),
  );
  const responseHeaders = Object.fromEntries(
    Object.entries(resHeaders).map(([key, value]) => [key, redact && sensitiveHeader(key) ? '[REDACTED]' : value]),
  );
  return {
    source: 'whistle-live',
    entryId: String(id),
    startTime: item && item.startTime,
    endTime: item && item.endTime,
    url: item && item.url,
    method: req.method ?? null,
    status: res.statusCode ?? null,
    requestHeaders,
    responseHeaders,
    requestBody: redact ? redactJson(reqDecoded.body) : reqDecoded.body,
    responseBody: redact ? redactJson(resDecoded.body) : resDecoded.body,
    requestBodyRaw: reqDecoded.body,
    responseBodyRaw: resDecoded.body,
    // Keep the raw request/response needed by HAR/session export. These fields
    // are only present when explicitly requested and never enter normal
    // `traffic` output.
    ...(input.keepRaw === true ? { raw: { req, res } } : {}),
    // A source item is either a raw Whistle record or an already-normalized
    // traffic entry. Keep both shapes usable so export can consume the same
    // data without re-fetching.
    requestBodyEncoding: reqDecoded.encoding || item.requestBodyEncoding,
    responseBodyEncoding: resDecoded.encoding || item.responseBodyEncoding,
    requestBodyTruncated: reqDecoded.truncated || item.requestBodyTruncated,
    responseBodyTruncated: resDecoded.truncated || item.responseBodyTruncated,
    requestSize: req.size ?? item.requestSize,
    responseSize: res.size ?? item.responseSize,
    requestId: requestIdOf(req, res, resDecoded.body),
    rules: item && item.rules ? item.rules : {},
    rulesHeaders: item && item.rulesHeaders ? item.rulesHeaders : {},
    timing: {
      dnsTime: item && item.dnsTime,
      requestTime: item && item.requestTime,
      responseTime: item && item.responseTime,
      endTime: item && item.endTime,
    },
  };
}

function trafficFilters(input) {
  const urls = [].concat(input && input.urls ? input.urls : input && input.url ? input.url : []);
  const methods = []
    .concat(input && input.methods ? input.methods : input && input.method ? input.method : [])
    .map((item) => String(item).toUpperCase());
  const statuses = []
    .concat(input && input.statuses ? input.statuses : input && input.status ? input.status : [])
    .map(Number);
  const since = input && input.since != null ? Number(input.since) : null;
  return { urls, methods, statuses, since };
}

function selectTraffic(rows, input = {}) {
  const { urls, methods, statuses, since } = trafficFilters(input);
  const entries = Object.entries(rows || {})
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => normalizeTrafficEntry(id, item, input))
    .filter((entry) => {
      if (urls.length && !urls.some((part) => String(entry.url || '').includes(String(part)))) return false;
      if (methods.length && !methods.includes(String(entry.method || '').toUpperCase())) return false;
      if (statuses.length && !statuses.includes(Number(entry.status))) return false;
      if (since != null && !(Number(entry.startTime) >= since)) return false;
      return true;
    })
    .sort((a, b) => Number(a.startTime || 0) - Number(b.startTime || 0));
  return entries;
}

async function traffic(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  const params = new URLSearchParams();
  if (input && input.ids) params.set('ids', [].concat(input.ids).join(','));
  if (input && input.statusQuery) params.set('status', [].concat(input.statusQuery).join(','));
  if (input && input.startTime != null) params.set('startTime', String(input.startTime));
  if (input && input.lastRowId != null) params.set('lastRowId', String(input.lastRowId));
  if (input && input.dumpCount != null) params.set('dumpCount', String(input.dumpCount));
  // Whistle treats *any* dumpCount key as snapshot mode, where it ignores count.
  if (input && input.dumpCount == null && input && input.count != null) {
    params.set('count', String(input.count));
  }
  const data = await callJson(instance.port, `/cgi-bin/get-data?${params.toString()}`);
  const entries = selectTraffic(data.data && data.data.data, input);
  return {
    source: 'whistle-live',
    storage: instance.storage,
    port: instance.port,
    capturedAt: new Date().toISOString(),
    cursor: {
      newIds: (data.data?.newIds || []).slice(0, 200),
      newIdsTotal: (data.data?.newIds || []).length,
      lastId: data.data?.lastId,
      endId: data.data?.endId,
    },
    next: {
      endId: data.data?.endId ?? null,
      lastId: data.data?.lastId ?? null,
    },
    summary: {
      total: entries.length,
      methods: [...new Set(entries.map((item) => item.method).filter(Boolean))],
      statuses: [...new Set(entries.map((item) => item.status).filter((item) => item != null))],
    },
    entries,
  };
}

async function trafficSessionObjects(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  const params = new URLSearchParams();
  if (input && input.ids) params.set('ids', [].concat(input.ids).join(','));
  if (input && input.startTime != null) params.set('startTime', String(input.startTime));
  if (input && input.lastRowId != null) params.set('lastRowId', String(input.lastRowId));
  if (input && input.dumpCount != null) params.set('dumpCount', String(input.dumpCount));
  if (input && input.dumpCount == null && input && input.count != null) {
    params.set('count', String(input.count));
  }
  const data = await callJson(instance.port, `/cgi-bin/get-data?${params.toString()}`);
  const rows = data.data && data.data.data;
  return Object.entries(rows || {})
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => ({
      ...item,
      id,
      raw: { req: item.req || {}, res: item.res || {} },
    }));
}

function composerResponse(data) {
  const res = data && data.res;
  if (!res || typeof res !== 'object') return { status: null, headers: {}, body: '', json: null };
  const decoded = decodeBody(res, 0);
  let json = null;
  try {
    json = typeof decoded.body === 'string' ? JSON.parse(decoded.body) : decoded.body;
  } catch {}
  return {
    status: res.statusCode ?? null,
    headers: res.headers || {},
    body: decoded.body,
    json,
    trailers: res.trailers || {},
  };
}

function harEntry(session) {
  const req = session.req || session.raw?.req || {};
  const res = session.res || session.raw?.res || {};
  const reqDecoded = decodeBody(req, 0);
  const resDecoded = decodeBody(res, 0);
  const method = req.method || session.method || 'GET';
  const status = res.statusCode ?? session.status ?? 0;
  const url = session.url || '';
  const reqHeaders = req.headers || session.requestHeaders || {};
  const resHeaders = res.headers || session.responseHeaders || {};
  const reqBody = reqDecoded.body || session.requestBodyRaw || session.requestBody || '';
  const resBody = resDecoded.body || session.responseBodyRaw || session.responseBody || '';
  const started = session.startTime ? new Date(session.startTime).toISOString() : new Date(0).toISOString();
  const elapsed = session.endTime && session.startTime ? session.endTime - session.startTime : 0;
  return {
    startedDateTime: started,
    time: elapsed,
    request: {
      method,
      url,
      httpVersion: req.httpVersion || 'HTTP/1.1',
      headers: Object.entries(reqHeaders).map(([name, value]) => ({ name, value: String(value) })),
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: req.size || session.requestSize || 0,
      postData: reqBody
        ? { mimeType: reqHeaders['content-type'] || 'application/octet-stream', text: String(reqBody) }
        : undefined,
    },
    response: {
      status,
      statusText: '',
      httpVersion: res.httpVersion || 'HTTP/1.1',
      headers: Object.entries(resHeaders).map(([name, value]) => ({ name, value: String(value) })),
      cookies: [],
      content: {
        size: res.size || session.responseSize || 0,
        mimeType: resHeaders['content-type'] || 'application/octet-stream',
        text: String(resBody || ''),
      },
      redirectURL: resHeaders.location || '',
      headersSize: -1,
      bodySize: res.size || session.responseSize || 0,
    },
    cache: {},
    timings: { send: 0, wait: elapsed, receive: 0 },
  };
}

async function compose(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  const url = String((input && input.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) fail('BAD_REQUEST', 'compose 需要 http(s) url');
  const body = {
    url,
    method: String((input && input.method) || 'GET').toUpperCase(),
    headers: input && input.headers ? input.headers : {},
    body: input && input.data != null ? String(input.data) : '',
    needResponse: true,
    useH2: Boolean(input && input.useH2),
    enableProxyRules: input?.enableProxyRules !== false,
  };
  if (input && input.base64) {
    body.body = input.base64;
    body.base64 = input.base64;
  }
  const data = await callJson(
    instance.port,
    '/cgi-bin/composer?needResponse=1',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    COMPOSE_TIMEOUT_MS,
  );
  const response = composerResponse(data);
  const includeSensitive = input?.includeSensitive === true;
  return {
    source: 'whistle-compose',
    storage: instance.storage,
    port: instance.port,
    capturedAt: new Date().toISOString(),
    request: {
      url,
      method: body.method,
      headers: includeSensitive
        ? body.headers
        : Object.fromEntries(
            Object.entries(body.headers).map(([key, value]) => [key, sensitiveHeader(key) ? '[REDACTED]' : value]),
          ),
      body: includeSensitive ? body.body : redactJson(body.body),
      enableProxyRules: body.enableProxyRules,
    },
    response: includeSensitive
      ? response
      : {
          ...response,
          headers: Object.fromEntries(
            Object.entries(response.headers).map(([key, value]) => [key, sensitiveHeader(key) ? '[REDACTED]' : value]),
          ),
          body: redactJson(response.body),
          json: redactJson(response.json),
        },
    ok: response.status != null && response.status >= 200 && response.status < 400,
  };
}

async function doctor(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const status = await statusOf(instance.port);
  if (!status) {
    return {
      storage: instance.storage,
      port: instance.port,
      alive: false,
      ok: false,
      checks: [{ name: 'alive', ok: false, detail: '实例不响应 /cgi-bin/status' }],
    };
  }
  const checks = [];
  const jsonCheck = async (name, pathname) => {
    try {
      const data = await callJson(instance.port, pathname);
      checks.push({ name, ok: data.ec === 0, detail: data });
      return data;
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
      return null;
    }
  };
  checks.push({
    name: 'alive',
    ok: true,
    detail: { version: status.version, storage: status.storage },
  });
  const https = await jsonCheck('https-capture', '/cgi-bin/https-status');
  const rules = await jsonCheck('rules-live', '/cgi-bin/rules/list');
  const rootCa = await fetch(`http://127.0.0.1:${instance.port}/cgi-bin/rootca?type=pem`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
    .then(async (response) => {
      const text = await response.text();
      const ok = response.ok && text.includes('BEGIN CERTIFICATE');
      checks.push({ name: 'root-ca', ok, detail: { present: ok } });
      return ok;
    })
    .catch((error) => {
      checks.push({ name: 'root-ca', ok: false, detail: error.message });
      return false;
    });
  return {
    storage: instance.storage,
    port: instance.port,
    alive: true,
    ok: checks.every((item) => item.ok),
    httpsCapture: https?.enableCapture === true,
    http2Enabled: https?.enableHttp2 === true,
    allowMultipleChoice: rules?.allowMultipleChoice === true,
    rootCa,
    checks,
  };
}

export function requireLiveAgentInstance(instance, status, pid) {
  if (!status) {
    fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  }
  if (status.storage !== instance.storage) {
    fail(
      'WHISTLE_INSTANCE_MISMATCH',
      `端口 ${instance.port} 被 ${status.storage || '未知实例'} 占用，不是 ${instance.storage}`,
    );
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    fail('WHISTLE_API_INSTANCE_UNKNOWN', `找不到实例 ${instance.storage} 的有效 pid`);
  }
  return { ...instance, pid };
}

async function liveAgentInstance(host, instance) {
  const status = await statusOf(instance.port);
  const settings = await host.settings.get();
  const pid = await instancePid(instance, settings);
  return requireLiveAgentInstance(instance, status, pid);
}

async function agent(host, input) {
  const registered = await requireInstance(host, input && input.storage);
  const instance = await liveAgentInstance(host, registered);
  const w2 = await resolveW2(host);
  const api = agentApiFor(instance, w2);
  const method = String((input && input.method) || '').trim();
  const args = Array.isArray(input && input.args) ? input.args : [];
  if (!method) {
    return {
      storage: instance.storage,
      port: instance.port,
      version: await api.network.getStatus(),
      requirements: agentApiRequirements(),
      methods: agentApiRequirements().methods,
    };
  }
  const [group, action] = method.split('.');
  if (!api[group] || typeof api[group][action] !== 'function') {
    fail('WHISTLE_AGENT_METHOD_UNKNOWN', `未知官方 Agent API 方法 ${method}`);
  }
  const result = await api[group][action](...args);
  const includeValues = input && input.includeValues === true;
  return {
    storage: instance.storage,
    port: instance.port,
    method,
    result:
      !includeValues && Array.isArray(result)
        ? result.map((item) => (group === 'rules' && item && typeof item === 'object' ? { ...item, value: '' } : item))
        : result,
  };
}

async function agentStatus(host, input) {
  const registered = await requireInstance(host, input && input.storage);
  const instance = await liveAgentInstance(host, registered);
  const w2 = await resolveW2(host);
  const api = agentApiFor(instance, w2);
  return {
    storage: instance.storage,
    port: instance.port,
    status: await api.network.getStatus(),
    rules: await api.rules.getStatus(),
    plugins: await api.plugins.getStatus(),
    https: await api.https.isEnabled(),
  };
}

async function exportData(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  const type = String((input && (input.type || input.format)) || 'rules');
  const filename = String((input && input.filename) || '').trim();
  const directory = String((input && input.directory) || '').trim();
  if (!directory) fail('BAD_REQUEST', 'export 需要 directory');
  mkdirSync(directory, { recursive: true });
  let pathname;
  let body = '';
  let suffix = 'txt';
  let contentType = 'text/plain';
  if (type === 'rules') {
    const name = String((input && input.name) || RULE_NAME);
    const rule = await readRule(instance.port, name);
    if (!rule) fail('RULE_NOT_FOUND', `没有规则组 ${name}`);
    body = rule.data;
    suffix = 'txt';
  } else if (type === 'values') {
    pathname = '/cgi-bin/values/export';
    contentType = 'application/json';
    suffix = 'txt';
  } else if (type === 'sessions' || type === 'har' || type === 'saz' || type === 'fiddler') {
    pathname = '/cgi-bin/sessions/export';
    const fileType = type === 'sessions' ? 'whistle' : type;
    const sessionRaw = String((input && input.sessions) || '').trim();
    let sessions = [];
    try {
      sessions = sessionRaw ? JSON.parse(sessionRaw) : [];
      if (!Array.isArray(sessions)) sessions = [];
    } catch (error) {
      fail('BAD_REQUEST', `sessions 不是合法 session JSON: ${error.message}`);
    }
    if (!sessions.length) sessions = await trafficSessionObjects(host, input);
    sessions = sessions.filter((session) => {
      const url = String(session.url || '');
      const method = String(session.req?.method || session.method || '').toUpperCase();
      const status = Number(session.res?.statusCode ?? session.status);
      const urls = input?.urls || (input?.url ? [input.url] : []);
      const methods = (input?.methods || (input?.method ? [input.method] : [])).map((item) =>
        String(item).toUpperCase(),
      );
      const statuses = input?.statuses || (input?.status ? [input.status] : []);
      if (urls.length && !urls.some((part) => url.includes(String(part)))) return false;
      if (methods.length && !methods.includes(method)) return false;
      if (statuses.length && !statuses.map(Number).includes(status)) return false;
      return true;
    });
    if (type === 'har') {
      sessions = {
        log: {
          version: '1.2',
          creator: { name: 'Whistle', version: 'warren-plugin' },
          browser: { name: 'Whistle', version: 'warren-plugin' },
          pages: [],
          entries: sessions.map(harEntry),
          comment: '',
        },
      };
    }
    const formBody = new URLSearchParams();
    formBody.set('exportFileType', fileType);
    formBody.set('sessions', JSON.stringify(sessions, null, 2));
    formBody.set('exportFilename', filename || '');
    body = formBody.toString();
    contentType = 'application/x-www-form-urlencoded';
    suffix = fileType === 'har' ? 'har' : fileType === 'Fiddler' || fileType === 'saz' ? 'saz' : 'txt';
  } else {
    fail('BAD_REQUEST', `未知 export type: ${type}`);
  }
  let response;
  if (pathname) {
    response = await fetch(`http://127.0.0.1:${instance.port}${pathname}`, {
      method: pathname === '/cgi-bin/values/export' ? 'GET' : 'POST',
      headers: { 'content-type': contentType },
      body: pathname === '/cgi-bin/values/export' ? undefined : body,
      signal: AbortSignal.timeout(COMPOSE_TIMEOUT_MS),
    });
  } else {
    response = new Response(body, { status: 200 });
  }
  if (!response.ok) fail('WHISTLE_EXPORT_FAILED', `导出 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    fail('WHISTLE_EXPORT_EMPTY', `导出 ${type} 返回 0 字节；没有可导出的 session 或 Whistle 拒绝生成`);
  }
  const requestedFile = filename || `${instance.storage}-${type}-${Date.now()}.${suffix}`;
  const file = path.join(directory, path.extname(requestedFile) ? requestedFile : `${requestedFile}.${suffix}`);
  writeFileSync(file, bytes);
  return {
    storage: instance.storage,
    type,
    file,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

/** 规则文本 → 模板。用户场景就是「线上地址 + 本地端口」。 */
function ruleLine(hostPattern, targetPort) {
  return `${hostPattern} 127.0.0.1:${targetPort}`;
}

async function upsertRule(port, name, rules) {
  const result = await postForm(port, '/cgi-bin/rules/project', { name, rules, groupName: '' });
  if (result.ec !== 0) fail('WHISTLE_RULE_WRITE_FAILED', `写规则失败: ${JSON.stringify(result)}`);
}

// ── 实例视图 ─────────────────────────────────────────────────────────

/** 环境绑的就是「proxy 指向这个实例端口」，所以绑定关系不用另存一份状态。 */
function envBoundTo(environments, port) {
  return environments.find((env) => typeof env.proxy === 'string' && loopbackPortOf(env.proxy) === port);
}

function loopbackPortOf(proxy) {
  try {
    const url = new URL(proxy);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return undefined;
    return Number(url.port) || undefined;
  } catch {
    return undefined;
  }
}

async function describe(instance, environments, rulesView, status, settings) {
  const bound = envBoundTo(environments, instance.port);
  const pid = status && status.storage === instance.storage ? await instancePid(instance, settings) : null;
  const occupiedByOther = Boolean(status) && status.storage !== instance.storage;
  return {
    storage: instance.storage,
    port: instance.port,
    // 自动化必须能从同一份 live 实例清单定位 Whistle pid；不能再依赖
    // 全局 ~/.whistle_client.pid（多实例时它通常指向 8899/另一个实例）。
    pid,
    hostPattern: instance.hostPattern ?? '',
    targetPort: instance.targetPort ?? null,
    createdAt: instance.createdAt,
    // 端口有响应但 storage 对不上，说明跑的是别人的实例：alive 不能算 true
    alive: Boolean(status) && !occupiedByOther,
    version: status && !occupiedByOther ? status.version : null,
    portOccupant: status ? status.storage : null,
    allowMultipleChoice: Boolean(rulesView?.allowMultipleChoice),
    selected: Array.isArray(rulesView?.selected) ? rulesView.selected : [],
    rules: Array.isArray(rulesView?.rules) ? rulesView.rules : [],
    url: `http://127.0.0.1:${instance.port}`,
    environmentId: bound ? bound.id : null,
    environmentName: bound ? bound.name : null,
    environmentProxy: bound ? (bound.proxy ?? null) : null,
  };
}

/**
 * 从 Warren 自己的 starting 注册表读实例 pid。
 *
 * `statusOf()` 仍是存活的唯一判据；这里只补 pid 元数据给需要直接调用
 * whistle live API 的自动化。注册表缺失/冲突时返回 null，不把它当成存活依据。
 */
async function instancePid(instance, settings) {
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

/**
 * 同一端口被登记多次时只留一条：优先「端口上跑的就是它」，否则留最新登记的那条。
 * 其余进 `stale`（只报告，不自动删记录——删记录会丢 hostPattern/targetPort 线索）。
 *
 * 导出给单测：真实场景（审计 thr_xt933f3iiz「同端口新旧两个实例记录」）不好复现，
 * 但判定规则必须能被断言。
 */
export function splitDuplicatePorts(instances, statuses) {
  const byPort = new Map();
  for (const instance of instances) {
    const group = byPort.get(instance.port) ?? [];
    group.push(instance);
    byPort.set(instance.port, group);
  }
  const live = [];
  const stale = [];
  for (const [port, group] of byPort) {
    if (group.length === 1) {
      live.push(group[0]);
      continue;
    }
    const status = statuses.get(port);
    const occupant = status ? group.find((item) => item.storage === status.storage) : null;
    const newest = [...group].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    const chosen = occupant ?? newest;
    live.push(chosen);
    for (const item of group) {
      if (item.storage === chosen.storage) continue;
      stale.push({
        storage: item.storage,
        port,
        reason: 'duplicate-port',
        liveStorage: chosen.storage,
        createdAt: item.createdAt ?? null,
      });
    }
  }
  const order = new Map(instances.map((item, index) => [item.storage, index]));
  live.sort((a, b) => (order.get(a.storage) ?? 0) - (order.get(b.storage) ?? 0));
  return { live, stale };
}

async function listInstances(host) {
  const environments = await host.environment.list();
  const settings = await host.settings.get();
  const instances = await readInstances(host);
  const statuses = new Map();
  await Promise.all(
    [...new Set(instances.map((instance) => instance.port))].map(async (port) => {
      statuses.set(port, await statusOf(port));
    }),
  );
  const { live, stale } = splitDuplicatePorts(instances, statuses);
  const views = await Promise.all(
    live.map(async (instance) => {
      if (!statuses.get(instance.port)) return { rules: [], allowMultipleChoice: false, selected: [] };
      try {
        return await readRulesView(instance.port);
      } catch {
        return { rules: [], allowMultipleChoice: false, selected: [] };
      }
    }),
  );
  return {
    instances: await Promise.all(
      live.map((instance, index) =>
        describe(instance, environments, views[index], statuses.get(instance.port), settings),
      ),
    ),
    stale,
    environments: environments.map((env) => ({
      id: env.id,
      name: env.name,
      status: env.status,
      proxy: env.proxy ?? null,
    })),
    w2: await resolveW2(host)
      .then((command) => command.display)
      .catch((error) => `(未找到) ${error.message}`),
  };
}

// ── 动作 ─────────────────────────────────────────────────────────────

async function forkInstance(host, input) {
  const requested = String((input && input.storage) || '').trim();
  const storage = requested || `dev-${Date.now().toString(36)}`;
  if (!STORAGE_RE.test(storage)) {
    fail('BAD_REQUEST', 'storage 只能用小写字母、数字和短横线，且以字母或数字开头');
  }
  const instances = await readInstances(host);
  if (instances.some((item) => item.storage === storage)) {
    fail('WHISTLE_STORAGE_EXISTS', `已经登记过叫 ${storage} 的实例；换个名字或先把它删掉`);
  }

  const settings = await host.settings.get();
  const base = Number(settings.portBase) > 0 ? Number(settings.portBase) : DEFAULT_PORT_BASE;
  const wanted = Number(input && input.port);
  let port = wanted > 0 ? wanted : await pickPort(base);
  if (wanted > 0) {
    if (await statusOf(port)) fail('WHISTLE_PORT_BUSY', `端口 ${port} 上已经有一个 whistle 实例了`);
  } else {
    /*
     * `canBind` 会放过「别人占着、但绑在另一个地址族」的端口（实测 8900 被 IPv6 侧占着，
     * 127.0.0.1 还能 bind 成功），所以选完端口还要再用状态探一次，撞了就顺延。
     */
    for (let attempt = 0; attempt < 5 && (await statusOf(port)); attempt += 1) port = await pickPort(port + 1);
    if (await statusOf(port)) fail('WHISTLE_NO_FREE_PORT', `从 ${base} 往后选的 5 个端口上都已经有 whistle 实例`);
  }
  const registered = instances.find((item) => item.port === port);
  if (registered) {
    fail(
      'WHISTLE_PORT_REGISTERED',
      `端口 ${port} 已经登记给实例 ${registered.storage}；用 start 把它按原端口拉起来，或换端口/先 remove。`,
    );
  }
  if (await statusOf(port)) fail('WHISTLE_PORT_BUSY', `端口 ${port} 上已经有一个 whistle 实例了`);

  const pre = await preflight(host);
  const env = await whistleEnv(host);
  const started = await runW2(pre.w2, ['start', '-S', storage, '-p', String(port)], env);
  const status = await waitForStatus(port, storage);
  if (!status) {
    fail(
      'WHISTLE_START_FAILED',
      `w2 start 之后 ${port} 上没有响应这个 storage 的实例。输出：${started.output || '(空)'}`,
    );
  }
  await enableHttpsCapture(port);
  await enableMultipleChoice(port);

  const hostPattern = String((input && input.hostPattern) || '').trim();
  const targetPort = Number(input && input.targetPort);
  if (hostPattern && targetPort > 0) {
    await upsertRule(port, RULE_NAME, ruleLine(hostPattern, targetPort));
    // 新实例的默认规则也要选中；开启多选后不能依赖「后写自动顶掉前一个」
    const selected = await postForm(port, '/cgi-bin/rules/project', { name: RULE_NAME, enable: '1' });
    if (selected.ec !== 0) fail('WHISTLE_RULE_ENABLE_FAILED', `新实例默认规则启用失败：${JSON.stringify(selected)}`);
    const activated = await readRule(port, RULE_NAME);
    if (!activated?.selected) fail('WHISTLE_RULE_ENABLE_UNCONFIRMED', '新实例默认规则回读 selected 仍不是 true');
  }

  const instance = {
    storage,
    port,
    hostPattern,
    targetPort: targetPort > 0 ? targetPort : null,
    createdAt: new Date().toISOString(),
  };
  await writeInstances(host, [...instances, instance]);
  await host.log.info(`实例 ${storage} 起在 ${port}（HTTPS 解密、多选规则已打开）`);
  return {
    ...(await listInstances(host)),
    created: { storage, port, allowMultipleChoice: true },
    ...(pre.warnings.length ? { warnings: pre.warnings } : {}),
  };
}

/**
 * 把 `list` 里 `alive:false` 的已登记实例按原端口原 storage 拉起来。
 *
 * `open` 只开 Web UI（页面来自实例自己），实例没跑时它只会显示打不开的页面；
 * 「重启已登记实例」是独立动作，不能混在 open 里（审计 thr_xt933f3iiz：open 被当成启动）。
 */
async function startInstance(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const current = await statusOf(instance.port);
  if (current && current.storage === instance.storage) {
    return {
      ...(await listInstances(host)),
      started: { storage: instance.storage, port: instance.port, alreadyRunning: true },
    };
  }
  if (current) {
    fail(
      'WHISTLE_PORT_BUSY',
      `端口 ${instance.port} 上跑的是实例 ${current.storage}，不是 ${instance.storage}；先 stop 对方或改登记端口。`,
    );
  }
  const pre = await preflight(host);
  const env = await whistleEnv(host);
  const started = await runW2(pre.w2, ['start', '-S', instance.storage, '-p', String(instance.port)], env);
  const status = await waitForStatus(instance.port, instance.storage);
  if (!status) {
    fail(
      'WHISTLE_START_FAILED',
      `w2 start 之后 ${instance.port} 上没有响应 ${instance.storage} 的实例。输出：${started.output || '(空)'}`,
    );
  }
  await enableHttpsCapture(instance.port);
  await enableMultipleChoice(instance.port);
  await host.log.info(`实例 ${instance.storage} 已在原端口 ${instance.port} 重新拉起`);
  return {
    ...(await listInstances(host)),
    started: {
      storage: instance.storage,
      port: instance.port,
      alreadyRunning: false,
      version: status.version ?? null,
    },
    ...(pre.warnings.length ? { warnings: pre.warnings } : {}),
  };
}

async function stopInstance(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) {
    return { ...(await listInstances(host)), note: '这个实例本来就没在跑' };
  }
  const w2 = await resolveW2(host);
  const stopped = await runW2(w2, ['stop', '-S', instance.storage], await whistleEnv(host), 10000);
  if (!(await waitUntilGone(instance.port))) {
    fail(
      'WHISTLE_STOP_FAILED',
      `w2 stop 之后 ${instance.port} 还在响应。这个实例可能不是这个 w2 起的（换过 WHISTLE_PATH？）。输出：${
        stopped.output || '(空)'
      }`,
    );
  }
  await host.log.info(`实例 ${instance.storage} 已停`);
  return listInstances(host);
}

async function removeInstance(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (await statusOf(instance.port)) await stopInstance(host, input);
  const instances = await readInstances(host);
  await writeInstances(
    host,
    instances.filter((item) => item.storage !== instance.storage),
  );
  // 只从登记表里摘掉：whistle 的规则文件还在磁盘上（想真删就自己去 WHISTLE_PATH 里删）
  return listInstances(host);
}

async function setRule(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  await enableMultipleChoice(instance.port);
  const rules = String((input && input.rules) || '');
  const name = String((input && input.name) || RULE_NAME);
  const expectedHash = typeof (input && input.expectedHash) === 'string' ? input.expectedHash : undefined;
  const previous = await readRule(instance.port, name);
  if (expectedHash && sha256(normalizeText(previous?.data ?? '')) !== expectedHash) {
    fail('RULE_STALE', `规则 ${name} 已经变了，请重新读取后再保存`);
  }
  const validation = validateRulesText(rules);
  if (!validation.ok && !(input && input.allowErrors === true)) {
    fail('RULE_INVALID', validation.errors.map((item) => item.message).join('; '));
  }
  await upsertRule(instance.port, name, rules);
  const written = await readRule(instance.port, name);
  const expected = sha256(normalizeText(rules));
  if (!written || sha256(normalizeText(written.data)) !== expected) {
    if (previous) await upsertRule(instance.port, name, previous.data);
    fail('RULE_WRITE_MISMATCH', `写入 ${name} 后读回的内容与目标不一致，已回滚`);
  }
  /*
   * `rules/project` 只保证正文写进去，不保证这一组被选中；Whistle 真正的生效条件是
   * `selected=true`。不补这一步会静默失败：保存成功、回读正文正确，但请求仍按真实网络走。
   */
  if (!written.selected) {
    const enabled = await postForm(instance.port, '/cgi-bin/rules/project', { name, enable: '1' });
    if (enabled.ec !== 0) {
      if (previous) await upsertRule(instance.port, name, previous.data);
      fail('RULE_ENABLE_FAILED', `规则 ${name} 写入后启用失败：${JSON.stringify(enabled)}`);
    }
  }
  const activated = await readRule(instance.port, name);
  if (!activated || sha256(normalizeText(activated.data)) !== expected || !activated.selected) {
    if (previous) await upsertRule(instance.port, name, previous.data);
    fail('RULE_ENABLE_UNCONFIRMED', `规则 ${name} 启用后回读失败（selected=${Boolean(activated?.selected)}）`);
  }
  // 规则的事实来源是 whistle 自己（`rules/list`），插件不另存一份
  return {
    ...(await readRulesView(instance.port)),
    verified: true,
    storage: instance.storage,
    port: instance.port,
    hash: expected,
    selected: true,
    warnings: validation.warnings,
  };
}

async function toggleRule(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const name = String((input && input.name) || RULE_NAME);
  const enabled = Boolean(input && input.enabled);
  if (enabled) await enableMultipleChoice(instance.port);
  const before = await readRule(instance.port, name);
  if (!before) fail('RULE_NOT_FOUND', `没有规则组 ${name}`);
  if (enabled) {
    // project + enable=1 只选择，不改正文。裸 select 会把 data 写成空串（实测）。
    const result = await postForm(instance.port, '/cgi-bin/rules/project', { name, enable: '1' });
    if (result.ec !== 0) fail('WHISTLE_RULE_TOGGLE_FAILED', `启用 ${name} 失败：${JSON.stringify(result)}`);
  } else {
    // unselect 必须同时带当前正文，否则同样会清空（实测）。
    const result = await postForm(instance.port, '/cgi-bin/rules/unselect', { name, value: before.data });
    if (result.ec !== 0) fail('WHISTLE_RULE_TOGGLE_FAILED', `停用 ${name} 失败：${JSON.stringify(result)}`);
  }
  const after = await readRule(instance.port, name);
  if (!after) {
    await upsertRule(instance.port, name, before.data);
    fail('RULE_TOGGLE_MISMATCH', `切换 ${name} 后规则消失，已恢复`);
  }
  const expectedHash = sha256(normalizeText(before.data));
  if (sha256(normalizeText(after.data)) !== expectedHash) {
    await upsertRule(instance.port, name, before.data);
    fail('RULE_TOGGLE_WIPED', `切换 ${name} 后规则正文变化，已恢复`);
  }
  if (Boolean(after.selected) !== enabled) {
    fail('RULE_TOGGLE_UNCONFIRMED', `切换 ${name} 后 selected=${after.selected}，期望 ${enabled}`);
  }
  return {
    ...(await readRulesView(instance.port)),
    verified: true,
    storage: instance.storage,
    port: instance.port,
    hash: expectedHash,
  };
}

async function removeRule(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  await postForm(instance.port, '/cgi-bin/rules/remove', { name: String((input && input.name) || RULE_NAME) });
  return { ...(await readRulesView(instance.port)), storage: instance.storage, port: instance.port };
}

// ── 预设与 profile ─────────────────────────────────────────────────────────

async function ensurePresetSchema(host) {
  await host.storage.sql.migrate([
    `CREATE TABLE IF NOT EXISTS whistle_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,
      current_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whistle_preset_revisions (
      preset_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (preset_id, revision)
    );
    CREATE TABLE IF NOT EXISTS whistle_profiles (
      instance_storage TEXT PRIMARY KEY,
      preset_id TEXT,
      revision INTEGER,
      variables_json TEXT NOT NULL DEFAULT '{}',
      layers_json TEXT NOT NULL DEFAULT '{}',
      override_rules TEXT NOT NULL DEFAULT '',
      applied_hash TEXT,
      applied_rules TEXT,
      applied_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whistle_profile_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_storage TEXT NOT NULL,
      event TEXT NOT NULL,
      preset_id TEXT,
      revision INTEGER,
      hash TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );`,
  ]);
}

async function listPresets(host) {
  return host.storage.sql.query(
    'SELECT id, name, category, description, builtin, current_revision AS revision, updated_at AS updatedAt FROM whistle_presets ORDER BY category, name',
  );
}

async function getPreset(host, input) {
  const id = String((input && input.id) || (input && input.presetId) || '').trim();
  if (!id) fail('BAD_REQUEST', 'presetGet 需要 id');
  const requested = Number(input && input.revision);
  const rows =
    Number.isInteger(requested) && requested > 0
      ? await host.storage.sql.query(
          'SELECT preset_id AS id, revision, definition_json AS definitionJson, definition_hash AS hash, created_at AS createdAt FROM whistle_preset_revisions WHERE preset_id = ? AND revision = ?',
          [id, requested],
        )
      : await host.storage.sql.query(
          'SELECT r.preset_id AS id, r.revision, r.definition_json AS definitionJson, r.definition_hash AS hash, r.created_at AS createdAt FROM whistle_preset_revisions r JOIN whistle_presets p ON p.id = r.preset_id AND p.current_revision = r.revision WHERE r.preset_id = ?',
          [id],
        );
  const row = rows[0];
  if (!row) fail('PRESET_NOT_FOUND', `没有预设 ${id}${Number.isInteger(requested) ? ` revision ${requested}` : ''}`);
  return { ...row, definition: JSON.parse(String(row.definitionJson)) };
}

/**
 * `local-static-only` 层是 opt-in：只在调用方显式给 `staticOnly` 时加进预设。
 * 默认关闭，避免改变已有预设的行为（计划 §4 风险表）。
 */
function withStaticOnly(definition, input) {
  const options = input && input.staticOnly;
  if (!options || typeof options !== 'object') return definition;
  return appendStaticOnlyLayer(definition, options);
}

async function presetDefinitions(host, input, presetIds) {
  if (!presetIds) return [withStaticOnly((await getPreset(host, input)).definition, input)];
  return Promise.all(
    presetIds.map(async (id) => withStaticOnly((await getPreset(host, { ...input, id })).definition, input)),
  );
}

async function previewPreset(host, input) {
  const layers = resolveScenarioLayers(input);
  const presetIds = resolvePresetIds(input);
  const preset = presetIds ? null : await getPreset(host, input);
  const definitions = await presetDefinitions(host, input, presetIds);
  const resolvedVariables = resolvePresetVariables(definitions, {
    ...input,
    ...(await presetLocalUrl(host, input)),
  });
  if (presetIds) {
    const merged = mergePresets(definitions, { id: input.id, name: input.name });
    const composed = composePreset(merged, {
      variables: resolvedVariables,
      layers,
      conflictPolicy: resolveConflictPolicy(input),
    });
    return { presetIds, mergedId: merged.id, scenario: input?.scenario, ...composed };
  }
  const composed = composePreset(definitions[0], {
    variables: resolvedVariables,
    layers,
    conflictPolicy: resolveConflictPolicy(input),
  });
  return { presetId: preset.id, revision: preset.revision, scenario: input?.scenario, ...composed };
}

function resolvePresetIds(input) {
  if (Array.isArray(input && input.presetIds)) return input.presetIds;
  if (input && input.scenario && Array.isArray(SCENARIOS[input.scenario]?.presetIds)) {
    return scenarioPresetIds(input.scenario);
  }
  return null;
}

async function presetLocalUrl(host, input) {
  const explicit = typeof input?.localUrl === 'string' ? input.localUrl.trim() : '';
  if (explicit) return { localUrl: explicit };
  if (!input?.storage) return {};
  try {
    const instance = await requireInstance(host, input.storage);
    const environments = await host.environment.list();
    const bound = envBoundTo(environments, instance.port);
    const url = bound?.currentUrl || '';
    return url ? { localUrl: url } : {};
  } catch {
    return {};
  }
}

function resolveScenarioLayers(input) {
  const scenario = input && typeof input.scenario === 'string' ? input.scenario : '';
  if (!scenario) return (input && input.layers) || {};
  if (!SCENARIOS[scenario]) fail('BAD_REQUEST', `未知场景 ${scenario}`);
  return { ...scenarioLayers(scenario), ...(input && input.layers) };
}

function resolveConflictPolicy(input) {
  return input && (input.scenario || Array.isArray(input.presetIds)) ? 'prefer-later' : undefined;
}

function assertPresetWarnings(composed, input) {
  if (composed.errors.length) fail('PRESET_INVALID', composed.errors.map((item) => item.message).join('; '));
  if (composed.warnings.length && !(input && input.allowWarnings === true)) {
    fail('PRESET_WARNINGS', composed.warnings.map((item) => item.message).join('; '));
  }
}

async function applyPreset(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  await enableMultipleChoice(instance.port);
  const presetIds = resolvePresetIds(input);
  const definitions = await presetDefinitions(host, input, presetIds);
  const preset = presetIds
    ? {
        id: String((input && input.id) || presetIds.join('+')),
        revision: Number((input && input.revision) || 1),
        definition: mergePresets(definitions, { id: input.id, name: input.name }),
      }
    : {
        id: input?.id,
        revision: Number(input?.revision || 1),
        definition: definitions[0],
      };
  const resolvedVariables = resolvePresetVariables(definitions, {
    ...input,
    ...(await presetLocalUrl(host, input)),
  });
  const composed = composePreset(preset.definition, {
    variables: resolvedVariables,
    layers: resolveScenarioLayers(input),
    conflictPolicy: resolveConflictPolicy(input),
  });
  assertPresetWarnings(composed, input);
  const expectedHash = typeof (input && input.expectedHash) === 'string' ? input.expectedHash : composed.hash;
  if (expectedHash !== composed.hash) {
    fail('PRESET_STALE_PREVIEW', `预览已过期：期望 ${expectedHash.slice(0, 12)}，当前 ${composed.hash.slice(0, 12)}`);
  }
  const name = String((input && input.name) || RULE_NAME);
  const previous = await readRule(instance.port, name);
  const previousData = normalizeText(previous?.data ?? '');
  const previousSelected = Boolean(previous?.selected);
  const startedAt = new Date().toISOString();
  await host.storage.sql.run(
    'INSERT INTO whistle_profile_history (instance_storage, event, preset_id, revision, hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      instance.storage,
      'apply.start',
      preset.id,
      preset.revision,
      composed.hash,
      JSON.stringify({ previousHash: sha256(previousData), previousSelected }),
      startedAt,
    ],
  );
  try {
    await upsertRule(instance.port, name, composed.rules);
    let written = await readRule(instance.port, name);
    if (!written || sha256(normalizeText(written.data)) !== composed.hash) {
      throw Object.assign(new Error('写入后读回的规则 hash 不一致'), { code: 'PRESET_WRITE_MISMATCH' });
    }
    if (!written.selected) {
      const enabled = await postForm(instance.port, '/cgi-bin/rules/project', { name, enable: '1' });
      if (enabled.ec !== 0) {
        throw Object.assign(new Error(`规则写入但启用失败：${JSON.stringify(enabled)}`), {
          code: 'PRESET_ENABLE_FAILED',
        });
      }
      written = await readRule(instance.port, name);
    }
    if (!written || sha256(normalizeText(written.data)) !== composed.hash || !written.selected) {
      throw Object.assign(new Error('启用后复核失败'), { code: 'PRESET_VERIFY_FAILED' });
    }
    const now = new Date().toISOString();
    await host.storage.sql.run(
      `INSERT INTO whistle_profiles (instance_storage, preset_id, revision, variables_json, layers_json, override_rules, applied_hash, applied_rules, applied_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)
       ON CONFLICT(instance_storage) DO UPDATE SET preset_id = excluded.preset_id, revision = excluded.revision,
         variables_json = excluded.variables_json, layers_json = excluded.layers_json,
         applied_hash = excluded.applied_hash, applied_rules = excluded.applied_rules,
         applied_at = excluded.applied_at, updated_at = excluded.updated_at`,
      [
        instance.storage,
        preset.id,
        preset.revision,
        JSON.stringify(resolvedVariables),
        JSON.stringify(resolveScenarioLayers(input)),
        composed.hash,
        composed.rules,
        now,
        now,
      ],
    );
    await host.storage.sql.run(
      'INSERT INTO whistle_profile_history (instance_storage, event, preset_id, revision, hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [instance.storage, 'apply.ok', preset.id, preset.revision, composed.hash, '{}', now],
    );
    return {
      storage: instance.storage,
      presetId: preset.id,
      revision: preset.revision,
      scenario: input?.scenario,
      hash: composed.hash,
      selected: true,
      lineCount: composed.lineCount,
      warnings: composed.warnings,
      rules: await readRules(instance.port),
    };
  } catch (error) {
    let rollbackError;
    try {
      await upsertRule(instance.port, name, previousData);
      if (previousSelected) await postForm(instance.port, '/cgi-bin/rules/project', { name, enable: '1' });
      const restored = await readRule(instance.port, name);
      const restoredOk = Boolean(restored) && sha256(normalizeText(restored.data)) === sha256(previousData);
      await host.storage.sql.run(
        'INSERT INTO whistle_profile_history (instance_storage, event, preset_id, revision, hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          instance.storage,
          'apply.rollback',
          preset.id,
          preset.revision,
          composed.hash,
          JSON.stringify({ error: error.message, restored: restoredOk }),
          new Date().toISOString(),
        ],
      );
      if (!restoredOk) rollbackError = '旧规则恢复后复核失败';
    } catch (cause) {
      rollbackError = cause.message;
    }
    fail(
      'PRESET_ROLLBACK_FAILED',
      `${error.message}；${rollbackError ? `恢复失败：${rollbackError}` : '已恢复旧规则'}`,
    );
  }
}

async function getProfile(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const rows = await host.storage.sql.query(
    'SELECT instance_storage AS storage, preset_id AS presetId, revision, variables_json AS variablesJson, layers_json AS layersJson, override_rules AS overrideRules, applied_hash AS appliedHash, applied_at AS appliedAt, updated_at AS updatedAt FROM whistle_profiles WHERE instance_storage = ?',
    [instance.storage],
  );
  if (!rows.length) return { storage: instance.storage, profile: null };
  const row = rows[0];
  return {
    storage: instance.storage,
    profile: {
      ...row,
      variables: JSON.parse(String(row.variablesJson || '{}')),
      layers: JSON.parse(String(row.layersJson || '{}')),
    },
  };
}

async function clearProfile(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  await host.storage.sql.run('DELETE FROM whistle_profiles WHERE instance_storage = ?', [instance.storage]);
  return { storage: instance.storage, cleared: true };
}

async function savePreset(host, input) {
  const definition = input && input.definition;
  const validation = validatePreset(definition);
  if (!validation.ok) fail('PRESET_INVALID', validation.errors.map((item) => item.message).join('; '));
  const existing = await host.storage.sql.query('SELECT current_revision FROM whistle_presets WHERE id = ?', [
    definition.id,
  ]);
  const revision = existing.length ? Number(existing[0].current_revision) + 1 : 1;
  const now = new Date().toISOString();
  const normalized = JSON.stringify(definition);
  if (existing.length) {
    await host.storage.sql.run(
      'UPDATE whistle_presets SET name = ?, category = ?, description = ?, current_revision = ?, updated_at = ? WHERE id = ?',
      [definition.name, definition.category ?? '', definition.description ?? '', revision, now, definition.id],
    );
  } else {
    await host.storage.sql.run(
      'INSERT INTO whistle_presets (id, name, category, description, builtin, current_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      [definition.id, definition.name, definition.category ?? '', definition.description ?? '', revision, now, now],
    );
  }
  await host.storage.sql.run(
    'INSERT INTO whistle_preset_revisions (preset_id, revision, definition_json, definition_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    [definition.id, revision, normalized, sha256(normalized), now],
  );
  return { presetId: definition.id, revision, hash: sha256(normalized) };
}

async function deletePreset(host, input) {
  const id = String((input && input.id) || '').trim();
  if (!id) fail('BAD_REQUEST', 'presetDelete 需要 id');
  const rows = await host.storage.sql.query('SELECT id FROM whistle_presets WHERE id = ?', [id]);
  if (!rows.length) fail('PRESET_NOT_FOUND', `没有预设 ${id}`);
  await host.storage.sql.run('DELETE FROM whistle_preset_revisions WHERE preset_id = ?', [id]);
  await host.storage.sql.run('DELETE FROM whistle_presets WHERE id = ?', [id]);
  return { presetId: id, deleted: true };
}

async function importPreset(_host, input) {
  const text = String((input && input.text) || '');
  if (!text.trim() && !(input && input.storage && input.name)) fail('BAD_REQUEST', 'presetImport 需要 text');
  let importedText = text;
  if (input && input.storage && input.name && !text.trim()) {
    const instance = await requireInstance(_host, input.storage);
    const current = await readRule(instance.port, String(input.name));
    if (!current) fail('RULE_NOT_FOUND', `没有规则组 ${input.name}`);
    importedText = current.data;
  }
  return importRulesText(importedText, {
    id: input && input.id,
    name: (input && input.title) || (input && input.name),
    category: input && input.category,
    description: input && input.description,
  });
}

async function exportPreset(host, input) {
  const preset = await getPreset(host, input);
  return { presetId: preset.id, revision: preset.revision, hash: preset.hash, definition: preset.definition };
}

async function ruleValidate(_host, input) {
  return validateRulesText(String((input && input.rules) || ''));
}

async function ruleDiff(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const name = String((input && input.name) || RULE_NAME);
  const current = await readRule(instance.port, name);
  return diffRules(current?.data ?? '', String((input && input.rules) || ''));
}

async function bindEnvironment(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const environmentId = String((input && input.environmentId) || '').trim();
  if (!environmentId) fail('BAD_REQUEST', 'bind 需要 environmentId');
  const environment = await host.environment.get(environmentId);
  if (!environment) fail('ENV_NOT_FOUND', `没有环境 ${environmentId}`);
  if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑，先把它起起来`);
  await enableMultipleChoice(instance.port);

  const response = await call(instance.port, '/cgi-bin/rootca?type=pem');
  const pem = await response.text();
  if (!pem.includes('BEGIN CERTIFICATE')) {
    fail('WHISTLE_ROOTCA_FAILED', `取不到 ${instance.storage} 的根证书`);
  }
  /*
   * CA 落在**环境自己的目录**里：它属于这个环境（环境删了就跟着没），
   * 也让「这个环境信谁」在磁盘上看得见。主进程只认这个路径，不需要知道 whistle。
   */
  const caPath = path.join(environment.storagePath, 'trusted-ca.pem');
  writeFileSync(caPath, pem);

  const proxy = `http://127.0.0.1:${instance.port}`;
  await host.environment.update({ id: environmentId, proxy, trustedCa: caPath });

  // proxy 只在 start() 时生效，所以「绑上就生效」必须重启
  const wasRunning = environment.status === 'running';
  if (wasRunning) {
    await host.environment.stop(environmentId);
    await host.environment.start(environmentId);
  }
  await host.log.info(`${environmentId} 已绑定到实例 ${instance.storage}（${proxy}）${wasRunning ? '，已重启' : ''}`);
  return {
    environmentId,
    proxy,
    trustedCa: caPath,
    restarted: wasRunning,
    // 证书失败会被网络服务按域名缓存；tab 上的验签兜底会绕过它，但也把限制说清楚
    ...(wasRunning
      ? {
          note: '若该域名此前已报过证书错，Chromium 会缓存失败结果；新标签会走验签兜底，若旧标签仍失败请重开该标签。',
        }
      : {}),
    ...(await listInstances(host)),
  };
}

async function unbindEnvironment(host, input) {
  const environmentId = String((input && input.environmentId) || '').trim();
  if (!environmentId) fail('BAD_REQUEST', 'unbind 需要 environmentId');
  const environment = await host.environment.get(environmentId);
  if (!environment) fail('ENV_NOT_FOUND', `没有环境 ${environmentId}`);
  await host.environment.update({ id: environmentId, proxy: null, trustedCa: null });
  const wasRunning = environment.status === 'running';
  if (wasRunning) {
    await host.environment.stop(environmentId);
    await host.environment.start(environmentId);
  }
  await host.log.info(`${environmentId} 已解绑代理`);
  return { environmentId, restarted: wasRunning, ...(await listInstances(host)) };
}

/**
 * 在**这个环境自己的标签里**打开 whistle 的 Web UI。
 *
 * 以前是 spawn `open` 甩给系统浏览器 —— 那样人看到的抓包和我们环境里的页面是两回事，
 * 而且还得自己配代理。开成环境标签之后，它和页面在同一个 session 里，随环境启停。
 * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §4。
 */
async function openBound(host, environmentId) {
  const id = String(environmentId || '').trim();
  if (!id) fail('BAD_REQUEST', 'open 需要 --env=<环境>');
  const environment = await host.environment.get(id);
  if (!environment) fail('ENV_NOT_FOUND', `没有环境 ${id}`);
  const port = loopbackPortOf(environment.proxy);
  if (!port) fail('WHISTLE_NOT_BOUND', `环境 ${id} 没有绑定代理实例（先绑一个，或用面板里的「绑定」）`);
  const url = `http://127.0.0.1:${port}`;
  const tab = await host.browser.openTab(url);
  // 只回 JSON 干净的字段：TabListItem 有可选字段（favicon / error），undefined 过不了 toJson
  return { url, tabId: String(tab.id), title: String(tab.title ?? '') };
}

export default {
  async activate(ctx) {
    await ensurePresetSchema(ctx.host);
    const instances = await readInstances(ctx.host);
    for (const instance of instances) {
      if (!(await statusOf(instance.port))) continue;
      try {
        await enableMultipleChoice(instance.port);
      } catch (error) {
        await ctx.host.log.warn(
          `实例 ${instance.storage} 打开多选规则失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await ctx.host.log.info(`whistle 插件已就绪，登记了 ${instances.length} 个实例`);
  },

  // ── 命令（agent 走 `warren plugin run com.warren.whistle <cmd>`）──
  async list(ctx) {
    return listInstances(ctx.host);
  },
  async fork(ctx) {
    return forkInstance(ctx.host, ctx.input);
  },
  async start(ctx) {
    return startInstance(ctx.host, ctx.input);
  },
  async stop(ctx) {
    return stopInstance(ctx.host, ctx.input);
  },
  async remove(ctx) {
    return removeInstance(ctx.host, ctx.input);
  },
  async bind(ctx) {
    return bindEnvironment(ctx.host, { ...ctx.input, environmentId: ctx.environmentId });
  },
  async unbind(ctx) {
    return unbindEnvironment(ctx.host, { environmentId: ctx.environmentId, ...ctx.input });
  },
  async open(ctx) {
    return openBound(ctx.host, ctx.environmentId);
  },
  // 规则组的命令入口：以前只在 rpc 白名单里，agent 只能 `warren call plugin.rpc`
  // 绕一层，`--help` 也看不到（计划 WP6 第 6 条）。
  async rules(ctx) {
    return rulesView(ctx.host, ctx.input);
  },
  async ruleSet(ctx) {
    return setRule(ctx.host, ctx.input);
  },
  async ruleToggle(ctx) {
    return toggleRule(ctx.host, ctx.input);
  },
  async ruleRemove(ctx) {
    return removeRule(ctx.host, ctx.input);
  },
  async presetList(ctx) {
    return { presets: await listPresets(ctx.host), scenarios: Object.values(SCENARIOS) };
  },
  async presetGet(ctx) {
    return getPreset(ctx.host, ctx.input);
  },
  async presetPreview(ctx) {
    return previewPreset(ctx.host, ctx.input);
  },
  async presetApply(ctx) {
    return applyPreset(ctx.host, ctx.input);
  },
  async presetSave(ctx) {
    return savePreset(ctx.host, ctx.input);
  },
  async presetDelete(ctx) {
    return deletePreset(ctx.host, ctx.input);
  },
  async presetImport(ctx) {
    return importPreset(ctx.host, ctx.input);
  },
  async presetExport(ctx) {
    return exportPreset(ctx.host, ctx.input);
  },
  async profileGet(ctx) {
    return getProfile(ctx.host, ctx.input);
  },
  async profileClear(ctx) {
    return clearProfile(ctx.host, ctx.input);
  },
  async ruleGet(ctx) {
    const instance = await requireInstance(ctx.host, ctx.input && ctx.input.storage);
    const name = String((ctx.input && ctx.input.name) || RULE_NAME);
    return { rule: await readRule(instance.port, name) };
  },
  async ruleValidate(ctx) {
    return ruleValidate(ctx.host, ctx.input);
  },
  async ruleDiff(ctx) {
    return ruleDiff(ctx.host, ctx.input);
  },
  async traffic(ctx) {
    return traffic(ctx.host, ctx.input);
  },
  async compose(ctx) {
    return compose(ctx.host, ctx.input);
  },
  async doctor(ctx) {
    return doctor(ctx.host, ctx.input);
  },
  async agent(ctx) {
    return agent(ctx.host, ctx.input);
  },
  async agentStatus(ctx) {
    return agentStatus(ctx.host, ctx.input);
  },
  async frames(ctx) {
    const instance = await requireInstance(ctx.host, ctx.input && ctx.input.storage);
    if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
    return {
      storage: instance.storage,
      port: instance.port,
      ...(await readFrames(instance.port, ctx.input)),
    };
  },
  async export(ctx) {
    return exportData(ctx.host, ctx.input);
  },

  // ── rpc（插件前端调） ────────────────────────────────────────────
  rpc: {
    async list(_input, ctx) {
      return listInstances(ctx.host);
    },
    async fork(input, ctx) {
      return forkInstance(ctx.host, input);
    },
    async stop(input, ctx) {
      return stopInstance(ctx.host, input);
    },
    async remove(input, ctx) {
      return removeInstance(ctx.host, input);
    },
    async start(input, ctx) {
      return startInstance(ctx.host, input);
    },
    async rules(input, ctx) {
      return rulesView(ctx.host, input);
    },
    async ruleSet(input, ctx) {
      return setRule(ctx.host, input);
    },
    async ruleToggle(input, ctx) {
      return toggleRule(ctx.host, input);
    },
    async ruleRemove(input, ctx) {
      return removeRule(ctx.host, input);
    },
    async presetList(_input, ctx) {
      return { presets: await listPresets(ctx.host) };
    },
    async presetGet(input, ctx) {
      return getPreset(ctx.host, input);
    },
    async presetPreview(input, ctx) {
      return previewPreset(ctx.host, input);
    },
    async presetApply(input, ctx) {
      return applyPreset(ctx.host, input);
    },
    async presetSave(input, ctx) {
      return savePreset(ctx.host, input);
    },
    async presetDelete(input, ctx) {
      return deletePreset(ctx.host, input);
    },
    async presetImport(input, ctx) {
      return importPreset(ctx.host, input);
    },
    async presetExport(input, ctx) {
      return exportPreset(ctx.host, input);
    },
    async profileGet(input, ctx) {
      return getProfile(ctx.host, input);
    },
    async profileClear(input, ctx) {
      return clearProfile(ctx.host, input);
    },
    async ruleGet(input, ctx) {
      const instance = await requireInstance(ctx.host, input && input.storage);
      const name = String((input && input.name) || RULE_NAME);
      return { rule: await readRule(instance.port, name) };
    },
    async ruleValidate(input, ctx) {
      return ruleValidate(ctx.host, input);
    },
    async ruleDiff(input, ctx) {
      return ruleDiff(ctx.host, input);
    },
    async traffic(input, ctx) {
      return traffic(ctx.host, input);
    },
    async compose(input, ctx) {
      return compose(ctx.host, input);
    },
    async doctor(input, ctx) {
      return doctor(ctx.host, input);
    },
    async agent(input, ctx) {
      return agent(ctx.host, input);
    },
    async agentStatus(input, ctx) {
      return agentStatus(ctx.host, input);
    },
    async frames(input, ctx) {
      const instance = await requireInstance(ctx.host, input && input.storage);
      if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
      return {
        storage: instance.storage,
        port: instance.port,
        ...(await readFrames(instance.port, input)),
      };
    },
    async export(input, ctx) {
      return exportData(ctx.host, input);
    },
    async bind(input, ctx) {
      return bindEnvironment(ctx.host, input);
    },
    async unbind(input, ctx) {
      return unbindEnvironment(ctx.host, input);
    },
    /** 面板上的「打开面板」：在该环境的标签里打开 whistle 的 Web UI。 */
    async open(input, ctx) {
      return openBound(ctx.host, input && input.environmentId);
    },
  },
};
