import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { IconButton, type ButtonProps } from "@/components/ui/button";
import styles from "@/components/ui/list-row.module.css";
import { cn } from "@/lib/utils";

export type ListRowProps = HTMLAttributes<HTMLDivElement> & {
  readonly selected?: boolean;
  readonly active?: boolean;
};

/**
 * Product list row shell — navigators, sidebars, expandable trees.
 * Geometry from control ladder tokens; do not re-declare row height/hover in features.
 */
export function ListRow({ className, selected = false, active = false, ...props }: ListRowProps) {
  return (
    <div
      data-slot="list-row"
      data-selected={selected || undefined}
      data-active={active || undefined}
      className={cn(styles.row, className)}
      {...props}
    />
  );
}

export type ListRowMainProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function ListRowMain({ className, type = "button", ...props }: ListRowMainProps) {
  return (
    <button
      data-slot="list-row-main"
      type={type}
      className={cn(styles.main, className)}
      {...props}
    />
  );
}

export function ListRowLeading({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="list-row-leading" className={cn(styles.leading, className)} {...props} />;
}

export function ListRowBody({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="list-row-body" className={cn(styles.body, className)} {...props} />;
}

export function ListRowLabel({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="list-row-label" className={cn(styles.label, className)} {...props} />;
}

/** Truncating title text inside ListRowLabel when mixed with marks/actions. */
export function ListRowLabelText({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span data-slot="list-row-label-text" className={cn(styles.labelText, className)} {...props} />
  );
}

export function ListRowMeta({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="list-row-meta" className={cn(styles.meta, className)} {...props} />;
}

export function ListRowTrailing({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-slot="list-row-trailing" className={cn(styles.trailing, className)} {...props} />
  );
}

export function ListRowActions({
  className,
  alwaysVisible = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly alwaysVisible?: boolean }) {
  return (
    <div
      data-slot="list-row-actions"
      data-hover-actions=""
      data-always-visible={alwaysVisible || undefined}
      className={cn(styles.actions, className)}
      {...props}
    />
  );
}

/** Dense icon control for row actions — no second hover wash. */
export function ListRowActionButton({
  className,
  variant = "ghost",
  size = "icon-xs",
  tone,
  ...props
}: ButtonProps & {
  /**
   * 语义色。给了就用这个色做图标色 + 底色（`bg-current/12`），没给就是安静的中性图标。
   * 一个词占一个按钮的行（启动 / 停止）用它，让「这个按钮会做什么」一眼可见。
   */
  readonly tone?: "success" | "destructive";
}) {
  return (
    <IconButton
      data-slot="list-row-action-button"
      data-tone={tone}
      variant={variant}
      size={size}
      className={cn(styles.actionButton, className)}
      {...props}
    />
  );
}

export function ListRowNested({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="list-row-nested" className={cn(styles.nested, className)} {...props} />;
}

export function ListRowNestedStatus({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="list-row-nested-status"
      className={cn(styles.nestedStatus, className)}
      {...props}
    />
  );
}

export type ListRowComposeProps = ListRowProps & {
  readonly leading?: ReactNode;
  readonly label: ReactNode;
  readonly meta?: ReactNode;
  readonly trailing?: ReactNode;
  readonly actions?: ReactNode;
  readonly onMainClick?: () => void;
  readonly mainProps?: Omit<ListRowMainProps, "onClick" | "children">;
};

/** One-shot composition for simple non-disclosure rows. */
export function ListRowItem({
  leading,
  label,
  meta,
  trailing,
  actions,
  onMainClick,
  mainProps,
  ...rowProps
}: ListRowComposeProps) {
  return (
    <ListRow {...rowProps}>
      <ListRowMain onClick={onMainClick} {...mainProps}>
        {leading ? <ListRowLeading>{leading}</ListRowLeading> : null}
        <ListRowBody>
          <ListRowLabel>
            {typeof label === "string" || typeof label === "number" ? (
              <ListRowLabelText>{label}</ListRowLabelText>
            ) : (
              label
            )}
          </ListRowLabel>
          {meta ? <ListRowMeta>{meta}</ListRowMeta> : null}
        </ListRowBody>
      </ListRowMain>
      {trailing ? <ListRowTrailing>{trailing}</ListRowTrailing> : null}
      {actions ? <ListRowActions>{actions}</ListRowActions> : null}
    </ListRow>
  );
}
