/**
 * 动作可用性：动作重试循环（对标 Playwright `_retryAction`）+ 元素状态检查
 * （对标 `checkElementStates` / `expectHitTarget`）。
 *
 * 为什么要有这层：CDP 的输入命令对「点不中」是**静默成功**的——坐标正确、命令返回、
 * 页面毫无反应。Playwright 靠「等元素可用 + 不满足就重试 + 命中诊断」把静默失败变成
 * 可读错误；我们照做。
 */
import type { PageContext } from './ctx.ts';
import { ACTION_TIMEOUT_DEFAULT, err, evalOnNode, nodeIdFor } from './page-helpers.ts';

export type ActionName =
  'click' | 'dblclick' | 'hover' | 'drag' | 'fill' | 'selectOption' | 'focus' | 'press' | 'setInputFiles';

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
      return ['visible', 'enabled'];
    case 'focus':
    case 'press':
    case 'setInputFiles':
      return [];
  }
}

/**
 * 可重试的错误：元素还没出现/还不可用/被挡住，下一次尝试可能就好了。
 * `TARGET_AMBIGUOUS` **不在**这里：多匹配是定位写错了，等多久都不会变唯一
 * （Playwright 的 strict 模式同样是立刻报错）。
 */
const RETRYABLE = new Set(['TARGET_NOT_FOUND', 'NOT_ACTIONABLE', 'TARGET_OCCLUDED', 'NODE_DETACHED']);

export function isRetryable(error: unknown): boolean {
  return RETRYABLE.has((error as { code?: string })?.code ?? '');
}

/**
 * 动作重试循环。每次 attempt **重新解析目标**——DOM 重渲染后拿到的是新节点
 * （Playwright 同款；我们之前只解析一次，重渲染就点到已脱离文档的旧节点）。
 *
 * 不可重试的错误（BAD_SELECTOR / PATH_DENIED / DIALOG_OPEN / TARGET_STALE …）直接抛原错，
 * 不要把它们拖到超时——那会让 agent 以为是「等不到」而不是「参数错」。
 */
export async function runAction<T>(options: {
  name: string;
  timeoutMs?: number;
  attempt: (retry: number) => Promise<T>;
}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_DEFAULT;
  const deadline = Date.now() + timeoutMs;
  const history: string[] = [];
  for (let retry = 0; ; retry++) {
    try {
      return await options.attempt(retry);
    } catch (error) {
      const code = (error as { code?: string })?.code ?? 'ERROR';
      const message = (error as Error)?.message ?? String(error);
      history.push(`#${retry + 1} ${code}: ${message.slice(0, 200)}`);
      if (!isRetryable(error)) throw error;
      if (Date.now() >= deadline) {
        // 超时错误必须自带重试历史：agent 拿到「等了什么、每次都看到什么」才能自纠错
        throw err(
          'TIMEOUT',
          `${options.name} 超时 ${timeoutMs}ms（${retry + 1} 次尝试）\n  ${history.slice(-10).join('\n  ')}`,
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
  hit: { ok: true } | { ok: false; blocker: string };
}

/** 元素状态 + 命中目标，一次求值算齐（省一次 CDP 往返）。 */
const STATE_SCRIPT = `(el) => new Promise((resolve) => {
  const read = () => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const before = read();
  requestAnimationFrame(() => {
    const after = read();
    const cs = getComputedStyle(el);
    const visible = after[2] > 0 && after[3] > 0 && cs.visibility !== 'hidden';
    const disabled = !!(el.disabled ?? (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));
    const stable = before.every((v, i) => v === after[i]);
    let hit = { ok: true };
    if (after[2] > 0 && after[3] > 0) {
      const x = Math.min(Math.max(after[0] + after[2] / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(after[1] + after[3] / 2, 0), innerHeight - 1);
      let node = document.elementFromPoint(x, y);
      while (node && node.shadowRoot) {
        const inner = node.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === node) break;
        node = inner;
      }
      const describe = (n) => n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')
        + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/).join('.') : '') : '未知元素';
      let cur = node;
      while (cur && cur !== el) cur = cur.assignedSlot || cur.parentElement || (cur.getRootNode ? cur.getRootNode().host : null) || null;
      if (cur !== el) hit = { ok: false, blocker: describe(node) };
    }
    resolve({ visible, stable, enabled: !disabled, editable: !disabled && el.readOnly !== true, hit });
  });
})`;

/**
 * 检查元素是否满足这些状态；不满足抛可重试的错误。
 *
 * **必须在 scrollIntoView 之后调用**：坐标与命中检测都依赖元素已在视口内。
 */
export async function checkActionable(
  ctx: PageContext,
  backendNodeId: number,
  states: ElementState[],
  sessionId?: string,
): Promise<void> {
  if (states.length === 0) return;
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
  const snapshot = (await evalOnNode(ctx, nodeId, STATE_SCRIPT, sessionId)) as StateSnapshot | null;
  if (!snapshot) throw err('NODE_DETACHED', '元素在检查过程中被移除');
  if (states.includes('visible') && !snapshot.visible) {
    throw err('NOT_ACTIONABLE', '元素不可见（零尺寸或 visibility:hidden）');
  }
  if (states.includes('stable') && !snapshot.stable) {
    throw err('NOT_ACTIONABLE', '元素正在移动（连续两帧位置不一致）');
  }
  if (states.includes('enabled') && !snapshot.enabled) {
    throw err('NOT_ACTIONABLE', '元素是 disabled');
  }
  if (states.includes('editable') && !snapshot.editable) {
    throw err('NOT_ACTIONABLE', '元素不可编辑（disabled 或 readonly）');
  }
  if (states.includes('receivesEvents') && !snapshot.hit.ok) {
    throw err('TARGET_OCCLUDED', `目标被 <${snapshot.hit.blocker}> 遮挡`);
  }
}
