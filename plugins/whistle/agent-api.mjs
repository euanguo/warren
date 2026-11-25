/**
 * Whistle 2.10.7+ Local Agent API 的隔离适配层。
 *
 * 官方 api.js 通过 `w2 root bin/api` 定位当前安装的 Whistle。Whistle 的
 * client 发现逻辑读 `~/.whistle_client.pid`，而 Warren 同时托管多个 storage
 * 实例；所以每次调用都必须在独立的 HOME 下加载 API，不能使用全局 HOME。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cache = new Map();

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function normalizeVersion(version) {
  return String(version || '')
    .split('.')
    .map((item) => Number(item));
}

export function isAgentApiVersion(version) {
  const [major, minor, patch] = normalizeVersion(version);
  return major > 2 || (major === 2 && (minor > 10 || (minor === 10 && patch >= 7)));
}

function readInstancePid(instance) {
  const livePid = Number(instance.pid);
  const livePort = Number(instance.port);
  if (Number.isInteger(livePid) && livePid > 0 && livePort > 0) {
    return {
      pid: livePid,
      options: {
        port: livePort,
        specialAuth: String(instance.specialAuth || ''),
      },
    };
  }
  if (instance.pidFile) {
    try {
      const raw = readFileSync(instance.pidFile, 'utf8').trim();
      const [pid, _host, port, ...rest] = raw.split(',');
      if (Number(port) === Number(instance.port) && Number(pid) > 0) {
        return { pid: Number(pid), options: { port: Number(port), specialAuth: rest[0] || '' } };
      }
    } catch {}
  }
  const home = process.env.WARREN_HOME ? path.resolve(process.env.WARREN_HOME) : path.join(os.homedir(), '.warren');
  const roots = [
    path.join(home, 'whistle', '.startingAppData'),
    path.join(home, '.startingAppData'),
    path.join(os.homedir(), '.startingAppData'),
  ];
  if (instance.startingDataDir) roots.unshift(path.join(instance.startingDataDir, '.startingAppData'));
  for (const root of roots) {
    for (const name of [`#${instance.storage}#`, `%23${instance.storage}%23`]) {
      const file = path.join(root, name);
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (Number(data?.options?.port) === Number(instance.port) && Number.isInteger(data?.pid)) {
          return data;
        }
      } catch {}
    }
  }
  return null;
}

/**
 * 官方 api.js 依赖 homedir() 找 client pid。这里用独立的 HOME 目录，
 * 避免影响当前进程和用户的全局 ~/.whistle_client.pid。
 */
function isolateHome(instance) {
  const record = readInstancePid(instance);
  const pid = record?.pid;
  const port = Number(instance.port);
  if (!Number.isInteger(pid) || pid <= 0 || !port) {
    fail('WHISTLE_API_INSTANCE_UNKNOWN', `找不到实例 ${instance.storage} 的 pid/port`);
  }
  const home = path.join(os.tmpdir(), `warren-whistle-api-${instance.storage}-${pid}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const rawAuth = String(record?.options?.specialAuth || '');
  const auth = /^[A-Za-z0-9._~-]+$/.test(rawAuth) ? rawAuth : '';
  const client = `${pid},127.0.0.1,${port},${auth}\n`;
  writeFileSync(path.join(home, '.whistle_client.pid'), client, { mode: 0o600 });
  return home;
}

function apiModulePath(instance, w2) {
  const home = isolateHome(instance);
  const key = `${w2.display}:${home}:${instance.storage}`;
  if (cache.has(key)) return cache.get(key);
  const { spawnSync } = require('node:child_process');
  /*
   * `whistle/bin/api` 是 CommonJS 闭包，内部通过 common.getHomedir() 找
   * `.whistle_client.pid`；加载时临时切换 HOME，加载完恢复。API 的方法本身
   * 走已解析的 http 配置，不再依赖调用时的 HOME。
   */
  const result = spawnSync(w2.file, [...w2.prefixArgs, 'root', 'bin/api'], {
    env: { ...process.env, ...w2.env, HOME: home },
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout?.trim()) {
    fail('WHISTLE_API_LOAD_FAILED', `加载官方 Agent API 失败: ${result.stderr || result.stdout || '空输出'}`);
  }
  cache.set(key, result.stdout.trim());
  return result.stdout.trim();
}

/**
 * 执行一次官方 API 调用。调用方必须显式传入 storage 对应的 instance。
 * 这里不读取全局 ~/.whistle_client.pid，也不猜测 8899。
 */
async function requestPort(instance, pathname, data, type) {
  const port = Number(instance.port);
  if (!port) fail('WHISTLE_API_INSTANCE_UNKNOWN', '实例缺少端口');
  const body = data == null ? null : typeof data === 'string' ? data : JSON.stringify(data);
  const headers = body
    ? { 'content-type': typeof data === 'string' ? 'application/x-www-form-urlencoded' : 'application/json' }
    : {};
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/cgi-bin/${pathname}`,
        method: body ? 'POST' : 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { code: 'WHISTLE_API_HTTP' }));
            return;
          }
          if (type === 'raw') {
            resolve(raw);
            return;
          }
          const text = raw.toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(Object.assign(new Error(`非 JSON: ${text.slice(0, 200)}`), { code: 'WHISTLE_API_NON_JSON' }));
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

