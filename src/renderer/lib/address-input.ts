/**
 * 地址栏输入 → 可导航 URL。
 *
 * **刻意不做搜索引擎兜底。** 真实浏览器把裸词发给默认引擎，但 warren 是隔离身份
 * 浏览器：随手敲的词默认发给 Google 等于拿这个环境的出口去泄露身份。所以解析不出来
 * 就返回 `null`，由调用方明确提示。这是记录在案的偏离，见
 * `docs/DESKTOP-SHELL-MIGRATION.md`。
 *
 * 纯函数、无依赖——`node --test` 能直接加载。
 */

/** 只认 http/https：隔离浏览器里 file:// 之类没有意义，也不该被地址栏打开。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
/**
 * 只有 `scheme://` 才算显式协议。
 * 不能写成 `^scheme:`——那样 `localhost:8899` 会被当成 scheme 叫 localhost。
 */
const EXPLICIT_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOSTNAME_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** 本地回环走 http——本地 fixture 没有证书，补 https 只会打不开。 */
function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare.endsWith('.localhost') || bare === '127.0.0.1' || bare === '::1';
}

/** 主机部分（含端口）。没有端口时就是整个 authority。 */
function authorityOf(input: string): string {
  return input.split(/[/?#]/, 1)[0] ?? '';
}

function hostnameOf(authority: string): string {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end === -1 ? authority : authority.slice(0, end + 1);
  }
  return authority.split(':', 1)[0] ?? '';
}

/**
 * 解析地址栏输入。返回 `null` 表示「这不是一个地址」——不要拿它去搜索。
 */
export function resolveAddressInput(raw: string): string | null {
  const input = raw.trim();
  if (input.length === 0) return null;

  // 已经带协议：只放行 http/https
  if (EXPLICIT_SCHEME_PATTERN.test(input)) {
    try {
      const url = new URL(input);
      return ALLOWED_PROTOCOLS.has(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  }

  const authority = authorityOf(input);
  if (authority.length === 0) return null;
  const host = hostnameOf(authority);
  const looksLikeHost = IPV4_PATTERN.test(host) || HOSTNAME_PATTERN.test(host) || isLocalHost(host);
  if (!looksLikeHost) return null;

  const scheme = isLocalHost(host) ? 'http://' : 'https://';
  try {
    return new URL(`${scheme}${input}`).toString();
  } catch {
    return null;
  }
}

export type AddressSecurity = 'secure' | 'insecure' | 'none';

/** omnibox 左侧图标的三态来源。 */
export function addressSecurity(url: string): AddressSecurity {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === 'https:') return 'secure';
    if (protocol === 'http:') return 'insecure';
  } catch {
    return 'none';
  }
  return 'none';
}
