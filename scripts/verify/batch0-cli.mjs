#!/usr/bin/env node
/**
 * 批次 0 验收：CLI 两处 P0（`docs/EXECUTION-PLAN-2026-10-17.md` §批次 0）。
 *
 * 判据全部是行为断言，不看源码：跑 CLI，看退出码、stdout/stderr。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { SUBS, TOP_LEVEL } from '../../bin/commands.mjs';

const CLI = path.join(import.meta.dirname, '..', '..', 'bin', 'warren.mjs');
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const bad = [];

// P0-2：未知组必须报错退出 1，且不往 stdout 吐 help
const nope = run(['nope']);
if (nope.status !== 1) bad.push(`warren nope exit=${nope.status}，期望 1`);
if (nope.stdout.trim() !== '') bad.push('warren nope 往 stdout 写了东西');
if (!nope.stderr.includes('未知命令组')) bad.push('warren nope 的 stderr 没说明原因');

// 无参 / help 仍然 exit 0 + 打 help
for (const args of [[], ['help']]) {
  const r = run(args);
  if (r.status !== 0) bad.push(`warren ${args.join(' ')} exit=${r.status}，期望 0`);
  if (!r.stdout.includes('Warren 的 Agent 接口')) bad.push(`warren ${args.join(' ')} 没打 help`);
}

// P0-1：help 与每组报错都要覆盖全量清单
const help = run(['help']).stdout;
for (const [group, list] of Object.entries(SUBS)) {
  const listed = new Set();
  for (const m of help.matchAll(new RegExp(`warren ${group} ([a-z|-]+)`, 'g'))) {
    for (const s of m[1].split('|')) listed.add(s);
  }
  for (const sub of list) if (!listed.has(sub)) bad.push(`help 漏了 ${group} ${sub}`);

  const r = run([group, '__nope__', '__env__']);
  if (r.status !== 1) bad.push(`warren ${group} __nope__ exit=${r.status}，期望 1`);
  for (const sub of list) if (!r.stderr.includes(sub)) bad.push(`${group} 的报错漏了 ${sub}`);
}
for (const c of TOP_LEVEL) if (!help.includes(`warren ${c}`)) bad.push(`help 漏了顶层命令 ${c}`);

if (bad.length) {
  console.error('BATCH0 FAIL');
  for (const b of bad) console.error('  - ' + b);
  process.exit(1);
}
console.log(`BATCH0 PASS (${Object.values(SUBS).flat().length} 个子命令 + ${TOP_LEVEL.length} 个顶层命令全覆盖)`);
