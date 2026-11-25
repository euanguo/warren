"use client";

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
  icon?: ReactNode;
  /**
   * 标签上的第二个控件（当前只有「有声 / 静音」的喇叭）。
   *
   * 不能塞进 `icon` 里：标签可关闭时 `icon` 整个被包进关闭按钮里，再放一个
   * `<button>` 就是 button 套 button（无效结构，实测 `button button` 命中 1）。
   * 这个槽位和关闭键一样是 `SurfaceTabAction` 的兄弟节点，结构合法。
   */
  iconAction?: ReactNode;
  /** Icon-only chip (label remains for a11y via title / sr-only). */
  iconOnly?: boolean;
  title?: string;
  closeLabel?: string;
  /** Preview tabs render italic title and can be pinned via double-click. */
  isPreview?: boolean;
  onSelect?: () => void;
  onClose?: () => void;
  onPin?: () => void;
  onPrewarm?: () => void;
  className?: string;
  labelClassName?: string;
}>;

/**
 * Flat shell tab chip for center content strips and inspector pane tabs.
 * Visual single source — feature code must not hand-roll header tab chrome.
 */
export function SurfaceTab({
  label,
  active = false,
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

  /** 中键关闭：真实浏览器的习惯，标签条上按中键关掉这个标签。 */
  const handleAuxClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 1 || !canClose || isSurfaceTabActionTarget(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onClose?.();
  };

  return (
    <div
      role="tab"
      tabIndex={onSelect ? 0 : undefined}
      title={resolvedTitle}
      data-slot="surface-tab"
      data-state={active ? "active" : "idle"}
      data-preview={isPreview ? "true" : undefined}
      aria-selected={onSelect ? active : undefined}
      aria-label={iconOnly ? label : undefined}
      className={cn(
        "group/surface-tab",
        surfaceTabChipClass,
        iconOnly && surfaceTabChipIconOnlyClass,
        !iconOnly && canClose && "pr-1",
        active && surfaceTabChipActiveClass,
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
          <Icon name="X" className="absolute size-3.5 shrink-0 opacity-0 transition-opacity group-hover/surface-tab:opacity-100 group-focus-within/surface-tab:opacity-100" />
        </SurfaceTabAction>
      ) : hasIcon ? (
        <span
          className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5"
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
      {iconAction}
      {iconOnly ? <span className="sr-only">{label}</span> : null}
      {!iconOnly ? (
        <span
          className={cn(
            "flex min-w-0 items-center text-left",
            isPreview && "italic",
            labelClassName,
          )}
        >
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

/** Nested icon control inside a surface tab (close / pin). */
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
        "relative text-subtle-foreground group-hover/surface-tab:bg-surface-hover group-focus-within/surface-tab:bg-surface-hover hover:bg-surface-active hover:text-foreground",
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

/** Horizontal scrolling host for surface tabs (ShellHeader main slot). */
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
