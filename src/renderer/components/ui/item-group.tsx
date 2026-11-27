import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * OpenBot 分组设置块与列表项原语（SettingsSection / ItemGroup / Item）。
 * 14px 标准圆角分组容器 + 1px 发丝行分隔线 + 零阴影。
 */
function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section data-slot="settings-section" className={cn("flex flex-col gap-2.5", className)}>
      <div className="flex items-end justify-between gap-3 px-0.5">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-medium leading-[18px] text-foreground">{title}</h3>
          {description ? <p className="mt-0.5 text-[12px] leading-[17px] text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-group"
      className={cn(
        "flex flex-col divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border bg-grouped shadow-none",
        className,
      )}
      {...props}
    />
  );
}

const itemVariants = cva(
  "flex w-full min-w-0 items-center justify-between gap-4 text-left text-[13px] leading-[18px] text-foreground",
  {
    variants: {
      size: {
        compact: "px-3 py-2",
        default: "px-3.5 py-3",
        spacious: "px-4 py-3.5",
      },
      interactive: {
        false: "",
        true: "cursor-pointer transition-none hover:bg-surface-hover active:bg-surface-active",
      },
    },
    defaultVariants: {
      size: "default",
      interactive: false,
    },
  },
);

function Item({
  className,
  size,
  interactive,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
  return (
    <div data-slot="item" className={cn(itemVariants({ size, interactive }), className)} {...props} />
  );
}

function ItemMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-media"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border bg-canvas text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="item-content" className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)} {...props} />;
}

function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn("flex items-center gap-1.5 text-[13px] font-medium leading-[18px] text-foreground", className)}
      {...props}
    />
  );
}

function ItemDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-description"
      className={cn("text-[12px] leading-[17px] text-muted-foreground", className)}
      {...props}
    />
  );
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="item-actions" className={cn("flex shrink-0 items-center gap-2", className)} {...props} />;
}

export {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  SettingsSection,
  itemVariants,
};
