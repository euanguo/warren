import { cn } from "@/lib/utils";
import { controlFieldClass, controlFocusClass } from "@/theme/surface";
import type { ComponentProps } from "react";

type TextareaProps = ComponentProps<"textarea">;

function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        controlFieldClass,
        controlFocusClass,
        // field height is min only for multi-line
        "flex min-h-16 h-auto w-full field-sizing-content transition-colors",
        "focus-visible:bg-input-fill",
        "disabled:bg-input-fill/50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
export type { TextareaProps };
