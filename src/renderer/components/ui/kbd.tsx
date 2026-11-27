import type * as React from "react";
import { cn } from "@/lib/utils";

/** 20px 等宽按键帽（OpenBot 规范：1px 发丝边 + 微底色）。 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-[18px] w-fit min-w-[18px] items-center justify-center gap-0.5 rounded-[var(--radius-xs)] border border-current/20 bg-current/10 px-1.5 font-mono text-[11px] font-medium leading-none text-current select-none shadow-none",
        "[&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <kbd data-slot="kbd-group" className={cn("inline-flex items-center gap-1", className)} {...props} />;
}

export { Kbd, KbdGroup };
