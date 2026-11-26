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
  { value: 'dark', label: '深色', hint: '微冷深炭工作台（默认）' },
  { value: 'light', label: '浅色', hint: '冷银白高对比日间配色' },
  { value: 'system', label: '跟随系统', hint: '随 macOS 外观自动切换' },
];

function ThemePreviewThumb({ mode }: { mode: ThemePreference }) {
  if (mode === 'system') {
    return (
      <span
        aria-hidden
        className="mb-1.5 flex h-8 w-14 overflow-hidden rounded-[6px] border border-border-heavy shadow-2xs"
      >
        <span className="flex flex-1 flex-col bg-[#181b21] p-1">
          <span className="h-1 w-4 rounded-full bg-[#5b8cff]" />
          <span className="mt-1 flex-1 rounded-[2px] bg-[#20242d]" />
        </span>
        <span className="flex flex-1 flex-col bg-[#e9edf3] p-1">
          <span className="h-1 w-4 rounded-full bg-[#3b5bdb]" />
          <span className="mt-1 flex-1 rounded-[2px] bg-[#ffffff]" />
        </span>
      </span>
    );
  }
  const dark = mode === 'dark';
  return (
    <span
      aria-hidden
      className={cn(
        'mb-1.5 flex h-8 w-14 overflow-hidden rounded-[6px] border border-border-heavy p-1 shadow-2xs',
        dark ? 'bg-[#111317]' : 'bg-[#e9edf3]',
      )}
    >
      <span className={cn('mr-1 w-3 rounded-[2px]', dark ? 'bg-[#181b21]' : 'bg-[#f4f6fa]')} />
      <span className="flex flex-1 flex-col gap-1">
        <span className={cn('h-1.5 w-5 rounded-full', dark ? 'bg-[#5b8cff]' : 'bg-[#3b5bdb]')} />
        <span className={cn('flex-1 rounded-[2px]', dark ? 'bg-[#20242d]' : 'bg-[#ffffff]')} />
      </span>
    </span>
  );
}

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
        <div className="grid grid-cols-3 gap-2.5">
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
                  'flex flex-col items-start gap-0.5 rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition-all outline-none focus-visible:border-focus',
                  active
                    ? 'border-[var(--theme-accent)] bg-surface-selected text-foreground [box-shadow:var(--shadow-raised)]'
                    : 'border-border bg-background/60 text-foreground hover:bg-surface-hover',
                )}
              >
                <ThemePreviewThumb mode={option.value} />
                <span className="text-xs font-medium">{option.label}</span>
                <span className="text-[length:var(--font-size-micro)] text-muted-foreground">{option.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={cn(cardSurfaceClass, 'flex flex-col gap-4')}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">紧凑顶栏密度</span>
            <span className="text-xs text-muted-foreground">降低顶栏高度，增大网页可视区。</span>
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
            <span className="text-xs text-muted-foreground">为网页与开发者工具应用 8px 圆角裁切。</span>
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
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">数据根目录（WARREN_HOME）</span>
          <span className="truncate font-mono text-sm font-medium text-foreground">{dataDir || '~/.warren'}</span>
          <span className="text-[length:var(--font-size-micro)] text-muted-foreground">
            保存隔离环境 Session、SQLite、Vault 密文与插件。
          </span>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => void window.envApi.openDataDir()}>
          <Icon name="FolderOpen" /> 打开目录
        </Button>
      </div>
    </div>
  );
}
