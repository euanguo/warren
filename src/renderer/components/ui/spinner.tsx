import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

type SpinnerProps = ComponentProps<"svg"> & {
  readonly label?: string;
};

/**
 * Compact accessible spinner (compact thin arc).
 */
function Spinner({ className, label = "Loading", ...props }: SpinnerProps) {
  return (
    <svg
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> 是表单计算结果的元素，不是 live region；spinner 就是 role="status" + aria-label
      role="status"
      aria-label={label}
      viewBox="0 0 16 16"
      fill="none"
      className={cn("size-4 shrink-0 animate-spin text-muted-foreground", className)}
      {...props}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export { Spinner };
export type { SpinnerProps };
