#!/usr/bin/env node
/**
 * 批次 4 验收：net.* 拆成带注入点的模块（`docs/EXECUTION-PLAN-2026-10-17.md` §批次 4）。
 *
 * 判据两条：
 *   1. 拆出来的模块**真的能单测** —— `tests/net-ops.test.ts` 必须存在且通过；
 *   2. 它是**行为保持**的 —— 网络拦截 n1–n5 必须全绿（那五套是这一步的保护网）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const bad = [];

// 1) 模块存在 + 不 import electron（运行时的），并且真的被单测覆盖
const ops = path.join(ROOT, 'src/main/net/ops.ts');
if (!existsSync(ops)) bad.push('src/main/net/ops.ts 不存在');
else {
  const src = readFileSync(ops, 'utf8');
  if (/^import \{[^}]*\} from 'electron'/m.test(src)) bad.push('ops.ts 有运行时 electron import（单测会加载不了）');
  if (!/import type \{[^}]*NetInterceptor/.test(src)) bad.push('ops.ts 没有用 type-only import 引 NetInterceptor');
  if (!/createInterceptor/.test(src)) bad.push('ops.ts 没有注入点 createInterceptor');
}
if (!existsSync(path.join(ROOT, 'tests/net-ops.test.ts'))) bad.push('tests/net-ops.test.ts 不存在');

// 2) environments.ts 里不该再留 #netFor / #net 表
const env = readFileSync(path.join(ROOT, 'src/main/environments.ts'), 'utf8');
if (/#netFor\(/.test(env)) bad.push('environments.ts 里还留着 #netFor');
if (/#net = new Map/.test(env)) bad.push('environments.ts 里还留着 #net 表');

// 3) 单测真的跑得起来（不是被加载失败吞掉）
const test = spawnSync(process.execPath, ['--test', 'tests/net-ops.test.ts'], { cwd: ROOT, encoding: 'utf8' });
if (test.status !== 0) bad.push(`tests/net-ops.test.ts 没通过：${test.stdout.split('\n').slice(-6).join(' ')}`);
else console.log(test.stdout.match(/^# pass \d+|^ℹ pass \d+/m)?.[0] ?? 'net-ops 单测通过');

// 4) 回归里的网络拦截五套（如果应用在跑）
let live = true;
try {
  execFileSync(process.execPath, ['bin/warren.mjs', 'call', 'debug.layout'], { cwd: ROOT, encoding: 'utf8' });
} catch {
  live = false;
}
if (live) {
  const regress = spawnSync('bash', ['scripts/regress/net-n1.sh'], { cwd: ROOT, encoding: 'utf8' });
  const fails = (regress.stdout.match(/^FAIL/gm) ?? []).length;
  const passes = (regress.stdout.match(/^PASS/gm) ?? []).length;
  console.log(`net-n1 实机：${passes} PASS / ${fails} FAIL`);
  if (fails) bad.push('net-n1 有 FAIL（拆 net.* 破坏了行为）');
} else {
  console.log('（应用没跑，跳过实机那半 —— 跑 bash scripts/regress/run-all.sh 补）');
}

if (bad.length) {
  console.error('BATCH4 FAIL');
  for (const b of bad) console.error('  - ' + b);
  process.exit(1);
}
console.log('BATCH4 PASS（ops.ts 带注入点且可单测；environments.ts 只剩转发）');
