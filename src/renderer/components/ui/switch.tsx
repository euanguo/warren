"use client";

/** Product visual source (components/ui). Stock: ui-reference (do not import). */
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";
import { controlFocusClass } from "@/theme/surface";

type SwitchProps = SwitchPrimitive.Root.Props & {
  size?: "sm" | "default";
};

/**
 */
function Switch({ className, size = "default", ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        controlFocusClass,
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent [box-shadow:var(--shadow-recessed)] transition-colors outline-none",
        "after:absolute after:-inset-x-3 after:-inset-y-2",
        "focus-visible:border-focus focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus",
        "data-[size=default]:h-5 data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6",
        "data-checked:bg-[var(--theme-accent)] data-unchecked:bg-input",
        "aria-invalid:border-destructive aria-invalid:ring-0",
        "data-disabled:cursor-not-allowed data-disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-white [box-shadow:0_1px_2px_rgba(0,0,0,0.3)] ring-0 transition-transform duration-150",
          "group-data-[size=default]/switch:size-3.5 group-data-[size=sm]/switch:size-2.5",
          "group-data-[size=default]/switch:data-checked:translate-x-[calc(100%+1px)]",
          "group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%+1px)]",
          "group-data-[size=default]/switch:data-unchecked:translate-x-0.5",
          "group-data-[size=sm]/switch:data-unchecked:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
export type { SwitchProps };
