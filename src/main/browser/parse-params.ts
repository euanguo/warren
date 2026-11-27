/**
 * RPC 与插件宿主共用运行时入参校验/解析器。
 *
 * 将跨边界的 `unknown` 入参在入口处收敛为强类型契约，消灭各层散落的 `as never` 与盲转。
 */
import type { SQLInputValue } from 'node:sqlite';
import type {
  DragOptions,
  FetchOptions,
  FillOptions,
  LoadState,
  NavigateOptions,
  ScreenshotOptions,
  SelectValue,
  SelectorState,
  SnapshotOptions,
  SnapshotScope,
  TargetInput,
  UrlMatcher,
  WaitEventKind,
  WaitPredicate,
} from '../../shared/types.ts';
import type { CookieInput } from './cookies.ts';
import { richErr } from './errors.ts';
import type { MouseButton } from './input.ts';
import type { EmulationSetting } from './ops/emulation.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined;
    out[key] = item;
  }
  return out;
}

/** 校验并归一元素定位目标（兼容历史上 RPC 对象传递的 `kind: 'css'`）。 */
export function asTargetInput(raw: unknown): TargetInput {
  if (typeof raw === 'string') return raw;
  if (isRecord(raw)) {
    const kind = raw.kind;
    if (kind === 'role' && typeof raw.role === 'string') {
      return { kind: 'role', role: raw.role, ...(typeof raw.name === 'string' ? { name: raw.name } : {}) };
    }
    if (kind === 'text' && typeof raw.text === 'string') return { kind: 'text', text: raw.text };
    if (kind === 'label' && typeof raw.text === 'string') return { kind: 'label', text: raw.text };
    if ((kind === 'selector' || kind === 'css') && typeof raw.selector === 'string') {
      return { kind: 'selector', selector: raw.selector };
    }
    if (kind === 'ref' && typeof raw.ref === 'string') return { kind: 'ref', ref: raw.ref };
    if (kind === 'xpath' && typeof raw.xpath === 'string') return { kind: 'xpath', xpath: raw.xpath };
  }
  throw richErr('BAD_SELECTOR', `非法的目标定位器: ${JSON.stringify(raw)}`);
}

export function asOptionalTargetInput(raw: unknown): TargetInput | undefined {
  return raw === undefined ? undefined : asTargetInput(raw);
}

export function asMouseButton(raw: unknown): MouseButton | undefined {
  return raw === 'left' || raw === 'middle' || raw === 'right' ? raw : undefined;
}

export function asNavigateOptions(raw: unknown): NavigateOptions {
  if (!isRecord(raw)) return {};
  return {
    referer: typeof raw.referer === 'string' ? raw.referer : undefined,
    timeoutMs: asFiniteNumber(raw.timeoutMs),
    waitUntil:
      raw.waitUntil === 'commit' ||
      raw.waitUntil === 'domcontentloaded' ||
      raw.waitUntil === 'load' ||
      raw.waitUntil === 'networkidle'
        ? raw.waitUntil
        : undefined,
  };
}

export function asClickOptions(raw: unknown): DragOptions {
  if (!isRecord(raw)) return {};
  const posRaw = raw.position;
  const position =
    isRecord(posRaw) && asFiniteNumber(posRaw.x) !== undefined && asFiniteNumber(posRaw.y) !== undefined
      ? { x: Number(posRaw.x), y: Number(posRaw.y) }
      : undefined;
  return {
    button: asMouseButton(raw.button),
    clickCount: asFiniteNumber(raw.clickCount),
    delay: asFiniteNumber(raw.delay),
    position,
    timeoutMs: asFiniteNumber(raw.timeoutMs),
    label: typeof raw.label === 'string' ? raw.label : undefined,
    steps: asFiniteNumber(raw.steps),
    noWaitAfter: Boolean(raw.noWaitAfter),
    navigationTimeoutMs: asFiniteNumber(raw.navigationTimeoutMs),
    ...(raw.humanize !== undefined ? { humanize: Boolean(raw.humanize) } : {}),
    ...(raw.newTab ? { newTab: true } : {}),
    ...(raw.placement === 'before' || raw.placement === 'after' || raw.placement === 'center'
      ? { placement: raw.placement }
      : {}),
  };
}

