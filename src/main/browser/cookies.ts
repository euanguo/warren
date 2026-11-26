/**
 * Cookie 受控通道：**只搬运不返回**。
 *
 * 设计见 `docs/PLUGIN-CAPABILITY-DESIGN.md` §9。三条不能破的线：
 * 1. 返回值里永远没有 value（`summarize` 走显式字段白名单，不是 delete）；
 * 2. `import` 不回显输入；
 * 3. 错误消息里也不带值。
 *
 * 值只在主进程内部流动：`copy` 是「从一个 session 读出来 → 直接写进另一个 session」，
 * 中间那一步的值从不进返回值。
 */
import type { Session } from 'electron';
import type { CookieSummary } from '../../shared/types.ts';

export interface CookieInput {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
}

export interface CookieFilter {
  domain?: string;
  name?: string;
}

/**
 * 逐字段挑出来。
 *
 * **不能写成 `const { value, ...rest } = cookie`**：那样以后 Electron 给 cookie 加新字段
 * （比如 partitioned / sameSite 之外的东西）就会自动漏出去。白名单是唯一能一直对的做法。
 */
export function summarize(cookie: Electron.Cookie): CookieSummary {
  const summary: CookieSummary = {
    name: String(cookie.name),
    domain: String(cookie.domain),
    path: String(cookie.path ?? '/'),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    session: Boolean(cookie.session),
  };
  if (typeof cookie.expirationDate === 'number') summary.expirationDate = cookie.expirationDate;
  return summary;
}

function matches(cookie: Electron.Cookie, filter: CookieFilter): boolean {
  if (filter.name && cookie.name !== filter.name) return false;
  if (filter.domain && cookie.domain !== filter.domain) return false;
  return true;
}

export async function listCookies(session: Session, url?: string): Promise<CookieSummary[]> {
  const cookies = url ? await session.cookies.get({ url }) : await session.cookies.get({});
  return cookies.map(summarize);
}

/**
 * 环境 → 环境。**值在这一层内部从 from 读出来、直接写进 to**，只回名字和计数。
 */
export async function copyCookies(
  from: Session,
  to: Session,
  filter: CookieFilter = {},
): Promise<{ copied: number; names: string[] }> {
  const cookies = (await from.cookies.get({})).filter((cookie) => matches(cookie, filter));
  const names: string[] = [];
  for (const cookie of cookies) {
    // 不传 url，按 domain/path 落——跨源 cookie（domain=localhost）在同一个 session 里也成立
    await to.cookies.set({
      url: cookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      ...(cookie.session ? {} : { expirationDate: cookie.expirationDate }),
    });
    names.push(cookie.name);
  }
  return { copied: names.length, names };
}

export async function importCookies(
  session: Session,
  cookies: CookieInput[],
): Promise<{ written: number; names: string[] }> {
  if (!Array.isArray(cookies)) {
    throw Object.assign(new Error('cookies 必须是数组'), { code: 'BAD_REQUEST' });
  }
  const names: string[] = [];
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== 'string' || !cookie.name) {
      throw Object.assign(new Error('每一条都要有 name'), { code: 'BAD_REQUEST' });
    }
    if (typeof cookie.value !== 'string') {
      // 不把值写进错误消息
      throw Object.assign(new Error(`cookie ${cookie.name} 的 value 必须是字符串`), {
        code: 'BAD_REQUEST',
      });
    }
    await session.cookies.set({
      url: cookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? '/',
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? false,
      ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
    });
    names.push(cookie.name);
  }
  return { written: names.length, names };
}

export async function clearCookies(session: Session, filter: CookieFilter = {}): Promise<{ removed: number }> {
  const cookies = (await session.cookies.get({})).filter((cookie) => matches(cookie, filter));
  for (const cookie of cookies) {
    // remove 要 url + name，两个都不带值
    await session.cookies.remove(cookieUrl(cookie), cookie.name);
  }
  return { removed: cookies.length };
}

/**
 * Electron 的 cookies.set / remove 要一个 URL。
 *
 * 按 domain 反推 scheme：domain 是 localhost / 127.0.0.1 / IP 时用 http（fixture 就是这种），
 * 其余用 https——把 secure cookie 塞进 http URL 会被拒。
 */
export function cookieUrl(cookie: { domain?: string; path?: string; secure?: boolean }): string {
  const domain = String(cookie.domain ?? '').replace(/^\./, '');
  const host = domain || 'localhost';
  const loopback = host === 'localhost' || host.startsWith('127.') || host === '::1';
  const scheme = cookie.secure || !loopback ? 'https' : 'http';
  return `${scheme}://${host}${cookie.path && cookie.path.startsWith('/') ? cookie.path : '/'}`;
}
