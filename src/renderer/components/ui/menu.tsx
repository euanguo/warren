import { cn } from "@/lib/utils";
import { elevatedMenuSurfaceClass, menuItemInteractiveClass } from "@/theme/surface";
import type { ButtonHTMLAttributes, HTMLAttributes } from "react";

type MenuSurfaceProps = HTMLAttributes<HTMLDivElement> & {
  readonly role?: "menu" | "listbox";
};

/**
 * Floating menu surface (dropdown / overflow / context-style).
 * Menu surface: glass fill, hairline ring, xl radius, p-1.
 */
function MenuSurface({ className, role = "menu", ...props }: MenuSurfaceProps) {
  return (
    <div
      role={role}
      data-slot="menu-surface"
      className={cn(
        elevatedMenuSurfaceClass,
        "z-50 flex min-w-44 flex-col gap-0.5 rounded-[var(--radius-menu)] p-1 select-none",
        className,
      )}
      {...props}
    />
  );
}

type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly destructive?: boolean;
};

function MenuItem({ className, destructive = false, type = "button", ...props }: MenuItemProps) {
  return (
    <button
      type={type}
      role="menuitem"
      data-slot="menu-item"
      className={cn(
        menuItemInteractiveClass,
        "flex min-h-[30px] w-full cursor-pointer items-center px-2.5 py-1.5 text-left text-[13px] leading-[18px]",
        destructive &&
          "text-danger-text hover:bg-danger-soft hover:text-danger-text focus:bg-danger-soft focus:text-danger-text data-highlighted:bg-danger-soft data-highlighted:text-danger-text",
        className,
      )}
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <hr> 带 UA 的 border/margin，会顶掉下面这行 h-px / bg-border/60
      role="separator"
      data-slot="menu-separator"
      className={cn("mx-1 my-1 h-px bg-border/60", className)}
      {...props}
    />
  );
}

function MenuLabel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="menu-label"
      className={cn(
        "px-[var(--control-pad-x-compact)] py-1 text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { MenuItem, MenuLabel, MenuSeparator, MenuSurface };
export type { MenuItemProps, MenuSurfaceProps };