export const AGENT_ENDPOINTS = {
  'network.getStatus': ['status'],
  'network.getSessions': ['sessions'],
  'network.getFrames': ['frames'],
  'network.request': ['composer'],
  'network.saveSessions': ['saved/save'],
  'network.getSavedSessions': ['saved/sessions'],
  'network.abort': ['abort'],
  'rules.getStatus': ['rules/status'],
  'rules.getList': ['rules/list'],
  'rules.get': ['rules/value'],
  'rules.add': ['rules/add'],
  'rules.select': ['rules/select2'],
  'rules.unselect': ['rules/unselect2'],
  'rules.moveToTop': ['rules/move-top'],
  'rules.isMultiSelect': ['rules/is-multi-select'],
  'rules.setMultiSelect': ['rules/allow-multiple-choice'],
  'rules.setLaterFirst': ['rules/enable-back-rules-first'],
  'rules.turnOn': ['rules/disable-all-rules'],
  'rules.turnOff': ['rules/disable-all-rules'],
  'values.getList': ['values/list'],
  'values.get': ['values/value'],
  'values.add': ['values/add'],
  'plugins.getStatus': ['plugins/status'],
  'plugins.getList': ['plugins/list'],
  'plugins.get': ['plugins/plugin'],
  'plugins.select': ['plugins/disable-plugin'],
  'plugins.unselect': ['plugins/disable-plugin'],
  'plugins.turnOn': ['plugins/disable-all-plugins'],
  'plugins.turnOff': ['plugins/disable-all-plugins'],
  isEnabledHTTPS: ['is-enabled-https'],
  setEnableHTTPS: ['intercept-https-connects'],
  getRootCA: ['rootca'],
  createFile: ['temp/create'],
  getFile: ['temp/get'],
};

