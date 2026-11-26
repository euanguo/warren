import type { SiteNote } from '../../../shared/types.ts';

export interface ReadablePageClient {
  currentUrl(): string;
  title(): Promise<string>;
  evaluate(fn: string, arg?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  fetch?(
    url: string,
    opts?: { method?: string; headers?: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; body?: string }>;
}

export interface ReadPageOptions {
  selector?: string;
  data?: boolean;
  links?: boolean | string;
  scroll?: boolean;
  /** 滚屏命中该子串时提前结束滚动。 */
  match?: string;
  maxScrolls?: number;
  /** 仅提取页面标题大纲（H1–H6）。 */
  outline?: boolean;
  /** 对提取后的正文行按子串或 `/regex/` 过滤。 */
  filter?: string;
  /** 拉取站点 `/llms.txt`（`index`）或 `/llms-full.txt`（`full`）作为文档优先通道。 */
  llms?: 'index' | 'full';
  siteNotes?: SiteNote[];
}

export interface ReadPageResult {
  url: string;
  title: string;
  siteNotes?: SiteNote[];
  text: string;
  outline?: Array<{ level: number; text: string }>;
  links?: Array<{ text: string; href: string }>;
  data?: Array<{ source: string; payload: unknown }>;
  scrolled?: { steps: number; container: string; matched?: boolean };
  llmsSource?: string;
}

/**
 * 实时 DOM + Shadow DOM 穿透正文提取脚本：
 * - 不使用 `cloneNode(true)`，保留 Open Shadow DOM 且利用 `getComputedStyle` / `checkVisibility` 排除隐藏元素；
 * - 兼容现代 React/Vue SPA 的纯 `<div>` 文本块，不再只认 `<p>`/`<li>`/`<h*>`；
 * - 同步采集标题大纲（`outline`）、链接（`links`）与嵌入 JSON（`__NEXT_DATA__` / JSON-LD / application/json）。
 */
const READ_EXTRACTION_FN = `(opts) => {
  const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'IFRAME', 'CANVAS', 'HEAD']);
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) {
      return false;
    }
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && cs.display !== 'contents') {
          return false;
        }
      } catch {}
    }
    return true;
  };

  const root = opts.selector
    ? document.querySelector(opts.selector)
    : (document.querySelector('main, article, [role="main"]') || document.body);

  const blocks = [];
  const outline = [];

  if (root) {
    const ownDirectText = (el) => {
      let buf = '';
      for (const child of el.childNodes) {
        if (child.nodeType === 3) buf += child.textContent || '';
      }
      return normalize(buf);
    };
    const isBlockLeaf = (el) => {
      for (const c of el.children) {
        const t = c.tagName;
        if (/^(DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|NAV|ASIDE|UL|OL|LI|TABLE|TR|P|BLOCKQUOTE|PRE|H[1-6])$/.test(t)) {
          return false;
        }
      }
      return !el.shadowRoot;
    };
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      const tag = node.tagName;
      if (SKIP_TAGS.has(tag)) return;
      if (node !== root && !isVisible(node)) return;

      if (/^H[1-6]$/.test(tag)) {
        const lvl = Number(tag[1]);
        const t = normalize(node.innerText ?? node.textContent);
        if (t) {
          outline.push({ level: lvl, text: t });
          blocks.push('#'.repeat(lvl) + ' ' + t);
        }
        return;
      }
      if (tag === 'LI') {
        const t = normalize(node.innerText ?? node.textContent);
        if (t) blocks.push('- ' + t);
        return;
      }
      if (tag === 'TR') {
        const cells = Array.from(node.querySelectorAll('th, td'))
          .filter((c) => isVisible(c))
          .map((c) => normalize(c.innerText ?? c.textContent));
        if (cells.some(Boolean)) blocks.push(cells.join(' | '));
        return;
      }
      if (tag === 'PRE') {
        const raw = String(node.innerText ?? node.textContent ?? '').trim();
        if (raw) blocks.push('\`\`\`\\n' + raw + '\\n\`\`\`');
        return;
      }
      if (tag === 'P' || tag === 'BLOCKQUOTE') {
        const t = normalize(node.innerText ?? node.textContent);
        if (t) blocks.push(t);
        return;
      }

      if (node.shadowRoot) {
        for (const sc of node.shadowRoot.children) walk(sc);
      }
      if (node.children.length === 0 || isBlockLeaf(node)) {
        const t = normalize(node.innerText ?? node.textContent);
        if (t && t.length >= 2) blocks.push(t);
        return;
      }
      const direct = ownDirectText(node);
      if (direct && direct.length >= 2) blocks.push(direct);
      for (const child of node.children) walk(child);
    };

    walk(root);
  }

  const deduped = [];
  for (const line of blocks) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }
  const fallbackText = root ? normalize(root.innerText ?? root.textContent) : '';
  const text = (deduped.length > 0 ? deduped.join('\\n') : fallbackText).slice(0, 48000);

  let links;
  if (opts.includeLinks) {
    const seen = new Set();
    const out = [];
    const scope = root || document;
    const walkLinks = (r) => {
      if (!r) return;
      for (const a of r.querySelectorAll('a[href]')) {
        if (!isVisible(a)) continue;
        const href = a.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);
        out.push({ text: normalize(a.innerText ?? a.textContent).slice(0, 140), href });
        if (out.length >= 250) return;
      }
      for (const el of r.querySelectorAll('*')) {
        if (el.shadowRoot && out.length < 250) walkLinks(el.shadowRoot);
      }
    };
    walkLinks(scope);
    links = out;
  }

  let data;
  if (opts.includeData) {
    const found = [];
    const pushScript = (label, raw) => {
      try {
        found.push({ source: label, payload: JSON.parse(raw) });
      } catch {}
    };
    const nextData = document.querySelector('#__NEXT_DATA__');
    if (nextData && nextData.textContent) pushScript('__NEXT_DATA__', nextData.textContent);
    document.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]').forEach((el, idx) => {
      if (el.id === '__NEXT_DATA__' || !el.textContent) return;
      pushScript(el.id || el.getAttribute('type') || 'json-' + idx, el.textContent);
    });
    data = found;
  }

  return { text, outline, links, data };
}`;

/**
 * 智能滚屏脚本：优先滚动 `-s` 指定容器，否则找页面内面积最大的可滚动内部容器（如仪表盘列表/聊天窗），
 * 若不存在内部滚动容器再滚动 `window`；支持 `--match <text>` 命中即停。
 */
const SMART_SCROLL_STEP_FN = `(arg) => {
  const selector = arg && arg.selector;
  const matchText = arg && arg.match ? String(arg.match).toLowerCase() : '';
  const hasMatch = () => matchText && String(document.body?.innerText || '').toLowerCase().includes(matchText);
  if (hasMatch()) return { moved: false, atBottom: false, matched: true, container: 'matched' };

  const isScrollable = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const cs = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(cs.overflowY)) return false;
    return el.scrollHeight > el.clientHeight + 20 && el.clientHeight >= 120;
  };

  let container = null;
  if (selector) {
    const el = document.querySelector(selector);
    if (isScrollable(el)) container = el;
  }
  if (!container) {
    let bestArea = 0;
    for (const el of document.querySelectorAll('main, section, div, ul, [role="feed"], [role="list"], [role="grid"]')) {
      if (!isScrollable(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        container = el;
      }
    }
  }

  if (container && container !== document.body && container !== document.documentElement) {
    const before = container.scrollTop;
    const step = Math.max(300, Math.round(container.clientHeight * 0.85));
    container.scrollTop += step;
    const moved = container.scrollTop > before;
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
    const desc = container.tagName.toLowerCase() + (container.id ? '#' + container.id : '');
    return { moved, atBottom, matched: hasMatch(), container: desc };
  }

  const before = window.scrollY;
  window.scrollBy(0, Math.max(400, Math.round(window.innerHeight * 0.85)));
  return {
    moved: window.scrollY > before,
    atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4,
    matched: hasMatch(),
    container: 'window',
  };
}`;

function compileLineFilter(raw?: string): ((line: string) => boolean) | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  const reMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  if (reMatch) {
    try {
      const re = new RegExp(reMatch[1]!, reMatch[2] || 'i');
      return (line) => re.test(line);
    } catch {}
  }
  const needle = trimmed.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

/** 将结构化数据或链接数组序列化为标准 CSV（供 `--out *.csv` 使用）。 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

/**
 * 干净网页阅读器：支持 `-s` 局部、实时 DOM/Shadow DOM 正文提取、`--outline` 标题大纲、
 * `--filter` 文本/正则过滤、`--data`（Next.js/JSON-LD）、`--links` 链接过滤、
 * 智能容器 `--scroll` + `--match` 命中停、以及 `--llms index|full` 文档通道。
 */
export async function readPage(controller: ReadablePageClient, options: ReadPageOptions = {}): Promise<ReadPageResult> {
  // 可选优先走 `/llms.txt` 或 `/llms-full.txt`
  if (options.llms && controller.fetch) {
    try {
      const current = new URL(controller.currentUrl());
      const llmsPath = options.llms === 'full' ? '/llms-full.txt' : '/llms.txt';
      const llmsUrl = `${current.origin}${llmsPath}`;
      const resp = await controller.fetch(llmsUrl, {
        method: 'GET',
        headers: { Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' },
      });
      if (resp.ok && resp.body && resp.body.trim().length > 20 && !/^<!doctype html/i.test(resp.body.trim())) {
        return {
          url: controller.currentUrl(),
          title: await controller.title(),
          ...(options.siteNotes && options.siteNotes.length > 0 ? { siteNotes: options.siteNotes } : {}),
          text: resp.body.slice(0, 64_000),
          llmsSource: llmsUrl,
        };
      }
    } catch {
      // 站点没有 llms.txt 时自动回退到正常 DOM 阅读
    }
  }

  let scrolled: ReadPageResult['scrolled'];
  if (options.scroll) {
    const maxScrolls = Math.max(1, Math.min(20, options.maxScrolls ?? 6));
    let steps = 0;
    let container = 'window';
    let matched = false;
    for (let step = 0; step < maxScrolls; step += 1) {
      const res = (await controller
        .evaluate(SMART_SCROLL_STEP_FN, { selector: options.selector, match: options.match })
        .catch(() => null)) as {
        moved?: boolean;
        atBottom?: boolean;
        matched?: boolean;
        container?: string;
      } | null;
      if (res?.container) container = res.container;
      if (res?.matched) {
        matched = true;
        break;
      }
      if (!res?.moved) break;
      steps += 1;
      if (res.atBottom) break;
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    scrolled = { steps, container, ...(options.match ? { matched } : {}) };
  }

  const includeLinks = options.links !== undefined && options.links !== false;
  const raw = (await controller.evaluate(READ_EXTRACTION_FN, {
    selector: options.selector,
    includeLinks,
    includeData: Boolean(options.data),
  })) as {
    text?: string;
    outline?: Array<{ level: number; text: string }>;
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

  let text = raw?.text ?? '';
  const outline = raw?.outline;
  if (options.outline && outline) {
    text = outline.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n');
  }
  const lineFilter = compileLineFilter(options.filter);
  if (lineFilter && text) {
    text = text
      .split(/\r?\n/)
      .filter((line) => lineFilter(line))
      .join('\n');
  }

  return {
    url: controller.currentUrl(),
    title: await controller.title(),
    ...(options.siteNotes && options.siteNotes.length > 0 ? { siteNotes: options.siteNotes } : {}),
    text,
    ...(options.outline && outline ? { outline } : {}),
    ...(links ? { links } : {}),
    ...(raw?.data ? { data: raw.data } : {}),
    ...(scrolled ? { scrolled } : {}),
  };
}
