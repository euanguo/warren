import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { cardSurfaceClass } from '@/theme/surface';
import type { SystemDiagnosticCheck, SystemDiagnosticsReport } from '@shared/types';

function checkBadge(status: SystemDiagnosticCheck['status']) {
  if (status === 'ok') {
    return (
      <Badge variant="outline" className="border-[var(--success)]/50 text-[var(--success)]">
        正常
      </Badge>
    );
  }
  if (status === 'warn') {
    return (
      <Badge variant="outline" className="border-[var(--warning)]/50 text-[var(--warning)]">
        提示
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-destructive/50 text-destructive">
      异常
    </Badge>
  );
}

/** 设置里的「诊断与关于」页：全局自检、导出脱敏报告与运行时版本信息。 */
export function DiagnosticsPanel() {
  const [report, setReport] = useState<SystemDiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(false);

  const runCheck = async () => {
    setLoading(true);
    try {
      const next = await window.envApi.systemDoctor();
      setReport(next);
    } catch (error) {
      toast.error('运行系统自检失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void window.envApi
      .systemDoctor()
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const copyReport = () => {
    if (!report) return;
    void navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    toast.success('已复制脱敏诊断报告 JSON');
  };

  return (
    <div className="flex flex-col gap-5">
      <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">健康自检（Doctor）</span>
            <span className="text-xs text-muted-foreground">
              检查存储引擎、Agent RPC Socket、环境池、Keychain、Skill 与插件工作进程。
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="ghost" disabled={!report} onClick={copyReport}>
              <Icon name="Copy" /> 复制脱敏报告
            </Button>
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void runCheck()}>
              <Icon name="Refresh" /> {loading ? '检测中…' : '重新检测'}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {(report?.checks ?? []).map((check) => (
            <div
              key={check.id}
              className="flex items-start justify-between gap-3 rounded-[var(--radius-md)] border border-border px-3 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{check.label}</span>
                  {checkBadge(check.status)}
                </div>
                <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{check.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
        <span className="text-sm font-medium">版本与运行环境</span>
        <div className="grid grid-cols-2 gap-y-2 text-xs">
          <span className="text-muted-foreground">Warren 版本</span>
          <span className="font-mono">{report?.appVersion ?? '—'}</span>
          <span className="text-muted-foreground">Electron / Chromium</span>
          <span className="font-mono">{report?.electronVersion ?? '—'}</span>
          <span className="text-muted-foreground">Node.js</span>
          <span className="font-mono">{report?.nodeVersion ?? '—'}</span>
          <span className="text-muted-foreground">平台架构</span>
          <span className="font-mono">{report?.platform ?? '—'}</span>
          <span className="text-muted-foreground">数据目录</span>
          <span className="truncate font-mono" title={report?.dataDir}>
            {report?.dataDir ?? '—'}
          </span>
        </div>
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Button size="sm" variant="outline" onClick={() => void window.envApi.openDataDir()}>
            <Icon name="FolderOpen" /> 打开数据目录
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void window.envApi.clearUrlHistory().then(({ cleared }) => toast.success(`已清理 ${cleared} 条地址历史`))
            }
          >
            <Icon name="Trash" /> 清理地址历史
          </Button>
        </div>
      </div>
    </div>
  );
}
