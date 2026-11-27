#!/usr/bin/env node
/**
 * 批次 1 验收：焦点矩阵实测（`docs/EXECUTION-PLAN-2026-10-17.md` §批次 1）。
 *
 * 三条问题，全部**不改代码**：
 *   1.1 后台环境 —— `inputCall` 的 `ensureOperable` 到底有没有效
 *   1.2 部分遮挡 —— 坐标映射会不会变
 *   1.3 `document.hasFocus()` —— 窗口隐藏时输入后页面能不能拿到焦点
 *
 * 结果同时打印出来（要写进文档），末尾给 BATCH1 PASS/FAIL。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'warren.mjs');
const PAGE = 'http://127.0.0.1:8899/cap/form.html';
const env = { ...process.env };
const w = (args, input) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, env, cwd: ROOT });
const wq = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, env, cwd: ROOT });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 默认不碰窗口（隐藏 / 恢复 / Dock 隐藏显示会打断用户正在用的电脑）。
// 单独跑本脚本也守这个开关；要验隐藏态输入与坐标就显式 WARREN_REGRESS_WINDOW=1。
const windowChecks = process.env.WARREN_REGRESS_WINDOW === '1';

const bad = [];
// 只求值，**不导航** —— 导航会把页面状态重置掉（第一版脚本就栽在这）
const evalOnly = (target, expr) => w(['exec', target], `console.log(await page.evaluate(() => ${expr}));`).trim();
// 导航 + 点击 + 读结果，放在**同一次 exec** 里，否则读的时候页面已经被重新加载
const clickAndRead = (target, sel, expr) =>
  w(
    ['exec', target],
    `await page.goto('${PAGE}');\nawait page.click('${sel}');\nconsole.log(await page.evaluate(() => ${expr}));`,
  ).trim();
const gotoAndRead = (target, expr) =>
  w(['exec', target], `await page.goto('${PAGE}');\nconsole.log(await page.evaluate(() => ${expr}));`).trim();

// ---------- 前置 ----------
const layout = () => JSON.parse(w(['call', 'debug.layout', '--json']));
if (!wq(['call', 'debug.layout']).stdout) {
  console.error('BATCH1 FAIL\n  - 应用没起来（先 npm start）');
  process.exit(1);
}
if (!windowChecks) {
  console.log('BATCH1 PASS SKIP（WARREN_REGRESS_WINDOW=0，不碰窗口）');
  process.exit(0);
}
wq(['env', 'remove', 'focustest']);
w(['env', 'create', 'focustest', `--start-url=${PAGE}`]);
w(['env', 'start', 'focustest']);
w(['env', 'start', 'cap']);
w(['env', 'select', 'cap']);
const winBoundsBefore = JSON.stringify(layout().windowBounds);
// 回归不抢前台：用原生 hide 隐藏窗口验证后台输入，不激活任何应用。
w(['call', 'debug.hideWindow']);
sleep(800);

// ---------- 1.1 后台环境：ensureOperable ----------
const b1 = clickAndRead('focustest', '#submit', `document.querySelector('#result').textContent`);
const b1ok = b1.length > 0 && b1 !== '未提交';
const bgFocus = layout().windowFocused;
console.log(
  `1.1 后台环境：点击后 #result="${b1}" / windowFocused=${bgFocus} -> ${b1ok ? 'ensureOperable 有效' : '输入没落地'}`,
);
if (!b1ok) bad.push('1.1 后台环境输入没落地（ensureOperable 有洞）');
if (bgFocus) bad.push('1.1 后台输入把 Warren 抢到了前台');

// 1.1 里 start focustest 会把它选中（headed 默认 true），所以这里必须把 cap 选回来 ——
// 不选回来，下面 1.2/1.3/1.4 测的其实是「后台环境」而不是「窗口隐藏」，第一版脚本就栽在这
w(['env', 'select', 'cap']);
sleep(500);
if (layout().showing.join() !== 'cap') bad.push(`1.2 前置：显示中的环境应为 cap，实际 ${layout().showing.join()}`);

// ---------- 1.2 隐藏/恢复：坐标映射 ----------
const rectBefore = gotoAndRead('cap', `JSON.stringify(document.querySelector('#submit').getBoundingClientRect())`);
const vpBefore = layout().viewport;
w(['call', 'debug.showWindow']);
sleep(500);
const rectAfter = evalOnly('cap', `JSON.stringify(document.querySelector('#submit').getBoundingClientRect())`);
const vpAfter = layout().viewport;
const winBoundsAfter = JSON.stringify(layout().windowBounds);
const focused = layout().windowFocused;
const b2ok =
  rectBefore === rectAfter &&
  JSON.stringify(vpBefore) === JSON.stringify(vpAfter) &&
  winBoundsBefore === winBoundsAfter;
console.log(
  `1.2 隐藏→恢复坐标映射：rect 相同=${rectBefore === rectAfter} viewport 相同=${JSON.stringify(vpBefore) === JSON.stringify(vpAfter)} windowBounds 相同=${winBoundsBefore === winBoundsAfter} windowFocused=${focused}`,
);
if (!b2ok) bad.push('1.2 隐藏/恢复后坐标/视口/窗口位置变了');

// ---------- 1.3 document.hasFocus() ----------
const hasFocus = evalOnly('cap', `document.hasFocus()`);
console.log(`1.3 windowFocused=${layout().windowFocused} / document.hasFocus()=${hasFocus}`);
console.log(
  `    -> ${hasFocus === 'false' ? '窗口未激活时页面自报无焦点；输入路径必须主动把 document 焦点交给页面' : '窗口未激活时页面仍认为有焦点'}`,
);

// ---------- 1.4 不激活窗口，输入后页面仍要拿到 document 焦点 ----------
const afterInput = w(
  ['exec', 'cap'],
  `await page.click('#submit');\nconsole.log(await page.evaluate(() => document.hasFocus()));`,
).trim();
console.log(`1.4 不抢前台：windowFocused=${layout().windowFocused} / 一次输入后 hasFocus=${afterInput}`);
if (afterInput !== 'true') bad.push(`输入之后 document.hasFocus()=${afterInput}，页面守卫会拦掉 agent 的点击`);
if (layout().windowFocused) bad.push('输入之后 Warren 被抢到了前台');

// ---------- 清理 ----------
wq(['env', 'stop', 'focustest']);
wq(['env', 'remove', 'focustest']);
wq(['env', 'select', 'cap']);
wq(['call', 'debug.showWindow']);

if (bad.length) {
  console.error('BATCH1 FAIL');
  for (const b of bad) console.error('  - ' + b);
  process.exit(1);
}
console.log(`BATCH1 PASS (后台环境有效；隐藏恢复坐标不变；输入后 document.hasFocus()=${afterInput})`);
