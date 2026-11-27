"use client";

/** Product visual source (components/ui). Stock: ui-reference (do not import). */
import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { elevatedMenuSurfaceClass, menuItemInteractiveClass } from "@/theme/surface";

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuPortal({ ...props }: ContextMenuPrimitive.Portal.Props) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />;
}

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      className={cn("select-none", className)}
      {...props}
    />
  );
}

/**
 * Pointer-anchored menu surface.
 * Do not force side="right" on the main content — Base anchors to the click point.
 *
 * `collisionBoundary` 是给「菜单不许压到原生页面视图」用的：页面是原生视图，
 * DOM 浮层压上去就被盖住、点不到，只能靠让开页面来解。让菜单一开始就待在
 * 发起它的那个面板里，页面就不用让开（见 lib/native-view-overlay-guard.ts）。
 */
function ContextMenuContent({
  className,
  collisionBoundary,
  collisionPadding,
  ...props
}: ContextMenuPrimitive.Popup.Props &
  Partial<
    Pick<
      ContextMenuPrimitive.Positioner.Props,
      | "align"
      | "alignOffset"
      | "side"
      | "sideOffset"
      | "collisionBoundary"
      | "collisionPadding"
    >
  >) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        sideOffset={2}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            elevatedMenuSurfaceClass,
            "z-50 flex max-h-(--available-height) min-w-44 origin-(--transform-origin) flex-col gap-0.5 overflow-x-hidden overflow-y-auto rounded-[var(--radius-menu)] p-1 text-menu-foreground outline-none",
            "warren-menu-enter data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: ContextMenuPrimitive.GroupLabel.Props & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "px-[var(--control-pad-x-compact)] py-[var(--control-pad-y-compact)] text-sm text-muted-foreground data-inset:pl-7",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: ContextMenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        menuItemInteractiveClass,
        "relative flex min-h-[30px] cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px] leading-[18px] select-none data-inset:pl-7",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        variant === "destructive" &&
          "text-danger-text hover:bg-danger-soft hover:text-danger-text focus:bg-danger-soft focus:text-danger-text data-highlighted:bg-danger-soft data-highlighted:text-danger-text",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSub({ ...props }: ContextMenuPrimitive.SubmenuRoot.Props) {
  return <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />;
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ContextMenuPrimitive.SubmenuTrigger.Props & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        menuItemInteractiveClass,
        "flex cursor-pointer items-center gap-1.5 px-[var(--control-pad-x-compact)] py-[var(--control-pad-y-compact)] text-sm leading-[18px] select-none data-inset:pl-7",
        "data-open:bg-surface-hover data-popup-open:bg-surface-hover",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <Icon name="ChevronRight" className="ml-auto" />
    </ContextMenuPrimitive.SubmenuTrigger>
  );
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuContent>) {
  return (
    <ContextMenuContent
      data-slot="context-menu-sub-content"
      className={cn("min-w-36", className)}
      {...props}
    />
  );
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)}
      {...props}
    />
  );
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: ContextMenuPrimitive.CheckboxItem.Props & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        menuItemInteractiveClass,
        "relative flex cursor-pointer items-center gap-1.5 py-[var(--control-pad-y-compact)] pr-8 pl-[var(--control-pad-x-compact)] text-sm leading-[18px] select-none data-inset:pl-7",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <Icon name="Check" className="size-3.5" />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
};
