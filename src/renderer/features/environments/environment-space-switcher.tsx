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

/** Space 是 Environment 里的控制分组，不是另一个 Environment（OpenBot SlidingTabs 胶囊交互）。 */
export function EnvironmentSpaceSwitcher({ spaces, activeSpaceId, leaseLabel, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const thumb = thumbRef.current;
    if (!container || !thumb) return;
    let initialized = false;
    const sync = () => {
      const activeEl = container.querySelector<HTMLElement>('[data-active="true"]');
      if (!activeEl) {
        thumb.style.opacity = '0';
        return;
      }
      if (!initialized) container.dataset.initializing = 'true';
      thumb.style.opacity = '1';
      thumb.style.width = `${activeEl.offsetWidth}px`;
      thumb.style.transform = `translate3d(${activeEl.offsetLeft}px, 0, 0)`;
      if (!initialized) {
        void thumb.getBoundingClientRect();
        delete container.dataset.initializing;
        initialized = true;
      }
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
      className="relative flex h-[var(--control-height-icon)] shrink-0 items-center gap-[3px] rounded-[var(--control-radius)] bg-tabs-bar p-[3px] [box-shadow:inset_0_0_0_1px_var(--border)]"
    >
      <span ref={thumbRef} aria-hidden data-slot="space-switcher-thumb" className="warren-sliding-pill opacity-0" />
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
              'relative z-10 h-full gap-1 border-0 hover:bg-transparent active:scale-100',
              active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
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
