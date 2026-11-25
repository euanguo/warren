import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cardSurfaceClass } from '@/theme/surface';
import { cn } from '@/lib/utils';
import type { AgentSkillStatus } from '@shared/types';

/**
 * 设置里的「Agent」一页 —— 让**外部 agent**（Claude Code / Codex…）认识 Warren。
 *
 * 为什么不放插件页：插件跑在 Warren 里，Skill 是给外面的 agent 的接入物，两件事。
 * 为什么不做成首页：一次性的配置，不该占工作台的位置。
 */
export function AgentPanel() {
  const [skills, setSkills] = useState<AgentSkillStatus[]>([]);
  const [installing, setInstalling] = useState<string>();
  /** 装完重取一次。计数一变 effect 重跑。 */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await window.envApi.agentSkills();
        if (!cancelled) setSkills(list);
      } catch (error) {
        if (!cancelled) {
          toast.error('读取 Skill 状态失败', {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    void load();
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

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        把 Warren 自带的 Skill 装进 agent 的 skills 目录，那个 agent 就知道怎么用 <code>warren</code>{' '}
        操作环境、读页面、填密码。装完不用重启 Warren。
      </p>

      <div className="flex flex-col gap-2">
        {skills.map((skill) => (
          <div
            key={skill.id}
            className={cn(cardSurfaceClass, 'flex items-center gap-3 px-3 py-2.5')}
            data-slot="agent-skill-row"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{skill.label}</span>
                {skill.installed && (
                  <Badge variant="outline" className="border-[var(--success)] text-[var(--success)]">
                    已安装
                  </Badge>
                )}
              </div>
              <div className="truncate text-xs text-muted-foreground" title={skill.path}>
                {skill.path}
              </div>
            </div>
            <Button
              size="sm"
              variant={skill.installed ? 'ghost' : 'default'}
              disabled={installing === skill.id}
              onClick={() => void install(skill.id)}
            >
              {installing === skill.id ? '安装中…' : skill.installed ? '重新安装' : '安装'}
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">给 agent 的一句话</span>
        <p className="text-xs text-muted-foreground">
          装好之后，直接对 agent 说「用 warren 开一个环境看看这个站点」即可。也可以显式点名：
        </p>
        <pre className={cn(cardSurfaceClass, 'overflow-x-auto px-3 py-2 text-xs text-muted-foreground')}>
          warren env list && warren env start dev && warren exec dev
        </pre>
      </div>
    </div>
  );
}
