/**
 * Whistle AI 调试意图与纯分析模块。
 *
 * 本文件**不碰 Electron、不碰网络、不碰文件系统**，供 `host.mjs` 和 `tests/whistle-intents.test.ts` 共用：
 * - 受控调试组常量（warren-mock / warren-fault / warren-local）
 * - quickMock / injectFault / mapLocal 规则拼装与幂等行替换
 * - matchRulesForUrl：Whistle 规则命中诊断
 * - computeTimings / extractMatchedRules：抓包性能与命中提取
 * - diffResponses：请求重放响应对比（状态码 / 响应头 / JSON diff）
 * - buildCurlCommand：抓包转可复制的脱敏 cURL 命令
 */
import { createHash } from 'node:crypto';
import { normalizeText } from './presets.mjs';

export const CONTROLLED_GROUPS = Object.freeze({
  mock: 'warren-mock',
  fault: 'warren-fault',
  local: 'warren-local',
});

export const MOCK_VALUE_PREFIX = 'warren-mock-';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-csrfcode',
  'x-csrf-token',
  'x-xsrf-token',
  'saas_token',
  'saas-token',
  'x-api-key',
  'x-auth-token',
]);

const SENSITIVE_JSON_KEYS = new Set([
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
  'apikey',
  'token',
]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function isSensitiveHeader(name) {
  return SENSITIVE_HEADERS.has(String(name || '').toLowerCase());
}

function isSensitiveJsonKey(key) {
  return SENSITIVE_JSON_KEYS.has(
    String(key || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ''),
  );
}

function isFiniteNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function diffTime(start, end) {
  return isFiniteNum(start) && isFiniteNum(end) && end >= start ? end - start : null;
}

/** 计算 Whistle session 分阶段耗时（毫秒），缺失阶段返回 null。 */
export function computeTimings(session) {
  if (!session || typeof session !== 'object') {
    return { dns: null, connect: null, ttfb: null, download: null, total: null };
  }
  const { startTime, dnsTime, connectTime, requestTime, responseTime, endTime } = session;
  const dns = diffTime(startTime, dnsTime);
  const connect = diffTime(dnsTime, connectTime) ?? diffTime(dnsTime, requestTime);
  const ttfb = isFiniteNum(session.ttfb) && session.ttfb >= 0 ? session.ttfb : diffTime(startTime, responseTime);
  const download = diffTime(responseTime, endTime);
  const total = diffTime(startTime, endTime);
  return { dns, connect, ttfb, download, total };
}

/** 从 Whistle session.rules 对象提取命中规则明细。 */
export function extractMatchedRules(rules) {
  if (!rules || typeof rules !== 'object') return [];
  const source = rules.rules && typeof rules.rules === 'object' ? rules.rules : rules;
  const seen = new Set();
  const matched = [];
  for (const [protocol, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== 'object') continue;
    const list = Array.isArray(entry.list) ? entry.list : [entry];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const raw = typeof item.raw === 'string' ? item.raw : '';
      const matcher =
        typeof item.matcher === 'string' ? item.matcher : typeof item.rawPattern === 'string' ? item.rawPattern : '';
      if (!raw && !matcher) continue;
      const key = `${protocol}\0${matcher}\0${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push({ protocol, matcher, raw });
    }
  }
  return matched;
}

function validatePattern(pattern, callerName) {
  const text = String(pattern ?? '').trim();
  if (!text) fail('BAD_REQUEST', `${callerName} 需要 pattern`);
  if (/[\r\n\s]/.test(text)) fail('BAD_REQUEST', `${callerName} 的 pattern 不能包含空白或换行`);
  return text;
}

/** 幂等更新或追加受控规则组中的某条 pattern 规则。 */
export function upsertManagedRuleLine(existingText, pattern, newLine, options = {}) {
  if (options.append === false) {
    return `${newLine}\n`;
  }
  const lines = normalizeText(existingText)
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''));
  const result = [];
  let replaced = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      result.push(line);
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    const samePattern = tokens[0] === pattern || (tokens.length === 2 && tokens[1] === pattern);
    if (samePattern) {
      if (!replaced) {
        result.push(newLine);
        replaced = true;
      }
      continue;
    }
    result.push(line);
  }
  if (!replaced) result.push(newLine);
  return `${result.join('\n')}\n`;
}

export function slugifyMockName(pattern, explicitName, extension = 'json') {
  const custom = String(explicitName ?? '').trim();
  if (custom) {
    if (/[\r\n\s{}]/.test(custom)) fail('BAD_REQUEST', 'Value 名称不能包含空白、换行或大括号');
    return custom;
  }
  const stripped = String(pattern || '')
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36);
  const digest = createHash('sha256')
    .update(String(pattern || ''), 'utf8')
    .digest('hex')
    .slice(0, 6);
  const ext = extension ? `.${String(extension).replace(/^\./, '')}` : '';
  return `${MOCK_VALUE_PREFIX}${stripped || 'rule'}-${digest}${ext}`;
}

/** 构造 quickMock 执行计划（Values + 受控组 warren-mock 规则行）。 */
export function buildQuickMockPlan(input = {}) {
  const pattern = validatePattern(input.pattern, 'quickMock');
  if (input.body === undefined) fail('BAD_REQUEST', 'quickMock 需要 body');
  const isObjectBody = typeof input.body === 'object' && input.body !== null;
  const valueBody = isObjectBody ? JSON.stringify(input.body, null, 2) : String(input.body);
  const contentType =
    typeof input.contentType === 'string' && input.contentType.trim()
      ? input.contentType.trim()
      : isObjectBody
        ? 'application/json'
        : '';
  const ext = contentType.includes('json') ? 'json' : contentType.includes('html') ? 'html' : 'txt';
  const valueName = slugifyMockName(pattern, input.name, ext);

  const operators = [`resBody://{${valueName}}`];
  if (contentType) {
    if (/[\s]/.test(contentType)) fail('BAD_REQUEST', 'contentType 不能包含空白');
    operators.push(`resType://${contentType}`);
  }
  if (input.statusCode !== undefined && input.statusCode !== null && input.statusCode !== '') {
    const code = Number(input.statusCode);
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      fail('BAD_REQUEST', 'statusCode 必须是 100..599 的整数');
    }
    operators.push(`statusCode://${code}`);
  }
  if (input.delayMs !== undefined && input.delayMs !== null && input.delayMs !== '') {
    const delay = Math.round(Number(input.delayMs));
    if (!Number.isFinite(delay) || delay < 0) fail('BAD_REQUEST', 'delayMs 必须是非负整数');
    if (delay > 0) operators.push(`resDelay://${delay}`);
  }
  if (input.cors === true) {
    operators.push('resCors://*');
  }

  const extraValues = [];
  if (input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)) {
    const entries = Object.entries(input.headers);
    if (entries.length > 0) {
      const compact = JSON.stringify(input.headers);
      if (!/\s/.test(compact)) {
        operators.push(`resHeaders://(${compact})`);
      } else {
        const headersName = `${valueName}.headers.json`;
        extraValues.push({ name: headersName, value: JSON.stringify(input.headers, null, 2) });
        operators.push(`resHeaders://{${headersName}}`);
      }
    }
  }

  return {
    group: CONTROLLED_GROUPS.mock,
    pattern,
    valueName,
    valueBody,
    extraValues,
    operators,
    ruleLine: `${pattern} ${operators.join(' ')}`,
  };
}

