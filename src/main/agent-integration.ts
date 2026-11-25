/**
 * 把自带的 Skill 装进各个 agent 的 skills 目录。
 *
 * 纯逻辑 + 显式路径参数（`home` / `sourceDir` 都从外面传）—— 不 import electron、
 * 也不自己去问 `os.homedir()`，所以 `tests/agent-integration.test.ts` 能拿临时目录直接跑。
 *
 * Skill 的**唯一真相**是仓库里的 `skills/warren/SKILL.md`；打包时由 `forge.config.cjs`
 * 的 `extraResource` 带进 `Contents/Resources/skills`（见 main.ts 里的 `skillSourceDir()`）。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSkillStatus } from '../shared/types.ts';

export interface AgentTarget {
  id: string;
  label: string;
  /** 相对 home 的 skills 目录 */
  skillsDir: string;
}

/**
 * 候选目录。三个都列出来、按实际存在与否标已装 —— 不猜用户用哪个 agent，
 * 也不替用户决定装哪儿。
 */
export const AGENT_TARGETS: readonly AgentTarget[] = [
  { id: 'agents', label: '通用（~/.agents）', skillsDir: '.agents/skills' },
  { id: 'claude', label: 'Claude Code（~/.claude）', skillsDir: '.claude/skills' },
  { id: 'codex', label: 'Codex（~/.codex）', skillsDir: '.codex/skills' },
];

export const SKILL_NAME = 'warren';

export function targetSkillPath(home: string, target: AgentTarget): string {
  return path.join(home, target.skillsDir, SKILL_NAME, 'SKILL.md');
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 读源 SKILL.md。读不到或空文件就抛 —— 宁可报错，也不装一份空壳出去。 */
export async function readSkillMarkdown(sourceDir: string): Promise<string> {
  const file = path.join(sourceDir, SKILL_NAME, 'SKILL.md');
  const text = await readFile(file, 'utf8');
  if (!text.trim()) throw new Error(`skill 源文件是空的: ${file}`);
  return text;
}

export async function skillStatus(home: string, sourceDir: string): Promise<AgentSkillStatus[]> {
  const out: AgentSkillStatus[] = [];
  for (const target of AGENT_TARGETS) {
    const file = targetSkillPath(home, target);
    out.push({ id: target.id, label: target.label, path: file, installed: await exists(file) });
  }
  // 源文件缺失是配置错误（打包漏了 extraResource），早报比装出空文件好
  await readSkillMarkdown(sourceDir);
  return out;
}

export async function installSkill(home: string, sourceDir: string, targetId: string): Promise<{ path: string }> {
  const target = AGENT_TARGETS.find((item) => item.id === targetId);
  if (!target) throw new Error(`未知的 agent: ${targetId}`);
  const markdown = await readSkillMarkdown(sourceDir);
  const file = targetSkillPath(home, target);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, markdown, 'utf8');
  return { path: file };
}
