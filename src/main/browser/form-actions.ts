/**
 * 表单、焦点、键盘组合与文件上传动作：fill / selectOption / setChecked / focus / press / setInputFiles。
 */
import type {
  ActionReceipt,
  FillOptions,
  FillWarning,
  PressOptions,
  SelectValue,
  TargetInput,
} from '../../shared/types.ts';
import type { PageContext } from './ctx.ts';
import { checkActionable, requiredStates, runAction } from './actionability.ts';
import { dispatchMouseClick, emitVisualAction, tname } from './actions.ts';
import { ACTIVE_READBACK_JS, FILL_ASSIGN_JS, FILL_PREPARE_JS, RESOLVE_FILL_CONTROL_FN } from './dom-scripts.ts';
import { richErr } from './errors.ts';
import { isMac, keyEvents } from './input.ts';
import { boxCenter, boxRect, frameOffsetFor } from './locator.ts';
import { heldModifiers } from './mouse-state.ts';
import { assertNoDialog, evalOnNode, nodeIdFor, resolveTarget, scrollIntoView } from './page-helpers.ts';
import { checkInputFiles } from './policy.ts';

/** 解析 `<label>` 或单控件容器内部真实的 fillable 元素；命中 `<label>`/包装器时返回其 `backendNodeId`。 */
async function resolveFillControl(ctx: PageContext, backendNodeId: number, sessionId?: string): Promise<number> {
  const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId).catch(() => 0);
  if (!nodeId) return backendNodeId;
  const resolved = await ctx
    .sendOn<{ object?: { objectId?: string } }>(sessionId, 'DOM.resolveNode', { nodeId })
    .catch(() => null);
  const outerObjectId = resolved?.object?.objectId;
  if (!outerObjectId) return backendNodeId;
  try {
    const res = await ctx
      .sendOn<{ result?: { objectId?: string } }>(sessionId, 'Runtime.callFunctionOn', {
        objectId: outerObjectId,
        functionDeclaration: RESOLVE_FILL_CONTROL_FN,
        returnByValue: false,
      })
      .catch(() => null);
    const innerObjectId = res?.result?.objectId;
    if (!innerObjectId) return backendNodeId;
    try {
      const desc = await ctx
        .sendOn<{ node?: { backendNodeId?: number } }>(sessionId, 'DOM.describeNode', { objectId: innerObjectId })
        .catch(() => null);
      return typeof desc?.node?.backendNodeId === 'number' ? desc.node.backendNodeId : backendNodeId;
    } finally {
      await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: innerObjectId }).catch(() => {});
    }
  } finally {
    await ctx.sendOn(sessionId, 'Runtime.releaseObject', { objectId: outerObjectId }).catch(() => {});
  }
}

