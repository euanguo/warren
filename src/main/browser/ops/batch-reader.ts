/**
 * 后台并发隔离读取池（Batch Reader）：
 * - 对标 Ardia 4 并发无扰读取能力，同时复用 Warren 每环境独立 `Electron.Session`（登录态/代理/CA）；
 * - 零 Electron 运行时依赖，通过注入 `openPage` 工厂创建并销毁临时 offscreen 页面，绝不打断用户或 Agent 活动 Tab；
 * - 单页失败/超时隔离，不拖垮整批结果，输出严格按输入 URL 顺序返回。
 */
import { readPage, type ReadablePageClient, type ReadPageOptions, type ReadPageResult } from './reader.ts';

export interface EphemeralReaderHandle {
  client: ReadablePageClient;
  load(url: string, timeoutMs: number): Promise<void>;
  close(): Promise<void> | void;
}

export interface BatchReadOptions extends ReadPageOptions {
  /** 并发数（默认 4，范围 1..6）。 */
  concurrency?: number;
  /** 单页加载超时 ms（默认 20000）。 */
  timeoutMs?: number;
  /** 每页正文裁剪上限（默认 12000 字符），避免 10 个页面把上下文撑爆。 */
  maxCharsPerPage?: number;
}

export interface BatchReadItem {
  url: string;
  ok: boolean;
  title?: string;
  text?: string;
  outline?: ReadPageResult['outline'];
  links?: ReadPageResult['links'];
  data?: ReadPageResult['data'];
  dataSummary?: ReadPageResult['dataSummary'];
  dataSlice?: ReadPageResult['dataSlice'];
  durationMs: number;
  error?: string;
}

export interface BatchReadResult {
  total: number;
  ok: number;
  failed: number;
  concurrency: number;
  durationMs: number;
  items: BatchReadItem[];
}

const MAX_URLS = 40;

function validateUrls(rawUrls: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawUrls) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw Object.assign(new Error(`非法 URL：${trimmed}`), { code: 'BAD_REQUEST' });
    }
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw Object.assign(new Error(`批量读取仅允许 http/https URL，拒绝 ${parsed.protocol}`), {
        code: 'BAD_REQUEST',
      });
    }
    const normalized = parsed.toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
    if (out.length >= MAX_URLS) break;
  }
  if (out.length === 0) {
    throw Object.assign(new Error('批量读取 URL 列表为空'), { code: 'BAD_REQUEST' });
  }
  return out;
}

export async function readUrlsConcurrently(
  rawUrls: readonly string[],
  options: BatchReadOptions,
  openPage: () => Promise<EphemeralReaderHandle>,
): Promise<BatchReadResult> {
  const startedAt = Date.now();
  const urls = validateUrls(rawUrls);
  const concurrency = Math.max(1, Math.min(6, Math.floor(options.concurrency ?? 4), urls.length));
  const timeoutMs = Math.max(2000, Math.min(90_000, Math.floor(options.timeoutMs ?? 20_000)));
  const maxChars = Math.max(500, Math.min(48_000, Math.floor(options.maxCharsPerPage ?? 12_000)));

  const items: BatchReadItem[] = Array.from({ length: urls.length });
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= urls.length) break;
      const url = urls[idx]!;
      const itemStart = Date.now();
      let handle: EphemeralReaderHandle | null = null;
      try {
        handle = await openPage();
        await handle.load(url, timeoutMs);
        const res = await readPage(handle.client, {
          selector: options.selector,
          data: options.data,
          links: options.links,
          outline: options.outline,
          filter: options.filter,
          block: options.block,
          fields: options.fields,
          where: options.where,
          limit: options.limit,
        });
        const text =
          res.text.length > maxChars
            ? `${res.text.slice(0, maxChars)}\n... (truncated at ${maxChars} chars)`
            : res.text;
        items[idx] = {
          url: res.url || url,
          ok: true,
          title: res.title,
          text,
          ...(res.outline ? { outline: res.outline } : {}),
          ...(res.links ? { links: res.links } : {}),
          ...(res.data ? { data: res.data } : {}),
          ...(res.dataSummary ? { dataSummary: res.dataSummary } : {}),
          ...(res.dataSlice ? { dataSlice: res.dataSlice } : {}),
          durationMs: Date.now() - itemStart,
        };
      } catch (err) {
        items[idx] = {
          url,
          ok: false,
          durationMs: Date.now() - itemStart,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (handle) {
          try {
            await handle.close();
          } catch {
            // 释放临时离屏页失败不应影响整批结果
          }
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = items.filter((it) => it?.ok).length;
  return {
    total: items.length,
    ok,
    failed: items.length - ok,
    concurrency,
    durationMs: Date.now() - startedAt,
    items,
  };
}