/** 构造 injectFault 规则行（写入受控组 warren-fault）。 */
export function buildFaultRuleLine(input = {}) {
  const pattern = validatePattern(input.pattern, 'injectFault');
  const operators = [];
  if (input.delayMs !== undefined && input.delayMs !== null && input.delayMs !== '') {
    const delay = Math.round(Number(input.delayMs));
    if (!Number.isFinite(delay) || delay < 0) fail('BAD_REQUEST', 'delayMs 必须是非负整数');
    if (delay > 0) operators.push(`resDelay://${delay}`);
  }
  if (input.reqDelayMs !== undefined && input.reqDelayMs !== null && input.reqDelayMs !== '') {
    const reqDelay = Math.round(Number(input.reqDelayMs));
    if (!Number.isFinite(reqDelay) || reqDelay < 0) fail('BAD_REQUEST', 'reqDelayMs 必须是非负整数');
    if (reqDelay > 0) operators.push(`reqDelay://${reqDelay}`);
  }
  if (input.speedKbps !== undefined && input.speedKbps !== null && input.speedKbps !== '') {
    const speed = Number(input.speedKbps);
    if (!Number.isFinite(speed) || speed <= 0) fail('BAD_REQUEST', 'speedKbps 必须是正数');
    operators.push(`resSpeed://${speed}`);
  }
  if (input.statusCode !== undefined && input.statusCode !== null && input.statusCode !== '') {
    const code = Number(input.statusCode);
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      fail('BAD_REQUEST', 'statusCode 必须是 100..599 的整数');
    }
    operators.push(`statusCode://${code}`);
  }
  if (input.disableCache === true) operators.push('disable://cache');
  if (input.disableEncoding === true) operators.push('disable://encoding');

  if (!operators.length) {
    fail(
      'BAD_REQUEST',
      'injectFault 至少需要一种故障参数（delayMs/reqDelayMs/speedKbps/statusCode/disableCache/disableEncoding）',
    );
  }
  return {
    group: CONTROLLED_GROUPS.fault,
    pattern,
    operators,
    ruleLine: `${pattern} ${operators.join(' ')}`,
  };
}