export async function callAgentApi(instance, w2, method, ...args) {
  // 官方 bin/api 的 client 发现只支持单 client；先校验官方模块和版本，
  // 再用同一官方 endpoint 契约显式访问 Warren 的多实例端口。
  const modulePath = apiModulePath(instance, w2);
  const api = require(modulePath);
  const [group, action] = String(method).split('.');
  const fn = action ? api[group]?.[action] : api[group];
  if (typeof fn !== 'function') {
    fail('WHISTLE_API_METHOD_UNKNOWN', `官方 Agent API 没有方法 ${method}`);
  }
  const status = await requestPort(instance, 'status');
  if (!isAgentApiVersion(status.version)) {
    fail('WHISTLE_API_VERSION', `Whistle ${status.version} < 2.10.7`);
  }
  const endpoint = AGENT_ENDPOINTS[method];
  if (!endpoint) fail('WHISTLE_API_METHOD_UNKNOWN', `未映射官方 endpoint: ${method}`);
  const [pathname, prefix] = endpoint;
  let query = prefix || '';
  let data = args[0];
  if (method === 'rules.get') query = `name=${encodeURIComponent(String(args[0] || ''))}`;
  if (method === 'values.get') query = `key=${encodeURIComponent(String(args[0] || ''))}`;
  if (method === 'plugins.get') query = `name=${encodeURIComponent(String(args[0] || ''))}`;
  if (method === 'rules.select') data = { name: args[0] };
  if (method === 'rules.unselect') data = { name: args[0] === undefined ? false : args[0] };
  if (method === 'rules.moveToTop') data = { name: args[0] };
  if (method === 'values.add') data = { name: args[0], value: args[1] };
  if (method === 'plugins.select' || method === 'plugins.unselect') {
    data = { name: args[0], disabled: method === 'plugins.unselect' ? 1 : 0 };
  }
  if (method === 'rules.setMultiSelect') data = { allowMultipleChoice: args[0] ? 1 : 0 };
  if (method === 'rules.setLaterFirst') data = { backRulesFirst: args[0] ? 1 : 0 };
  if (method === 'rules.turnOn') data = { disabledAllRules: 0 };
  if (method === 'rules.turnOff') data = { disabledAllRules: 1 };
  if (method === 'plugins.turnOn') data = { disabledAllPlugins: 0 };
  if (method === 'plugins.turnOff') data = { disabledAllPlugins: 1 };
  if (method === 'setEnableHTTPS') data = { interceptHttpsConnects: args[0] ? 1 : 0 };
  if (method === 'network.abort') data = { list: Array.isArray(args[0]) ? args[0].join() : args[0] };
  if (method === 'network.request') data = args[0];
  if (method === 'network.getSessions' || method === 'network.getFrames') data = args[0] || {};
  if (method === 'network.saveSessions') data = { sessions: args[0] || [], filename: args[1] || '' };
  if (method === 'network.getSavedSessions') {
    const saved = args[0] || {};
    const filename = typeof saved === 'string' ? saved : saved.filename || '';
    query = `filename=${encodeURIComponent(filename)}&count=${Number(saved.count || 0)}&time=${Number(saved.time || 0)}`;
  }
  if (method === 'createFile') {
    const value =
      typeof args[0] === 'string' ? { value: args[0] } : { base64: Buffer.from(args[0] || '').toString('base64') };
    data = value;
  }
  if (method === 'getFile') query = `filename=${encodeURIComponent(String(args[0] || ''))}`;
  const result = await requestPort(
    instance,
    pathname + (query ? `?${query}` : ''),
    data,
    method === 'getRootCA' || method === 'getSavedSessions' ? 'raw' : undefined,
  );
  if (method === 'getFile') return result.value;
  if (method === 'network.getSavedSessions') {
    const text = Buffer.isBuffer(result) ? gunzipSync(result).toString('utf8') : String(result);
    return JSON.parse(text);
  }
  if (method === 'rules.getList') {
    return (result.list || []).map((item) => ({
      name: item.name,
      value: item.data || '',
      selected: Boolean(item.selected),
    }));
  }
  if (method === 'rules.get' || method === 'values.get') return result.value;
  if (method === 'values.getList') {
    return (result.list || []).map((item) => ({ name: item.name, value: item.data || '' }));
  }
  if (method === 'plugins.get') return result.plugin;
  if (method === 'rules.add' || method === 'values.add') return result.ec === 0;
  if (method === 'rules.isMultiSelect') return Boolean(result.multiSelect);
  if (method === 'isEnabledHTTPS') return Boolean(result.enabled);
  if (method === 'rules.select' || method === 'rules.unselect' || method === 'rules.moveToTop') {
    return result.ec === 0;
  }
  if (method === 'plugins.select' || method === 'plugins.unselect') return Boolean(result.exists);
  if (
    method === 'rules.setMultiSelect' ||
    method === 'rules.setLaterFirst' ||
    method === 'rules.turnOn' ||
    method === 'rules.turnOff' ||
    method === 'plugins.turnOn' ||
    method === 'plugins.turnOff' ||
    method === 'setEnableHTTPS'
  ) {
    return result.ec === 0;
  }
  return result;
}