export function asFillOptions(raw: unknown): FillOptions {
  if (!isRecord(raw)) return {};
  return {
    clearFirst: raw.clearFirst === undefined ? undefined : Boolean(raw.clearFirst),
    timeoutMs: asFiniteNumber(raw.timeoutMs),
    submit: Boolean(raw.submit),
    ...(raw.isSecret !== undefined ? { isSecret: Boolean(raw.isSecret) } : {}),
  };
}

export function asFocusOptions(raw: unknown): { timeoutMs?: number } {
  if (!isRecord(raw)) return {};
  return { timeoutMs: asFiniteNumber(raw.timeoutMs) };
}

type SelectSingleItem = string | { value?: string; label?: string; index?: number };

function asSelectSingleItem(raw: unknown): SelectSingleItem {
  if (typeof raw === 'string') return raw;
  if (isRecord(raw)) {
    const out: { value?: string; label?: string; index?: number } = {};
    if (typeof raw.value === 'string') out.value = raw.value;
    if (typeof raw.label === 'string') out.label = raw.label;
    if (typeof raw.index === 'number' && Number.isFinite(raw.index)) out.index = raw.index;
    if (out.value !== undefined || out.label !== undefined || out.index !== undefined) return out;
  }
  throw richErr('BAD_REQUEST', 'selectOption 的选项格式非法');
}

export function asSelectValue(raw: unknown): SelectValue {
  if (raw === null) return null;
  if (Array.isArray(raw)) return raw.map(asSelectSingleItem);
  return asSelectSingleItem(raw);
}

export function asStringArray(raw: unknown, field = 'paths'): string[] {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    throw richErr('BAD_REQUEST', `${field} 必须是字符串数组`);
  }
  return raw;
}

export function asStringOrList(raw: unknown, field = 'paths'): string | string[] {
  if (typeof raw === 'string') return raw;
  return asStringArray(raw, field);
}

export function asPasteContent(raw: unknown): string | { text: string; html?: string } {
  if (typeof raw === 'string') return raw;
  if (isRecord(raw) && typeof raw.text === 'string') {
    return {
      text: raw.text,
      ...(typeof raw.html === 'string' ? { html: raw.html } : {}),
    };
  }
  throw richErr('BAD_REQUEST', 'keyboardPaste 需要字符串或 { text, html? }');
}

export function asFetchOptions(raw: unknown): FetchOptions {
  if (!isRecord(raw)) return {};
  const cacheValues = ['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached'] as const;
  const cache = cacheValues.includes(raw.cache as (typeof cacheValues)[number])
    ? (raw.cache as RequestCache)
    : undefined;
  return {
    method: typeof raw.method === 'string' ? raw.method : undefined,
    headers: asStringMap(raw.headers),
    body: typeof raw.body === 'string' ? raw.body : undefined,
    cache,
    timeoutMs: asFiniteNumber(raw.timeoutMs),
    credentials: raw.credentials === 'omit' || raw.credentials === 'include' ? raw.credentials : undefined,
    saveAs: typeof raw.saveAs === 'string' ? raw.saveAs : undefined,
  };
}

export function asSelectorState(raw: unknown): SelectorState | undefined {
  if (raw === undefined) return undefined;
  if (
    raw === 'attached' ||
    raw === 'detached' ||
    raw === 'visible' ||
    raw === 'hidden' ||
    raw === 'enabled' ||
    raw === 'disabled'
  ) {
    return raw;
  }
  throw richErr('BAD_REQUEST', `非法的等待状态 state: ${String(raw)}`);
}

export function asLoadState(raw: unknown): LoadState {
  if (raw === undefined) return 'load';
  if (raw === 'commit' || raw === 'domcontentloaded' || raw === 'load' || raw === 'networkidle') return raw;
  throw richErr('BAD_REQUEST', `非法的加载状态 loadState: ${String(raw)}`);
}

export function asWaitEventKind(raw: unknown): WaitEventKind {
  if (raw === 'popup' || raw === 'download' || raw === 'dialog' || raw === 'fileChooser') return raw;
  throw richErr('BAD_REQUEST', `非法的等待事件类型: ${String(raw)}`);
}

