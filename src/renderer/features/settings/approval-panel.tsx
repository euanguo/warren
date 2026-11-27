import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { pluginActions, usePluginState } from '@/state/plugin-store';
import { cardSurfaceClass } from '@/theme/surface';
import { cn } from '@/lib/utils';
import type { AppSettings, ApprovalMode, ControlPolicy, Environment, PluginPolicy } from '@shared/types';

const CONTROL_LABELS: Record<ControlPolicy, string> = {
  ask: '保护人工接管，交还前拒绝 AI 抢回（默认）',
  'agent-created': 'AI 建的环境允许自动恢复控制',
  auto: '允许 AI 随时自动恢复控制',
};

const PLUGIN_LABELS: Record<PluginPolicy, string> = {
  ask: '装插件时逐项批准（默认）',
  auto: '需要确认的能力自动批准',
};

const ENV_LABELS: Record<ApprovalMode, string> = {
  inherit: '跟随全局',
  ask: '保护人工接管',
  auto: '允许 AI 自动恢复',
};

const LEASE_TTL_LABELS: Record<string, string> = {
  '30000': '30 秒（短脚本）',
  '60000': '60 秒（默认）',
  '180000': '3 分钟',
  '300000': '5 分钟',
  '600000': '10 分钟（上限）',
};

const label = <T extends string>(map: Record<T, string>, value: string): string => map[value as T] ?? value;

/**
 * 控制权、租约时长与插件审批策略。**只有界面 IPC 可写**，RPC 侧只读。
 */
export function ApprovalPanel({ environments }: { environments: Environment[] }) {
  const { settings } = usePluginState();

  const save = async (patch: Partial<AppSettings>) => {
    try {
      await pluginActions.updateSettings(patch);
      toast.success('审批与控制策略已更新');
    } catch (error) {
      toast.error('保存策略失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const saveEnv = async (id: string, mode: ApprovalMode) => {
    try {
      await window.envApi.update(id, { approval: mode === 'inherit' ? null : mode });
    } catch (error) {
      toast.error('保存环境审批覆盖失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className={cn(cardSurfaceClass, 'flex flex-col gap-4')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">人工接管保护策略</span>
            <Select
              value={settings.controlPolicy}
              onValueChange={(value) => void save({ controlPolicy: value as ControlPolicy })}
            >
              <SelectTrigger data-slot="approval-control">
                <SelectValue>{(value) => label(CONTROL_LABELS, String(value))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CONTROL_LABELS) as ControlPolicy[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {CONTROL_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              Agent 空间空闲时人工可直接操作；仅在人工点「接管 / 暂停 AI」后，按此策略决定 AI 能否抢回控制权。
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">插件能力确认</span>
            <Select
              value={settings.pluginPolicy}
              onValueChange={(value) => void save({ pluginPolicy: value as PluginPolicy })}
            >
              <SelectTrigger data-slot="approval-plugin">
                <SelectValue>{(value) => label(PLUGIN_LABELS, String(value))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PLUGIN_LABELS) as PluginPolicy[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {PLUGIN_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              只管 confirm 层能力（写入/代理/导航/事件订阅）；denied 能力永远不可开启。
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 border-t border-border pt-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Agent Lease 默认租约时长</span>
            <Select
              value={String(settings.leaseTtlMs ?? 60_000)}
              onValueChange={(value) => void save({ leaseTtlMs: Number(value) })}
            >
              <SelectTrigger>
                <SelectValue>{(value) => LEASE_TTL_LABELS[String(value)] ?? `${String(value)} ms`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.keys(LEASE_TTL_LABELS).map((key) => (
                  <SelectItem key={key} value={key}>
                    {LEASE_TTL_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">单次持权默认到期时长（长任务会自动续租）。</span>
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium">底部控制权胶囊与「接管」按钮</span>
              <span className="text-[11px] text-muted-foreground">
                Agent 控制中在页面底部悬浮显示当前调用方与一键接管按钮。
              </span>
            </div>
            <Switch
              aria-label="底部控制权胶囊"
              checked={settings.showControlPill ?? true}
              onCheckedChange={(checked) => void save({ showControlPill: checked })}
            />
          </div>
        </div>
      </div>

      <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">环境级控制权例外覆盖（{environments.length}）</span>
          <span className="text-xs text-muted-foreground">优先级高于全局策略，适合对测试账号环境设为自动放行。</span>
        </div>
        {environments.length === 0 ? (
          <p className="text-xs text-muted-foreground">还没有环境。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {environments.map((env) => (
              <div
                key={env.id}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-border px-3 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-xs">
                  {env.name}{' '}
                  <span className="text-muted-foreground">· {env.createdBy === 'agent' ? 'AI 创建' : '人创建'}</span>
                </span>
                <div className="w-36 shrink-0">
                  <Select
                    value={env.approval ?? 'inherit'}
                    onValueChange={(value) => void saveEnv(env.id, value as ApprovalMode)}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue>{(value) => label(ENV_LABELS, String(value))}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ENV_LABELS) as ApprovalMode[]).map((key) => (
                        <SelectItem key={key} value={key}>
                          {ENV_LABELS[key]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
