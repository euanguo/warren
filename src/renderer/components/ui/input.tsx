import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@/lib/utils";
import { controlFieldClass, controlFocusClass } from "@/theme/surface";

type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  size?: "sm" | "md" | "lg";
  onValueChange?: (value: string) => void;
};

const INPUT_SIZE_CLASS = {
  sm: "h-[var(--control-size-sm)] px-2",
  md: "h-[var(--control-size-md)] px-3",
  lg: "h-[var(--control-size-lg)] px-3",
} as const;

/**
 * DEFAULT field control — 对齐 OpenBot `.ui-input`（sm 28 / md 32 / lg 36px，无 min-h 阻塞）。
 */
function Input({ className, type, size = "md", onValueChange, onChange, ...props }: InputProps) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(
        controlFieldClass,
        controlFocusClass,
        INPUT_SIZE_CLASS[size],
        "w-full min-w-0 transition-none outline-none",
        "focus-visible:bg-input-fill",
        "disabled:pointer-events-none disabled:opacity-[0.42]",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-normal file:text-foreground",
        className,
      )}
      onValueChange={onValueChange}
      onChange={onChange}
      {...props}
    />
  );
}

export { Input };
export type { InputProps };
