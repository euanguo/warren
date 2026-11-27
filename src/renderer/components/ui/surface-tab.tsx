import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';

import { Icon } from '@/components/icons';
import { IconButton } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  controlRingFocusClass,
  surfaceTabChipActiveClass,
  surfaceTabChipClass,
  surfaceTabChipIconOnlyClass,
  surfaceTabStripClass,
} from '@/theme/surface';

const SURFACE_TAB_ACTION_SELECTOR = '[data-surface-tab-action]';

function isSurfaceTabActionTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(SURFACE_TAB_ACTION_SELECTOR) !== null;
}

export type SurfaceTabProps = Readonly<{
  label: string;
  active?: boolean;
  /**
   * `chip`：默认扁平标签芯片（右侧检视器 / 面板子标签）；
   * `chrome`：OpenBot 风格 28px 居中全圆角顶栏标签，激活态透明叠在 `<TabShape />` 之上融进主画布卡片。
   */
  variant?: 'chip' | 'chrome';
  icon?: ReactNode;
  iconAction?: ReactNode;
  /** 标题右侧的附加轻量动作槽位（如音频/静音开关），避免顶替左侧图标导致布局跳动。 */
  trailingAction?: ReactNode;
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
  variant = 'chip',
  icon,
  iconAction,
  trailingAction,
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
  const isChrome = variant === 'chrome';

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!onSelect || isSurfaceTabActionTarget(event.target)) {
      selectedOnPointerDownRef.current = false;
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      selectedOnPointerDownRef.current = false;
      return;
    }
    // chrome 标签需要让父级标签条接管指针拖拽排序，不能阻断 pointerdown 冒泡
    if (!isChrome) {
      event.stopPropagation();
    }
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
    if (isSurfaceTabActionTarget(event.target)) {
      return;
    }
    if (isChrome && canClose && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      return;
    }
    if (!onSelect) {
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') {
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

  return (
    <div
      role="tab"
      tabIndex={onSelect ? 0 : undefined}
      title={resolvedTitle}
      data-slot="surface-tab"
      data-variant={variant}
      data-state={active ? 'active' : 'idle'}
      data-preview={isPreview ? 'true' : undefined}
      aria-selected={onSelect ? active : undefined}
      aria-label={iconOnly ? label : undefined}
      className={cn(
        'group/surface-tab relative z-[1]',
        isChrome
          ? cn(
              'inline-flex h-[var(--chrome-tab-height,var(--control-height-compact))] min-w-0 items-center gap-1.5 overflow-hidden rounded-[var(--radius-md)] border border-transparent text-[12px] font-medium transition-colors duration-[var(--duration-fast)] select-none',
              active
                ? 'bg-transparent text-foreground'
                : onSelect
                  ? 'warren-chrome-tab-idle text-muted-foreground'
                  : 'text-muted-foreground',
              controlRingFocusClass,
            )
          : cn(surfaceTabChipClass, active && surfaceTabChipActiveClass),
        iconOnly && surfaceTabChipIconOnlyClass,
        !iconOnly &&
          (isChrome
            ? canClose && hasIcon
              ? 'pl-1.5 pr-2'
              : 'px-2'
            : canClose && hasIcon
              ? 'gap-1.5 pl-2 pr-2.5'
              : canClose && !hasIcon
                ? 'gap-1.5 pl-2.5 pr-1.5'
                : 'px-2.5'),
        onSelect ? 'cursor-pointer' : isChrome && 'cursor-default',
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
        isChrome ? (
          <ChromeTabCloseSlot
            label={closeLabel ?? label}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <span
              data-surface-tab-icon=""
              className={cn(
                'col-start-1 row-start-1 flex items-center justify-center transition-opacity duration-100 group-hover/surface-tab:opacity-0 group-focus-within/surface-tab:opacity-0',
                active ? 'opacity-100' : 'opacity-80',
              )}
            >
              {icon}
            </span>
            <Icon
              name="X"
              data-surface-tab-close-glyph=""
              className="col-start-1 row-start-1 size-3 shrink-0 opacity-0 transition-opacity duration-100 group-hover/surface-tab:opacity-100 group-focus-within/surface-tab:opacity-100"
            />
          </ChromeTabCloseSlot>
        ) : (
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
        )
      ) : hasIcon ? (
        <span
          data-surface-tab-icon=""
          className={cn(
            'flex shrink-0 items-center justify-center [&_svg]:size-3.5',
            isChrome ? 'size-[18px]' : 'size-3.5',
            isChrome && !active && 'opacity-80',
          )}
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
      {iconAction}
      {iconOnly ? <span className="sr-only">{label}</span> : null}
      {!iconOnly ? (
        isChrome ? (
          <ChromeTabLabel label={label} isPreview={isPreview} className={labelClassName} />
        ) : (
          <span className={cn('flex min-w-0 flex-1 items-center text-left', isPreview && 'italic', labelClassName)}>
            <span className="truncate">{label}</span>
          </span>
        )
      ) : null}
      {trailingAction}
      {canClose && !hasIcon ? (
        isChrome ? (
          <ChromeTabCloseSlot
            label={closeLabel ?? label}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <Icon name="X" data-surface-tab-close-glyph="" className="size-3 shrink-0" />
          </ChromeTabCloseSlot>
        ) : (
          <SurfaceTabAction
            label={closeLabel ?? label}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <Icon name="X" className="size-3.5" />
          </SurfaceTabAction>
        )
      ) : null}
    </div>
  );
}

/** 顶栏标签标题：仅当文本真正超出可用宽度时开启右侧渐隐蒙层，短标题保持末尾字符 100% 锐利。 */
function ChromeTabLabel({
  label,
  isPreview,
  className,
}: {
  label: string;
  isPreview?: boolean;
  className?: string;
}) {
  const labelRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const el = labelRef.current;
    if (!el) return;
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      const overflowing = el.scrollWidth > el.clientWidth + 1;
      el.dataset.overflow = overflowing ? 'true' : 'false';
    };
    sync();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    observer?.observe(el);
    void document.fonts?.ready?.then(sync);
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [label]);

  return (
    <span
      ref={labelRef}
      data-slot="chrome-tab-label"
      data-overflow="false"
      className={cn(
        'warren-chrome-tab-label block min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left [text-overflow:clip]',
        isPreview && 'italic',
        className,
      )}
    >
      {label}
    </span>
  );
}

/** OpenBot 同款 18px 圆形图标/关闭槽位：静息全透明、悬停 Tab 交叉淡入 ×、仅悬停 × 本身才亮圆形底。 */
function ChromeTabCloseSlot({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-surface-tab-action=""
      className={cn(
        controlRingFocusClass,
        'relative grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted-foreground transition-colors duration-[var(--duration-fast)] hover:bg-surface-active hover:text-foreground active:scale-95',
      )}
      onClick={onClick}
    >
      {children}
    </button>
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
        controlRingFocusClass,
        'relative text-muted-foreground group-hover/surface-tab:bg-surface-hover group-focus-within/surface-tab:bg-surface-hover hover:bg-surface-active hover:text-foreground',
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
  'aria-label'?: string;
  onPointerLeave?: () => void;
}>;

export function SurfaceTabStrip({
  children,
  className,
  'aria-label': ariaLabel,
  onPointerLeave,
}: SurfaceTabStripProps) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-slot="surface-tab-strip"
      className={cn(surfaceTabStripClass, className)}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>
  );
}
