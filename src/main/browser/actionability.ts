/**
 * 动作可用性：动作重试循环（对标 Playwright `_retryAction`）+ 深度元素状态检查
 * （`checkVisibility`、`display:contents`、`inert` 祖先、禁用 `<fieldset>`、DOM Clobbering 防护、
 * Portal 浮层免滚动识别、CDP `DOM.getNodeForLocation` 命中归属、顶层模态检测与 AX 语义遮挡描述）。
 */
import type { PageContext } from './ctx.ts';
import { hitTestLocation, isHitAcceptable, localQuadClickPoint } from './click-point.ts';
import { ACTIONABILITY_STATE_JS } from './dom-scripts.ts';
import { richErr } from './errors.ts';
import { describeAxBlocker } from './locator.ts';
import { ACTION_TIMEOUT_DEFAULT, evalOnNode, nodeIdFor } from './page-helpers.ts';

export type ActionName =
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'drag'
  | 'fill'
  | 'selectOption'
  | 'check'
  | 'uncheck'
  | 'focus'
  | 'press'
  | 'setInputFiles';

/** 元素状态名，口径与 Playwright 一致。 */
export type ElementState = 'visible' | 'stable' | 'enabled' | 'editable' | 'receivesEvents';

/**
 * 每个动作需要哪些状态。**照抄 Playwright 的检查矩阵**（`docs/src/actionability.md`），
 * 不要凭感觉加减：`focus/press/setInputFiles` 在它那里是零检查（隐藏的 file input 是合法目标）。
 */
export function requiredStates(action: ActionName): ElementState[] {
  switch (action) {
    case 'click':
    case 'dblclick':
      return ['visible', 'stable', 'enabled', 'receivesEvents'];
    case 'hover':
    case 'drag':
      return ['visible', 'stable', 'receivesEvents'];
    case 'fill':
      return ['visible', 'enabled', 'editable'];
    case 'selectOption':
    case 'check':
    case 'uncheck':
      return ['visible', 'enabled'];
    case 'focus':
    case 'press':
    case 'setInputFiles':
      return [];
  }
}

/**
 * 可重试的错误：元素还没出现/还不可用/被挡住，下一次尝试可能就好了。
 * `TARGET_AMBIGUOUS` **不在**这里：多匹配是定位写错了，等多久都不会变唯一。
 */
const RETRYABLE = new Set(['TARGET_NOT_FOUND', 'NOT_ACTIONABLE', 'TARGET_OCCLUDED', 'NODE_DETACHED']);

export function isRetryable(error: unknown): boolean {
  return RETRYABLE.has((error as { code?: string })?.code ?? '');
}

export interface ActionRetryOptions<T> {
  name: string;
  timeoutMs?: number;
  /** 遇到联动表单短暂 disabled（如上级下拉触发下级解锁）时的最小宽限等待窗口 ms（默认 1500）。 */
  disabledGraceMs?: number;
  attempt: (retry: number) => Promise<T>;
}

/**
 * 动作重试循环。每次 attempt **重新解析目标**——DOM 重渲染后拿到的是新节点。
 * 不可重试的错误直接抛原错，不要把它们拖到超时。
 */
export async function runAction<T>(options: ActionRetryOptions<T>): Promise<T> {
  const baseTimeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_DEFAULT;
  const startedAt = Date.now();
  let deadline = startedAt + baseTimeoutMs;
  const disabledGraceMs = options.disabledGraceMs ?? (options.timeoutMs === undefined ? 1500 : 0);
  const history: string[] = [];
  let lastDetails: Record<string, unknown> | undefined;
  for (let retry = 0; ; retry++) {
    try {
      return await options.attempt(retry);
    } catch (error) {
      const errObj = error as { code?: string; message?: string; details?: { data?: Record<string, unknown> } };
      const code = errObj?.code ?? 'ERROR';
      const message = errObj?.message ?? String(error);
      if (errObj?.details?.data) lastDetails = errObj.details.data;
      history.push(`#${retry + 1} ${code}: ${message.slice(0, 200)}`);
      if (!isRetryable(error)) throw error;
      if (disabledGraceMs > 0 && /disabled/i.test(message)) {
        deadline = Math.max(deadline, startedAt + disabledGraceMs);
      }
      if (Date.now() >= deadline) {
        throw richErr(
          'TIMEOUT',
          `${options.name} 超时 ${Math.max(baseTimeoutMs, deadline - startedAt)}ms（${retry + 1} 次尝试）\n  ${history.slice(-10).join('\n  ')}`,
          lastDetails ? { data: lastDetails } : undefined,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50 * (retry + 1), 500)));
    }
  }
}

