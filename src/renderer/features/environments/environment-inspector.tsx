import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
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
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { PluginInspectorTab } from '@/lib/plugin-runtime';
import { cn } from '@/lib/utils';
import type {
  AxNode,
  ConsoleEntry,
  CookieSummary,
  Environment,
  EventRecord,
  NetAction,
  NetHit,
  NetRule,
  NetworkEntry,
  SnapshotResult,
} from '@shared/types';

const actorClass: Record<string, string> = {
  agent: 'text-[var(--info)]',
  human: 'text-[var(--warning)]',
  system: 'text-muted-foreground',
};

const consoleLevelClass: Record<string, string> = {
  error: 'text-destructive',
  warn: 'text-[var(--warning)]',
  info: 'text-muted-foreground',
  debug: 'text-muted-foreground/70',
};

function statusClass(status: number): string {
  if (status === 0) return 'text-destructive';
  if (status >= 500) return 'text-destructive';
  if (status >= 400) return 'text-[var(--warning)]';
  return 'text-muted-foreground';
}

function AxTree({ nodes }: { nodes: AxNode[] }) {
  return (
    <div className="flex flex-col gap-0.5 font-mono text-xs">
      {nodes.map((node, index) => (
        <div key={`${node.backendNodeId ?? index}`} className="flex gap-2">
          <span className="shrink-0 text-muted-foreground">{node.role}</span>
          <span className="truncate">{node.name || node.value || ''}</span>
        </div>
      ))}
    </div>
  );
}

/** 规则动作的中文短名。列表最窄只有 260px，长英文串会把匹配串挤没。 */
function actionLabel(action: NetAction): string {
  switch (action.type) {
    case 'mock':
      return `mock ${action.status}`;
    case 'block':
      return '阻断';
    case 'redirect':
      return `跳转 ${action.to}`;
    case 'delay':
      return `延迟 ${action.ms}ms`;
    case 'setRequestHeaders':
      return `改请求头 ${Object.keys(action.headers).join(',')}`;
    case 'setResponseHeaders':
      return `改响应头 ${Object.keys(action.headers).join(',')}`;
    case 'passthrough':
      return '放行（临时）';
  }
}

/**
 * 「规则」页：人看得见的规则表 + 命中记录。
 *
 * 这是相对 CDP Fetch 的核心优势——拦截规则不是 agent 的暗箱，人也能看、能关。
 */
