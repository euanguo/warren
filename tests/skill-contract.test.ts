import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateCliInvocation } from '../bin/commands.mjs';

const SKILL_PATH = path.join(import.meta.dirname, '..', 'skills', 'warren', 'SKILL.md');

/** 简单拆解一条 bash 示例中的命令行 token（保留双引号 / 单引号语义）。 */
function splitBashCommand(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of line) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** 从 SKILL.md 的 ```bash 代码块提取每一条逻辑 `warren ...` 命令（跳过 heredoc 主体）。 */
function extractSkillCommands(markdown: string): string[][] {
  const commands: string[][] = [];
  const fenceRe = /```(?:bash|sh)\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(fenceRe)) {
    const lines = match[1]!.split(/\r?\n/);
    let inHeredocMarker: string | null = null;
    let joined = '';
    for (const raw of lines) {
      const line = raw.replace(/\s+#.*$/, '').trimEnd();
      if (inHeredocMarker) {
        if (line.trim() === inHeredocMarker) inHeredocMarker = null;
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.endsWith('\\')) {
        joined += trimmed.slice(0, -1) + ' ';
        continue;
      }
      const full = (joined + trimmed).trim();
      joined = '';
      const heredocMatch = full.match(/<<'?([A-Z_]+)'?$/);
      if (heredocMatch) inHeredocMarker = heredocMatch[1]!;
      const cleaned = full.replace(/\s*<<'?[A-Z_]+'?$/, '');
      if (cleaned.startsWith('warren ')) {
        commands.push(splitBashCommand(cleaned).slice(1));
      }
    }
  }
  return commands;
}

test('SKILL.md 内所有 bash 命令示例都能通过真实 CLI 命令解析器校验（防文档漂移）', () => {
  const markdown = readFileSync(SKILL_PATH, 'utf8');
  const invocations = extractSkillCommands(markdown);
  assert.ok(invocations.length >= 15, `只抽取到 ${invocations.length} 条命令示例`);
  for (const argv of invocations) {
    const check = validateCliInvocation(argv);
    assert.equal(check.ok, true, `SKILL.md 示例校验失败: warren ${argv.join(' ')} → ${check.reason ?? ''}`);
  }
});
