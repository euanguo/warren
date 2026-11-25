import { Button } from '@/components/ui/button';
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot';
import { cn } from '@/lib/utils';
import type { EnvironmentSpace, SpaceId } from '@shared/types';

interface Props {
  spaces: EnvironmentSpace[];
  activeSpaceId: SpaceId;
  onSelect: (space: SpaceId) => void;
}

function agentTone(space?: EnvironmentSpace): StatusDotTone {
  if (space?.owner === 'agent') return 'warning';
  if (space?.owner === 'human') return 'success';
  return 'idle';
}

/** Space 是 Environment 里的控制分组，不是另一个 Environment。 */
export function EnvironmentSpaceSwitcher({ spaces, activeSpaceId, onSelect }: Props) {
  if (!spaces.length) return null;
  const agent = spaces.find((space) => space.id === 'agent');
  return (
    <div
      data-slot="space-switcher"
      className="my-0.5 flex shrink-0 items-center gap-0.5 rounded-[var(--control-radius)] border border-border bg-muted/30 p-0.5"
    >
      {spaces.map((space) => {
        const active = space.id === activeSpaceId;
        const agentState =
          space.id === 'agent'
            ? space.owner === 'agent'
              ? 'AI 操作中'
              : space.owner === 'human'
                ? '你接管中'
                : '空闲'
            : '';
        return (
          <Button
            key={space.id}
            size="xs"
            variant={active ? 'secondary' : 'ghost'}
            className={cn('gap-1', active && 'text-foreground')}
            data-space={space.id}
            data-active={active ? 'true' : undefined}
            onClick={() => onSelect(space.id)}
            title={agentState || space.label}
          >
            {space.id === 'agent' && <StatusDot tone={agentTone(agent)} />}
            {space.id === 'person' ? '我的' : 'Agent'}
            <span className="font-mono text-[10px] text-muted-foreground">{space.tabs.length}</span>
          </Button>
        );
      })}
    </div>
  );
}
