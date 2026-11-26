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
  method: 'GET';
  url: string;
  status: number;
  resourceType: string;
  suggestedTemplate: string;
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
 * 执行一条只读 Saved Flow：在页面上下文内发 GET `fetch`（复用当前环境 Session），
 * 解析 JSON 并应用 `extractPath` / `--where` / `--fields` / `--limit` 及字段漂移检测。
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
    if (options.where && Object.keys(options.where).length > 0) {
      rows = rows.filter((item) => {
        if (!item || typeof item !== 'object') return false;
        const rec = item as Record<string, unknown>;
        return Object.entries(options.where!).every(([k, want]) => {
          const actual = getByPath(rec, k);
          return String(actual ?? '').toLowerCase() === want.toLowerCase();
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