/** 构造 mapLocal 规则行（写入受控组 warren-local）。 */
export function buildMapLocalRuleLine(input = {}) {
  const pattern = validatePattern(input.pattern, 'mapLocal');
  let target = '';
  if (typeof input.targetUrl === 'string' && input.targetUrl.trim()) {
    target = input.targetUrl.trim();
    if (/[\r\n\s]/.test(target)) fail('BAD_REQUEST', 'targetUrl 不能包含空白或换行');
  } else if (input.targetPort !== undefined && input.targetPort !== null && input.targetPort !== '') {
    const port = Number(input.targetPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      fail('BAD_REQUEST', 'targetPort 必须是 1..65535 的整数');
    }
    const host = String(input.targetHost || '127.0.0.1').trim() || '127.0.0.1';
    if (/[\r\n\s]/.test(host)) fail('BAD_REQUEST', 'targetHost 不能包含空白或换行');
    target = `${host}:${port}`;
  } else if (typeof input.localDir === 'string' && input.localDir.trim()) {
    const dir = input.localDir.trim();
    if (/[\r\n\s]/.test(dir)) fail('BAD_REQUEST', 'localDir 不能包含空白或换行');
    const proto = input.protocol === 'xfile' ? 'xfile' : 'file';
    target = `${proto}://${dir}`;
  } else {
    fail('BAD_REQUEST', 'mapLocal 需要 targetPort、targetUrl 或 localDir');
  }
  return {
    group: CONTROLLED_GROUPS.local,
    pattern,
    target,
    ruleLine: `${pattern} ${target}`,
  };
}

// ── Whistle 规则匹配诊断 ─────────────────────────────────────────────

const IPV4_OR_HOST_PORT_RE = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/;
const OPERATOR_RE = /^[a-zA-Z][\w-]*:\/\//;
const URL_SCHEME_RE = /^(?:https?|wss?):\/\//i;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegex(pattern, anchoredStart) {
  const body = String(pattern).split('*').map(escapeRegex).join('.*');
  return new RegExp(`${anchoredStart ? '^' : ''}${body}`);
}

function matchFilterToken(token, parsedUrl, method, headers) {
  const sep = token.indexOf('://');
  if (sep < 0) return false;
  const spec = token.slice(sep + 3);
  if (/^m(?:ethod)?:/i.test(spec)) {
    const expected = spec
      .slice(spec.indexOf(':') + 1)
      .toUpperCase()
      .split('|');
    return expected.includes(method);
  }
  if (/^h(?:eader)?:/i.test(spec)) {
    const rest = spec.slice(spec.indexOf(':') + 1);
    const eq = rest.indexOf('=');
    const hName = (eq >= 0 ? rest.slice(0, eq) : rest).trim().toLowerCase();
    const hVal = eq >= 0 ? rest.slice(eq + 1) : '';
    const actual = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === hName)?.[1];
    if (actual === undefined || actual === null) return false;
    return hVal ? String(actual).includes(hVal) : true;
  }
  if (spec.startsWith('/') && spec.lastIndexOf('/') > 0) {
    const last = spec.lastIndexOf('/');
    try {
      const re = new RegExp(spec.slice(1, last), spec.slice(last + 1));
      return re.test(parsedUrl.href);
    } catch {
      return false;
    }
  }
  return parsedUrl.href.includes(spec);
}

