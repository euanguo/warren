import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Button, IconButton } from '@/components/ui/button';
import {
  ListRow,
  ListRowActionButton,
  ListRowActions,
  ListRowLabel,
  ListRowMain,
  ListRowMeta,
} from '@/components/ui/list-row';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
} from '@/components/ui/sidebar';
import { Icon } from '@/components/icons';
import { StatusDot } from '@/components/ui/status-dot';
import { StatusMark } from '@/components/ui/status-dot';
import {
  disclosureChevronClassName,
  disclosureInnerClassName,
  disclosureShellClassName,
} from '@/lib/disclosure-motion';
import { cn } from '@/lib/utils';
import type { PluginBadgeSnapshot, PluginEnvBadge } from '@/lib/plugin-badges';
import { ownerLabel, statusLabel, statusTone } from '@/lib/labels';
import type { Environment, Group, NativeMenuItem } from '@shared/types';
import type { PluginEnvAction } from '@/lib/plugin-runtime';

interface Props {
  environments: Environment[];
  groups: Group[];
  selected?: string;
  onSelect: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRemove: (id: string) => void;
  onTakeover: (id: string) => void;
  onRelease: (id: string) => void;
  /** 插件往环境菜单里加的动作（清单声明的，不需要插件前端） */
  pluginActions?: PluginEnvAction[];
  onRunPluginAction?: (pluginId: string, command: string, environmentId: string) => void;
  /** 插件往环境行放的状态芯片（renderer-only store） */
  pluginBadges?: PluginBadgeSnapshot;
  /** 侧栏收起时只留 icon，label 进 title */
  compact?: boolean;
  onRenameGroup: (id: string, name: string) => void;
  onRemoveGroup: (id: string) => void;
  onToggleGroup: (id: string, collapsed: boolean) => void;
  onMoveToGroup: (environmentId: string, groupId: string | undefined) => void;
}

const UNGROUPED = '__ungrouped__';
const UNGROUPED_COLLAPSED_KEY = 'warren.sidebar.ungroupedCollapsed';

