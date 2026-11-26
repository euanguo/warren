import type { TargetInput } from '../../../shared/types.ts';
import type { PageContext } from '../ctx.ts';
import { err, evalOnNode, nodeIdFor, resolveTarget } from '../page-helpers.ts';

export type InspectProp = 'url' | 'title' | 'text' | 'html' | 'value' | 'attr' | 'box';
export type InspectState = 'visible' | 'enabled' | 'checked';

function escapeCssAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 把 `warren browser find <env> <by> <spec>` 的定位方式归一成标准 `TargetInput`。 */
export function targetFromBy(by: string, spec: string, name?: string): TargetInput {
  switch (by) {
    case 'role':
      return { kind: 'role', role: spec, ...(name ? { name } : {}) };
    case 'text':
      return { kind: 'text', text: spec };
    case 'label':
      return { kind: 'label', text: spec };
    case 'placeholder':
      return { kind: 'selector', selector: `[placeholder*="${escapeCssAttr(spec)}"]` };
    case 'testid':
      return { kind: 'selector', selector: `[data-testid="${escapeCssAttr(spec)}"]` };
    case 'selector':
    case 'css':
      return { kind: 'selector', selector: spec };
    case 'xpath':
      return { kind: 'xpath', xpath: spec };
    default:
      throw err('BAD_REQUEST', `不支持的定位类型 ${by}（支持 role/label/text/placeholder/testid/selector/xpath）`);
  }
}

/** 原子读取目标属性（url / title / text / html / value / attr / box），支持跨源 iframe。 */
export async function readTargetProperty(
  ctx: PageContext,
  prop: InspectProp,
  target?: TargetInput,
  attrName?: string,
): Promise<unknown> {
  if (prop === 'url') return ctx.wc.getURL();
  if (prop === 'title') return ctx.wc.getTitle();
  if (target === undefined) throw err('BAD_REQUEST', `${prop} 需要目标定位器`);

  const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);

  switch (prop) {
    case 'text':
      return evalOnNode(ctx, nodeId, '(el) => String(el.innerText ?? el.textContent ?? "").trim()', sessionId);
    case 'html':
      return evalOnNode(ctx, nodeId, '(el) => String(el.outerHTML ?? "")', sessionId);
    case 'value':
      return evalOnNode(ctx, nodeId, '(el) => ("value" in el ? el.value : el.getAttribute("value"))', sessionId);
    case 'attr': {
      if (!attrName) throw err('BAD_REQUEST', 'attr 需要指定属性名');
      return evalOnNode(ctx, nodeId, `(el) => el.getAttribute(${JSON.stringify(attrName)})`, sessionId);
    }
    case 'box':
      return evalOnNode(
        ctx,
        nodeId,
        '(el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 }; }',
        sessionId,
      );
    default:
      throw err('BAD_REQUEST', `未知属性 ${String(prop)}`);
  }
}

/** 原子检查元素状态（visible / enabled / checked）。 */
export async function checkTargetState(ctx: PageContext, state: InspectState, target: TargetInput): Promise<boolean> {
  const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);

  switch (state) {
    case 'visible':
      return Boolean(
        await evalOnNode(
          ctx,
          nodeId,
          `(el) => {
            if (!el || !el.isConnected) return false;
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }`,
          sessionId,
        ),
      );
    case 'enabled':
      return Boolean(
        await evalOnNode(ctx, nodeId, '(el) => !el.disabled && el.getAttribute("aria-disabled") !== "true"', sessionId),
      );
    case 'checked':
      return Boolean(
        await evalOnNode(
          ctx,
          nodeId,
          '(el) => Boolean(el.checked || el.getAttribute("aria-checked") === "true")',
          sessionId,
        ),
      );
    default:
      throw err('BAD_REQUEST', `未知状态检查 ${String(state)}`);
  }
}
