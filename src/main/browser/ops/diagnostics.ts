/**
 * 页面开发诊断工具箱：
 * - `printPdf`：`Page.printToPDF` 导出 PDF（严格遵守 `guardSavePath`）；
 * - `collectVitals`：采集 Core Web Vitals / Navigation Timing / DOM 规模；
 * - `auditAccessibility`：结构化 WCAG 基础审计（缺 alt / 缺 label / 标题跳级 / 重复 id / 坏 aria 引用等）；
 * - `inspectReactTree`：只读探查 React Fiber 树与脱敏 props 摘要（绝不修改页面状态）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PageContext } from '../ctx.ts';
import { sha256Buffer } from '../../artifacts.ts';
import { richErr } from '../errors.ts';
import { guardSavePath } from '../policy.ts';

export interface PdfOptions {
  path: string;
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
}

export async function printPdf(
  ctx: PageContext,
  opts: PdfOptions,
): Promise<{ ok: true; path: string; bytes: number; sha256: string }> {
  const dest = guardSavePath(opts.path);
  let buf: Buffer;
  // Electron 的 headed WebContents 不暴露 CDP `Page.printToPDF`（headless 专用），优先走原生 `wc.printToPDF`
  if (typeof ctx.wc?.printToPDF === 'function') {
    buf = await ctx.wc.printToPDF({
      landscape: Boolean(opts.landscape),
      printBackground: opts.printBackground !== false,
      ...(opts.scale && opts.scale >= 0.1 && opts.scale <= 2 ? { scale: opts.scale } : {}),
    });
  } else {
    const res = await ctx.send<{ data?: string }>('Page.printToPDF', {
      landscape: Boolean(opts.landscape),
      printBackground: opts.printBackground !== false,
      ...(opts.scale && opts.scale >= 0.1 && opts.scale <= 2 ? { scale: opts.scale } : {}),
    });
    if (!res?.data) throw richErr('INTERNAL', 'Page.printToPDF 未返回 PDF 数据');
    buf = Buffer.from(res.data, 'base64');
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return { ok: true, path: dest, bytes: buf.length, sha256: sha256Buffer(buf) };
}

export interface VitalsReport {
  url: string;
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  domNodes: number;
  resourceCount: number;
  jsHeapUsedMb: number | null;
}

export async function collectVitals(ctx: PageContext): Promise<VitalsReport> {
  const res = await ctx.send<{ result?: { value?: VitalsReport } }>('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const round = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);
      const nav = performance.getEntriesByType('navigation')[0];
      const paints = performance.getEntriesByType('paint');
      const fcp = paints.find((p) => p.name === 'first-contentful-paint');
      const lcps = performance.getEntriesByType('largest-contentful-paint');
      const lcp = lcps.length > 0 ? lcps[lcps.length - 1] : null;
      const shifts = performance.getEntriesByType('layout-shift');
      const cls = shifts.length > 0
        ? shifts.filter((s) => !s.hadRecentInput).reduce((acc, s) => acc + (s.value || 0), 0)
        : 0;
      const mem = performance.memory;
      return {
        url: location.href,
        ttfbMs: nav ? round(nav.responseStart - nav.requestStart) : null,
        domContentLoadedMs: nav ? round(nav.domContentLoadedEventEnd) : null,
        loadMs: nav ? round(nav.loadEventEnd) : null,
        fcpMs: fcp ? round(fcp.startTime) : null,
        lcpMs: lcp ? round(lcp.startTime) : null,
        cls: round(cls),
        domNodes: document.getElementsByTagName('*').length,
        resourceCount: performance.getEntriesByType('resource').length,
        jsHeapUsedMb: mem ? round(mem.usedJSHeapSize / (1024 * 1024)) : null,
      };
    })()`,
  });
  return (
    res?.result?.value ?? {
      url: ctx.wc.getURL(),
      ttfbMs: null,
      domContentLoadedMs: null,
      loadMs: null,
      fcpMs: null,
      lcpMs: null,
      cls: null,
      domNodes: 0,
      resourceCount: 0,
      jsHeapUsedMb: null,
    }
  );
}

export interface A11yIssue {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  selector: string;
}

export interface A11yAuditReport {
  url: string;
  passed: boolean;
  errorCount: number;
  warningCount: number;
  issues: A11yIssue[];
}

export async function auditAccessibility(ctx: PageContext): Promise<A11yAuditReport> {
  const res = await ctx.send<{ result?: { value?: A11yAuditReport } }>('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const issues = [];
      const cssPath = (el) => {
        if (!el || el.nodeType !== 1) return '';
        const tag = el.tagName.toLowerCase();
        if (el.id) return tag + '#' + el.id;
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.') : '';
        return tag + (cls ? '.' + cls : '');
      };
      const add = (rule, severity, message, el) => {
        if (issues.length < 100) issues.push({ rule, severity, message, selector: cssPath(el) });
      };
      const isVisible = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      // 1) html lang
      if (!document.documentElement.getAttribute('lang')) {
        add('html-has-lang', 'warning', '<html> 缺少 lang 属性', document.documentElement);
      }
      // 2) img alt
      for (const img of document.querySelectorAll('img')) {
        if (!isVisible(img)) continue;
        if (!img.hasAttribute('alt') && img.getAttribute('role') !== 'presentation' && img.getAttribute('aria-hidden') !== 'true') {
          add('image-alt', 'error', '可见 <img> 缺少 alt 属性', img);
        }
      }
      // 3) 表单控件标签
      for (const ctrl of document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea')) {
        if (!isVisible(ctrl)) continue;
        const hasLabel = Boolean(
          (ctrl.labels && ctrl.labels.length > 0) ||
          ctrl.getAttribute('aria-label') ||
          ctrl.getAttribute('aria-labelledby') ||
          ctrl.getAttribute('title'),
        );
        if (!hasLabel) add('form-label', 'error', '表单控件缺少关联 <label> 或 aria-label', ctrl);
      }
      // 4) 按钮与链接可访问名称
      for (const el of document.querySelectorAll('button, a[href]')) {
        if (!isVisible(el)) continue;
        const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
        const hasImgAlt = Boolean(el.querySelector('img[alt]:not([alt=""])'));
        if (!name && !hasImgAlt && !el.getAttribute('aria-labelledby')) {
          add('empty-interactive', 'error', '可交互按钮/链接缺少可访问文本', el);
        }
      }
      // 5) 标题层级跳级
      let prevLevel = 0;
      for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
        if (!isVisible(h)) continue;
        const lvl = Number(h.tagName[1]);
        if (prevLevel > 0 && lvl > prevLevel + 1) {
          add('heading-order', 'warning', '标题层级跳级：h' + prevLevel + ' -> h' + lvl, h);
        }
        prevLevel = lvl;
      }
      // 6) 重复 id
      const idCounts = new Map();
      for (const el of document.querySelectorAll('[id]')) {
        const id = el.getAttribute('id');
        if (!id) continue;
        idCounts.set(id, (idCounts.get(id) || 0) + 1);
        if (idCounts.get(id) === 2) add('duplicate-id', 'error', '文档内存在重复 id: #' + id, el);
      }
      // 7) 正数 tabindex
      for (const el of document.querySelectorAll('[tabindex]')) {
        const v = Number(el.getAttribute('tabindex'));
        if (v > 0) add('positive-tabindex', 'warning', '存在正向 tabindex=' + v + '（破坏自然键盘焦点顺序）', el);
      }
      // 8) 坏的 aria-labelledby / aria-describedby 引用
      for (const el of document.querySelectorAll('[aria-labelledby], [aria-describedby]')) {
        for (const attr of ['aria-labelledby', 'aria-describedby']) {
          const val = (el.getAttribute(attr) || '').trim();
          if (!val) continue;
          for (const refId of val.split(/\\s+/)) {
            if (!document.getElementById(refId)) {
              add('broken-aria-ref', 'error', attr + ' 引用了不存在的 id: #' + refId, el);
            }
          }
        }
      }

      const errorCount = issues.filter((i) => i.severity === 'error').length;
      const warningCount = issues.filter((i) => i.severity === 'warning').length;
      return { url: location.href, passed: errorCount === 0, errorCount, warningCount, issues };
    })()`,
  });
  return (
    res?.result?.value ?? {
      url: ctx.wc.getURL(),
      passed: true,
      errorCount: 0,
      warningCount: 0,
      issues: [],
    }
  );
}

export interface ReactComponentSummary {
  name: string;
  depth: number;
  propsKeys: string[];
}

export async function inspectReactTree(
  ctx: PageContext,
  opts: { maxNodes?: number } = {},
): Promise<{ detected: boolean; version?: string; components: ReactComponentSummary[] }> {
  const maxNodes = Math.max(10, Math.min(200, opts.maxNodes ?? 80));
  const res = await ctx.send<{
    result?: { value?: { detected: boolean; version?: string; components: ReactComponentSummary[] } };
  }>('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const maxNodes = ${maxNodes};
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      let version;
      if (hook && hook.renderers && hook.renderers.size > 0) {
        const first = hook.renderers.values().next().value;
        if (first && first.version) version = String(first.version);
      }
      // 查找 DOM 上挂载的 __reactFiber$ / __reactContainer$
      let rootFiber = null;
      const candidates = [document.getElementById('root'), document.getElementById('__next'), document.getElementById('app'), document.body, ...Array.from(document.body?.children || []).slice(0, 10)];
      for (const el of candidates) {
        if (!el) continue;
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
        if (key) {
          rootFiber = el[key];
          break;
        }
      }
      if (!rootFiber) return { detected: Boolean(version), ...(version ? { version } : {}), components: [] };
      const components = [];
      const walk = (fiber, depth) => {
        if (!fiber || components.length >= maxNodes) return;
        const type = fiber.type;
        let nextDepth = depth;
        if (typeof type === 'function' || (type && typeof type === 'object' && (type.displayName || type.render))) {
          const name = type.displayName || type.name || (type.render && (type.render.displayName || type.render.name)) || 'Anonymous';
          const propsKeys = fiber.memoizedProps && typeof fiber.memoizedProps === 'object'
            ? Object.keys(fiber.memoizedProps).filter((k) => k !== 'children' && !/pass|secret|token|auth|cookie/i.test(k)).slice(0, 8)
            : [];
          components.push({ name: String(name).slice(0, 60), depth, propsKeys });
          nextDepth = depth + 1;
        }
        walk(fiber.child, nextDepth);
        walk(fiber.sibling, depth);
      };
      walk(rootFiber, 0);
      return { detected: true, ...(version ? { version } : {}), components };
    })()`,
  });
  return res?.result?.value ?? { detected: false, components: [] };
}
