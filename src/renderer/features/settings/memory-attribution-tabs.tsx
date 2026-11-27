import { useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatIdleSeconds, formatMemoryKb } from '@/lib/format';
import { cn } from '@/lib/utils';
import { environmentActions } from '@/state/environment-store';
import { cardSurfaceClass } from '@/theme/surface';
import type { EnvMemoryProtectionReason, MemoryEnvAttribution, MemorySnapshot, ProcessCategory } from '@shared/types';

const PROTECTION_LABELS: Record<EnvMemoryProtectionReason, string> = {
  selected: '当前查看',
  leased: 'Agent 持权',
  pinned: '已固定',
  audible: '音频播放中',
  busy: '加载/录制中',
};

const CATEGORY_LABELS: Record<ProcessCategory, string> = {
  environment: '环境页面',
  plugin: '插件进程',
  shell: '壳层浮层',
  system: '系统与 GPU',
};

interface Props {
  snapshot: MemorySnapshot | null;
  pinnedSet: ReadonlySet<string>;
  busyAction: string | null;
  onTogglePin: (env: MemoryEnvAttribution) => Promise<void>;
  onRunAction: (key: string, fn: () => Promise<void>) => Promise<void>;
}

/** 内存归因明细（环境 / 插件 / 全部进程），支持展开单环境查看共享 PID 与休眠标签。 */
export function MemoryAttributionTabs({ snapshot, pinnedSet, busyAction, onTogglePin, onRunAction }: Props) {
  const [expandedEnvs, setExpandedEnvs] = useState<Record<string, boolean>>({});
  const [detailTab, setDetailTab] = useState<'environments' | 'plugins' | 'processes'>('environments');

  const toggleExpanded = (id: string) => {
    setExpandedEnvs((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
      <Tabs
        value={detailTab}
        onValueChange={(value) => setDetailTab(value as 'environments' | 'plugins' | 'processes')}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="environments">环境占用（{snapshot?.environments.length ?? 0}）</TabsTrigger>
            <TabsTrigger value="plugins">插件进程（{snapshot?.plugins.length ?? 0}）</TabsTrigger>
            <TabsTrigger value="processes">全部进程（{snapshot?.processes.length ?? 0}）</TabsTrigger>
          </TabsList>
          <span className="text-[11px] text-muted-foreground">多标签共享同一渲染进程时仅计一次，不重复虚报</span>
        </div>

        <TabsContent value="environments" className="mt-3">
          {!snapshot || snapshot.environments.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">暂无环境数据。</p>
          ) : (
            <div className="flex flex-col gap-2">
              {snapshot.environments.map((env) => {
                const expanded = Boolean(expandedEnvs[env.id]);
                const isPinned = env.pinned || pinnedSet.has(env.id);
                const envTone: StatusDotTone =
                  env.status === 'running' ? 'success' : env.status === 'dormant' ? 'warning' : 'idle';
                const envStatusText =
                  env.status === 'running' ? '运行中' : env.status === 'dormant' ? '已休眠' : '已停止';

                return (
                  <div
                    key={env.id}
                    data-slot="memory-env-row"
                    data-env-id={env.id}
                    className="rounded-[var(--radius-md)] border border-border bg-surface-under/40"
                  >
                    <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(env.id)}
                        aria-expanded={expanded}
                        aria-label={`展开环境 ${env.name} 标签明细`}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <Icon
                          name={expanded ? 'ChevronDown' : 'ChevronRight'}
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                        <StatusDot tone={envTone} />
                        <span className="truncate text-xs font-medium">{env.name}</span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{env.id}</span>
                        <Badge variant="outline" className="text-[11px]">
                          {envStatusText}
                        </Badge>
                        {env.protectedReason && (
                          <Badge variant="secondary" className="text-[11px]">
                            {PROTECTION_LABELS[env.protectedReason]}
                          </Badge>
                        )}
                      </button>

                      <div className="flex items-center gap-3 text-xs tabular-nums">
                        <span className="text-[11px] text-muted-foreground">
                          {env.activeTabs + env.sleepingTabs} 标签
                          {env.sleepingTabs > 0 ? `（${env.sleepingTabs} 休眠）` : ''}
                          {env.status === 'running' ? ` · ${formatIdleSeconds(env.idleSeconds)}` : ''}
                        </span>
                        <span className="w-20 text-right font-mono font-medium">{formatMemoryKb(env.memoryKb)}</span>
                        <span className="w-12 text-right font-mono text-[11px] text-muted-foreground">
                          {env.cpuPercent.toFixed(1)}%
                        </span>
                      </div>

                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant={isPinned ? 'secondary' : 'ghost'}
                          title={isPinned ? '取消固定（允许自动休眠与 LRU 回收）' : '固定环境（免受自动休眠与回收）'}
                          onClick={() => void onTogglePin(env)}
                        >
                          <Icon name="Lock" className="size-3.5" />
                          {isPinned ? '已固定' : '固定'}
                        </Button>
                        {env.status === 'running' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyAction !== null || Boolean(env.protectedReason)}
                            title={
                              env.protectedReason
                                ? `受保护（${PROTECTION_LABELS[env.protectedReason]}），无法休眠`
                                : '休眠此环境释放渲染进程（保留登录态与标签）'
                            }
                            onClick={() =>
                              void onRunAction(`hibernate:${env.id}`, async () => {
                                await environmentActions.hibernate(env.id);
                              })
                            }
                          >
                            休眠
                          </Button>
                        )}
                        {env.status === 'dormant' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyAction !== null}
                            onClick={() =>
                              void onRunAction(`wake:${env.id}`, async () => {
                                await environmentActions.wake(env.id);
                              })
                            }
                          >
                            <Icon name="Play" className="size-3.5" />
                            唤醒
                          </Button>
                        )}
                        <IconButton
                          variant="ghost"
                          title="清理此环境的 HTTP 缓存（保留登录态）"
                          aria-label={`清理 ${env.name} 缓存`}
                          disabled={busyAction !== null}
                          onClick={() =>
                            void onRunAction(`cache:${env.id}`, async () => {
                              await environmentActions.clearCache(env.id);
                            })
                          }
                        >
                          <Icon name="Trash" className="size-3.5" />
                        </IconButton>
                      </div>
                    </div>

                    {expanded && (
                      <div className="border-t border-border/70 px-3 py-2">
                        {env.tabs.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground">
                            {env.status === 'dormant'
                              ? '环境已休眠，页面渲染进程已完全释放；唤醒后自动恢复标签。'
                              : '当前无打开的标签。'}
                          </p>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            {env.tabs.map((tab) => (
                              <div
                                key={tab.id}
                                className="flex items-center gap-2 rounded-[var(--control-radius)] px-2 py-1 text-xs hover:bg-surface-hover/60"
                              >
                                <Badge variant="outline" className="shrink-0 text-[10px]">
                                  {tab.space === 'agent' ? 'Agent' : '我的'}
                                </Badge>
                                <span
                                  className={cn('min-w-0 flex-1 truncate', tab.sleeping && 'text-muted-foreground')}
                                  title={tab.url}
                                >
                                  {tab.title || tab.url}
                                </span>
                                {tab.sleeping ? (
                                  <Badge variant="ghost" className="text-[10px] text-muted-foreground">
                                    休眠中 · 0 MB
                                  </Badge>
                                ) : (
                                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                                    {formatMemoryKb(tab.memoryKb)}
                                    {tab.sharedPidCount > 1 ? `（共享 PID · ${tab.sharedPidCount} 标签）` : ''}
                                  </span>
                                )}
                                {!tab.sleeping && !tab.active && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busyAction !== null}
                                    onClick={() =>
                                      void onRunAction(`sleep-tab:${tab.id}`, async () => {
                                        await environmentActions.tabSleep(env.id, tab.space, tab.id);
                                      })
                                    }
                                  >
                                    休眠标签
                                  </Button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="plugins" className="mt-3">
          {!snapshot || snapshot.plugins.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">尚未安装插件。</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {snapshot.plugins.map((plugin) => (
                <div
                  key={plugin.id}
                  className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface-under/40 px-2.5 py-2 text-xs"
                >
                  <StatusDot
                    tone={plugin.status === 'running' ? 'success' : plugin.status === 'error' ? 'error' : 'idle'}
                  />
                  <span className="font-medium">{plugin.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{plugin.id}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {plugin.runtime}
                  </Badge>
                  {plugin.pid && <span className="font-mono text-[11px] text-muted-foreground">PID {plugin.pid}</span>}
                  <span className="ml-auto font-mono font-medium tabular-nums">{formatMemoryKb(plugin.memoryKb)}</span>
                  <span className="w-12 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {plugin.cpuPercent.toFixed(1)}%
                  </span>
                  {plugin.status === 'running' && (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyAction !== null}
                        onClick={() =>
                          void onRunAction(`reload-plugin:${plugin.id}`, async () => {
                            await window.envApi.pluginReload(plugin.id);
                            toast.success(`已重载插件「${plugin.name}」`);
                          })
                        }
                      >
                        重载
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyAction !== null}
                        onClick={() =>
                          void onRunAction(`disable-plugin:${plugin.id}`, async () => {
                            await window.envApi.pluginDisable(plugin.id);
                            toast.success(`已停用插件「${plugin.name}」`);
                          })
                        }
                      >
                        停用
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="processes" className="mt-3">
          {!snapshot || snapshot.processes.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">暂无进程明细。</p>
          ) : (
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {snapshot.processes.map((proc) => (
                <div
                  key={proc.pid}
                  className="flex items-center gap-2 rounded-[var(--control-radius)] border border-border/70 px-2.5 py-1.5 text-xs"
                >
                  <Badge variant="outline" className="w-20 shrink-0 justify-center text-[10px]">
                    {CATEGORY_LABELS[proc.category]}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate" title={proc.label}>
                    {proc.label}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">PID {proc.pid}</span>
                  <span className="w-20 shrink-0 text-right font-mono font-medium tabular-nums">
                    {formatMemoryKb(proc.memoryKb)}
                  </span>
                  <span className="w-12 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {proc.cpuPercent.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
