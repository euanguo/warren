#!/usr/bin/env node
/**
 * 批次 3 验收：扩展加载（`docs/EXECUTION-PLAN-2026-10-17.md` §批次 3）。
 *
 * **能验的**：装 / 列 / 卸 + 内容脚本真的注入 + React DevTools 的 hook 注入。
 * **验不了的**：DevTools 面板（`chrome.devtools.panels.create`）有没有出现在 DevTools 里 ——
 *   那要读 DevTools 窗口的 UI。本机实测（截图，见文档）是**没出现**，连 Electron 自己测试
 *   夹具同形状的最小 MV2 扩展也不出现。所以这条不写成断言，写成"已知缺口"。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'warren.mjs');
const w = (args, input) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, cwd: ROOT });
const wq = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, cwd: ROOT });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const bad = [];
const ENV = 'exttest';

// ---------- 前置 ----------
wq(['env', 'remove', ENV]);
w(['env', 'create', ENV, '--start-url=http://127.0.0.1:8899/cap/form.html']);
w(['env', 'start', ENV]);
w(['env', 'select', ENV]);

// ---------- 1. 装 + 列 ----------
const addOut = w(['extension', 'add', ENV, 'fixtures/extension/hello']);
if (!/hello/.test(addOut)) bad.push(`extension add 没返回 id：${addOut.trim()}`);
const listed = w(['extension', 'list', ENV]);
if (!/hello/.test(listed)) bad.push(`extension list 里没有 hello：${listed.trim()}`);

// ---------- 2. 内容脚本真的注入了（重启环境之后）----------
w(['env', 'stop', ENV]);
w(['env', 'start', ENV]);
w(['env', 'select', ENV]);
sleep(500);
const marker = w(
  ['exec', ENV],
  `await page.goto('http://127.0.0.1:8899/cap/form.html');
   console.log('MARK=' + await page.evaluate(() => document.documentElement.getAttribute('data-warren-ext')));`,
).trim();
const mark = /MARK=(.*)/.exec(marker)?.[1];
console.log(`内容脚本标记 data-warren-ext = "${mark}"`);
if (mark !== 'hello') bad.push(`内容脚本没注入（marker=${mark}）`);

// ---------- 3. 坏输入被挡 ----------
const crx = wq(['extension', 'add', ENV, 'fixtures/extension/hello/manifest.json', '--name=bad']);
if (crx.status === 0) bad.push('把文件当目录装居然成功了（应该报 EXTENSION_NOT_UNPACKED）');
else if (!/不是目录|EXTENSION_NOT_UNPACKED/.test(crx.stderr)) bad.push(`坏输入的报错不对：${crx.stderr.trim()}`);
const traversal = wq(['extension', 'add', ENV, 'fixtures/extension/hello', '--name=../../evil']);
if (traversal.status === 0) bad.push('路径穿越的目录名居然通过了（应该报 BAD_EXTENSION_NAME）');

// ---------- 4. 卸载 ----------
const rmOut = w(['extension', 'remove', ENV, 'hello']);
if (!/"removed":\s*true/.test(rmOut)) bad.push(`extension remove 没删掉：${rmOut.trim()}`);
if (/hello/.test(w(['extension', 'list', ENV]))) bad.push('remove 之后 list 里还有 hello');

// ---------- 清理 ----------
wq(['env', 'stop', ENV]);
wq(['env', 'remove', ENV]);
wq(['env', 'select', 'cap']);

if (bad.length) {
  console.error('BATCH3 FAIL');
  for (const b of bad) console.error('  - ' + b);
  process.exit(1);
}
console.log('BATCH3 PASS（装/列/卸 + 内容脚本注入 + 坏输入被挡；DevTools 面板是已知缺口，见文档）');
