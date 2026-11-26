/**
 * CLI 与主进程共用的输出安全治理与动态超时预算（纯 ESM，零依赖）。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { warrenHome } from './paths.mjs';

export const DEFAULT_MAX_OUTPUT_CHARS = 12_000;

export function stripTerminalEscapes(input) {
  const s = String(input);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x1b) {
      const next = s.charCodeAt(i + 1);
      if (next === 0x5b) {
        i += 2;
        while (i < s.length) {
          const c = s.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) break;
          i++;
        }
        continue;
      }
      if (next === 0x5d) {
        i += 2;
        while (i < s.length) {
          const c = s.charCodeAt(i);
          if (c === 0x07) break;
          if (c === 0x1b && s.charCodeAt(i + 1) === 0x5c) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (i + 1 < s.length) i++;
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    out += s[i];
  }
  return out;
}

export function wrapUntrustedContent(content, meta = {}) {
  const nonce = meta.nonce ?? randomBytes(6).toString('hex');
  const tag = `warren_page_content_${nonce}`;
  const escaped = stripTerminalEscapes(content).replace(/<\s*\/\s*warren_page_content/gi, '&lt;/warren_page_content');
  const attrs = [
    'trust="untrusted"',
    ...(meta.source ? [`source=${JSON.stringify(meta.source)}`] : []),
    ...(meta.url ? [`url=${JSON.stringify(stripTerminalEscapes(meta.url).slice(0, 240))}`] : []),
  ].join(' ');
  return `<${tag} ${attrs}>\n${escaped}\n</${tag}>`;
}

export function applyOutputBudget(raw, options = {}) {
  const cleaned = stripTerminalEscapes(raw);
  const totalChars = cleaned.length;
  if (options.full) return { text: cleaned, truncated: false, totalChars };
  const limit = options.maxChars && options.maxChars > 0 ? options.maxChars : DEFAULT_MAX_OUTPUT_CHARS;
  if (totalChars <= limit) return { text: cleaned, truncated: false, totalChars };

  const tmpDir = options.tmpDir ?? path.join(warrenHome(), 'tmp');
  const safeLabel = (options.label ?? 'output').replace(/[^\w.-]+/g, '-').slice(0, 32);
  const savedPath = path.join(tmpDir, `${safeLabel}-${Date.now()}-${randomBytes(3).toString('hex')}.txt`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(savedPath, cleaned, 'utf8');
  } catch {
    // 忽略落盘错误，仍执行裁剪
  }

  const headLen = Math.max(200, Math.floor(limit * 0.78));
  const tailLen = Math.max(100, limit - headLen - 180);
  const head = cleaned.slice(0, headLen);
  const tail = cleaned.slice(Math.max(headLen, totalChars - tailLen));
  const omitted = Math.max(0, totalChars - head.length - tail.length);
  const footer = `\n... [输出已按 --max-output=${limit} 裁剪，共 ${totalChars} 字符，省略中间 ${omitted} 字符；完整内容已保存至 ${savedPath}，或加 --full 查看全文] ...\n`;
  return { text: `${head}${footer}${tail}`, truncated: true, totalChars, savedPath };
}

export function computeRpcTimeoutMs(method, params = {}, baseTimeoutMs = 60_000) {
  const base = Number.isFinite(baseTimeoutMs) && baseTimeoutMs > 0 ? baseTimeoutMs : 60_000;
  let required = base;
  if (typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
    required = Math.max(required, params.timeoutMs + 5_000);
  }
  if (method === 'browser.waitForTimeout' && typeof params.ms === 'number' && Number.isFinite(params.ms)) {
    required = Math.max(required, params.ms + 5_000);
  }
  if (method === 'browser.batch') {
    const count = Array.isArray(params.steps)
      ? params.steps.length
      : typeof params.script === 'string'
        ? params.script
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#')).length
        : 1;
    required = Math.max(required, count * 6_000 + 9_000);
  }
  if (method === 'browser.read' && params.scroll) {
    const scrolls = typeof params.maxScrolls === 'number' && params.maxScrolls > 0 ? params.maxScrolls : 6;
    required = Math.max(required, scrolls * 2_000 + 20_000);
  }
  return Math.min(300_000, Math.max(base, Math.round(required)));
}

export function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))];
  if (headers.length === 0) return '';
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => headers.map((h) => esc(r?.[h])).join(','))].join('\n');
}