function NetRulesPanel({
  rules,
  hits,
  onToggle,
}: {
  rules: NetRule[];
  hits: NetHit[];
  onToggle: (ruleId: string, enabled: boolean) => void;
}) {
  const hitsOf = (ruleId: string) => hits.filter((hit) => hit.ruleId === ruleId).length;
  return (
    <div className="flex flex-col gap-2 px-3 py-2 text-xs">
      {rules.length === 0 && (
        <p className="text-muted-foreground">
          还没有规则。用 <span className="font-mono">warren net rule add</span> 加一条。
        </p>
      )}
      {rules.map((rule) => (
        <div key={rule.id} className="flex items-start gap-2" data-slot="net-rule">
          <Switch
            checked={rule.enabled}
            onCheckedChange={(checked) => onToggle(rule.id, checked)}
            aria-label={`${rule.enabled ? '关闭' : '启用'}规则 ${rule.id}`}
            className="mt-0.5"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono">{rule.match.url}</span>
              <Badge variant="outline" className="shrink-0">
                {actionLabel(rule.action)}
              </Badge>
            </div>
            <div className="truncate font-mono text-muted-foreground">
              {rule.id.slice(0, 8)} · {rule.match.method ?? '*'} · 命中 {hitsOf(rule.id)}
              {/* 临时放行会自己消失，剩多久要写出来——不然「规则怎么没了」没法解释 */}
              {/* 倒计时本来就该每次轮询重算，渲染期读时钟是刻意的（没有 SSR，不存在水合不一致） */}
              {/* oxlint-disable-next-line react/purity */}
              {rule.expiresAt ? ` · 剩 ${Math.max(0, Math.round((rule.expiresAt - Date.now()) / 1000))}s` : ''}
            </div>
          </div>
        </div>
      ))}
      <div className="mt-1 flex flex-col gap-0.5 border-t border-border pt-2 font-mono">
        <p className="text-muted-foreground">命中记录（最近 {hits.length} 条）</p>
        {hits.slice(0, 40).map((hit, index) => (
          <div key={`${hit.at}-${index}`} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">{hit.at.slice(11, 19)}</span>
            <span className={cn('w-9 shrink-0', statusClass(hit.status))}>{hit.status || 'ERR'}</span>
            <span className="w-16 shrink-0 text-muted-foreground">{hit.action}</span>
            <span className="truncate">{hit.url}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

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
  /** 插件往检查器里加的页 */
  pluginTabs?: PluginInspectorTab[];
  environmentId?: string;
}

/**
 * 检查器面板：事件 / 快照 / 控制台 / 网络。
 *
 * 它是**调试用的旁路信息**，不是主内容——所以默认收在右侧面板里，
 * 不占页面高度。标签用中文短名，因为面板最窄只有 260px，四个英文标签放不下。
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
  pluginTabs = [],
  environmentId,
}: Props) {
  const running = current?.status === 'running';
  const errorCount = consoleEntries.filter((entry) => entry.level === 'error').length;
  const tabsListRef = useRef<HTMLDivElement>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });
  const [eventActorFilter, setEventActorFilter] = useState<'all' | 'agent' | 'human' | 'system'>('all');
  const [eventQuery, setEventQuery] = useState('');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  const syncTabOverflow = useCallback(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const left = list.scrollLeft > 2;
    const right = list.scrollLeft + list.clientWidth < list.scrollWidth - 2;
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
        if (eventActorFilter !== 'all' && event.actor !== eventActorFilter) return false;
        if (!q) return true;
        return event.message.toLowerCase().includes(q) || event.actor.toLowerCase().includes(q);
      });
  }, [events, eventActorFilter, eventQuery]);

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
      className="h-full w-full min-w-0 gap-0 overflow-hidden bg-background"
    >
      <div className="flex h-[var(--shell-address-row-height)] shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        {tabScroll.left && (
          <IconButton
            size="icon-xs"
            variant="ghost"
            aria-label="向左滚动标签"
            onClick={() => scrollTabsBy(-120)}
            className="shrink-0"
          >
            <Icon name="ChevronLeft" />
          </IconButton>
        )}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <TabsList
            ref={tabsListRef}
            variant="line"
            onScroll={syncTabOverflow}
            className="h-auto w-full min-w-0 justify-start gap-0.5 overflow-x-auto px-0.5 [scrollbar-width:none]"
          >
            <TabsTrigger value="events" className="shrink-0 px-2 text-xs">
              事件
            </TabsTrigger>
            <TabsTrigger value="snapshot" disabled={!running} className="shrink-0 px-2 text-xs">
              快照
            </TabsTrigger>
            <TabsTrigger value="console" disabled={!running} className="shrink-0 px-2 text-xs">
              控制台
              {errorCount > 0 && (
                <Badge variant="outline" className="border-destructive/50 text-destructive">
                  {errorCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="network" disabled={!running} className="shrink-0 px-2 text-xs">
              网络
              {networkEntries.length > 0 && <Badge variant="outline">{networkEntries.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="rules" disabled={!running} className="shrink-0 px-2 text-xs">
              规则
              {netRules.length > 0 && <Badge variant="outline">{netRules.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="storage" disabled={!running} className="shrink-0 px-2 text-xs">
              存储
              {cookies && cookies.length > 0 && <Badge variant="outline">{cookies.length}</Badge>}
            </TabsTrigger>
            {pluginTabs.length > 0 && <span className="mx-1 h-3.5 w-px shrink-0 bg-border" aria-hidden />}
            {pluginTabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={`plugin:${tab.pluginId}:${tab.id}`}
                disabled={!running}
                className="shrink-0 px-2 text-xs"
              >
                {tab.title}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabScroll.left && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-background to-transparent"
            />
          )}
          {tabScroll.right && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-background to-transparent"
            />
          )}
        </div>
        {tabScroll.right && (
          <IconButton
            size="icon-xs"
            variant="ghost"
            aria-label="向右滚动标签"
            onClick={() => scrollTabsBy(120)}
            className="shrink-0"
          >
            <Icon name="ChevronRight" />
          </IconButton>
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
                        <span>{tab.title}</span>
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
      </div>

      <TabsContent value="events" className="flex min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2.5 py-1.5">
          {(
            [
              ['all', '全部'],
              ['agent', 'Agent'],
              ['human', '人工'],
              ['system', '系统'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setEventActorFilter(value)}
              className={cn(
                'rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[length:var(--font-size-micro)] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-focus',
                eventActorFilter === value
                  ? 'bg-surface-selected font-medium text-foreground'
                  : 'text-subtle-foreground hover:bg-surface-hover hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
          <input
            type="text"
            value={eventQuery}
            onChange={(event) => setEventQuery(event.target.value)}
            placeholder="筛选…"
            aria-label="筛选事件"
            className="ml-auto h-6 w-24 min-w-0 rounded-[var(--radius-sm)] border border-border bg-[var(--input-fill)] px-2 text-[length:var(--font-size-micro)] text-foreground outline-none placeholder:text-subtle-foreground focus:border-focus"
          />
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 px-2 pt-1.5 pr-3 pb-5 text-xs leading-5">
            {filteredEvents.length === 0 && (
              <p className="px-1.5 py-2 text-muted-foreground">
                {events.length === 0 ? '暂无事件。' : '没有匹配的事件记录。'}
              </p>
            )}
            {filteredEvents.map((event) => {
              const expanded = expandedEventId === event.id;
              return (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => setExpandedEventId(expanded ? null : event.id)}
                  title={expanded ? '点击收起' : `${event.message}（点击展开全文）`}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-left transition-colors outline-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-focus',
                    expanded && 'bg-surface-selected/70',
                  )}
                >
                  <span className="shrink-0 font-mono text-[length:var(--font-size-micro)] text-muted-foreground tabular-nums">
                    {new Date(event.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  <span
                    className={cn(
                      'w-11 shrink-0 font-mono text-[length:var(--font-size-micro)]',
                      actorClass[event.actor],
                    )}
                  >
                    {event.actor}
                  </span>
                  <span className={cn('min-w-0 flex-1', expanded ? 'break-all whitespace-pre-wrap' : 'truncate')}>
                    {event.message}
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="snapshot" className="min-h-0">
        <ScrollArea className="h-full">
          <div className="px-3 py-2">
            {snapshotLoading && (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner /> 正在读取可访问性树…
              </span>
            )}
            {!snapshotLoading && !snapshot && (
              <div className="flex flex-col items-start gap-2 py-2">
                <p className="text-xs text-muted-foreground">读取当前页面的可访问性节点树，便于检查 Agent 感知结构。</p>
                <Button size="xs" variant="outline" disabled={!running} onClick={onRefreshSnapshot}>
                  <Icon name="RotateClockwise" className="size-3.5" />
                  读取当前页面快照
                </Button>
              </div>
            )}
            {!snapshotLoading && snapshot && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  {snapshot.title} · {snapshot.nodes.length} 个节点
                </p>
                <AxTree nodes={snapshot.nodes} />
              </div>
            )}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="console" className="min-h-0">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-0.5 px-3 py-2 font-mono text-xs">
            {consoleEntries.length === 0 && <p className="text-muted-foreground">还没有 console 输出。</p>}
            {consoleEntries
              .slice(-120)
              .reverse()
              .map((entry, index) => (
                <div key={`${entry.at}-${index}`} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground">{entry.at.slice(11, 19)}</span>
                  <span className={cn('w-10 shrink-0', consoleLevelClass[entry.level])}>{entry.level}</span>
                  <span className="truncate">{entry.message}</span>
                  {entry.source && <span className="shrink-0 text-muted-foreground">{entry.source}</span>}
                </div>
              ))}
          </div>
        </ScrollArea>
      </TabsContent>

      {pluginTabs.map((tab) => (
        <TabsContent key={tab.id} value={`plugin:${tab.pluginId}:${tab.id}`} className="min-h-0">
          <ScrollArea className="h-full">
            <div className="p-3">
              <PluginSurfaceHost
                pluginId={tab.pluginId}
                title={tab.title}
                Component={tab.component}
                props={{ pluginId: tab.pluginId, environmentId }}
              />
            </div>
          </ScrollArea>
        </TabsContent>
      ))}

      <TabsContent value="network" className="min-h-0">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-0.5 px-3 py-2 font-mono text-xs">
            {networkEntries.length === 0 && <p className="text-muted-foreground">还没有网络请求。</p>}
            {networkEntries
              .slice(-120)
              .reverse()
              .map((entry, index) => (
                <div key={`${entry.at}-${index}`} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground">{entry.at.slice(11, 19)}</span>
                  <span className={cn('w-9 shrink-0', statusClass(entry.status))}>{entry.status || 'ERR'}</span>
                  <span className="w-12 shrink-0 text-muted-foreground">{entry.method}</span>
                  <span className="truncate">{entry.url}</span>
                </div>
              ))}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="rules" className="min-h-0">
        <ScrollArea className="h-full">
          <NetRulesPanel rules={netRules} hits={netHits} onToggle={onNetRuleToggle} />
        </ScrollArea>
      </TabsContent>

      <TabsContent value="storage" className="min-h-0">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-0.5 px-3 py-2 font-mono text-xs">
            {!cookies && <p className="font-sans text-muted-foreground">正在读取…</p>}
            {cookies?.length === 0 && <p className="font-sans text-muted-foreground">这个环境还没有 cookie。</p>}
            {cookies?.map((cookie) => (
              <div key={`${cookie.domain}${cookie.path}${cookie.name}`} className="flex items-baseline gap-2">
                <span className="truncate">{cookie.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {cookie.secure ? 'S' : '-'}
                  {cookie.httpOnly ? 'H' : '-'}
                </span>
                <span className="truncate text-muted-foreground">{cookie.domain}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {cookie.session
                    ? '会话'
                    : cookie.expirationDate
                      ? new Date(cookie.expirationDate * 1000).toLocaleDateString()
                      : '—'}
                </span>
              </div>
            ))}
            {cookies && cookies.length > 0 && (
              <p className="mt-2 font-sans text-muted-foreground/70">
                只有名字 / 域 / 过期 / 标志——cookie 的值不走这条通道（见 PLUGIN-CAPABILITY-DESIGN §9）。 S = secure，H =
                httpOnly。
              </p>
            )}
          </div>
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}
