import { cn } from "@/lib/utils";

/**
 * Shared surface + control recipes.
 * All geometry/color come from theme tokens — components compose these, never invent px.
 */

/** Floating menu / select / dropdown glass ( 0.5px hairline + dual shadow + blur). */
export const elevatedMenuSurfaceClass = cn(
  "[corner-shape:var(--corner-shape)] bg-menu text-menu-foreground shadow-none ring-[0.5px] ring-border-heavy backdrop-blur-[var(--blur-menu)] [box-shadow:var(--elevation-popover)]",
);

export const elevatedDialogSurfaceClass = cn(
  "[corner-shape:var(--corner-shape)] rounded-[var(--radius-dialog)] bg-menu text-menu-foreground shadow-none ring-[0.5px] ring-border-heavy backdrop-blur-[var(--blur-dialog)] [box-shadow:var(--elevation-popover)]",
);

export const elevatedPanelSurfaceClass = cn(
  "[corner-shape:var(--corner-shape)] rounded-[var(--radius-menu)] bg-menu text-menu-foreground shadow-none ring-[0.5px] ring-border-heavy backdrop-blur-[var(--blur-menu)] [box-shadow:var(--elevation-popover)]",
);

/**
 * Tooltip — Measured: r12.5, 1px border (~8.4%), solid popover bg, no blur/shadow.
 */
export const elevatedTooltipSurfaceClass = cn(
  "rounded-[var(--control-radius)] border border-border bg-popover text-popover-foreground shadow-none backdrop-blur-none [corner-shape:var(--corner-shape)]",
);

/** Composer shell. */
export const elevatedComposerSurfaceClass = cn(
  "[corner-shape:var(--corner-shape)] rounded-[var(--radius-composer)] bg-input-fill text-foreground shadow-none ring-[0.5px] ring-border-heavy backdrop-blur-[var(--blur-menu)] [box-shadow:var(--elevation-popover)]",
);

/**
 * 面板内的一组内容（插件卡、凭据行、分组卡片…）。
 * 圆角走 token——各处手写 `rounded-lg` 会绕开 --radius-scale，换肤时对不上。
 */
export const cardSurfaceClass = cn(
  "rounded-[var(--radius-lg)] border border-border p-3 [corner-shape:var(--corner-shape)]",
);

/**
 * DEFAULT field chrome (Input / SelectTrigger / Textarea).
 * Dialog field (legacy reference ~39h): h≈39, radius-xl≈15, pad 8×12, fill rgba(45,45,45,0.96), border 15.6%.
 */
export const controlFieldClass = cn(
  "[corner-shape:var(--corner-shape)] h-[var(--control-height-field)] min-h-[var(--control-height-field)] rounded-[var(--control-radius-field)] border border-input bg-input-fill px-[var(--control-pad-x-field)] py-[var(--control-pad-y-field)] text-sm leading-[21px] text-foreground shadow-none",
  "placeholder:text-subtle-foreground",
  "disabled:cursor-not-allowed disabled:opacity-40",
  "aria-invalid:border-destructive",
);

/** Compact field (dense chrome / toolbar selects) — still tokenized. */
export const controlFieldCompactClass = cn(
  "[corner-shape:var(--corner-shape)] h-[var(--control-height-compact)] min-h-[var(--control-height-compact)] rounded-[var(--control-radius)] border border-input bg-input-fill px-[var(--control-pad-x-compact)] text-sm leading-[18px] text-foreground shadow-none",
  "placeholder:text-subtle-foreground",
  "disabled:cursor-not-allowed disabled:opacity-40",
  "aria-invalid:border-destructive",
);

/** Shared control focus: thin blue hairline, never ring bloom. */
export const controlFocusClass = cn(
  "outline-none focus:outline-none focus-visible:outline-none",
  "focus-visible:ring-0 focus-visible:ring-transparent",
  "focus-visible:border-focus",
);

/** Icon chrome often keeps 1px transparent border for stable hit geometry. */
export const controlIconChromeClass = cn(
  "border border-transparent shadow-none",
  "focus-visible:border-focus",
);

/** Sidebar / list row hover+focus wash (list-hover 7.8%). */
export const listItemInteractiveClass = cn(
  "[corner-shape:var(--corner-shape)] rounded-[var(--radius-menu-item)] text-foreground outline-hidden",
  "hover:bg-surface-hover focus:bg-surface-hover focus-visible:bg-surface-hover",
  "active:bg-surface-hover",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border",
);

/** Selected / current row (list-active-selection 5.2%). */
export const listItemSelectedClass = "bg-surface-selected";

/**
 * Floating menu items ([cmdk-item]):
 * base opacity 0.7 → hover/selected opacity 1 + list-hover wash.
 */
export const menuItemInteractiveClass = cn(
  "[corner-shape:var(--corner-shape)] rounded-[var(--radius-menu-item)] text-foreground outline-hidden opacity-70",
  "hover:bg-surface-hover hover:opacity-100",
  "focus:bg-surface-hover focus:opacity-100 focus:text-foreground",
  "focus-visible:bg-surface-hover focus-visible:opacity-100",
  "active:bg-surface-hover active:opacity-100",
  "data-highlighted:bg-surface-hover data-highlighted:opacity-100 data-highlighted:text-foreground",
  "data-[highlighted]:bg-surface-hover data-[highlighted]:opacity-100",
  "aria-selected:bg-surface-hover aria-selected:opacity-100",
  "data-disabled:pointer-events-none data-disabled:opacity-25",
  "disabled:pointer-events-none disabled:opacity-25",
);

/** Icon chrome press (enabled:active:bg-token-foreground/15). */
export const controlActiveWashClass = "active:bg-foreground/15";

/** Muted icon → full ink on hover/focus. */
export const iconTintClass = cn(
  "text-subtle-foreground",
  "hover:text-foreground focus-visible:text-foreground",
);

/** Sidebar / list row geometry: compact control height. */
export const controlRowClass = cn(
  "[corner-shape:var(--corner-shape)] h-[var(--control-height-compact)] min-h-[var(--control-height-compact)] rounded-[var(--control-radius)] px-[var(--control-pad-x-compact)] py-[var(--control-pad-y-compact)] text-sm leading-[1.325]",
);

/**
 * Shell surface tab chip (center content tabs / inspector pane tabs).
 * Height matches header icon chrome (28); active uses selected wash, not accent fill.
 */
export const surfaceTabChipClass = cn(
  "[corner-shape:var(--corner-shape)] inline-flex h-[var(--control-height-icon)] min-h-[var(--control-height-icon)] shrink-0 items-center gap-1.5 overflow-hidden rounded-[var(--control-radius)] border border-transparent px-[var(--control-pad-x-compact)] text-[length:var(--font-size-caption)] font-normal text-subtle-foreground transition-colors select-none",
  "hover:bg-surface-hover hover:text-foreground",
  controlFocusClass,
);

export const surfaceTabChipActiveClass = cn(
  "bg-surface-selected text-foreground hover:bg-surface-selected hover:text-foreground",
);

export const surfaceTabChipIconOnlyClass =
  "justify-center gap-0 px-0 size-[var(--control-height-icon)]";

export const surfaceTabStripClass = cn(
  "scroll-fade-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden",
);