function matchUrlPattern(pattern, parsedUrl) {
  if (!pattern) return false;
  let pat = pattern;
  let negated = false;
  if (pat.startsWith('!')) {
    negated = true;
    pat = pat.slice(1);
  }
  let matched = false;
  // 1. 正则 /.../flags
  if (pat.startsWith('/') && pat.lastIndexOf('/') > 0) {
    const last = pat.lastIndexOf('/');
    const body = pat.slice(1, last);
    const flags = pat.slice(last + 1);
    try {
      matched = new RegExp(body, flags).test(parsedUrl.href);
    } catch {
      matched = false;
    }
    return negated ? !matched : matched;
  }
  // 2. 前缀锚定 ^...
  if (pat.startsWith('^')) {
    let raw = pat.slice(1);
    const exactEnd = raw.endsWith('$');
    if (exactEnd) raw = raw.slice(0, -1);
    const re = new RegExp(`^${raw.split('*').map(escapeRegex).join('.*')}${exactEnd ? '$' : ''}`);
    matched = re.test(parsedUrl.href);
    return negated ? !matched : matched;
  }
  // 3. 通配符 *
  if (pat.includes('*')) {
    if (pat.includes('://') || pat.startsWith('http') || pat.startsWith('ws')) {
      matched = wildcardToRegex(pat, true).test(parsedUrl.href);
    } else {
      const hostAndPath = `${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}`;
      const re = wildcardToRegex(pat, !pat.startsWith('*.'));
      matched = re.test(parsedUrl.hostname) || re.test(hostAndPath);
    }
    return negated ? !matched : matched;
  }
  // 4. 完整 scheme 或 //host/path
  const hasScheme = URL_SCHEME_RE.test(pat);
  const protocolRelative = pat.startsWith('//');
  const normalizedPat = hasScheme ? pat : protocolRelative ? `${parsedUrl.protocol}${pat}` : `http://${pat}`;
  try {
    const patUrl = new URL(normalizedPat);
    if (hasScheme && patUrl.protocol !== parsedUrl.protocol) {
      matched = false;
    } else {
      const hostMatch = patUrl.port ? patUrl.host === parsedUrl.host : patUrl.hostname === parsedUrl.hostname;
      if (!hostMatch) {
        matched = false;
      } else {
        const patPath = patUrl.pathname || '/';
        if (patPath === '/' && !pat.endsWith('/')) {
          matched = true;
        } else {
          const cleanPat = patPath.endsWith('/') ? patPath : `${patPath}`;
          matched =
            parsedUrl.pathname === cleanPat ||
            parsedUrl.pathname.startsWith(cleanPat.endsWith('/') ? cleanPat : `${cleanPat}/`);
        }
        if (matched && patUrl.search) {
          matched = parsedUrl.search.includes(patUrl.search.slice(1));
        }
      }
    }
  } catch {
    matched = parsedUrl.href.includes(pat);
  }
  return negated ? !matched : matched;
}

