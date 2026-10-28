"use client";

/** Product visual source (components/ui). Stock: ui-reference (do not import). */
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";
import { controlFocusClass } from "@/theme/surface";
import { cva, type VariantProps } from "class-variance-authority";

function Tabs({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-[var(--control-radius)] p-[3px] text-subtle-foreground group-data-horizontal/tabs:h-[var(--control-height)] group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted/80",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        controlFocusClass,
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-[var(--control-radius)] border-0 border-transparent px-1.5 py-0.5 text-sm font-normal whitespace-nowrap text-subtle-foreground shadow-none transition-colors",
        "hover:text-foreground focus-visible:ring-0 focus-visible:ring-transparent",
        "disabled:pointer-events-none disabled:opacity-40",
        "data-active:bg-surface-selected data-active:text-foreground data-active:shadow-none",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
