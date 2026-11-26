import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { InstalledPlugin } from '@shared/types';
import { PluginCard } from './plugin-card';

type FilterMode = 'all' | 'running' | 'pending' | 'error' | 'host';

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
          className="w-44 text-xs"
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
