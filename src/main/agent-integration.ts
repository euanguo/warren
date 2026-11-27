/**
 * 把自带的 Skill 装进各个 agent 的 skills 目录。
 *
 * 纯逻辑 + 显式路径参数（`home` / `sourceDir` 都从外面传）—— 不 import electron、
 * 也不自己去问 `os.homedir()`，所以 `tests/agent-integration.test.ts` 能拿临时目录直接跑。
 *
 * Skill 的**唯一真相**是仓库里的 `skills/warren/SKILL.md`；打包时由 `forge.config.cjs`
 * 的 `extraResource` 带进 `Contents/Resources/skills`（见 main.ts 里的 `skillSourceDir()`）。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSkillStatus } from '../shared/types.ts';
import {
  composeWarrenSkill,
  sha256Text,
  writeComposedSkillDirectory,
  type ComposedSkillBundle,
  type PluginSkillEntry,
} from './skills/composer.ts';

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
  { id: 'cursor', label: 'Cursor（~/.cursor）', skillsDir: '.cursor/skills' },
];

export const SKILL_NAME = 'warren';
export const SKILL_STAMP_FILE = '.warren-skill';

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

/** 将内置基础 Skill 与当前已启用插件合成为最终 Skill 包。 */
export async function composeSkill(
  sourceDir: string,
  plugins: PluginSkillEntry[] = [],
  options: { mode?: 'index' | 'full' | 'base-only' } = {},
): Promise<ComposedSkillBundle> {
  const baseMarkdown = await readSkillMarkdown(sourceDir);
  return composeWarrenSkill(baseMarkdown, plugins, options);
}

interface SkillStamp {
  sha256?: string;
  composedSha?: string;
  enabledPlugins?: Array<{ id: string; name: string; version: string; skillSha: string }>;
}

async function readStamp(dir: string): Promise<SkillStamp | null> {
  try {
    const raw = await readFile(path.join(dir, SKILL_STAMP_FILE), 'utf8');
    return JSON.parse(raw) as SkillStamp;
  } catch {
    return null;
  }
}

export async function skillStatus(
  home: string,
  sourceDir: string,
  plugins: PluginSkillEntry[] = [],
): Promise<AgentSkillStatus[]> {
  // 源文件缺失是配置错误（打包漏了 extraResource），早报比装出空文件好
  const bundle = await composeSkill(sourceDir, plugins, { mode: 'index' });
  const expectedMainSha = sha256Text(bundle.markdown);

  const out: AgentSkillStatus[] = [];
  for (const target of AGENT_TARGETS) {
    const file = targetSkillPath(home, target);
    const dir = path.dirname(file);
    const installed = await exists(file);
    let installedSha: string | undefined;
    let stamp: SkillStamp | null = null;
    if (installed) {
      try {
        installedSha = sha256Text(await readFile(file, 'utf8'));
        stamp = await readStamp(dir);
      } catch {
        installedSha = undefined;
      }
    }
    const stampMatches =
      stamp?.composedSha !== undefined ? stamp.composedSha === bundle.composedSha : bundle.enabledPlugins.length === 0;
    const upToDate = installed && installedSha === expectedMainSha && stampMatches;
    out.push({
      id: target.id,
      label: target.label,
      path: file,
      installed,
      upToDate,
      ...(installedSha ? { sha256: installedSha } : {}),
      enabledPlugins:
        installed && stamp?.enabledPlugins
          ? stamp.enabledPlugins
          : bundle.enabledPlugins.map((p) => ({
              id: p.id,
              name: p.name,
              version: p.version,
              skillSha: p.skillSha,
            })),
    });
  }
  return out;
}

export async function installSkill(
  home: string,
  sourceDir: string,
  targetId: string,
  plugins: PluginSkillEntry[] = [],
): Promise<{ path: string; sha256: string; composedSha: string }> {
  const target = AGENT_TARGETS.find((item) => item.id === targetId);
  if (!target) throw new Error(`未知的 agent: ${targetId}`);
  const bundle = await composeSkill(sourceDir, plugins, { mode: 'index' });
  const file = targetSkillPath(home, target);
  return writeComposedSkillDirectory(path.dirname(file), bundle, SKILL_STAMP_FILE);
}

/** 刷新所有已安装但内容过期（含插件启停或版本变化）的 Skill 目标目录。 */
export async function refreshSkills(
  home: string,
  sourceDir: string,
  plugins: PluginSkillEntry[] = [],
): Promise<Array<{ id: string; path: string; sha256: string }>> {
  const statuses = await skillStatus(home, sourceDir, plugins);
  const refreshed: Array<{ id: string; path: string; sha256: string }> = [];
  for (const status of statuses) {
    if (!status.installed || status.upToDate) continue;
    const { path: written, sha256 } = await installSkill(home, sourceDir, status.id, plugins);
    refreshed.push({ id: status.id, path: written, sha256 });
  }
  return refreshed;
}
