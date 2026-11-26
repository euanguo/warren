/**
 * 凭据脱敏。**叶子模块，不 import 任何东西** —— 网络层（`net/ops.ts`）也要用它，
 * 而那条路径必须能被 `node --test` 直接加载（不能拖进 electron）。
 *
 * 词表是**保守**的：宁可多脱一点，也不能把凭据写进日志/返回值。
 * key 命中敏感词的值替换 `[REDACTED]`（深拷贝递归，不改原对象）。
 */
/** 敏感 key 的词表。`redactSecrets` 和 URL query 脱敏共用一张表，别各写一份。 */
const SENSITIVE_KEY = /password|passwd|secret|token|api[_-]?key|cookie|session|authorization/i;
const SENSITIVE_HEADER_RE =
  /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i;

/** 这个 key 是不是敏感词。 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** 是否为必须脱敏/剥离的认证或会话类 HTTP 头。 */
export function isSensitiveHeader(key: string): boolean {
  return SENSITIVE_HEADER_RE.test(key.trim()) || isSensitiveKey(key);
}

/** 将 HTTP Headers 或头映射对象原地复制并脱敏所有敏感请求/响应头。 */
export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const plain: Record<string, string> = {};
  if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, key) => {
      plain[key] = value;
    });
  } else {
    for (const [key, value] of Object.entries(headers as Record<string, string>)) {
      plain[key] = value;
    }
  }
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(plain)) {
    redacted[key] = isSensitiveHeader(key) ? '[REDACTED]' : value;
  }
  return redacted;
}

/** 将 URL 的认证信息及敏感 query 参数值替换为 `[REDACTED]`。 */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    let hit = false;
    if (url.password) {
      url.password = '[REDACTED]';
      hit = true;
    }
    for (const [key] of [...url.searchParams]) {
      if (isSensitiveKey(key) || isSensitiveHeader(key)) {
        url.searchParams.set(key, '[REDACTED]');
        hit = true;
      }
    }
    return hit ? url.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
}

export function redactSecrets<T>(value: T): { value: T; redacted: boolean } {
  const hit = SENSITIVE_KEY;
  let redacted = false;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (hit.test(k)) {
          redacted = true;
          out[k] = '[REDACTED]';
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, redacted };
}
