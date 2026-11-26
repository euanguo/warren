/**
 * CLI / Agent 输出安全治理：
 * 1. 剥离终端 ANSI / OSC 转义序列与控制字符（纯字符码状态机，防终端注入且无正则回溯）；
 * 2. IDPI 边界包裹（`--content-boundaries`）：用随机 nonce 隔离不可信页面文本，
 *    并对内容里的宽松闭合标签变体转义，防止提示注入提前闭合边界；
 * 3. 输出长度预算（`--max-output`，默认 12000 字符；`--full` 关闭）：超限时完整落盘到
 *    `$WARREN_HOME/tmp/` 并返回首尾节选与文件路径。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MAX_OUTPUT_CHARS = 12_000;

/** 纯字符码状态机清理终端 ANSI CSI / OSC 转义序列及不可见控制字符（保留 \t \n \r）。 */
export function stripTerminalEscapes(input: string): string {
  const s = String(input);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // ESC (0x1B)
    if (code === 0x1b) {
      const next = s.charCodeAt(i + 1);
      if (next === 0x5b) {
        // CSI: ESC [ ... final byte 0x40..0x7E
        i += 2;
        while (i < s.length) {
          const c = s.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) break;
          i++;
        }
        continue;
      }
      if (next === 0x5d) {
        // OSC: ESC ] ... BEL(0x07) or ST(ESC \)
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
      // 其余两字节 ESC 序列
      if (i + 1 < s.length) i++;
      continue;
    }
    // 保留 \t(9), \n(10), \r(13)；跳过其余 C0 (0..31) 和 DEL/C1 (127..159)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    out += s[i];
  }
  return out;
}

/**
 * IDPI 边界隔离包装：
 * 生成随机十六进制 nonce 作为标签名一部分，并把正文里任何形似
 * `</warren_page_content...>` 的宽松闭合标签中的 `<` 转义为 `&lt;`，防止内容逃逸。
 */
export function wrapUntrustedContent(
  content: string,
  meta: { source?: string; url?: string; nonce?: string } = {},
): string {
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

export interface OutputBudgetOptions {
  maxChars?: number;
  full?: boolean;
  tmpDir?: string;
  label?: string;
}

export interface OutputBudgetResult {
  text: string;
  truncated: boolean;
  totalChars: number;
  savedPath?: string;
}

function defaultTmpDir(): string {
  const home = process.env.WARREN_HOME ? path.resolve(process.env.WARREN_HOME) : path.join(os.homedir(), '.warren');
  return path.join(home, 'tmp');
}

export function applyOutputBudget(raw: string, options: OutputBudgetOptions = {}): OutputBudgetResult {
  const cleaned = stripTerminalEscapes(raw);
  const totalChars = cleaned.length;
  if (options.full) {
    return { text: cleaned, truncated: false, totalChars };
  }
  const limit = options.maxChars && options.maxChars > 0 ? options.maxChars : DEFAULT_MAX_OUTPUT_CHARS;
  if (totalChars <= limit) {
    return { text: cleaned, truncated: false, totalChars };
  }

  const tmpDir = options.tmpDir ?? defaultTmpDir();
  const safeLabel = (options.label ?? 'output').replace(/[^\w.-]+/g, '-').slice(0, 32);
  const savedPath = path.join(tmpDir, `${safeLabel}-${Date.now()}-${randomBytes(3).toString('hex')}.txt`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(savedPath, cleaned, 'utf8');
  } catch {
    // 写临时目录失败时仍做安全裁剪，不阻断主输出
  }

  const headLen = Math.max(200, Math.floor(limit * 0.78));
  const tailLen = Math.max(100, limit - headLen - 180);
  const head = cleaned.slice(0, headLen);
  const tail = cleaned.slice(Math.max(headLen, totalChars - tailLen));
  const omitted = Math.max(0, totalChars - head.length - tail.length);
  const footer = `\n... [输出已按 --max-output=${limit} 裁剪，共 ${totalChars} 字符，省略中间 ${omitted} 字符；完整内容已保存至 ${savedPath}，或加 --full 查看全文] ...\n`;
  return {
    text: `${head}${footer}${tail}`,
    truncated: true,
    totalChars,
    savedPath,
  };
}
