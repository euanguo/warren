/**
 * HAR 1.2 的最小实现：只存「回放要用得上的字段」（method / url / status / 响应体）。
 *
 * **纯函数，不碰 fs**——读写文件在 `environments.ts`，这样转换逻辑能直接单测。
 * 头一律不写进 HAR：`cookie` / `authorization` 是凭据，落盘就是新的泄漏面
 * （回放只需要响应，不需要请求头）。
 */
import { escapeRegExp } from './rules.ts';
import type { NetRule } from '../../shared/types';

export interface HarEntry {
  at: string;
  method: string;
  url: string;
  status: number;
  contentType?: string;
  /** 只记文本类响应体；没有就不写（回放时跳过这条）。 */
  body?: string;
}

function bad(message: string): Error {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST' });
}

export function toHarDocument(entries: HarEntry[]): unknown {
  return {
    log: {
      version: '1.2',
      creator: { name: 'warren', version: '0.1.0' },
      entries: entries.map((entry) => ({
        startedDateTime: entry.at,
        time: 0,
        request: {
          method: entry.method,
          url: entry.url,
          httpVersion: 'HTTP/1.1',
          headers: [],
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: -1,
        },
        response: {
          status: entry.status,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          headers: [],
          cookies: [],
          content: {
            size: entry.body?.length ?? 0,
            mimeType: entry.contentType ?? 'application/octet-stream',
            ...(entry.body === undefined ? {} : { text: entry.body }),
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: entry.body?.length ?? 0,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      })),
    },
  };
}

/**
 * HAR → 规则（回放）。
 *
 * URL 用**正则精确匹配**：glob 会把 `?` 当单字符通配，带查询串的 URL 会误命中别的地址。
 * `offline` 再补一条最低优先级的兜底阻断——「录不到的请求不发真实网络」。
 */
export function rulesFromHar(input: unknown, offline = false): NetRule[] {
  const entries = (input as { log?: { entries?: unknown } } | undefined)?.log?.entries;
  if (!Array.isArray(entries)) throw bad('不是合法的 HAR：缺 log.entries');

  const rules: NetRule[] = [];
  const seen = new Set<string>();
  entries.forEach((raw, index) => {
    const entry = raw as {
      request?: { method?: unknown; url?: unknown };
      response?: { status?: unknown; content?: { text?: unknown; mimeType?: unknown } };
    };
    const url = entry?.request?.url;
    const status = entry?.response?.status;
    const text = entry?.response?.content?.text;
    // 没有响应体（二进制 / 超限 / 失败请求）的条目回放不了，跳过
    if (typeof url !== 'string' || !url || typeof status !== 'number' || status < 200 || typeof text !== 'string')
      return;
    const method = typeof entry.request?.method === 'string' ? entry.request.method.toUpperCase() : 'GET';
    // shortcut: 同一个 (method,url) 只回放**第一条**录到的响应（后面重复的直接丢弃）。
    // 站点若依赖「同一接口两次调用返回不同结果」，回放会退化成同一个响应；那时再改成按顺序消费。
    if (seen.has(`${method} ${url}`)) return;
    seen.add(`${method} ${url}`);
    rules.push({
      id: `har:${index}`,
      enabled: true,
      match: { url: `^${escapeRegExp(url)}$`, isRegex: true, method },
      action: {
        type: 'mock',
        status,
        body: text,
        contentType:
          typeof entry.response?.content?.mimeType === 'string' ? entry.response.content.mimeType : undefined,
      },
    });
  });

  if (offline) {
    rules.push({
      id: 'har:__offline__',
      enabled: true,
      priority: -1000,
      match: { url: '*' },
      action: { type: 'block' },
    });
  }
  return rules;
}
