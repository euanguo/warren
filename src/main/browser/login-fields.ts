/**
 * 隔离世界智能登录表单探测引擎（无 Electron 依赖，纯评分与脚本构造可单测）。
 *
 * 设计红线（AGENTS.md 硬约束 11）：
 * - 全部 DOM 遍历跑在 `Page.createIsolatedWorld` 中；
 * - 绝不往被控页面写任何全局变量或 `data-*` 属性；
 * - 同时覆盖主文档、open Shadow DOM、同源 iframe 与跨源 OOPIF 子会话。
 */
import type { PageContext } from './ctx.ts';
import type {
  DetectedLoginField,
  DetectedLoginFieldsResult,
  LoginFieldKind,
  LoginStepKind,
} from '../../shared/types.ts';

export interface RawScannedControl {
  tag: string;
  type: string;
  role: string;
  autocomplete: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  labelText: string;
  text: string;
  inputMode: string;
  maxLength: number;
  formKey: string;
  selector: string;
  inShadow: boolean;
  inSameOriginFrame: boolean;
  frameId?: string;
  inCrossOriginFrame?: boolean;
  rect: { x: number; y: number; width: number; height: number };
  order: number;
}

const PASSWORD_RE = /\b(pass(word|wd)?|pwd|secret|pin)\b|密码|口令/i;
const TOTP_RE =
  /\b(totp|otp|2fa|mfa|one[-_ ]?time|auth(enticator)?[-_ ]?code|verify[-_ ]?code|passcode|token)\b|动态码|验证码|谷歌验证|口令码|双因素/i;
const USERNAME_RE =
  /\b(user(name|id)?|account|login|email|e-mail|mail|phone|mobile|tel|uin|uid|handle|member|identifier)\b|账号|帐号|用户名|登录名|邮箱|手机|电话/i;
const SEARCH_RE = /\b(search|query|keyword|filter|find)\b|搜索|查找|筛选/i;
const SUBMIT_RE =
  /\b(sign[- ]?in|log[- ]?in|login|submit|next|continue|verify|confirm|enter|go)\b|登录|登陆|登入|下一步|继续|验证|提交|确认/i;
const NEGATIVE_BUTTON_RE =
  /\b(cancel|back|forgot|reset|register|sign[- ]?up|create|help|close|clear|show|hide|toggle|eye|send[- ]?code)\b|取消|返回|忘记|找回|重置|注册|创建|帮助|关闭|清空|显示|隐藏|获取验证码|发送验证码/i;

function combinedMeta(c: RawScannedControl): string {
  return [c.autocomplete, c.name, c.id, c.placeholder, c.ariaLabel, c.labelText].filter(Boolean).join(' ');
}

function isEditableInput(c: RawScannedControl): boolean {
  if (c.tag !== 'input') return false;
  const ignored = new Set([
    'hidden',
    'checkbox',
    'radio',
    'submit',
    'button',
    'reset',
    'file',
    'image',
    'range',
    'color',
    'date',
    'time',
  ]);
  return !ignored.has(c.type);
}

function isButtonLike(c: RawScannedControl): boolean {
  if (c.tag === 'button') return true;
  if (c.tag === 'input' && (c.type === 'submit' || c.type === 'button' || c.type === 'image')) return true;
  if (c.role === 'button') return true;
  return false;
}

/** 结合定位器与跨源标记生成 `controller.fill` / `controller.click` 可直接消费的 target。 */
function buildTarget(
  c: RawScannedControl,
): string | { kind: 'label'; text: string } | { kind: 'role'; role: string; name?: string } {
  if (!c.inCrossOriginFrame && c.selector) return c.selector;
  const label = (c.ariaLabel || c.labelText || c.placeholder).trim();
  if (label) {
    if (isButtonLike(c)) return { kind: 'role', role: 'button', name: label };
    return { kind: 'label', text: label };
  }
  if (isButtonLike(c) && c.text.trim()) {
    return { kind: 'role', role: 'button', name: c.text.trim() };
  }
  return c.selector;
}

function scorePassword(c: RawScannedControl): number {
  if (!isEditableInput(c)) return 0;
  let score = 0;
  if (c.type === 'password') score += 90;
  const ac = c.autocomplete.toLowerCase();
  if (ac.includes('current-password')) score += 40;
  else if (ac.includes('new-password')) score += 25;
  if (PASSWORD_RE.test(combinedMeta(c))) score += 20;
  return score;
}

