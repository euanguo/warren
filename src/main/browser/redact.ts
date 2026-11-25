/**
 * 凭据脱敏。**叶子模块，不 import 任何东西** —— 网络层（`net/ops.ts`）也要用它，
 * 而那条路径必须能被 `node --test` 直接加载（不能拖进 electron）。
 *
 * 词表是**保守**的：宁可多脱一点，也不能把凭据写进日志/返回值。
 * key 命中敏感词的值替换 `[REDACTED]`（深拷贝递归，不改原对象）。
 */
/** 敏感 key 的词表。`redactSecrets` 和 URL query 脱敏共用一张表，别各写一份。 */
const SENSITIVE_KEY = /password|passwd|secret|token|api[_-]?key|cookie|session/i;

/** 这个 key 是不是敏感词。 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
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
