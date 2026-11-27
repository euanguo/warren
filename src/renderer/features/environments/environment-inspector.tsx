import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
import { ActionTooltip } from '@/components/action-tooltip';
import { Icon } from '@/components/icons';
import { PluginBrandGlyph } from '@/components/identity-glyphs';
import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { PluginInspectorTab } from '@/lib/plugin-sdk-types';
import type {
  ConsoleEntry,
  CookieSummary,
  Environment,
  EventRecord,
  NetHit,
  NetRule,
  NetworkEntry,
  SnapshotResult,
  SpaceId,
} from '@shared/types';
import {
  ConsoleInspectorPanel,
  EventsInspectorPanel,
  NetRulesPanel,
  NetworkInspectorPanel,
  SnapshotInspectorPanel,
  StorageInspectorPanel,
} from './inspector-panels';

interface Props {
  current?: Environment;
  events: EventRecord[];
  snapshot?: SnapshotResult;
  snapshotLoading: boolean;
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  netRules: NetRule[];
  netHits: NetHit[];
  /** 存储页：cookie 元数据（没有值）；undefined = 还没读过 */
  cookies?: CookieSummary[];
  onNetRuleToggle: (ruleId: string, enabled: boolean) => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
  onRefreshSnapshot: () => void;
  onRefreshCookies?: () => void;
  pluginTabs?: PluginInspectorTab[];
  environmentId?: string;
  space?: SpaceId;
  url?: string;
  onOpenPluginPage?: (pluginId: string, surfaceId: string) => void;
  maximized?: boolean;
  onToggleMaximize?: () => void;
  onClose?: () => void;
}

/**
 * 右侧伴随工作台抽屉（OpenBot SidePanel 风格）：
 * - CSS mask-image 左右边缘滚动渐隐（无翻页箭头噪音）；
 * - 隐藏在悬停/激活项两侧的智能 1px 竖向分隔线；
 * - 支持全舞台最大化 / 还原 + 关闭按钮；
 * - 覆盖事件 / 快照 / 控制台 / 网络 / 规则 / 存储 / 插件伴随页。
 */
