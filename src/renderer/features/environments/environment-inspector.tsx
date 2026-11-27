import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
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
  /** 插件往检查器里加的页 */
  pluginTabs?: PluginInspectorTab[];
  environmentId?: string;
  space?: SpaceId;
  url?: string;
  onOpenPluginPage?: (pluginId: string, surfaceId: string) => void;
}

/**
 * 检查器面板：事件 / 快照 / 控制台 / 网络 / 规则 / 存储 / 插件伴随页。
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
}: Props) {
  const running = current?.status === 'running';
  const errorCount = consoleEntries.filter((entry) => entry.level === 'error').length;
  const tabsListRef = useRef<HTMLDivElement>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });
  const [eventActorFilter, setEventActorFilter] = useState<'all' | 'agent' | 'human' | 'system'>('all');
  const [onlyCurrentEnv, setOnlyCurrentEnv] = useState(false);
  const [eventQuery, setEventQuery] = useState('');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  const syncTabOverflow = useCallback(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const left = list.scrollLeft > 6;
    const right = list.scrollLeft + list.clientWidth < list.scrollWidth - 6;
    setTabScroll((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(
      '[data-slot="tabs-trigger"][data-active], [data-slot="tabs-trigger"][aria-selected="true"]',
    );
    active?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    syncTabOverflow();
  }, [activeTab, pluginTabs.length, syncTabOverflow]);

  useEffect(() => {
    const list = tabsListRef.current;
    if (!list) return;
    syncTabOverflow();
    const observer = new ResizeObserver(syncTabOverflow);
    observer.observe(list);
    return () => observer.disconnect();
  }, [syncTabOverflow, pluginTabs.length]);

  const scrollTabsBy = (delta: number) => {
    tabsListRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

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
    { id: 'events', label: '事件', disabled: false },
    { id: 'snapshot', label: '快照', disabled: !running },
    { id: 'console', label: errorCount > 0 ? `控制台 (${errorCount})` : '控制台', disabled: !running },
    {
      id: 'network',
      label: networkEntries.length > 0 ? `网络 (${networkEntries.length})` : '网络',
      disabled: !running,
    },
    { id: 'rules', label: netRules.length > 0 ? `规则 (${netRules.length})` : '规则', disabled: !running },
    { id: 'storage', label: cookies && cookies.length > 0 ? `存储 (${cookies.length})` : '存储', disabled: !running },
  ];

  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className="h-full w-full min-w-0 gap-0 overflow-hidden bg-surface-drawer"
    >
      <div className="flex h-[var(--shell-address-row-height)] shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <TabsList
            ref={tabsListRef}
            variant="line"
            onScroll={syncTabOverflow}
            className="h-auto w-full min-w-0 justify-start gap-0.5 overflow-x-auto px-0.5 [scrollbar-width:none]"
          >
            <TabsTrigger value="events" className="shrink-0 px-1.5 text-xs">
              事件
            </TabsTrigger>
            <TabsTrigger value="snapshot" disabled={!running} className="shrink-0 px-1.5 text-xs">
              快照
            </TabsTrigger>
            <TabsTrigger value="console" disabled={!running} className="shrink-0 px-1.5 text-xs">
              控制台
              {errorCount > 0 && (
                <Badge variant="outline" className="border-destructive/50 text-destructive">
                  {errorCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="network" disabled={!running} className="shrink-0 px-1.5 text-xs">
              网络
              {networkEntries.length > 0 && <Badge variant="outline">{networkEntries.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="rules" disabled={!running} className="shrink-0 px-1.5 text-xs">
              规则
              {netRules.length > 0 && <Badge variant="outline">{netRules.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="storage" disabled={!running} className="shrink-0 px-1.5 text-xs">
              存储
              {cookies && cookies.length > 0 && <Badge variant="outline">{cookies.length}</Badge>}
            </TabsTrigger>
            {pluginTabs.length > 0 && <span className="mx-0.5 h-3.5 w-px shrink-0 bg-border" aria-hidden />}
            {pluginTabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={`plugin:${tab.pluginId}:${tab.id}`}
                disabled={!running}
                className="shrink-0 gap-1 px-1.5 text-xs"
              >
                <PluginBrandGlyph pluginId={tab.pluginId} icon={tab.icon} className="size-3" />
                {tab.title}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabScroll.left && (
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center bg-gradient-to-r from-surface-drawer via-surface-drawer/95 to-transparent pr-3">
              <IconButton
                size="icon-xs"
                variant="ghost"
                aria-label="向左滚动标签"
                onClick={() => scrollTabsBy(-120)}
                className="pointer-events-auto size-5"
              >
                <Icon name="ChevronLeft" className="size-3.5" />
              </IconButton>
            </div>
          )}
          {tabScroll.right && (
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center bg-gradient-to-l from-surface-drawer via-surface-drawer/95 to-transparent pl-3">
              <IconButton
                size="icon-xs"
                variant="ghost"
                aria-label="向右滚动标签"
                onClick={() => scrollTabsBy(120)}
                className="pointer-events-auto size-5"
              >
                <Icon name="ChevronRight" className="size-3.5" />
              </IconButton>
            </div>
          )}
        </div>
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
                  {activeTab === item.id && <Icon name="Check" className="size-3.5 text-[var(--theme-accent)]" />}
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
                        {activeTab === value && <Icon name="Check" className="size-3.5 text-[var(--theme-accent)]" />}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {activeTab === 'snapshot' && (
          <IconButton
            size="icon-xs"
            title="刷新 Agent 快照"
            aria-label="刷新 Agent 快照"
            disabled={!running || snapshotLoading}
            onClick={onRefreshSnapshot}
            className="shrink-0"
          >
            <Icon name="RotateClockwise" className={snapshotLoading ? 'animate-spin' : undefined} />
          </IconButton>
        )}
        {activeTab === 'storage' && onRefreshCookies && (
          <IconButton
            size="icon-xs"
            title="刷新 Cookie 列表"
            aria-label="刷新 Cookie 列表"
            disabled={!running}
            onClick={onRefreshCookies}
            className="shrink-0"
          >
            <Icon name="RotateClockwise" />
          </IconButton>
        )}
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
