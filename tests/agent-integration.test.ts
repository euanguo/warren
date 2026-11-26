import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_TARGETS,
  installSkill,
  refreshSkills,
  SKILL_STAMP_FILE,
  skillStatus,
  targetSkillPath,
} from '../src/main/agent-integration.ts';

/** 造一个临时 home + 一个临时 skill 源目录。 */
async function fixtures(markdown = '# warren\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warren-skill-'));
  const home = path.join(root, 'home');
  const source = path.join(root, 'skills');
  await mkdir(home, { recursive: true });
  await mkdir(path.join(source, 'warren'), { recursive: true });
  if (markdown) await writeFile(path.join(source, 'warren', 'SKILL.md'), markdown, 'utf8');
  return { root, home, source, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('三个候选目录都列出来，初始都是未安装', async () => {
  const f = await fixtures();
  try {
    const list = await skillStatus(f.home, f.source);
    assert.equal(list.length, AGENT_TARGETS.length);
    assert.ok(list.every((item) => item.installed === false));
    assert.ok(list.every((item) => path.isAbsolute(item.path)));
  } finally {
    await f.cleanup();
  }
});

test('安装写入目标目录并原样落盘，状态跟着变', async () => {
  const f = await fixtures('# warren\n正文\n');
  try {
    const { path: written } = await installSkill(f.home, f.source, 'codex');
    assert.equal(written, targetSkillPath(f.home, { id: 'codex', label: '', skillsDir: '.codex/skills' }));
    assert.equal(await readFile(written, 'utf8'), '# warren\n正文\n');

    const list = await skillStatus(f.home, f.source);
    assert.equal(list.find((item) => item.id === 'codex')?.installed, true);
    assert.equal(list.find((item) => item.id === 'claude')?.installed, false);
  } finally {
    await f.cleanup();
  }
});

test('目标目录不存在时自己建出来（一键安装不用先手建目录）', async () => {
  const f = await fixtures();
  try {
    await installSkill(f.home, f.source, 'claude');
    const list = await skillStatus(f.home, f.source);
    assert.equal(list.find((item) => item.id === 'claude')?.installed, true);
  } finally {
    await f.cleanup();
  }
});

test('未知 agent 报错，不静默写别处', async () => {
  const f = await fixtures();
  try {
    await assert.rejects(() => installSkill(f.home, f.source, 'nope'), /未知的 agent/);
  } finally {
    await f.cleanup();
  }
});

test('源文件缺失或为空时报错 —— 宁可失败也不装空壳', async () => {
  const missing = await fixtures();
  try {
    await rm(path.join(missing.source, 'warren', 'SKILL.md'));
    await assert.rejects(() => skillStatus(missing.home, missing.source));
  } finally {
    await missing.cleanup();
  }

  const empty = await fixtures('   \n');
  try {
    await assert.rejects(() => installSkill(empty.home, empty.source, 'agents'), /空/);
  } finally {
    await empty.cleanup();
  }
});

test('写入 .warren-skill SHA-256 校验戳并支持过期检测与 refreshSkills', async () => {
  const f = await fixtures('# warren v1\n');
  try {
    const installed = await installSkill(f.home, f.source, 'codex');
    const stampRaw = await readFile(path.join(path.dirname(installed.path), SKILL_STAMP_FILE), 'utf8');
    const stamp = JSON.parse(stampRaw) as { sha256: string };
    assert.equal(stamp.sha256, installed.sha256);

    const freshList = await skillStatus(f.home, f.source);
    assert.equal(freshList.find((item) => item.id === 'codex')?.upToDate, true);

    await writeFile(path.join(f.source, 'warren', 'SKILL.md'), '# warren v2\n', 'utf8');
    const staleList = await skillStatus(f.home, f.source);
    assert.equal(staleList.find((item) => item.id === 'codex')?.upToDate, false);

    const refreshed = await refreshSkills(f.home, f.source);
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0]?.id, 'codex');

    const updatedList = await skillStatus(f.home, f.source);
    assert.equal(updatedList.find((item) => item.id === 'codex')?.upToDate, true);
  } finally {
    await f.cleanup();
  }
});
