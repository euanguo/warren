import type { CSSProperties, MouseEvent } from 'react';
import { Icon } from '@/components/icons';
import {
  ListRow,
  ListRowActionButton,
  ListRowActions,
  ListRowBody,
  ListRowLabel,
  ListRowMain,
  ListRowMeta,
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
  const showSecondLine = !compact;

  return (
    <li className="relative" data-env-id={env.id}>
      <ListRow
        selected={selected}
        className={showSecondLine ? 'py-1.5' : undefined}
        style={
          showSecondLine
            ? ({
                '--list-row-gap': '0.625rem',
                '--list-row-body-gap': '1px',
              } as CSSProperties)
            : undefined
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
            size={showSecondLine ? 'md' : 'sm'}
            ringClassName={selected ? 'ring-surface-selected-solid' : 'ring-sidebar'}
          />
          <ListRowBody>
            <ListRowLabel className="flex-1">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-medium text-foreground',
                  showSecondLine ? 'text-[13px] leading-4 tracking-[-0.01em]' : 'text-xs leading-4',
                )}
              >
                {env.name}
              </span>
              {!showSecondLine && (
                <ListRowMeta className="ml-1 max-w-[44%] shrink-0 pl-1" title={egressLabel(env.proxy)}>
                  {egressLabel(env.proxy)}
                </ListRowMeta>
              )}
            </ListRowLabel>
            {showSecondLine && (
              <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--font-size-micro)] leading-[14px] text-subtle-foreground">
                <span className="min-w-0 truncate font-mono" title={egressLabel(env.proxy)}>
                  {egressLabel(env.proxy)}
                </span>
                {env.status === 'dormant' && (
                  <span className="shrink-0 text-[var(--warning)]" title="已休眠，登录态与标签已保留">
                    已休眠
                  </span>
                )}
                {env.error && (
                  <span className="shrink-0 text-destructive" title={env.error}>
                    异常
                  </span>
                )}
                {env.owner !== 'none' && (
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-0.5 font-mono',
                      env.owner === 'agent' ? 'text-[var(--info)]' : 'text-[var(--success)]',
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
                      badge.labels.length > 1
                        ? `插件状态：${badge.labels.join(' / ')}`
                        : `插件状态：${badge.first.label}`
                    }
                  >
                    <Icon name={badge.first.icon ?? 'Zap'} className="size-3" />
                    <span className="truncate">{badge.first.label}</span>
                  </span>
                )}
              </div>
            )}
          </ListRowBody>
        </ListRowMain>
        <ListRowActions alwaysVisible>
          {env.status === 'starting' ? (
            <ListRowActionButton disabled title="启动中…" aria-label="启动中">
              <Spinner className="size-3" />
            </ListRowActionButton>
          ) : env.status === 'running' ? (
            <ListRowActionButton
              tone="destructive"
              title="停止环境"
              aria-label="停止"
              className="opacity-75 hover:opacity-100"
              onClick={() => onStop(env.id)}
            >
              <Icon name="Stop" />
            </ListRowActionButton>
          ) : (
            <ListRowActionButton
              tone="success"
              title={env.status === 'dormant' ? '唤醒环境（保留登录态）' : '启动环境'}
              aria-label={env.status === 'dormant' ? '唤醒' : '启动'}
              className="opacity-75 hover:opacity-100"
              onClick={() => onStart(env.id)}
            >
              <Icon name="Play" />
            </ListRowActionButton>
          )}
        </ListRowActions>
      </ListRow>
    </li>
  );
}
