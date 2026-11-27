import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { formatMemoryKb } from '@/lib/format';
import { pluginActions, usePluginState } from '@/state/plugin-store';
import type { AppSettings, MemoryEnvAttribution, MemorySnapshot } from '@shared/types';
import { MemoryAttributionTabs } from './memory-attribution-tabs';
import { MemoryOverviewCard } from './memory-overview-card';
import { MemoryPolicyForm } from './memory-policy-form';

export { formatMemoryKb };

const POLL_INTERVAL_MS = 3000;

export function MemoryPanel() {
  const { settings } = usePluginState();
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);

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
      if (document.hidden) return;
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
    const onVisibility = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
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

  const pinnedSet = useMemo(() => new Set(settings.pinnedEnvIds ?? []), [settings.pinnedEnvIds]);

  return (
    <div data-slot="memory-panel" className="flex flex-col gap-5">
      <MemoryOverviewCard
        snapshot={snapshot}
        loading={loading}
        busyAction={busyAction}
        onRefresh={() => void pullSnapshot(false)}
        onRunAction={runPanelAction}
      />

      <MemoryAttributionTabs
        snapshot={snapshot}
        pinnedSet={pinnedSet}
        busyAction={busyAction}
        onTogglePin={togglePinEnv}
        onRunAction={runPanelAction}
      />

      <MemoryPolicyForm settings={settings} onSave={saveSettings} />

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon name="Info" className="size-3.5 shrink-0" />
        统计口径：基于操作系统工作集（Working Set）并按 PID 严格去重；Agent 自动化后台操作会自动豁免降频与回收。
      </p>
    </div>
  );
}
