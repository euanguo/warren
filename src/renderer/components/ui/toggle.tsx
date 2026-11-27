import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-[var(--control-radius)] border border-transparent text-[13px] font-medium whitespace-nowrap transition-none outline-none hover:bg-surface-hover hover:text-foreground active:scale-[0.97] focus-visible:border-focus focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)] disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-danger-border aria-pressed:bg-control-active aria-pressed:text-foreground data-[state=on]:bg-control-active data-[state=on]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent text-muted-foreground",
        outline: "border-border-strong bg-control text-foreground hover:bg-control-hover",
      },
      size: {
        default:
          "h-[var(--control-height)] min-w-[var(--control-height)] px-[var(--control-pad-x)] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-[var(--control-height-compact)] min-w-[var(--control-height-compact)] rounded-[var(--control-radius)] px-[var(--control-pad-x-compact)] text-[12px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-[var(--control-size-lg)] min-w-[var(--control-size-lg)] px-[var(--control-pad-x)] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
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
