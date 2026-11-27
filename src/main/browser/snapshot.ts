/**
 * 观察：混合 DOM 补盲（密码定宽脱敏 / 幽灵文本过滤 / cursor:pointer 与隐藏控件救回 / `-u` 链接解析）
 * 与稳定自愈 `@N` 引用分配。
 *
 * **只有 `assignRefs()` 会往 `RefTable` 注册 ref。** 别的模块要读 AX 树一律走 `ax-tree.ts#readAxNodes()`。
 */
import type { AxNode, SnapshotOptions, ViewportMetrics } from '../../shared/types.ts';
import type { PageContext } from './ctx.ts';
import { buildHierarchicalAxNodes, readAxFrames, sessionOfAxNode, tagAxNodeSession } from './ax-tree.ts';
import { richErr } from './errors.ts';
import { boxRect } from './locator.ts';
import { INTERACTIVE_ROLE_RE, isActionableRole } from './roles.ts';

/** 以某个 backendId 为根，在它所属的那个 frame 里按 childIds 收子树。 */
function collectSubtree(nodes: Array<Record<string, unknown>>, rootBackendId: number): Set<number> {
  const byNodeId = new Map<string, Record<string, unknown>>();
  for (const n of nodes) {
    if (n.nodeId !== undefined && n.nodeId !== null) byNodeId.set(String(n.nodeId), n);
  }
  let rootNodeId: string | null = null;
  for (const [id, n] of byNodeId) {
    if (n.backendDOMNodeId === rootBackendId) {
      rootNodeId = id;
      break;
    }
  }
  const out = new Set<number>();
  if (rootNodeId === null) return out;
  const queue = [rootNodeId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    const node = byIdOrGet(byNodeId, id);
    const b = node?.backendDOMNodeId;
    if (typeof b === 'number') out.add(b);
    const kids = node?.childIds as unknown[] | undefined;
    if (Array.isArray(kids)) queue.push(...kids.map(String));
  }
  return out;
}

function byIdOrGet(map: Map<string, Record<string, unknown>>, key: string) {
  return map.get(key);
}

interface DomAugmentResult {
  passwordIndices: number[];
  hiddenGhostIndices: number[];
  urls: Record<number, string>;
  extras: Array<{ idx: number; role: string; name: string; cursorInteractive?: boolean; hiddenInput?: boolean }>;
  boxes?: Record<number, { x: number; y: number; width: number; height: number }>;
  viewport?: ViewportMetrics;
  viewportBands?: { above: number[]; inside: number[]; below: number[] };
}

/**
 * 隔离世界 DOM 补盲与隐私加固（支持主会话 + 同源 contentDocument iframe + OOPIF 子会话）：
 * 1. 标记所有密码框（`type="password"` / `autocomplete*="password"`）做固定宽度 `"••••••••"` 脱敏；
 * 2. 识别 `opacity: 0` / `visibility: hidden` 幽灵元素（保留 `input[type=file]`）；
 * 3. 可选解析 `a[href]` 真实 URL（`-u`）；
 * 4. 可选扫描 `cursor: pointer`（父已 pointer 时去重）、`onclick`、`tabindex>=0`、`[contenteditable]`
 *    与隐藏 `<input type="file">`，把 AX 树漏掉的可交互元素救回快照。
 */
