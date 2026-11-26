import { useMemo, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon, isIconName } from '@/components/icons';
import { getPluginBrand } from '@/lib/plugin-brand';
import { cardSurfaceClass } from '@/theme/surface';
import { cn } from '@/lib/utils';
import { PERMISSION_TIERS } from '@shared/permissions';
import type { InstalledPlugin, PluginLogEntry, PluginSettingValue } from '@shared/types';

type FilterMode = 'all' | 'running' | 'pending' | 'error' | 'host';

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
      setDraft('');
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

function PluginCard({ plugin, onChanged }: { plugin: InstalledPlugin; onChanged: () => void }) {
  const [logs, setLogs] = useState<PluginLogEntry[] | undefined>();
  const [logFilter, setLogFilter] = useState('');

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

  const brand = getPluginBrand(plugin.id, plugin.icon);
  const brandIconName = isIconName(brand.icon) ? brand.icon : 'Plug';

  return (
    <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')} data-plugin={plugin.id}>
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <span
            aria-hidden
            style={{ '--brand-hue': brand.hue } as CSSProperties}
            className="plugin-brand-chip mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
          >
            <Icon name={brandIconName} className="size-4" />
          </span>
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
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {plugin.permissions.map((permission) => (
          <span key={permission}>{tierBadge(permission, plugin.needsConfirmation.includes(permission))}</span>
        ))}
      </div>

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

/** 设置里的「插件管理」页：支持状态过滤、子进程边界提示与日志检索。 */
export function PluginsPanel({
  onChanged,
  plugins,
  pluginErrors,
}: {
  onChanged: () => void;
  plugins: InstalledPlugin[];
  pluginErrors: Array<{ pluginId: string; message: string }>;
}) {
  const [source, setSource] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [query, setQuery] = useState('');

  const act = async (action: () => Promise<unknown>, failure: string) => {
    try {
      await action();
      setSource('');
      onChanged();
    } catch (error) {
      toast.error(failure, {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const counts = useMemo(() => {
    return {
      all: plugins.length,
      running: plugins.filter((p) => p.status === 'running').length,
      pending: plugins.filter((p) => p.needsConfirmation.length > 0 || p.status === 'needs-configuration').length,
      error: plugins.filter((p) => p.status === 'error').length,
      host: plugins.filter((p) => p.runtime === 'host').length,
    };
  }, [plugins]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((plugin) => {
      if (filter === 'running' && plugin.status !== 'running') return false;
      if (filter === 'pending' && plugin.needsConfirmation.length === 0 && plugin.status !== 'needs-configuration') {
        return false;
      }
      if (filter === 'error' && plugin.status !== 'error') return false;
      if (filter === 'host' && plugin.runtime !== 'host') return false;
      if (!q) return true;
      return `${plugin.id} ${plugin.name} ${plugin.description ?? ''}`.toLowerCase().includes(q);
    });
  }, [plugins, filter, query]);

  const filterChips: Array<{ id: FilterMode; label: string; count: number }> = [
    { id: 'all', label: '全部', count: counts.all },
    { id: 'running', label: '运行中', count: counts.running },
    { id: 'pending', label: '待授权/配置', count: counts.pending },
    { id: 'error', label: '异常', count: counts.error },
    { id: 'host', label: 'Node 宿主', count: counts.host },
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        插件均在可终止子进程中执行：受限 VM 进程只拦截越权 API 调用，并非 OS 安全沙箱；声明{' '}
        <code className="font-mono">host</code> 的插件拥有完整 Node 权限。只安装你信任的包。
      </p>

      {pluginErrors.map((err) => (
        <Alert key={err.pluginId} variant="destructive">
          <AlertTitle>插件前端加载失败：{err.pluginId}</AlertTitle>
          <AlertDescription>{err.message}</AlertDescription>
        </Alert>
      ))}

      <div className="flex items-center gap-2">
        <Input
          value={source}
          placeholder="输入 path: / npm: / git: 插件源…"
          onChange={(event) => setSource(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !source.trim()) return;
            void act(() => window.envApi.pluginInstall(source.trim()), '安装插件失败');
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!source.trim()}
          onClick={() => void act(() => window.envApi.pluginInstall(source.trim()), '安装插件失败')}
        >
          <Icon name="Package" /> 从源安装
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void act(() => window.envApi.pluginInstall(), '安装插件失败')}>
          选目录…
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {filterChips.map((chip) => (
            <Button
              key={chip.id}
              size="sm"
              variant={filter === chip.id ? 'secondary' : 'ghost'}
              onClick={() => setFilter(chip.id)}
            >
              {chip.label} ({chip.count})
            </Button>
          ))}
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选已装插件…"
          className="h-7 w-44 text-xs"
        />
      </div>

      {plugins.length === 0 && <p className="text-xs text-muted-foreground">还没有装插件。</p>}
      {plugins.length > 0 && filtered.length === 0 && (
        <p className="text-xs text-muted-foreground">当前筛选条件下没有匹配的插件。</p>
      )}

      {filtered.map((plugin) => (
        <PluginCard key={plugin.id} plugin={plugin} onChanged={onChanged} />
      ))}
    </div>
  );
}
