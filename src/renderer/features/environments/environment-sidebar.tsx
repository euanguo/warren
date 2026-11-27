import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/icons';
import { IconButton } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { disclosureInnerClassName, disclosureShellClassName } from '@/lib/disclosure-motion';
import type { PluginBadgeSnapshot } from '@/lib/plugin-badges';
import type { PluginEnvAction } from '@/lib/plugin-sdk-types';
import type { Environment, Group } from '@shared/types';
import { SidebarEnvRow } from './sidebar-env-row';
import { SidebarGroupHeader } from './sidebar-group-header';
import { openEnvironmentContextMenu, openGroupContextMenu } from './sidebar-menus';

interface Props {
  environments: Environment[];
  groups: Group[];
  selected?: string;
  /** 首屏数据是否已从主进程拉回；false 时展示轻量占位而非误报「还没有环境」。 */
  ready?: boolean;
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

export function EnvironmentSidebar({
  environments,
  groups,
  selected,
  ready = true,
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
}: Props) {
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

  return (
    <Sidebar collapsible="none" className="h-full w-full min-w-0" data-collapsed="false">
      <SidebarHeader className="flex h-[var(--shell-address-row-height)] shrink-0 flex-row items-center px-2 py-0">
        <div className="flex w-full items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Icon
              name="Search"
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <SidebarInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索环境…"
              aria-label="搜索环境"
              className="h-[var(--control-height-icon)] border-border/80 bg-[var(--chrome-field-fill)] pl-7 text-xs shadow-none focus-visible:border-focus"
            />
          </div>
          <IconButton
            variant="secondary"
            data-slot="sidebar-create-env"
            title="新建环境"
            aria-label="新建环境"
            className="border border-border/80"
            onClick={() => void window.envApi.openOverlay({ kind: 'create-env' })}
          >
            <Icon name="Plus" />
          </IconButton>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {!ready && environments.length === 0 && (
          <div data-slot="sidebar-loading" aria-busy="true" className="flex flex-col gap-1.5 px-2 py-2">
            <Skeleton className="h-[var(--control-height-compact)] w-full opacity-60" />
            <Skeleton className="h-[var(--control-height-compact)] w-5/6 opacity-45" />
            <Skeleton className="h-[var(--control-height-compact)] w-2/3 opacity-30" />
          </div>
        )}

        {ready && environments.length === 0 && (
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
              onContextMenu={
                group
                  ? (event) =>
                      void openGroupContextMenu(
                        event,
                        group,
                        environments.filter((env) => env.groupId === group.id),
                        { onStart, onStop, onRenameGroup, onRemoveGroup, onToggleGroup },
                      )
                  : undefined
              }
            >
              <SidebarGroupHeader
                title={group?.name ?? '未分组'}
                count={bucket.environments.length}
                runningCount={running}
                collapsed={collapsed}
                onToggle={toggle}
              />

              <div className={disclosureShellClassName(!collapsed)}>
                <SidebarGroupContent className={disclosureInnerClassName()} inert={collapsed}>
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {bucket.environments.map((env) => (
                      <SidebarEnvRow
                        key={env.id}
                        env={env}
                        selected={env.id === selected}
                        compact={compact}
                        pluginBadges={pluginBadges}
                        onSelect={onSelect}
                        onStart={onStart}
                        onStop={onStop}
                        onContextMenu={(event, target) =>
                          void openEnvironmentContextMenu(event, target, groups, pluginActions, {
                            onStart,
                            onStop,
                            onRemove,
                            onTakeover,
                            onRelease,
                            onMoveToGroup,
                            onRunPluginAction,
                          })
                        }
                      />
                    ))}
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
          <span className="min-w-0 truncate tabular-nums">
            {!ready && environments.length === 0
              ? '正在加载环境…'
              : `${runningCount} 运行 / ${environments.length} 环境`}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton
              variant="ghost"
              title="新建分组"
              aria-label="新建分组"
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
