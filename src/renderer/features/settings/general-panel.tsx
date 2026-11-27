import { useEffect, useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
} from '@/components/ui/item-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useResolvedTheme } from '@/lib/theme';
import { pluginActions, usePluginState } from '@/state/plugin-store';
import {
  BUILTIN_SKINS,
  DEFAULT_SKIN_ID,
  SKIN_COLOR_META,
  hasSkinOverrides,
  resolveSkinDefinition,
  resolveSkinPalette,
  validateSkinOverridesInput,
  type SkinColorKey,
  type SkinColorOverrides,
  type SkinColorPalette,
} from '@shared/skin';
import type { ThemePreference } from '@shared/types';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; hint: string }> = [
  { value: 'dark', label: '深色', hint: '低噪中性暗色工作台（默认）' },
  { value: 'light', label: '浅色', hint: '柔白清爽日间配色' },
  { value: 'system', label: '跟随系统', hint: '随系统深浅外观自动切换' },
];

function MiniSkinCanvas({ palette }: { palette: SkinColorPalette }) {
  return (
    <span className="flex flex-1 gap-1 p-1.5" style={{ backgroundColor: palette.frame }}>
      <span
        className="flex flex-1 gap-1 overflow-hidden rounded-[4px] border p-1"
        style={{ backgroundColor: palette.canvas, borderColor: `${palette.border}66` }}
      >
        <span className="flex w-5 flex-col gap-1 rounded-[2px] p-0.5" style={{ backgroundColor: palette.sidebar }}>
          <span
            className="block h-1 w-full rounded-full"
            style={{ backgroundColor: palette.textMuted, opacity: 0.6 }}
          />
          <span
            className="block h-1 w-2/3 rounded-full"
            style={{ backgroundColor: palette.textMuted, opacity: 0.35 }}
          />
        </span>
        <span className="flex flex-1 flex-col gap-1">
          <span className="h-1.5 w-7 rounded-full" style={{ backgroundColor: palette.accent }} />
          <span
            className="flex-1 rounded-[3px] border"
            style={{ backgroundColor: palette.surface, borderColor: `${palette.border}55` }}
          />
        </span>
      </span>
    </span>
  );
}

function ThemePreviewThumb({
  mode,
  darkPalette,
  lightPalette,
}: {
  mode: ThemePreference;
  darkPalette: SkinColorPalette;
  lightPalette: SkinColorPalette;
}) {
  if (mode === 'system') {
    return (
      <span
        aria-hidden
        className="flex aspect-[1.65] w-full overflow-hidden rounded-[var(--radius-lg)] border border-border-grouped bg-sheet transition-transform duration-120 ease-out group-active/choice:scale-[0.97]"
      >
        <MiniSkinCanvas palette={darkPalette} />
        <span className="w-px shrink-0 bg-border-grouped" />
        <MiniSkinCanvas palette={lightPalette} />
      </span>
    );
  }
  const palette = mode === 'dark' ? darkPalette : lightPalette;
  return (
    <span
      aria-hidden
      className="flex aspect-[1.65] w-full overflow-hidden rounded-[var(--radius-lg)] border border-border-grouped bg-sheet transition-transform duration-120 ease-out group-active/choice:scale-[0.97]"
    >
      <MiniSkinCanvas palette={palette} />
    </span>
  );
}

/** OpenBot 原版 `SettingsPictureChoice` 圆形单选指示器（20px：选中为强调色实心圆勾，未选为空心圆环）。 */
function ChoiceRadioDot({ checked }: { checked: boolean }) {
  return checked ? (
    <span
      data-slot="choice-radio"
      data-checked="true"
      aria-hidden="true"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-seed text-on-accent"
    >
      <Icon name="Check" className="size-3 stroke-[2.75]" />
    </span>
  ) : (
    <span
      data-slot="choice-radio"
      aria-hidden="true"
      className="inline-flex size-5 shrink-0 rounded-full border-[1.5px] border-muted-foreground/45 transition-colors group-hover/choice:border-foreground/55"
    />
  );
}

