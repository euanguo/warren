import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { PluginBrandGlyph } from '@/components/identity-glyphs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { cardSurfaceClass } from '@/theme/surface';
import { PERMISSION_TIERS } from '@shared/permissions';
import type { InstalledPlugin, PluginLogEntry, PluginSettingValue, PluginSkillDocument } from '@shared/types';

const PLUGIN_OPTION_LABELS: Record<string, string> = {
  all: '全部',
  local: '仅本地',
  remote: '仅远程',
};

function formatOptionLabel(option: string): string {
  return PLUGIN_OPTION_LABELS[option] ?? option;
}

function tierBadge(permission: string, needsConfirm = true) {
  const tier = PERMISSION_TIERS[permission] ?? 'denied';
  if (tier === 'granted') return <Badge variant="secondary">{permission}</Badge>;
  if (tier === 'confirm') {
    if (!needsConfirm) {
      return <Badge variant="secondary">{permission} · 已确认</Badge>;
    }
    return (
      <Badge variant="outline" className="border-[var(--warning)]/50 text-[var(--warning)]">
        {permission} · 确认
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-destructive/50 text-destructive">
      {permission} · 禁止
    </Badge>
  );
}

const STATUS_LABEL: Record<InstalledPlugin['status'], string> = {
  running: '运行中',
  starting: '启动中',
  disabled: '已停用',
  error: '出错',
  'needs-configuration': '待配置',
};

const RUNTIME_HINT: Record<InstalledPlugin['runtime'], string> = {
  sandbox: '受限 VM 子进程：可超时强杀并拦截越权 API 调用，不是 OS 安全沙箱',
  host: '独立 Node 宿主进程：拥有完整的 Node 能力（读写文件、起子进程）',
};

function statusTone(status: InstalledPlugin['status']): string {
  if (status === 'running') return 'border-[var(--success)]/50 text-[var(--success)]';
  if (status === 'starting') return 'border-[var(--warning)]/50 text-[var(--warning)]';
  if (status === 'error') return 'border-destructive/50 text-destructive';
  if (status === 'needs-configuration') return 'border-[var(--warning)]/50 text-[var(--warning)]';
  return 'text-muted-foreground';
}

/** 一个设置项的编辑行。secret 只显示「已配置 / 未配置」，值永远不回渲染层。 */
function SettingField({
  plugin,
  setting,
  onSaved,
}: {
  plugin: InstalledPlugin;
  setting: PluginSettingValue;
  onSaved: () => void;
}) {
  const isSecret = setting.type === 'secret';
  const [draft, setDraft] = useState(isSecret ? '' : String(setting.value ?? ''));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await window.envApi.pluginConfigSet(plugin.id, setting.key, draft);
      if (isSecret) setDraft('');
      toast.success(`已保存 ${setting.label}`);
      onSaved();
    } catch (error) {
      toast.error('保存失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground" title={setting.description}>
        {setting.label}
      </span>

      {setting.options ? (
        <Select
          value={String(setting.value ?? '')}
          onValueChange={(value) => {
            if (!value) return;
            void window.envApi.pluginConfigSet(plugin.id, setting.key, value).then(onSaved);
          }}
        >
          <SelectTrigger className="flex-1 text-xs" aria-label={setting.label}>
            <SelectValue>{(value) => formatOptionLabel(String(value ?? ''))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {setting.options.map((option) => (
              <SelectItem key={option} value={option}>
                {formatOptionLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          type={isSecret ? 'password' : 'text'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={isSecret ? (setting.configured ? '已配置（输入以覆盖）' : '未配置') : ''}
          className="flex-1 text-xs"
        />
      )}

      {!setting.options && (
        <Button size="sm" variant="ghost" disabled={busy || (!draft && isSecret)} onClick={() => void save()}>
          保存
        </Button>
      )}
    </div>
  );
}

export function PluginCard({ plugin, onChanged }: { plugin: InstalledPlugin; onChanged: () => void }) {
  const [logs, setLogs] = useState<PluginLogEntry[] | undefined>();
  const [logFilter, setLogFilter] = useState('');
  const [skillDoc, setSkillDoc] = useState<PluginSkillDocument | null>(null);
  const [skillOpen, setSkillOpen] = useState(false);

  const act = async (action: () => Promise<unknown>, failure: string) => {
    try {
      await action();
      onChanged();
    } catch (error) {
      toast.error(failure, {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const surfaces = Array.from(new Set(plugin.contributes.surfaces.map((surface) => surface.title)));
  const filteredLogs = useMemo(() => {
    if (!logs) return [];
    const q = logFilter.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((entry) => entry.message.toLowerCase().includes(q) || entry.level.toLowerCase().includes(q));
  }, [logs, logFilter]);

  return (
    <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')} data-plugin={plugin.id}>
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <PluginBrandGlyph pluginId={plugin.id} icon={plugin.icon} variant="chip" className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium">{plugin.name}</span>
              <span className="text-[length:var(--font-size-micro)] text-muted-foreground">v{plugin.version}</span>
              {/* 不写「沙箱」以免暗示 OS 安全沙箱，只描述真实进程模型（见 AGENTS 硬约束 1）。 */}
              <Badge variant="outline" title={RUNTIME_HINT[plugin.runtime]}>
                {plugin.runtime === 'host' ? 'Node 宿主进程' : '受限 VM 进程'}
              </Badge>
              <Badge variant="outline" className={statusTone(plugin.status)}>
                {STATUS_LABEL[plugin.status]}
              </Badge>
              {plugin.skill && (
                <Badge
                  variant="outline"
                  title={plugin.skill.hasExplicitSkill ? '插件自带 SKILL.md' : '由命令清单自动生成的 Skill 摘要'}
                >
                  {plugin.skill.hasExplicitSkill ? '自带 Skill' : '自动 Skill'}
                </Badge>
              )}
            </div>
            {plugin.description && <p className="mt-1 text-xs text-muted-foreground">{plugin.description}</p>}
            {plugin.statusDetail && (
              <p className="mt-1 text-[length:var(--font-size-micro)] text-destructive">{plugin.statusDetail}</p>
            )}
            {surfaces.length > 0 && (
              <p className="mt-1 text-[length:var(--font-size-micro)] text-muted-foreground">
                挂载界面：{surfaces.join('、')}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {plugin.enabled ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act(() => window.envApi.pluginDisable(plugin.id), '停用失败')}
            >
              停用
            </Button>
          ) : (
            <Button size="sm" onClick={() => void act(() => window.envApi.pluginEnable(plugin.id), '启用失败')}>
              启用
            </Button>
          )}
          <IconButton
            title="重载插件"
            aria-label="重载插件"
            onClick={() => void act(() => window.envApi.pluginReload(plugin.id), '重载失败')}
          >
            <Icon name="Refresh" />
          </IconButton>
          <IconButton
            title={logs ? '收起日志' : '查看日志'}
            aria-label="查看日志"
            onClick={() => {
              if (logs) {
                setLogs(undefined);
                setLogFilter('');
                return;
              }
              void window.envApi.pluginLogs(plugin.id, 100).then(setLogs);
            }}
          >
            <Icon name="Code" />
          </IconButton>
          <IconButton
            title="卸载插件"
            aria-label={`卸载插件 ${plugin.name}`}
            onClick={() =>
              void (async () => {
                const confirmed = await window.envApi.openOverlay<boolean>({
                  kind: 'confirm',
                  title: `卸载插件「${plugin.name}」`,
                  description: '将停用并移除插件包文件（插件独立数据目录保留，重新安装可恢复）。确定继续吗？',
                  confirmLabel: '卸载',
                  destructive: true,
                });
                if (!confirmed) return;
                await act(async () => {
                  await window.envApi.pluginUninstall(plugin.id);
                  toast.success(`已卸载插件「${plugin.name}」`);
                }, '卸载插件失败');
              })()
            }
          >
            <Icon name="Trash" />
          </IconButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {plugin.permissions.map((permission) => (
          <span key={permission}>{tierBadge(permission, plugin.needsConfirmation.includes(permission))}</span>
        ))}
      </div>

      {plugin.skill && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border/70 px-2.5 py-1.5 text-xs">
          <div className="min-w-0 flex-1">
            <span className="font-medium text-foreground">Agent Skill 注入</span>
            <p className="truncate text-[11px] text-muted-foreground">{plugin.skill.summary}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void window.envApi
                  .pluginReadSkill(plugin.id)
                  .then((doc) => {
                    setSkillDoc(doc);
                    setSkillOpen(true);
                  })
                  .catch((error) => {
                    toast.error('读取 Skill 失败', {
                      description: error instanceof Error ? error.message : String(error),
                    });
                  });
              }}
            >
              <Icon name="Code" className="size-3.5" />
              预览 Skill
            </Button>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground select-none">
              <span>{plugin.skillExposed ? '已注入' : '未注入'}</span>
              <Switch
                aria-label={`向 Agent 暴露 ${plugin.name} Skill`}
                checked={plugin.skillExposed}
                onCheckedChange={(checked) =>
                  void act(() => window.envApi.pluginSetSkillExposed(plugin.id, checked), '更新 Skill 暴露设置失败')
                }
              />
            </label>
          </div>
        </div>
      )}

      <Dialog open={skillOpen} onOpenChange={setSkillOpen}>
        <DialogContent className="flex max-h-[84vh] flex-col gap-3 overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{skillDoc?.pluginName ?? plugin.name} · Agent Skill 预览</DialogTitle>
            <DialogDescription>
              {skillDoc?.hasExplicitSkill
                ? `来自插件包内 ${skillDoc.entry ?? 'SKILL.md'}（${skillDoc.bytes} 字节）。开启下方开关后，Warren 会在同步和输出 --skill 时自动注入此手册。`
                : '该插件未提供显式 SKILL.md，当前为宿主按命令清单生成的兜底摘要。'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border/70 bg-muted/20 px-3 py-2 text-xs">
            <label className="flex cursor-pointer items-center gap-2 text-foreground select-none">
              <Switch
                aria-label={`向外部编码 Agent 注入 ${plugin.name} Skill`}
                checked={plugin.skillExposed}
                onCheckedChange={(checked) =>
                  void act(() => window.envApi.pluginSetSkillExposed(plugin.id, checked), '更新 Skill 暴露设置失败')
                }
              />
              <span>{plugin.skillExposed ? '已向外部编码 Agent 注入此 Skill' : '当前已暂停向外部编码 Agent 注入'}</span>
            </label>
            <Button
              size="xs"
              variant="outline"
              disabled={!skillDoc?.markdown}
              onClick={() => {
                void navigator.clipboard
                  .writeText(skillDoc?.markdown ?? '')
                  .then(() => toast.success('已复制 Skill 全文'))
                  .catch(() => toast.error('复制失败'));
              }}
            >
              <Icon name="Copy" className="size-3.5" />
              复制全文
            </Button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-border bg-muted/30 p-3.5 font-mono text-[11px] leading-relaxed">
            {skillDoc?.markdown ?? ''}
          </pre>
        </DialogContent>
      </Dialog>

      {plugin.needsConfirmation.length > 0 && (
        <Alert>
          <AlertTitle>需要确认 {plugin.needsConfirmation.length} 项能力</AlertTitle>
          <AlertDescription>
            <div className="flex flex-wrap items-center gap-1">
              {plugin.needsConfirmation.map((permission) => (
                <span key={permission}>{tierBadge(permission)}</span>
              ))}
              <Button
                size="sm"
                className="ml-2"
                onClick={() =>
                  void act(() => window.envApi.pluginGrant(plugin.id, plugin.needsConfirmation), '授权失败')
                }
              >
                全部批准
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {plugin.settings.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          {plugin.settings.map((setting) => (
            <SettingField key={setting.key} plugin={plugin} setting={setting} onSaved={onChanged} />
          ))}
        </div>
      )}

      {logs && (
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          <div className="flex items-center gap-2">
            <Input
              value={logFilter}
              onChange={(event) => setLogFilter(event.target.value)}
              placeholder="过滤插件日志…"
              className="flex-1 text-xs"
            />
            <IconButton
              title="刷新日志"
              aria-label="刷新日志"
              onClick={() => void window.envApi.pluginLogs(plugin.id, 100).then(setLogs)}
            >
              <Icon name="Refresh" />
            </IconButton>
          </div>
          <pre className="max-h-44 overflow-auto rounded-[var(--radius-md)] border border-border bg-muted/30 p-2 font-mono text-[length:var(--font-size-micro)] leading-relaxed">
            {filteredLogs.length
              ? filteredLogs
                  .map((entry) => `${entry.at.slice(11, 19)} ${entry.level.toUpperCase()} ${entry.message}`)
                  .join('\n')
              : '（没有匹配的日志条目）'}
          </pre>
        </div>
      )}
    </div>
  );
}