function scoreTotp(c: RawScannedControl): number {
  if (!isEditableInput(c) || c.type === 'password') return 0;
  let score = 0;
  const ac = c.autocomplete.toLowerCase();
  const meta = combinedMeta(c);
  if (ac.includes('one-time-code')) score += 95;
  if (TOTP_RE.test(meta)) score += 65;
  if (c.maxLength >= 4 && c.maxLength <= 8) {
    if (c.inputMode === 'numeric' || c.type === 'number' || c.type === 'tel') score += 25;
    else if (score > 0) score += 15;
  }
  if (SEARCH_RE.test(meta)) score -= 60;
  return Math.max(0, score);
}

function scoreUsername(c: RawScannedControl, passwords: RawScannedControl[]): number {
  if (!isEditableInput(c) || c.type === 'password') return 0;
  const meta = combinedMeta(c);
  if (c.type === 'search' || c.role === 'searchbox' || SEARCH_RE.test(meta)) return 0;
  if (c.autocomplete.toLowerCase().includes('one-time-code') || TOTP_RE.test(meta)) return 0;

  let score = 0;
  const ac = c.autocomplete.toLowerCase();
  if (ac.includes('username')) score += 90;
  else if (ac.includes('email')) score += 80;
  else if (ac.includes('tel')) score += 65;

  if (c.type === 'email') score += 55;
  else if (c.type === 'tel') score += 35;
  else if (c.type === 'text' || c.type === '') score += 15;

  if (USERNAME_RE.test(meta)) score += 55;

  // 与密码框同 form 或紧邻密码框上方，强加分
  for (const pwd of passwords) {
    const sameContext = (c.frameId ?? '') === (pwd.frameId ?? '');
    if (!sameContext) continue;
    if (c.formKey && c.formKey === pwd.formKey && c.order < pwd.order) {
      score += 45;
      break;
    }
    const dy = pwd.rect.y - c.rect.y;
    if (dy > 0 && dy < 240 && Math.abs(pwd.rect.x - c.rect.x) < 200) {
      score += 30;
      break;
    }
  }
  return score;
}

function scoreSubmit(c: RawScannedControl, anchors: RawScannedControl[]): number {
  if (!isButtonLike(c)) return 0;
  const text = [c.text, c.ariaLabel, c.id, c.name].filter(Boolean).join(' ').trim();
  if (NEGATIVE_BUTTON_RE.test(text)) return 0;

  let score = 0;
  if (c.type === 'submit') score += 55;
  if (SUBMIT_RE.test(text)) score += 60;

  for (const anchor of anchors) {
    if ((c.frameId ?? '') !== (anchor.frameId ?? '')) continue;
    if (c.formKey && c.formKey === anchor.formKey) {
      score += 40;
      break;
    }
    const dy = c.rect.y - anchor.rect.y;
    if (dy >= -20 && dy < 260) {
      score += 20;
      break;
    }
  }
  return score;
}

function toField(kind: LoginFieldKind, c: RawScannedControl, score: number): DetectedLoginField {
  const confidence = Math.min(1, Math.round((score / 130) * 100) / 100);
  return {
    kind,
    selector: c.selector,
    target: buildTarget(c),
    confidence,
    ...(c.labelText || c.ariaLabel || c.placeholder || c.text
      ? { label: (c.labelText || c.ariaLabel || c.placeholder || c.text).trim().slice(0, 80) }
      : {}),
    ...(c.autocomplete ? { autocomplete: c.autocomplete } : {}),
    ...(c.type ? { inputType: c.type } : {}),
    ...(c.frameId ? { frameId: c.frameId } : {}),
    ...(c.inShadow ? { inShadow: true } : {}),
    ...(c.inSameOriginFrame ? { inSameOriginFrame: true } : {}),
    ...(c.inCrossOriginFrame ? { inCrossOriginFrame: true } : {}),
    rect: c.rect,
  };
}

/** 根据命中的字段集合判定当前登录页形态（单步 / 两步 / MFA / 无登录框）。 */
export function classifyLoginStep(fields: DetectedLoginFieldsResult['fields']): LoginStepKind {
  if (fields.username && fields.password) return 'single';
  if (fields.password) return 'password-only';
  if (fields.totp && !fields.username) return 'totp-only';
  if (fields.username) return 'username-only';
  return 'none';
}

