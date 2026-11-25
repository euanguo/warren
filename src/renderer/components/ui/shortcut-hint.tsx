import { Kbd } from "@/components/ui/kbd";

/**
 * Shortcut hint chip. The web-next original resolved a binding from the shell's
 * shortcut registry; this app has none, so the caller passes the display string.
 */
export function ShortcutHint({
  sequence,
  label,
}: {
  readonly sequence: string;
  readonly label?: string;
}) {
  return <Kbd aria-label={label ?? sequence}>{sequence}</Kbd>;
}
