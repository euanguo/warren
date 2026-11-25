#!/usr/bin/env node
/**
 * 批次 6 验收：鼠标路径合成 + 截图哈希对比（`docs/EXECUTION-PLAN-2026-10-17.md` §批次 6）。
 *
 * 两个前置实验的结论都写在这里：
 *   - **截图是确定性的** —— 同一页面连截多次字节完全相同，所以 SHA-256 足够回答
 *     「改了 CSS 之后页面变了吗」，不需要引图像库做逐像素。
 *   - **路径合成真的生效** —— 页面里数的 `mousemove` 次数从 1 变成 ≥3。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'warren.mjs');
const w = (args, input) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, cwd: ROOT });
const wq = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, cwd: ROOT });
const bad = [];
const ENV = 'pathtest';

// ---------- 1. 鼠标路径：mousemove 次数 ----------
wq(['env', 'remove', ENV]);
w(['env', 'create', ENV, '--start-url=http://127.0.0.1:8899/cap/form.html']);
w(['env', 'start', ENV]);
w(['env', 'select', ENV]);

const moves = Number(
  w(
    ['exec', ENV],
    `await page.goto('http://127.0.0.1:8899/cap/form.html');
     await page.evaluate(() => { window.__moves = 0; document.addEventListener('mousemove', () => window.__moves++); });
     await page.click('#submit');
     console.log('MOVES=' + await page.evaluate(() => window.__moves));`,
  ).match(/MOVES=(\d+)/)?.[1],
);
console.log(`mousemove 次数 = ${moves}（合成前是 1）`);
if (!Number.isFinite(moves) || moves < 3) bad.push(`鼠标路径没生效：mousemove=${moves}`);

// ---------- 2. 截图确定性 + shot diff ----------
const shot = (out) => w(['browser', 'screenshot', ENV, `--output=${out}`]);
const A = '/tmp/warren-batch6-a.png';
const B = '/tmp/warren-batch6-b.png';
shot(A);
shot(B);
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
if (hash(A) !== hash(B)) bad.push('同一页面连截两次字节不同 —— 哈希对比不可用（那要改成逐像素）');
else console.log(`同一页面连截两次字节相同（${hash(A).slice(0, 16)}）`);

const same = wq(['shot', 'diff', A, B]);
if (same.status !== 0) bad.push(`shot diff 对相同图退出 ${same.status}（期望 0）`);
if (!/"same":\s*true/.test(same.stdout)) bad.push('shot diff 对相同图没报 same=true');

// 改一下页面再截 → 必须报不同、退出 1
w(['exec', ENV], `await page.evaluate(() => { document.body.style.background = '#123456'; });`);
const C = '/tmp/warren-batch6-c.png';
shot(C);
const diff = wq(['shot', 'diff', A, C]);
if (diff.status === 0) bad.push('shot diff 对不同图退出了 0（应该 1，才能当断言用）');
if (!/"same":\s*false/.test(diff.stdout)) bad.push('shot diff 对不同图没报 same=false');
console.log('改了背景色之后：same=false，exit=1');

// 不存在的文件要报错退出 1，而不是抛栈
const missing = wq(['shot', 'diff', A, '/tmp/不存在-warrren.png']);
if (missing.status !== 1 || !/文件不存在/.test(missing.stderr)) bad.push('缺文件时报错不对');

// ---------- 清理 ----------
wq(['env', 'stop', ENV]);
wq(['env', 'remove', ENV]);
wq(['env', 'select', 'cap']);

if (bad.length) {
  console.error('BATCH6 FAIL');
  for (const b of bad) console.error('  - ' + b);
  process.exit(1);
}
console.log(`BATCH6 PASS（mousemove ${moves} 次；截图确定；shot diff 相同 exit 0 / 不同 exit 1）`);
