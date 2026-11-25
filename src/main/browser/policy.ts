/**
 * CDP 白名单 / 路径护栏 / fetch 凭据默认。纯函数，可单测。
 *
 * `page.cdp` 选的是发送会话，不缩小作用域（Ego clearing-state 同款警告）——
 * 所以整 profile 级的方法一律禁掉，只给单 origin 版。
 */
import path from 'node:path';
import { warrenHome } from '../paths.ts';

/** 允许的 CDP 域。域外一切方法直接 CDP_BLOCKED。 */
const ALLOWED_DOMAINS = new Set(['Page', 'Runtime', 'DOM', 'Accessibility', 'Input', 'Emulation', 'Overlay']);

/** 域内也要禁的方法。 */
const DENIED_METHODS = new Set([
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
  'Storage.clearCookies', // 无 scope 版会清整 profile；单 origin 版走 clearDataForOrigin
  'Storage.clearDataForOrigin', // 必须走 RPC（带 origin 校验），不许 raw cdp
]);

export function checkCdpAllowed(method: string): void {
  if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) {
    throw Object.assign(new Error(`CDP_BLOCKED 非法方法名: ${method}`), { code: 'CDP_BLOCKED' });
  }
  const [domain] = method.split('.');
  // Browser.* / Target.* 全体禁掉：先紧后松（连 getVersion 这种只读也不放）
  if (domain === 'Browser' || domain === 'Target') {
    throw Object.assign(new Error(`CDP_BLOCKED ${method}（Browser/Target 域不开放）`), {
      code: 'CDP_BLOCKED',
    });
  }
  if (!ALLOWED_DOMAINS.has(domain)) {
    throw Object.assign(new Error(`CDP_BLOCKED ${method}（域未开放）`), { code: 'CDP_BLOCKED' });
  }
  if (DENIED_METHODS.has(method)) {
    throw Object.assign(new Error(`CDP_BLOCKED ${method}（整 profile 级操作不开放）`), {
      code: 'CDP_BLOCKED',
    });
  }
  // Network.* / Storage.* 不在 ALLOWED 里，上面的域检查已拦；这里兜底防以后放宽域时漏网
}

/** 写下载/上传目标路径的护栏。返回净化后的绝对路径。 */
export function guardSavePath(input: string, _kind: 'saveAs' | 'setInputFiles'): string {
  if (typeof input !== 'string' || !input) {
    throw Object.assign(new Error(`PATH_DENIED 空路径`), { code: 'PATH_DENIED' });
  }
  if (!path.isAbsolute(input)) {
    throw Object.assign(new Error(`PATH_DENIED 须绝对路径: ${input}`), { code: 'PATH_DENIED' });
  }
  const normalized = path.normalize(input);
  // 数据根（默认 ~/.warren，WARREN_HOME 可覆盖）：整个根都护住，不只是根目录本身
  const dataRoot = warrenHome();
  if (normalized === dataRoot || normalized.startsWith(dataRoot + path.sep)) {
    throw Object.assign(new Error(`PATH_DENIED 禁止写入 ${dataRoot} 数据目录`), {
      code: 'PATH_DENIED',
    });
  }
  // core/ 数据目录：app.getPath('userData')/core，按常见位置护栏
  if (normalized.includes(`${path.sep}core${path.sep}`) && /warren/i.test(normalized)) {
    throw Object.assign(new Error(`PATH_DENIED 禁止写入 core 数据目录`), { code: 'PATH_DENIED' });
  }
  const SYS_DIRS = ['/etc/', '/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/', '/System/', '/private/etc/'];
  if (process.platform !== 'win32') {
    for (const d of SYS_DIRS) {
      if (normalized === d.slice(0, -1) || normalized.startsWith(d)) {
        throw Object.assign(new Error(`PATH_DENIED 禁止写入系统目录: ${input}`), {
          code: 'PATH_DENIED',
        });
      }
    }
  }
  return normalized;
}

/** 同站判断：fetch 缺省同站 include、跨站 omit。 */
export function isSameOrigin(pageUrl: string, target: string): boolean {
  try {
    const a = new URL(pageUrl);
    const b = new URL(target, pageUrl);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

export function defaultCredentials(pageUrl: string, target: string, explicit?: 'omit' | 'include'): 'omit' | 'include' {
  if (explicit === 'omit' || explicit === 'include') return explicit;
  return isSameOrigin(pageUrl, target) ? 'include' : 'omit';
}

/** 上传文件必须存在、可读、非目录。调用方在 main 里做 fs 检查，这里只做形状校验。 */
export function checkInputFiles(paths: unknown): string[] {
  const list = Array.isArray(paths) ? paths : [paths];
  if (list.length === 0 || list.some((p) => typeof p !== 'string' || !p)) {
    throw Object.assign(new Error('PATH_DENIED 文件路径非法'), { code: 'PATH_DENIED' });
  }
  for (const p of list as string[]) guardSavePath(p, 'setInputFiles');
  return list as string[];
}

/** 下载文件名消毒：只留 basename，去掉路径穿越。 */
export function sanitizeFilename(name: string): string {
  const base = path
    .basename(String(name || 'download'))
    .replace(/[^\w.\-()[\]{} ]+/g, '_')
    .slice(0, 128);
  return base || 'download';
}

/**
 * `vault.fill` 的域名名单（抄 Browser Use `secret_bindings.allowedDomains`）：
 * 裸 host，子域继承（`example.com` 放行 `a.example.com`）。不传名单 = 不限。
 */
export function hostAllowed(host: string, domains?: string[]): boolean {
  if (!domains || domains.length === 0) return true;
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return domains.some((raw) => {
    const d = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/^\./, '');
    if (!d) return false;
    return h === d || h.endsWith(`.${d}`);
  });
}
