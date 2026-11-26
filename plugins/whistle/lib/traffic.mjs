/**
 * Whistle 抓包浏览、Composer 合成/重放、HAR/cURL 导出、排障链接与官方 Agent API。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../presets.mjs';
import { agentApiFor, agentApiRequirements, isAgentApiVersion, resolveAgentMethod } from '../agent-api.mjs';
import {
  buildCurlCommand,
  computeTimings,
  diffResponses,
  extractMatchedRules,
  isSensitiveHeader,
  isSensitiveJsonKey,
  redactJson,
} from '../intents.mjs';
import { COMPOSE_TIMEOUT_MS, PROBE_TIMEOUT_MS, RULE_NAME, envBoundTo, fail, requireInstance } from './shared.mjs';
import { callJson, instancePid, readRule, requireRunningInstance, resolveW2, statusOf } from './w2-client.mjs';

export function decodeBody(part, limit = 128 * 1024) {
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

export function requestIdOf(req, res, body) {
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

export function normalizeTrafficEntry(id, item, input = {}) {
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
    Object.entries(reqHeaders).map(([key, value]) => [key, redact && isSensitiveHeader(key) ? '[REDACTED]' : value]),
  );
  const responseHeaders = Object.fromEntries(
    Object.entries(resHeaders).map(([key, value]) => [key, redact && isSensitiveHeader(key) ? '[REDACTED]' : value]),
  );
  return {
    source: 'whistle-live',
    entryId: String(id),
    startTime: item && item.startTime != null ? item.startTime : null,
    endTime: item && item.endTime != null ? item.endTime : null,
    url: item && item.url != null ? String(item.url) : '',
    method: req.method ?? null,
    status: res.statusCode != null ? Number(res.statusCode) : null,
    requestHeaders,
    responseHeaders,
    requestBody: redact ? redactJson(reqDecoded.body) : reqDecoded.body,
    responseBody: redact ? redactJson(resDecoded.body) : resDecoded.body,
    // Keep the raw request/response needed by HAR/session export. These fields
    // are only present when explicitly requested and never enter normal
    // `traffic` output.
    ...(input.keepRaw === true ? { raw: { req, res } } : {}),
    // A source item is either a raw Whistle record or an already-normalized
    // traffic entry. Keep both shapes usable so export can consume the same
    // data without re-fetching.
    requestBodyEncoding: reqDecoded.encoding || item.requestBodyEncoding || null,
    responseBodyEncoding: resDecoded.encoding || item.responseBodyEncoding || null,
    requestBodyTruncated: Boolean(reqDecoded.truncated || item.requestBodyTruncated),
    responseBodyTruncated: Boolean(resDecoded.truncated || item.responseBodyTruncated),
    requestSize: req.size ?? item.requestSize ?? null,
    responseSize: res.size ?? item.responseSize ?? null,
    requestId: requestIdOf(req, res, resDecoded.body),
    rules: item && item.rules ? item.rules : {},
    rulesHeaders: item && item.rulesHeaders ? item.rulesHeaders : {},
    matchedRules: extractMatchedRules(item && item.rules),
    timings: computeTimings(item),
    timing: {
      dnsTime: item && item.dnsTime != null ? item.dnsTime : null,
      requestTime: item && item.requestTime != null ? item.requestTime : null,
      responseTime: item && item.responseTime != null ? item.responseTime : null,
      endTime: item && item.endTime != null ? item.endTime : null,
    },
  };
}

export function trafficFilters(input) {
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

export function selectTraffic(rows, input = {}) {
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

export function hasServerSessionFilters(input) {
  if (!input || typeof input !== 'object') return false;
  return Boolean(
    input.type ||
    input.subUrl ||
    input.statusCode !== undefined ||
    input.reqHeader ||
    input.resHeader ||
    input.startId !== undefined ||
    input.latest !== undefined,
  );
}

export function hasLegacyGetDataCursor(input) {
  if (!input || typeof input !== 'object') return false;
  return Boolean(input.ids || input.statusQuery || input.lastRowId != null || input.dumpCount != null);
}

export function buildSessionApiOptions(input = {}) {
  const opts = {};
  if (input.type) opts.type = String(input.type);
  if (input.subUrl) opts.subUrl = String(input.subUrl);
  else if (typeof input.url === 'string' && input.url.trim()) opts.subUrl = input.url.trim();
  else if (Array.isArray(input.urls) && input.urls.length === 1) opts.subUrl = String(input.urls[0]);
  const method = input.method ?? input.methods;
  if (method) opts.method = method;
  const statusCode = input.statusCode ?? input.statuses ?? input.status;
  if (statusCode !== undefined) opts.statusCode = statusCode;
  if (input.reqHeader && typeof input.reqHeader === 'object') {
    opts.reqHeader = {
      ...input.reqHeader,
      name: String(input.reqHeader.name || input.reqHeader.key || '').toLowerCase(),
    };
  }
  if (input.resHeader && typeof input.resHeader === 'object') {
    opts.resHeader = {
      ...input.resHeader,
      name: String(input.resHeader.name || input.resHeader.key || '').toLowerCase(),
    };
  }
  if (input.startId !== undefined) opts.startId = input.startId;
  if (input.startTime != null) opts.startTime = Number(input.startTime);
  if (input.since != null && opts.startTime == null) opts.startTime = Number(input.since);
  if (input.latest !== undefined) opts.latest = Boolean(input.latest);
  else if (opts.startId === undefined && opts.startTime === undefined) opts.latest = true;
  if (input.count != null) opts.count = Number(input.count);
  return opts;
}

export async function tryGetSessionsViaAgentApi(host, registered, status, input) {
  if (!isAgentApiVersion(status?.version) || hasLegacyGetDataCursor(input)) return null;
  try {
    const settings = await host.settings.get();
    const pid = await instancePid(registered, settings);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const live = requireLiveAgentInstance(registered, status, pid);
    const w2 = await resolveW2(host);
    const api = agentApiFor(live, w2);
    const sessions = await api.network.getSessions(buildSessionApiOptions(input));
    return Array.isArray(sessions) ? sessions : null;
  } catch (error) {
    if (hasServerSessionFilters(input) && error?.code === 'WHISTLE_API_LOAD_FAILED') {
      return null;
    }
    return null;
  }
}

export async function traffic(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const status = await statusOf(instance.port);
  if (!status) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  const apiSessions = await tryGetSessionsViaAgentApi(host, instance, status, input);
  if (apiSessions) {
    const rows = Object.fromEntries(apiSessions.map((item, idx) => [String(item.id || idx), item]));
    const entries = selectTraffic(rows, input);
    const lastEntryId = entries.length ? entries[entries.length - 1].entryId : null;
    const ids = entries.map((item) => item.entryId);
    return {
      source: 'whistle-live',
      filterMode: 'server-sessions',
      storage: instance.storage,
      port: instance.port,
      capturedAt: new Date().toISOString(),
      cursor: {
        newIds: ids.slice(0, 200),
        newIdsTotal: ids.length,
        lastId: lastEntryId,
        endId: lastEntryId,
      },
      next: {
        endId: lastEntryId,
        lastId: lastEntryId,
      },
      summary: {
        total: entries.length,
        methods: [...new Set(entries.map((item) => item.method).filter(Boolean))],
        statuses: [...new Set(entries.map((item) => item.status).filter((item) => item != null))],
      },
      entries,
    };
  }
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
      lastId: data.data?.lastId ?? null,
      endId: data.data?.endId ?? null,
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

export async function trafficSessionObjects(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const status = await statusOf(instance.port);
  if (!status) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  const apiSessions = await tryGetSessionsViaAgentApi(host, instance, status, input);
  if (apiSessions) {
    return apiSessions.map((item, idx) => ({
      ...item,
      id: String(item.id || idx),
      raw: { req: item.req || {}, res: item.res || {} },
    }));
  }
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

export function composerResponse(data) {
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

export function harEntry(session) {
  const req = session.req || session.raw?.req || {};
  const res = session.res || session.raw?.res || {};
  const reqDecoded = decodeBody(req, 0);
  const resDecoded = decodeBody(res, 0);
  const method = req.method || session.method || 'GET';
  const status = res.statusCode ?? session.status ?? 0;
  const url = session.url || '';
  const reqHeaders = req.headers || session.requestHeaders || {};
  const resHeaders = res.headers || session.responseHeaders || {};
  const reqBody = reqDecoded.body || session.requestBody || '';
  const resBody = resDecoded.body || session.responseBody || '';
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

export async function compose(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  const url = String((input && input.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) fail('BAD_REQUEST', 'compose 需要 http(s) url');
  const rawBody = input && input.data != null ? input.data : input && input.body != null ? input.body : '';
  const body = {
    url,
    method: String((input && input.method) || 'GET').toUpperCase(),
    headers: input && input.headers ? input.headers : {},
    body: typeof rawBody === 'object' && rawBody !== null ? JSON.stringify(rawBody) : String(rawBody),
    needResponse: true,
    useH2: Boolean(input && input.useH2),
    enableProxyRules: input?.enableProxyRules !== false,
    ...(input && input.rules ? { rules: String(input.rules) } : {}),
    ...(input && Number(input.times) > 1 ? { repeatCount: Math.round(Number(input.times)) } : {}),
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
            Object.entries(body.headers).map(([key, value]) => [key, isSensitiveHeader(key) ? '[REDACTED]' : value]),
          ),
      body: includeSensitive ? body.body : redactJson(body.body),
      enableProxyRules: body.enableProxyRules,
    },
    response: includeSensitive
      ? response
      : {
          ...response,
          headers: Object.fromEntries(
            Object.entries(response.headers).map(([key, value]) => [
              key,
              isSensitiveHeader(key) ? '[REDACTED]' : value,
            ]),
          ),
          body: redactJson(response.body),
          json: redactJson(response.json),
        },
    ok: response.status != null && response.status >= 200 && response.status < 400,
  };
}

export async function doctor(host, input) {
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

export async function liveAgentInstance(host, instance) {
  const status = await statusOf(instance.port);
  const settings = await host.settings.get();
  const pid = await instancePid(instance, settings);
  return requireLiveAgentInstance(instance, status, pid);
}

export async function agent(host, input) {
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
  const resolved = resolveAgentMethod(method);
  if (!resolved || !api[resolved.group] || typeof api[resolved.group][resolved.action] !== 'function') {
    fail('WHISTLE_AGENT_METHOD_UNKNOWN', `未知官方 Agent API 方法 ${method}`);
  }
  const result = await api[resolved.group][resolved.action](...args);
  const includeValues = input && input.includeValues === true;
  return {
    storage: instance.storage,
    port: instance.port,
    method: resolved.canonical,
    requestedMethod: method,
    result:
      !includeValues && Array.isArray(result)
        ? result.map((item) =>
            resolved.group === 'rules' && item && typeof item === 'object' ? { ...item, value: '' } : item,
          )
        : result,
  };
}

export async function agentStatus(host, input) {
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

export async function exportData(host, input) {
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
  const baseDir = path.resolve(directory);
  const targetName = path.extname(requestedFile) ? requestedFile : `${requestedFile}.${suffix}`;
  const file = path.resolve(baseDir, targetName);
  const rel = path.relative(baseDir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('PATH_DENIED', `导出文件名不能逃逸目标目录 ${directory}: ${requestedFile}`);
  }
  writeFileSync(file, bytes);
  return {
    storage: instance.storage,
    type,
    file,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

export async function findSessionByReqId(host, instance, reqId) {
  const id = String(reqId || '').trim();
  if (!id) fail('BAD_REQUEST', '需要 reqId');
  const data = await callJson(instance.port, `/cgi-bin/get-data?ids=${encodeURIComponent(id)}`);
  const direct = data?.data?.data?.[id];
  if (direct && typeof direct === 'object') {
    return { ...direct, id };
  }
  const status = await statusOf(instance.port);
  const recent = await tryGetSessionsViaAgentApi(host, instance, status, { latest: true, count: 200 });
  const matched = Array.isArray(recent) ? recent.find((item) => String(item.id || '') === id) : null;
  if (matched) return matched;
  fail('WHISTLE_SESSION_NOT_FOUND', `实例 ${instance.storage} 中找不到 reqId=${id} 的抓包记录`);
}

export function restoreRedactedJsonFields(edited, orig) {
  if (Array.isArray(edited) && Array.isArray(orig)) {
    return edited.map((item, idx) => restoreRedactedJsonFields(item, orig[idx]));
  }
  if (
    !edited ||
    !orig ||
    typeof edited !== 'object' ||
    typeof orig !== 'object' ||
    Array.isArray(edited) ||
    Array.isArray(orig)
  ) {
    return edited;
  }
  const out = {};
  for (const [k, v] of Object.entries(edited)) {
    if (v === '[REDACTED]' && isSensitiveJsonKey(k) && Object.hasOwn(orig, k)) {
      out[k] = orig[k];
    } else if (Object.hasOwn(orig, k)) {
      out[k] = restoreRedactedJsonFields(v, orig[k]);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function replay(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const reqId = String((input && input.reqId) || '').trim();
  const session = await findSessionByReqId(host, instance, reqId);
  const origReq = session.req || session.raw?.req || {};
  const origRes = session.res || session.raw?.res || {};

  const mergedHeaders = {};
  const origKeyMap = new Map();
  for (const [key, val] of Object.entries(origReq.headers || {})) {
    const lower = String(key).toLowerCase();
    if (lower.startsWith(':') || lower === 'content-length') continue;
    mergedHeaders[key] = Array.isArray(val) ? val.join('; ') : String(val ?? '');
    origKeyMap.set(lower, key);
  }
  if (input?.headers && typeof input.headers === 'object') {
    for (const [key, val] of Object.entries(input.headers)) {
      const lower = String(key).toLowerCase();
      const existingKey = origKeyMap.get(lower);
      if (val === null || val === undefined) {
        if (existingKey) delete mergedHeaders[existingKey];
        delete mergedHeaders[key];
      } else {
        const strVal = String(val);
        // 脱敏占位符不得覆盖服务端原始敏感头
        if (strVal === '[REDACTED]' && existingKey && isSensitiveHeader(key)) {
          continue;
        }
        if (existingKey && existingKey !== key) delete mergedHeaders[existingKey];
        mergedHeaders[key] = strVal;
        origKeyMap.set(lower, key);
      }
    }
  }

  let dataPayload;
  let base64Payload;
  if (input && input.body !== undefined) {
    const origReqDecoded = decodeBody(origReq, 0);
    if (typeof input.body === 'object' && input.body !== null) {
      dataPayload = JSON.stringify(restoreRedactedJsonFields(input.body, origReqDecoded.body));
    } else {
      const rawBodyStr = String(input.body);
      let restored = rawBodyStr;
      if (origReqDecoded.body && typeof origReqDecoded.body === 'object') {
        try {
          const parsedEdited = JSON.parse(rawBodyStr);
          if (parsedEdited && typeof parsedEdited === 'object') {
            restored = JSON.stringify(restoreRedactedJsonFields(parsedEdited, origReqDecoded.body));
          }
        } catch {}
      }
      dataPayload = restored;
    }
  } else if (typeof origReq.base64 === 'string' && origReq.base64) {
    base64Payload = origReq.base64;
  } else if (typeof origReq.body === 'string') {
    dataPayload = origReq.body;
  }

  const composed = await compose(host, {
    storage: instance.storage,
    url: input?.url || session.url,
    method: input?.method || origReq.method || 'GET',
    headers: mergedHeaders,
    data: dataPayload,
    base64: base64Payload,
    rules: input?.rules,
    times: input?.times,
    useH2: input?.useH2,
    enableProxyRules: input?.enableProxyRules,
    includeSensitive: input?.includeSensitive,
  });

  const includeSensitive = input?.includeSensitive === true;
  const origDecoded = decodeBody(origRes, 0);
  let origJson = null;
  try {
    origJson = typeof origDecoded.body === 'string' ? JSON.parse(origDecoded.body) : origDecoded.body;
  } catch {}
  const origRawHeaders = origRes.headers || {};
  const original = {
    status: origRes.statusCode ?? null,
    headers: includeSensitive
      ? origRawHeaders
      : Object.fromEntries(
          Object.entries(origRawHeaders).map(([key, value]) => [key, isSensitiveHeader(key) ? '[REDACTED]' : value]),
        ),
    body: includeSensitive ? origDecoded.body : redactJson(origDecoded.body),
    json: includeSensitive ? origJson : redactJson(origJson),
  };

  const diff =
    input?.diff === true
      ? diffResponses(
          { status: origRes.statusCode ?? null, headers: origRawHeaders, body: origDecoded.body, json: origJson },
          composed.response,
          { includeSensitive },
        )
      : null;

  return {
    storage: instance.storage,
    port: instance.port,
    reqId,
    request: composed.request,
    original,
    replayed: composed.response,
    ok: composed.ok,
    diff,
  };
}

export async function toCurl(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const reqId = String((input && input.reqId) || '').trim();
  const session = await findSessionByReqId(host, instance, reqId);
  const includeSensitive = input?.includeSensitive === true;
  const curl = buildCurlCommand(session, { includeSensitive });
  return {
    storage: instance.storage,
    port: instance.port,
    reqId,
    method: String(session.req?.method || 'GET').toUpperCase(),
    url: String(session.url || ''),
    sensitiveIncluded: includeSensitive,
    curl,
  };
}

export async function captureLink(host, input) {
  const registered = await requireInstance(host, input && input.storage);
  const instance = await liveAgentInstance(host, registered);
  let sessions = await trafficSessionObjects(host, input);
  const { urls, methods, statuses, since } = trafficFilters(input);
  sessions = sessions.filter((session) => {
    const url = String(session.url || '');
    const method = String(session.req?.method || session.method || '').toUpperCase();
    const status = Number(session.res?.statusCode ?? session.status);
    if (urls.length && !urls.some((part) => url.includes(String(part)))) return false;
    if (methods.length && !methods.includes(method)) return false;
    if (statuses.length && !statuses.map(Number).includes(status)) return false;
    if (since != null && !(Number(session.startTime) >= since)) return false;
    return true;
  });
  if (!sessions.length) fail('WHISTLE_CAPTURE_EMPTY', '没有匹配过滤条件的抓包记录，无法生成排障链接');

  const w2 = await resolveW2(host);
  const api = agentApiFor(instance, w2);
  const name = String((input && input.name) || `warren-${instance.storage}-${Date.now()}`).trim();
  const savedRaw = await api.network.saveSessions(sessions, name);
  const savedFilename =
    typeof savedRaw === 'string'
      ? savedRaw
      : savedRaw && typeof savedRaw === 'object' && typeof savedRaw.filename === 'string'
        ? savedRaw.filename
        : null;
  const url = await api.network.createUrl(sessions);

  let opened = false;
  let tabId = null;
  let environmentId = String((input && input.environmentId) || '').trim() || null;
  if (input?.open === true) {
    if (!environmentId) {
      const bound = envBoundTo(await host.environment.list(), instance.port);
      environmentId = bound ? bound.id : null;
    }
    if (environmentId) {
      const tab = await host.browser.openTab(url, { environmentId, activate: true });
      opened = Boolean(tab);
      tabId = tab?.id ? String(tab.id) : null;
    }
  }

  return {
    storage: instance.storage,
    port: instance.port,
    count: sessions.length,
    name,
    savedFilename: savedFilename || null,
    url,
    opened,
    ...(environmentId ? { environmentId } : {}),
    ...(tabId ? { tabId } : {}),
  };
}
