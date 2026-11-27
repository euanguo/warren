import { cn } from '@/lib/utils';

/**
 * 共享表面与控件配方（OpenBot 扁平精密体系）。
 * 所有几何尺寸来自锁定基础 Token，所有颜色来自可配置配色皮肤层。
 */

/** 浮动菜单 / 下拉选择：纯实色 14px 卡片 + 1px 描边 + 克制阴影（零模糊）。 */
export const elevatedMenuSurfaceClass = cn(
  'rounded-[var(--radius-menu)] bg-menu text-menu-foreground shadow-none [box-shadow:var(--elevation-popover)]',
);

/** 对话框：20px 圆角实色层 + 1px dialog-ring。 */
export const elevatedDialogSurfaceClass = cn(
  'rounded-[var(--radius-dialog)] bg-sheet text-foreground shadow-none [box-shadow:var(--elevation-dialog)]',
);

/** 浮层面板（Popover / 快捷弹层）：14px 实色卡片。 */
export const elevatedPanelSurfaceClass = cn(
  'rounded-[var(--radius-menu)] bg-popover text-popover-foreground shadow-none [box-shadow:var(--elevation-popover)]',
);

/** Tooltip：纯实色高对比气泡 + 1px 描边，无模糊。 */
export const elevatedTooltipSurfaceClass = cn(
  'rounded-[var(--radius-md)] border border-border-strong bg-tooltip text-tooltip-foreground [box-shadow:var(--elevation-popover)]',
);

/** 输入组合壳层。 */
export const elevatedComposerSurfaceClass = cn(
  'rounded-[var(--radius-composer)] border border-border-strong bg-control text-foreground shadow-none',
);

/**
 * 分组内容卡片（插件卡、凭据行、设置卡等）。
 * 14px 标准圆角 + 1px 发丝边框 + 零阴影。
 */
export const cardSurfaceClass = cn(
  'rounded-[var(--radius-card)] border border-border bg-grouped p-3 shadow-none',
);

/**
 * 默认表单字段外观（Input / SelectTrigger / Textarea）。
 * 32px 高度 · 8px 圆角 · 纯实色表面 · 1px 边框 · 零内凹阴影。
 */
export const controlFieldClass = cn(
  'h-[var(--control-height-field)] min-h-[var(--control-height-field)] rounded-[var(--control-radius-field)] border border-border-strong bg-control px-[var(--control-pad-x-field)] py-[var(--control-pad-y-field)] text-[13px] leading-[18px] text-foreground shadow-none',
  'placeholder:text-subtle-foreground',
  'disabled:cursor-not-allowed disabled:opacity-40',
  'aria-invalid:border-danger-border',
);

/** 紧凑表单字段（28px 高度）。 */
export const controlFieldCompactClass = cn(
  'h-[var(--control-height-compact)] min-h-[var(--control-height-compact)] rounded-[var(--control-radius)] border border-border-strong bg-control px-[var(--control-pad-x-compact)] text-[13px] leading-[18px] text-foreground shadow-none',
  'placeholder:text-subtle-foreground',
  'disabled:cursor-not-allowed disabled:opacity-40',
  'aria-invalid:border-danger-border',
);

/** 统一控件焦点：1px 中性发丝环，绝不发蓝光晕。 */
export const controlFocusClass = cn(
  'outline-none focus:outline-none focus-visible:outline-none',
  'focus-visible:ring-0 focus-visible:ring-transparent',
  'focus-visible:border-focus focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]',
);

/** 图标按钮无边框稳定几何。 */
export const controlIconChromeClass = cn(
  'border border-transparent shadow-none',
  'focus-visible:border-focus focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]',
);

/** 侧栏与列表行交互（0ms 瞬时悬停，无拖尾）。 */
export const listItemInteractiveClass = cn(
  'rounded-[var(--radius-menu-item)] text-foreground outline-hidden transition-none',
  'hover:bg-surface-hover focus-visible:bg-surface-hover',
  'active:bg-surface-active',
  'focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]',
);

/** 选中列表行。 */
export const listItemSelectedClass = 'bg-surface-selected';

/** 菜单项交互（全对比文字 + 0ms 瞬时悬停，无半透明灰字）。 */
export const menuItemInteractiveClass = cn(
  'rounded-[var(--radius-menu-item)] text-foreground outline-hidden transition-none',
  'hover:bg-surface-hover',
  'focus:bg-surface-hover focus:text-foreground',
  'focus-visible:bg-surface-hover',
  'active:bg-surface-active',
  'data-highlighted:bg-surface-hover data-highlighted:text-foreground',
  'data-[highlighted]:bg-surface-hover',
  'aria-selected:bg-surface-hover',
  'data-disabled:pointer-events-none data-disabled:opacity-35',
  'disabled:pointer-events-none disabled:opacity-35',
);

/** 图标按钮按下反馈。 */
export const controlActiveWashClass = 'active:bg-control-active active:scale-[0.97]';

/** 次级图标悬停转高对比文字。 */
export const iconTintClass = cn(
  'text-muted-foreground transition-none',
  'hover:text-foreground focus-visible:text-foreground',
);

/** 列表行紧凑几何（28px）。 */
export const controlRowClass = cn(
  'h-[var(--control-height-compact)] min-h-[var(--control-height-compact)] rounded-[var(--control-radius)] px-[var(--control-pad-x-compact)] py-[var(--control-pad-y-compact)] text-[13px] leading-[18px]',
);

/** 顶栏/抽屉标签芯片（默认扁平、0ms 悬停、无阴影）。 */
export const surfaceTabChipClass = cn(
  'inline-flex h-[var(--control-height-icon)] min-h-[var(--control-height-icon)] shrink-0 items-center gap-1.5 overflow-hidden rounded-[var(--control-radius)] border border-transparent px-[var(--control-pad-x-compact)] text-[12px] font-medium text-muted-foreground transition-none select-none',
  'hover:bg-surface-hover hover:text-foreground',
  controlFocusClass,
);

export const surfaceTabChipActiveClass = cn(
  'bg-control-active text-foreground hover:bg-control-active hover:text-foreground',
);

export const surfaceTabChipIconOnlyClass = 'justify-center gap-0 px-0 size-[var(--control-height-icon)]';

export const surfaceTabStripClass = cn(
  'scroll-fade-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden',
);
