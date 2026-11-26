import type { MouseEvent } from 'react';
import { Icon } from '@/components/icons';
import {
  ListRow,
  ListRowActionButton,
  ListRowActions,
  ListRowLabel,
  ListRowMain,
  ListRowMeta,
} from '@/components/ui/list-row';
import { StatusMark } from '@/components/ui/status-dot';
import { ownerLabel, statusLabel, statusTone } from '@/lib/labels';
import type { PluginBadgeSnapshot, PluginEnvBadge } from '@/lib/plugin-badges';
import { cn } from '@/lib/utils';
import type { Environment } from '@shared/types';

export function egressLabel(proxy?: string): string {
  if (!proxy) return '直连';
  try {
    return new URL(proxy).host;
  } catch {
    return proxy;
  }
}

function rowTitle(env: Environment): string {
  const parts = [env.name, statusLabel[env.status] ?? env.status];
  if (env.title) parts.push(env.title);
  if (env.owner !== 'none') parts.push(ownerLabel[env.owner]);
  parts.push(egressLabel(env.proxy));
  if (env.error) parts.push(`页面加载失败：${env.error}`);
  return parts.join(' · ');
}

function badgeToneClass(tone: PluginEnvBadge['tone']): string {
  switch (tone) {
    case 'info':
      return 'text-[var(--info)]';
    case 'success':
      return 'text-[var(--success)]';
    case 'warning':
      return 'text-[var(--warning)]';
    case 'danger':
      return 'text-destructive';
    default:
      return 'text-muted-foreground';
  }
}

function badgesForEnv(
  envId: string,
  snapshot: PluginBadgeSnapshot | undefined,
): { first?: PluginEnvBadge; labels: string[] } {
  if (!snapshot) return { labels: [] };
  const labels: string[] = [];
  let first: PluginEnvBadge | undefined;
  for (const pluginId of Object.keys(snapshot).sort()) {
    const badge = snapshot[pluginId]?.[envId];
    if (!badge) continue;
    if (!first) first = badge;
    labels.push(badge.label);
  }
  return { first, labels };
}

interface Props {
  env: Environment;
  selected: boolean;
  compact: boolean;
  pluginBadges?: PluginBadgeSnapshot;
  onSelect: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onContextMenu: (event: MouseEvent, env: Environment) => void;
}

/** 高信噪比环境行：默认仅展示 状态圆点 + 名称 + 出口微标，占锁时补充控制方标识。 */
export function SidebarEnvRow({
  env,
  selected,
  compact,
  pluginBadges,
  onSelect,
  onStart,
  onStop,
  onContextMenu,
}: Props) {
  const badge = badgesForEnv(env.id, pluginBadges);

  return (
    <li className="relative" data-env-id={env.id}>
      <ListRow selected={selected}>
        <ListRowMain
          onClick={() => onSelect(env.id)}
          onContextMenu={(event) => onContextMenu(event, env)}
          title={rowTitle(env)}
        >
          <ListRowLabel className="flex-1">
            <StatusMark tone={env.error ? 'error' : statusTone(env.status)} />
            <span className="ml-0.5 min-w-0 flex-1 truncate text-sm">{env.name}</span>
            {env.owner !== 'none' && (
              <span
                className={cn(
                  'ml-1 flex shrink-0 items-center gap-0.5 text-[10px]',
                  env.owner === 'agent' ? 'text-[var(--info)]' : 'text-[var(--warning)]',
                )}
                title={ownerLabel[env.owner]}
              >
                <Icon name={env.owner === 'agent' ? 'Robot' : 'User'} className="size-3.5" />
                {!compact && env.owner === 'agent' && (
                  <span className="max-w-[4.5rem] truncate font-mono">{env.leaseLabel || 'AI'}</span>
                )}
              </span>
            )}
            {badge.first && (
              <span
                data-slot="env-badge"
                className={cn(
                  'ml-1 flex max-w-[3.5rem] shrink-0 items-center gap-0.5 text-[10px]',
                  badgeToneClass(badge.first.tone),
                )}
                title={
                  badge.labels.length > 1 ? `插件状态：${badge.labels.join(' / ')}` : `插件状态：${badge.first.label}`
                }
              >
                <Icon name={badge.first.icon ?? 'Zap'} className="size-3.5" />
                {!compact && <span className="truncate">{badge.first.label}</span>}
              </span>
            )}
            <ListRowMeta
              className={cn('ml-1 shrink-0 pl-1', badge.first ? 'max-w-[28%]' : 'max-w-[40%]')}
              title={egressLabel(env.proxy)}
            >
              {egressLabel(env.proxy)}
            </ListRowMeta>
          </ListRowLabel>
        </ListRowMain>
        <ListRowActions alwaysVisible>
          {env.status === 'running' ? (
            <ListRowActionButton title="停止" aria-label="停止" onClick={() => onStop(env.id)}>
              <Icon name="Stop" />
            </ListRowActionButton>
          ) : (
            <ListRowActionButton tone="success" title="启动" aria-label="启动" onClick={() => onStart(env.id)}>
              <Icon name="Play" />
            </ListRowActionButton>
          )}
        </ListRowActions>
      </ListRow>
    </li>
  );
}