/** 将 `SelectValue` 归一化为要依次匹配的字符串标签列表（供 ARIA 单选/多选 chip 共用）。 */
export function normalizeAriaSelectWants(value: SelectValue): string[] {
  if (value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    const label =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? (item.label ?? item.value ?? (item.index !== undefined ? String(item.index) : ''))
          : '';
    const trimmed = String(label ?? '').trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/** 针对一组可见 ARIA 选项执行安全匹配：精确优先；无精确匹配时仅当子串唯一命中才选，命中 >=2 报歧义不盲点。 */
export function matchAriaOption<T extends { label: string; value: string; disabled?: boolean }>(
  options: readonly T[],
  wanted: string,
): { status: 'hit'; option: T } | { status: 'not_found' } | { status: 'ambiguous'; matches: T[] } {
  const needle = wanted.trim().toLowerCase();
  const exact = options.filter(
    (o) => o.label.trim().toLowerCase() === needle || o.value.trim().toLowerCase() === needle,
  );
  if (exact.length === 1) return { status: 'hit', option: exact[0]! };
  if (exact.length > 1) return { status: 'ambiguous', matches: exact };

  const partial = options.filter(
    (o) => o.label.trim().toLowerCase().includes(needle) || o.value.trim().toLowerCase().includes(needle),
  );
  if (partial.length === 1) return { status: 'hit', option: partial[0]! };
  if (partial.length > 1) return { status: 'ambiguous', matches: partial };
  return { status: 'not_found' };
}

/**
 * 现代 DataGrid / Spreadsheet 单元格智能填值（`[role=gridcell]`/`[role=cell]`/`<td>`）：
 * 双击激活内联编辑器（必要时补按 Enter）→ 等编辑器聚焦（≤1s）→ 全选替换并按 Enter 提交 →
 * 读回 `cellChange: { before, after }`；若触发校验错误则按 Escape 退出并抛 `GRID_EDIT_REJECTED`。
 */
async function tryFillGridCell(
  ctx: PageContext,
  backendNodeId: number,
  nodeId: number,
  value: string,
  since: number,
  sessionId?: string,
): Promise<({ ok: true; cellChange: { before: string; after: string } } & ActionReceipt) | null> {
  const probe = (await evalOnNode(
    ctx,
    nodeId,
    `(el) => {
      if (!el || el.nodeType !== 1) return null;
      const role = (el.getAttribute?.('role') || '').toLowerCase();
      const tag = (el.tagName || '').toUpperCase();
      const isCell = role === 'gridcell' || role === 'cell' || tag === 'TD';
      if (!isCell) return null;
      const alreadyEditable = el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA';
      if (alreadyEditable) return null;
      return { isGridCell: true, before: String(el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim() };
    }`,
    sessionId,
  ).catch(() => null)) as { isGridCell?: boolean; before?: string } | null;
  if (!probe || probe.isGridCell !== true) return null;
  const beforeText = typeof probe.before === 'string' ? probe.before : '';

  const center = await boxCenter(ctx, backendNodeId, undefined, sessionId);
  // 1. 双击激活网格编辑器
  await dispatchMouseClick(ctx, center, { clickCount: 2 });

  const hasActiveEditor = async (): Promise<boolean> => {
    const active = (await evalOnNode(
      ctx,
      nodeId,
      `(el) => {
        const a = document.activeElement;
        if (!a || a === document.body) return false;
        const tag = (a.tagName || '').toUpperCase();
        const role = (a.getAttribute?.('role') || '').toLowerCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable || role === 'textbox' || role === 'combobox') {
          return true;
        }
        return Boolean(el.querySelector('input, textarea, select, [contenteditable="true"]'));
      }`,
      sessionId,
    ).catch(() => false)) as boolean;
    return active === true;
  };

  let editorReady = false;
  for (let i = 0; i < 6; i += 1) {
    if (await hasActiveEditor()) {
      editorReady = true;
      break;
    }
    if (i === 2) {
      const [eDown, eUp] = keyEvents('Enter');
      await ctx.sendInput('Input.dispatchKeyEvent', eDown!);
      await ctx.sendInput('Input.dispatchKeyEvent', eUp!);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!editorReady) return null;

  // 2. 全选并写入新值后按 Enter 提交
  await ctx.sendInput('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    commands: ['selectAll'],
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: isMac() ? 4 : 2,
  });
  await ctx.sendInput('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: isMac() ? 4 : 2,
  });
  const [bsDown, bsUp] = keyEvents('Backspace');
  await ctx.sendInput('Input.dispatchKeyEvent', bsDown!);
  await ctx.sendInput('Input.dispatchKeyEvent', bsUp!);
  if (value.length > 0) await ctx.sendInput('Input.insertText', { text: value });
  const [enterDown, enterUp] = keyEvents('Enter');
  await ctx.sendInput('Input.dispatchKeyEvent', enterDown!);
  await ctx.sendInput('Input.dispatchKeyEvent', enterUp!);
  await new Promise((r) => setTimeout(r, 150));

  // 3. 检查是否出现校验错误并读回单元格新值
  const verify = (await evalOnNode(
    ctx,
    nodeId,
    `(el) => {
      const invalid = el.getAttribute?.('aria-invalid') === 'true' || Boolean(el.querySelector?.('[aria-invalid="true"]'));
      const errNode = el.querySelector?.('[role="alert"], .error, .invalid-feedback') || document.querySelector?.('[role="alert"]');
      const errText = invalid && errNode ? String(errNode.textContent || '').trim() : '';
      const after = String(el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim();
      return { invalid, errText, after };
    }`,
    sessionId,
  ).catch(() => ({ invalid: false, errText: '', after: value }))) as {
    invalid: boolean;
    errText: string;
    after: string;
  };

  if (verify.invalid) {
    const [escDown, escUp] = keyEvents('Escape');
    await ctx.sendInput('Input.dispatchKeyEvent', escDown!);
    await ctx.sendInput('Input.dispatchKeyEvent', escUp!);
    throw richErr('GRID_EDIT_REJECTED', `表格单元格编辑被拒绝：${verify.errText || '校验未通过'}`);
  }

  return {
    ok: true,
    cellChange: { before: beforeText, after: verify.after },
    ...ctx.pending.receiptSince(since),
  };
}

export async function fill(
  ctx: PageContext,
  target: TargetInput,
  value: string,
  opts: FillOptions = {},
): Promise<
  {
    ok: true;
    warning?: FillWarning;
    focusMoved?: boolean;
    cellChange?: { before: string; after: string };
  } & ActionReceipt
> {
  assertNoDialog(ctx);
  const since = Date.now();
  return runAction({
    name: `fill ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const { backendNodeId: initialBackendId, sessionId } = await resolveTarget(ctx, target);
      const backendNodeId = await resolveFillControl(ctx, initialBackendId, sessionId);
      await scrollIntoView(ctx, backendNodeId, retry, sessionId);
      // 若目标是尚未展开编辑器的 DataGrid 单元格（gridcell/cell/td），优先走单元格激活协议
      if (backendNodeId === initialBackendId) {
        const maybeNodeId = await nodeIdFor(ctx, backendNodeId, sessionId).catch(() => 0);
        if (maybeNodeId) {
          const gridResult = await tryFillGridCell(ctx, backendNodeId, maybeNodeId, value, since, sessionId);
          if (gridResult) return gridResult;
        }
      }
      await checkActionable(ctx, backendNodeId, requiredStates('fill'), sessionId);
      // 若输入框位于局部滚动容器内且中心点正被同级悬浮条/底栏半遮挡（如 uitp:overlapped），
      // 主动尝试 center/start 滚出遮挡区，避免页面 input 监听因 elementFromPoint 未命中而清空输入。
      const checkCenterHit = async () => {
        const nid = await nodeIdFor(ctx, backendNodeId, sessionId).catch(() => 0);
        if (!nid) return true;
        const ok = await evalOnNode(
          ctx,
          nid,
          `(el) => {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return true;
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return false;
            let hit = document.elementFromPoint(cx, cy);
            while (hit && hit.shadowRoot) {
              const inner = hit.shadowRoot.elementFromPoint(cx, cy);
              if (!inner || inner === hit) break;
              hit = inner;
            }
            const parentOf = (n) => n.assignedSlot || n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
            let cur = hit;
            while (cur) {
              if (cur === el) return true;
              cur = parentOf(cur);
            }
            return Boolean(hit && hit.nodeType === 1 && hit.tagName === 'LABEL' && hit.control === el);
          }`,
          sessionId,
        ).catch(() => true);
        return ok === true;
      };
      if (!(await checkCenterHit())) {
        await scrollIntoView(ctx, backendNodeId, 1, sessionId);
        if (!(await checkCenterHit())) {
          await scrollIntoView(ctx, backendNodeId, 3, sessionId);
        }
      }
      const fillRect = await boxRect(ctx, backendNodeId, sessionId).catch(() => undefined);
      if (fillRect) {
        // 严禁把填进去的 value 放进 label，避免密码/凭据明文出现在遮罩层
        emitVisualAction(
          ctx,
          'fill',
          fillRect.x + fillRect.width / 2,
          fillRect.y + fillRect.height / 2,
          fillRect,
          `fill ${tname(target)}`,
        );
      }
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      await ctx.sendOn(sessionId, 'DOM.focus', { nodeId }).catch(() => {});

      const clearFirst = opts.clearFirst !== false;
      const numberInvalid = value.trim() !== '' && Number.isNaN(Number(value.trim()));
      const outcome = (await evalOnNode(ctx, nodeId, FILL_PREPARE_JS, sessionId, [clearFirst, numberInvalid])) as {
        status: 'done' | 'assign' | 'needsinput' | 'error';
        message?: string;
        type?: string;
        isPassword?: boolean;
        isContentEditable?: boolean;
        selectedAll?: boolean;
        prevValue?: string;
        prevLength?: number;
        maxLength?: number;
      } | null;
      if (outcome?.status === 'error') throw richErr('TARGET_NOT_FILLABLE', outcome.message ?? 'fill 失败');
      if (outcome?.status === 'assign') {
        const assigned = (await evalOnNode(ctx, nodeId, FILL_ASSIGN_JS, sessionId, [value])) as {
          status: 'done' | 'error';
          message?: string;
        } | null;
        if (assigned?.status === 'error') {
          throw richErr('TARGET_NOT_FILLABLE', assigned.message ?? 'fill 失败');
        }
        outcome.status = 'done';
      }
      const isSecretFill = Boolean(opts.isSecret || outcome?.isPassword);

      if (outcome?.status !== 'done') {
        if (clearFirst) {
          // 对富文本编辑器或未选中成功的控件，走 Chromium 原生 editing command `selectAll` + Backspace
          if (!outcome?.selectedAll || outcome?.isContentEditable) {
            await ctx.sendInput('Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              commands: ['selectAll'],
              key: 'a',
              code: 'KeyA',
              windowsVirtualKeyCode: 65,
              modifiers: isMac() ? 4 : 2,
            });
            await ctx.sendInput('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'a',
              code: 'KeyA',
              windowsVirtualKeyCode: 65,
              modifiers: isMac() ? 4 : 2,
            });
          }
          if (value === '' || (outcome?.prevLength ?? 0) > 0) {
            const [bsDown, bsUp] = keyEvents('Backspace');
            await ctx.sendInput('Input.dispatchKeyEvent', bsDown!);
            await ctx.sendInput('Input.dispatchKeyEvent', bsUp!);
          }
        }
        if (value.length > 0) {
          // 混合输入：前 n-1 字符高速 insertText，最后一个 ASCII 可打印字符走真实 keyDown/keyUp，
          // 以便触发依赖 keydown/keyup 的 autocomplete / combobox / datepicker。
          const lastChar = value[value.length - 1]!;
          const canTailKey = !isSecretFill && /^[\x20-\x7e]$/.test(lastChar);
          if (canTailKey) {
            const prefix = value.slice(0, -1);
            if (prefix) await ctx.sendInput('Input.insertText', { text: prefix });
            const [down, up] = keyEvents(lastChar);
            await ctx.sendInput('Input.dispatchKeyEvent', down!);
            await ctx.sendInput('Input.dispatchKeyEvent', up!);
          } else {
            await ctx.sendInput('Input.insertText', { text: value });
          }
        }
      }

      let warning: FillWarning | undefined;
      let focusMoved = false;
      // 分级回读校验：密码框或秘密填充直接跳过且绝不回显/回读明文
      if (!isSecretFill && outcome?.status !== 'done') {
        const readInfo = (await evalOnNode(ctx, nodeId, ACTIVE_READBACK_JS, sessionId).catch(() => null)) as {
          value?: string;
          targetValue?: string;
          moved?: boolean;
        } | null;
        if (readInfo && typeof readInfo.value === 'string') {
          focusMoved = Boolean(readInfo.moved);
          const actual = readInfo.value;
          const norm = (s: string) =>
            outcome?.type === 'email' || outcome?.isContentEditable ? s.replace(/\s+/g, ' ').trim() : s;
          if (norm(actual) !== norm(value)) {
            const maxLen = outcome?.maxLength ?? -1;
            if (maxLen > 0 && actual === value.slice(0, maxLen)) {
              warning = {
                kind: 'truncated',
                expectedLength: value.length,
                actualLength: actual.length,
                message: `输入达到字段 maxLength=${maxLen} 限制，已截断为 ${actual.length} 字符`,
              };
            } else if (value.length > 0 && actual.length > 0 && actual !== (outcome?.prevValue ?? '')) {
              warning = {
                kind: 'formatted',
                expectedLength: value.length,
                actualLength: actual.length,
                message: `页面已对输入值做格式化改写（期望 ${value.length} 字，读回 ${actual.length} 字）`,
              };
            } else if (value.length > 0 || actual.length > 0) {
              throw richErr('FILL_UNCONFIRMED', `FILL_UNCONFIRMED 期望 ${value.length} 字，读回 ${actual.length} 字`, {
                hint: '页面可能拦截或吞掉了输入，请检查焦点是否落在自定义组件内或存在前置弹窗',
                data: { expectedLength: value.length, actualLength: actual.length, focusMoved },
              });
            }
          }
        }
      }

      if (opts.submit) {
        const [enterDown, enterUp] = keyEvents('Enter');
        await ctx.sendInput('Input.dispatchKeyEvent', enterDown!);
        await ctx.sendInput('Input.dispatchKeyEvent', enterUp!);
      }

      return {
        ok: true,
        ...(warning ? { warning } : {}),
        ...(focusMoved ? { focusMoved } : {}),
        ...ctx.pending.receiptSince(since),
      };
    },
  });
}

/**
 * 选择下拉选项：同时支持原生 `<select>`（含 `option.disabled` 校验与 `availableOptions` 反馈）
 * 和现代 SPA 自定义 ARIA `combobox` / `listbox`。
 */
export async function selectOption(
  ctx: PageContext,
  target: TargetInput,
  value: SelectValue,
  opts: { timeoutMs?: number; by?: 'auto' | 'value' | 'label' | 'index' } = {},
): Promise<{ selected: string[]; kind?: 'native' | 'aria' } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  const byMode = opts.by ?? 'auto';
  return runAction({
    name: `selectOption ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      await scrollIntoView(ctx, backendNodeId, retry, sessionId);
      await checkActionable(ctx, backendNodeId, requiredStates('selectOption'), sessionId);
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);

      // 先判定元素是原生 <select> 还是 ARIA combobox/listbox
      const inspect = (await evalOnNode(
        ctx,
        nodeId,
        `(el) => {
          const isNative = el instanceof HTMLSelectElement;
          const role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
          return { isNative, role, isAria: role === 'combobox' || role === 'listbox' || el.getAttribute?.('aria-haspopup') === 'listbox' };
        }`,
        sessionId,
      )) as { isNative: boolean; role: string; isAria: boolean } | null;

      if (inspect?.isNative) {
        const res = (await evalOnNode(
          ctx,
          nodeId,
          `(el) => {
            const norm = ${JSON.stringify(value)};
            const byMode = ${JSON.stringify(byMode)};
            const wants = norm === null ? [] : Array.isArray(norm) ? norm : [norm];
            const available = Array.from(el.options).slice(0, 30).map((o) => ({
              value: o.value,
              label: (o.label || o.text || '').trim(),
              index: o.index,
              disabled: Boolean(o.disabled),
            }));
            const match = (opt, w) => {
              const label = (opt.label || opt.text || '').trim();
              if (typeof w === 'string') {
                if (byMode === 'value') return opt.value === w;
                if (byMode === 'label') return label === w;
                if (byMode === 'index') return String(opt.index) === w;
                return opt.value === w || label === w || opt.text === w;
              }
              if (w && typeof w === 'object') {
                if (w.value !== undefined && opt.value !== w.value) return false;
                if (w.label !== undefined && label !== w.label && opt.text !== w.label) return false;
                if (w.index !== undefined && opt.index !== w.index) return false;
                return true;
              }
              return false;
            };
            if (wants.length === 0) {
              el.value = '';
              el.selectedIndex = -1;
            } else {
              const matched = [];
              for (const opt of el.options) {
                if (wants.some((w) => match(opt, w))) matched.push(opt);
              }
              if (matched.length === 0) {
                return { status: 'not_found', available };
              }
              const disabledHit = matched.find((o) => o.disabled);
              if (disabledHit) {
                return { status: 'disabled', option: { value: disabledHit.value, label: (disabledHit.label || disabledHit.text || '').trim() }, available };
              }
              let first = true;
              for (const opt of el.options) {
                const hit = matched.includes(opt);
                if (el.multiple) opt.selected = hit;
                else if (hit && first) { opt.selected = true; first = false; }
                else if (!el.multiple) opt.selected = false;
              }
            }
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { status: 'ok', selected: Array.from(el.selectedOptions).map((o) => o.value) };
          }`,
          sessionId,
        )) as
          | { status: 'ok'; selected: string[] }
          | { status: 'not_found'; available: Array<Record<string, unknown>> }
          | { status: 'disabled'; option: { value: string; label: string }; available: Array<Record<string, unknown>> };

        if (res.status === 'not_found') {
          throw richErr('TARGET_NOT_FOUND', `下拉框中找不到匹配选项：${JSON.stringify(value)}`, {
            hint: '请从 availableOptions 中选择存在的 value 或 label',
            data: { availableOptions: res.available },
          });
        }
        if (res.status === 'disabled') {
          throw richErr(
            'NOT_ACTIONABLE',
            `选项 "${res.option.label || res.option.value}" 处于 disabled 状态，不可选择`,
            {
              data: { availableOptions: res.available },
            },
          );
        }
        return { selected: res.selected, kind: 'native', ...ctx.pending.receiptSince(since) };
      }

      if (inspect?.isAria) {
        // 自定义 ARIA combobox / listbox / 多值 chip-typeahead：逐项展开、筛选、唯一匹配并点击
        const wants = normalizeAriaSelectWants(value);
        if (wants.length === 0) {
          return { selected: [], kind: 'aria', ...ctx.pending.receiptSince(since) };
        }
        const selectedAll: string[] = [];
        const offset = sessionId ? await frameOffsetFor(ctx, sessionId) : { x: 0, y: 0 };

        for (const wantedLabel of wants) {
          const center = await boxCenter(ctx, backendNodeId, undefined, sessionId);
          if (inspect.role !== 'listbox') {
            await dispatchMouseClick(ctx, center);
            await new Promise((r) => setTimeout(r, 120));
          }
          // 若 combobox 自身或内部带输入筛选框，输入筛选词触发异步/本地过滤
          const isTypeahead = (await evalOnNode(
            ctx,
            nodeId,
            `(el) => {
              const input = el.tagName === 'INPUT' ? el : el.querySelector?.('input');
              if (!input || input.disabled || input.readOnly) return false;
              input.focus();
              input.value = '';
              input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              return true;
            }`,
            sessionId,
          ).catch(() => false)) as boolean;
          if (isTypeahead) {
            await ctx.sendInput('Input.insertText', { text: wantedLabel });
            await new Promise((r) => setTimeout(r, 150));
          }

          const collected = (await evalOnNode(
            ctx,
            nodeId,
            `(el) => {
              const controlsId = el.getAttribute?.('aria-controls') || el.getAttribute?.('aria-owns');
              const scope = (controlsId && document.getElementById(controlsId)) || (el.getAttribute?.('role') === 'listbox' ? el : document);
              const opts = Array.from(scope.querySelectorAll('[role="option"]')).filter((o) => {
                const r = o.getBoundingClientRect();
                const cs = getComputedStyle(o);
                return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
              });
              return opts.slice(0, 40).map((o, idx) => {
                const r = o.getBoundingClientRect();
                return {
                  index: idx,
                  label: (o.textContent || '').trim(),
                  value: o.getAttribute('data-value') || o.getAttribute('value') || (o.textContent || '').trim(),
                  disabled: o.getAttribute('aria-disabled') === 'true',
                  x: r.left + r.width / 2,
                  y: r.top + r.height / 2,
                };
              });
            }`,
            sessionId,
          )) as Array<{ index: number; label: string; value: string; disabled: boolean; x: number; y: number }>;

          const available = (collected ?? []).map(({ index, label, value: val, disabled }) => ({
            index,
            label,
            value: val,
            disabled,
          }));
          const matched = matchAriaOption(collected ?? [], wantedLabel);
          if (matched.status === 'not_found') {
            throw richErr('TARGET_NOT_FOUND', `ARIA 下拉列表中未找到选项：${wantedLabel}`, {
              hint: '请从 availableOptions 中选择可见的选项文本',
              data: { availableOptions: available },
            });
          }
          if (matched.status === 'ambiguous') {
            throw richErr(
              'TARGET_AMBIGUOUS',
              `ARIA 选项 "${wantedLabel}" 命中多个候选（${matched.matches.map((m) => m.label).join(', ')}），请传更精确的选项文本`,
              { data: { availableOptions: available } },
            );
          }
          if (matched.option.disabled) {
            throw richErr('NOT_ACTIONABLE', `ARIA 选项 "${matched.option.label}" 处于禁用状态`, {
              data: { availableOptions: available },
            });
          }
          await dispatchMouseClick(ctx, { x: matched.option.x + offset.x, y: matched.option.y + offset.y });
          selectedAll.push(matched.option.value);
          if (wants.length > 1) await new Promise((r) => setTimeout(r, 100));
        }

        return { selected: selectedAll, kind: 'aria', ...ctx.pending.receiptSince(since) };
      }

      throw richErr('TARGET_NOT_FILLABLE', `selectOption 失败：目标既不是 <select> 也不是 ARIA combobox/listbox`);
    },
  });
}

