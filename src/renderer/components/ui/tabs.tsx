import { useEffect, useRef } from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { controlRingFocusClass } from "@/theme/surface";

function Tabs({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      data-orientation={orientation}
      className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list relative inline-flex w-fit items-center justify-center rounded-[var(--control-radius)] text-muted-foreground data-[orientation=horizontal]:h-[var(--control-height)] data-[orientation=vertical]:h-fit data-[orientation=vertical]:flex-col",
  {
    variants: {
      variant: {
        default: "gap-[3px] p-[3px] bg-tabs-bar [box-shadow:inset_0_0_0_1px_var(--border)]",
        pill: "gap-1 rounded-none border-0 bg-transparent p-0",
        line: "gap-1 rounded-none border-b border-border bg-transparent p-0",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

/**
 * OpenBot 滑动胶囊指示条 TabsList：
 * `variant="default"` 时自动以物理滑动胶囊跟踪激活项，首帧无闪烁。
 */
function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (variant !== "default") return;
    const list = listRef.current;
    const pill = pillRef.current;
    if (!list || !pill) return;

    let initialized = false;

    const sync = () => {
      const isVertical = list.closest('[data-slot="tabs"]')?.getAttribute("data-orientation") === "vertical";
      if (isVertical) {
        pill.style.opacity = "0";
        return;
      }
      const activeTab = list.querySelector<HTMLElement>('[data-slot="tabs-trigger"][data-active], [data-slot="tabs-trigger"][aria-selected="true"]');
      if (!activeTab) {
        pill.style.opacity = "0";
        return;
      }

      const listRect = list.getBoundingClientRect();
      const tabRect = activeTab.getBoundingClientRect();
      if (tabRect.width <= 0 || listRect.width <= 0) {
        pill.style.opacity = "0";
        return;
      }

      const x = tabRect.left - listRect.left - list.clientLeft;
      if (!initialized) {
        list.dataset.initializing = "true";
      }
      pill.style.opacity = "1";
      pill.style.width = `${tabRect.width}px`;
      pill.style.transform = `translate3d(${x}px, 0, 0)`;

      if (!initialized) {
        void pill.getBoundingClientRect();
        delete list.dataset.initializing;
        initialized = true;
      }
    };

    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(sync)
        : null;
    observer?.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-selected", "data-active"],
    });

    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    resizeObserver?.observe(list);

    sync();

    return () => {
      observer?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [variant]);

  return (
    <TabsPrimitive.List
      ref={listRef}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {variant === "default" ? <span ref={pillRef} aria-hidden="true" className="warren-sliding-pill" style={{ opacity: 0 }} /> : null}
      {children}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        controlRingFocusClass,
        "relative z-[1] inline-flex h-full flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-transparent px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap text-muted-foreground shadow-none transition-none select-none",
        "hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-[0.42]",
        "data-active:text-foreground",
        "group-data-[variant=pill]/tabs-list:rounded-[var(--control-radius)] group-data-[variant=pill]/tabs-list:text-text-secondary group-data-[variant=pill]/tabs-list:hover:bg-control-hover group-data-[variant=pill]/tabs-list:hover:text-foreground group-data-[variant=pill]/tabs-list:data-active:border-surface-selected-border group-data-[variant=pill]/tabs-list:data-active:bg-surface-tab-selected group-data-[variant=pill]/tabs-list:data-active:text-foreground group-data-[variant=pill]/tabs-list:data-active:hover:bg-surface-tab-selected",
        "group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:border-b-2 group-data-[variant=line]/tabs-list:border-b-transparent group-data-[variant=line]/tabs-list:data-active:border-b-foreground",
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
      className={cn("warren-tab-enter flex-1 text-[13px] outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