export function asUrlMatcher(raw: unknown): UrlMatcher {
  if (typeof raw === 'string') return raw;
  if (isRecord(raw)) {
    if (typeof raw.regex === 'string') return { regex: raw.regex };
    if (typeof raw.glob === 'string') return { glob: raw.glob };
  }
  throw richErr('BAD_REQUEST', 'url matcher 必须是字符串、{ regex } 或 { glob }');
}

export function asWaitPredicate(raw: unknown): WaitPredicate {
  if (!isRecord(raw)) throw richErr('BAD_REQUEST', 'waitFor 的 predicate 必须是对象');
  const out: WaitPredicate = {};
  if (typeof raw.text === 'string') out.text = raw.text;
  if (typeof raw.role === 'string') out.role = raw.role;
  if (typeof raw.selector === 'string') out.selector = raw.selector;
  if (raw.url !== undefined) out.url = asUrlMatcher(raw.url);
  if (typeof raw.function === 'string') out.function = raw.function;
  if ('functionArg' in raw) out.functionArg = raw.functionArg;
  if (raw.loadState !== undefined) out.loadState = asLoadState(raw.loadState);
  if (raw.event !== undefined) out.event = asWaitEventKind(raw.event);
  return out;
}

export function asWaitOptions(raw: unknown): {
  timeoutMs?: number;
  state?: SelectorState;
  polling?: number;
  idleMs?: number;
} {
  if (!isRecord(raw)) return {};
  return {
    timeoutMs: asFiniteNumber(raw.timeoutMs),
    ...(raw.state !== undefined ? { state: asSelectorState(raw.state) } : {}),
    polling: asFiniteNumber(raw.polling),
    idleMs: asFiniteNumber(raw.idleMs),
  };
}

export function asSnapshotOptions(raw: unknown): SnapshotOptions {
  if (!isRecord(raw)) return {};
  const scope: SnapshotScope | undefined =
    raw.scope === 'viewport' || raw.scope === 'full_page' || raw.scope === 'subtree' ? raw.scope : undefined;
  return {
    scope,
    root: typeof raw.root === 'string' ? raw.root : undefined,
    limit: asFiniteNumber(raw.limit),
    includeActionMarks: Boolean(raw.includeActionMarks),
    includeStableLocator: Boolean(raw.includeStableLocator),
    interactiveOnly: Boolean(raw.interactiveOnly),
    roles: Array.isArray(raw.roles) ? raw.roles.filter((r): r is string => typeof r === 'string') : undefined,
    selector: typeof raw.selector === 'string' ? raw.selector : undefined,
    urls: Boolean(raw.urls),
    includeCursor: raw.includeCursor === undefined ? undefined : Boolean(raw.includeCursor),
    boxes: Boolean(raw.boxes),
    maxDepth: asFiniteNumber(raw.maxDepth),
    maxTokens: asFiniteNumber(raw.maxTokens),
    filter: typeof raw.filter === 'string' ? raw.filter : undefined,
    frame: typeof raw.frame === 'string' ? raw.frame : undefined,
    noFold: Boolean(raw.noFold),
  };
}

export function asScreenshotOptions(raw: unknown): ScreenshotOptions {
  if (!isRecord(raw)) return {};
  let clip: ScreenshotOptions['clip'];
  if (raw.clip !== undefined) {
    if (!isRecord(raw.clip)) throw richErr('BAD_REQUEST', 'screenshot clip 必须是对象');
    const x = asFiniteNumber(raw.clip.x);
    const y = asFiniteNumber(raw.clip.y);
    const width = asFiniteNumber(raw.clip.width);
    const height = asFiniteNumber(raw.clip.height);
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      throw richErr('BAD_REQUEST', 'screenshot clip 需要有限数值 x/y/width/height');
    }
    clip = { x, y, width, height };
  }
  return {
    format: raw.format === 'jpeg' ? 'jpeg' : raw.format === 'png' ? 'png' : undefined,
    fullPage: Boolean(raw.fullPage),
    clip,
    path: typeof raw.path === 'string' ? raw.path : undefined,
    encoding: raw.encoding === 'base64' ? 'base64' : undefined,
    annotate: Boolean(raw.annotate),
  };
}

