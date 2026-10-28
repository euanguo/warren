import { useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cardSurfaceClass, controlFieldCompactClass } from '@/theme/surface';
import { cn } from '@/lib/utils';
import { PERMISSION_TIERS } from '@shared/permissions';
import type { InstalledPlugin, PluginLogEntry, PluginSettingValue } from '@shared/types';

function tierBadge(permission: string) {
  const tier = PERMISSION_TIERS[permission] ?? 'denied';
  if (tier === 'granted') return <Badge variant="secondary">{permission}</Badge>;
  if (tier === 'confirm')
    return (
      <Badge variant="outline" className="border-[var(--warning)]/50 text-[var(--warning)]">
        {permission}
      </Badge>
    );
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

/** 徽章只写「跑在哪」；这条 title 和面板顶部那段说明一起，把「不是沙箱」说清楚。 */
const RUNTIME_HINT: Record<InstalledPlugin['runtime'], string> = {
  sandbox: '同进程运行：只挡误用和越权 API 调用，不是安全沙箱',
  host: '独立进程运行：有完整的 Node 能力（读写文件、起子进程）',
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
  const [draft, setDraft] = useState('');
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

  const placeholder =
    setting.type === 'secret'
      ? setting.configured
        ? '已配置（输入新值可覆盖）'
        : '未配置'
      : String(setting.value ?? '');

  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        {setting.label}
        {setting.type === 'secret' && ' · 存进 Vault'}
      </span>
      {setting.options ? (
        <select
          className={cn(controlFieldCompactClass, 'text-xs')}
          value={String(setting.value ?? '')}
          onChange={(event) =>
            void window.envApi.pluginConfigSet(plugin.id, setting.key, event.target.value).then(onSaved)
          }
        >
          {setting.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex items-center gap-1">
          <Input
            className="h-7 text-xs"
            type={setting.type === 'secret' ? 'password' : 'text'}
            value={draft}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button size="sm" variant="outline" disabled={busy || !draft} onClick={() => void save()}>
            保存
          </Button>
        </div>
      )}
      {setting.description && <span className="text-[10px] text-muted-foreground">{setting.description}</span>}
    </label>
  );
}

function PluginCard({ plugin, onChanged }: { plugin: InstalledPlugin; onChanged: () => void }) {
  const [logs, setLogs] = useState<PluginLogEntry[] | undefined>();

  const act = async (action: () => Promise<unknown>, failure: string) => {
    try {
      await action();
      onChanged();
    } catch (error) {
      toast.error(failure, { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const surfaces = plugin.contributes.surfaces.map((surface) => `${surface.kind}/${surface.id}`);

  return (
    <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{plugin.name}</span>
            <span className="text-[10px] text-muted-foreground">v{plugin.version}</span>
            {/*
              不能写「沙箱」：sandbox 运行时**不是安全边界**（挡误用不挡恶意，见 AGENTS 硬约束 1），
              而「沙箱」这三个字就是在暗示它是。这里只描述它**跑在哪**，说明写在面板顶部那条提示里。
            */}
            <Badge variant="outline" title={RUNTIME_HINT[plugin.runtime]}>
              {plugin.runtime === 'host' ? '独立进程' : '同进程'}
            </Badge>
            <Badge variant="outline" className={statusTone(plugin.status)}>
              {STATUS_LABEL[plugin.status]}
            </Badge>
          </div>
          {plugin.description && <p className="mt-1 text-xs text-muted-foreground">{plugin.description}</p>}
          {plugin.statusDetail && <p className="mt-1 text-[11px] text-destructive">{plugin.statusDetail}</p>}
          {surfaces.length > 0 && <p className="mt-1 text-[10px] text-muted-foreground">界面：{surfaces.join('、')}</p>}
          <p className="mt-1 truncate text-[10px] text-muted-foreground" title={plugin.dir}>
            {plugin.dir}
          </p>
          {plugin.source && (
            <p className="truncate text-[10px] text-muted-foreground" title={plugin.source}>
              {plugin.packageName} · {plugin.source}
              {plugin.resolved ? ` · ${plugin.resolved}` : ''}
            </p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {plugin.enabled ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void act(() => window.envApi.pluginDisable(plugin.id), '停用失败')}
            >
              停用
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void act(() => window.envApi.pluginEnable(plugin.id), '启用失败')}
            >
              启用
            </Button>
          )}
          <IconButton
            title="重载插件"
            aria-label="重载插件"
            onClick={() => void act(() => window.envApi.pluginReload(plugin.id), '重载失败')}
          >
            <Icon name="RotateClockwise" />
          </IconButton>
          <IconButton
            title={logs ? '收起日志' : '查看日志'}
            aria-label="查看日志"
            onClick={() => {
              if (logs) {
                setLogs(undefined);
                return;
              }
              void window.envApi.pluginLogs(plugin.id, 50).then(setLogs);
            }}
          >
            <Icon name="List" />
          </IconButton>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {plugin.permissions.map((permission) => (
          <span key={permission}>{tierBadge(permission)}</span>
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
        <div className="flex flex-col gap-2">
          {plugin.settings.map((setting) => (
            <SettingField key={setting.key} plugin={plugin} setting={setting} onSaved={onChanged} />
          ))}
        </div>
      )}

      {logs && (
        <pre className="max-h-40 overflow-auto rounded-[var(--radius-md)] border border-border bg-muted/30 p-2 text-[10px] leading-relaxed">
          {logs.length
            ? logs.map((entry) => `${entry.at.slice(11, 19)} ${entry.level.toUpperCase()} ${entry.message}`).join('\n')
            : '（还没有日志）'}
        </pre>
      )}
    </div>
  );
}

/** 设置里的「插件」一页。 */
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
  // 列表就是 props：装 / 停 / 卸之后由父组件重取（main 侧每次变更都会发 `state:changed`），
  // 这里不再自己存一份副本——两份真相源必然会漂。
  const act = async (action: () => Promise<unknown>, failure: string) => {
    try {
      await action();
      onChanged();
    } catch (error) {
      toast.error(failure, { description: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="flex flex-col gap-3" data-slot="plugins-panel">
      {pluginErrors.length > 0 && (
        <Alert>
          <AlertTitle>有插件没能加载界面</AlertTitle>
          <AlertDescription>
            {pluginErrors.map((error) => (
              <p key={`${error.pluginId}:${error.message}`} className="text-xs">
                {error.pluginId}：{error.message}
              </p>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {/*
        硬约束 1：插件不是安全沙箱，UI 上不能含糊、也不能谎称沙箱。
        这段话就放在安装按钮正上方——用户点「安装…」之前会看到它。
      */}
      <Alert>
        <AlertTitle>插件是半可信代码，不是沙箱</AlertTitle>
        <AlertDescription>
          <p className="text-xs">
            「同进程」的插件跑在核心进程里：只挡误用和越权 API 调用，<strong>不挡恶意代码</strong>，
            它能看见你在应用界面里看到的内容。
          </p>
          <p className="mt-1 text-xs">
            「独立进程」的插件有完整的 Node 能力（读写文件、起子进程）。新装的插件默认停用，
            启用前会列出它声明的每一项能力，需要确认的要你点「全部批准」。
          </p>
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">已安装</span>
        <Input
          className="ml-auto min-w-64 max-w-xl flex-1"
          value={source}
          placeholder="path:plugins/account-manager / npm:warren-plugin-whistle@^0.3.0 / git:..."
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

      {plugins.length === 0 && <p className="text-xs text-muted-foreground">还没有装插件。</p>}
      {plugins.map((plugin) => (
        <PluginCard key={plugin.id} plugin={plugin} onChanged={() => void act(async () => undefined, '刷新失败')} />
      ))}
    </div>
  );
}
