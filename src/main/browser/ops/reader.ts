import type { SiteNote } from '../../../shared/types.ts';

export interface ReadablePageClient {
  currentUrl(): string;
  title(): Promise<string>;
  evaluate(fn: string, arg?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export interface ReadPageOptions {
  selector?: string;
  data?: boolean;
  links?: boolean | string;
  scroll?: boolean;
  maxScrolls?: number;
  siteNotes?: SiteNote[];
}

export interface ReadPageResult {
  url: string;
  title: string;
  siteNotes?: SiteNote[];
  text: string;
  links?: Array<{ text: string; href: string }>;
  data?: Array<{ source: string; payload: unknown }>;
}

const READ_EXTRACTION_FN = `(opts) => {
  const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const root = opts.selector
    ? document.querySelector(opts.selector)
    : (document.querySelector('main, article, [role="main"]') || document.body);
  let text = '';
  if (root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, svg, template').forEach((el) => el.remove());
    const blocks = [];
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      const tag = node.tagName;
      if (/^H[1-6]$/.test(tag)) {
        const t = normalize(node.textContent);
        if (t) blocks.push('#'.repeat(Number(tag[1])) + ' ' + t);
        return;
      }
      if (tag === 'LI') {
        const t = normalize(node.textContent);
        if (t) blocks.push('- ' + t);
        return;
      }
      if (tag === 'TR') {
        const cells = Array.from(node.querySelectorAll('th, td')).map((c) => normalize(c.textContent));
        if (cells.some(Boolean)) blocks.push(cells.join(' | '));
        return;
      }
      if (tag === 'PRE' || tag === 'CODE') {
        const raw = String(node.textContent || '').trim();
        if (raw) blocks.push(raw);
        return;
      }
      if (tag === 'P' || tag === 'BLOCKQUOTE') {
        const t = normalize(node.textContent);
        if (t) blocks.push(t);
        return;
      }
      for (const child of node.children) walk(child);
    };
    walk(clone);
    const deduped = [];
    for (const line of blocks) {
      if (deduped[deduped.length - 1] !== line) deduped.push(line);
    }
    text = (deduped.length > 0 ? deduped.join('\\n') : normalize(clone.textContent)).slice(0, 32000);
  }

  let links;
  if (opts.includeLinks) {
    const seen = new Set();
    const out = [];
    const scope = root || document;
    for (const a of scope.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push({ text: normalize(a.textContent).slice(0, 140), href });
      if (out.length >= 250) break;
    }
    links = out;
  }

  let data;
  if (opts.includeData) {
    const found = [];
    const pushScript = (label, raw) => {
      try {
        found.push({ source: label, payload: JSON.parse(raw) });
      } catch {
        // 忽略无法解析的脚本块
      }
    };
    const nextData = document.querySelector('#__NEXT_DATA__');
    if (nextData && nextData.textContent) pushScript('__NEXT_DATA__', nextData.textContent);
    document.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]').forEach((el, idx) => {
      if (el.id === '__NEXT_DATA__' || !el.textContent) return;
      pushScript(el.id || el.getAttribute('type') || 'json-' + idx, el.textContent);
    });
    data = found;
  }

  return { text, links, data };
}`;

const SCROLL_STEP_FN = `() => {
  const before = window.scrollY;
  window.scrollBy(0, Math.max(400, Math.round(window.innerHeight * 0.85)));
  return { moved: window.scrollY > before, atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4 };
}`;

/**
 * 干净网页阅读器：支持 `-s` 局部、正文提取、`--data`（Next.js/JSON-LD）、
 * `--links` 链接过滤与 `--scroll` 懒加载滚屏，同时注入匹配的 `# site-notes`。
 */
export async function readPage(controller: ReadablePageClient, options: ReadPageOptions = {}): Promise<ReadPageResult> {
  if (options.scroll) {
    const maxScrolls = Math.max(1, Math.min(12, options.maxScrolls ?? 4));
    for (let step = 0; step < maxScrolls; step += 1) {
      const res = (await controller.evaluate(SCROLL_STEP_FN).catch(() => null)) as {
        moved?: boolean;
        atBottom?: boolean;
      } | null;
      if (!res?.moved || res.atBottom) break;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  const includeLinks = options.links !== undefined && options.links !== false;
  const raw = (await controller.evaluate(READ_EXTRACTION_FN, {
    selector: options.selector,
    includeLinks,
    includeData: Boolean(options.data),
  })) as {
    text?: string;
    links?: Array<{ text: string; href: string }>;
    data?: Array<{ source: string; payload: unknown }>;
  } | null;

  let links = raw?.links;
  if (links && typeof options.links === 'string' && options.links.trim()) {
    const pattern = options.links.trim().toLowerCase();
    links = links.filter(
      (item) => item.href.toLowerCase().includes(pattern) || item.text.toLowerCase().includes(pattern),
    );
  }

  return {
    url: controller.currentUrl(),
    title: await controller.title(),
    ...(options.siteNotes && options.siteNotes.length > 0 ? { siteNotes: options.siteNotes } : {}),
    text: raw?.text ?? '',
    ...(links ? { links } : {}),
    ...(raw?.data ? { data: raw.data } : {}),
  };
}
