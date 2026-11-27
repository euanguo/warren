import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * 产品按钮单源（OpenBot 扁平精密体系）。
 *
 * - 7 种语义变体（新增 `destructive-ghost`）；
 * - 零外投影、0ms 悬停响应、`active:scale-[0.97]` 按压微缩；
 * - 1px 中性发丝焦点环，绝不发蓝光晕。
 */
const buttonVariants = cva(
  cn(
    "group/button inline-flex shrink-0 items-center justify-center bg-clip-padding text-[13px] font-medium whitespace-nowrap select-none",
    "transition-[transform] duration-100 ease-out",
    "border border-transparent shadow-none outline-none",
    "in-data-[slot=button-group]:border-border-strong",
    "focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-transparent focus-visible:border-focus focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]",
    "active:scale-[0.97] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-40",
    "aria-invalid:border-danger-border",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ),
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:opacity-90 active:opacity-82 aria-expanded:opacity-90",
        secondary:
          "bg-control text-foreground hover:bg-control-hover active:bg-control-active aria-expanded:bg-control-hover",
        outline:
          "border-border-strong bg-control text-foreground hover:bg-control-hover active:bg-control-active aria-expanded:bg-control-hover",
        ghost:
          "bg-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground active:bg-surface-active aria-expanded:bg-surface-hover",
        destructive:
          "bg-danger-soft text-danger-text hover:bg-danger-soft-hover active:bg-danger-soft-hover",
        "destructive-ghost":
          "bg-transparent text-danger-text hover:bg-danger-soft active:bg-danger-soft-hover",
        link: "rounded-none bg-transparent text-accent-text underline-offset-4 hover:underline active:opacity-80 active:scale-100",
      },
      size: {
        default:
          "h-[var(--control-height)] min-h-[var(--control-height)] gap-1.5 rounded-[var(--control-radius)] px-[var(--control-pad-x)] py-[var(--control-pad-y)] text-[13px] leading-[18px]",
        sm: "h-[var(--control-height-compact)] min-h-[var(--control-height-compact)] gap-1 rounded-[var(--control-radius)] px-2.5 text-[12px] leading-[16px] in-data-[slot=button-group]:rounded-[var(--control-radius)]",
        xs: "h-[var(--control-size-xs)] gap-1 rounded-[var(--radius-sm)] px-2 text-[12px] leading-[16px] in-data-[slot=button-group]:rounded-[var(--control-radius)]",
        lg: "h-[var(--control-size-lg)] min-h-[var(--control-size-lg)] gap-1.5 rounded-[var(--radius-lg)] px-4 text-[14px] leading-[20px]",
        icon: "size-[var(--control-height-icon)] rounded-[var(--control-radius-icon)] p-0 [&_svg:not([class*='size-'])]:size-4",
        "icon-sm":
          "size-[var(--control-height-icon-compact)] rounded-[var(--radius-sm)] p-0 in-data-[slot=button-group]:rounded-[var(--control-radius)] [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs":
          "size-[var(--control-height-icon-dense)] rounded-[var(--radius-sm)] p-0 in-data-[slot=button-group]:rounded-[var(--control-radius)] [&_svg:not([class*='size-'])]:size-3",
        "icon-lg":
          "size-[var(--control-height-icon-roomy)] rounded-[var(--control-radius)] p-0 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

function Button({ className, variant = "default", size = "default", ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

/** 图标按钮单源（默认 28×28、8px 圆角、16px 图标）。 */
function IconButton({ className, variant = "ghost", size = "icon", ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="icon-button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, IconButton, buttonVariants };
export type { ButtonProps };
