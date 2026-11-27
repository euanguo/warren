/**
 * 只读参数化 Saved Flows（对标 Ardia Flows，但严格守住 Warren 安全底线）：
 * - **只允许 `GET` 请求**，绝不允许保存写接口（POST/PUT/DELETE/PATCH）；
 * - 落库前强力剥离一切认证/敏感请求头（`Cookie`、`Authorization`、`X-API-Key`、`Token` 等），
 *   并复用敏感词校验拒绝任何凭据明文；
 * - 运行时在目标浏览器上下文内执行同站 `fetch`（自动复用该环境自身隔离 Session 登录态，不落盘 Cookie）；
 * - 支持 `{{param}}` 模板插值（URL 编码防注入）、`--fields` 字段投影、`--where k=v` 过滤、
 *   `--limit N` 截断与字段漂移告警（`schemaDrift`）。
 */
import type { FetchResult, NetworkEntry, SavedFlowRecord, SavedFlowSpec } from '../../../shared/types.ts';
import { richErr } from '../errors.ts';
import { isSensitiveHeader, isSensitiveKey } from '../redact.ts';

const SECRET_VALUE_RE = /(?:bearer\s+[a-z0-9._-]{12,}|sk-[a-z0-9]{16,}|ghp_[a-z0-9]{20,}|password\s*[:=]\s*\S+)/i;

export interface FlowStepCandidate {
  ref?: string;
  stepId?: string;
  stepLabel?: string;
  method: 'GET';
  url: string;
  status: number;
  resourceType: string;
  suggestedTemplate: string;
  matchedParams?: Array<{ param: string; value: string; sourceStepId: string }>;
}

/** 校验并清洗 Flow 名称（仅允许小写字母、数字、点、下划线、连字符）。 */
export function normalizeFlowName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    throw richErr('BAD_REQUEST', `非法 flow 名称：${raw}（只允许小写字母、数字、点、下划线、连字符）`);
  }
  return name;
}

/** 校验并净化 SavedFlowSpec：强约束只读 GET + 无敏感头/明文凭据。 */
export function sanitizeFlowSpec(input: Partial<SavedFlowSpec>): { site: string; spec: SavedFlowSpec } {
  const method = String(input.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    throw richErr('BAD_REQUEST', `安全约束：Saved Flow 仅允许只读 GET 请求，拒绝 ${method}`);
  }
  const urlTemplate = String(input.urlTemplate ?? '').trim();
  if (!urlTemplate) throw richErr('BAD_REQUEST', 'Saved Flow 缺少 urlTemplate');
  if (SECRET_VALUE_RE.test(urlTemplate)) {
    throw richErr('BAD_REQUEST', 'Saved Flow 的 urlTemplate 包含疑似凭据明文，已拒绝保存');
  }
  let parsed: URL;
  try {
    // 把 {{param}} 替换成合法占位值来校验 URL 结构
    parsed = new URL(urlTemplate.replace(/\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g, 'placeholder'));
  } catch {
    throw richErr('BAD_REQUEST', `urlTemplate 不是合法的 http/https URL：${urlTemplate}`);
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw richErr('BAD_REQUEST', `Saved Flow 只允许 http/https 协议，拒绝 ${parsed.protocol}`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveHeader(key) || isSensitiveKey(key)) {
      throw richErr('BAD_REQUEST', `Saved Flow 的 urlTemplate 包含敏感查询参数 ${key}，已拒绝保存`);
    }
  }

  const safeHeaders: Record<string, string> = {};
  if (input.headers && typeof input.headers === 'object') {
    for (const [k, v] of Object.entries(input.headers)) {
      const key = k.trim();
      if (!key || isSensitiveHeader(key) || isSensitiveKey(key)) continue;
      const val = String(v ?? '');
      if (SECRET_VALUE_RE.test(val)) continue;
      safeHeaders[key] = val;
    }
  }

  const fields = Array.isArray(input.fields)
    ? input.fields
        .map((f) => String(f).trim())
        .filter(Boolean)
        .slice(0, 50)
    : undefined;
  const description = input.description ? String(input.description).trim().slice(0, 200) : undefined;
  if (description && SECRET_VALUE_RE.test(description)) {
    throw richErr('BAD_REQUEST', 'Saved Flow 的 description 包含疑似凭据明文，已拒绝保存');
  }

  return {
    site: parsed.host.toLowerCase(),
    spec: {
      method: 'GET',
      urlTemplate,
      ...(Object.keys(safeHeaders).length > 0 ? { headers: safeHeaders } : {}),
      ...(input.extractPath ? { extractPath: String(input.extractPath).trim() } : {}),
      ...(fields && fields.length > 0 ? { fields } : {}),
      ...(description ? { description } : {}),
    },
  };
}

