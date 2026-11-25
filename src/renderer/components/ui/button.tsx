import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Product button (single visual source under components/ui).
 *
 * Geometry from shared control tokens (`--control-height*`, `--control-pad-*`,
 * `--control-radius*`) — not hard-coded per component.
 * Call sites omit `size` (DEFAULT). Prefer `<IconButton>` for icon-only.
 * Stock baseline: components/ui-reference/button.tsx (do not import).
 */
const buttonVariants = cva(
  cn(
    "group/button inline-flex shrink-0 items-center justify-center bg-clip-padding text-sm font-normal whitespace-nowrap transition-colors select-none [corner-shape:var(--corner-shape)]",
    // Borderless chrome; focus = thin border-focus hairline, never ring-3 bloom.
    "border border-transparent shadow-none outline-none",
    // Split/group surfaces need a real edge so ButtonGroup can join corners.
    "in-data-[slot=button-group]:border-border",
    "focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-transparent focus-visible:border-focus",
    "active:translate-y-0 disabled:pointer-events-none disabled:opacity-40",
    "aria-invalid:border-destructive",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ),
  {
    variants: {
      variant: {
        default:
          "bg-foreground text-background hover:bg-foreground/80 active:bg-foreground/70 aria-expanded:bg-foreground/80",
        // Secondary: soft wash — not a stroked box.
        secondary:
          "bg-surface-fog text-foreground hover:bg-surface-hover active:bg-foreground/15 aria-expanded:bg-surface-hover",
        outline:
          "bg-surface-fog text-foreground hover:bg-surface-hover active:bg-foreground/15 aria-expanded:bg-surface-hover",
        ghost:
          // Do not force text-foreground when expanded — colored triggers (e.g. Full access)
          // must keep their semantic color while open.
          "bg-transparent text-subtle-foreground hover:bg-surface-hover hover:text-foreground active:bg-foreground/15 aria-expanded:bg-surface-hover",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 active:bg-destructive/25",
        link: "rounded-none bg-transparent text-foreground underline-offset-4 hover:underline active:opacity-80",
      },
      size: {
        // DEFAULT — default filled action.
        default:
          "h-[var(--control-height)] min-h-[var(--control-height)] gap-1 rounded-[var(--control-radius)] px-[var(--control-pad-x)] py-[var(--control-pad-y)] text-sm leading-[18px]",
        // Scale down: list/toolbar text row (~29).
        sm: "h-[var(--control-height-compact)] min-h-[var(--control-height-compact)] gap-1 rounded-[var(--control-radius)] px-[var(--control-pad-x-compact)] text-sm leading-[18px] in-data-[slot=button-group]:rounded-[var(--control-radius)]",
        xs: "h-6 gap-1 rounded-[var(--control-radius-icon)] px-2 text-xs leading-[16px] in-data-[slot=button-group]:rounded-[var(--control-radius)]",
        // Scale up: rare pill CTA.
        lg: "h-auto min-h-[var(--control-height)] gap-1.5 rounded-full px-5 py-2 text-base leading-[18px]",
        // Icon ladder (radius-md ≈ 10). default icon = toolbar 26.
        icon: "size-[var(--control-height-icon)] rounded-[var(--control-radius)] p-0 [&_svg:not([class*='size-'])]:size-4",
        "icon-sm":
          "size-[var(--control-height-icon-compact)] rounded-[var(--control-radius)] p-0 in-data-[slot=button-group]:rounded-[var(--control-radius)] [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs":
          "size-[var(--control-height-icon-dense)] rounded-[var(--control-radius-icon)] p-0 in-data-[slot=button-group]:rounded-[var(--control-radius)] [&_svg:not([class*='size-'])]:size-3",
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

/**
 * Icon-only control. Default = header chrome icon (28 / r12.5 / glyph 16).
 * Call sites should omit `size`.
 */
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
