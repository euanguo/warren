import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { environmentActions } from '@/state/environment-store';
import { pluginActions, usePluginState } from '@/state/plugin-store';
import { cardSurfaceClass } from '@/theme/surface';
import type {
  AppSettings,
  EnvMemoryProtectionReason,
  LruEvictAction,
  MemoryEnvAttribution,
  MemoryPressureLevel,
  MemorySnapshot,
  ProcessCategory,
} from '@shared/types';

const POLL_INTERVAL_MS = 1500;

const SOFT_LIMIT_OPTIONS = ['3072', '4096', '6144', '8192', '12288', '0'];
const MAX_RUNNING_OPTIONS = ['4', '6', '8', '12', '16', '0'];
const IDLE_MINUTES_OPTIONS = ['0', '5', '10', '20', '30', '60'];
const TAB_SLEEP_OPTIONS = ['0', '10', '20', '30', '60'];

interface PolicyPreset {
  id: 'eco' | 'balanced' | 'performance';
  label: string;
  description: string;
  patch: Pick<
    AppSettings,
    | 'memorySoftLimitMb'
    | 'maxRunning'
    | 'idleHibernateMinutes'
    | 'tabSleepMinutes'
    | 'lazyRestoreTabs'
    | 'throttleBackgroundTabs'
    | 'lruEvictAction'
  >;
}

const POLICY_PRESETS: PolicyPreset[] = [
  {
    id: 'eco',
    label: '省内存',
    description: '软顶 3 GB · 并发 4 环境 · 闲置 5m 休眠 · 标签 10m 休眠',
    patch: {
      memorySoftLimitMb: 3072,
      maxRunning: 4,
      idleHibernateMinutes: 5,
      tabSleepMinutes: 10,
      lazyRestoreTabs: true,
      throttleBackgroundTabs: true,
      lruEvictAction: 'hibernate',
    },
  },
  {
    id: 'balanced',
    label: '均衡（推荐）',
    description: '软顶 6 GB · 并发 8 环境 · 闲置 10m 休眠 · 标签 20m 休眠',
    patch: {
      memorySoftLimitMb: 6144,
      maxRunning: 8,
      idleHibernateMinutes: 10,
      tabSleepMinutes: 20,
      lazyRestoreTabs: true,
      throttleBackgroundTabs: true,
      lruEvictAction: 'hibernate',
    },
  },
  {
    id: 'performance',
    label: '高性能',
    description: '不设软顶 · 并发 16 环境 · 闲置 30m 休眠 · 保持标签常驻',
    patch: {
      memorySoftLimitMb: 0,
      maxRunning: 16,
      idleHibernateMinutes: 30,
      tabSleepMinutes: 0,
      lazyRestoreTabs: false,
      throttleBackgroundTabs: false,
      lruEvictAction: 'hibernate',
    },
  },
];

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

const PRESSURE_META: Record<MemoryPressureLevel, { label: string; tone: StatusDotTone; badgeClass: string }> = {
  normal: {
    label: '水位正常',
    tone: 'success',
    badgeClass: 'bg-[var(--success)]/15 text-[var(--success)]',
  },
  elevated: {
    label: '内存偏高',
    tone: 'warning',
    badgeClass: 'bg-[var(--warning)]/15 text-[var(--warning)]',
  },
  high: {
    label: '高压警戒',
    tone: 'error',
    badgeClass: 'bg-[var(--destructive)]/15 text-[var(--destructive)]',
  },
};

export function formatMemoryKb(kb: number): string {
  const safe = Number.isFinite(kb) && kb > 0 ? kb : 0;
  const mb = safe / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(safe)} KB`;
}

function formatIdleSeconds(seconds: number): string {
  if (seconds < 60) return '刚刚活跃';
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `闲置 ${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  return `闲置 ${hours} 小时 ${mins % 60} 分`;
}

