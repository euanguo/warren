/**
 * Disclosure motion — single source for all open/close toggle animations.
 *
 * All toggles (Collapsible, DisclosureRegion, sidebar sections, project open) must
 * use these helpers — 220ms ease-out with motion-reduce fallbacks — and never
 * invent bespoke height/opacity @keyframes. Shell three-pane geometry retains
 * framer-motion for its spring (progress × size) which cannot be expressed as
 * a pure CSS disclosure.
 */
import { cn } from "@/lib/utils";

export function disclosureWidthClassName(
  open: boolean,
  openWidthClassName: string,
  className?: string,
): string {
  return cn(
    "overflow-hidden transition-[width] duration-[var(--motion-disclosure-duration)] ease-[var(--motion-disclosure-ease)] motion-reduce:transition-none",
    open ? openWidthClassName : "w-0",
    className,
  );
}

export function disclosureShellClassName(open: boolean, className?: string): string {
  return cn(
    "grid transition-[grid-template-rows,opacity] duration-[var(--motion-disclosure-duration)] ease-[var(--motion-disclosure-ease)] motion-reduce:transition-none",
    open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
    className,
  );
}

export function disclosureInnerClassName(className?: string): string {
  return cn("min-h-0 overflow-hidden", className);
}

export function disclosureContentClassName(open: boolean, className?: string): string {
  return cn(
    "transition-[opacity,transform] duration-[var(--motion-disclosure-duration)] ease-[var(--motion-disclosure-ease)] motion-reduce:transition-none",
    open ? "translate-y-0 opacity-100" : "-translate-y-1 pointer-events-none opacity-0",
    className,
  );
}

export function disclosureChevronClassName(open: boolean, className?: string): string {
  return cn(
    "size-[var(--size-icon-xs)] shrink-0 text-muted-foreground transition-transform duration-[var(--motion-disclosure-duration)] ease-[var(--motion-disclosure-ease)] motion-reduce:transition-none",
    open && "rotate-90",
    className,
  );
}

export function disclosureCollapsiblePanelClassName(className?: string): string {
  return cn(
    "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-[var(--motion-disclosure-duration)] ease-[var(--motion-disclosure-ease)] motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)]",
    className,
  );
}
