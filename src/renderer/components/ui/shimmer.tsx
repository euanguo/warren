import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Product shimmer text — uses shadcn `shimmer` utility (shadcn/tailwind.css).
 * Prefer this over hand-rolled pulse for streaming / loading chrome.
 */
export function Shimmer({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="shimmer"
      className={cn("shimmer inline-block text-muted-foreground", className)}
      {...props}
    >
      {children}
    </span>
  );
}
