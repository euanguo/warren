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
        "flex min-h-[76px] h-auto w-full field-sizing-content px-3 py-2 transition-none",
        "focus-visible:bg-input-fill",
        "disabled:opacity-[0.42]",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
export type { TextareaProps };
