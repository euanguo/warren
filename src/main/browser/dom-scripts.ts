/**
 * 注入目标页面（`Runtime.callFunctionOn`）执行的共享 DOM 脚本常量。
 *
 * 集中在纯叶子模块中统一防 DOM Clobbering / Shadow DOM 穿透逻辑，
 * 避免 `actionability.ts` / `actions.ts` / `click-point.ts` 各自重复实现。
 */

const SAFE_DOM_PREAMBLE = `
  const tagGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
  const safeTag = (n) => {
    try { return n && n.nodeType === 1 ? String(tagGetter ? tagGetter.call(n) : n.tagName).toLowerCase() : ''; }
    catch { return ''; }
  };
  const safeAttr = (n, k) => {
    try { return typeof n.getAttribute === 'function' ? n.getAttribute(k) : null; }
    catch { return null; }
  };
  const parentOf = (n) => n.assignedSlot || n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
`;

/** 校验命中节点是否等价于目标、位于目标内部，或是激活目标的关联 `<label>`。 */
export const RELATION_CHECK_JS = `(target, hit) => {
  if (!target || !hit) return false;
  if (target === hit) return true;
${SAFE_DOM_PREAMBLE}
  let cur = hit;
  while (cur) {
    if (cur === target) return true;
    cur = parentOf(cur);
  }
  cur = hit;
  let hitLabel = null;
  const interactiveBetween = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
  while (cur && cur.nodeType === 1) {
    const tag = safeTag(cur);
    if (tag === 'label') {
      hitLabel = cur;
      break;
    }
    if (cur !== target && interactiveBetween.has(tag)) {
      return false;
    }
    cur = parentOf(cur);
  }
  if (hitLabel && hitLabel.control === target) return true;
  if (safeTag(target) === 'label' && target.control === hit) return true;
  return false;
}`;

const IS_VISIBLE_EL_BODY = `
  const isVisibleEl = (node) => {
    const cs = getComputedStyle(node);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.display === 'none') return false;
    if (typeof node.checkVisibility === 'function') {
      try {
        if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          if (cs.display !== 'contents') return false;
        }
      } catch {}
    } else if (Number(cs.opacity) === 0) {
      return false;
    }
    if (cs.display === 'contents') {
      for (const child of node.children) {
        const cr = child.getBoundingClientRect();
        if (cr.width > 0 && cr.height > 0) return true;
      }
      return false;
    }
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
`;

/** 单元素可见性判断脚本，供 `waitForSelector` 与 `actionability` 共用统一口径。 */
export const ELEMENT_VISIBLE_JS = `(el) => {
${IS_VISIBLE_EL_BODY}
  return isVisibleEl(el);
}`;

