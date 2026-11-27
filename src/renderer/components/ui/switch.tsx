import { useEffect, useRef } from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";
import { controlFocusClass } from "@/theme/surface";

type SwitchProps = SwitchPrimitive.Root.Props & {
  size?: "sm" | "default";
};

const SPRING_STIFFNESS = 520;
const SPRING_DAMPING = 32;
const DRAG_THRESHOLD_PX = 3;
const MAX_STRETCH = 0.24;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * OpenBot 物理阻尼弹簧 + 指针拖拽 Switch：
 * - 速度驱动形变（stretch / squash：`scaleX = 1 + s, scaleY = 1 - s * 0.55`）；
 * - 超过 3px 指针滑动可实时拖动圆球并在松手时按中点提交状态，同时抑制多余 click 反转；
 * - 减弱动态效果或无头测试环境下自动瞬时定位。
 */
function Switch({
  className,
  size = "default",
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  onPointerDown,
  onClick,
  ...props
}: SwitchProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const posRef = useRef<number>(checked ?? defaultChecked ? 1 : 0);
  const velocityRef = useRef<number>(0);
  const targetRef = useRef<number>(checked ?? defaultChecked ? 1 : 0);
  const rafRef = useRef<number>(0);
  const draggingRef = useRef<boolean>(false);
  const suppressClickRef = useRef<boolean>(false);

  const travelPx = size === "sm" ? 10 : 16;

  const paintThumb = (pos: number, velocity: number) => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    const clamped = Math.max(-0.08, Math.min(1.08, pos));
    const stretch = Math.min(MAX_STRETCH, Math.abs(velocity) * 0.032);
    const scaleX = 1 + stretch;
    const scaleY = 1 - stretch * 0.55;
    const translateX = clamped * travelPx;
    thumb.style.transform = `translate3d(${translateX.toFixed(2)}px, 0, 0) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`;
  };

  const stopSpring = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  };

  const runSpringTo = (target: number) => {
    targetRef.current = target;
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      stopSpring();
      posRef.current = target;
      velocityRef.current = 0;
      paintThumb(target, 0);
      return;
    }

    stopSpring();
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.032, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      const displacement = targetRef.current - posRef.current;
      velocityRef.current += displacement * SPRING_STIFFNESS * dt;
      velocityRef.current *= Math.exp(-SPRING_DAMPING * dt);
      posRef.current += velocityRef.current * dt;

      if (Math.abs(targetRef.current - posRef.current) < 0.002 && Math.abs(velocityRef.current) < 0.01) {
        posRef.current = targetRef.current;
        velocityRef.current = 0;
        paintThumb(posRef.current, 0);
        rafRef.current = 0;
        return;
      }

      paintThumb(posRef.current, velocityRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const root = rootRef.current;
    const isChecked =
      checked !== undefined ? Boolean(checked) : root?.getAttribute("aria-checked") === "true" || Boolean(defaultChecked);
    const nextTarget = isChecked ? 1 : 0;
    if (!draggingRef.current) {
      if (Math.abs(posRef.current - nextTarget) > 0.001) {
        runSpringTo(nextTarget);
      } else {
        paintThumb(nextTarget, 0);
      }
    }
    return () => {
      stopSpring();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, size]);

  const handlePointerDown: NonNullable<SwitchProps["onPointerDown"]> = (event) => {
    onPointerDown?.(event);
    if (disabled || event.button !== 0) return;

    const root = rootRef.current;
    if (!root) return;

    const startX = event.clientX;
    const isCurrentlyChecked = root.getAttribute("aria-checked") === "true";
    const startPos = isCurrentlyChecked ? 1 : 0;
    let moved = false;
    let latestPos = startPos;
    let lastClientX = startX;

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      if (!moved) {
        moved = true;
        draggingRef.current = true;
        stopSpring();
      }
      const nextPos = Math.max(0, Math.min(1, startPos + dx / travelPx));
      const instantVelocity = (moveEvent.clientX - lastClientX) * 0.45;
      lastClientX = moveEvent.clientX;
      latestPos = nextPos;
      posRef.current = nextPos;
      paintThumb(nextPos, instantVelocity);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };

    const onUp = () => {
      cleanup();
      if (!moved) return;
      draggingRef.current = false;
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);

      const nextChecked = latestPos >= 0.5;
      if (nextChecked !== isCurrentlyChecked) {
        root.click();
      }
      runSpringTo(nextChecked ? 1 : 0);
    };

    const onCancel = () => {
      cleanup();
      if (!moved) return;
      draggingRef.current = false;
      runSpringTo(startPos);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const handleClick: NonNullable<SwitchProps["onClick"]> = (event) => {
    if (suppressClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };

  const handleCheckedChange: SwitchPrimitive.Root.Props["onCheckedChange"] = (nextChecked, eventDetails) => {
    onCheckedChange?.(nextChecked, eventDetails);
    if (!draggingRef.current) {
      runSpringTo(nextChecked ? 1 : 0);
    }
  };

  return (
    <SwitchPrimitive.Root
      ref={rootRef}
      data-slot="switch"
      data-size={size}
      checked={checked}
      defaultChecked={defaultChecked}
      disabled={disabled}
      onCheckedChange={handleCheckedChange}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      className={cn(
        controlFocusClass,
        "peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full border-0 shadow-none transition-none outline-none select-none",
        "after:absolute after:-inset-x-3 after:-inset-y-2",
        "data-[size=default]:h-[var(--switch-height)] data-[size=default]:w-[var(--switch-width)] data-[size=default]:p-[2px]",
        "data-[size=sm]:h-[var(--switch-sm-height)] data-[size=sm]:w-[var(--switch-sm-width)] data-[size=sm]:p-px",
        "data-unchecked:bg-control-active dark:data-unchecked:bg-control data-unchecked:[box-shadow:inset_0_0_0_1px_var(--border-strong)]",
        "data-checked:bg-accent-seed",
        "focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]",
        "aria-invalid:[box-shadow:0_0_0_3px_var(--danger-focus)]",
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        ref={thumbRef}
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-xs ring-0 will-change-transform",
          "group-data-[size=default]/switch:size-[var(--switch-thumb)]",
          "group-data-[size=sm]/switch:size-[var(--switch-sm-thumb)]",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
export type { SwitchProps };
