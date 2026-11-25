"use client";

/** Product visual source (components/ui). Stock: ui-reference (do not import). */
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

type LabelProps = ComponentProps<"label">;

/**
 */
function Label({ className, ...props }: LabelProps) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-normal text-foreground select-none",
        "group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-40",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
export type { LabelProps };
