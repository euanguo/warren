/**
 * 观察：AX 树取数（带短 TTL 缓存）、snapshot 与 ref 分配、截图。
 *
 * **只有 `snapshot()` 会往 `RefTable` 注册 ref。** 别的模块要读 AX 树一律走
 * `readAxNodes()`——它只读不注册。这是修掉「内部解析顺手重置 ref 表、
 * 让 `@N` 静默指到别的元素」的那条不变量。
 */
import type { AxNode, ScreenshotOptions, ScreenshotResult, SnapshotOptions } from '../../shared/types.ts';
import type { AxFrame, PageContext } from './ctx.ts';
import { defaultScreenshotPath, guardScreenshotPath, imageSize, sha256Buffer, writeArtifact } from '../artifacts.ts';
import { err } from './page-helpers.ts';
import {
  canFallbackToElectronScreenshot,
  SCREENSHOT_CDP_TIMEOUT_MS,
  screenshotFallbackError,
  withTimeout,
} from './screenshot-policy.ts';

/**
 * 同一轮等待里的多次取树复用一份。
 *
 * 等待轮询是 150ms，TTL 必须 ≥ 它，否则每轮都过期、等于没有缓存；
 * 也别调太大（>500ms 会让等待明显变迟钝）。
 */
const AX_CACHE_TTL_MS = 300;
const axCache = new Map<number, { frames: AxFrame[]; at: number }>();

/** 导航/销毁后丢掉缓存，别把上一页的结构喂给下一步。 */
export function invalidateAxCache(wcId: number): void {
  axCache.delete(wcId);
}

/**
 * 各 frame 的 AX 节点。
 *
 * `Accessibility.getFullAXTree` **不返回子 frame 的内容**（Iframe 节点的 childIds 是空的，实测），
 * 所以按 `Page.getFrameTree` 逐帧取。
 *
 * **跨源 iframe（OOPIF）不在主会话的 frame tree 里**（实测：只列出 1 个 frame），
 * 得从它自己的子会话取（`Target.setAutoAttach` 建起来的，见 session.ts）。
 * 每个 frame 带上 `sessionId`，后面的盒模型 / 命中测试才知道该往哪个会话发命令。
 */
export async function readAxFrames(ctx: PageContext): Promise<AxFrame[]> {
  const cached = axCache.get(ctx.wc.id);
  if (cached && Date.now() - cached.at < AX_CACHE_TTL_MS && sessionsAlive(ctx, cached.frames)) return cached.frames;

  const tree = await ctx
    .send<{ frameTree?: { frame: { id: string }; childFrames?: unknown[] } }>('Page.getFrameTree')
    .catch(() => null);
  const frameIds: string[] = [];
  const walk = (node: { frame?: { id: string }; childFrames?: unknown[] } | undefined) => {
    if (!node?.frame?.id) return;
    frameIds.push(node.frame.id);
    for (const child of (node.childFrames ?? []) as Array<{
      frame?: { id: string };
      childFrames?: unknown[];
    }>) {
      walk(child);
    }
  };
  walk(tree?.frameTree);
  const out: AxFrame[] = [];
  for (const frameId of frameIds) {
    try {
      const r = await ctx.send<{ nodes?: Array<Record<string, unknown>> }>('Accessibility.getFullAXTree', {
        frameId,
      });
      out.push({ frameId, nodes: r.nodes ?? [] });
    } catch {
      // frame 可能在取的过程中销毁
    }
  }
  // OOPIF：每个子会话自己就是一棵树，主会话的 frame tree 里根本没有它
  for (const child of ctx.childSessions()) {
    if (!child.frameId) continue;
    try {
      const r = await ctx.sendOn<{ nodes?: Array<Record<string, unknown>> }>(
        child.sessionId,
        'Accessibility.getFullAXTree',
      );
      out.push({ frameId: child.frameId, sessionId: child.sessionId, nodes: r.nodes ?? [] });
    } catch {
      // 子 frame 可能在取的过程中销毁
    }
  }
  axCache.set(ctx.wc.id, { frames: out, at: Date.now() });
  return out;
}

