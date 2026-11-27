/**
 * 浏览器可交互语义角色判据（叶子模块，供 `snapshot.ts` 与 `ops/snapshot-compact.ts` 共用）。
 */
/** 交互角色白名单（含 ARIA 树项、网格单元、折叠三角、颜色选择器与 DOM 补盲节点）。 */
export const INTERACTIVE_ROLE_RE =
  /^(button|link|textbox|checkbox|radio|combobox|menuitem|menuitemcheckbox|menuitemradio|tab|switch|slider|searchbox|spinbutton|option|treeitem|listbox|gridcell|disclosuretriangle|colorwell|clickable|draggable|droppable|file_input)$/i;

export function isActionableRole(role: string): boolean {
  return INTERACTIVE_ROLE_RE.test(String(role || ''));
}