export function EnvironmentInspector({
  current,
  events,
  snapshot,
  snapshotLoading,
  consoleEntries,
  networkEntries,
  netRules,
  netHits,
  cookies,
  onNetRuleToggle,
  activeTab,
  onTabChange,
  onRefreshSnapshot,
  onRefreshCookies,
  pluginTabs = [],
  environmentId,
  space = 'person',
  url = '',
  onOpenPluginPage,
  maximized = false,
  onToggleMaximize,
  onClose,
}: Props) {
  const running = current?.status === 'running';
  const errorCount = consoleEntries.filter((entry) => entry.level === 'error').length;
  const tabsListRef = useRef<HTMLDivElement>(null);
  const [eventActorFilter, setEventActorFilter] = useState<'all' | 'agent' | 'human' | 'system'>('all');
  const [onlyCurrentEnv, setOnlyCurrentEnv] = useState(false);
  const [eventQuery, setEventQuery] = useState('');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  const syncTabFade = useCallback(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const start = list.scrollLeft > 4;
    const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 4;
    list.dataset.fadeStart = start ? 'true' : 'false';
    list.dataset.fadeEnd = end ? 'true' : 'false';
  }, []);

  useEffect(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(
      '[data-slot="tabs-trigger"][data-active], [data-slot="tabs-trigger"][aria-selected="true"]',
    );
    active?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    syncTabFade();
  }, [activeTab, pluginTabs.length, syncTabFade]);

  useEffect(() => {
    const list = tabsListRef.current;
    if (!list) return;
    syncTabFade();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncTabFade) : null;
    observer?.observe(list);
    return () => observer?.disconnect();
  }, [syncTabFade, pluginTabs.length]);

  const filteredEvents = useMemo(() => {
    const q = eventQuery.trim().toLowerCase();
    return events
      .slice(-120)
      .reverse()
      .filter((event) => {
        if (onlyCurrentEnv && current && event.environmentId !== current.id) return false;
        if (eventActorFilter !== 'all' && event.actor !== eventActorFilter) return false;
        if (!q) return true;
        return event.message.toLowerCase().includes(q) || event.actor.toLowerCase().includes(q);
      });
  }, [events, eventActorFilter, eventQuery, onlyCurrentEnv, current]);

  const builtinTabItems = [
    { id: 'events', label: '事件', disabled: false, badge: null as React.ReactNode },
    { id: 'snapshot', label: '快照', disabled: !running, badge: null },
    {
      id: 'console',
      label: '控制台',
      disabled: !running,
      badge: errorCount > 0 ? <Badge variant="destructive">{errorCount}</Badge> : null,
    },
    {
      id: 'network',
      label: '网络',
      disabled: !running,
      badge: networkEntries.length > 0 ? <Badge variant="secondary">{networkEntries.length}</Badge> : null,
    },
    {
      id: 'rules',
      label: '规则',
      disabled: !running,
      badge: netRules.length > 0 ? <Badge variant="secondary">{netRules.length}</Badge> : null,
    },
    {
      id: 'storage',
      label: '存储',
      disabled: !running,
      badge: cookies && cookies.length > 0 ? <Badge variant="secondary">{cookies.length}</Badge> : null,
    },
  ];

  const allTabIds = [
    ...builtinTabItems.map((item) => item.id),
    ...pluginTabs.map((t) => `plugin:${t.pluginId}:${t.id}`),
  ];

  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      data-slot="environment-inspector"
      data-maximized={maximized ? 'true' : 'false'}
      className="h-full w-full min-w-0 gap-0 overflow-hidden bg-canvas"
    >
      <div className="flex h-[var(--shell-address-row-height)] shrink-0 items-center gap-1 border-b border-border px-1.5">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <TabsList
            ref={tabsListRef}
            variant="pill"
            onScroll={syncTabFade}
            className="warren-fade-x scroll-fade-x h-[var(--control-height-icon)] w-full min-w-0 justify-start gap-1 overflow-x-auto px-0.5"
          >
            {builtinTabItems.map((item, idx) => {
              const isSelected = activeTab === item.id;
              const nextIsSelected = allTabIds[idx + 1] === activeTab;
              return (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  disabled={item.disabled}
                  className={cn(
                    'relative h-[var(--control-height-icon)] shrink-0 flex-none px-2 text-[12px] font-medium',
                    !isSelected &&
                      !nextIsSelected &&
                      idx < allTabIds.length - 1 &&
                      'after:pointer-events-none after:absolute after:top-1/2 after:-right-[3px] after:h-4 after:w-px after:-translate-y-1/2 after:bg-border-strong hover:after:opacity-0',
                  )}
                >
                  {item.label}
                  {item.badge}
                </TabsTrigger>
              );
            })}
            {pluginTabs.map((tab, pIdx) => {
              const value = `plugin:${tab.pluginId}:${tab.id}`;
              const globalIdx = builtinTabItems.length + pIdx;
              const isSelected = activeTab === value;
              const nextIsSelected = allTabIds[globalIdx + 1] === activeTab;
              return (
                <TabsTrigger
                  key={tab.id}
                  value={value}
                  disabled={!running}
                  className={cn(
                    'relative h-[var(--control-height-icon)] shrink-0 flex-none gap-1 px-2 text-[12px] font-medium',
                    !isSelected &&
                      !nextIsSelected &&
                      globalIdx < allTabIds.length - 1 &&
                      'after:pointer-events-none after:absolute after:top-1/2 after:-right-[3px] after:h-4 after:w-px after:-translate-y-1/2 after:bg-border-strong hover:after:opacity-0',
                  )}
                >
                  <PluginBrandGlyph pluginId={tab.pluginId} icon={tab.icon} className="size-3" />
                  {tab.title}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {activeTab === 'snapshot' && (
            <ActionTooltip label="刷新 Agent 快照" side="bottom">
              <IconButton
                size="icon-xs"
                aria-label="刷新 Agent 快照"
                disabled={!running || snapshotLoading}
                onClick={onRefreshSnapshot}
              >
                <Icon name="RotateClockwise" className={snapshotLoading ? 'animate-spin' : undefined} />
              </IconButton>
            </ActionTooltip>
          )}
          {activeTab === 'storage' && onRefreshCookies && (
            <ActionTooltip label="刷新 Cookie 列表" side="bottom">
              <IconButton size="icon-xs" aria-label="刷新 Cookie 列表" disabled={!running} onClick={onRefreshCookies}>
                <Icon name="RotateClockwise" />
              </IconButton>
            </ActionTooltip>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton size="icon-xs" variant="ghost" aria-label="全部工作台面板" title="切换全部工作台面板" />
              }
            >
              <Icon name="ChevronDown" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuGroup>
                <DropdownMenuLabel>内置调试</DropdownMenuLabel>
                {builtinTabItems.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    disabled={item.disabled}
                    onClick={() => onTabChange(item.id)}
                    className="justify-between"
                  >
                    <span>{item.label}</span>
                    {activeTab === item.id && <Icon name="Check" className="size-3.5 text-accent-text" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              {pluginTabs.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>插件伴随</DropdownMenuLabel>
                    {pluginTabs.map((tab) => {
                      const value = `plugin:${tab.pluginId}:${tab.id}`;
                      return (
                        <DropdownMenuItem
                          key={value}
                          disabled={!running}
                          onClick={() => onTabChange(value)}
                          className="justify-between"
                        >
                          <span className="flex items-center gap-1.5">
                            <PluginBrandGlyph pluginId={tab.pluginId} icon={tab.icon} />
                            {tab.title}
                          </span>
                          {activeTab === value && <Icon name="Check" className="size-3.5 text-accent-text" />}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {onToggleMaximize && (
            <ActionTooltip label={maximized ? '还原伴随面板宽度' : '最大化伴随面板'} side="bottom">
              <IconButton
                size="icon-xs"
                variant="ghost"
                data-slot="inspector-maximize-toggle"
                aria-label={maximized ? '还原面板' : '最大化面板'}
                aria-pressed={maximized}
                onClick={onToggleMaximize}
              >
                <Icon name={maximized ? 'Minimize' : 'Maximize'} />
              </IconButton>
            </ActionTooltip>
          )}

          {onClose && (
            <ActionTooltip label="关闭工作台面板" side="bottom">
              <IconButton
                size="icon-xs"
                variant="ghost"
                data-slot="inspector-close"
                aria-label="关闭工作台面板"
                onClick={onClose}
              >
                <Icon name="X" />
              </IconButton>
            </ActionTooltip>
          )}
        </div>
      </div>

      <TabsContent value="events" className="flex min-h-0 flex-col">
        <EventsInspectorPanel
          totalCount={events.length}
          events={filteredEvents}
          actorFilter={eventActorFilter}
          onlyCurrentEnv={onlyCurrentEnv}
          onToggleOnlyCurrentEnv={current ? () => setOnlyCurrentEnv((prev) => !prev) : undefined}
          query={eventQuery}
          expandedEventId={expandedEventId}
          onActorFilterChange={setEventActorFilter}
          onQueryChange={setEventQuery}
          onToggleExpand={(id) => setExpandedEventId((prev) => (prev === id ? null : id))}
        />
      </TabsContent>

      <TabsContent value="snapshot" className="min-h-0">
        <SnapshotInspectorPanel
          loading={snapshotLoading}
          running={Boolean(running)}
          snapshot={snapshot}
          onRefresh={onRefreshSnapshot}
        />
      </TabsContent>

      <TabsContent value="console" className="min-h-0">
        <ConsoleInspectorPanel entries={consoleEntries} />
      </TabsContent>

      {pluginTabs.map((tab) => (
        <TabsContent key={tab.id} value={`plugin:${tab.pluginId}:${tab.id}`} className="min-h-0">
          <ScrollArea className="h-full">
            <div className="p-3">
              <PluginSurfaceHost
                pluginId={tab.pluginId}
                title={tab.title}
                Component={tab.component}
                props={{
                  pluginId: tab.pluginId,
                  environmentId,
                  space,
                  url,
                  openPluginPage: (surfaceId) => {
                    if (surfaceId) onOpenPluginPage?.(tab.pluginId, surfaceId);
                  },
                }}
              />
            </div>
          </ScrollArea>
        </TabsContent>
      ))}

      <TabsContent value="network" className="min-h-0">
        <NetworkInspectorPanel entries={networkEntries} />
      </TabsContent>

      <TabsContent value="rules" className="min-h-0">
        <ScrollArea className="h-full">
          <NetRulesPanel rules={netRules} hits={netHits} onToggle={onNetRuleToggle} />
        </ScrollArea>
      </TabsContent>

      <TabsContent value="storage" className="min-h-0">
        <StorageInspectorPanel cookies={cookies} onRefresh={onRefreshCookies} />
      </TabsContent>
    </Tabs>
  );
}