export function asEmulationSetting(raw: unknown): EmulationSetting {
  if (!isRecord(raw) || typeof raw.kind !== 'string') {
    throw richErr('BAD_REQUEST', 'browser.set 需要含 kind 的对象');
  }
  switch (raw.kind) {
    case 'viewport': {
      const width = asFiniteNumber(raw.width);
      const height = asFiniteNumber(raw.height);
      if (width === undefined || height === undefined) {
        throw richErr('BAD_REQUEST', 'viewport 需要数值 width 与 height');
      }
      return {
        kind: 'viewport',
        width,
        height,
        dpr: asFiniteNumber(raw.dpr),
        mobile: raw.mobile === undefined ? undefined : Boolean(raw.mobile),
      };
    }
    case 'device':
      if (typeof raw.device !== 'string' || !raw.device.trim()) {
        throw richErr('BAD_REQUEST', 'device 需要设备名');
      }
      return { kind: 'device', device: raw.device };
    case 'geo': {
      const latitude = asFiniteNumber(raw.latitude);
      const longitude = asFiniteNumber(raw.longitude);
      if (latitude === undefined || longitude === undefined) {
        throw richErr('BAD_REQUEST', 'geo 需要合法的 latitude 与 longitude');
      }
      return { kind: 'geo', latitude, longitude, accuracy: asFiniteNumber(raw.accuracy) };
    }
    case 'offline':
      return { kind: 'offline', offline: Boolean(raw.offline) };
    case 'headers': {
      const headers = asStringMap(raw.headers);
      if (!headers) throw richErr('BAD_REQUEST', 'headers 需要键值对对象');
      return { kind: 'headers', headers };
    }
    case 'media': {
      const colorScheme =
        raw.colorScheme === 'dark' || raw.colorScheme === 'light' || raw.colorScheme === 'no-preference'
          ? raw.colorScheme
          : undefined;
      const reducedMotion =
        raw.reducedMotion === 'reduce' || raw.reducedMotion === 'no-preference' ? raw.reducedMotion : undefined;
      return { kind: 'media', colorScheme, reducedMotion };
    }
    case 'tz':
      if (typeof raw.timezoneId !== 'string') throw richErr('BAD_REQUEST', 'tz 需要 timezoneId 字符串');
      return { kind: 'tz', timezoneId: raw.timezoneId };
    case 'locale':
      if (typeof raw.locale !== 'string') throw richErr('BAD_REQUEST', 'locale 需要 locale 字符串');
      return { kind: 'locale', locale: raw.locale };
    case 'reset':
      return { kind: 'reset' };
    default:
      throw richErr('BAD_REQUEST', `未知的 browser.set kind: ${raw.kind}`);
  }
}

export function asCookieInputs(raw: unknown): CookieInput[] {
  if (!Array.isArray(raw)) throw richErr('PLUGIN_BAD_REQUEST', 'cookies 必须是数组');
  return raw.map((item, idx) => {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.value !== 'string' ||
      typeof item.domain !== 'string'
    ) {
      throw richErr('PLUGIN_BAD_REQUEST', `cookies[${idx}] 缺少 name/value/domain 字符串`);
    }
    return {
      name: item.name,
      value: item.value,
      domain: item.domain,
      ...(typeof item.path === 'string' ? { path: item.path } : {}),
      ...(typeof item.secure === 'boolean' ? { secure: item.secure } : {}),
      ...(typeof item.httpOnly === 'boolean' ? { httpOnly: item.httpOnly } : {}),
      ...(typeof item.expirationDate === 'number' && Number.isFinite(item.expirationDate)
        ? { expirationDate: item.expirationDate }
        : {}),
    };
  });
}

export function asSqlParams(raw: unknown): SQLInputValue[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw richErr('PLUGIN_BAD_REQUEST', 'SQL params 必须是数组');
  return raw.map((v, idx) => {
    if (
      v === null ||
      typeof v === 'number' ||
      typeof v === 'bigint' ||
      typeof v === 'string' ||
      ArrayBuffer.isView(v)
    ) {
      return v as SQLInputValue;
    }
    if (v === undefined) return null;
    throw richErr('PLUGIN_BAD_REQUEST', `SQL params[${idx}] 类型不支持`);
  });
}
