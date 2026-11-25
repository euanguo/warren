import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@/lib/utils";
import { controlFieldClass, controlFocusClass } from "@/theme/surface";

type InputProps = React.ComponentProps<"input"> & {
  onValueChange?: (value: string) => void;
};

/**
 * DEFAULT field control — tokens via `controlFieldClass`.
 * Stock: ui-reference/input.tsx
 */
function Input({ className, type, onValueChange, onChange, ...props }: InputProps) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        controlFieldClass,
        controlFocusClass,
        "w-full min-w-0 transition-colors outline-none",
        "focus-visible:bg-input-fill",
        "disabled:pointer-events-none disabled:bg-input-fill/50",
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
