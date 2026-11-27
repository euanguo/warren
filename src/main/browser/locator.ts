/**
 * 浏览器定位与坐标解析器：
 * - 多 frame / Shadow DOM（含 Closed Shadow 兜底）/ XPath / AX 语义目标解析；
 * - 元素在主视口内的精准落点 / 矩形盒计算与 OOPIF 偏移叠加；
 * - 遮挡元素的 AX 语义 + DOM 描述、Overlay 高亮及坐标探针。
 */
import type { AxNode, TargetInput } from '../../shared/types.ts';
import {
  buildHierarchicalAxNodes,
  invalidateAxTreeCache,
  readAxFrames,
  readAxNodes,
  sessionOfAxNode,
} from './ax-tree.ts';
import { describeDomNode, localQuadClickPoint } from './click-point.ts';
import type { PageContext } from './ctx.ts';
import { richErr } from './errors.ts';
import { evalOnNode, nodeIdFor, pageError, resolveTarget } from './page-helpers.ts';
import { assertUnique, normalizeTarget, pickNth, type NormalizedTarget } from './target.ts';

/** 按 WebContents id 缓存各 CDP 会话的隔离世界上下文 id。 */
const worldCtxCache = new Map<number, Map<string, number>>();

/** 导航/销毁后丢掉 AX 树缓存与隔离世界上下文映射，别把上一页的结构喂给下一步。 */
export function invalidateAxCache(wcId: number): void {
  invalidateAxTreeCache(wcId);
  worldCtxCache.delete(wcId);
}

const DESCRIBE_CONCURRENCY = 16;

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = Array.from<R>({ length: items.length });
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) break;
        results[index] = await fn(items[index]!, index);
      }
    }),
  );
  return results;
}

/**
 * 选择器遍历的页面内脚本（零全局状态）：
 * - 直接返回匹配元素数组（远程 objectId），彻底消除 `window.__warrenMatches` 并发覆盖与 N+1 逐项 evaluate；
 * - 若传入 `hasText` / `textIs`，在隔离世界内一次性过滤，免去每个候选节点 3 次 CDP 往返；
 * - 错误以 `__WARREN_ERR__:<kind>:<msg>` 字符串返回。
 */
function selectorWalkScript(selector: string, filter?: { hasText?: string; textIs?: string }): string {
  return `(() => {
    const sel = ${JSON.stringify(selector)};
    const hasText = ${JSON.stringify(filter?.hasText ?? null)};
    const textIs = ${JSON.stringify(filter?.textIs ?? null)};
    const describe = (e) => String((e && (e.message || e.name)) || e);
    try {
      document.querySelector(sel);
    } catch (e) {
      const kind = e && e.name === 'SyntaxError' ? 'syntax' : 'other';
      return '__WARREN_ERR__:' + kind + ':' + describe(e);
    }
    const out = [];
    const matchText = (el) => {
      if (hasText === null && textIs === null) return true;
      const t = String(el.innerText ?? el.textContent ?? '');
      if (hasText !== null && !t.includes(hasText)) return false;
      if (textIs !== null && t.trim() !== textIs) return false;
      return true;
    };
    const walk = (root) => {
      let matches;
      try {
        matches = root.querySelectorAll(sel);
      } catch {
        return;
      }
      // 逐个 push，不用 push(...matches)：匹配数上十万时展开实参会撑爆调用栈（实测 RangeError）
      for (const el of matches) {
        if (matchText(el)) out.push(el);
      }
      let all;
      try {
        all = root.querySelectorAll('*');
      } catch {
        return;
      }
      for (const el of all) {
        let shadow = null;
        try {
          shadow = el.shadowRoot;
        } catch {}
        if (shadow) walk(shadow);
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {}
        if (doc) walk(doc);
      }
    };
    try {
      walk(document);
    } catch (e) {
      return '__WARREN_ERR__:other:' + describe(e);
    }
    return out;
  })()`;
}

