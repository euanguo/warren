import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { useRef } from "react";

import { IconButton } from "@/components/ui/button";
import { Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import {
  controlFocusClass,
  surfaceTabChipActiveClass,
  surfaceTabChipClass,
  surfaceTabChipIconOnlyClass,
  surfaceTabStripClass,
} from "@/theme/surface";

const SURFACE_TAB_ACTION_SELECTOR = "[data-surface-tab-action]";

function isSurfaceTabActionTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(SURFACE_TAB_ACTION_SELECTOR) !== null;
}

export type SurfaceTabProps = Readonly<{
  label: string;
  active?: boolean;
  /**
   * `chip`：默认扁平标签芯片（右侧检视器 / 面板子标签）；
   * `chrome`：顶栏凹角无界浏览器标签，激活态透明叠在 `<TabShape />` 之上融进主画布卡片。
   */
  variant?: "chip" | "chrome";
  icon?: ReactNode;
  iconAction?: ReactNode;
  iconOnly?: boolean;
  title?: string;
  closeLabel?: string;
  isPreview?: boolean;
  onSelect?: () => void;
  onClose?: () => void;
  onPin?: () => void;
  onPrewarm?: () => void;
  className?: string;
  labelClassName?: string;
}>;

export function SurfaceTab({
  label,
  active = false,
  variant = "chip",
  icon,
  iconAction,
  iconOnly = false,
  title,
  closeLabel,
  isPreview = false,
  onSelect,
  onClose,
  onPin,
  onPrewarm,
  className,
  labelClassName,
}: SurfaceTabProps) {
  const selectedOnPointerDownRef = useRef(false);
  const hasIcon = icon !== undefined && icon !== null;
  const canClose = onClose !== undefined;
  const resolvedTitle = title ?? label;

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!onSelect || isSurfaceTabActionTarget(event.target)) {
      selectedOnPointerDownRef.current = false;
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      selectedOnPointerDownRef.current = false;
      return;
    }
    event.stopPropagation();
    selectedOnPointerDownRef.current = true;
    onSelect?.();
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (selectedOnPointerDownRef.current) {
      selectedOnPointerDownRef.current = false;
      event.stopPropagation();
      return;
    }
    if (!onSelect || isSurfaceTabActionTarget(event.target)) {
      return;
    }
    event.stopPropagation();
    onSelect?.();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect || isSurfaceTabActionTarget(event.target)) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onSelect?.();
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onPin || isSurfaceTabActionTarget(event.target)) {
      return;
    }
    event.stopPropagation();
    onPin();
  };

  const handleAuxClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 1 || !canClose || isSurfaceTabActionTarget(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onClose?.();
  };

  const isChrome = variant === "chrome";

  return (
    <div
      role="tab"
      tabIndex={onSelect ? 0 : undefined}
      title={resolvedTitle}
      data-slot="surface-tab"
      data-variant={variant}
      data-state={active ? "active" : "idle"}
      data-preview={isPreview ? "true" : undefined}
      aria-selected={onSelect ? active : undefined}
      aria-label={iconOnly ? label : undefined}
      className={cn(
        "group/surface-tab relative z-[1]",
        isChrome
          ? cn(
              "inline-flex h-[32px] shrink-0 items-center gap-1.5 overflow-hidden rounded-t-[10px] border border-transparent text-[12px] font-medium transition-none select-none",
              active
                ? "bg-transparent text-foreground"
                : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              controlFocusClass,
            )
          : cn(surfaceTabChipClass, active && surfaceTabChipActiveClass),
        iconOnly && surfaceTabChipIconOnlyClass,
        !iconOnly && canClose && hasIcon && "gap-1.5 pl-2 pr-2.5",
        !iconOnly && canClose && !hasIcon && "gap-1.5 pl-2.5 pr-1.5",
        !iconOnly && !canClose && "px-2.5",
        onSelect && "cursor-pointer",
        className,
      )}
      onPointerEnter={onPrewarm}
      onFocus={onPrewarm}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      {canClose && hasIcon ? (
        <SurfaceTabAction
          label={closeLabel ?? label}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <span className="flex items-center justify-center transition-opacity group-hover/surface-tab:opacity-0 group-focus-within/surface-tab:opacity-0">
            {icon}
          </span>
          <Icon
            name="X"
            className="absolute size-3.5 shrink-0 opacity-0 transition-opacity group-hover/surface-tab:opacity-100 group-focus-within/surface-tab:opacity-100"
          />
        </SurfaceTabAction>
      ) : hasIcon ? (
        <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5" aria-hidden>
          {icon}
        </span>
      ) : null}
      {iconAction}
      {iconOnly ? <span className="sr-only">{label}</span> : null}
      {!iconOnly ? (
        <span className={cn("flex min-w-0 items-center text-left", isPreview && "italic", labelClassName)}>
          <span className="truncate">{label}</span>
        </span>
      ) : null}
      {canClose && !hasIcon ? (
        <SurfaceTabAction
          label={closeLabel ?? label}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <Icon name="X" className="size-3.5" />
        </SurfaceTabAction>
      ) : null}
    </div>
  );
}

export type SurfaceTabActionProps = Readonly<{
  label: string;
  children: ReactNode;
  className?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}>;

export function SurfaceTabAction({ label, children, className, onClick }: SurfaceTabActionProps) {
  return (
    <IconButton
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      data-surface-tab-action=""
      className={cn(
        controlFocusClass,
        "relative text-muted-foreground group-hover/surface-tab:bg-surface-hover group-focus-within/surface-tab:bg-surface-hover hover:bg-surface-active hover:text-foreground",
        className,
      )}
      onClick={onClick}
    >
      {children}
    </IconButton>
  );
}

export type SurfaceTabStripProps = Readonly<{
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}>;

export function SurfaceTabStrip({
  children,
  className,
  "aria-label": ariaLabel,
}: SurfaceTabStripProps) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-slot="surface-tab-strip"
      className={cn(surfaceTabStripClass, className)}
    >
      {children}
    </div>
  );
}
