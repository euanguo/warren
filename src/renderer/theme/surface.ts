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

/** Tooltip：对齐 OpenBot `.ui-motion-tooltip-label`（实色 bg-sheet + 1px menu-edge，与菜单同源）。 */
export const elevatedTooltipSurfaceClass = cn(
  'rounded-[var(--radius-md)] bg-tooltip text-tooltip-foreground [box-shadow:var(--elevation-popover)]',
);

/** 输入组合壳层。 */
export const elevatedComposerSurfaceClass = cn(
  'rounded-[var(--radius-composer)] border border-border-strong bg-control text-foreground shadow-none',
);

/**
 * 分组内容卡片（插件卡、凭据行、设置卡等，对齐 OpenBot `.settings-modal-card`）。
 * 12px 标准圆角 + 实色 surface 底 + 零阴影（暗色靠纯净色差无需硬框，浅色极淡 1px 发丝边防融底）。
 */
export const cardSurfaceClass = cn(
  'rounded-[var(--radius-lg)] border border-border bg-grouped p-4 shadow-none dark:border-transparent',
);

/**
 * 默认表单字段外观（Input / SelectTrigger / Textarea，对齐 OpenBot `.ui-input`）。
 * 32px 高度 · 8px 圆角 · 纯实色表面 · 1px 边框 · 零内凹阴影（不写 min-h 阻断调用方高度覆盖）。
 */
export const controlFieldClass = cn(
  'h-[var(--control-height-field)] rounded-[var(--control-radius-field)] border border-border-strong bg-control px-[var(--control-pad-x-field)] py-[var(--control-pad-y-field)] text-[13px] leading-[18px] text-foreground shadow-none',
  'placeholder:text-subtle-foreground',
  'disabled:cursor-not-allowed disabled:opacity-[0.42]',
  'aria-invalid:border-danger',
);

/** 紧凑表单字段（28px 高度）。 */
export const controlFieldCompactClass = cn(
  'h-[var(--control-height-compact)] rounded-[var(--control-radius)] border border-border-strong bg-control px-[var(--control-pad-x-compact)] text-[13px] leading-[18px] text-foreground shadow-none',
  'placeholder:text-subtle-foreground',
  'disabled:cursor-not-allowed disabled:opacity-[0.42]',
  'aria-invalid:border-danger',
);

/** 统一控件焦点：对齐 OpenBot `.ui-input:focus-visible`（单 1px border-focus，不叠双层厚边）。 */
export const controlFocusClass = cn(
  'outline-none focus:outline-none focus-visible:outline-none',
  'focus-visible:ring-0 focus-visible:ring-transparent',
  'focus-visible:border-focus',
);

/** 无框交互控件焦点环：对齐 OpenBot `--openbot-focus-ring`（1px 中性外环，用于按钮、列表项与标签）。 */
export const controlRingFocusClass = cn(
  'outline-none focus:outline-none focus-visible:outline-none',
  'focus-visible:ring-0 focus-visible:ring-transparent',
  'focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]',
);

/** 图标按钮无边框稳定几何。 */
export const controlIconChromeClass = cn(
  'border border-transparent shadow-none',
  'focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]',
);

/** 侧栏与列表行交互（0ms 瞬时悬停，无拖尾）。 */
export const listItemInteractiveClass = cn(
  'rounded-[var(--control-radius)] text-foreground outline-hidden transition-none',
  'hover:bg-surface-hover focus-visible:bg-surface-hover',
  'active:bg-surface-active',
  'focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]',
);

/** 画布 / 侧栏上的选中项（暗色为 OpenBot 纯净 bg-surface 无框；浅色为纯白 + 1px 极淡发丝边、零阴影）。 */
export const listItemSelectedClass =
  'border border-surface-selected-border bg-surface-selected text-foreground';

/** 菜单项交互（对齐 OpenBot `action-menu.css`：同心 10px 圆角 + `--surface-highlight` 悬停 + 图标默认 muted 悬停提亮）。 */
export const menuItemInteractiveClass = cn(
  'rounded-[var(--radius-menu-item)] text-foreground outline-hidden transition-none',
  'hover:bg-surface-highlight',
  'focus:bg-surface-highlight focus:text-foreground',
  'focus-visible:bg-surface-highlight',
  'active:bg-surface-active',
  'data-highlighted:bg-surface-highlight data-highlighted:text-foreground',
  'data-[highlighted]:bg-surface-highlight',
  'aria-selected:bg-surface-highlight',
  'data-disabled:pointer-events-none data-disabled:opacity-[0.45]',
  'disabled:pointer-events-none disabled:opacity-[0.45]',
  '[&_svg]:text-muted-foreground hover:[&_svg]:text-foreground focus-visible:[&_svg]:text-foreground data-highlighted:[&_svg]:text-foreground data-[highlighted]:[&_svg]:text-foreground',
);

/** 图标按钮按下反馈。 */
export const controlActiveWashClass = 'active:bg-control-active active:scale-[0.96]';

/** 次级图标悬停转高对比文字。 */
export const iconTintClass = cn(
  'text-muted-foreground transition-none',
  'hover:text-foreground focus-visible:text-foreground',
);

/** 列表行紧凑几何（28px）。 */
export const controlRowClass = cn(
  'h-[var(--control-height-compact)] rounded-[var(--control-radius)] px-[var(--control-pad-x-compact)] py-[var(--control-pad-y-compact)] text-[13px] leading-[18px]',
);

/** 顶栏/抽屉标签芯片（对齐 OpenBot `.side-panel-tab`：0ms 悬停、无阴影）。 */
export const surfaceTabChipClass = cn(
  'inline-flex h-[var(--control-height-icon)] shrink-0 items-center gap-1.5 overflow-hidden rounded-[var(--control-radius)] border border-transparent px-[var(--control-pad-x-compact)] text-[12px] font-medium text-text-secondary transition-none select-none',
  'hover:bg-control-hover hover:text-foreground',
  controlRingFocusClass,
);

export const surfaceTabChipActiveClass = cn(
  'border-surface-selected-border bg-surface-tab-selected text-foreground hover:bg-surface-tab-selected hover:text-foreground',
);

export const surfaceTabChipIconOnlyClass = 'justify-center gap-0 px-0 size-[var(--control-height-icon)]';

export const surfaceTabStripClass = cn(
  'scroll-fade-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden',
);