/** 渲染 `urlTemplate` 中的 `{{key}}` 占位符，做严格 URL 编码并阻止路径穿越。 */
export function renderFlowUrl(urlTemplate: string, params: Record<string, string> = {}): string {
  const missing: string[] = [];
  const rendered = urlTemplate.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key: string) => {
    const val = params[key];
    if (val === undefined) {
      missing.push(key);
      return '';
    }
    const raw = String(val);
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    if (
      raw === '.' ||
      raw === '..' ||
      decoded === '.' ||
      decoded === '..' ||
      /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(decoded)
    ) {
      throw richErr('BAD_REQUEST', `Flow 参数 ${key} 包含非法路径段: ${raw}`);
    }
    return encodeURIComponent(raw);
  });
  if (missing.length > 0) {
    throw richErr('BAD_REQUEST', `Flow 缺少必填参数：${missing.join(', ')}（请通过 --param key=val 传入）`);
  }
  try {
    const u = new URL(rendered);
    if (u.pathname.split('/').some((seg) => seg === '..' || seg === '%2e%2e' || seg.toLowerCase() === '%2e%2e')) {
      throw richErr('BAD_REQUEST', 'Flow 渲染后 URL 包含非法 .. 路径段');
    }
  } catch (e) {
    if ((e as { code?: string }).code === 'BAD_REQUEST') throw e;
  }
  return rendered;
}

/** 从当前环境的遥测请求流中筛选出适合做成只读 Flow 的 GET API 候选（去重 + 参数化建议）。 */
export function extractFlowCandidates(entries: readonly NetworkEntry[]): FlowStepCandidate[] {
  const out: FlowStepCandidate[] = [];
  const seen = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.method.toUpperCase() !== 'GET') continue;
    if (e.status < 200 || e.status >= 300) continue;
    if (!/xhr|fetch|other/i.test(e.resourceType || 'xhr')) continue;
    if (/\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ico|map)(\?|$)/i.test(e.url)) continue;
    let u: URL;
    try {
      u = new URL(e.url);
    } catch {
      continue;
    }
    const baseKey = `${u.origin}${u.pathname}`;
    if (seen.has(baseKey)) continue;
    seen.add(baseKey);

    // 将查询参数值转成 {{key}} 建议模板（跳过疑似敏感 token 参数）
    const suggested = new URL(baseKey);
    for (const [k] of u.searchParams) {
      if (/token|key|secret|auth|sig|sign/i.test(k)) continue;
      suggested.searchParams.set(k, `{{${k}}}`);
    }
    out.push({
      method: 'GET',
      url: e.url,
      status: e.status,
      resourceType: e.resourceType,
      suggestedTemplate: decodeURIComponent(suggested.toString()),
    });
    if (out.length >= 25) break;
  }
  return out;
}

