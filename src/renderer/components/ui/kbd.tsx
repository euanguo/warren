import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Kbd chip (inside tooltip): ~16h, r10, border-0, bg current/10, px-1.5 py-0.5, text-xs.
 * Tooltip shell owns the 1px border — not the kbd.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-4 w-fit min-w-4 items-center justify-center gap-1 rounded-[var(--control-radius-icon)] border-0 bg-current/10 px-1.5 py-0.5 font-sans text-xs font-normal leading-none text-current select-none shadow-none",
        "[&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