function targetSessions(ctx: PageContext): Array<string | undefined> {
  const children = ctx.childSessions();
  const activeFrameId = ctx.activeFrameId?.();
  if (activeFrameId) {
    const matchedChild = children.find((c) => c.frameId === activeFrameId);
    if (matchedChild) return [matchedChild.sessionId];
    return [undefined];
  }
  return [undefined, ...children.map((c) => c.sessionId)];
}

async function isolatedContext(ctx: PageContext, sessionId?: string): Promise<number> {
  let map = worldCtxCache.get(ctx.wc.id);
  if (!map) {
    map = new Map();
    worldCtxCache.set(ctx.wc.id, map);
  }
  const activeFrameId = !sessionId ? ctx.activeFrameId?.() : undefined;
  const key = `${sessionId ?? ''}:${activeFrameId ?? ''}`;
  const cached = map.get(key);
  if (cached !== undefined) return cached;
  let frameId = activeFrameId;
  if (!frameId) {
    const { frameTree } = await ctx.sendOn<{ frameTree: { frame: { id: string } } }>(sessionId, 'Page.getFrameTree');
    frameId = frameTree.frame.id;
  }
  const { executionContextId } = await ctx.sendOn<{ executionContextId: number }>(
    sessionId,
    'Page.createIsolatedWorld',
    { frameId, worldName: 'warren' },
  );
  map.set(key, executionContextId);
  return executionContextId;
}

/**
 * 单次 `Runtime.getProperties` 批量拆出数组内所有元素 `objectId`，
 * 再以有界并发（16）执行 `DOM.describeNode` + `Runtime.releaseObject`，替代 N+1 串行往返。
 */
async function backendIdsFromArrayObject(
  ctx: PageContext,
  arrayObjectId: string,
  sessionId?: string,
): Promise<number[]> {
  let elementRefs: Array<{ index: number; objectId: string }> = [];
  try {
    const props = await ctx
      .sendOn<{ result?: Array<{ name: string; value?: { objectId?: string } }> }>(sessionId, 'Runtime.getProperties', {
        objectId: arrayObjectId,
        ownProperties: true,
      })
      .catch(() => null);
    for (const prop of props?.result ?? []) {
      if (!/^\d+$/.test(prop.name)) continue;
      const objectId = prop.value?.objectId;
      if (objectId) elementRefs.push({ index: Number(prop.name), objectId });
    }
  } finally {
    await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: arrayObjectId }).catch(() => {});
  }
  elementRefs.sort((a, b) => a.index - b.index);
  const resolved = await mapConcurrent(elementRefs, DESCRIBE_CONCURRENCY, async ({ objectId }) => {
    try {
      const node = await ctx
        .sendOn<{ node?: { backendNodeId?: number } }>(sessionId, 'DOM.describeNode', { objectId })
        .catch(() => null);
      return typeof node?.node?.backendNodeId === 'number' ? node.node.backendNodeId : null;
    } finally {
      await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId }).catch(() => {});
    }
  });
  return resolved.filter((id): id is number => id !== null);
}