/** 纯逻辑打分与择优：喂入扫描到的控件列表，输出标准化登录框结果。 */
export function selectLoginFields(url: string, controls: RawScannedControl[]): DetectedLoginFieldsResult {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }

  const scoredPasswords = controls
    .map((c) => ({ c, score: scorePassword(c) }))
    .filter((item) => item.score >= 50)
    .sort((a, b) => b.score - a.score || a.c.order - b.c.order);

  const bestPassword = scoredPasswords[0];
  const passwordControls = scoredPasswords.map((item) => item.c);

  const scoredTotp = controls
    .filter((c) => c !== bestPassword?.c)
    .map((c) => ({ c, score: scoreTotp(c) }))
    .filter((item) => item.score >= 55)
    .sort((a, b) => b.score - a.score || a.c.order - b.c.order);
  const bestTotp = scoredTotp[0];

  const scoredUsername = controls
    .filter((c) => c !== bestPassword?.c && c !== bestTotp?.c)
    .map((c) => ({ c, score: scoreUsername(c, passwordControls) }))
    .filter((item) => item.score >= (bestPassword ? 40 : 60))
    .sort((a, b) => b.score - a.score || a.c.order - b.c.order);
  const bestUsername = scoredUsername[0];

  const anchors = [bestPassword?.c, bestUsername?.c, bestTotp?.c].filter(Boolean) as RawScannedControl[];
  const scoredSubmit = anchors.length
    ? controls
        .map((c) => ({ c, score: scoreSubmit(c, anchors) }))
        .filter((item) => item.score >= 50)
        .sort((a, b) => b.score - a.score || a.c.order - b.c.order)
    : [];
  const bestSubmit = scoredSubmit[0];

  const fields: DetectedLoginFieldsResult['fields'] = {};
  if (bestUsername) fields.username = toField('username', bestUsername.c, bestUsername.score);
  if (bestPassword) fields.password = toField('password', bestPassword.c, bestPassword.score);
  if (bestTotp) fields.totp = toField('totp', bestTotp.c, bestTotp.score);
  if (bestSubmit) fields.submit = toField('submit', bestSubmit.c, bestSubmit.score);

  const candidates: DetectedLoginField[] = [];
  for (const item of scoredUsername.slice(0, 3)) candidates.push(toField('username', item.c, item.score));
  for (const item of scoredPasswords.slice(0, 3)) candidates.push(toField('password', item.c, item.score));
  for (const item of scoredTotp.slice(0, 2)) candidates.push(toField('totp', item.c, item.score));
  for (const item of scoredSubmit.slice(0, 2)) candidates.push(toField('submit', item.c, item.score));

  return {
    url,
    host,
    step: classifyLoginStep(fields),
    fields,
    candidates,
  };
}

/**
 * 构造隔离世界扫描脚本。
 * 纯只读 DOM 遍历，不写任何 window 属性或 DOM 标记；支持 open Shadow DOM 与同源 iframe。
 */
