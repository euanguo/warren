/**
 * URL matcher：字符串=子串；`{regex}`；`{glob}`（`*` 通配）。
 * 纯函数，可单测。
 */
export type UrlMatcherInput = string | { regex: string } | { glob: string };

/** glob（`*` 任意字符、`?` 单字符）→ 全匹配正则。网络拦截规则也用它。 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function matchUrl(url: string, matcher: UrlMatcherInput): boolean {
  if (typeof matcher === 'string') return url.includes(matcher);
  if (matcher && typeof matcher === 'object') {
    if (typeof (matcher as { regex?: unknown }).regex === 'string') {
      return new RegExp((matcher as { regex: string }).regex).test(url);
    }
    if (typeof (matcher as { glob?: unknown }).glob === 'string') {
      return globToRegExp((matcher as { glob: string }).glob).test(url);
    }
  }
  throw Object.assign(new Error(`matcher 非法: ${JSON.stringify(matcher)}`), {
    code: 'BAD_REQUEST',
  });
}

/** readyState 判定：`loading` 之外都算 domcontentloaded 已过。 */
export function readyStateAtLeast(state: string, want: 'domcontentloaded' | 'load' | 'complete'): boolean {
  const order = ['loading', 'interactive', 'complete'];
  const at = order.indexOf(state);
  if (at < 0) return false;
  if (want === 'domcontentloaded') return at >= 1;
  return at >= 2;
}