/** 深度元素状态与命中检测脚本（Shadow DOM / `display:contents` / `checkVisibility` / `inert` / 模态遮挡）。 */
export const ACTIONABILITY_STATE_JS = `(el) => new Promise((resolve) => {
${SAFE_DOM_PREAMBLE}
${IS_VISIBLE_EL_BODY}
  const readRect = () => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  };
  const isDisabledByFieldset = (node) => {
    let cur = node;
    while (cur && cur.nodeType === 1) {
      const parent = cur.parentElement;
      if (parent && safeTag(parent) === 'fieldset' && parent.hasAttribute('disabled')) {
        const firstLegend = Array.from(parent.children).find((c) => safeTag(c) === 'legend');
        if (!firstLegend || !firstLegend.contains(node)) return true;
      }
      cur = parentOf(cur);
    }
    return false;
  };
  const isInert = (node) => {
    let cur = node;
    while (cur && cur.nodeType === 1) {
      if (cur.inert === true || cur.hasAttribute?.('inert')) return true;
      cur = parentOf(cur);
    }
    return false;
  };
  const isFloatingFlyout = (node) => {
    const role = (safeAttr(node, 'role') || '').toLowerCase();
    if (!/^(menuitem|menuitemcheckbox|menuitemradio|option)$/.test(role)) return false;
    let cur = node;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 12; depth++) {
      const pos = getComputedStyle(cur).position;
      if (pos === 'fixed' || pos === 'absolute') return true;
      cur = parentOf(cur);
    }
    return false;
  };
  const describe = (n) => {
    if (!n || n.nodeType !== 1) return '未知元素';
    const tag = safeTag(n) || 'element';
    const id = safeAttr(n, 'id');
    const cls = (safeAttr(n, 'class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
    return tag + (id ? '#' + id : '') + (cls ? '.' + cls : '');
  };
  const findTopmostModal = () => {
    const modals = [...document.querySelectorAll(':modal, [aria-modal="true"], dialog[open]')];
    for (let i = modals.length - 1; i >= 0; i--) {
      const m = modals[i];
      if (!isVisibleEl(m)) continue;
      const mr = m.getBoundingClientRect();
      const samples = [
        [mr.left + mr.width / 2, mr.top + mr.height / 2],
        [mr.left + mr.width * 0.25, mr.top + mr.height * 0.25],
        [mr.left + mr.width * 0.75, mr.top + mr.height * 0.25],
        [mr.left + mr.width * 0.25, mr.top + mr.height * 0.75],
        [mr.left + mr.width * 0.75, mr.top + mr.height * 0.75],
      ];
      for (const [sx, sy] of samples) {
        if (sx < 0 || sy < 0 || sx >= innerWidth || sy >= innerHeight) continue;
        let hit = document.elementFromPoint(sx, sy);
        while (hit && hit.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(sx, sy);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        let c = hit;
        while (c) {
          if (c === m) return m;
          c = parentOf(c);
        }
      }
    }
    return null;
  };

  const before = readRect();
  requestAnimationFrame(() => {
    const after = readRect();
    const visible = isVisibleEl(el);
    const inert = isInert(el);
    const disabled =
      inert ||
      el.disabled === true ||
      safeAttr(el, 'aria-disabled') === 'true' ||
      isDisabledByFieldset(el);
    const stable = before.every((v, i) => Math.abs(v - after[i]) < 0.5);
    const inViewport =
      after[2] > 0 &&
      after[3] > 0 &&
      after[0] + after[2] > 0 &&
      after[1] + after[3] > 0 &&
      after[0] < innerWidth &&
      after[1] < innerHeight;
    let hit = { ok: true };
    if (visible && after[2] > 0 && after[3] > 0) {
      const x = Math.min(Math.max(after[0] + after[2] / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(after[1] + after[3] / 2, 0), innerHeight - 1);
      let node = document.elementFromPoint(x, y);
      while (node && node.shadowRoot) {
        const inner = node.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === node) break;
        node = inner;
      }
      let ok = false;
      let cur = node;
      while (cur) {
        if (cur === el) { ok = true; break; }
        cur = parentOf(cur);
      }
      if (!ok && node && node.nodeType === 1) {
        let c = node;
        let blocked = false;
        while (c && c.nodeType === 1) {
          const t = safeTag(c);
          if (t === 'label') {
            if (!blocked && c.control === el) ok = true;
            break;
          }
          if (c !== el && (t === 'a' || t === 'button')) blocked = true;
          c = parentOf(c);
        }
      }
      if (!ok) {
        const modal = findTopmostModal();
        const modalDesc = modal && !modal.contains(el) ? describe(modal) : undefined;
        hit = { ok: false, blocker: describe(node), ...(modalDesc ? { modalBlocker: modalDesc } : {}) };
      }
    }
    const readOnly = el.readOnly === true || safeAttr(el, 'aria-readonly') === 'true';
    resolve({
      visible,
      stable,
      enabled: !disabled,
      editable: !disabled && !readOnly,
      inert,
      inViewport,
      floatingFlyout: isFloatingFlyout(el),
      hit,
    });
  });
})`;

/** 从 `<label>` 或单控件包装器解析真实 fillable 元素。 */
export const RESOLVE_FILL_CONTROL_FN = `function () {
  const el = this;
${SAFE_DOM_PREAMBLE}
  const tag = safeTag(el);
  if (tag === 'label' && el.control) return el.control;
  if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) {
    const inner = el.querySelectorAll?.('input:not([type="hidden"]), textarea, [contenteditable=""], [contenteditable="true"]');
    if (inner && inner.length === 1) return inner[0];
  }
  return null;
}`;