export function buildLoginFieldScanScript(): string {
  return `(() => {
    const out = [];
    const seen = new Set();
    let order = 0;

    const cssEsc = (value) => {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
      return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
    };

    const attrEsc = (value) => String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');

    const isVisible = (el) => {
      if (!el || el.disabled) return false;
      const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
      if (style) {
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };

    const labelFor = (el) => {
      const parts = [];
      const doc = el.ownerDocument;
      if (el.id && doc) {
        try {
          const linked = doc.querySelector('label[for="' + attrEsc(el.id) + '"]');
          if (linked && linked.textContent) parts.push(linked.textContent.trim());
        } catch {}
      }
      const parentLabel = el.closest ? el.closest('label') : null;
      if (parentLabel && parentLabel.textContent) parts.push(parentLabel.textContent.trim());
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy && doc) {
        for (const id of labelledBy.split(/\\s+/)) {
          const ref = doc.getElementById(id);
          if (ref && ref.textContent) parts.push(ref.textContent.trim());
        }
      }
      return parts.join(' ').replace(/\\s+/g, ' ').trim();
    };

    const uniqueSelector = (root, el) => {
      const tag = el.tagName.toLowerCase();
      const test = (sel) => {
        try {
          const matches = root.querySelectorAll(sel);
          return matches.length === 1 && matches[0] === el;
        } catch {
          return false;
        }
      };
      if (el.id && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(el.id)) {
        const s = '#' + cssEsc(el.id);
        if (test(s)) return s;
      }
      for (const attr of ['data-testid', 'data-test', 'data-qa']) {
        const val = el.getAttribute(attr);
        if (val) {
          const s = tag + '[' + attr + '="' + attrEsc(val) + '"]';
          if (test(s)) return s;
        }
      }
      const name = el.getAttribute('name');
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (name) {
        const s1 = tag + '[name="' + attrEsc(name) + '"]' + (type ? '[type="' + attrEsc(type) + '"]' : '');
        if (test(s1)) return s1;
        const s2 = tag + '[name="' + attrEsc(name) + '"]';
        if (test(s2)) return s2;
      }
      const ac = el.getAttribute('autocomplete');
      if (ac && ac !== 'off' && ac !== 'on') {
        const s = tag + '[autocomplete="' + attrEsc(ac) + '"]';
        if (test(s)) return s;
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) {
        const s = tag + '[placeholder="' + attrEsc(placeholder) + '"]';
        if (test(s)) return s;
      }
      if (tag === 'input' && type) {
        const s = 'input[type="' + attrEsc(type) + '"]';
        if (test(s)) return s;
      }
      const segs = [];
      let cur = el;
      for (let depth = 0; cur && depth < 5 && cur.nodeType === 1; depth += 1) {
        const t = cur.tagName.toLowerCase();
        if (cur.id) {
          segs.unshift('#' + cssEsc(cur.id));
          break;
        }
        let idx = 1;
        let sib = cur.previousElementSibling;
        while (sib) {
          if (sib.tagName === cur.tagName) idx += 1;
          sib = sib.previousElementSibling;
        }
        segs.unshift(t + ':nth-of-type(' + idx + ')');
        cur = cur.parentElement;
      }
      return segs.join(' > ') || tag;
    };

    const formKeys = new WeakMap();
    let formSeq = 0;
    const formKeyOf = (el) => {
      const form = el.form || (el.closest ? el.closest('form') : null);
      if (!form) return '';
      if (!formKeys.has(form)) formKeys.set(form, 'f' + (++formSeq));
      return formKeys.get(form);
    };

    const walk = (root, inShadow, inSameOriginFrame, offsetX, offsetY) => {
      if (!root) return;
      let controls = [];
      try {
        controls = Array.from(root.querySelectorAll('input, button, [role="button"]'));
      } catch {
        controls = [];
      }
      for (const el of controls) {
        if (seen.has(el) || !isVisible(el)) continue;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : (el.getAttribute('type') || '').toLowerCase();
        out.push({
          tag,
          type,
          role: (el.getAttribute('role') || '').toLowerCase(),
          autocomplete: el.getAttribute('autocomplete') || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          labelText: labelFor(el),
          text: (el.innerText || el.textContent || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
          inputMode: (el.getAttribute('inputmode') || '').toLowerCase(),
          maxLength: typeof el.maxLength === 'number' && el.maxLength > 0 ? el.maxLength : 0,
          formKey: formKeyOf(el),
          selector: uniqueSelector(root, el),
          inShadow,
          inSameOriginFrame,
          rect: {
            x: Math.round(rect.x + offsetX),
            y: Math.round(rect.y + offsetY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          order: order++,
        });
      }
      let all = [];
      try {
        all = Array.from(root.querySelectorAll('*'));
      } catch {
        all = [];
      }
      for (const el of all) {
        if (el.shadowRoot) {
          walk(el.shadowRoot, true, inSameOriginFrame, offsetX, offsetY);
        }
        if (el.tagName === 'IFRAME') {
          try {
            const doc = el.contentDocument;
            if (doc) {
              const r = el.getBoundingClientRect();
              walk(doc, inShadow, true, offsetX + r.x, offsetY + r.y);
            }
          } catch {}
        }
      }
    };

    walk(document, false, false, 0, 0);
    return out;
  })()`;
}

async function scanSession(
  ctx: PageContext,
  sessionId: string | undefined,
  frameId: string | undefined,
  inCrossOriginFrame: boolean,
): Promise<RawScannedControl[]> {
  try {
    let targetFrameId = frameId;
    if (!targetFrameId) {
      const tree = await ctx.sendOn<{ frameTree?: { frame?: { id?: string } } }>(sessionId, 'Page.getFrameTree');
      targetFrameId = tree?.frameTree?.frame?.id;
    }
    if (!targetFrameId) return [];
    const world = await ctx.sendOn<{ executionContextId?: number }>(sessionId, 'Page.createIsolatedWorld', {
      frameId: targetFrameId,
      worldName: 'warren-login-detect',
    });
    if (typeof world?.executionContextId !== 'number') return [];
    const evalRes = await ctx.sendOn<{ result?: { value?: RawScannedControl[] } }>(sessionId, 'Runtime.evaluate', {
      contextId: world.executionContextId,
      expression: buildLoginFieldScanScript(),
      returnByValue: true,
    });
    const list = Array.isArray(evalRes?.result?.value) ? evalRes.result.value : [];
    return list.map((item) => ({
      ...item,
      frameId: targetFrameId,
      inCrossOriginFrame,
    }));
  } catch {
    return [];
  }
}

/** 扫描当前页面（主文档 + open Shadow DOM + 同源/跨源 iframe）并识别登录表单字段。 */
export async function detectLoginFields(ctx: PageContext): Promise<DetectedLoginFieldsResult> {
  const url = ctx.wc.getURL();
  const mainControls = await scanSession(ctx, undefined, undefined, false);
  const childLists = await Promise.all(
    ctx.childSessions().map((child) => scanSession(ctx, child.sessionId, child.frameId, true)),
  );
  const merged = [...mainControls, ...childLists.flat()];
  return selectLoginFields(url, merged);
}