function egress(proxy?: string): string {
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
  parts.push(egress(env.proxy));
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

interface Bucket {
  key: string;
  group?: Group;
  environments: Environment[];
}

function buildBuckets(environments: Environment[], groups: Group[]): Bucket[] {
  const sorted = [...environments].sort((a, b) => a.order - b.order);
  const buckets: Bucket[] = groups.map((group) => ({
    key: group.id,
    group,
    environments: sorted.filter((env) => env.groupId === group.id),
  }));
  const orphans = sorted.filter((env) => !env.groupId || !groups.some((g) => g.id === env.groupId));
  if (orphans.length > 0 || groups.length > 0) {
    buckets.push({ key: UNGROUPED, environments: orphans });
  }
  return buckets;
}

export function EnvironmentSidebar(props: Props) {
  const {
    environments,
    groups,
    selected,
    onSelect,
    onStart,
    onStop,
    onRemove,
    onTakeover,
    onRelease,
    pluginActions = [],
    onRunPluginAction,
    pluginBadges,
    compact = false,
    onRenameGroup,
    onRemoveGroup,
    onToggleGroup,
    onMoveToGroup,
  } = props;

  const [query, setQuery] = useState('');
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(
    () => localStorage.getItem(UNGROUPED_COLLAPSED_KEY) === '1',
  );
  useEffect(() => {
    localStorage.setItem(UNGROUPED_COLLAPSED_KEY, ungroupedCollapsed ? '1' : '0');
  }, [ungroupedCollapsed]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return environments;
    return environments.filter((env) =>
      [env.id, env.name, env.proxy, env.title, env.currentUrl]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [environments, query]);

  const buckets = useMemo(() => buildBuckets(filtered, groups), [filtered, groups]);
  const runningCount = environments.filter((env) => env.status === 'running').length;

  const copy = (text: string) => void navigator.clipboard.writeText(text);
  const envsInGroup = (groupId: string) => environments.filter((env) => env.groupId === groupId);

  const openEnvMenu = async (event: MouseEvent, env: Environment) => {
    event.preventDefault();
    event.stopPropagation();

    const moveSubmenu: NativeMenuItem[] =
      groups.length === 0
        ? [{ label: '还没有分组', enabled: false }]
        : groups.map((target) => ({
            id: `move:${target.id}`,
            label: target.name,
            enabled: env.groupId !== target.id,
          }));
    if (env.groupId) {
      if (moveSubmenu.length > 0) moveSubmenu.push({ type: 'separator' });
      moveSubmenu.push({ id: 'move:__ungrouped__', label: '移出分组' });
    }

    const items: NativeMenuItem[] = [
      { label: `${env.name} (${statusLabel[env.status] ?? env.status})`, enabled: false },
      { type: 'separator' },
      env.status === 'running' ? { id: 'stop', label: '停止' } : { id: 'start', label: '启动' },
      { type: 'separator' },
      { id: 'takeover', label: '接管 Agent Space', enabled: env.owner !== 'human' },
      { id: 'release', label: '交还 Agent Space', enabled: env.owner === 'human' },
      { type: 'separator' },
      { id: 'copy:cli', label: '复制 CLI 寻址' },
      { id: 'copy:url', label: '复制当前 URL', enabled: Boolean(env.currentUrl) },
      { id: 'open:external', label: '在外部浏览器打开', enabled: Boolean(env.currentUrl) },
      { type: 'separator' },
      { id: 'edit', label: '编辑…' },
      { label: '移动到分组', type: 'submenu', submenu: moveSubmenu },
    ];

    if (pluginActions.length > 0) {
      items.push({ type: 'separator' });
      for (const action of pluginActions) {
        items.push({
          id: `plugin:${action.pluginId}:${action.id}`,
          label: action.title,
        });
      }
    }

    items.push({ type: 'separator' }, { id: 'remove', label: '删除环境…' });

    const picked = await window.envApi.popupMenu(items, {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
    });
    if (!picked) return;

    if (picked === 'start') onStart(env.id);
    else if (picked === 'stop') onStop(env.id);
    else if (picked === 'takeover') onTakeover(env.id);
    else if (picked === 'release') onRelease(env.id);
    else if (picked === 'copy:cli') copy(`warren exec ${env.id}`);
    else if (picked === 'copy:url' && env.currentUrl) copy(env.currentUrl);
    else if (picked === 'open:external' && env.currentUrl) window.open(env.currentUrl, '_blank');
    else if (picked === 'edit') {
      void window.envApi.openOverlay({ kind: 'edit-env', environment: env });
    } else if (picked.startsWith('move:')) {
      const targetId = picked.slice(5);
      onMoveToGroup(env.id, targetId === '__ungrouped__' ? undefined : targetId);
    } else if (picked.startsWith('plugin:')) {
      const rest = picked.slice(7);
      const sep = rest.indexOf(':');
      const pluginId = rest.slice(0, sep);
      const actionId = rest.slice(sep + 1);
      const action = pluginActions.find((a) => a.pluginId === pluginId && a.id === actionId);
      if (action) onRunPluginAction?.(action.pluginId, action.command, env.id);
    } else if (picked === 'remove') {
      const confirmed = await window.envApi.openOverlay<boolean>({
        kind: 'confirm',
        title: `删除环境「${env.name}」？`,
        description: '该环境的独立浏览器存储（Cookie、登录态）会一并删除，无法撤销。',
        confirmLabel: '删除',
        destructive: true,
      });
      if (confirmed) onRemove(env.id);
    }
  };

  const openGroupMenu = async (event: MouseEvent, group: Group) => {
    event.preventDefault();
    event.stopPropagation();

    const items: NativeMenuItem[] = [
      { label: group.name, enabled: false },
      { type: 'separator' },
      { id: 'create-env', label: '新建环境…' },
      { id: 'rename', label: '重命名分组…' },
      { id: 'toggle', label: group.collapsed ? '展开' : '折叠' },
      { type: 'separator' },
      { id: 'start-all', label: '启动组内全部' },
      { id: 'stop-all', label: '停止组内全部' },
      { id: 'copy-cli', label: '复制组内 CLI 寻址' },
      { type: 'separator' },
      { id: 'remove', label: '删除分组（环境保留）' },
    ];

    const picked = await window.envApi.popupMenu(items, {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
    });
    if (!picked) return;

    if (picked === 'create-env') {
      void window.envApi.openOverlay({ kind: 'create-env', initialGroupId: group.id });
    } else if (picked === 'rename') {
      const next = await window.envApi.openOverlay<string>({
        kind: 'rename',
        title: '重命名分组',
        label: '分组名',
        initialValue: group.name,
      });
      if (next) onRenameGroup(group.id, next);
    } else if (picked === 'toggle') {
      onToggleGroup(group.id, !group.collapsed);
    } else if (picked === 'start-all') {
      envsInGroup(group.id).forEach((env) => onStart(env.id));
    } else if (picked === 'stop-all') {
      envsInGroup(group.id).forEach((env) => onStop(env.id));
    } else if (picked === 'copy-cli') {
      copy(
        envsInGroup(group.id)
          .map((env) => `warren exec ${env.id}`)
          .join('\n'),
      );
    } else if (picked === 'remove') {
      const confirmed = await window.envApi.openOverlay<boolean>({
        kind: 'confirm',
        title: `删除分组「${group.name}」？`,
        description: '组内环境会保留并移出分组，不会被删除。',
        confirmLabel: '删除',
        destructive: true,
      });
      if (confirmed) onRemoveGroup(group.id);
    }
  };

  return (
    <Sidebar collapsible="none" className="h-full" data-collapsed="false">
      <div className="flex h-[var(--shell-chrome-row-height)] shrink-0 items-center px-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => void window.envApi.openOverlay({ kind: 'create-env' })}
        >
          <Icon name="Plus" />
          <span className="truncate">新建环境</span>
        </Button>
      </div>

      <SidebarHeader className="pt-0">
        <div className="relative">
          <Icon
            name="Search"
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
          />
          <SidebarInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索环境…"
            className="pl-7"
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {environments.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">还没有环境。点上方「新建环境」开始。</p>
        )}

        {environments.length > 0 && filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">没有匹配「{query}」的环境。</p>
        )}

        {buckets.map((bucket) => {
          const group = bucket.group;
          const collapsed = group ? group.collapsed : ungroupedCollapsed;
          const toggle = () => (group ? onToggleGroup(group.id, !collapsed) : setUngroupedCollapsed(!collapsed));
          const running = bucket.environments.filter((env) => env.status === 'running').length;

          return (
            <SidebarGroup
              key={bucket.key}
              className="py-0.5"
              onContextMenu={group ? (event) => void openGroupMenu(event, group) : undefined}
            >
              <SidebarGroupLabel
                className="h-[var(--size-row)] cursor-pointer select-none rounded-[var(--control-radius)] transition-colors duration-150 ease-out hover:bg-surface-hover motion-reduce:transition-none"
                onClick={toggle}
              >
                <Icon name="ChevronRight" className={disclosureChevronClassName(!collapsed, 'size-4')} />
                <span className="truncate">{group?.name ?? '未分组'}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {collapsed && running > 0 && <StatusDot tone="success" />}
                  <span className="text-[10px] tabular-nums opacity-60">{bucket.environments.length}</span>
                </span>
              </SidebarGroupLabel>

              <div className={disclosureShellClassName(!collapsed)}>
                <SidebarGroupContent className={disclosureInnerClassName()} inert={collapsed}>
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {bucket.environments.map((env) => {
                      const badge = badgesForEnv(env.id, pluginBadges);
                      return (
                        <li key={env.id} className="relative" data-env-id={env.id}>
                          <ListRow selected={env.id === selected}>
                            <ListRowMain
                              onClick={() => onSelect(env.id)}
                              onContextMenu={(event) => void openEnvMenu(event, env)}
                              title={rowTitle(env)}
                            >
                              <ListRowLabel className="flex-1">
                                <StatusMark tone={env.error ? 'error' : statusTone(env.status)} />
                                <span className="ml-0.5 min-w-0 flex-1 truncate text-sm">{env.name}</span>
                                {env.owner !== 'none' && (
                                  <span
                                    className="ml-1 flex shrink-0 items-center text-muted-foreground"
                                    title={ownerLabel[env.owner]}
                                  >
                                    <Icon name={env.owner === 'agent' ? 'Robot' : 'User'} className="size-3.5" />
                                  </span>
                                )}
                                {env.approval && (
                                  <span
                                    className="ml-1 flex shrink-0 items-center text-[var(--warning)]"
                                    title={env.approval === 'auto' ? '审批：自动放行' : '审批：总是要审批'}
                                  >
                                    <Icon name={env.approval === 'auto' ? 'Zap' : 'Lock'} className="size-3.5" />
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
                                      badge.labels.length > 1
                                        ? `插件状态：${badge.labels.join(' / ')}`
                                        : `插件状态：${badge.first.label}`
                                    }
                                  >
                                    <Icon name={badge.first.icon ?? 'Zap'} className="size-3.5" />
                                    {!compact && <span className="truncate">{badge.first.label}</span>}
                                  </span>
                                )}
                                <ListRowMeta
                                  className={cn('ml-1 shrink-0 pl-1', badge.first ? 'max-w-[28%]' : 'max-w-[40%]')}
                                  title={egress(env.proxy)}
                                >
                                  {egress(env.proxy)}
                                </ListRowMeta>
                              </ListRowLabel>
                            </ListRowMain>
                            <ListRowActions alwaysVisible>
                              {env.status === 'running' ? (
                                <ListRowActionButton title="停止" aria-label="停止" onClick={() => onStop(env.id)}>
                                  <Icon name="Stop" />
                                </ListRowActionButton>
                              ) : (
                                <ListRowActionButton
                                  tone="success"
                                  title="启动"
                                  aria-label="启动"
                                  onClick={() => onStart(env.id)}
                                >
                                  <Icon name="Play" />
                                </ListRowActionButton>
                              )}
                            </ListRowActions>
                          </ListRow>
                        </li>
                      );
                    })}
                    {bucket.environments.length === 0 && (
                      <li className="px-2 py-1.5 text-xs text-muted-foreground">空分组</li>
                    )}
                  </ul>
                </SidebarGroupContent>
              </div>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {runningCount} 运行 / {environments.length} 环境
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton
              variant="ghost"
              title="新建分组"
              onClick={() => void window.envApi.openOverlay({ kind: 'create-group' })}
            >
              <Icon name="FolderPlus" />
            </IconButton>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
