/**
 * 打包壳层专用自定义协议 `warren-app://shell/...`：
 *
 * 当 Electron Fuse `GrantFileProtocolExtraPrivileges: false` 生效时，`file://` 会退回裸 OS 文件加载器，
 * 无法读取 `app.asar` 内的静态资源且会阻断 `<script type="module" crossorigin>` 与动态 `import()`。
 * 通过受限自定义安全协议从打包目录（含 ASAR）提供渲染层静态资源，既保留全部 7 项安全 Fuse，
 * 又为渲染壳层与插件模块加载提供稳定的安全源（`warren-app://shell`）。
 */
import type { Protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const APP_PROTOCOL_SCHEME = 'warren-app';
export const APP_PROTOCOL_HOST = 'shell';
export const APP_PROTOCOL_ORIGIN = `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** 构造壳层页面 URL（支持 `?surface=overlay` / `?surface=popover`）。 */
export function appShellUrl(surface?: 'overlay' | 'popover'): string {
  return surface ? `${APP_PROTOCOL_ORIGIN}/index.html?surface=${surface}` : `${APP_PROTOCOL_ORIGIN}/index.html`;
}

/** 将 `warren-app://shell/...` 解析为受限于 `rootDir` 的目标文件路径；越界或非法请求返回 null。 */
export function resolveAppAssetPath(
  requestUrl: string,
  rootDir: string,
): { filePath: string; contentType: string } | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_PROTOCOL_SCHEME}:` || url.hostname !== APP_PROTOCOL_HOST) return null;

  // 在 WHATWG URL 自动折叠 `..` 之前拦截原始路径中的穿越尝试（含 %2e 编码）
  const rawAfterOrigin = requestUrl.slice(APP_PROTOCOL_ORIGIN.length).split(/[?#]/, 1)[0] ?? '';
  if (/(?:^|\/)(?:\.\.|%2e%2e|\.%2e|%2e\.)(?:\/|$)/i.test(rawAfterOrigin)) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;

  const trimmed = pathname.replace(/^\/+/, '') || 'index.html';
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((seg) => seg === '.' || seg === '..' || seg.startsWith('.'))) {
    return null;
  }

  const normalizedRoot = path.resolve(rootDir);
  const resolved = path.resolve(normalizedRoot, ...segments);
  if (!resolved.startsWith(normalizedRoot + path.sep)) return null;

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext];
  if (!contentType) return null;

  return { filePath: resolved, contentType };
}

export function registerAppProtocol(options: { protocol: Protocol; rootDir: string }): void {
  const rootDir = path.resolve(options.rootDir);

  options.protocol.handle(APP_PROTOCOL_SCHEME, async (request) => {
    const resolved = resolveAppAssetPath(request.url, rootDir);
    if (!resolved) return new Response('forbidden', { status: 403 });

    try {
      const body = await readFile(resolved.filePath);
      const headers: Record<string, string> = {
        'content-type': resolved.contentType,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      };
      if (request.headers.get('origin') === APP_PROTOCOL_ORIGIN) {
        headers['access-control-allow-origin'] = APP_PROTOCOL_ORIGIN;
        headers.vary = 'Origin';
      }
      return new Response(body, { headers });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}