interface StateSnapshot {
  visible: boolean;
  stable: boolean;
  enabled: boolean;
  editable: boolean;
  inert: boolean;
  inViewport: boolean;
  floatingFlyout: boolean;
  hit: { ok: true } | { ok: false; blocker: string; modalBlocker?: string };
}

/**
 * 判断目标是否为已在视口内的浮动 Portal 菜单项（如 Radix/Base UI/MUI 的 menuitem/option）。
 * 若返回 true，调用方应跳过 `scrollIntoView`，避免滚动触发浮层关闭。
 */
export async function isVisibleFloatingFlyout(
  ctx: PageContext,
  backendNodeId: number,
  sessionId?: string,
): Promise<boolean> {
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId).catch(() => 0);
  if (!nodeId) return false;
  const result = await evalOnNode(
    ctx,
    nodeId,
    `(el) => {
      if (!el || el.nodeType !== 1) return false;
      const role = (typeof el.getAttribute === 'function' ? el.getAttribute('role') : '') || '';
      if (!/^(menuitem|menuitemcheckbox|menuitemradio|option)$/i.test(role)) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return false;
      const parentOf = (n) => n.assignedSlot || n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
      let cur = el;
      for (let d = 0; cur && cur.nodeType === 1 && d < 12; d++) {
        const pos = getComputedStyle(cur).position;
        if (pos === 'fixed' || pos === 'absolute') return true;
        cur = parentOf(cur);
      }
      return false;
    }`,
    sessionId,
  ).catch(() => false);
  return result === true;
}

/**
 * 检查元素是否满足目标动作所需状态；不满足抛可重试错误，并附带 AX 语义遮挡描述。
 */
export async function checkActionable(
  ctx: PageContext,
  backendNodeId: number,
  states: ElementState[],
  sessionId?: string,
): Promise<void> {
  if (states.length === 0) return;
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
  const snapshot = (await evalOnNode(ctx, nodeId, ACTIONABILITY_STATE_JS, sessionId)) as StateSnapshot | null;
  if (!snapshot) throw richErr('NODE_DETACHED', '元素在检查过程中被移除');
  if (states.includes('visible') && !snapshot.visible) {
    throw richErr('NOT_ACTIONABLE', '元素不可见（零尺寸、visibility:hidden 或 opacity:0）');
  }
  if (states.includes('stable') && !snapshot.stable) {
    throw richErr('NOT_ACTIONABLE', '元素正在移动（连续两帧位置不一致）');
  }
  if (states.includes('enabled') && !snapshot.enabled) {
    throw richErr(
      'NOT_ACTIONABLE',
      snapshot.inert ? '元素位于 inert 子树中，无法交互' : '元素是 disabled（或位于禁用的 fieldset 内）',
    );
  }
  if (states.includes('editable') && !snapshot.editable) {
    throw richErr('NOT_ACTIONABLE', '元素不可编辑（disabled、inert 或 readonly）');
  }
  if (states.includes('receivesEvents')) {
    // 优先使用浏览器引擎级 CDP `DOM.getNodeForLocation` 校验（防 elementFromPoint 伪造 + 穿透 Shadow DOM）
    const quadInfo = await localQuadClickPoint(ctx, backendNodeId, undefined, sessionId).catch(() => null);
    if (quadInfo) {
      const cdpHit = await hitTestLocation(ctx, quadInfo.point, sessionId);
      if (cdpHit?.backendNodeId) {
        const ok = await isHitAcceptable(ctx, backendNodeId, cdpHit.backendNodeId, sessionId);
        if (ok) return;
        const blockerDesc = await describeAxBlocker(ctx, cdpHit.backendNodeId, sessionId);
        const modalNote =
          !snapshot.hit.ok && snapshot.hit.modalBlocker ? `；顶层模态框：<${snapshot.hit.modalBlocker}>` : '';
        throw richErr('TARGET_OCCLUDED', `目标被 ${blockerDesc} 遮挡${modalNote}`, {
          data: {
            blocker: blockerDesc,
            ...(modalNote && !snapshot.hit.ok ? { modalBlocker: snapshot.hit.modalBlocker } : {}),
          },
        });
      }
    }
    if (!snapshot.hit.ok) {
      const modalNote = snapshot.hit.modalBlocker ? `；顶层模态框：<${snapshot.hit.modalBlocker}>` : '';
      throw richErr('TARGET_OCCLUDED', `目标被 <${snapshot.hit.blocker}> 遮挡${modalNote}`, {
        data: {
          blocker: snapshot.hit.blocker,
          ...(snapshot.hit.modalBlocker ? { modalBlocker: snapshot.hit.modalBlocker } : {}),
        },
      });
    }
  }
}