async function augmentFrameWithDom(
  ctx: PageContext,
  nodes: AxNode[],
  options: {
    urls?: boolean;
    includeCursor?: boolean;
    boxes?: boolean;
    viewportFilter?: boolean;
    frameId?: string;
    loaderId?: string;
    sessionId?: string;
  },
): Promise<{ nodes: AxNode[]; viewport?: ViewportMetrics }> {
  if (ctx.wc.isDestroyed()) return { nodes };
  const sessionId = options.sessionId;
  // 在隔离世界扫描页面，绝不污染主世界 window
  let contextId: number | undefined;
  try {
    const tree = await ctx.sendOn<{ frameTree?: { frame?: { id?: string } } }>(sessionId, 'Page.getFrameTree');
    const fid = options.frameId ?? tree?.frameTree?.frame?.id;
    if (!fid) return { nodes };
    const world = await ctx.sendOn<{ executionContextId?: number }>(sessionId, 'Page.createIsolatedWorld', {
      frameId: fid,
      worldName: 'warren-augment',
    });
    contextId = world?.executionContextId;
  } catch {
    return { nodes };
  }
  if (!contextId) return { nodes };

  try {
    const raw = await ctx.sendOn<{ result?: { objectId?: string } }>(sessionId, 'Runtime.evaluate', {
      contextId,
      returnByValue: false,
      expression: `(() => {
        const opts = ${JSON.stringify({
          urls: Boolean(options.urls),
          includeCursor: Boolean(options.includeCursor),
          boxes: Boolean(options.boxes),
          viewportFilter: Boolean(options.viewportFilter),
          isMainFrame: !options.sessionId,
        })};
        const tagGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
        const safeTag = (n) => {
          try { return n && n.nodeType === 1 ? String(tagGetter ? tagGetter.call(n) : n.tagName).toLowerCase() : ''; }
          catch { return ''; }
        };
        const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const vw = Math.max(1, innerWidth || document.documentElement?.clientWidth || 1280);
        const vh = Math.max(1, innerHeight || document.documentElement?.clientHeight || 800);
        const sx = Math.max(0, Math.round(scrollX || 0));
        const sy = Math.max(0, Math.round(scrollY || 0));
        const pw = Math.max(vw, Math.round(document.documentElement?.scrollWidth || vw));
        const ph = Math.max(vh, Math.round(document.documentElement?.scrollHeight || vh));
        const belowPx = Math.max(0, ph - (sy + vh));
        const maxScrollY = Math.max(0, ph - vh);
        const viewport = opts.isMainFrame ? {
          width: vw,
          height: vh,
          scrollX: sx,
          scrollY: sy,
          scrollWidth: pw,
          scrollHeight: ph,
          abovePx: sy,
          belowPx,
          scrollPercentY: maxScrollY > 0 ? Math.min(100, Math.round((sy / maxScrollY) * 100)) : 100,
        } : undefined;

        const collected = [];
        const passwordIndices = [];
        const hiddenGhostIndices = [];
        const urls = {};
        const extras = [];
        const boxes = {};
        const viewportBands = opts.viewportFilter ? { above: [], inside: [], below: [] } : undefined;
        const seen = new Set();

        const pushEl = (el) => {
          const idx = collected.length;
          collected.push(el);
          return idx;
        };

        const isInteractiveEl = (el, tag) => {
          if (/^(a|button|input|select|textarea|summary|option)$/.test(tag)) return true;
          const role = (el.getAttribute('role') || '').toLowerCase();
          if (/^(button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|searchbox|option|treeitem|listbox|gridcell)$/.test(role)) return true;
          return el.isContentEditable || (el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0);
        };

        const walk = (root, parentHasPointer) => {
          let all;
          try { all = root.querySelectorAll('*'); } catch { return; }
          for (const el of all) {
            if (seen.has(el)) continue;
            seen.add(el);
            const tag = safeTag(el);
            if (!tag || tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;

            // 1) 密码字段识别
            if (tag === 'input') {
              const type = String(el.type || '').toLowerCase();
              const ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
              if (type === 'password' || ac.includes('password')) {
                passwordIndices.push(pushEl(el));
              }
              // 隐藏 file input 救回
              if (type === 'file' && opts.includeCursor) {
                const label = (el.labels && el.labels[0] && clean(el.labels[0].textContent)) || el.getAttribute('aria-label') || el.getAttribute('name') || 'Upload file';
                extras.push({ idx: pushEl(el), role: 'file_input', name: label.slice(0, 80), hiddenInput: !isVisible(el) });
              }
            }

            // 2) -u 链接 URL
            if (opts.urls && tag === 'a' && el.href) {
              urls[pushEl(el)] = String(el.href);
            }

            const cs = getComputedStyle(el);
            const invisible = cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0;
            if (invisible) {
              if (tag !== 'input' || String(el.type || '').toLowerCase() !== 'file') {
                if (clean(el.textContent).length > 0 && el.children.length === 0) {
                  hiddenGhostIndices.push(pushEl(el));
                }
              }
              if (el.shadowRoot) walk(el.shadowRoot, false);
              if (tag === 'iframe') {
                try { if (el.contentDocument) walk(el.contentDocument, false); } catch {}
              }
              continue;
            }

            // 2.5) 真视口内外判定（仅 scope === 'viewport' 时启用）
            if (viewportBands && isInteractiveEl(el, tag)) {
              const r = el.getBoundingClientRect();
              const inModal = Boolean(el.closest('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'));
              const bandIdx = pushEl(el);
              if (inModal || (r.bottom >= -120 && r.top <= vh + 120 && r.right >= -120 && r.left <= vw + 120)) {
                viewportBands.inside.push(bandIdx);
              } else if (r.bottom < -120) {
                viewportBands.above.push(bandIdx);
              } else {
                viewportBands.below.push(bandIdx);
              }
            }

            // 3) Cursor 交互补盲（排除带 href 的原生链接与原生表单控件，保留无 href 交互 <a>、拖拽区与小图标按钮）
            const hasPointer = cs.cursor === 'pointer';
            if (opts.includeCursor && extras.length < 120) {
              const isNative =
                (tag === 'a' && el.hasAttribute('href')) ||
                /^(button|input|select|textarea|summary|label|option)$/.test(tag);
              const role = (el.getAttribute('role') || '').toLowerCase();
              const hasAriaInteractive = /^(button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|searchbox|option|treeitem|listbox|gridcell)$/.test(role);
              if (!isNative && !hasAriaInteractive) {
                const r = el.getBoundingClientRect();
                const reasonableSize = r.width >= 8 && r.height >= 8 && r.width * r.height < vw * vh * 0.45;
                const clsStr = typeof el.className === 'string' ? el.className : '';
                const isDraggable =
                  el.getAttribute('draggable') === 'true' || /\\bui-draggable\\b/.test(clsStr);
                const isDroppable =
                  typeof el.ondrop === 'function' ||
                  el.hasAttribute('ondrop') ||
                  /\\bui-droppable\\b/.test(clsStr);
                const hasIconMedia =
                  Boolean(cs.backgroundImage && cs.backgroundImage !== 'none') ||
                  /url\\(/i.test(cs.content || '') ||
                  Boolean(el.querySelector && el.querySelector('svg, img, i'));
                const isSmallIconControl = hasPointer && hasIconMedia && r.width <= 48 && r.height <= 48;
                const explicitInteractive =
                  typeof el.onclick === 'function' ||
                  el.hasAttribute('onclick') ||
                  typeof el.onmouseenter === 'function' ||
                  el.hasAttribute('onmouseenter') ||
                  typeof el.onmouseover === 'function' ||
                  el.hasAttribute('onmouseover') ||
                  el.isContentEditable ||
                  isDraggable ||
                  isDroppable ||
                  (el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0);
                if (reasonableSize && (explicitInteractive || isSmallIconControl || (hasPointer && !parentHasPointer))) {
                  const text = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent).slice(0, 80);
                  const iconFallback =
                    !text && hasPointer && hasIconMedia
                      ? el.id
                        ? '#' + el.id
                        : clsStr
                            .trim()
                            .split(/\\s+/)
                            .filter((c) => c && !/^(clicked|active|selected|hover|focus|icon|fa)$/i.test(c))
                            .slice(0, 2)
                            .join('.')
                      : '';
                  if (text || iconFallback || explicitInteractive) {
                    const idx = pushEl(el);
                    const idFallback = (isDraggable || isDroppable) && el.id ? '#' + el.id : '';
                    const extraRole = el.isContentEditable
                      ? 'textbox'
                      : isDraggable
                        ? 'draggable'
                        : isDroppable
                          ? 'droppable'
                          : 'clickable';
                    extras.push({
                      idx,
                      role: extraRole,
                      name: text || iconFallback || idFallback || tag,
                      cursorInteractive: true,
                    });
                    if (opts.boxes) {
                      boxes[idx] = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
                    }
                  }
                }
              }
            }

            if (el.shadowRoot) walk(el.shadowRoot, hasPointer);
            if (tag === 'iframe') {
              try { if (el.contentDocument) walk(el.contentDocument, false); } catch {}
            }
          }
        };

        walk(document, false);
        return {
          elements: collected,
          meta: JSON.stringify({ passwordIndices, hiddenGhostIndices, urls, extras, boxes, viewport, viewportBands }),
        };
      })()`,
    });

    const bundleObjectId = raw?.result?.objectId;
    if (!bundleObjectId) return { nodes };

    let data: DomAugmentResult | null = null;
    let elementsObjectId: string | undefined;
    try {
      const bundleProps = await ctx
        .sendOn<{ result?: Array<{ name: string; value?: { value?: unknown; objectId?: string } }> }>(
          sessionId,
          'Runtime.getProperties',
          { objectId: bundleObjectId, ownProperties: true },
        )
        .catch(() => null);
      for (const prop of bundleProps?.result ?? []) {
        if (prop.name === 'meta' && typeof prop.value?.value === 'string') {
          try {
            data = JSON.parse(prop.value.value) as DomAugmentResult;
          } catch {
            data = null;
          }
        } else if (prop.name === 'elements' && prop.value?.objectId) {
          elementsObjectId = prop.value.objectId;
        }
      }
    } finally {
      await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: bundleObjectId }).catch(() => {});
    }

    if (!data) {
      if (elementsObjectId) {
        await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: elementsObjectId }).catch(() => {});
      }
      return { nodes };
    }

    const indexToBackend = new Map<number, number>();
    const neededIndices = new Set<number>([
      ...data.passwordIndices,
      ...data.hiddenGhostIndices,
      ...Object.keys(data.urls).map(Number),
      ...data.extras.map((e) => e.idx),
      ...(data.viewportBands
        ? [...data.viewportBands.above, ...data.viewportBands.inside, ...data.viewportBands.below]
        : []),
    ]);

    if (elementsObjectId) {
      const elementEntries: Array<{ idx: number; objectId: string; needed: boolean }> = [];
      try {
        const elProps = await ctx
          .sendOn<{ result?: Array<{ name: string; value?: { objectId?: string } }> }>(
            sessionId,
            'Runtime.getProperties',
            { objectId: elementsObjectId, ownProperties: true },
          )
          .catch(() => null);
        for (const prop of elProps?.result ?? []) {
          if (!/^\d+$/.test(prop.name)) continue;
          const objectId = prop.value?.objectId;
          if (!objectId) continue;
          const idx = Number(prop.name);
          elementEntries.push({ idx, objectId, needed: neededIndices.has(idx) });
        }
      } finally {
        await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: elementsObjectId }).catch(() => {});
      }

      // 有界并发（16）批量解析 backendNodeId 并释放远程句柄，彻底消除 N+1 串行 CDP 往返
      const CONCURRENCY = 16;
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, Math.max(1, elementEntries.length)) }, async () => {
          while (true) {
            const pos = cursor;
            cursor += 1;
            if (pos >= elementEntries.length) break;
            const entry = elementEntries[pos]!;
            try {
              if (entry.needed) {
                const desc = await ctx
                  .sendOn<{ node?: { backendNodeId?: number } }>(sessionId, 'DOM.describeNode', {
                    objectId: entry.objectId,
                  })
                  .catch(() => null);
                if (typeof desc?.node?.backendNodeId === 'number') {
                  indexToBackend.set(entry.idx, desc.node.backendNodeId);
                }
              }
            } finally {
              await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: entry.objectId }).catch(() => {});
            }
          }
        }),
      );
    }

    const passwordIds = new Set<number>();
    for (const idx of data.passwordIndices) {
      const bid = indexToBackend.get(idx);
      if (bid !== undefined) passwordIds.add(bid);
    }
    const ghostIds = new Set<number>();
    for (const idx of data.hiddenGhostIndices) {
      const bid = indexToBackend.get(idx);
      if (bid !== undefined) ghostIds.add(bid);
    }
    const urlByBackend = new Map<number, string>();
    for (const [idxStr, href] of Object.entries(data.urls)) {
      const bid = indexToBackend.get(Number(idxStr));
      if (bid !== undefined) urlByBackend.set(bid, href);
    }

    const aboveIds = new Set<number>();
    const insideIds = new Set<number>();
    const belowIds = new Set<number>();
    if (data.viewportBands) {
      for (const idx of data.viewportBands.above) {
        const bid = indexToBackend.get(idx);
        if (bid !== undefined) aboveIds.add(bid);
      }
      for (const idx of data.viewportBands.inside) {
        const bid = indexToBackend.get(idx);
        if (bid !== undefined) insideIds.add(bid);
      }
      for (const idx of data.viewportBands.below) {
        const bid = indexToBackend.get(idx);
        if (bid !== undefined) belowIds.add(bid);
      }
    }

    const existingBackendIds = new Set<number>();
    const filtered: AxNode[] = [];
    let omittedAbove = 0;
    let omittedBelow = 0;
    for (const node of nodes) {
      const bid = node.backendNodeId;
      const sameSession = (sessionOfAxNode(node) ?? undefined) === sessionId;
      if (sameSession && typeof bid === 'number') {
        if (ghostIds.has(bid) && !node.hiddenInput) continue;
        existingBackendIds.add(bid);
        if (passwordIds.has(bid)) {
          node.sensitive = true;
          node.value = '••••••••';
        }
        const href = urlByBackend.get(bid);
        if (href && /^link$/i.test(node.role)) {
          node.url = href;
        }
        if (options.viewportFilter && !node.hiddenInput) {
          if (aboveIds.has(bid)) {
            omittedAbove += 1;
            continue;
          }
          if (belowIds.has(bid)) {
            omittedBelow += 1;
            continue;
          }
          if (insideIds.has(bid)) node.inViewport = true;
        }
      }
      filtered.push(node);
    }

    for (const extra of data.extras) {
      const bid = indexToBackend.get(extra.idx);
      if (bid === undefined || existingBackendIds.has(bid)) continue;
      if (options.viewportFilter && !extra.hiddenInput) {
        if (aboveIds.has(bid)) {
          omittedAbove += 1;
          continue;
        }
        if (belowIds.has(bid)) {
          omittedBelow += 1;
          continue;
        }
      }
      existingBackendIds.add(bid);
      const extraNode: AxNode = {
        role: extra.role,
        name: extra.name,
        backendNodeId: bid,
        depth: 0,
        loaderId: options.loaderId,
        ...(options.frameId ? { frameId: options.frameId } : {}),
        ...(extra.cursorInteractive ? { cursorInteractive: true } : {}),
        ...(extra.hiddenInput ? { hiddenInput: true } : {}),
        ...(insideIds.has(bid) ? { inViewport: true } : {}),
        ...(data.boxes?.[extra.idx] ? { box: data.boxes[extra.idx] } : {}),
      };
      tagAxNodeSession(extraNode, sessionId);
      filtered.push(extraNode);
    }

    const viewport = data.viewport
      ? {
          ...data.viewport,
          ...(omittedAbove > 0 ? { omittedAbove } : {}),
          ...(omittedBelow > 0 ? { omittedBelow } : {}),
        }
      : undefined;
    return { nodes: filtered, viewport };
  } catch {
    return { nodes };
  }
}