/**
 * 缓存里的跨源 frame 还挂着吗。
 *
 * OOPIF 的进程会被换掉（detach → 重新 attach，sessionId 跟着变），而 AX 缓存有 120ms TTL。
 * 拿一个**已经死掉的 sessionId** 去发命令，表现不是报错而是「在旧会话里查到了另一个同 id 的节点」
 * （`backendNodeId` 只在同一个 renderer 内唯一）——实测症状是页面里抛
 * `el.getBoundingClientRect is not a function`，也就是解析到了一个文本节点。
 * 所以缓存必须跟着会话的存亡一起校验。
 */
function sessionsAlive(ctx: PageContext, frames: AxFrame[]): boolean {
  const alive = new Set(ctx.childSessions().map((child) => child.sessionId));
  return frames.every((frame) => !frame.sessionId || alive.has(frame.sessionId));
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
      // 会话已经没了 = 这个元素已经不在这个页面里了，绝不能退回主会话去猜
      // （backendNodeId 跨 renderer 不唯一，退回主会话会静默命中别的元素）。
      // 报可重试的错误，让动作循环重新解析一次目标。
      if (frame.sessionId && !alive.has(frame.sessionId)) {
        throw Object.assign(new Error('跨源子会话已经换掉了，重新解析目标'), {
          code: 'NODE_DETACHED',
        });
      }
      return { frameId: frame.frameId, sessionId: frame.sessionId };
    }
  }
  return undefined;
}

/**
 * AX 节点的状态读取。
 *
 * **状态不在顶层**：`Accessibility.AXNode` 顶层只有 role/name/description/value，
 * `checked/expanded/level/selected/pressed/disabled/readonly/required/focused/valuetext`
 * 全在 `properties: AXProperty[]` 里，每项形如 `{ name, value: { type, value } }`。
 * 之前只读顶层 `disabled`，所以那个字段**恒为 undefined**（实测）。
 */
function propValue(node: Record<string, unknown>, name: string): unknown {
  const props = node.properties as Array<{ name?: string; value?: { value?: unknown } }> | undefined;
  return props?.find((p) => p.name === name)?.value?.value;
}

function statesOf(node: Record<string, unknown>) {
  const bool = (v: unknown): boolean | undefined =>
    typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
  const tri = (v: unknown): boolean | 'mixed' | undefined => (v === 'mixed' ? 'mixed' : bool(v));
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return {
    disabled: bool(propValue(node, 'disabled')),
    checked: tri(propValue(node, 'checked')),
    expanded: bool(propValue(node, 'expanded')),
    selected: bool(propValue(node, 'selected')),
    pressed: tri(propValue(node, 'pressed')),
    level: num(propValue(node, 'level')),
    readonly: bool(propValue(node, 'readonly')),
    required: bool(propValue(node, 'required')),
    focused: bool(propValue(node, 'focused')),
    valuetext: str(propValue(node, 'valuetext')),
  };
}

