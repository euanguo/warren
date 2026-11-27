#!/usr/bin/env node
/**
 * 批次 2 验收：去掉焦点守卫 + CI 静态门与打包流水线校验（`docs/EXECUTION-PLAN-2026-10-17.md` §批次 2）。
 *
 * 最要紧的一条：**窗口离屏、未抢前台时，带 `document.hasFocus()` 守卫的真实站点也要能点得动**。
 * 以前会被 `assertInputFocus` 拦下（WINDOW_NOT_FOCUSED），现在既没有守卫，
 * 发输入前还会把 document 焦点交给页面（`focusDisplayedPage`）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'warren.mjs');
const PAGE = 'http://127.0.0.1:8899/cap/focus-guard.html';
const w = (args, input) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, cwd: ROOT });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 默认不碰窗口；单独跑也守这个开关（见 run-all.sh 的说明）。
const windowChecks = process.env.WARREN_REGRESS_WINDOW === '1';
const bad = [];

// ---------- 静态：守卫真的没了 + CI 流水线在位 ----------
const envSrc = readFileSync(path.join(ROOT, 'src/main/environments.ts'), 'utf8');
if (/assertInputFocus\(\)\s*:\s*void\s*\{[\s\S]*?WINDOW_NOT_FOCUSED/.test(envSrc)) {
  bad.push('environments.ts 里 assertInputFocus 还在');
}
const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
if (!/static-gates:/.test(ci)) bad.push('ci.yml 里没有 static-gates job');
if (!/package-macos:/.test(ci)) bad.push('ci.yml 里没有 package-macos job');
const runAll = readFileSync(path.join(ROOT, 'scripts/regress/run-all.sh'), 'utf8');
if (/窗口不在前台.*exit 1/.test(runAll)) bad.push('run-all.sh 还在因为窗口不在前台直接退出');

// ---------- 行为：失焦时点「有焦点才生效」的按钮 ----------
if (!windowChecks) {
  console.log('BATCH2 PASS（静态守卫通过；窗口态行为 SKIP：WARREN_REGRESS_WINDOW=0，不碰窗口）');
  process.exit(0);
}
w(['env', 'start', 'cap']);
w(['env', 'select', 'cap']);
w(['call', 'debug.backgroundWindow']);
sleep(800);
const focused = JSON.parse(w(['call', 'debug.layout', '--json'])).windowFocused;
if (focused) bad.push(`前置失败：后台窗口仍在前台（windowFocused=${focused}）`);

const out = w(
  ['exec', 'cap'],
  `await page.goto('${PAGE}');
   await page.click('#guarded');
   console.log('GUARDED=' + await page.evaluate(() => document.querySelector('#guarded-state').textContent));
   console.log('HASFOCUS=' + await page.evaluate(() => document.hasFocus()));`,
);
const guarded = /GUARDED=(.*)/.exec(out)?.[1]?.trim();
const hasFocus = /HASFOCUS=(.*)/.exec(out)?.[1]?.trim();
console.log(`离屏下点 guarded = "${guarded}" / windowFocused=${focused} / 页面 document.hasFocus() = ${hasFocus}`);
if (guarded !== '已点') bad.push(`离屏时 hasFocus 守卫的按钮没生效（guarded="${guarded}"）`);
if (hasFocus !== 'true') bad.push(`发输入后 document.hasFocus()=${hasFocus}，期望 true`);
if (JSON.parse(w(['call', 'debug.layout', '--json'])).windowFocused) {
  bad.push('输入之后 Warren 被抢到了前台');
}

// 恢复可见但不激活，别把用户的机器切到 Warren。
w(['call', 'debug.showWindow']);

if (bad.length) {
  console.error('BATCH2 FAIL');
  for (const b of bad) console.error('  - ' + b);
  process.exit(1);
}
console.log('BATCH2 PASS (守卫已删；离屏时 hasFocus 守卫的按钮也生效；CI job 就位)');
