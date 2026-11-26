import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { pluginActions, usePluginState } from '@/state/plugin-store';
import { cn } from '@/lib/utils';
import { cardSurfaceClass } from '@/theme/surface';
import type { ThemePreference } from '@shared/types';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; hint: string }> = [
  { value: 'dark', label: '深色', hint: '低对比深灰工作台（默认）' },
  { value: 'light', label: '浅色', hint: '高明亮日间配色' },
  { value: 'system', label: '跟随系统', hint: '随 macOS 外观自动切换' },
];

export function GeneralPanel() {
  const { settings } = usePluginState();
  const [dataDir, setDataDir] = useState<string>('');
  const [savingKey, setSavingKey] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void window.envApi
      .systemDoctor()
      .then((report) => {
        if (!cancelled) setDataDir(report.dataDir);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = async (key: string, next: Parameters<typeof pluginActions.updateSettings>[0]) => {
    setSavingKey(key);
    try {
      await pluginActions.updateSettings(next);
    } catch (error) {
      toast.error('保存设置失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSavingKey(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">界面主题</span>
          <span className="text-xs text-muted-foreground">主工作台、浮层对话框与悬浮窗卡片同步生效。</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((option) => {
            const active = (settings.theme ?? 'dark') === option.value;
            return (
              <button
                key={option.value}
                type="button"
                data-slot={`theme-option-${option.value}`}
                aria-pressed={active}
                disabled={savingKey === 'theme'}
                onClick={() => void patch('theme', { theme: option.value })}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors',
                  active
                    ? 'border-ring bg-surface-active text-foreground'
                    : 'border-border bg-background/50 text-muted-foreground hover:bg-surface-hover hover:text-foreground',
                )}
              >
                <span className="text-xs font-medium">{option.label}</span>
                <span className="text-[11px] opacity-75">{option.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={cn(cardSurfaceClass, 'flex flex-col gap-4')}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">紧凑顶栏密度</span>
            <span className="text-xs text-muted-foreground">压低标签栏与地址栏高度，为网页画布留出更大纵向视口。</span>
          </div>
          <Switch
            aria-label="紧凑顶栏密度"
            checked={Boolean(settings.compactTopbar)}
            disabled={savingKey === 'compactTopbar'}
            onCheckedChange={(checked) => void patch('compactTopbar', { compactTopbar: checked })}
          />
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">网页与 DevTools 视图圆角</span>
            <span className="text-xs text-muted-foreground">
              为原生 `WebContentsView` 应用 8px 圆角裁切，与外框卡片融为一体。
            </span>
          </div>
          <Switch
            aria-label="网页与 DevTools 视图圆角"
            checked={settings.pageBorderRadius ?? true}
            disabled={savingKey === 'pageBorderRadius'}
            onCheckedChange={(checked) => void patch('pageBorderRadius', { pageBorderRadius: checked })}
          />
        </div>
      </div>

      <div className={cn(cardSurfaceClass, 'flex items-center justify-between gap-4')}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">数据根目录（WARREN_HOME）</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{dataDir || '~/.warren'}</span>
          <span className="text-[11px] text-muted-foreground">
            包含环境 Session、SQLite 数据库、Vault 密文与插件目录。
          </span>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => void window.envApi.openDataDir()}>
          <Icon name="FolderOpen" /> 打开目录
        </Button>
      </div>
    </div>
  );
}
