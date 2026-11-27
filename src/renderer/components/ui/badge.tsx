import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

/**
 * OpenBot 风格语义徽章（含实心、柔色与描边变体）。
 */
const badgeVariants = cva(
  "group/badge inline-flex h-[22px] w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap transition-none outline-none [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-accent-seed text-on-accent",
        secondary: "bg-control text-text-secondary",
        outline: "border-border-strong bg-transparent text-text-secondary",
        ghost: "bg-transparent text-text-secondary",
        link: "bg-transparent text-accent-text underline-offset-4 hover:underline",
        destructive: "bg-danger-soft text-danger-text",
        "primary-light": "bg-accent-soft text-accent-text",
        success: "bg-success-soft text-success-text",
        warning: "bg-warning-soft text-warning-text",
        info: "bg-accent-soft text-accent-text",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeProps = useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant = "default", render, ...props }: BadgeProps) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
export type { BadgeProps };
