import { toast } from 'sonner';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ActionTooltip } from '@/components/action-tooltip';
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
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot';
import { formatMemoryKb } from '@/lib/format';
import { disclosureInnerClassName, disclosureShellClassName } from '@/lib/disclosure-motion';
import type { PluginBadgeSnapshot } from '@/lib/plugin-badges';
import type { PluginEnvAction } from '@/lib/plugin-sdk-types';
import { cn } from '@/lib/utils';
import { listItemInteractiveClass } from '@/theme/surface';
import type { Environment, Group, MemorySnapshot, OverlayFormValues } from '@shared/types';
import { SidebarEnvRow } from './sidebar-env-row';
import { SidebarGroupHeader } from './sidebar-group-header';
import { openEnvironmentContextMenu, openGroupContextMenu } from './sidebar-menus';

async function createGroup(): Promise<void> {
  const values = await window.envApi.openOverlay<OverlayFormValues>({
    kind: 'form',
    title: '新建分组',
    description: '分组只影响侧栏的组织方式，不影响运行时。',
    submitLabel: '创建',
    fields: [{ type: 'text', key: 'name', label: '分组名', placeholder: '生产', required: true, maxLength: 80 }],
  });
  const name = typeof values?.name === 'string' ? values.name.trim() : '';
  if (!name) return;
  try {
    await window.envApi.groupCreate(name);
  } catch (error) {
    toast.error('新建分组失败', { description: error instanceof Error ? error.message : String(error) });
  }
}