/** fill 前置检查与全选（绝不将明文 value 拼进脚本源码）。 */
export const FILL_PREPARE_JS = `(el, clearFirst, numberInvalid) => {
${SAFE_DOM_PREAMBLE}
  let target = el;
  const initialTag = safeTag(target);
  if (initialTag === 'label' && target.control) {
    target = target.control;
  } else if (initialTag !== 'input' && initialTag !== 'textarea' && !target.isContentEditable) {
    const inner = target.querySelectorAll?.('input:not([type="hidden"]), textarea, [contenteditable=""], [contenteditable="true"]');
    if (inner && inner.length === 1) target = inner[0];
  }
  const tag = safeTag(target);
  const type = tag === 'input' ? String(target.type || 'text').toLowerCase() : tag;
  const isPassword = tag === 'input' && type === 'password';
  const prevValue = 'value' in target ? String(target.value ?? '') : String(target.textContent ?? '');
  const maxLength = typeof target.maxLength === 'number' && target.maxLength > 0 ? target.maxLength : -1;

  if (tag === 'input') {
    const byAssign = ['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week'];
    const byTyping = ['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url'];
    if (!byAssign.includes(type) && !byTyping.includes(type)) {
      return { status: 'error', message: 'input type "' + type + '" 不能 fill' };
    }
    if (type === 'number' && numberInvalid) {
      return { status: 'error', message: 'number 输入框不接受非数字（请传入合法数字）' };
    }
    if (byAssign.includes(type)) {
      return { status: 'assign', type, isPassword: false, prevValue, maxLength };
    }
  } else if (tag !== 'textarea' && !target.isContentEditable) {
    return { status: 'error', message: '不是 input/textarea/contenteditable' };
  }

  target.focus();
  let selectedAll = false;
  if (clearFirst) {
    if (typeof target.select === 'function') {
      try {
        target.select();
        selectedAll = true;
      } catch {}
    }
    if (!selectedAll && target.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
          selectedAll = true;
        }
      } catch {}
    }
  }
  return {
    status: 'needsinput',
    type,
    isPassword,
    isContentEditable: Boolean(target.isContentEditable),
    selectedAll,
    prevValue: isPassword ? '' : prevValue,
    prevLength: prevValue.length,
    maxLength,
  };
}`;

/** 对特种控件（date/color/range 等）走参数化原生 setter 赋值并校验格式。 */
export const FILL_ASSIGN_JS = `(el, rawValue) => {
  const type = String(el.type || 'text').toLowerCase();
  const v = type === 'color' ? String(rawValue).toLowerCase() : String(rawValue).trim();
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, v);
  else el.value = v;
  if (el.value !== v) {
    const formatHints = {
      date: 'YYYY-MM-DD',
      time: 'HH:MM 或 HH:MM:SS',
      'datetime-local': 'YYYY-MM-DDTHH:MM',
      month: 'YYYY-MM',
      week: 'YYYY-Www',
      color: '#rrggbb',
      range: 'min..max 之间的数字',
    };
    return {
      status: 'error',
      message: '页面拒绝了 ' + type + ' 值，请确认格式为 ' + (formatHints[type] || '合法值'),
    };
  }
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { status: 'done' };
}`;

/** 穿透 Shadow DOM 读取当前真正拥有焦点的元素值（兼容 Combobox 弹出层焦点转移）。 */
export const ACTIVE_READBACK_JS = `(el) => {
${SAFE_DOM_PREAMBLE}
  const deepActive = () => {
    let cur = document.activeElement;
    while (cur && cur.shadowRoot && cur.shadowRoot.activeElement) {
      cur = cur.shadowRoot.activeElement;
    }
    return cur;
  };
  const active = deepActive();
  const readVal = (n) => {
    if (!n) return '';
    return 'value' in n ? String(n.value ?? '') : String(n.textContent ?? '');
  };
  let target = el;
  if (safeTag(target) === 'label' && target.control) target = target.control;
  const moved = Boolean(active && active !== target && (safeTag(active) === 'input' || safeTag(active) === 'textarea' || active.isContentEditable));
  return {
    value: readVal(moved ? active : target),
    targetValue: readVal(target),
    moved,
  };
}`;
