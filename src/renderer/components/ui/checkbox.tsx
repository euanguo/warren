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
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-[var(--radius-xs)] border border-border-strong bg-control shadow-none transition-none outline-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        "data-checked:border-accent-seed data-checked:bg-accent-seed data-checked:text-on-accent",
        "aria-invalid:border-danger aria-invalid:ring-0",
        "disabled:cursor-not-allowed disabled:opacity-[0.42]",
        "after:absolute after:-inset-x-3 after:-inset-y-2",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3 [&>svg]:stroke-[2.5]"
      >
        <Icon name="Check" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
export type { CheckboxProps };
