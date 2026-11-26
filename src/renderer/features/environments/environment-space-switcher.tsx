import { useLayoutEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot';
import { cn } from '@/lib/utils';
import type { EnvironmentSpace, SpaceId } from '@shared/types';

interface Props {
  spaces: EnvironmentSpace[];
  activeSpaceId: SpaceId;
  leaseLabel?: string;
  onSelect: (space: SpaceId) => void;
}

function agentTone(space?: EnvironmentSpace): StatusDotTone {
  if (space?.owner === 'agent') return 'info';
  if (space?.owner === 'human') return 'success';
  return 'idle';
}

/** Space 是 Environment 里的控制分组，不是另一个 Environment。 */
export function EnvironmentSpaceSwitcher({ spaces, activeSpaceId, leaseLabel, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const thumb = thumbRef.current;
    if (!container || !thumb) return;
    const sync = () => {
      const activeEl = container.querySelector<HTMLElement>('[data-active="true"]');
      if (!activeEl) {
        thumb.style.opacity = '0';
        return;
      }
      thumb.style.opacity = '1';
      thumb.style.width = `${activeEl.offsetWidth}px`;
      thumb.style.transform = `translateX(${activeEl.offsetLeft}px)`;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeSpaceId, spaces]);

  if (!spaces.length) return null;
  const agent = spaces.find((space) => space.id === 'agent');
  return (
    <div
      ref={containerRef}
      data-slot="space-switcher"
      className="relative flex shrink-0 items-center gap-0.5 rounded-[var(--control-radius)] border border-border bg-input-fill p-0.5 [box-shadow:var(--shadow-recessed)]"
    >
      <span
        ref={thumbRef}
        aria-hidden
        data-slot="space-switcher-thumb"
        className="pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded-[var(--control-radius-icon)] border border-border-heavy/80 bg-surface-elevated opacity-0 [box-shadow:var(--shadow-raised)] transition-[transform,width,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
      />
      {spaces.map((space) => {
        const active = space.id === activeSpaceId;
        const agentRunning = space.id === 'agent' && space.owner === 'agent';
        const agentState =
          space.id === 'agent'
            ? space.owner === 'agent'
              ? `${leaseLabel || 'AI'} 操作中${active ? '' : ' · 点击查看'}`
              : space.owner === 'human'
                ? '你接管中'
                : 'Agent 空间空闲（只读）'
            : '';
        return (
          <Button
            key={space.id}
            size="xs"
            variant="ghost"
            className={cn(
              'relative z-10 gap-1 hover:bg-transparent',
              active ? 'font-medium text-foreground' : 'text-subtle-foreground hover:text-foreground',
            )}
            data-space={space.id}
            data-active={active ? 'true' : undefined}
            onClick={() => onSelect(space.id)}
            title={agentState || space.label}
          >
            {space.id === 'agent' && (
              <StatusDot tone={agentTone(agent)} className={cn(agentRunning && 'animate-pulse')} />
            )}
            {space.id === 'person' ? '我的' : 'Agent'}
            <span className="font-mono text-[length:var(--font-size-micro)] text-muted-foreground">
              {space.tabs.length}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