function formatLimitMb(mb: number): string {
  if (mb <= 0) return '不限制';
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

function matchesPreset(settings: AppSettings, preset: PolicyPreset): boolean {
  const p = preset.patch;
  return (
    (settings.memorySoftLimitMb ?? 6144) === p.memorySoftLimitMb &&
    (settings.maxRunning ?? 8) === p.maxRunning &&
    (settings.idleHibernateMinutes ?? 10) === p.idleHibernateMinutes &&
    (settings.tabSleepMinutes ?? 20) === p.tabSleepMinutes &&
    (settings.lazyRestoreTabs ?? true) === p.lazyRestoreTabs &&
    (settings.throttleBackgroundTabs ?? true) === p.throttleBackgroundTabs &&
    (settings.lruEvictAction ?? 'hibernate') === p.lruEvictAction
  );
}

export function MemoryPanel() {
  const { settings } = usePluginState();
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expandedEnvs, setExpandedEnvs] = useState<Record<string, boolean>>({});
  const [detailTab, setDetailTab] = useState<'environments' | 'plugins' | 'processes'>('environments');

  const pullSnapshot = useCallback(async (silent = false) => {
    try {
      const next = await window.envApi.memorySnapshot();
      setSnapshot(next);
    } catch (error) {
      if (!silent) {
        toast.error('采集内存快照失败', {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const load = () => {
      void window.envApi
        .memorySnapshot()
        .then((next) => {
          if (!active) return;
          setSnapshot(next);
          setLoading(false);
        })
        .catch(() => {
          if (active) setLoading(false);
        });
    };
    load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const saveSettings = async (patch: Partial<AppSettings>, notice?: string) => {
    try {
      await pluginActions.updateSettings(patch);
      if (notice) toast.success(notice);
      void pullSnapshot(true);
    } catch (error) {
      toast.error('保存内存策略失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const runPanelAction = async (key: string, fn: () => Promise<void>) => {
    setBusyAction(key);
    try {
      await fn();
      await pullSnapshot(true);
    } finally {
      setBusyAction(null);
    }
  };

  const togglePinEnv = async (env: MemoryEnvAttribution) => {
    const current = new Set(settings.pinnedEnvIds ?? []);
    if (current.has(env.id)) current.delete(env.id);
    else current.add(env.id);
    await saveSettings(
      { pinnedEnvIds: [...current] },
      current.has(env.id) ? `已固定「${env.name}」，免受自动休眠与 LRU 回收` : `已取消固定「${env.name}」`,
    );
  };

  const toggleExpanded = (id: string) => {
    setExpandedEnvs((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const pressureMeta = PRESSURE_META[snapshot?.pressure ?? 'normal'];
  const totalKb = snapshot?.totalMemoryKb ?? 0;
  const hostPercent =
    snapshot && snapshot.systemTotalKb > 0 ? Math.min(100, (snapshot.totalMemoryKb / snapshot.systemTotalKb) * 100) : 0;

  const segments = useMemo(() => {
    if (!snapshot || totalKb <= 0) return [];
    const items: Array<{ key: string; label: string; kb: number; barClass: string; dotClass: string }> = [
      {
        key: 'environments',
        label: '环境页面',
        kb: snapshot.breakdown.environmentsKb,
        barClass: 'bg-[var(--theme-accent)]',
        dotClass: 'bg-[var(--theme-accent)]',
      },
      {
        key: 'plugins',
        label: '插件进程',
        kb: snapshot.breakdown.pluginsKb,
        barClass: 'bg-[var(--info)]',
        dotClass: 'bg-[var(--info)]',
      },
      {
        key: 'shell',
        label: '壳层与浮层',
        kb: snapshot.breakdown.shellKb,
        barClass: 'bg-[var(--warning)]',
        dotClass: 'bg-[var(--warning)]',
      },
      {
        key: 'system',
        label: '系统与 GPU',
        kb: snapshot.breakdown.systemKb,
        barClass: 'bg-muted-foreground/45',
        dotClass: 'bg-muted-foreground/45',
      },
    ];
    return items.map((item) => ({
      ...item,
      percent: Math.round((item.kb / totalKb) * 1000) / 10,
    }));
  }, [snapshot, totalKb]);

  const pinnedSet = useMemo(() => new Set(settings.pinnedEnvIds ?? []), [settings.pinnedEnvIds]);

  return (
    <div data-slot="memory-panel" className="flex flex-col gap-5">
      {/* 顶部总览与快捷治理 */}
      <div className={cn(cardSurfaceClass, 'flex flex-col gap-4')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Warren 总内存（按 PID 去重）</span>
              <Badge variant="ghost" className={cn('gap-1.5 font-medium', pressureMeta.badgeClass)}>
                <StatusDot tone={pressureMeta.tone} />
                {pressureMeta.label}
              </Badge>
            </div>
            <div className="flex items-baseline gap-2.5">
              <span data-slot="memory-total" className="text-2xl font-semibold tracking-tight tabular-nums">
                {loading && !snapshot ? '采集中…' : formatMemoryKb(totalKb)}
              </span>
              {snapshot && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {snapshot.softLimitMb > 0 ? `软顶 ${formatLimitMb(snapshot.softLimitMb)} · ` : ''}
                  占宿主机 {hostPercent.toFixed(1)}%（可用 {formatMemoryKb(snapshot.systemFreeKb)}）·{' '}
                  {snapshot.counts.processCount} 进程
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">每 1.5s 实时采样</span>
            <IconButton
              variant="ghost"
              title="立即刷新快照"
              aria-label="立即刷新快照"
              onClick={() => void pullSnapshot(false)}
            >
              <Icon name="Refresh" className="size-3.5" />
            </IconButton>
          </div>
        </div>

        {/* 4 分类堆叠条 */}
        <div className="flex flex-col gap-2">
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-under">
            {segments.map((seg) =>
              seg.kb > 0 ? (
                <div
                  key={seg.key}
                  style={{ width: `${Math.max(1.5, seg.percent)}%` }}
                  title={`${seg.label}：${formatMemoryKb(seg.kb)} (${seg.percent}%)`}
                  className={cn('h-full transition-[width] duration-300', seg.barClass)}
                />
              ) : null,
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {segments.map((seg) => (
              <div
                key={seg.key}
                className="flex items-center justify-between rounded-[var(--control-radius)] border border-border/70 bg-surface-under/50 px-2.5 py-1.5 text-xs"
              >
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className={cn('size-2 shrink-0 rounded-full', seg.dotClass)} />
                  {seg.label}
                </span>
                <span className="font-mono font-medium tabular-nums">{formatMemoryKb(seg.kb)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 一键动作条 */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={busyAction !== null || (snapshot?.reclaimableMemoryKb ?? 0) === 0}
            onClick={() =>
              void runPanelAction('hibernate-bg', async () => {
                await environmentActions.hibernateBackground();
              })
            }
          >
            <Icon name="Zap" />
            休眠全部后台环境
            {snapshot && snapshot.reclaimableMemoryKb > 0 && (
              <span className="font-mono text-[11px] text-muted-foreground">
                约释放 {formatMemoryKb(snapshot.reclaimableMemoryKb)}
              </span>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busyAction !== null}
            onClick={() =>
              void runPanelAction('sleep-tabs', async () => {
                await environmentActions.sleepIdleTabs();
              })
            }
          >
            <Icon name="Stop" />
            释放非激活标签
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busyAction !== null}
            onClick={() =>
              void runPanelAction('clear-caches', async () => {
                await environmentActions.clearAllCaches();
              })
            }
          >
            <Icon name="Trash" />
            清理 HTTP 缓存（保留登录态）
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busyAction !== null}
            onClick={() =>
              void runPanelAction('reclaim-shell', async () => {
                const res = await window.envApi.reclaimShellSurfaces();
                if (res.reclaimed > 0) toast.success(`已回收 ${res.reclaimed} 个空闲浮层进程`);
                else toast.info('当前没有可回收的空闲浮层进程');
              })
            }
          >
            回收空闲浮层
          </Button>
        </div>
      </div>

      {/* 归因明细 */}
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
                            onClick={() => void togglePinEnv(env)}
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
                                void runPanelAction(`hibernate:${env.id}`, async () => {
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
                                void runPanelAction(`wake:${env.id}`, async () => {
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
                              void runPanelAction(`cache:${env.id}`, async () => {
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
                                        void runPanelAction(`sleep-tab:${tab.id}`, async () => {
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
                    {plugin.pid && (
                      <span className="font-mono text-[11px] text-muted-foreground">PID {plugin.pid}</span>
                    )}
                    <span className="ml-auto font-mono font-medium tabular-nums">
                      {formatMemoryKb(plugin.memoryKb)}
                    </span>
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
                            void runPanelAction(`reload-plugin:${plugin.id}`, async () => {
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
                            void runPanelAction(`disable-plugin:${plugin.id}`, async () => {
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

      {/* 策略预设与细粒度控制 */}
      <div className={cn(cardSurfaceClass, 'flex flex-col gap-4')}>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">自动内存治理策略</span>
          <span className="text-xs text-muted-foreground">
            一键切换预设档位，或按需微调软水位、休眠阈值与后台降频。所有自动回收均绝不中断当前查看、Agent
            持权或已固定环境。
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {POLICY_PRESETS.map((preset) => {
            const active = matchesPreset(settings, preset);
            return (
              <button
                key={preset.id}
                type="button"
                data-slot="memory-preset"
                data-preset={preset.id}
                data-active={active ? 'true' : 'false'}
                onClick={() => void saveSettings(preset.patch, `已切换到「${preset.label}」策略`)}
                className={cn(
                  'flex flex-col gap-1 rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition-colors',
                  active
                    ? 'border-[var(--theme-accent)] bg-surface-selected'
                    : 'border-border bg-surface-under/40 hover:bg-surface-hover',
                )}
              >
                <span className="text-xs font-medium">{preset.label}</span>
                <span className="text-[11px] leading-snug text-muted-foreground">{preset.description}</span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 gap-4 border-t border-border pt-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">内存软水位上限（自动压力守卫）</span>
            <Select
              value={String(settings.memorySoftLimitMb ?? 6144)}
              onValueChange={(value) => void saveSettings({ memorySoftLimitMb: Number(value) })}
            >
              <SelectTrigger data-slot="memory-soft-limit">
                <SelectValue>{(value) => formatLimitMb(Number(value))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SOFT_LIMIT_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {formatLimitMb(Number(opt))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              超出软水位时自动释放闲置标签并休眠最久未用的后台环境，回落至 85% 安全水位即止。
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">并发运行环境上限</span>
            <Select
              value={String(settings.maxRunning ?? 8)}
              onValueChange={(value) => void saveSettings({ maxRunning: Number(value) })}
            >
              <SelectTrigger>
                <SelectValue>
                  {(value) => (String(value) === '0' ? '不限制' : `最多 ${String(value)} 个环境`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MAX_RUNNING_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt === '0' ? '不限制' : `${opt} 个环境`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">同时运行的环境超过上限时按最久未使用顺序回收。</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">后台环境闲置休眠</span>
            <Select
              value={String(settings.idleHibernateMinutes ?? 10)}
              onValueChange={(value) => void saveSettings({ idleHibernateMinutes: Number(value) })}
            >
              <SelectTrigger>
                <SelectValue>
                  {(value) => (String(value) === '0' ? '关闭自动休眠' : `${String(value)} 分钟`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {IDLE_MINUTES_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt === '0' ? '关闭自动休眠' : `${opt} 分钟`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              休眠会释放整套渲染进程，保留 Cookie、代理与标签清单，点击或 CLI 调用时秒级透明唤醒。
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">后台非激活标签自动休眠</span>
            <Select
              value={String(settings.tabSleepMinutes ?? 20)}
              onValueChange={(value) => void saveSettings({ tabSleepMinutes: Number(value) })}
            >
              <SelectTrigger>
                <SelectValue>
                  {(value) => (String(value) === '0' ? '关闭标签休眠' : `${String(value)} 分钟`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TAB_SLEEP_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt === '0' ? '关闭标签休眠' : `${opt} 分钟`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              仅回收长时间未切换的非激活标签，绝不休眠发声、加载中或打开 DevTools 的标签。
            </span>
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-xs font-medium">达到并发上限时的 LRU 回收方式</span>
            <Select
              value={settings.lruEvictAction ?? 'hibernate'}
              onValueChange={(value) => void saveSettings({ lruEvictAction: value as LruEvictAction })}
            >
              <SelectTrigger>
                <SelectValue>
                  {(value) => (value === 'stop' ? '直接停止环境' : '优先休眠（推荐：保留登录态与标签，点击透明唤醒）')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hibernate">优先休眠（推荐：保留登录态与标签，点击透明唤醒）</SelectItem>
                <SelectItem value="stop">直接停止环境</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium">惰性恢复非激活标签与非活跃空间</span>
              <span className="text-[11px] text-muted-foreground">
                启动或唤醒环境时仅加载当前激活标签，其余标签保持 0 内存占位，点击或 Agent 访问时再实例化。
              </span>
            </div>
            <Switch
              aria-label="惰性恢复非激活标签与非活跃空间"
              checked={settings.lazyRestoreTabs ?? true}
              onCheckedChange={(checked) => void saveSettings({ lazyRestoreTabs: checked })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium">后台标签自动降频（Agent 持权期间自动豁免）</span>
              <span className="text-[11px] text-muted-foreground">
                对不可见页面启用 Chromium 后台节流以显著降低 CPU 与内存波动；页面切到前台或 Agent 持权时自动解除。
              </span>
            </div>
            <Switch
              aria-label="后台标签自动降频"
              checked={settings.throttleBackgroundTabs ?? true}
              onCheckedChange={(checked) => void saveSettings({ throttleBackgroundTabs: checked })}
            />
          </div>
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon name="Info" className="size-3.5 shrink-0" />
        统计口径：基于操作系统工作集（Working Set）并按 PID 严格去重；Agent 自动化后台操作会自动豁免降频与回收。
      </p>
    </div>
  );
}
