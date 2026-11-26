import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { pluginActions, usePluginState } from '@/state/plugin-store';
import { cn } from '@/lib/utils';
import { cardSurfaceClass } from '@/theme/surface';
import type { DevToolsDockMode, DomainPref, ViewportPresetId } from '@shared/types';

const DOCK_LABELS: Record<DevToolsDockMode, string> = {
  right: '右侧停靠（默认）',
  bottom: '底部停靠',
  detach: '独立窗口',
};

const VIEWPORT_LABELS: Record<ViewportPresetId, string> = {
  auto: '自适应舞台尺寸（默认）',
  'desktop-1440': '桌面 · 1440×900',
  'laptop-1280': '笔电 · 1280×800',
  'mobile-390': '手机 · 390×844',
};

const MAX_RUNNING_OPTIONS = ['4', '6', '8', '12', '16', '0'];
const IDLE_MINUTES_OPTIONS = ['0', '5', '10', '30', '60'];

export function BrowserPanel() {
  const { settings } = usePluginState();
  const [domainPrefs, setDomainPrefs] = useState<DomainPref[]>([]);
  const [clearingHistory, setClearingHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      void window.envApi
        .domainPrefs()
        .then((list) => {
          if (!cancelled) setDomainPrefs(list);
        })
        .catch(() => {});
    };
    pull();
    const unsub = window.envApi.onEnvDelta(pull);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const save = async (patch: Parameters<typeof pluginActions.updateSettings>[0]) => {
    try {
      await pluginActions.updateSettings(patch);
    } catch (error) {
      toast.error('保存浏览器设置失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const clearPref = async (envId: string, origin: string) => {
    try {
      await window.envApi.clearDomainPref(envId, origin);
      setDomainPrefs((prev) => prev.filter((item) => !(item.envId === envId && item.origin === origin)));
    } catch (error) {
      toast.error('清除按域偏好失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const clearHistory = async () => {
    setClearingHistory(true);
    try {
      const { cleared } = await window.envApi.clearUrlHistory();
      toast.success(`已清理 ${cleared} 条地址输入历史`);
    } catch (error) {
      toast.error('清理地址历史失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setClearingHistory(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className={cn(cardSurfaceClass, 'flex flex-col gap-4')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">DevTools 默认停靠位</span>
            <Select
              value={settings.devtoolsDefaultDock ?? 'right'}
              onValueChange={(value) => void save({ devtoolsDefaultDock: value as DevToolsDockMode })}
            >
              <SelectTrigger data-slot="devtools-default-dock">
                <SelectValue>{(value) => DOCK_LABELS[value as DevToolsDockMode] ?? String(value)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(DOCK_LABELS) as DevToolsDockMode[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {DOCK_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">新打开开发者工具时默认采用的停靠方式。</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">新站点默认视口预设</span>
            <Select
              value={settings.devtoolsDefaultViewport ?? 'auto'}
              onValueChange={(value) => void save({ devtoolsDefaultViewport: value as ViewportPresetId })}
            >
              <SelectTrigger data-slot="devtools-default-viewport">
                <SelectValue>{(value) => VIEWPORT_LABELS[value as ViewportPresetId] ?? String(value)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(VIEWPORT_LABELS) as ViewportPresetId[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {VIEWPORT_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">站点尚未配置专属视口预设时作为默认值。</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 border-t border-border pt-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">并发运行环境上限（LRU 回收）</span>
            <Select
              value={String(settings.maxRunning ?? 8)}
              onValueChange={(value) => void save({ maxRunning: Number(value) })}
            >
              <SelectTrigger>
                <SelectValue>
                  {(value) => (String(value) === '0' ? '不限制' : `最多 ${String(value)} 个（默认 8）`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MAX_RUNNING_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option === '0' ? '不限制' : `${option} 个环境`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">超出上限时自动停止最久未使用的非活跃环境。</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">闲置自动休眠阈值</span>
            <Select
              value={String(settings.idleHibernateMinutes ?? 10)}
              onValueChange={(value) => void save({ idleHibernateMinutes: Number(value) })}
            >
              <SelectTrigger>
                <SelectValue>
                  {(value) => (String(value) === '0' ? '关闭自动休眠' : `${String(value)} 分钟`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {IDLE_MINUTES_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option === '0' ? '关闭自动休眠' : `${option} 分钟`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              休眠会释放渲染进程内存，保留 Cookie 与标签，再次点击或 CLI 调用时透明唤醒。
            </span>
          </div>
        </div>
      </div>

      <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">按域浏览偏好（{domainPrefs.length}）</span>
            <span className="text-xs text-muted-foreground">按环境 + Origin 记住页面缩放比例与响应式视口预设。</span>
          </div>
        </div>
        {domainPrefs.length === 0 ? (
          <p className="text-xs text-muted-foreground">还没有保存按域缩放或视口记录。</p>
        ) : (
          <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
            {domainPrefs.map((pref) => (
              <div
                key={`${pref.envId}:${pref.origin}`}
                className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border px-2.5 py-1.5 text-xs"
              >
                <span className="shrink-0 font-mono text-muted-foreground">{pref.envId}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{pref.origin}</span>
                <span className="shrink-0 text-muted-foreground">
                  {Math.round(pref.zoomFactor * 100)}%{pref.viewportPreset ? ` · ${pref.viewportPreset}` : ''}
                </span>
                <IconButton
                  title="清除此偏好"
                  aria-label={`清除 ${pref.origin}`}
                  onClick={() => void clearPref(pref.envId, pref.origin)}
                >
                  <Icon name="Trash" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={cn(cardSurfaceClass, 'flex items-center justify-between gap-4')}>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">地址栏输入历史</span>
          <span className="text-xs text-muted-foreground">跨环境地址联想只保留最近 200 条非隐私记录。</span>
        </div>
        <Button size="sm" variant="outline" disabled={clearingHistory} onClick={() => void clearHistory()}>
          <Icon name="Trash" /> {clearingHistory ? '清理中…' : '清理全部历史'}
        </Button>
      </div>
    </div>
  );
}
