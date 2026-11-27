import { useState } from 'react';
import { Icon } from '@/components/icons';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { formatLimitMb } from '@/lib/format';
import { cn } from '@/lib/utils';
import { cardSurfaceClass } from '@/theme/surface';
import type { AppSettings, LruEvictAction } from '@shared/types';

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

interface Props {
  settings: AppSettings;
  onSave: (patch: Partial<AppSettings>, notice?: string) => Promise<void>;
}

/** 内存策略预设与可折叠高级阈值：默认展示三档推荐预设，高级参数一键展开微调。 */
export function MemoryPolicyForm({ settings, onSave }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className={cn(cardSurfaceClass, 'flex flex-col gap-4')}>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">自动内存治理策略</span>
        <span className="text-xs text-muted-foreground">
          默认选择一档预设即可稳定运行；所有自动回收绝不中断当前查看、Agent 持权或已固定环境。
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
              onClick={() => void onSave(preset.patch, `已切换到「${preset.label}」策略`)}
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

      <div className="border-t border-border pt-2.5">
        <button
          type="button"
          data-slot="memory-advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((prev) => !prev)}
          className="flex w-full items-center justify-between rounded-[var(--control-radius)] px-1 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="flex items-center gap-1.5">
            <Icon name={advancedOpen ? 'ChevronDown' : 'ChevronRight'} className="size-3.5" />
            高级阈值与开关
          </span>
          <span className="font-mono text-[11px] text-subtle-foreground">
            软顶 {formatLimitMb(settings.memorySoftLimitMb ?? 6144)} · 并发 {settings.maxRunning ?? 8} · 闲置{' '}
            {settings.idleHibernateMinutes ?? 10}m
          </span>
        </button>

        {advancedOpen && (
          <div className="mt-3 flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">内存软水位上限（自动压力守卫）</span>
                <Select
                  value={String(settings.memorySoftLimitMb ?? 6144)}
                  onValueChange={(value) => void onSave({ memorySoftLimitMb: Number(value) })}
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
                  onValueChange={(value) => void onSave({ maxRunning: Number(value) })}
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
                <span className="text-[11px] text-muted-foreground">
                  同时运行的环境超过上限时按最久未使用顺序回收。
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">后台环境闲置休眠</span>
                <Select
                  value={String(settings.idleHibernateMinutes ?? 10)}
                  onValueChange={(value) => void onSave({ idleHibernateMinutes: Number(value) })}
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
                  休眠释放渲染进程并保留 Cookie、代理与标签，再次点击或 CLI 调用时秒级透明唤醒。
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">后台非激活标签自动休眠</span>
                <Select
                  value={String(settings.tabSleepMinutes ?? 20)}
                  onValueChange={(value) => void onSave({ tabSleepMinutes: Number(value) })}
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
                  onValueChange={(value) => void onSave({ lruEvictAction: value as LruEvictAction })}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(value) =>
                        value === 'stop' ? '直接停止环境' : '优先休眠（推荐：保留登录态与标签，点击透明唤醒）'
                      }
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
                  onCheckedChange={(checked) => void onSave({ lazyRestoreTabs: checked })}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">后台标签自动降频（Agent 持权期间自动豁免）</span>
                  <span className="text-[11px] text-muted-foreground">
                    对不可见页面启用 Chromium 后台节流以显著降低 CPU 与内存波动；切到前台或 Agent 持权时自动解除。
                  </span>
                </div>
                <Switch
                  aria-label="后台标签自动降频"
                  checked={settings.throttleBackgroundTabs ?? true}
                  onCheckedChange={(checked) => void onSave({ throttleBackgroundTabs: checked })}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
