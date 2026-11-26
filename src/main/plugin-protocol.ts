/**
 * 插件前端自定义协议 `warren-plugin://` 注册与目录缓存。
 *
 * 将原本每次请求都全量扫描 `plugins.list()` 的实现改为按需缓存 + 变更失效，
 * 消除多模块 ESM 加载时的重复主进程元数据序列化开销。
 */
import type { Protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginHost } from './plugins/host.ts';

interface CachedPluginEntry {
  enabled: boolean;
  dir: string;
  app?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
};

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
          next.set(item.id, { enabled: item.enabled, dir: item.dir, app: item.app });
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
      const root = path.resolve(plugin.dir);
      const target = path.resolve(root, relative || plugin.app || '');
      if (!target.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
      try {
        const body = await readFile(target);
        return new Response(body, {
          headers: {
            'content-type': MIME_TYPES[path.extname(target)] ?? 'application/octet-stream',
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
            // 渲染层在 http://localhost:5173（开发）或 file://（打包），跨源加载插件模块必须显式放行 CORS
            'access-control-allow-origin': '*',
          },
        });
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
