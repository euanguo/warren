import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cardSurfaceClass } from '@/theme/surface';
import { cn } from '@/lib/utils';
import type { AgentSkillStatus } from '@shared/types';

const QUICK_CLI_SNIPPETS = [
  { id: 'skill', label: '打印合成版 Skill（含已启用插件）', cmd: 'warren --skill' },
  { id: 'plugin-skill', label: '读取指定插件 Skill 手册', cmd: 'warren skills plugin <pluginId>' },
  { id: 'methods', label: '查看 RPC 能力目录', cmd: 'warren methods' },
  { id: 'doctor', label: '环境连接自检', cmd: 'warren env doctor <env>' },
];

/**
 * 设置里的「Agent 接入」部分：安装 Skill 与展示 CLI 自发现入口。
 */
export function AgentPanel() {
  const [skills, setSkills] = useState<AgentSkillStatus[]>([]);
  const [installing, setInstalling] = useState<string>();
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void window.envApi.agentSkills().then((list) => {
      if (!cancelled) setSkills(list);
    });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const install = async (targetId: string) => {
    setInstalling(targetId);
    try {
      const { path } = await window.envApi.agentInstallSkill(targetId);
      toast.success('Skill 已同步（含已启用插件）', { description: path });
      setTick((value) => value + 1);
    } catch (error) {
      toast.error('安装 Skill 失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstalling(undefined);
    }
  };

  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      const updated = await window.envApi.agentRefreshSkills();
      toast.success(updated.length ? `已同步 ${updated.length} 个 Skill 目录` : '所有已安装目录均已是最新');
      setTick((value) => value + 1);
    } catch (error) {
      toast.error('批量刷新 Skill 失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRefreshingAll(false);
    }
  };

  const enabledPluginSkills = skills[0]?.enabledPlugins ?? [];
  const hasOutdated = skills.some((item) => item.installed && item.upToDate === false);

  const copyCmd = (cmd: string) => {
    void navigator.clipboard.writeText(cmd);
    toast.success(`已复制：${cmd}`);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Built-in Skill 与插件 Skill 自动注入</span>
            <span className="text-xs text-muted-foreground">
              把 Warren 核心 Skill 与当前已启用插件的 Skill 同步到外部编码 Agent
              目录；插件启停或更新后会自动刷新已安装目录。
            </span>
          </div>
          {hasOutdated && (
            <Button size="sm" variant="outline" disabled={refreshingAll} onClick={() => void refreshAll()}>
              {refreshingAll ? '同步中…' : '刷新过期目录'}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>当前自动注入插件 Skill（{enabledPluginSkills.length}）：</span>
          {enabledPluginSkills.length === 0 ? (
            <span>无已启用且暴露 Skill 的插件</span>
          ) : (
            enabledPluginSkills.map((p) => (
              <Badge key={p.id} variant="secondary" className="gap-1 font-mono text-[10px]">
                <Icon name="Plug" className="size-3 text-muted-foreground" />
                {p.name} · v{p.version}
              </Badge>
            ))
          )}
        </div>

        <div className="flex flex-col gap-2">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{skill.label}</span>
                  {skill.installed && (
                    <Badge variant={skill.upToDate === false ? 'warning' : 'success'}>
                      {skill.upToDate === false ? '待同步' : '已同步'}
                    </Badge>
                  )}
                </div>
                <p className="truncate font-mono text-[11px] text-muted-foreground">{skill.path}</p>
              </div>
              <Button
                size="sm"
                variant={skill.installed ? 'outline' : 'default'}
                disabled={installing === skill.id}
                onClick={() => void install(skill.id)}
              >
                {installing === skill.id ? '安装中…' : skill.installed ? '重新同步' : '安装'}
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className={cn(cardSurfaceClass, 'flex flex-col gap-2.5')}>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">CLI 自发现与排查命令</span>
          <span className="text-xs text-muted-foreground">
            外部 Agent 在终端中直接运行即可实时拉取当前协议方法列表与 Skill 约定。
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          {QUICK_CLI_SNIPPETS.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border px-2.5 py-1.5 text-xs"
            >
              <span className="text-muted-foreground">{item.label}</span>
              <div className="flex items-center gap-2">
                <code className="font-mono text-foreground">{item.cmd}</code>
                <Button size="sm" variant="ghost" onClick={() => copyCmd(item.cmd)}>
                  <Icon name="Copy" /> 复制
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
