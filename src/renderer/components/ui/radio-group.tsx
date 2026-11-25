"use client";

/** Product visual source (components/ui). Stock: ui-reference (do not import). */
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@/lib/utils";
import { controlFocusClass } from "@/theme/surface";

type RadioGroupProps = RadioGroupPrimitive.Props;
type RadioGroupItemProps = RadioPrimitive.Root.Props;

function RadioGroup({ className, ...props }: RadioGroupProps) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-2", className)}
      {...props}
    />
  );
}

/**
 */
function RadioGroupItem({ className, ...props }: RadioGroupItemProps) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        controlFocusClass,
        "group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-input bg-transparent shadow-none outline-none",
        "after:absolute after:-inset-x-3 after:-inset-y-2",
        "focus-visible:border-focus focus-visible:ring-0 focus-visible:ring-transparent",
        "data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground",
        "aria-invalid:border-destructive aria-invalid:ring-0",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="flex size-4 items-center justify-center"
      >
        <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
export type { RadioGroupItemProps, RadioGroupProps };