export async function snapshotWithMeta(
  ctx: PageContext,
  options: SnapshotOptions & { limit?: number; interestingOnly?: boolean } = {},
): Promise<{ nodes: AxNode[]; viewport?: ViewportMetrics }> {
  // 默认保持 full_page 兼容 + 附带视口滚动进度；显式传 `scope: 'viewport'` 时开启真视口过滤
  const scope = options.scope ?? 'full_page';
  const limit = options.limit ?? (scope === 'viewport' ? 600 : 2000);
  const frames = await readAxFrames(ctx);
  let onlyFrame: string | undefined = options.frame ?? ctx.activeFrameId?.();
  let allowed: Set<number> | null = null;

  if (scope === 'subtree') {
    if (!options.root) throw richErr('BAD_REQUEST', 'subtree 需要 root（snapshot ref）');
    const { backendId } = ctx.refs.resolve(options.root);
    let ownerFrame: string | undefined;
    let rootNode: Record<string, unknown> | undefined;
    for (const frame of frames) {
      rootNode = frame.nodes.find((node) => node.backendDOMNodeId === backendId);
      if (rootNode) {
        ownerFrame = frame.frameId;
        break;
      }
    }
    if (!ownerFrame) throw richErr('TARGET_NOT_FOUND', `subtree root 不在当前 AX 树里: ${options.root}`);
    onlyFrame = ownerFrame;
    const role = String((rootNode?.role as { value?: string } | undefined)?.value ?? '');
    if (/^iframe$/i.test(role)) {
      const desc = await ctx
        .send<{ node: { frameId?: string } }>('DOM.describeNode', { backendNodeId: backendId })
        .catch(() => null);
      const childFrame = desc?.node?.frameId;
      if (childFrame && frames.some((frame) => frame.frameId === childFrame)) onlyFrame = childFrame;
    }
    if (onlyFrame === ownerFrame && !/^iframe$/i.test(role)) {
      allowed = collectSubtree(frames.find((frame) => frame.frameId === ownerFrame)?.nodes ?? [], backendId);
    }
  }

  const roles = Array.isArray(options.roles) ? new Set(options.roles.map((role) => role.toLowerCase())) : null;
  let selectorAllowed: Set<number> | null = null;
  if (options.selector) {
    const evaluated = await ctx
      .send<{ result: { objectId?: string } }>('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(options.selector)})`,
        returnByValue: false,
      })
      .catch(() => null);
    const objectId = evaluated?.result?.objectId;
    if (objectId) {
      const described = await ctx
        .send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId })
        .catch(() => null);
      await ctx.send('Runtime.releaseObject', { objectId }).catch(() => {});
      const rootBackendId = described?.node?.backendNodeId;
      if (rootBackendId) {
        const main = frames.find((frame) => !frame.sessionId);
        selectorAllowed = collectSubtree(main?.nodes ?? [], rootBackendId);
      }
    }
    if (!selectorAllowed) selectorAllowed = new Set();
  }

  let out: AxNode[] = [];
  for (const frame of frames) {
    if (onlyFrame && frame.frameId !== onlyFrame) continue;
    const remaining = limit - out.length;
    if (remaining <= 0) break;
    const built = buildHierarchicalAxNodes(frame.nodes, frame, frames.length > 1, remaining * 2);
    for (const node of built) {
      const backendId = node.backendNodeId;
      if (allowed && !(typeof backendId === 'number' && allowed.has(backendId))) continue;
      if (selectorAllowed && !(typeof backendId === 'number' && selectorAllowed.has(backendId))) continue;
      if (options.maxDepth !== undefined && (node.depth ?? 0) > options.maxDepth) continue;
      const isInteractive = INTERACTIVE_ROLE_RE.test(node.role);
      if (options.interactiveOnly && !isInteractive) continue;
      if (roles && !roles.has(node.role.toLowerCase())) continue;
      out.push(node);
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }

  const augmentOpts = {
    urls: options.urls,
    includeCursor: options.includeCursor ?? Boolean(options.interactiveOnly),
    boxes: options.boxes,
    viewportFilter: scope === 'viewport',
  };
  let viewport: ViewportMetrics | undefined;
  const mainFrame = frames.find((f) => !f.sessionId);
  if (!onlyFrame || (mainFrame && onlyFrame === mainFrame.frameId)) {
    const aug = await augmentFrameWithDom(ctx, out, {
      ...augmentOpts,
      frameId: mainFrame?.frameId,
      loaderId: mainFrame?.loaderId,
    });
    out = aug.nodes;
    viewport = aug.viewport;
  }
  for (const childFrame of frames) {
    if (!childFrame.sessionId) continue;
    if (onlyFrame && onlyFrame !== childFrame.frameId) continue;
    const aug = await augmentFrameWithDom(ctx, out, {
      ...augmentOpts,
      frameId: childFrame.frameId,
      loaderId: childFrame.loaderId,
      sessionId: childFrame.sessionId,
    });
    out = aug.nodes;
  }
  if (options.interactiveOnly) {
    out = out.filter((n) => INTERACTIVE_ROLE_RE.test(n.role) || n.cursorInteractive || n.hiddenInput);
  }
  if (roles) {
    out = out.filter((n) => roles.has(n.role.toLowerCase()));
  }

  if (options.boxes) {
    const needBox = out.filter((n) => !n.box && n.backendNodeId && isActionableRole(n.role));
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, Math.max(1, needBox.length)) }, async () => {
        while (true) {
          const pos = cursor;
          cursor += 1;
          if (pos >= needBox.length) break;
          const n = needBox[pos]!;
          const sessionId = sessionOfAxNode(n) ?? frames.find((f) => f.frameId === n.frameId)?.sessionId;
          const rect = await boxRect(ctx, n.backendNodeId!, sessionId).catch(() => null);
          if (rect) {
            n.box = {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          }
        }
      }),
    );
  }

  for (const n of out) {
    if (options.includeStableLocator) n.locator = stableLocator(n);
    if (options.includeActionMarks) n.actions = actionMarks(n.role);
  }
  return { nodes: out.slice(0, limit), ...(viewport ? { viewport } : {}) };
}