/** 按点分路径提取嵌套字段（如 `data.items`）。 */
export function getByPath(obj: unknown, dotPath?: string): unknown {
  if (!dotPath || !dotPath.trim()) return obj;
  let cur: unknown = obj;
  for (const part of dotPath.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export interface RunFlowOptions {
  params?: Record<string, string>;
  fields?: string[];
  where?: Record<string, string>;
  limit?: number;
}

export interface RunFlowResult {
  flow: string;
  url: string;
  status: number;
  count: number;
  rows: unknown;
  schemaDrift?: { missingFields: string[]; message: string };
}

/**
 * 从示例 JSON 响应体自动推断最显著的记录数组路径 `extractPath` 与前 12 个标量字段 `fields`。
 */
export function inferFlowSchema(payload: unknown): { extractPath?: string; fields?: string[] } {
  const pickScalarFields = (sample: Record<string, unknown>): string[] =>
    Object.entries(sample)
      .filter(([, v]) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .map(([k]) => k)
      .slice(0, 12);

  if (Array.isArray(payload)) {
    const first = payload.find((it) => it && typeof it === 'object' && !Array.isArray(it)) as
      Record<string, unknown> | undefined;
    return first ? { fields: pickScalarFields(first) } : {};
  }
  if (!payload || typeof payload !== 'object') return {};

  let best: { path: string; rows: Record<string, unknown>[] } | null = null;
  const walk = (node: unknown, prefix: string, depth: number) => {
    if (depth > 4 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const objs = node.filter((it): it is Record<string, unknown> =>
        Boolean(it && typeof it === 'object' && !Array.isArray(it)),
      );
      if (objs.length > 0 && (!best || objs.length > best.rows.length)) {
        best = { path: prefix, rows: objs };
      }
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, prefix ? `${prefix}.${k}` : k, depth + 1);
    }
  };
  walk(payload, '', 0);
  if (!best) return {};
  const found = best as { path: string; rows: Record<string, unknown>[] };
  const fields = found.rows[0] ? pickScalarFields(found.rows[0]) : undefined;
  return {
    ...(found.path ? { extractPath: found.path } : {}),
    ...(fields && fields.length > 0 ? { fields } : {}),
  };
}

/**
 * 零手写模板保存：基于已录制的只读 GET 请求（如 `s3r1`）与用户指定的 `--param key=sampleValue`
 * 自动把 URL 中的查询参数/字面量值参数化为 `{{key}}`，并结合响应样本自动推断 `extractPath`/`fields`。
 */
export function buildFlowSpecFromRecordedRequest(
  recordedUrl: string,
  options: {
    params?: Record<string, string>;
    extractPath?: string;
    fields?: string[];
    description?: string;
    sampleBody?: string;
  } = {},
): { site: string; spec: SavedFlowSpec } {
  let u: URL;
  try {
    u = new URL(recordedUrl);
  } catch {
    throw richErr('BAD_REQUEST', `录制的请求 URL 非法：${recordedUrl}`);
  }
  const templateUrl = new URL(`${u.origin}${u.pathname}`);
  const explicitParams = options.params ?? {};

  const matchedExplicit = new Set<string>();
  for (const [k, v] of u.searchParams) {
    if (isSensitiveHeader(k) || isSensitiveKey(k)) continue;
    let placeholderName: string | undefined;
    if (k in explicitParams) {
      placeholderName = k;
      matchedExplicit.add(k);
    } else {
      for (const [pName, pSample] of Object.entries(explicitParams)) {
        if (pSample && v.toLowerCase() === pSample.toLowerCase()) {
          placeholderName = pName;
          matchedExplicit.add(pName);
          break;
        }
      }
    }
    templateUrl.searchParams.set(k, placeholderName ? `{{${placeholderName}}}` : v);
  }

  let urlTemplate = decodeURIComponent(templateUrl.toString());
  for (const [pName, pSample] of Object.entries(explicitParams)) {
    if (matchedExplicit.has(pName) || !pSample) continue;
    const escaped = pSample.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const segRe = new RegExp(`(?<=/)${escaped}(?=/|$|\\?)`);
    if (segRe.test(urlTemplate)) {
      urlTemplate = urlTemplate.replace(segRe, `{{${pName}}}`);
      matchedExplicit.add(pName);
    }
  }

  let inferred: { extractPath?: string; fields?: string[] } = {};
  if (options.sampleBody) {
    try {
      inferred = inferFlowSchema(JSON.parse(options.sampleBody));
    } catch {
      inferred = {};
    }
  }

  return sanitizeFlowSpec({
    method: 'GET',
    urlTemplate,
    extractPath: options.extractPath ?? inferred.extractPath,
    fields: options.fields && options.fields.length > 0 ? options.fields : inferred.fields,
    description: options.description,
  });
}

function collectRowKeys(rows: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const item of rows.slice(0, 10)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const k of Object.keys(item as Record<string, unknown>)) keys.add(k);
    }
  }
  return [...keys];
}

