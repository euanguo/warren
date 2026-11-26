/** Product visual source (components/ui). Stock: ui-reference (do not import). */
import { cn } from "@/lib/utils"

/**
 * 状态点。实心圆，不是描边图标——图标库里的圆都是 stroke 的。
 * 颜色走 `bg-current`，所以只要给 tone 的 text 色，圆点就跟着走。
 */
const toneClass = {
  error: "text-[var(--destructive)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  info: "text-[var(--info)]",
  idle: "text-muted-foreground/40",
} as const

export type StatusDotTone = keyof typeof toneClass

function StatusDot({
  tone = "idle",
  className,
}: {
  tone?: StatusDotTone
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-slot="status-dot"
      className={cn("size-1.5 shrink-0 rounded-full bg-current", toneClass[tone], className)}
    />
  )
}

/**
 * 状态标记：一块带底色的方块，中间一颗实心点。
 *
 * 和 `StatusDot` 的区别是「一块颜色」而不是「一个点」——一行里跑着的和停着的混在
 * 一起时，带底色的方块扫一眼就能分出来，6px 的点得凑近看。
 *
 * 底色走 `bg-current/15`：同一个 `tone` 的语义色，点用满色、底用 15%，状态只有一个
 * 颜色来源，加新状态不用再挑一个底色。
 */
function StatusMark({
  tone = "idle",
  className,
}: {
  tone?: StatusDotTone
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-slot="status-mark"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-current/15",
        toneClass[tone],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
    </span>
  )
}

export { StatusDot, StatusMark, toneClass as statusDotToneClass }
export type { StatusDotTone as StatusDotToneName }
