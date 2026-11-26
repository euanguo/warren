import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cardSurfaceClass } from '@/theme/surface';
import { cn } from '@/lib/utils';
import type { AgentSkillStatus } from '@shared/types';

const QUICK_CLI_SNIPPETS = [
  { id: 'skill', label: '打印 Skill 手册', cmd: 'warren --skill' },
  { id: 'methods', label: '查看 RPC 能力目录', cmd: 'warren methods' },
  { id: 'doctor', label: '环境连接自检', cmd: 'warren doctor <env>' },
];

/**
 * 设置里的「Agent 接入」部分：安装 Skill 与展示 CLI 自发现入口。
 */
export function AgentPanel() {
  const [skills, setSkills] = useState<AgentSkillStatus[]>([]);
  const [installing, setInstalling] = useState<string>();
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
      toast.success('Skill 已安装', { description: path });
      setTick((value) => value + 1);
    } catch (error) {
      toast.error('安装 Skill 失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstalling(undefined);
    }
  };

  const copyCmd = (cmd: string) => {
    void navigator.clipboard.writeText(cmd);
    toast.success(`已复制：${cmd}`);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Built-in Skill 自动安装</span>
          <span className="text-xs text-muted-foreground">
            把 Warren 浏览器 Skill 安装到外部编码 Agent 的本地目录，让 Claude Code / Codex / OpenCode 自动学会调用。
          </span>
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
                    <Badge variant="outline" className="border-[var(--success)]/50 text-[var(--success)]">
                      已安装
                    </Badge>
                  )}
                </div>
                <p className="truncate font-mono text-[11px] text-muted-foreground">{skill.path}</p>
              </div>
              <Button
                size="sm"
                variant={skill.installed ? 'ghost' : 'default'}
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