/** 把 AX 树拍平成节点数组。只读，不注册 ref。 */
export async function readAxNodes(ctx: PageContext, limit = 2000): Promise<AxNode[]> {
  const frames = await readAxFrames(ctx);
  const out: AxNode[] = [];
  for (const frame of frames) {
    for (const node of frame.nodes) {
      if (node.ignored) continue;
      const role = (node.role as { value?: string } | undefined)?.value ?? '';
      const name = (node.name as { value?: string } | undefined)?.value ?? '';
      const value = (node.value as { value?: string } | undefined)?.value;
      const backendId = node.backendDOMNodeId as number | undefined;
      const hasName = typeof name === 'string' && name.length > 0;
      const interactive = /button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|searchbox/i.test(
        role,
      );
      if (!hasName && !interactive && !value) continue;
      out.push({
        role,
        name: hasName ? name : '',
        backendNodeId: backendId,
        value: typeof value === 'string' ? value : undefined,
        description: (node.description as { value?: string } | undefined)?.value,
        ...statesOf(node),
        frameId: frames.length > 1 ? frame.frameId : undefined,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 以某个 backendId 为根，在**它所属的那个 frame** 里按 childIds 收子树。 */
function collectSubtree(nodes: Array<Record<string, unknown>>, rootBackendId: number): Set<number> {
  // childIds 是 nodeId（不是 backendId）。CDP 的 nodeId 是**字符串**（实测），
  // 按数字比较会一个都匹配不上、subtree 恒为空，所以统一按字符串索引。
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
    const node = byNodeId.get(id);
    const b = node?.backendDOMNodeId;
    if (typeof b === 'number') out.add(b);
    const kids = node?.childIds as unknown[] | undefined;
    if (Array.isArray(kids)) queue.push(...kids.map(String));
  }
  return out;
}

export async function snapshot(
  ctx: PageContext,
  options: SnapshotOptions & { limit?: number; interestingOnly?: boolean } = {},
): Promise<AxNode[]> {
  const scope = options.scope ?? 'viewport';
  const limit = options.limit ?? (scope === 'full_page' ? 2000 : 400);
  const frames = await readAxFrames(ctx);
  // subtree：以 root ref 的 backendId 为根，在**它所属的那个 frame** 里用 childIds 过滤
  let onlyFrame: string | undefined;
  let allowed: Set<number> | null = null;
  if (scope === 'subtree') {
    if (!options.root) throw err('BAD_REQUEST', 'subtree 需要 root（snapshot ref）');
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
    if (!ownerFrame) throw err('TARGET_NOT_FOUND', `subtree root 不在当前 AX 树里: ${options.root}`);
    onlyFrame = ownerFrame;
    const role = String((rootNode?.role as { value?: string } | undefined)?.value ?? '');
    // iframe 的子树在**子 frame** 里（AX 不给跨 frame 的 childIds），所以换成子 frame 整棵
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
  const out: AxNode[] = [];
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
  for (const frame of frames) {
    if (onlyFrame && frame.frameId !== onlyFrame) continue;
    for (const node of frame.nodes) {
      if (node.ignored) continue;
      const role = (node.role as { value?: string } | undefined)?.value ?? '';
      const name = (node.name as { value?: string } | undefined)?.value ?? '';
      const value = (node.value as { value?: string } | undefined)?.value;
      const backendId = node.backendDOMNodeId as number | undefined;
      if (allowed && !(typeof backendId === 'number' && allowed.has(backendId))) continue;
      if (selectorAllowed && !(typeof backendId === 'number' && selectorAllowed.has(backendId))) continue;
      const hasName = typeof name === 'string' && name.length > 0;
      const interactive = /button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|searchbox/i.test(
        role,
      );
      if (options.interactiveOnly && !interactive) continue;
      if (roles && !roles.has(role.toLowerCase())) continue;
      if (!hasName && !interactive && !value) continue;
      out.push({
        role,
        name: hasName ? name : '',
        backendNodeId: backendId,
        value: typeof value === 'string' ? value : undefined,
        description: (node.description as { value?: string } | undefined)?.value,
        ...statesOf(node),
        frameId: frames.length > 1 ? frame.frameId : undefined,
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  // 这里**不碰 RefTable**：ref 是 agent 的会话状态，只有 assignRefs() 能改。
  // 渲染层检查器、插件 API、`env.egress` 都会走到这个函数，随手注册一次就会把
  // agent 手上的 `@N` 重编号（元素集变了就指到别的元素），而且不报 TARGET_STALE。
  for (const n of out) {
    if (options.includeStableLocator) n.locator = stableLocator(n);
    if (options.includeActionMarks) n.actions = actionMarks(n.role);
  }
  return out;
}

/**
 * 给一批节点分配 `@N` 并写进 ref 表。**只有 agent 的 `browser.snapshot` 调它。**
 *
 * 表是「每个标签一份的会话状态」：别的调用方读快照不该动它。要复用老 ref 的能力
 * （`subtree{root}`、`@N` 动作）就必须显式走这条路径，而不是让读快照顺手重置。
 */
export function assignRefs(ctx: PageContext, nodes: AxNode[], options: { includeStableLocator?: boolean } = {}): void {
  const refs = ctx.refs.register(nodes.map((node) => (isActionableRole(node.role) ? node.backendNodeId : undefined)));
  let ri = 0;
  for (const node of nodes) {
    if (isActionableRole(node.role) && typeof node.backendNodeId === 'number') node.ref = refs[ri++];
    // ref 分配后重算一次 locator：`stableLocator` 对非交互节点会退回 `@N`
    if (options.includeStableLocator) node.locator = stableLocator(node);
  }
}

/**
 * 动作 ref 只给可交互角色分配。
 *
 * AX 树里的 StaticText / InlineTextBox 也带 backendDOMNodeId，但它们不是 HTMLElement；
 * 拿这些 ref 去点击时，页面里的 `getBoundingClientRect` 不存在（实测）。文本节点仍然
 * 留在 snapshot 里供阅读，只是不会拿到能被动作消费的 `@N`。
 */
function isActionableRole(role: string): boolean {
  return /button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|searchbox|option|spinbutton|listbox/i.test(
    String(role || ''),
  );
}

export async function screenshot(
  ctx: PageContext,
  opts: ScreenshotOptions = {},
  environmentId?: string,
): Promise<ScreenshotResult> {
  const format = opts.format ?? 'png';
  const params: Record<string, unknown> = { format };
  if (opts.fullPage) params.captureBeyondViewport = true;
  if (opts.clip) {
    params.clip = {
      x: opts.clip.x,
      y: opts.clip.y,
      width: opts.clip.width,
      height: opts.clip.height,
      scale: 1,
    };
  }
  let buffer: Buffer;
  let source: 'cdp' | 'electron' = 'cdp';
  try {
    const { data } = await withTimeout(
      ctx.send<{ data: string }>('Page.captureScreenshot', params),
      SCREENSHOT_CDP_TIMEOUT_MS,
      `CDP screenshot timed out after ${SCREENSHOT_CDP_TIMEOUT_MS}ms`,
    );
    buffer = Buffer.from(data, 'base64');
  } catch (error) {
    const fallback = await captureVisiblePage(ctx, format, opts);
    if (!fallback.buffer) throw screenshotFallbackError(fallback.error ?? error);
    buffer = fallback.buffer;
    source = 'electron';
  }
  const wantsBase64 = opts.encoding === 'base64';
  const target =
    opts.path ?? (wantsBase64 ? undefined : defaultScreenshotPath(environmentId ?? String(ctx.tabIndex()), format));
  if (target) {
    const meta = await writeArtifact(guardScreenshotPath(target), buffer);
    const size = imageSize(buffer, format);
    return {
      ...meta,
      format,
      ...size,
      source,
      ...(wantsBase64 ? { base64: buffer.toString('base64') } : {}),
    };
  }
  const size = imageSize(buffer, format);
  return {
    bytes: buffer.length,
    sha256: sha256Buffer(buffer),
    format,
    ...size,
    source,
    base64: buffer.toString('base64'),
  };
}

/**
 * CDP 拿不到 surface 时，退回 Electron 自己的画面捕获。
 *
 * 只支持可见视口：`capturePage` 不实现整页或裁剪语义，带这两个参数时必须继续报
 * CDP 的原始错误，不能悄悄返回一张语义不同的图。
 */
async function captureVisiblePage(
  ctx: PageContext,
  format: 'png' | 'jpeg',
  opts: ScreenshotOptions,
): Promise<{ buffer?: Buffer; error?: unknown }> {
  if (!canFallbackToElectronScreenshot(opts)) return { error: 'fullPage/clip 不能走 Electron 兜底' };
  if (ctx.wc.isDestroyed()) return { error: 'webContents 已销毁' };
  try {
    const image = await ctx.wc.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty()) return { error: 'NativeImage 为空' };
    return { buffer: format === 'jpeg' ? image.toJPEG(92) : image.toPNG() };
  } catch (error) {
    return { error };
  }
}

function stableLocator(n: AxNode): string | undefined {
  if (n.name && /button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch/i.test(n.role)) {
    return `loc=role:${n.role.toLowerCase()}[name="${n.name.slice(0, 60).replace(/"/g, '\\"')}"]`;
  }
  if (n.ref) return n.ref;
  return undefined;
}

function actionMarks(role: string): Array<'click' | 'fill' | 'select' | 'focus'> {
  const r = role.toLowerCase();
  if (/button|link|menuitem|tab|switch|checkbox|radio|slider/i.test(r)) return ['click', 'focus'];
  if (/textbox|searchbox|combobox/i.test(r)) return ['fill', 'focus'];
  if (/listbox|combobox/i.test(r)) return ['select', 'focus'];
  return ['focus'];
}
