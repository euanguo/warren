#!/usr/bin/env node
/**
 * 批次 5 验收：请求/响应 body 可见（`docs/EXECUTION-PLAN-2026-10-17.md` §批次 5）。
 *
 * 核心结论（决定了做法）：**body 与 CORS 真实在 Electron 里是互斥的** —— 抓 body 要靠
 * `protocol.handle` 挂上整个 session，而那会让跨源响应跳过 CORS 检查。所以 body **只在
 * HAR 录制期间**有，不常开。这条验收同时锁住「不录制时给可执行的错误」和「录制时能读到、
 * 且 URL 里的敏感 query 已脱敏」。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'warren.mjs');
const w = (args, input) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, cwd: ROOT });
const wq = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, cwd: ROOT });
const bad = [];
const ENV = 'bodytest';

const cleanup = () => {
  wq(['net', 'record', 'stop', ENV]);
  wq(['env', 'stop', ENV]);
  wq(['env', 'remove', ENV]);
  wq(['env', 'select', 'cap']);
};

wq(['env', 'remove', ENV]);
w(['env', 'create', ENV, '--start-url=http://127.0.0.1:8899/cap/net.html']);
w(['env', 'start', ENV]);
w(['env', 'select', ENV]);

// 1) 不录制时：必须报 NET_BODY_NEEDS_RECORDING，且消息里给下一步命令
const dry = wq(['net', 'body', ENV, '0']);
if (dry.status === 0) bad.push('不录制时 net body 居然成功了（应该报 NET_BODY_NEEDS_RECORDING）');
else {
  if (!/NET_BODY_NEEDS_RECORDING/.test(dry.stderr)) bad.push(`错误码不对：${dry.stderr.trim()}`);
  if (!new RegExp(`net record start ${ENV}`).test(dry.stderr)) bad.push('错误消息没给下一步命令');
}

// 2) 录制中：能读到 body，且 URL 的敏感 query 已脱敏
w(['net', 'record', 'start', ENV]);
w(
  ['exec', ENV],
  `await page.evaluate(\`fetch('/cap/api/user?token=abc123&id=1').then(r=>r.json())\`);
await page.waitForTimeout(400);`,
);
const body = JSON.parse(w(['net', 'body', ENV, '0']));
if (!/cap\/api\/user/.test(body.url)) bad.push(`第 0 条不是刚打的接口：${body.url}`);
if (!/token=%5BREDACTED%5D/.test(body.url)) bad.push(`URL 里的 token 没脱敏：${body.url}`);
if (!/id=1/.test(body.url)) bad.push(`不敏感的 query 被误伤：${body.url}`);
if (typeof body.body !== 'string' || !body.body.length) bad.push('body 是空的');
console.log(`body[0] = ${body.status} ${body.url} / redacted=${body.redacted}`);

// 3) 序号越界：报 BAD_REQUEST 并报出总数
const oob = wq(['net', 'body', ENV, '99']);
if (oob.status === 0) bad.push('越界序号居然成功了');
else if (!/BAD_REQUEST/.test(oob.stderr) || !/一共抓到/.test(oob.stderr))
  bad.push(`越界报错不对：${oob.stderr.trim()}`);

// 4) 停止录制后**仍然读得到最近一次**（#har 要留着写 HAR 文件；下次 start 才清）
//    这条是有意为之：录完再回来读，比「必须边录边读」好用
w(['net', 'record', 'stop', ENV]);
const after = wq(['net', 'body', ENV, '0']);
if (after.status !== 0) bad.push(`stop 之后读不到最近一次录到的 body：${after.stderr.trim()}`);
else console.log('stop 之后仍可读最近一次录制（有意）');

// 5) 新起一轮录制会清空上一轮
w(['net', 'record', 'start', ENV]);
const fresh = wq(['net', 'body', ENV, '0']);
if (fresh.status === 0) bad.push('新起一轮录制没清掉上一轮抓到的 body');

cleanup();
if (bad.length) {
  console.error('BATCH5 FAIL');
  for (const b of bad) console.error('  - ' + b);
  process.exit(1);
}
console.log('BATCH5 PASS（没抓过时给可执行错误；录制时能读 body 且 URL 已脱敏；停录后仍可读；新录清空）');
