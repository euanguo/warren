import { useMemo } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot';
import { formatLimitMb, formatMemoryKb } from '@/lib/format';
import { cn } from '@/lib/utils';
import { environmentActions } from '@/state/environment-store';
import { cardSurfaceClass } from '@/theme/surface';
import type { MemoryPressureLevel, MemorySnapshot } from '@shared/types';

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

interface Props {
  snapshot: MemorySnapshot | null;
  loading: boolean;
  busyAction: string | null;
  onRefresh: () => void;
  onRunAction: (key: string, fn: () => Promise<void>) => Promise<void>;
}

/** 内存总览卡片：PID 去重总内存、4 分类占比条（--chart-1..4 语义色）与一键释放动作。 */
export function MemoryOverviewCard({ snapshot, loading, busyAction, onRefresh, onRunAction }: Props) {
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
        barClass: 'bg-[var(--chart-1)]',
        dotClass: 'bg-[var(--chart-1)]',
      },
      {
        key: 'plugins',
        label: '插件进程',
        kb: snapshot.breakdown.pluginsKb,
        barClass: 'bg-[var(--chart-2)]',
        dotClass: 'bg-[var(--chart-2)]',
      },
      {
        key: 'shell',
        label: '壳层与浮层',
        kb: snapshot.breakdown.shellKb,
        barClass: 'bg-[var(--chart-3)]',
        dotClass: 'bg-[var(--chart-3)]',
      },
      {
        key: 'system',
        label: '系统与 GPU',
        kb: snapshot.breakdown.systemKb,
        barClass: 'bg-[var(--chart-4)]',
        dotClass: 'bg-[var(--chart-4)]',
      },
    ];
    return items.map((item) => ({
      ...item,
      percent: Math.round((item.kb / totalKb) * 1000) / 10,
    }));
  }, [snapshot, totalKb]);

  return (
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
          <span className="text-[11px] text-muted-foreground">每 3s 采样</span>
          <IconButton variant="ghost" title="立即刷新快照" aria-label="立即刷新快照" onClick={onRefresh}>
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
            void onRunAction('hibernate-bg', async () => {
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
            void onRunAction('sleep-tabs', async () => {
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
            void onRunAction('clear-caches', async () => {
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
            void onRunAction('reclaim-shell', async () => {
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
  );
}
