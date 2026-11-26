/**
 * 账号管理插件前端（4 面协同工作台）。
 *
 * 明文是明确产品定位，不是遗漏：界面必须持续展示明文风险提醒。
 * 注意：本入口与 `./ui/*.js` 均为无构建步骤纯浏览器 ESM，仅使用 `app.h` 与 `app.ui`。
 */
import { createDetailEditorViews } from './ui/detail-editor.js';
import { createWorkbenchViews } from './ui/dialogs-page.js';
import { createInspectorViews } from './ui/inspector.js';
import { createPopoverViews } from './ui/popover.js';
import { createAccountUiContext } from './ui/shared.js';

export default function register(app) {
  const ctx = createAccountUiContext(app);
  const { MatchStatusBadge, QuickAutofillPopover } = createPopoverViews(ctx);
  const { AccountsInspectorTab } = createInspectorViews(ctx);
  const { AccountDetailView, AccountEditorView } = createDetailEditorViews(ctx);
  const { AccountsPage } = createWorkbenchViews(ctx, { AccountDetailView, AccountEditorView });

  app.surfaces.railPage({
    id: 'accounts',
    title: '账号',
    icon: 'User',
    path: 'accounts',
    component: AccountsPage,
  });

  app.surfaces.inspectorTab({
    id: 'site-accounts',
    title: '账号',
    component: AccountsInspectorTab,
  });

  app.surfaces.popover({
    id: 'quick-autofill',
    title: '快捷填充账号',
    icon: 'Key',
    shortcut: '⇧⌘L',
    width: 380,
    height: 492,
    component: QuickAutofillPopover,
  });

  app.surfaces.statusBadge({
    id: 'match-badge',
    title: '当前页匹配账号',
    icon: 'Key',
    component: MatchStatusBadge,
  });

  app.surfaces.commandBarAction({
    id: 'quick-fill',
    title: '一键填充当前页账号',
    description: '自动匹配当前站点并填充账号密码',
    icon: 'Key',
    shortcut: '⇧⌘L',
    command: 'autoFill',
  });
}