async function runSelectorWalk(
  ctx: PageContext,
  selector: string,
  filter: { hasText?: string; textIs?: string } | undefined,
  allowRetry: boolean,
  sessionId?: string,
): Promise<number[]> {
  const contextId = await isolatedContext(ctx, sessionId);
  let r: {
    result?: { type?: string; value?: unknown; objectId?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  try {
    r = await ctx.sendOn(sessionId, 'Runtime.evaluate', {
      contextId,
      expression: selectorWalkScript(selector, filter),
      returnByValue: false,
      awaitPromise: false,
    });
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (allowRetry && /context|destroyed|cannot find|target closed|session closed/i.test(message)) {
      worldCtxCache.get(ctx.wc.id)?.delete(sessionId ?? '');
      return runSelectorWalk(ctx, selector, filter, false, sessionId);
    }
    throw richErr('SELECTOR_EVAL_FAILED', `选择器求值失败（不是选择器非法）：${selector}；原始错误：${message}`);
  }
  if (r.exceptionDetails) {
    const message = pageError(r.exceptionDetails);
    if (allowRetry && /context|destroyed|cannot find|target closed|session closed/i.test(message)) {
      worldCtxCache.get(ctx.wc.id)?.delete(sessionId ?? '');
      return runSelectorWalk(ctx, selector, filter, false, sessionId);
    }
    throw richErr('SELECTOR_EVAL_FAILED', `选择器求值失败（不是选择器非法）：${selector}；原始错误：${message}`);
  }
  if (
    r.result?.type === 'string' &&
    typeof r.result.value === 'string' &&
    r.result.value.startsWith('__WARREN_ERR__:')
  ) {
    const rest = r.result.value.slice('__WARREN_ERR__:'.length);
    const sep = rest.indexOf(':');
    const kind = sep >= 0 ? rest.slice(0, sep) : 'other';
    const detail = sep >= 0 ? rest.slice(sep + 1) : rest;
    if (kind === 'syntax') throw richErr('BAD_SELECTOR', `CSS 非法: ${selector}（${detail}）`);
    throw richErr('SELECTOR_EVAL_FAILED', `选择器求值失败（不是选择器非法）：${selector}；原始错误：${detail}`);
  }
  const arrayObjectId = r.result?.objectId;
  if (!arrayObjectId) {
    throw richErr('SELECTOR_EVAL_FAILED', `选择器求值失败（不是选择器非法）：${selector}；隔离世界没有返回结果数组`);
  }
  return backendIdsFromArrayObject(ctx, arrayObjectId, sessionId);
}

/**
 * Closed Shadow Root 兜底检索：利用 CDP `DOM.getDocument({ depth: -1, pierce: true })`
 * 遍历包含 `shadowRoots`（含 closed）的完整节点树，支持 `#id`、`.class`、`[attr="val"]` 与标签名匹配。
 */
async function pierceClosedShadowSelector(
  ctx: PageContext,
  selector: string,
): Promise<Array<{ backendNodeId: number; sessionId?: string }>> {
  const trimmed = selector.trim();
  if (!trimmed || /[\s>+~:,]/.test(trimmed)) return [];
  const idMatch = trimmed.match(/^#([A-Za-z0-9_-]+)$/);
  const classMatch = trimmed.match(/^\.([A-Za-z0-9_-]+)$/);
  const attrMatch = trimmed.match(/^\[([A-Za-z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/);
  const tagMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9-]*)$/);
  if (!idMatch && !classMatch && !attrMatch && !tagMatch) return [];

  const out: Array<{ backendNodeId: number; sessionId?: string }> = [];
  for (const sessionId of targetSessions(ctx)) {
    const doc = await ctx
      .sendOn<{ root?: Record<string, unknown> }>(sessionId, 'DOM.getDocument', { depth: -1, pierce: true })
      .catch(() => null);
    if (!doc?.root) continue;
    const walk = (node: Record<string, unknown> | undefined) => {
      if (!node || out.length >= 20) return;
      if (Number(node.nodeType ?? 0) === 1) {
        const nodeName = String(node.nodeName ?? '').toLowerCase();
        const attrs = Array.isArray(node.attributes) ? (node.attributes as string[]) : [];
        const getAttr = (k: string): string | undefined => {
          for (let i = 0; i < attrs.length - 1; i += 2) {
            if (attrs[i]?.toLowerCase() === k.toLowerCase()) return attrs[i + 1];
          }
          return undefined;
        };
        let matched = false;
        if (idMatch) matched = getAttr('id') === idMatch[1];
        else if (classMatch) matched = (getAttr('class') ?? '').split(/\s+/).includes(classMatch[1]!);
        else if (tagMatch) matched = nodeName === tagMatch[1]!.toLowerCase();
        else if (attrMatch) {
          const val = getAttr(attrMatch[1]!);
          const expected = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
          matched = expected === undefined ? val !== undefined : val === expected;
        }
        if (matched && typeof node.backendNodeId === 'number') {
          out.push({ backendNodeId: node.backendNodeId, sessionId });
        }
      }
      const children = Array.isArray(node.children) ? (node.children as Array<Record<string, unknown>>) : [];
      for (const c of children) walk(c);
      const shadows = Array.isArray(node.shadowRoots) ? (node.shadowRoots as Array<Record<string, unknown>>) : [];
      for (const s of shadows) walk(s);
      if (node.contentDocument && typeof node.contentDocument === 'object') {
        walk(node.contentDocument as Record<string, unknown>);
      }
    };
    walk(doc.root);
  }
  return out;
}

async function backendIdsBySelector(
  ctx: PageContext,
  selector: string,
  filter?: { hasText?: string; textIs?: string },
): Promise<{ items: Array<{ backendNodeId: number; sessionId?: string }>; fromClosedShadow: boolean }> {
  const all: Array<{ backendNodeId: number; sessionId?: string }> = [];
  let firstSyntaxError: unknown;
  for (const sessionId of targetSessions(ctx)) {
    try {
      const ids = await runSelectorWalk(ctx, selector, filter, true, sessionId);
      for (const backendNodeId of ids) all.push({ backendNodeId, sessionId });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'BAD_SELECTOR') {
        firstSyntaxError = error;
        break;
      }
      if (!sessionId) throw error;
    }
  }
  if (firstSyntaxError) throw firstSyntaxError;
  if (all.length === 0) {
    const pierced = await pierceClosedShadowSelector(ctx, selector);
    if (pierced.length > 0) return { items: pierced, fromClosedShadow: true };
  }
  return { items: all, fromClosedShadow: false };
}

async function backendIdForCss(
  ctx: PageContext,
  norm: { selector?: string; href?: string; hasText?: string; textIs?: string; nth?: number },
): Promise<{ backendNodeId: number; sessionId?: string }> {
  let selector = norm.selector ?? '';
  if (norm.href !== undefined) selector = `a[href*="${norm.href.replace(/"/g, '\\"')}"]`;
  const textFilter = norm.hasText || norm.textIs ? { hasText: norm.hasText, textIs: norm.textIs } : undefined;
  const { items: candidates, fromClosedShadow } = await backendIdsBySelector(ctx, selector, textFilter);
  if (candidates.length === 0) {
    if (textFilter) throw richErr('TARGET_NOT_FOUND', `selector 文本过滤无匹配: ${selector}`);
    throw richErr('TARGET_NOT_FOUND', `selector not found: ${selector}`);
  }
  let filtered = candidates;
  // 常规 DOM / Open Shadow 已在隔离世界完成文本过滤；仅 Closed Shadow 兜底路径需补做文本校验
  if (fromClosedShadow && textFilter) {
    filtered = [];
    for (const item of candidates) {
      const nodeId = await nodeIdFor(ctx, item.backendNodeId, item.sessionId).catch(() => 0);
      const text = nodeId
        ? await evalOnNode(ctx, nodeId, '(el) => (el.innerText ?? el.textContent ?? "")', item.sessionId).catch(
            () => '',
          )
        : '';
      const t = String(text ?? '');
      if (norm.hasText && t.includes(norm.hasText)) filtered.push(item);
      else if (norm.textIs && t.trim() === norm.textIs) filtered.push(item);
    }
    if (filtered.length === 0) throw richErr('TARGET_NOT_FOUND', `selector 文本过滤无匹配: ${selector}`);
  }
  if (filtered.length > 1 && norm.nth === undefined) {
    const preview: string[] = [];
    for (const item of filtered.slice(0, 3)) {
      const desc = await ctx
        .sendOn<{ node: { nodeName: string } }>(item.sessionId, 'DOM.describeNode', {
          backendNodeId: item.backendNodeId,
        })
        .catch(() => null);
      preview.push(desc ? String(desc.node.nodeName ?? '?').toLowerCase() : '?');
    }
    throw Object.assign(
      new Error(
        `target ambiguous: ${filtered.length} 个匹配（${preview.join(' / ')}），加 >> nth=N 或换定位：${selector}`,
      ),
      { code: 'TARGET_AMBIGUOUS' },
    );
  }
  return pickNth(filtered, norm.nth, selector);
}

async function xpathBackendIds(
  ctx: PageContext,
  xpath: string,
): Promise<Array<{ backendNodeId: number; sessionId?: string }>> {
  const all: Array<{ backendNodeId: number; sessionId?: string }> = [];
  for (const sessionId of targetSessions(ctx)) {
    let contextId: number;
    try {
      contextId = await isolatedContext(ctx, sessionId);
    } catch {
      if (!sessionId) throw richErr('BAD_SELECTOR', `xpath 非法: ${xpath}`);
      continue;
    }
    const evaluated = await ctx
      .sendOn<{ result?: { type?: string; value?: unknown; objectId?: string } }>(sessionId, 'Runtime.evaluate', {
        contextId,
        expression: `(() => {
           const xp = ${JSON.stringify(xpath)};
           try {
             const it = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
             const out = [];
             for (let i = 0; i < Math.min(it.snapshotLength, 50); i++) {
               const el = it.snapshotItem(i);
               if (el instanceof Element) out.push(el);
             }
             return out;
           } catch { return '__WARREN_XPATH_ERR__'; }
         })()`,
        returnByValue: false,
      })
      .catch(() => null);
    if (!evaluated || evaluated.result?.value === '__WARREN_XPATH_ERR__' || !evaluated.result?.objectId) {
      if (!sessionId) throw richErr('BAD_SELECTOR', `xpath 非法: ${xpath}`);
      continue;
    }
    const ids = await backendIdsFromArrayObject(ctx, evaluated.result.objectId, sessionId);
    for (const backendNodeId of ids) all.push({ backendNodeId, sessionId });
  }
  return all;
}

async function backendIdForXpath(
  ctx: PageContext,
  xpath: string,
  nth?: number,
): Promise<{ backendNodeId: number; sessionId?: string }> {
  const ids = await xpathBackendIds(ctx, xpath);
  if (ids.length === 0) throw richErr('TARGET_NOT_FOUND', `xpath not found: ${xpath}`);
  if (ids.length > 1 && nth === undefined) {
    throw Object.assign(new Error(`target ambiguous: ${ids.length} 个匹配，加 >> nth=N：${xpath}`), {
      code: 'TARGET_AMBIGUOUS',
    });
  }
  return pickNth(ids, nth, xpath);
}

async function backendIdForAria(
  ctx: PageContext,
  norm: NormalizedTarget,
): Promise<{ backendNodeId: number; sessionId?: string }> {
  // 只读 AX 树，不注册 ref
  const frames = await readAxFrames(ctx).catch(() => []);
  const nodes: AxNode[] = [];
  for (const frame of frames) {
    const remaining = 2000 - nodes.length;
    if (remaining <= 0) break;
    nodes.push(...buildHierarchicalAxNodes(frame.nodes, frame, frames.length > 1, remaining));
  }
  const normText = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const isRole = norm.kind === 'role';
  const isLabel = norm.kind === 'label';
  const wanted =
    norm.kind === 'text'
      ? normText(norm.text)
      : isLabel
        ? normText((norm as { text: string }).text)
        : normText((norm as { name?: string }).name ?? '');
  const exact =
    norm.kind === 'text'
      ? (norm as { exact?: boolean }).exact
      : isRole
        ? (norm as { nameExact?: boolean }).nameExact
        : false;
  const nth = (norm as { nth?: number }).nth;
  const raw = nodes.filter((node) => {
    if (!node.backendNodeId) return false;
    const nodeName = normText(node.name);
    if (isRole) {
      if (node.role.toLowerCase() !== (norm as { role: string }).role.toLowerCase()) return false;
      if (!wanted) return true;
      return exact ? nodeName === wanted : nodeName === wanted || nodeName.includes(wanted);
    }
    if (isLabel) {
      return /textbox|searchbox|combobox/i.test(node.role) && nodeName.includes(wanted);
    }
    return exact ? nodeName === wanted : nodeName.includes(wanted);
  });
  const seen = new Set<string>();
  let matches = raw.filter((node) => {
    const key = `${sessionOfAxNode(node) ?? ''}::${node.backendNodeId!}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!isRole) {
    const actionable = matches.filter((node) => !/^(StaticText|InlineTextBox|LineBreak)$/.test(node.role));
    if (actionable.length > 0) matches = actionable;
  }
  if (matches.length === 0) throw richErr('TARGET_NOT_FOUND', `target not found: ${JSON.stringify(norm)}`);
  if (matches.length > 1 && nth === undefined) {
    assertUnique(matches, JSON.stringify(norm));
  }
  const picked = nth === undefined ? matches[0] : pickNth(matches, nth, JSON.stringify(norm));
  if (!picked.backendNodeId) throw richErr('TARGET_NOT_FOUND', `target not attached: ${JSON.stringify(norm)}`);
  return { backendNodeId: picked.backendNodeId, sessionId: sessionOfAxNode(picked) };
}

/**
 * 把 `@N` / `css` / `xpath` / `href` / `role` / `text` / `label` 目标解析成 `{ backendNodeId, sessionId }`。
 */
export async function resolveLocatorTarget(
  ctx: PageContext,
  target: TargetInput,
): Promise<{ backendNodeId: number; sessionId?: string }> {
  const norm = normalizeTarget(target);
  if (norm.kind === 'ref') {
    const resolved = ctx.refs.resolve(norm.ref);
    const sessionId =
      resolved.entry?.sessionId ?? (await frameOfBackendId(ctx, resolved.backendId).catch(() => undefined))?.sessionId;
    const alive = await ctx
      .sendOn<{ node?: { backendNodeId?: number } }>(sessionId, 'DOM.describeNode', {
        backendNodeId: resolved.backendId,
      })
      .catch(() => null);
    if (alive?.node?.backendNodeId) return { backendNodeId: resolved.backendId, sessionId };
    const freshNodes = await readAxNodes(ctx, 2000).catch(() => []);
    const healed = ctx.refs.tryHeal(norm.ref, freshNodes);
    if (healed) {
      const meta = ctx.refs.getMeta(norm.ref);
      ctx.noteHealedRef?.({
        ref: meta?.ref ?? norm.ref,
        role: meta?.role ?? 'element',
        name: meta?.name ?? '',
        ...(meta?.containerScope ? { containerScope: meta.containerScope } : {}),
      });
      const healedSession =
        healed.sessionId ?? (await frameOfBackendId(ctx, healed.backendId).catch(() => undefined))?.sessionId;
      return { backendNodeId: healed.backendId, sessionId: healedSession };
    }
    return { backendNodeId: resolved.backendId, sessionId };
  }
  if (norm.kind === 'xpath') return backendIdForXpath(ctx, norm.xpath, norm.nth);
  if (norm.kind === 'selector' || norm.kind === 'href') return backendIdForCss(ctx, norm);
  if (norm.kind === 'role' || norm.kind === 'text' || norm.kind === 'label') return backendIdForAria(ctx, norm);
  throw richErr('BAD_SELECTOR', `未知 Target: ${JSON.stringify(target)}`);
}

/** 这个 backendNodeId 属于哪个 frame / 会话。没在 AX 树里（比如裸 div）返回 undefined。 */
export async function frameOfBackendId(
  ctx: PageContext,
  backendNodeId: number,
): Promise<{ frameId: string; sessionId?: string } | undefined> {
  const frames = await readAxFrames(ctx).catch(() => []);
  const alive = new Set(ctx.childSessions().map((child) => child.sessionId));
  for (const frame of frames) {
    if (frame.nodes.some((node) => node.backendDOMNodeId === backendNodeId)) {
      if (frame.sessionId && !alive.has(frame.sessionId)) {
        throw richErr('NODE_DETACHED', '跨源子会话已经换掉了，重新解析目标');
      }
      return { frameId: frame.frameId, sessionId: frame.sessionId };
    }
  }
  return undefined;
}

async function ownerIframeOf(ctx: PageContext, frameId: string): Promise<number | undefined> {
  const frames = await readAxFrames(ctx).catch(() => []);
  for (const frame of frames) {
    if (frame.sessionId) continue;
    for (const node of frame.nodes) {
      const role = (node.role as { value?: string } | undefined)?.value ?? '';
      if (!/^iframe$/i.test(role)) continue;
      const backendNodeId = node.backendDOMNodeId as number | undefined;
      if (typeof backendNodeId !== 'number') continue;
      const desc = await ctx
        .send<{ node?: { frameId?: string } }>('DOM.describeNode', { backendNodeId })
        .catch(() => null);
      if (desc?.node?.frameId === frameId) return backendNodeId;
    }
  }
  return undefined;
}

/** 跨源 frame 的视口原点在主 frame 视口里的位置。 */
export async function frameOffsetFor(ctx: PageContext, sessionId: string): Promise<{ x: number; y: number }> {
  const child = ctx.childSessions().find((item) => item.sessionId === sessionId);
  if (!child?.frameId) return { x: 0, y: 0 };
  const owner = await ownerIframeOf(ctx, child.frameId);
  if (owner === undefined) return { x: 0, y: 0 };
  const nodeId = await nodeIdFor(ctx, owner);
  const { model } = await ctx
    .send<{ model: { content: number[] } | null }>('DOM.getBoxModel', { nodeId })
    .catch(() => ({ model: null }));
  const content = model?.content;
  if (!content || content.length < 8) return { x: 0, y: 0 };
  return { x: content[0]!, y: content[1]! };
}

/**
 * 精准点击坐标（主 frame 视口坐标）。
 * 优先走 `DOM.getContentQuads` 最大多边形内部整点，避开折行链接/旋转元素的外接盒空心陷阱，
 * 并叠加跨源 iframe 偏移。
 */
export async function boxCenter(
  ctx: PageContext,
  backendNodeId: number,
  position?: { x: number; y: number },
  sessionId?: string,
): Promise<{ x: number; y: number }> {
  const { point } = await localQuadClickPoint(ctx, backendNodeId, position, sessionId);
  const offset = sessionId ? await frameOffsetFor(ctx, sessionId) : { x: 0, y: 0 };
  return { x: point.x + offset.x, y: point.y + offset.y };
}

/** 元素的布局盒（主 frame 视口坐标）。跨源 iframe 里的元素已经加过 owner 偏移。 */
export async function boxRect(
  ctx: PageContext,
  backendNodeId: number,
  sessionId?: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const { rect } = await localQuadClickPoint(ctx, backendNodeId, undefined, sessionId);
  const offset = sessionId ? await frameOffsetFor(ctx, sessionId) : { x: 0, y: 0 };
  return { x: rect.x + offset.x, y: rect.y + offset.y, width: rect.width, height: rect.height };
}

/** 一次计算元素精准多边形落点与视口外接矩形（主 frame 视口坐标，含 OOPIF 偏移）。 */
export async function boxPointAndRect(
  ctx: PageContext,
  backendNodeId: number,
  position?: { x: number; y: number },
  sessionId?: string,
): Promise<{ x: number; y: number; rect: { x: number; y: number; width: number; height: number } }> {
  const { point, rect } = await localQuadClickPoint(ctx, backendNodeId, position, sessionId);
  const offset = sessionId ? await frameOffsetFor(ctx, sessionId) : { x: 0, y: 0 };
  return {
    x: point.x + offset.x,
    y: point.y + offset.y,
    rect: { x: rect.x + offset.x, y: rect.y + offset.y, width: rect.width, height: rect.height },
  };
}

/**
 * 用 AX 树将遮挡元素的 `backendNodeId` 翻译成语义描述（如 `dialog "Cookie 设置"`），
 * 拿不到 AX 信息时回退到安全的 DOM 标签/id/class 描述。
 */
export async function describeAxBlocker(ctx: PageContext, backendNodeId: number, sessionId?: string): Promise<string> {
  const partial = await ctx
    .sendOn<{ nodes?: Array<Record<string, unknown>> }>(sessionId, 'Accessibility.getPartialAXTree', {
      backendNodeId,
      fetchRelatives: false,
    })
    .catch(() => null);
  const ax = partial?.nodes?.[0];
  const role = String((ax?.role as { value?: string } | undefined)?.value ?? '').trim();
  const name = String((ax?.name as { value?: string } | undefined)?.value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const domDesc = await describeDomNode(ctx, backendNodeId, sessionId);
  if (role && !/^(generic|none|presentation|StaticText)$/i.test(role)) {
    const clipped = name.length > 60 ? `${name.slice(0, 57)}...` : name;
    return clipped ? `${role} "${clipped}" (<${domDesc}>)` : `${role} (<${domDesc}>)`;
  }
  return `<${domDesc}>`;
}

/** 高亮配色：清爽品牌蓝描边+柔和填充，与表单校验红明确区分。 */
const HIGHLIGHT = { r: 59, g: 130, b: 246, a: 0.24 };

export async function highlightElement(
  ctx: PageContext,
  backendNodeId: number,
  sessionId?: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await boxRect(ctx, backendNodeId, sessionId);
  await ctx.send('Overlay.enable').catch(() => {});
  if (sessionId) {
    await ctx.send('Overlay.highlightRect', {
      ...rect,
      color: HIGHLIGHT,
      outlineColor: { ...HIGHLIGHT, a: 1 },
    });
  } else {
    await ctx.send('Overlay.highlightNode', {
      backendNodeId,
      highlightConfig: {
        contentColor: HIGHLIGHT,
        borderColor: { ...HIGHLIGHT, a: 1 },
        showInfo: false,
      },
    });
  }
  return rect;
}

export async function probePoint(
  ctx: PageContext,
  target: Parameters<PageContext['backendIdFor']>[0],
): Promise<{
  backendNodeId: number;
  sessionId?: string;
  point: { x: number; y: number };
  truth?: { x: number; y: number };
  delta?: { x: number; y: number };
}> {
  const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
  const point = await boxCenter(ctx, backendNodeId, undefined, sessionId);
  if (!sessionId) return { backendNodeId, point };

  const frame = await ctx.frameOf(backendNodeId).catch(() => undefined);
  const owner = frame ? await ownerIframeOf(ctx, frame.frameId) : undefined;
  if (owner === undefined) return { backendNodeId, sessionId, point };
  const ownerNode = await nodeIdFor(ctx, owner);
  const origin = (await evalOnNode(
    ctx,
    ownerNode,
    `(el) => {
       const r = el.getBoundingClientRect();
       const cs = getComputedStyle(el);
       return {
         x: r.left + parseFloat(cs.borderLeftWidth || '0') + parseFloat(cs.paddingLeft || '0'),
         y: r.top + parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.paddingTop || '0'),
       };
     }`,
  )) as { x: number; y: number };
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
  const inner = (await evalOnNode(
    ctx,
    nodeId,
    `(el) => { const r = el.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; }`,
    sessionId,
  )) as { x: number; y: number };
  const truth = { x: origin.x + inner.x, y: origin.y + inner.y };
  return {
    backendNodeId,
    sessionId,
    point,
    truth,
    delta: { x: point.x - truth.x, y: point.y - truth.y },
  };
}
