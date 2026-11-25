/**
 * 选择器字符串解析 + Target 归一。纯函数，可单测。
 *
 * 支持（按序试）：`@21`/`ref=21`、`text=`（引号精确否则模糊）、`loc=css:/role:/href:`、
 * `xpath=`、`css=`、裸 CSS、末尾 `>> nth=N`（-1=末个）、末尾 `:has-text/:text-is`。
 * 解析失败抛 BAD_SELECTOR，不猜。
 */
export type NormalizedTarget =
  | { kind: 'ref'; ref: string; nth?: number }
  | { kind: 'role'; role: string; name?: string; nameExact?: boolean; nth?: number }
  | { kind: 'text'; text: string; exact?: boolean; nth?: number }
  | { kind: 'label'; text: string; nth?: number }
  | { kind: 'selector'; selector: string; hasText?: string; textIs?: string; nth?: number }
  | { kind: 'xpath'; xpath: string; nth?: number }
  | { kind: 'href'; href: string; nth?: number };

function fail(input: string, reason: string): never {
  throw Object.assign(new Error(`BAD_SELECTOR ${reason}: ${input}`), { code: 'BAD_SELECTOR' });
}

/** 剥末尾 `>> nth=N`。 */
function splitNth(input: string): { body: string; nth?: number } {
  const m = input.match(/^(.*)\s*>>\s*nth=(-?\d+)\s*$/);
  if (!m) return { body: input };
  const nth = Number(m[2]);
  if (!Number.isInteger(nth) || nth < -1) fail(input, 'nth 非法（-1 或非负整数）');
  return { body: m[1].trim(), nth };
}

/** 剥末尾 `:has-text("x")` / `:text-is("x")`。只做末尾形（Ego 子集）。 */
function splitTextFilter(body: string): { body: string; hasText?: string; textIs?: string } {
  const m = body.match(/^(.*):(has-text|text-is)\(\s*"((?:[^"\\]|\\.)*)"\s*\)\s*$/);
  if (!m) return { body };
  const value = m[3].replace(/\\"/g, '"');
  if (!value) fail(body, '空文本过滤');
  return m[2] === 'has-text' ? { body: m[1].trim(), hasText: value } : { body: m[1].trim(), textIs: value };
}

function unquote(s: string): { value: string; exact: boolean } {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return { value: t.slice(1, -1), exact: true };
  }
  return { value: t, exact: false };
}

export function parseSelector(input: string): NormalizedTarget {
  if (typeof input !== 'string' || !input.trim()) fail(String(input), '空选择器');
  const { body: nthBody, nth } = splitNth(input.trim());
  const { body, hasText, textIs } = splitTextFilter(nthBody);

  // @21 / ref=21
  if (/^@\d+$/.test(body)) return { kind: 'ref', ref: body, nth };
  const refM = body.match(/^ref=(\d+)$/);
  if (refM) return { kind: 'ref', ref: `@${refM[1]}`, nth };

  // text=...
  if (body.startsWith('text=')) {
    const { value, exact } = unquote(body.slice(5));
    if (!value) fail(input, 'text 为空');
    return { kind: 'text', text: value, exact, nth };
  }

  // xpath=...
  if (body.startsWith('xpath=')) {
    const xpath = body.slice(6).trim();
    if (!xpath) fail(input, 'xpath 为空');
    return { kind: 'xpath', xpath, nth };
  }

  // css=...
  if (body.startsWith('css=')) {
    const selector = body.slice(4).trim();
    if (!selector) fail(input, 'css 为空');
    return { kind: 'selector', selector, hasText, textIs, nth };
  }

  // loc=...
  if (body.startsWith('loc=')) {
    const rest = body.slice(4);
    if (rest.startsWith('css:')) {
      const selector = rest.slice(4).trim();
      if (!selector) fail(input, 'loc=css 为空');
      return { kind: 'selector', selector, hasText, textIs, nth };
    }
    if (rest.startsWith('href:')) {
      const href = rest.slice(5).trim();
      if (!href) fail(input, 'loc=href 为空');
      return { kind: 'href', href, nth };
    }
    if (rest.startsWith('role:')) {
      // loc=role:button[name="Sign in"] / [name*="Sign"]
      const m = rest.slice(5).match(/^([A-Za-z]+)(?:\[name(\*?)=["']((?:[^"'\\]|\\.)*)["']\])?$/);
      if (!m) fail(input, 'loc=role 格式非法');
      return {
        kind: 'role',
        role: m[1],
        name: m[3] ? m[3].replace(/\\"/g, '"') : undefined,
        nameExact: m[3] ? m[2] !== '*' : undefined,
        nth,
      };
    }
    fail(input, 'loc= 只支持 css:/role:/href:');
  }

  // 裸 CSS（含末尾文本过滤）
  if (!body) fail(input, '空选择器');
  return { kind: 'selector', selector: body, hasText, textIs, nth };
}

/**
 * 老 Target 对象归一：`{kind:role/text/label/selector/ref/xpath}` 原样过；
 * 字符串走 parseSelector。
 */
export function normalizeTarget(input: unknown): NormalizedTarget {
  if (typeof input === 'string') return parseSelector(input);
  if (input && typeof input === 'object') {
    const t = input as Record<string, unknown>;
    if (t.kind === 'role' && typeof t.role === 'string') {
      return { kind: 'role', role: t.role, name: typeof t.name === 'string' ? t.name : undefined };
    }
    if (t.kind === 'text' && typeof t.text === 'string') return { kind: 'text', text: t.text };
    if (t.kind === 'label' && typeof t.text === 'string') return { kind: 'label', text: t.text };
    if (t.kind === 'selector' && typeof t.selector === 'string') {
      return { kind: 'selector', selector: t.selector };
    }
    if (t.kind === 'ref' && typeof t.ref === 'string') return parseSelector(t.ref);
    if (t.kind === 'xpath' && typeof t.xpath === 'string') return { kind: 'xpath', xpath: t.xpath };
  }
  return fail(JSON.stringify(input), 'Target 非法');
}

/** nth 挑选：第 N 个（-1=末个），越界抛 TARGET_NOT_FOUND。 */
export function pickNth<T>(items: T[], nth: number | undefined, what: string): T {
  if (nth === undefined) return items[0];
  const index = nth === -1 ? items.length - 1 : nth;
  const item = items[index];
  if (item === undefined) {
    throw Object.assign(new Error(`${what}: nth=${nth} 越界（共 ${items.length} 个）`), {
      code: 'TARGET_NOT_FOUND',
    });
  }
  return item;
}

/** 多匹配报歧义：带 count + 前 3 候选。 */
export function assertUnique<T extends { role: string; name: string }>(items: T[], input: string): T {
  if (items.length === 0) {
    throw Object.assign(new Error(`target not found: ${input}`), { code: 'TARGET_NOT_FOUND' });
  }
  if (items.length > 1) {
    const preview = items
      .slice(0, 3)
      .map((i) => `${i.role}“${i.name.slice(0, 24)}”`)
      .join(' / ');
    throw Object.assign(
      new Error(`target ambiguous: ${items.length} 个匹配（${preview}），加 >> nth=N 或换定位：${input}`),
      {
        code: 'TARGET_AMBIGUOUS',
      },
    );
  }
  return items[0];
}