interface Props {
  environments: Environment[];
  groups: Group[];
  selected?: string;
  /** 首屏数据是否已从主进程拉回；false 时展示轻量占位而非误报「还没有环境」。 */
  ready?: boolean;
  onSelect: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onHibernate?: (id: string) => void;
  onClearCache?: (id: string) => void;
  onRemove: (id: string) => void;
  onTakeover: (id: string) => void;
  onRelease: (id: string) => void;
  pluginActions?: PluginEnvAction[];
  onRunPluginAction?: (pluginId: string, command: string, environmentId: string) => void;
  pluginBadges?: PluginBadgeSnapshot;
  /** OpenBot 72px 紧凑图标轨道态。 */
  compact?: boolean;
  /** 完全关闭（0px）态：暂停轮询采样。 */
  closed?: boolean;
  /** 侧栏被全屏设置/插件页遮挡时暂停低频内存采样。 */
  paused?: boolean;
  searchFocusToken?: number;
  onExpandFromCompact?: () => void;
  onToggleCompact?: () => void;
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
  onHibernate,
  onClearCache,
  onRemove,
  onTakeover,
  onRelease,
  pluginActions = [],
  onRunPluginAction,
  pluginBadges,
  compact = false,
  closed = false,
  paused = false,
  searchFocusToken = 0,
  onExpandFromCompact,
  onToggleCompact,
  onRenameGroup,
  onRemoveGroup,
  onToggleGroup,
  onMoveToGroup,
}: Props) {
  const [query, setQuery] = useState('');
  const [memorySnap, setMemorySnap] = useState<MemorySnapshot | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(
    () => localStorage.getItem(UNGROUPED_COLLAPSED_KEY) === '1',
  );

  useEffect(() => {
    localStorage.setItem(UNGROUPED_COLLAPSED_KEY, ungroupedCollapsed ? '1' : '0');
  }, [ungroupedCollapsed]);

  useEffect(() => {
    if (!searchFocusToken || compact || closed) return;
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchFocusToken, compact, closed]);

  // 侧栏可见时每 15s 静默采样一次内存摘要；隐藏或被全屏页覆盖时暂停
  useEffect(() => {
    if (closed || paused || typeof window === 'undefined' || !window.envApi?.memorySnapshot) return;
    let active = true;
    const pull = () => {
      if (document.hidden) return;
      void window.envApi
        .memorySnapshot()
        .then((snap) => {
          if (active && snap) setMemorySnap(snap);
        })
        .catch(() => undefined);
    };
    pull();
    const timer = window.setInterval(pull, 15_000);
    const onVisibility = () => {
      if (!document.hidden) pull();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [closed, paused]);

  const openMemoryQuickPopover = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    void window.envApi.openPopover({
      id: 'memory-quick',
      anchorRect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      size: { width: 340, height: 312 },
      placement: 'top-start',
      focusable: true,
      props: {},
    });
  };

  const memoryTone: StatusDotTone =
    memorySnap?.pressure === 'high' ? 'error' : memorySnap?.pressure === 'elevated' ? 'warning' : 'idle';

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
    <Sidebar
      collapsible="none"
      className="h-full w-full min-w-0 bg-sidebar"
      data-collapsed={compact ? 'true' : 'false'}
      data-compact={compact ? 'true' : 'false'}
    >
      <SidebarHeader
        className={cn(
          'flex h-[var(--shell-address-row-height)] shrink-0 flex-row items-center py-0',
          compact ? 'justify-center px-2' : 'px-2',
        )}
      >
        {compact ? (
          <div className="flex w-full items-center justify-center gap-1">
            <ActionTooltip label="展开并搜索环境" side="right">
              <IconButton
                variant="ghost"
                size="icon-md"
                data-slot="sidebar-compact-search"
                aria-label="展开并搜索环境"
                className="rounded-full bg-control text-muted-foreground hover:bg-control-active hover:text-foreground"
                onClick={onExpandFromCompact ?? onToggleCompact}
              >
                <Icon name="Search" />
              </IconButton>
            </ActionTooltip>
          </div>
        ) : (
          <div className="flex w-full items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Icon
                name="Search"
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <SidebarInput
                ref={searchInputRef}
                size="md"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索环境…"
                aria-label="搜索环境"
                className="h-[var(--control-size-md)] rounded-full border-0 bg-control pr-7 pl-8 text-[13px] shadow-none hover:bg-control-active focus-visible:bg-control-active focus-visible:[box-shadow:inset_0_0_0_1px_var(--border-grouped)]"
              />
              {query && (
                <button
                  type="button"
                  aria-label="清空环境搜索"
                  onClick={() => setQuery('')}
                  className="absolute top-1/2 right-2 flex size-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-none hover:bg-surface-hover hover:text-foreground"
                >
                  <Icon name="X" className="size-3" />
                </button>
              )}
            </div>
            <ActionTooltip label="新建环境" side="bottom">
              <IconButton
                variant="default"
                size="icon-md"
                data-slot="sidebar-create-env"
                aria-label="新建环境"
                className="rounded-full"
                onClick={() => void window.envApi.openOverlay({ kind: 'create-env' })}
              >
                <Icon name="Plus" className="size-4" />
              </IconButton>
            </ActionTooltip>
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className={cn(compact && 'px-1.5 py-2')}>
        {!ready && environments.length === 0 && (
          <div
            data-slot="sidebar-loading"
            aria-busy="true"
            className={cn('flex flex-col gap-1.5 py-2', compact ? 'items-center px-0' : 'px-2')}
          >
            <Skeleton className={cn(compact ? 'size-9 rounded-[var(--radius-lg)]' : 'h-8 w-full', 'opacity-60')} />
            <Skeleton className={cn(compact ? 'size-9 rounded-[var(--radius-lg)]' : 'h-8 w-5/6', 'opacity-45')} />
            <Skeleton className={cn(compact ? 'size-9 rounded-[var(--radius-lg)]' : 'h-8 w-2/3', 'opacity-30')} />
          </div>
        )}

        {ready && environments.length === 0 && !compact && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">还没有环境。点上方「+」新建开始。</p>
        )}

        {environments.length > 0 && filtered.length === 0 && !compact && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">没有匹配「{query}」的环境。</p>
        )}

        {buckets.map((bucket) => {
          const group = bucket.group;
          const collapsed = !compact && (group ? group.collapsed : ungroupedCollapsed);
          const toggle = () => (group ? onToggleGroup(group.id, !collapsed) : setUngroupedCollapsed(!collapsed));
          const running = bucket.environments.filter((env) => env.status === 'running').length;

          return (
            <SidebarGroup
              key={bucket.key}
              className={cn(compact ? 'px-0 py-0.5' : 'py-0.5')}
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
              {!compact && (
                <SidebarGroupHeader
                  title={group?.name ?? '未分组'}
                  count={bucket.environments.length}
                  runningCount={running}
                  collapsed={collapsed}
                  onToggle={toggle}
                />
              )}

              <div className={disclosureShellClassName(!collapsed)}>
                <SidebarGroupContent className={disclosureInnerClassName()} inert={collapsed}>
                  <ul className={cn('flex flex-col', compact ? 'items-center gap-1' : 'mt-0.5 gap-0.5')}>
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
                            onHibernate,
                            onClearCache,
                            onRemove,
                            onTakeover,
                            onRelease,
                            onMoveToGroup,
                            onRunPluginAction,
                          })
                        }
                      />
                    ))}
                    {!compact && bucket.environments.length === 0 && (
                      <li className="px-2 py-1.5 text-xs text-muted-foreground">空分组</li>
                    )}
                  </ul>
                </SidebarGroupContent>
              </div>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className={cn('border-t border-border', compact ? 'px-2 py-1.5' : 'px-2 py-1.5')}>
        {compact ? (
          <div className="flex flex-col items-center gap-1">
            <ActionTooltip label="新建环境" side="right">
              <IconButton
                variant="ghost"
                data-slot="sidebar-create-env"
                aria-label="新建环境"
                className="size-8"
                onClick={() => void window.envApi.openOverlay({ kind: 'create-env' })}
              >
                <Icon name="Plus" />
              </IconButton>
            </ActionTooltip>
            <ActionTooltip
              label={memorySnap ? `内存 ${formatMemoryKb(memorySnap.totalMemoryKb)}` : '查看内存占用'}
              side="right"
            >
              <button
                type="button"
                data-slot="sidebar-memory-capsule"
                aria-label="查看内存占用与一键休眠"
                onClick={openMemoryQuickPopover}
                className={cn(
                  listItemInteractiveClass,
                  'relative inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon name="Activity" className="size-4" />
                <StatusDot tone={memoryTone} className="absolute top-1.5 right-1.5 ring-1 ring-sidebar" />
              </button>
            </ActionTooltip>
            {onToggleCompact ? (
              <ActionTooltip label="展开侧栏" side="right">
                <IconButton variant="ghost" aria-label="展开侧栏" className="size-8" onClick={onToggleCompact}>
                  <Icon name="PanelLeftOpen" />
                </IconButton>
              </ActionTooltip>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 pl-1 text-xs text-muted-foreground">
            <span className="min-w-0 truncate tabular-nums">
              {!ready && environments.length === 0
                ? '正在加载环境…'
                : `${runningCount} 运行 / ${environments.length} 环境`}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                data-slot="sidebar-memory-capsule"
                title="查看内存占用与一键休眠"
                aria-label="查看内存占用与一键休眠"
                onClick={openMemoryQuickPopover}
                className={cn(
                  listItemInteractiveClass,
                  'inline-flex h-[var(--control-height-icon)] items-center gap-1.5 border border-border bg-control px-2 font-mono text-[11px] tabular-nums text-muted-foreground hover:bg-control-hover hover:text-foreground',
                )}
              >
                <StatusDot tone={memoryTone} />
                <span>{memorySnap ? formatMemoryKb(memorySnap.totalMemoryKb) : '内存'}</span>
              </button>
              <ActionTooltip label="新建分组" side="top">
                <IconButton variant="ghost" aria-label="新建分组" onClick={() => void createGroup()}>
                  <Icon name="FolderPlus" />
                </IconButton>
              </ActionTooltip>
            </div>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