export function agentApiFor(instance, w2) {
  return {
    network: {
      getStatus: () => callAgentApi(instance, w2, 'network.getStatus'),
      getSessions: (options) => callAgentApi(instance, w2, 'network.getSessions', options),
      getFrames: (options) => callAgentApi(instance, w2, 'network.getFrames', options),
      request: (options) => callAgentApi(instance, w2, 'network.request', options),
      saveSessions: (sessions, name) => callAgentApi(instance, w2, 'network.saveSessions', sessions, name),
      getSavedSessions: (name) => callAgentApi(instance, w2, 'network.getSavedSessions', name),
      abort: (reqId) => callAgentApi(instance, w2, 'network.abort', reqId),
    },
    rules: {
      getStatus: () => callAgentApi(instance, w2, 'rules.getStatus'),
      getList: () => callAgentApi(instance, w2, 'rules.getList'),
      get: (name) => callAgentApi(instance, w2, 'rules.get', name),
      add: (name, value, selected) => callAgentApi(instance, w2, 'rules.add', name, value, selected),
      select: (name) => callAgentApi(instance, w2, 'rules.select', name),
      unselect: (name) => callAgentApi(instance, w2, 'rules.unselect', name),
      moveToTop: (name) => callAgentApi(instance, w2, 'rules.moveToTop', name),
      isMultiSelect: () => callAgentApi(instance, w2, 'rules.isMultiSelect'),
      setMultiSelect: (enabled) => callAgentApi(instance, w2, 'rules.setMultiSelect', enabled),
      setLaterFirst: (enabled) => callAgentApi(instance, w2, 'rules.setLaterFirst', enabled),
      turnOn: () => callAgentApi(instance, w2, 'rules.turnOn'),
      turnOff: () => callAgentApi(instance, w2, 'rules.turnOff'),
    },
    values: {
      getList: () => callAgentApi(instance, w2, 'values.getList'),
      get: (name) => callAgentApi(instance, w2, 'values.get', name),
      add: (name, value) => callAgentApi(instance, w2, 'values.add', name, value),
    },
    plugins: {
      getStatus: () => callAgentApi(instance, w2, 'plugins.getStatus'),
      getList: () => callAgentApi(instance, w2, 'plugins.getList'),
      get: (name) => callAgentApi(instance, w2, 'plugins.get', name),
      select: (name) => callAgentApi(instance, w2, 'plugins.select', name),
      unselect: (name) => callAgentApi(instance, w2, 'plugins.unselect', name),
      turnOn: () => callAgentApi(instance, w2, 'plugins.turnOn'),
      turnOff: () => callAgentApi(instance, w2, 'plugins.turnOff'),
    },
    https: {
      isEnabled: () => callAgentApi(instance, w2, 'isEnabledHTTPS'),
      setEnabled: (enabled) => callAgentApi(instance, w2, 'setEnableHTTPS', enabled),
      getRootCA: () => callAgentApi(instance, w2, 'getRootCA'),
    },
    files: {
      create: (data) => callAgentApi(instance, w2, 'createFile', data),
      get: (filepath) => callAgentApi(instance, w2, 'getFile', filepath),
    },
  };
}

export function agentApiRequirements() {
  return {
    minimumVersion: '2.10.7',
    insecureGlobalHome: false,
    methods: [
      'network.getStatus',
      'network.getSessions',
      'network.getFrames',
      'network.request',
      'network.saveSessions',
      'rules.getStatus',
      'rules.getList',
      'rules.get',
      'rules.add',
      'rules.select',
      'rules.unselect',
      'rules.moveToTop',
      'rules.isMultiSelect',
      'rules.setMultiSelect',
      'rules.setLaterFirst',
      'rules.turnOn',
      'rules.turnOff',
      'values.getList',
      'values.get',
      'values.add',
      'plugins.getStatus',
      'plugins.getList',
      'plugins.get',
      'plugins.select',
      'plugins.unselect',
      'plugins.turnOn',
      'plugins.turnOff',
      'isEnabledHTTPS',
      'setEnableHTTPS',
      'getRootCA',
      'createFile',
      'getFile',
    ],
  };
}
