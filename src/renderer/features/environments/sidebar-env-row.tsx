import type { CSSProperties, MouseEvent } from 'react';
import { ActionTooltip } from '@/components/action-tooltip';
import { Icon } from '@/components/icons';
import {
  ListRow,
  ListRowActionButton,
  ListRowActions,
  ListRowBody,
  ListRowLabel,
  ListRowMain,
} from '@/components/ui/list-row';
import { EnvIdentityAvatar } from '@/components/identity-glyphs';
import { Spinner } from '@/components/ui/spinner';
import { ownerLabel, statusLabel } from '@/lib/labels';
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
      return 'text-accent-text';
    case 'success':
      return 'text-success-text';
    case 'warning':
      return 'text-warning-text';
    case 'danger':
      return 'text-danger-text';
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

/** 高信噪比环境行：展开态双行信息；紧凑态（72px 图标轨道）自动切换为居中头像卡片 + 右侧富提示。 */
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

  if (compact) {
    const subtitle = [
      statusLabel[env.status] ?? env.status,
      egressLabel(env.proxy),
      env.owner !== 'none' ? ownerLabel[env.owner] : null,
    ]
      .filter(Boolean)
      .join(' · ');

    return (
      <li className="relative flex justify-center" data-env-id={env.id}>
        <ActionTooltip label={env.name} description={subtitle} side="right">
          <button
            type="button"
            data-slot="sidebar-compact-env"
            data-selected={selected ? 'true' : undefined}
            aria-label={rowTitle(env)}
            onClick={() => onSelect(env.id)}
            onDoubleClick={() => {
              if (env.status !== 'running' && env.status !== 'starting') onStart(env.id);
            }}
            onContextMenu={(event) => onContextMenu(event, env)}
            className={cn(
              'relative flex size-10 cursor-pointer items-center justify-center rounded-[var(--radius-lg)] border border-transparent transition-transform duration-100 outline-none active:scale-[0.96]',
              'focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]',
              selected
                ? '[--avatar-outline:var(--surface-selected)] border-surface-selected-border bg-surface-selected'
                : '[--avatar-outline:var(--bg-sidebar)] hover:[--avatar-outline:color-mix(in_srgb,var(--bg-sidebar),var(--foreground)_5%)] hover:bg-surface-hover',
            )}
          >
            <EnvIdentityAvatar
              envId={env.id}
              name={env.name}
              status={env.status}
              hasError={Boolean(env.error)}
              size="md"
              ringClassName="ring-[var(--avatar-outline)]"
            />
          </button>
        </ActionTooltip>
      </li>
    );
  }

  return (
    <li className="group/env-row relative" data-env-id={env.id}>
      <ListRow
        selected={selected}
        className="py-1.5"
        style={
          {
            '--list-row-gap': '0.625rem',
            '--list-row-body-gap': '1px',
          } as CSSProperties
        }
      >
        <ListRowMain
          onClick={() => onSelect(env.id)}
          onDoubleClick={() => {
            if (env.status !== 'running' && env.status !== 'starting') onStart(env.id);
          }}
          onContextMenu={(event) => onContextMenu(event, env)}
          title={rowTitle(env)}
        >
          <EnvIdentityAvatar
            envId={env.id}
            name={env.name}
            status={env.status}
            hasError={Boolean(env.error)}
            size="md"
            ringClassName="ring-[var(--avatar-outline)]"
          />
          <ListRowBody>
            <ListRowLabel className="flex-1">
              <span className="min-w-0 flex-1 truncate text-[13px] leading-4 font-medium tracking-[-0.01em] text-foreground">
                {env.name}
              </span>
            </ListRowLabel>
            <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--font-size-micro)] leading-[14px] text-muted-foreground">
              <span className="min-w-0 truncate font-mono" title={egressLabel(env.proxy)}>
                {egressLabel(env.proxy)}
              </span>
              {env.status === 'dormant' && (
                <span className="shrink-0 text-warning-text" title="已休眠，登录态与标签已保留">
                  已休眠
                </span>
              )}
              {env.error && (
                <span className="shrink-0 text-danger-text" title={env.error}>
                  异常
                </span>
              )}
              {env.owner !== 'none' && (
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-0.5 font-mono',
                    env.owner === 'agent' ? 'text-accent-text' : 'text-success-text',
                  )}
                  title={ownerLabel[env.owner]}
                >
                  <Icon name={env.owner === 'agent' ? 'Robot' : 'User'} className="size-3" />
                  <span className="max-w-[6.5rem] truncate">
                    {env.owner === 'agent' ? env.leaseLabel || 'AI' : '接管中'}
                  </span>
                </span>
              )}
              {badge.first && (
                <span
                  data-slot="env-badge"
                  className={cn(
                    'inline-flex max-w-[4.5rem] shrink-0 items-center gap-0.5',
                    badgeToneClass(badge.first.tone),
                  )}
                  title={
                    badge.labels.length > 1 ? `插件状态：${badge.labels.join(' / ')}` : `插件状态：${badge.first.label}`
                  }
                >
                  <Icon name={badge.first.icon ?? 'Zap'} className="size-3" />
                  <span className="truncate">{badge.first.label}</span>
                </span>
              )}
            </div>
          </ListRowBody>
        </ListRowMain>
        <ListRowActions alwaysVisible>
          {env.status === 'starting' ? (
            <ListRowActionButton size="icon-sm" disabled title="启动中…" aria-label="启动中">
              <Spinner className="size-3.5" />
            </ListRowActionButton>
          ) : env.status === 'running' ? (
            <ListRowActionButton
              size="icon-sm"
              tone="destructive"
              title="停止环境"
              aria-label="停止"
              className="opacity-75 group-hover/env-row:opacity-100"
              onClick={() => onStop(env.id)}
            >
              <Icon name="Stop" className="size-3.5" />
            </ListRowActionButton>
          ) : (
            <ListRowActionButton
              size="icon-sm"
              tone="success"
              title={env.status === 'dormant' ? '唤醒环境（保留登录态）' : '启动环境'}
              aria-label={env.status === 'dormant' ? '唤醒' : '启动'}
              className={cn(
                selected ? 'opacity-75 group-hover/env-row:opacity-100' : 'opacity-45 group-hover/env-row:opacity-100',
              )}
              onClick={() => onStart(env.id)}
            >
              <Icon name="Play" className="size-3.5" />
            </ListRowActionButton>
          )}
        </ListRowActions>
      </ListRow>
    </li>
  );
}