export async function snapshot(
  ctx: PageContext,
  options: SnapshotOptions & { limit?: number; interestingOnly?: boolean } = {},
): Promise<AxNode[]> {
  return (await snapshotWithMeta(ctx, options)).nodes;
}

/**
 * 给一批节点分配跨快照稳定的 `@N` 并绑定 per-frame `loaderId` 写进 ref 表。
 * **只有 agent 的 `browser.snapshot` / `batch` 调它。**
 */
export function assignRefs(ctx: PageContext, nodes: AxNode[], options: { includeStableLocator?: boolean } = {}): void {
  const frameLoaders = new Map<string, string>();
  for (const n of nodes) {
    if (n.frameId && n.loaderId) frameLoaders.set(n.frameId, n.loaderId);
  }
  const assigned = ctx.refs.registerStable(
    nodes.map((node) =>
      isActionableRole(node.role) || node.cursorInteractive || node.hiddenInput
        ? {
            backendId: node.backendNodeId,
            frameId: node.frameId,
            loaderId: node.loaderId,
            sessionId: sessionOfAxNode(node),
            role: node.role,
            name: node.name,
            ...(node.containerScope ? { containerScope: node.containerScope } : {}),
          }
        : undefined,
    ),
    frameLoaders,
  );
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const hit = assigned[i];
    if (hit) {
      node.ref = hit.ref;
      if (hit.isNew) node.isNew = true;
    }
    if (options.includeStableLocator) node.locator = stableLocator(node);
  }
}

function stableLocator(n: AxNode): string | undefined {
  if (n.name && /button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|treeitem/i.test(n.role)) {
    return `loc=role:${n.role.toLowerCase()}[name="${n.name.slice(0, 60).replace(/"/g, '\\"')}"]`;
  }
  if (n.ref) return n.ref;
  return undefined;
}

function actionMarks(role: string): Array<'click' | 'fill' | 'select' | 'focus'> {
  const r = role.toLowerCase();
  if (
    /button|link|menuitem|tab|switch|checkbox|radio|slider|treeitem|clickable|draggable|droppable|disclosuretriangle/i.test(
      r,
    )
  ) {
    return ['click', 'focus'];
  }
  if (/textbox|searchbox|combobox/i.test(r)) return ['fill', 'focus'];
  if (/listbox|combobox/i.test(r)) return ['select', 'focus'];
  return ['focus'];
}