function splitRuleLineRole(tokens) {
  const filters = [];
  const rest = [];
  for (const token of tokens) {
    if (/^(?:includeFilter|excludeFilter):\/\//i.test(token)) filters.push(token);
    else rest.push(token);
  }
  if (rest.length < 2) return null;
  const first = rest[0];
  const second = rest[1];
  const firstIsOperator = OPERATOR_RE.test(first) && !URL_SCHEME_RE.test(first);
  const firstIsIpTarget = IPV4_OR_HOST_PORT_RE.test(first);
  const secondIsOperator = OPERATOR_RE.test(second) && !URL_SCHEME_RE.test(second);
  if ((firstIsIpTarget || firstIsOperator) && !secondIsOperator) {
    return {
      pattern: second,
      operators: [first, ...rest.slice(2)],
      filters,
    };
  }
  return {
    pattern: first,
    operators: rest.slice(1),
    filters,
  };
}

/** 解析一组 Whistle 规则并诊断指定 URL 会命中哪些规则。 */
export function matchRulesForUrl(ruleGroups, options = {}) {
  const urlText = String(options.url || '').trim();
  if (!urlText) fail('BAD_REQUEST', 'ruleTest 需要 url');
  let parsedUrl;
  try {
    parsedUrl = new URL(urlText);
  } catch {
    fail('BAD_REQUEST', `非法 URL: ${urlText}`);
  }
  const method = String(options.method || 'GET').toUpperCase();
  const headers = options.headers && typeof options.headers === 'object' ? options.headers : {};
  const includeDisabled = options.includeDisabled === true;

  const matched = [];
  const effective = { hosts: [], urls: [], protocols: {} };
  for (const group of Array.isArray(ruleGroups) ? ruleGroups : []) {
    if (!group || typeof group !== 'object') continue;
    if (String(group.name || '').startsWith('\r')) continue;
    if (!includeDisabled && !group.selected) continue;
    const lines = normalizeText(group.data || '').split('\n');
    for (const [index, rawLine] of lines.entries()) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const tokens = trimmed.split(/\s+/);
      const parsed = splitRuleLineRole(tokens);
      if (!parsed) continue;
      if (!matchUrlPattern(parsed.pattern, parsedUrl)) continue;
      const includes = parsed.filters.filter((f) => /^includeFilter:\/\//i.test(f));
      const excludes = parsed.filters.filter((f) => /^excludeFilter:\/\//i.test(f));
      if (includes.length && !includes.every((f) => matchFilterToken(f, parsedUrl, method, headers))) continue;
      if (excludes.some((f) => matchFilterToken(f, parsedUrl, method, headers))) continue;

      matched.push({
        group: group.name,
        selected: Boolean(group.selected),
        lineNumber: index + 1,
        line: trimmed,
        pattern: parsed.pattern,
        operators: parsed.operators,
      });

      for (const op of parsed.operators) {
        if (IPV4_OR_HOST_PORT_RE.test(op)) {
          effective.hosts.push(op);
        } else if (URL_SCHEME_RE.test(op)) {
          effective.urls.push(op);
        } else {
          const idx = op.indexOf('://');
          if (idx > 0) {
            const proto = op.slice(0, idx);
            effective.protocols[proto] = op.slice(idx + 3);
          }
        }
      }
    }
  }

  return {
    url: urlText,
    method,
    matched,
    matchedCount: matched.length,
    effectiveRules: effective,
    source: 'rule-matcher',
  };
}

// ── 响应 Diff ─────────────────────────────────────────────────────────

function normalizeHeaderMap(headers, includeSensitive) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    const rawVal = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    out[key] = !includeSensitive && isSensitiveHeader(key) ? '[REDACTED]' : rawVal;
  }
  return out;
}

function tryParseJson(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body !== 'string' || !body.trim()) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function redactValueForDiff(key, value, includeSensitive) {
  if (!includeSensitive && isSensitiveJsonKey(key)) {
    return value ? '[REDACTED]' : '';
  }
  return value;
}

function walkJsonDiff(a, b, prefix, out, includeSensitive, depth = 0) {
  if (depth > 6) return;
  if (a === b) return;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    out.changed.push({ path: prefix || '$', from: a, to: b });
    return;
  }
  if (Array.isArray(a)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i += 1) {
      const itemPath = `${prefix}[${i}]`;
      if (i >= a.length) out.added.push({ path: itemPath, value: b[i] });
      else if (i >= b.length) out.removed.push({ path: itemPath, value: a[i] });
      else walkJsonDiff(a[i], b[i], itemPath, out, includeSensitive, depth + 1);
    }
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    const hasA = Object.hasOwn(a, key);
    const hasB = Object.hasOwn(b, key);
    if (!hasA) {
      out.added.push({ path: nextPath, value: redactValueForDiff(key, b[key], includeSensitive) });
    } else if (!hasB) {
      out.removed.push({ path: nextPath, value: redactValueForDiff(key, a[key], includeSensitive) });
    } else {
      const valA = redactValueForDiff(key, a[key], includeSensitive);
      const valB = redactValueForDiff(key, b[key], includeSensitive);
      walkJsonDiff(valA, valB, nextPath, out, includeSensitive, depth + 1);
    }
  }
}