/**
 * 幂等勾选 / 取消勾选（checkbox / radio / switch / menuitemcheckbox）。
 * - 状态已符合目标时直接返回 `{ ok: true, changed: false, checked }`，绝不误反选；
 * - radio 不允许 `uncheck`（符合 HTML 规范，报 `NOT_ACTIONABLE`）；
 * - 隐藏的原生 `<input type="checkbox|radio">` 自动尝试点击其关联 `<label>` 或 DOM `.click()`。
 */
export async function setChecked(
  ctx: PageContext,
  target: TargetInput,
  wantChecked: boolean,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; checked: boolean; changed: boolean } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  const action = wantChecked ? 'check' : 'uncheck';
  return runAction({
    name: `${action} ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async (retry) => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      const state = (await evalOnNode(
        ctx,
        nodeId,
        `(el) => {
          const tagGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
          const safeTag = (n) => {
            try { return n && n.nodeType === 1 ? String(tagGetter ? tagGetter.call(n) : n.tagName).toLowerCase() : ''; }
            catch { return ''; }
          };
          let ctrl = el;
          if (safeTag(ctrl) === 'label' && ctrl.control) ctrl = ctrl.control;
          const tag = safeTag(ctrl);
          const inputType = tag === 'input' ? String(ctrl.type || '').toLowerCase() : '';
          const role = String(ctrl.getAttribute?.('role') || '').toLowerCase();
          const isCheckable =
            (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) ||
            /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role);
          if (!isCheckable) return { checkable: false };
          const isRadio = inputType === 'radio' || role === 'radio' || role === 'menuitemradio';
          const disabled = Boolean(ctrl.disabled || ctrl.getAttribute?.('aria-disabled') === 'true');
          const checked = tag === 'input' ? Boolean(ctrl.checked) : ctrl.getAttribute?.('aria-checked') === 'true';
          const r = ctrl.getBoundingClientRect();
          const cs = getComputedStyle(ctrl);
          const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
          return { checkable: true, isRadio, disabled, checked, visible };
        }`,
        sessionId,
      )) as {
        checkable: boolean;
        isRadio?: boolean;
        disabled?: boolean;
        checked?: boolean;
        visible?: boolean;
      } | null;

      if (!state?.checkable) {
        throw richErr('TARGET_NOT_ACTIONABLE', '目标不是 checkbox / radio / switch 控件');
      }
      if (state.disabled) {
        throw richErr('NOT_ACTIONABLE', '控件处于 disabled 状态，无法切换勾选');
      }
      if (state.isRadio && !wantChecked) {
        throw richErr('NOT_ACTIONABLE', 'radio 单选框不支持 uncheck，请选择同组其他单选项');
      }
      if (state.checked === wantChecked) {
        return { ok: true, checked: wantChecked, changed: false, ...ctx.pending.receiptSince(since) };
      }

      if (state.visible) {
        await scrollIntoView(ctx, backendNodeId, retry, sessionId);
        await checkActionable(ctx, backendNodeId, requiredStates(action), sessionId);
        const point = await boxCenter(ctx, backendNodeId, undefined, sessionId);
        await dispatchMouseClick(ctx, point);
      } else {
        // 隐藏的原生 checkbox（sr-only / opacity:0）：尝试关联 label 点击，否则原生 DOM click
        const postNodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
        await evalOnNode(
          ctx,
          postNodeId,
          `(el) => {
            const ctrl = el.tagName?.toLowerCase() === 'label' && el.control ? el.control : el;
            const lbl = (ctrl.labels && ctrl.labels[0]) || (ctrl.id ? document.querySelector('label[for="' + CSS.escape(ctrl.id) + '"]') : null);
            if (lbl && typeof lbl.click === 'function') lbl.click();
            else if (typeof ctrl.click === 'function') ctrl.click();
          }`,
          sessionId,
        );
      }

      // 验证是否切换成功
      const verifyNodeId = await nodeIdFor(ctx, backendNodeId, sessionId).catch(() => 0);
      const afterChecked = verifyNodeId
        ? await evalOnNode(
            ctx,
            verifyNodeId,
            `(el) => {
              const ctrl = el.tagName?.toLowerCase() === 'label' && el.control ? el.control : el;
              return ctrl.tagName?.toLowerCase() === 'input'
                ? Boolean(ctrl.checked)
                : ctrl.getAttribute?.('aria-checked') === 'true';
            }`,
            sessionId,
          ).catch(() => wantChecked)
        : wantChecked;

      if (Boolean(afterChecked) !== wantChecked) {
        throw richErr('NOT_ACTIONABLE', `点击后勾选状态未变为 ${wantChecked}`);
      }
      return { ok: true, checked: wantChecked, changed: true, ...ctx.pending.receiptSince(since) };
    },
  });
}

export async function focus(
  ctx: PageContext,
  target: TargetInput,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true } & ActionReceipt> {
  const since = Date.now();
  return runAction({
    name: `focus ${tname(target)}`,
    timeoutMs: opts.timeoutMs,
    attempt: async () => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      await checkActionable(ctx, backendNodeId, requiredStates('focus'), sessionId);
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      await ctx.sendOn(sessionId, 'DOM.focus', { nodeId });
      return { ok: true, ...ctx.pending.receiptSince(since) };
    },
  });
}

/**
 * press(sel?, chord, opts?)：形如 `press('Enter')` 是老全局 press(key)；
 * `press(sel, chord)` 先聚焦再按键。
 */
export async function press(
  ctx: PageContext,
  selOrChord: string | TargetInput,
  chordOrOpts?: string | PressOptions,
  maybeOpts?: PressOptions,
): Promise<{ ok: true } & ActionReceipt> {
  assertNoDialog(ctx);
  const since = Date.now();
  let chord: string;
  let opts: PressOptions;
  if (typeof selOrChord === 'string' && (chordOrOpts === undefined || typeof chordOrOpts !== 'string')) {
    chord = selOrChord as string;
    opts = (chordOrOpts as PressOptions) ?? {};
  } else {
    if (typeof chordOrOpts !== 'string') throw richErr('BAD_REQUEST', 'press(sel, chord) 的 chord 必须是字符串');
    chord = chordOrOpts;
    opts = maybeOpts ?? {};
    await runAction({
      name: `press ${tname(selOrChord as TargetInput)} ${chord}`,
      timeoutMs: opts.timeoutMs,
      attempt: async () => {
        const { backendNodeId, sessionId } = await resolveTarget(ctx, selOrChord as TargetInput);
        const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
        await ctx.sendOn(sessionId, 'DOM.focus', { nodeId });
        return { ok: true } as const;
      },
    });
  }
  const events = keyEvents(chord, { modifiers: heldModifiers(ctx.wc) });
  await ctx.sendInput('Input.dispatchKeyEvent', events[0] as Record<string, unknown>);
  if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
  await ctx.sendInput('Input.dispatchKeyEvent', events[1] as Record<string, unknown>);
  return { ok: true, ...ctx.pending.receiptSince(since) };
}

export async function setInputFiles(
  ctx: PageContext,
  target: TargetInput,
  paths: string | string[],
): Promise<{ ok: true; files: string[] } & ActionReceipt> {
  const since = Date.now();
  const list = checkInputFiles(paths);
  const { statSync } = await import('node:fs');
  for (const p of list) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      throw richErr('PATH_DENIED', `文件不存在: ${p}`);
    }
    if (!st.isFile()) throw richErr('PATH_DENIED', `不是文件: ${p}`);
  }
  return runAction({
    name: `setInputFiles ${tname(target)}`,
    attempt: async () => {
      const { backendNodeId, sessionId } = await resolveTarget(ctx, target);
      const nodeId = await nodeIdFor(ctx, backendNodeId, sessionId);
      await ctx.sendOn(sessionId, 'DOM.setFileInputFiles', { nodeId, files: list });
      return { ok: true, files: list, ...ctx.pending.receiptSince(since) };
    },
  });
}
