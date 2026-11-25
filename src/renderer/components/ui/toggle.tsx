"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-[var(--control-radius)] [corner-shape:var(--corner-shape)] border border-transparent text-sm font-normal whitespace-nowrap transition-colors outline-none hover:bg-surface-hover hover:text-foreground focus-visible:border-focus focus-visible:ring-0 focus-visible:ring-transparent disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive aria-pressed:bg-surface-selected data-[state=on]:bg-surface-selected [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "bg-surface-fog hover:bg-surface-hover",
      },
      size: {
        default:
          "h-[var(--control-height)] min-w-[var(--control-height)] px-[var(--control-pad-x)] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-[var(--control-height-compact)] min-w-[var(--control-height-compact)] rounded-[var(--control-radius)] px-[var(--control-pad-x-compact)] text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-[var(--control-height-field)] min-w-[var(--control-height-field)] px-[var(--control-pad-x)] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