/**
 * 执行一条只读 Saved Flow：在页面或环境 Session 内发 GET `fetch`（复用隔离登录态），
 * 解析 JSON 并应用状态码分类（401/403/429）、`extractPath`、宽容子串/精确 `--where`、
 * 字段合法性校验、`--fields` 投影、`--limit` 截断及字段漂移检测。
 */
export async function executeSavedFlow(
  record: SavedFlowRecord,
  fetcher: (url: string, opts: { method: 'GET'; headers?: Record<string, string> }) => Promise<FetchResult>,
  options: RunFlowOptions = {},
): Promise<RunFlowResult> {
  const url = renderFlowUrl(record.spec.urlTemplate, options.params);
  const res = await fetcher(url, {
    method: 'GET',
    ...(record.spec.headers ? { headers: record.spec.headers } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw richErr(
      'FLOW_AUTH_EXPIRED',
      `Flow "${record.name}" 鉴权失败（HTTP ${res.status}），请先在目标环境重新登录 ${record.site} 后重试`,
    );
  }
  if (res.status === 429) {
    throw richErr('FLOW_RATE_LIMITED', `Flow "${record.name}" 触发站点限流（HTTP 429），请稍后降频重试`);
  }
  if (res.status >= 400 || res.status === 0) {
    throw richErr('FLOW_HTTP_ERROR', `Flow "${record.name}" 请求失败（HTTP ${res.status} ${res.statusText || ''}）`);
  }

  let payload: unknown = res.body ?? '';
  if (typeof res.body === 'string') {
    try {
      payload = JSON.parse(res.body);
    } catch {
      payload = res.body;
    }
  }
  const extracted = getByPath(payload, record.spec.extractPath);
  const targetFields = options.fields && options.fields.length > 0 ? options.fields : record.spec.fields;

  if (Array.isArray(extracted)) {
    let rows: unknown[] = extracted;
    if (options.where && Object.keys(options.where).length > 0 && rows.length > 0) {
      const availableKeys = collectRowKeys(rows);
      for (const rawKey of Object.keys(options.where)) {
        const key = rawKey.endsWith('=') ? rawKey.slice(0, -1).trim() : rawKey.trim();
        const rootField = key.split('.')[0]!;
        if (availableKeys.length > 0 && !availableKeys.includes(rootField)) {
          throw richErr(
            'FLOW_UNKNOWN_FIELD',
            `Flow "${record.name}" 中不存在过滤字段 "${key}"；可用字段：${availableKeys.slice(0, 20).join(', ')}`,
          );
        }
      }
      rows = rows.filter((item) => {
        if (!item || typeof item !== 'object') return false;
        const rec = item as Record<string, unknown>;
        return Object.entries(options.where!).every(([rawKey, want]) => {
          const exact = rawKey.endsWith('=');
          const key = exact ? rawKey.slice(0, -1).trim() : rawKey.trim();
          const actual = String(getByPath(rec, key) ?? '').toLowerCase();
          const needle = String(want ?? '').toLowerCase();
          return exact ? actual === needle : actual.includes(needle);
        });
      });
    }
    if (options.limit && options.limit > 0) {
      rows = rows.slice(0, options.limit);
    }

    let schemaDrift: RunFlowResult['schemaDrift'];
    if (targetFields && targetFields.length > 0 && rows.length > 0) {
      const sample = rows[0];
      if (sample && typeof sample === 'object') {
        const missingFields = targetFields.filter((f) => getByPath(sample, f) === undefined);
        if (missingFields.length > 0) {
          schemaDrift = {
            missingFields,
            message: `检测到接口结构漂移，缺失预期字段：${missingFields.join(', ')}`,
          };
        }
      }
      rows = rows.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const projected: Record<string, unknown> = {};
        for (const f of targetFields) projected[f] = getByPath(item, f);
        return projected;
      });
    }

    return {
      flow: record.name,
      url,
      status: res.status,
      count: rows.length,
      rows,
      ...(schemaDrift ? { schemaDrift } : {}),
    };
  }

  return {
    flow: record.name,
    url,
    status: res.status,
    count: extracted === undefined ? 0 : 1,
    rows: extracted ?? null,
  };
}
