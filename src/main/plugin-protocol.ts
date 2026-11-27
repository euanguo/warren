/**
 * 插件前端自定义协议 `warren-plugin://` 注册与目录缓存。
 *
 * 将原本每次请求都全量扫描 `plugins.list()` 的实现改为按需缓存 + 变更失效，
 * 消除多模块 ESM 加载时的重复主进程元数据序列化开销。
 */
import type { Protocol } from 'electron';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PluginHost } from './plugins/host.ts';

interface CachedPluginEntry {
  enabled: boolean;
  dir: string;
  app?: string;
  server?: string;
  host?: string;
}

/** 仅放行前端模块与静态资源，严禁暴露 HTML、数据库文件或服务端源码。 */
const MIME_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const BLOCKED_BASENAMES = new Set(['package.json', 'package-lock.json', 'data.db', 'data.db-wal', 'data.db-shm']);

const BLOCKED_EXTS = new Set(['.db', '.sqlite', '.sqlite3', '.db-wal', '.db-shm', '.html', '.htm']);

export function isBlockedPluginAssetPath(
  relativePath: string,
  plugin: Pick<CachedPluginEntry, 'server' | 'host'>,
): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return true;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((seg) => seg === '..' || seg === '.' || seg === 'node_modules' || seg.startsWith('.'))) {
    return true;
  }
  const base = segments[segments.length - 1]!.toLowerCase();
  if (BLOCKED_BASENAMES.has(base)) return true;
  if (/\.(db|sqlite|sqlite3)(-wal|-shm)?$/i.test(base)) return true;
  const ext = path.extname(base).toLowerCase();
  if (BLOCKED_EXTS.has(ext) || !MIME_TYPES[ext]) return true;
  for (const backend of [plugin.server, plugin.host]) {
    if (!backend) continue;
    const backendNorm = backend.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (backendNorm && normalized === backendNorm) return true;
  }
  return false;
}

function allowedCorsOrigin(request: Request): string | undefined {
  const origin = request.headers.get('origin');
  if (!origin) return undefined;
  if (origin === 'null' || origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173') {
    return origin;
  }
  return undefined;
}

export function registerPluginProtocol(options: { protocol: Protocol; getPlugins: () => PluginHost | undefined }): {
  invalidate: () => void;
} {
  let cache: Map<string, CachedPluginEntry> | undefined;
  let pendingLoad: Promise<Map<string, CachedPluginEntry>> | undefined;

  const invalidate = (): void => {
    cache = undefined;
    pendingLoad = undefined;
  };

  const resolveEntry = async (id: string): Promise<CachedPluginEntry | undefined> => {
    if (cache) return cache.get(id);
    if (!pendingLoad) {
      pendingLoad = (async () => {
        const host = options.getPlugins();
        const list = host ? await host.list() : [];
        const next = new Map<string, CachedPluginEntry>();
        for (const item of list) {
          next.set(item.id, {
            enabled: item.enabled,
            dir: item.dir,
            app: item.app,
            server: item.server,
            host: item.host,
          });
        }
        cache = next;
        pendingLoad = undefined;
        return next;
      })();
    }
    const map = await pendingLoad;
    return map.get(id);
  };

  options.protocol.handle('warren-plugin', async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.hostname;
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const plugin = await resolveEntry(id);
      if (!plugin || !plugin.enabled) return new Response('plugin not loaded', { status: 404 });
      const requested = relative || plugin.app || '';
      if (isBlockedPluginAssetPath(requested, plugin)) {
        return new Response('forbidden', { status: 403 });
      }
      const root = path.resolve(plugin.dir);
      const target = path.resolve(root, requested);
      if (!target.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
      try {
        const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
        if (!realTarget.startsWith(realRoot + path.sep)) return new Response('forbidden', { status: 403 });
        const info = await stat(realTarget);
        if (!info.isFile()) return new Response('forbidden', { status: 403 });
        const ext = path.extname(realTarget).toLowerCase();
        const contentType = MIME_TYPES[ext];
        if (!contentType) return new Response('forbidden', { status: 403 });
        const body = await readFile(realTarget);
        const corsOrigin = allowedCorsOrigin(request);
        const headers: Record<string, string> = {
          'content-type': contentType,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          vary: 'Origin',
        };
        if (corsOrigin) headers['access-control-allow-origin'] = corsOrigin;
        return new Response(body, { headers });
      } catch {
        return new Response('not found', { status: 404 });
      }
    } catch (error) {
      console.error('[plugin-protocol] failed', request.url, error);
      return new Response(String(error), { status: 500 });
    }
  });

  return { invalidate };
}