export function GeneralPanel() {
  const { settings } = usePluginState();
  const resolvedScheme = useResolvedTheme();
  const [dataDir, setDataDir] = useState<string>('');
  const [savingKey, setSavingKey] = useState<string>();
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [jsonDraft, setJsonDraft] = useState('');

  const activeSkinId = settings.skin ?? DEFAULT_SKIN_ID;
  const activeSkinDef = resolveSkinDefinition(activeSkinId);
  const darkPalette = resolveSkinPalette(activeSkinId, 'dark', settings.skinOverrides);
  const lightPalette = resolveSkinPalette(activeSkinId, 'light', settings.skinOverrides);
  const currentPalette = resolvedScheme === 'light' ? lightPalette : darkPalette;
  const customized = hasSkinOverrides(settings.skinOverrides);

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

  const patch = async (
    key: string,
    next: Parameters<typeof pluginActions.updateSettings>[0],
    originEvent?: MouseEvent<HTMLElement>,
  ) => {
    setSavingKey(key);
    const origin = originEvent ? { x: originEvent.clientX, y: originEvent.clientY } : undefined;
    try {
      await pluginActions.updateSettings(next, origin ? { animate: true, origin } : undefined);
    } catch (error) {
      toast.error('保存设置失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSavingKey(undefined);
    }
  };

  const updateSingleColor = (colorKey: SkinColorKey, hex: string) => {
    const nextOverrides: SkinColorOverrides = {
      ...settings.skinOverrides,
      [resolvedScheme]: {
        ...settings.skinOverrides?.[resolvedScheme],
        [colorKey]: hex.toLowerCase(),
      },
    };
    void patch(`skin-color-${colorKey}`, { skinOverrides: nextOverrides });
  };

  const resetSkinOverrides = (event: MouseEvent<HTMLButtonElement>) => {
    void patch('skinOverrides', { skinOverrides: {} }, event).then(() => {
      setJsonDraft('');
      toast.success('已恢复当前皮肤默认色板');
    });
  };

  const exportCurrentPaletteJson = () => {
    const payload = JSON.stringify({ dark: darkPalette, light: lightPalette }, null, 2);
    void navigator.clipboard?.writeText(payload);
    setJsonDraft(payload);
    toast.success('已复制当前 12 色皮肤配置到剪贴板');
  };

  const applyJsonOverrides = () => {
    const checked = validateSkinOverridesInput(jsonDraft);
    if (!checked.ok) {
      toast.error('皮肤配置校验失败', { description: checked.error });
      return;
    }
    void patch('skinOverrides', { skinOverrides: checked.overrides }).then(() => {
      if (checked.ignoredKeys.length > 0) {
        toast.warning('已应用合法配色，非配色字段已拦截', {
          description: `皮肤仅允许改色板，已忽略：${checked.ignoredKeys.slice(0, 4).join(', ')}`,
        });
      } else {
        toast.success('已应用自定义配色');
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="外观模式" description="深浅模式将在主工作台、浮层对话框与悬浮窗卡片间实时同步。">
        <ItemGroup>
          <div role="radiogroup" aria-label="外观模式" className="grid grid-cols-3 gap-4 px-4 pt-4 pb-3.5">
            {THEME_OPTIONS.map((option) => {
              const active = (settings.theme ?? 'dark') === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  data-slot={`theme-option-${option.value}`}
                  disabled={savingKey === 'theme'}
                  onClick={(event) => void patch('theme', { theme: option.value }, event)}
                  className="group/choice flex cursor-pointer flex-col items-center gap-2 rounded-[var(--radius-md)] outline-none focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-[0.42]"
                >
                  <ThemePreviewThumb mode={option.value} darkPalette={darkPalette} lightPalette={lightPalette} />
                  <span className="text-[13px] leading-[18px] font-medium text-foreground">{option.label}</span>
                  <ChoiceRadioDot checked={active} />
                </button>
              );
            })}
          </div>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection
        title={
          <span className="inline-flex items-center gap-2">
            <span>配色皮肤</span>
            <Badge variant="outline">仅色板可配 · 结构规范锁定</Badge>
          </span>
        }
        description="皮肤层独立可抽离，仅替换 12 色色板；控件尺寸、圆角、字号与动效均由基础 Token 统一锁定。"
        actions={
          customized ? (
            <Button size="xs" variant="ghost" onClick={resetSkinOverrides}>
              恢复默认色板
            </Button>
          ) : null
        }
      >
        <ItemGroup>
          <div
            role="radiogroup"
            aria-label="配色皮肤"
            data-slot="skin-picker"
            className="grid grid-cols-2 gap-3.5 px-4 pt-4 pb-3.5 sm:grid-cols-4"
          >
            {BUILTIN_SKINS.map((skin) => {
              const active = activeSkinId === skin.id;
              const preview = skin[resolvedScheme];
              return (
                <button
                  key={skin.id}
                  type="button"
                  aria-pressed={active}
                  title={skin.description}
                  data-slot={`skin-option-${skin.id}`}
                  disabled={savingKey === 'skin'}
                  onClick={(event) => void patch('skin', { skin: skin.id, skinOverrides: {} }, event)}
                  className="group/choice flex cursor-pointer flex-col items-center gap-2 rounded-[var(--radius-md)] outline-none focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-[0.42]"
                >
                  <span
                    aria-hidden
                    className="flex aspect-[1.65] w-full flex-col justify-between overflow-hidden rounded-[var(--radius-md)] border border-border-grouped p-1.5 transition-transform duration-120 ease-out group-active/choice:scale-[0.97]"
                    style={{ backgroundColor: preview.frame }}
                  >
                    <span
                      className="flex flex-1 gap-1 overflow-hidden rounded-[4px] border p-1"
                      style={{ backgroundColor: preview.canvas, borderColor: `${preview.border}66` }}
                    >
                      <span
                        className="flex w-4 flex-col gap-1 rounded-[2px] p-0.5"
                        style={{ backgroundColor: preview.sidebar }}
                      >
                        <span
                          className="block h-1 w-full rounded-full"
                          style={{ backgroundColor: preview.textMuted, opacity: 0.65 }}
                        />
                        <span
                          className="block h-1 w-2/3 rounded-full"
                          style={{ backgroundColor: preview.textMuted, opacity: 0.35 }}
                        />
                      </span>
                      <span className="flex flex-1 flex-col gap-1">
                        <span className="h-1.5 w-6 rounded-full" style={{ backgroundColor: preview.accent }} />
                        <span
                          className="flex-1 rounded-[3px] border"
                          style={{ backgroundColor: preview.surface, borderColor: `${preview.border}55` }}
                        />
                      </span>
                    </span>
                    <span className="mt-1 flex w-full items-center gap-1">
                      {[preview.frame, preview.canvas, preview.surface, preview.accent, preview.text].map((hex, i) => (
                        <span
                          key={i}
                          className="h-2 flex-1 rounded-[2px] border border-border-strong"
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </span>
                  </span>
                  <span className="text-[13px] leading-[18px] font-medium text-foreground">{skin.name}</span>
                  <ChoiceRadioDot checked={active} />
                </button>
              );
            })}
          </div>

          <Collapsible open={customizerOpen} onOpenChange={setCustomizerOpen}>
            <Item size="compact">
              <ItemContent>
                <ItemTitle>
                  <Icon name="Palette" className="size-3.5 text-muted-foreground" />
                  <span>
                    自定义色板微调（当前：{activeSkinDef.name} · {resolvedScheme === 'dark' ? '深色' : '浅色'}）
                  </span>
                  {customized && <Badge variant="primary-light">已微调</Badge>}
                </ItemTitle>
                <ItemDescription>直接调整单个色值或导入纯色板 JSON，自动拦截任何非颜色 Token。</ItemDescription>
              </ItemContent>
              <ItemActions>
                <CollapsibleTrigger render={<Button size="xs" variant="outline" data-slot="skin-customizer-toggle" />}>
                  {customizerOpen ? '收起色板' : '配置色板'}
                </CollapsibleTrigger>
              </ItemActions>
            </Item>

            <CollapsibleContent>
              <div className="flex flex-col gap-3.5 bg-canvas/50 p-3.5">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {SKIN_COLOR_META.map((field) => {
                    const value = currentPalette[field.key];
                    return (
                      <label
                        key={field.key}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border bg-grouped px-2.5 py-2 hover:bg-surface-hover"
                        title={field.description}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-[12px] font-medium text-foreground">{field.label}</span>
                          <span className="font-mono text-[10px] uppercase text-muted-foreground">{value}</span>
                        </span>
                        <input
                          type="color"
                          aria-label={`${field.label}色值`}
                          value={value}
                          onChange={(event) => updateSingleColor(field.key, event.target.value)}
                          className="h-6 w-7 shrink-0 cursor-pointer rounded-[4px] border border-border-strong bg-transparent p-0"
                        />
                      </label>
                    );
                  })}
                </div>

                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-foreground">配色 JSON 导入 / 导出</span>
                    <div className="flex items-center gap-1.5">
                      <Button size="xs" variant="ghost" onClick={exportCurrentPaletteJson}>
                        <Icon name="Copy" className="size-3.5" /> 复制当前色板
                      </Button>
                      <Button size="xs" variant="outline" disabled={!jsonDraft.trim()} onClick={applyJsonOverrides}>
                        应用 JSON
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    value={jsonDraft}
                    onChange={(event) => setJsonDraft(event.target.value)}
                    placeholder='{"dark": {"accent": "#22c55e"}, "light": {"accent": "#16a34a"}}'
                    rows={3}
                    className="resize-none font-mono text-[11px]"
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection title="工作台密度与视图">
        <ItemGroup>
          <Item>
            <ItemContent>
              <ItemTitle>紧凑顶栏密度</ItemTitle>
              <ItemDescription>降低顶栏与地址栏高度至 34px，为网页留出更多纵向可视区。</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="紧凑顶栏密度"
                checked={Boolean(settings.compactTopbar)}
                disabled={savingKey === 'compactTopbar'}
                onCheckedChange={(checked) => void patch('compactTopbar', { compactTopbar: checked })}
              />
            </ItemActions>
          </Item>

          <Item>
            <ItemContent>
              <ItemTitle>网页与 DevTools 视图圆角</ItemTitle>
              <ItemDescription>为原生网页与开发者工具应用 8px 圆角裁切，与主卡片边缘和谐贴合。</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="网页与 DevTools 视图圆角"
                checked={settings.pageBorderRadius ?? true}
                disabled={savingKey === 'pageBorderRadius'}
                onCheckedChange={(checked) => void patch('pageBorderRadius', { pageBorderRadius: checked })}
              />
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection title="本地数据目录">
        <ItemGroup>
          <Item>
            <ItemContent>
              <ItemTitle>数据根目录（WARREN_HOME）</ItemTitle>
              <ItemDescription className="truncate font-mono text-foreground/90">
                {dataDir || '~/.warren'}
              </ItemDescription>
              <ItemDescription>保存隔离环境 Session、SQLite 与插件数据。</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button size="sm" variant="outline" onClick={() => void window.envApi.openDataDir()}>
                <Icon name="FolderOpen" /> 打开目录
              </Button>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsSection>
    </div>
  );
}