/** 对比原始响应与重放响应（状态码 / 响应头 / JSON 字段 diff）。 */
export function diffResponses(original = {}, replayed = {}, options = {}) {
  const includeSensitive = options.includeSensitive === true;
  const origStatus = original.status ?? null;
  const nextStatus = replayed.status ?? null;
  const statusChanged = origStatus !== nextStatus;

  const origHeaders = normalizeHeaderMap(original.headers, includeSensitive);
  const nextHeaders = normalizeHeaderMap(replayed.headers, includeSensitive);
  const headersDiff = { added: {}, removed: {}, changed: {} };
  for (const key of new Set([...Object.keys(origHeaders), ...Object.keys(nextHeaders)])) {
    const inOrig = Object.hasOwn(origHeaders, key);
    const inNext = Object.hasOwn(nextHeaders, key);
    if (!inOrig) headersDiff.added[key] = nextHeaders[key];
    else if (!inNext) headersDiff.removed[key] = origHeaders[key];
    else if (origHeaders[key] !== nextHeaders[key]) {
      headersDiff.changed[key] = { from: origHeaders[key], to: nextHeaders[key] };
    }
  }
  const headersChanged =
    Object.keys(headersDiff.added).length > 0 ||
    Object.keys(headersDiff.removed).length > 0 ||
    Object.keys(headersDiff.changed).length > 0;

  const origJson = tryParseJson(original.json ?? original.body);
  const nextJson = tryParseJson(replayed.json ?? replayed.body);
  let jsonDiff = null;
  let bodyChanged = false;
  if (origJson && nextJson) {
    jsonDiff = { added: [], removed: [], changed: [] };
    walkJsonDiff(origJson, nextJson, '', jsonDiff, includeSensitive);
    bodyChanged = jsonDiff.added.length > 0 || jsonDiff.removed.length > 0 || jsonDiff.changed.length > 0;
  } else {
    const origText = typeof original.body === 'string' ? original.body : JSON.stringify(original.body ?? '');
    const nextText = typeof replayed.body === 'string' ? replayed.body : JSON.stringify(replayed.body ?? '');
    bodyChanged = origText !== nextText;
  }

  return {
    changed: statusChanged || headersChanged || bodyChanged,
    statusChanged,
    statusDiff: { from: origStatus, to: nextStatus },
    headersChanged,
    headersDiff,
    bodyChanged,
    jsonDiff,
  };
}

// ── cURL 导出 ─────────────────────────────────────────────────────────

export function shellEscape(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

/** 将抓包 session 或归一化条目转为安全可执行的 curl 命令。 */
export function buildCurlCommand(session, options = {}) {
  if (!session || typeof session !== 'object') fail('BAD_REQUEST', 'buildCurlCommand 需要 session 对象');
  const includeSensitive = options.includeSensitive === true;
  const req = session.req || session.raw?.req || {};
  const url = String(session.url || '').trim();
  if (!url) fail('BAD_REQUEST', 'session 缺少 url');
  const method = String(req.method || session.method || 'GET').toUpperCase();
  const headers = req.headers || session.requestHeaders || {};

  let bodyText = '';
  if (typeof req.base64 === 'string' && req.base64) {
    bodyText = Buffer.from(req.base64, 'base64').toString('utf8');
  } else if (typeof req.body === 'string') {
    bodyText = req.body;
  } else if (session.requestBodyRaw !== undefined && session.requestBodyRaw !== '') {
    bodyText =
      typeof session.requestBodyRaw === 'object'
        ? JSON.stringify(session.requestBodyRaw)
        : String(session.requestBodyRaw);
  } else if (session.requestBody !== undefined && session.requestBody !== '') {
    bodyText =
      typeof session.requestBody === 'object' ? JSON.stringify(session.requestBody) : String(session.requestBody);
  }

  const parts = ['curl', '-X', method];
  let hasGzip = false;
  for (const [key, rawValue] of Object.entries(headers)) {
    const lower = String(key).toLowerCase();
    if (lower.startsWith(':') || lower === 'content-length') continue;
    const valStr = Array.isArray(rawValue) ? rawValue.join('; ') : String(rawValue ?? '');
    if (lower === 'accept-encoding' && /gzip/i.test(valStr)) hasGzip = true;
    const safeVal = !includeSensitive && isSensitiveHeader(lower) ? '[REDACTED]' : valStr;
    parts.push('-H', shellEscape(`${key}: ${safeVal}`));
  }
  if (bodyText) {
    parts.push('--data-raw', shellEscape(bodyText));
  }
  if (hasGzip) parts.push('--compressed');
  parts.push(shellEscape(url));
  return parts.join(' ');
}
