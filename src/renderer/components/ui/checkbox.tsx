"use client";

/** Product visual source (components/ui). Stock: ui-reference (do not import). */
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@/lib/utils";
import { controlFocusClass } from "@/theme/surface";
import { Icon } from "@/components/icons";

type CheckboxProps = CheckboxPrimitive.Root.Props;

/**
 */
function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        controlFocusClass,
        "peer relative flex size-3.5 shrink-0 items-center justify-center rounded-[var(--control-radius-icon)] border border-input bg-transparent shadow-none transition-colors outline-none",
        "focus-visible:border-focus focus-visible:ring-0 focus-visible:ring-transparent",
        "data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground",
        "aria-invalid:border-destructive aria-invalid:ring-0",
        "disabled:cursor-not-allowed disabled:opacity-40",
        "after:absolute after:-inset-x-3 after:-inset-y-2",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3"
      >
        <Icon name="Check" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
export type { CheckboxProps };
