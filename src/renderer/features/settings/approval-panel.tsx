import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cardSurfaceClass } from '@/theme/surface';
import { cn } from '@/lib/utils';
import type { AppSettings, ApprovalMode, ControlPolicy, Environment, PluginPolicy } from '@shared/types';

/**
 * 设置里的「审批」一页。
 *
 * **这里是唯一能改审批策略的地方** —— RPC / CLI 只有读。
 * agent 能给自己放行的话，这道门就等于不存在。见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3.4。
 */
const CONTROL_LABELS: Record<ControlPolicy, string> = {
  ask: '要人点头（默认）',
  'agent-created': 'AI 建的环境自动放行',
  auto: '一律自动放行',
};

const PLUGIN_LABELS: Record<PluginPolicy, string> = {
  ask: '装插件时逐项批准（默认）',
  auto: '需要确认的能力自动批准',
};

const ENV_LABELS: Record<ApprovalMode, string> = {
  inherit: '跟随全局',
  ask: '总是要审批',
  auto: '自动放行',
};

const label = <T extends string>(map: Record<T, string>, value: string): string => map[value as T] ?? value;

export function ApprovalPanel({ environments }: { environments: Environment[] }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.envApi.settings().then((next) => {
      if (!cancelled) setSettings(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (patch: Partial<AppSettings>) => {
    try {
      setSettings(await window.envApi.setSettings(patch));
    } catch (error) {
      toast.error('保存审批策略失败', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const saveEnv = async (id: string, mode: ApprovalMode) => {
    try {
      // `inherit` 是「没有覆盖」，用 null 清掉这个字段
      await window.envApi.update(id, { approval: mode === 'inherit' ? null : mode });
    } catch (error) {
      toast.error('保存环境审批策略失败', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="flex max-w-2xl flex-col gap-4" data-slot="approval-panel">
      <p className="text-xs text-muted-foreground">
        控制权：agent 想操作页面时要先拿到该环境的写权限。默认人点过「接管控制权」之后，agent 会一直等到人交还。
      </p>

      <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">控制权</span>
          <Select
            value={settings?.controlPolicy ?? 'ask'}
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
            放行时 agent 会直接接管并记一条事件；人随时可以再点「接管控制权」抢回来。
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">插件能力确认</span>
          <Select
            value={settings?.pluginPolicy ?? 'ask'}
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
            「需要确认」那一层的能力（改代理、填表单、读网络等）。自动批准**不落库**：切回来立刻恢复拦截。
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium">每个环境的例外</span>
        <p className="text-[11px] text-muted-foreground">默认全部「跟随全局」。这里改的是例外。</p>
        {environments.map((env) => (
          <div
            key={env.id}
            data-slot="approval-env"
            data-env={env.id}
            className={cn(cardSurfaceClass, 'flex items-center gap-3')}
          >
            <span className="min-w-0 flex-1 truncate text-xs">
              {env.name}
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                {env.createdBy === 'agent' ? 'AI 创建' : '人创建'}
              </span>
            </span>
            <div className="w-40 shrink-0">
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
    </div>
  );
}
