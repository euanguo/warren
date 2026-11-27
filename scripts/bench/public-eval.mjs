#!/usr/bin/env node
/**
 * Warren 公开基准自动化评测套件（覆盖 4 个分层 Suite，共 42 项真实公开任务）：
 * - miniwob-core (15): Farama MiniWoB++ 核心原子交互与表单（含纯 @N drag-box、浮层 autocomplete）
 * - miniwob-hard (9):  Farama MiniWoB++ 复杂多步 SPA / 文件树 / 分页搜索 / Webmail / 机票日历预订
 * - online-dom  (10):  UI Testing Playground (6) + The Internet Herokuapp (4) 核心 DOM 陷阱
 * - online-hard  (8):  UI Testing Playground (3) + The Internet Herokuapp (5) 高难多帧/可见性/上传/动态控件
 *
 * 用法：
 *   WARREN_HOME=/tmp/warren-bench-live node scripts/bench/public-eval.mjs \
 *     --suite=all --miniwob-url=http://127.0.0.1:8910/miniwob --out=/tmp/warren-bench-report.json
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(REPO_ROOT, 'bin/warren.mjs');

const ALL_SUITES = ['miniwob-core', 'miniwob-hard', 'online-dom', 'online-hard'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function parseArgs(argv) {
  const opts = {
    suites: ALL_SUITES,
    miniwobUrl: 'http://127.0.0.1:8910/miniwob',
    envName: `bench-eval-${Date.now().toString(36)}`,
    keepEnv: false,
    outPath: '',
    taskFilter: '',
  };
  for (const arg of argv) {
    if (arg.startsWith('--suite=')) {
      const raw = arg.slice('--suite='.length).trim();
      opts.suites =
        raw === 'all'
          ? ALL_SUITES
          : raw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
    } else if (arg.startsWith('--miniwob-url=')) {
      opts.miniwobUrl = arg.slice('--miniwob-url='.length).replace(/\/$/, '');
    } else if (arg.startsWith('--env=')) {
      opts.envName = arg.slice('--env='.length).trim();
      opts.keepEnv = true;
    } else if (arg.startsWith('--out=')) {
      opts.outPath = arg.slice('--out='.length).trim();
    } else if (arg.startsWith('--task=')) {
      opts.taskFilter = arg.slice('--task='.length).trim();
    }
  }
  return opts;
}

class WarrenHarness {
  constructor(envId) {
    this.envId = envId;
    this.steps = 0;
  }

  resetSteps() {
    this.steps = 0;
  }

  run(args, { countStep = false, timeout = 35_000 } = {}) {
    if (countStep) this.steps += 1;
    try {
      const stdout = execFileSync('node', [CLI_PATH, ...args], {
        cwd: REPO_ROOT,
        env: process.env,
        encoding: 'utf8',
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout: stdout.trim(), stderr: '' };
    } catch (err) {
      return {
        ok: false,
        stdout: String(err.stdout ?? '').trim(),
        stderr: String(err.stderr ?? err.message ?? '').trim(),
        status: err.status ?? 1,
      };
    }
  }

  runJson(args, opts) {
    const res = this.run([...args, '--json'], opts);
    if (!res.ok) {
      let parsed = null;
      try {
        parsed = JSON.parse(res.stdout || res.stderr);
      } catch {
        // 非 JSON 错误文本保留原样
      }
      return { ok: false, data: parsed, error: res.stderr || res.stdout };
    }
    try {
      return { ok: true, data: JSON.parse(res.stdout) };
    } catch {
      return { ok: false, data: null, error: `JSON 解析失败: ${res.stdout.slice(0, 200)}` };
    }
  }

  open(url) {
    const r = this.run(['browser', 'open', this.envId, url, '--timeout=25000'], { timeout: 35_000 });
    if (!r.ok) throw new Error(`open(${url}) 失败: ${r.stderr || r.stdout}`);
    return r;
  }

  snapshot({ interactive = true, noFold = true } = {}) {
    const args = ['browser', 'snapshot', this.envId];
    if (interactive) args.push('-i');
    if (noFold) args.push('--no-fold');
    const r = this.runJson(args, { countStep: true });
    if (!r.ok) throw new Error(`snapshot 失败: ${r.error}`);
    return r.data?.nodes ?? [];
  }

  click(target, extraArgs = []) {
    const r = this.run(['browser', 'click', this.envId, target, '--timeout=8000', ...extraArgs], { countStep: true });
    if (!r.ok) throw new Error(`click(${target}) 失败: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  clickRaw(target, extraArgs = []) {
    return this.run(['browser', 'click', this.envId, target, '--timeout=5000', ...extraArgs], { countStep: true });
  }

  fill(target, value, extraArgs = []) {
    const r = this.run(['browser', 'fill', this.envId, target, value, '--timeout=8000', ...extraArgs], {
      countStep: true,
    });
    if (!r.ok) throw new Error(`fill(${target}) 失败: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  select(target, values) {
    const arr = Array.isArray(values) ? values : [values];
    const r = this.run(['browser', 'select', this.envId, target, ...arr, '--timeout=8000'], { countStep: true });
    if (!r.ok) throw new Error(`select(${target}) 失败: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  drag(source, target) {
    const r = this.run(['browser', 'drag', this.envId, source, target, '--timeout=8000'], { countStep: true });
    if (!r.ok) throw new Error(`drag(${source} -> ${target}) 失败: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  hover(target) {
    const r = this.run(['browser', 'hover', this.envId, target, '--timeout=8000'], { countStep: true });
    if (!r.ok) throw new Error(`hover(${target}) 失败: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  upload(target, filePath) {
    const r = this.run(['browser', 'upload', this.envId, target, filePath], { countStep: true });
    if (!r.ok) throw new Error(`upload(${target}) 失败: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  dialog(action) {
    const r = this.run(['browser', 'dialog', this.envId, action], { countStep: true });
    if (!r.ok) throw new Error(`dialog(${action}) 失败: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  waitText(text, timeoutMs = 15_000) {
    const r = this.run(['browser', 'wait', this.envId, `--text=${text}`, `--timeout=${timeoutMs}`], {
      countStep: true,
      timeout: timeoutMs + 10_000,
    });
    if (!r.ok) throw new Error(`wait(--text=${text}) 失败: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  waitMs(ms) {
    this.run(['browser', 'wait', this.envId, String(ms)]);
  }

  frameList() {
    const r = this.runJson(['browser', 'frame', this.envId, 'list'], { countStep: true });
    if (!r.ok) throw new Error(`frame list 失败: ${r.error}`);
    return Array.isArray(r.data) ? r.data : (r.data?.frames ?? []);
  }

  frameSelect(target) {
    const r = this.run(['browser', 'frame', this.envId, 'select', target], { countStep: true });
    if (!r.ok) throw new Error(`frame select(${target}) 失败: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  isVisible(target) {
    const r = this.runJson(['browser', 'is', this.envId, 'visible', target], { countStep: true });
    if (!r.ok) return { ok: false, value: false, error: r.error };
    const val = typeof r.data === 'boolean' ? r.data : Boolean(r.data?.ok ?? r.data?.result ?? r.data?.value);
    return { ok: true, value: val };
  }

  evalJs(expr) {
    const r = this.runJson(['browser', 'eval', this.envId, expr]);
    if (!r.ok) throw new Error(`eval 失败: ${r.error}`);
    return r.data?.value !== undefined ? r.data.value : r.data;
  }
}

function norm(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findNode(nodes, predicate) {
  return nodes.find((n) => n.ref && predicate(n));
}

function startMiniwob(h, baseUrl, taskName) {
  h.open(`${baseUrl}/${taskName}.html`);
  // 点 START 遮罩开始正式计时
  h.click('#sync-task-cover', ['--no-changes']);
  const query = norm(h.evalJs('document.querySelector("#query")?.textContent || ""'));
  return query;
}

function readMiniwobReward(h) {
  const res = h.evalJs(
    '({ done: Boolean(window.WOB_DONE_GLOBAL), raw: Number(window.WOB_RAW_REWARD_GLOBAL ?? 0), reward: Number(window.WOB_REWARD_GLOBAL ?? 0), reason: window.WOB_REWARD_REASON || "" })',
  );
  return res;
}

function assertMiniwobPass(res, extra = '') {
  if (!res?.done || res.raw <= 0) {
    throw new Error(`MiniWoB 未通过: done=${res?.done} raw=${res?.raw} reason=${res?.reason} ${extra}`.trim());
  }
  return `reward=${res.raw.toFixed(2)}${extra ? ` (${extra})` : ''}`;
}

// ---------- Suite 1: MiniWoB++ Core (15 项) ----------

function miniwobCoreTasks(baseUrl) {
  return [
    {
      suite: 'miniwob-core',
      id: 'miniwob:click-button',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'click-button');
        const target = q.match(/"([^"]+)"/)?.[1];
        const nodes = h.snapshot();
        const btn = findNode(nodes, (n) => /button/i.test(n.role) && norm(n.name) === target);
        if (!btn) throw new Error(`未找到按钮 "${target}"`);
        h.click(btn.ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:click-link',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'click-link');
        const target = q.match(/"([^"]+)"/)?.[1];
        const nodes = h.snapshot();
        const link = findNode(nodes, (n) => /(link|clickable)/i.test(n.role) && norm(n.name) === target);
        if (!link) throw new Error(`未找到链接 "${target}"`);
        h.click(link.ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:click-dialog',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'click-dialog');
        const rawTarget = q.match(/"([^"]+)"/)?.[1] || 'Close';
        const target = rawTarget.toLowerCase() === 'x' ? 'Close' : rawTarget;
        const nodes = h.snapshot();
        const btn =
          findNode(nodes, (n) => /button/i.test(n.role) && norm(n.name).toLowerCase() === target.toLowerCase()) ||
          findNode(nodes, (n) => /button/i.test(n.role) && norm(n.name).toLowerCase().includes(target.toLowerCase()));
        if (!btn) throw new Error(`未找到弹窗按钮 "${rawTarget}"`);
        h.click(btn.ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:click-checkboxes',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'click-checkboxes');
        const rawList = q.replace(/^Select\s+/i, '').replace(/\s+and click Submit\.?$/i, '');
        const wanted = rawList === 'nothing' ? [] : rawList.split(/,\s*/).map(norm).filter(Boolean);
        const nodes = h.snapshot();
        for (const label of wanted) {
          const cb = findNode(nodes, (n) => /checkbox/i.test(n.role) && norm(n.name) === label);
          if (!cb) throw new Error(`未找到复选框 "${label}"`);
          h.click(cb.ref, ['--no-changes']);
        }
        const submit = findNode(nodes, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h), `${wanted.length} boxes`);
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:click-option',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'click-option');
        const target = q
          .replace(/^Select\s+/i, '')
          .replace(/\s+and click Submit\.?$/i, '')
          .trim();
        const nodes = h.snapshot();
        const radio = findNode(nodes, (n) => /radio/i.test(n.role) && norm(n.name) === target);
        if (!radio) throw new Error(`未找到单选项 "${target}"`);
        h.click(radio.ref, ['--no-changes']);
        const submit = findNode(nodes, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:enter-text',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'enter-text');
        const text = q.match(/"([^"]+)"/)?.[1] ?? '';
        const nodes = h.snapshot();
        const box = findNode(nodes, (n) => /textbox/i.test(n.role));
        const submit = findNode(nodes, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        h.fill(box.ref, text, ['--no-changes']);
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:enter-password',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'enter-password');
        const pw = q.match(/"([^"]+)"/)?.[1] ?? '';
        const nodes = h.snapshot();
        const boxes = nodes.filter((n) => n.ref && /textbox/i.test(n.role));
        if (boxes.length < 2) throw new Error(`密码框不足 2 个: ${boxes.length}`);
        for (const box of boxes) h.fill(box.ref, pw, ['--no-changes']);
        const submit = findNode(nodes, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:login-user',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'login-user');
        const matches = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        const [user, pass] = matches;
        const nodes = h.snapshot();
        const boxes = nodes.filter((n) => n.ref && /textbox/i.test(n.role));
        h.fill(boxes[0].ref, user, ['--no-changes']);
        h.fill(boxes[1].ref, pass, ['--no-changes']);
        const btn = findNode(nodes, (n) => /button/i.test(n.role) && /login/i.test(n.name));
        h.click(btn.ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:click-collapsible',
      run: (h) => {
        startMiniwob(h, baseUrl, 'click-collapsible');
        const nodes1 = h.snapshot();
        const header = findNode(
          nodes1,
          (n) => /(button|tab|clickable|heading)/i.test(n.role) && /section/i.test(n.name),
        );
        if (!header) throw new Error('未找到折叠标题');
        h.click(header.ref, ['--no-changes']);
        h.waitMs(250);
        const nodes2 = h.snapshot();
        const submit = findNode(nodes2, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:click-tab',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'click-tab');
        const tabNum = q.match(/Tab\s*#?(\d+)/i)?.[1] ?? '2';
        const nodes = h.snapshot();
        const tab =
          findNode(nodes, (n) => /(tab|link)/i.test(n.role) && new RegExp(`#?${tabNum}\\b`).test(n.name)) ||
          findNode(nodes, (n) => /(tab|link)/i.test(n.role) && norm(n.name) === tabNum);
        if (!tab) throw new Error(`未找到 Tab #${tabNum}`);
        h.click(tab.ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:click-scroll-list',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'click-scroll-list');
        const raw = q.replace(/^Select\s+/i, '').replace(/\s+from the scroll list.*$/i, '');
        const items = raw.split(/,\s*/).map(norm).filter(Boolean);
        const nodes = h.snapshot();
        const listbox = findNode(nodes, (n) => /(listbox|combobox)/i.test(n.role));
        if (!listbox) throw new Error('未找到滚动列表 select');
        h.select(listbox.ref, items);
        const submit = findNode(nodes, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h), `selected=${items.length}`);
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:focus-text-2',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'focus-text-2');
        const idx = /second/i.test(q) ? 1 : 0;
        const nodes = h.snapshot();
        const boxes = nodes.filter((n) => n.ref && /textbox/i.test(n.role));
        if (!boxes[idx]) throw new Error(`未找到第 ${idx + 1} 个文本框`);
        h.click(boxes[idx].ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:choose-list',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'choose-list');
        const item = q
          .replace(/^Select\s+/i, '')
          .replace(/\s+from the list.*$/i, '')
          .trim();
        const nodes = h.snapshot();
        const combo = findNode(nodes, (n) => /combobox/i.test(n.role));
        if (!combo) throw new Error('未找到下拉框');
        h.select(combo.ref, item);
        const submit = findNode(nodes, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h));
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:drag-box',
      run: (h) => {
        startMiniwob(h, baseUrl, 'drag-box');
        // 严格验证改造项 2：零硬编码 CSS，纯靠 snapshot -i 暴露的 draggable @N 完成拖拽
        const nodes = h.snapshot();
        const small = findNode(
          nodes,
          (n) => /^draggable$/i.test(n.role) && /^(s|#draggableSmall)$/i.test(norm(n.name)),
        );
        const large = findNode(
          nodes,
          (n) => /^draggable$/i.test(n.role) && /^(L|#draggableLarge)$/i.test(norm(n.name)),
        );
        const submit = findNode(nodes, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        if (!small || !large) {
          throw new Error(
            `snapshot -i 未识别可拖拽方块 (found=${JSON.stringify(nodes.map((n) => `${n.role}:${n.name}:${n.ref}`))})`,
          );
        }
        h.drag(small.ref, large.ref);
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h), `via snapshot refs ${small.ref}->${large.ref}`);
      },
    },
    {
      suite: 'miniwob-core',
      id: 'miniwob:use-autocomplete-nodelay',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'use-autocomplete-nodelay');
        const startMatch = q.match(/starts with "([^"]+)"/i)?.[1] ?? '';
        const endMatch = q.match(/ends with "([^"]+)"/i)?.[1] ?? '';
        const nodes1 = h.snapshot();
        const input = findNode(nodes1, (n) => /textbox/i.test(n.role));
        const submit = findNode(nodes1, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        h.fill(input.ref, startMatch, ['--no-changes']);
        h.waitMs(200);
        const nodes2 = h.snapshot();
        const item = findNode(nodes2, (n) => {
          if (/button|textbox/i.test(n.role)) return false;
          const label = norm(n.name);
          return (
            label.toLowerCase().startsWith(startMatch.toLowerCase()) &&
            (!endMatch || label.toLowerCase().endsWith(endMatch.toLowerCase()))
          );
        });
        if (!item) {
          throw new Error(
            `未在自动补全浮层找到匹配项 starts="${startMatch}" ends="${endMatch}" (nodes=${JSON.stringify(nodes2.map((n) => `${n.role}:${n.name}`))})`,
          );
        }
        h.click(item.ref, ['--no-changes']);
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h), `picked="${item.name}"`);
      },
    },
  ];
}

// ---------- Suite 2: MiniWoB++ Hard / Multi-Step (9 项) ----------

function miniwobHardTasks(baseUrl) {
  return [
    {
      suite: 'miniwob-hard',
      id: 'miniwob-hard:click-collapsible-2',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'click-collapsible-2');
        const target = q.match(/"([^"]+)"/)?.[1];
        for (let i = 1; i <= 3; i++) {
          const nodes = h.snapshot();
          const link = findNode(nodes, (n) => /(link|clickable)/i.test(n.role) && norm(n.name) === target);
          if (link) {
            h.click(link.ref);
            return assertMiniwobPass(readMiniwobReward(h), `found in section ${i - 1}`);
          }
          const sec = findNode(
            nodes,
            (n) => /(tab|button|heading|clickable)/i.test(n.role) && new RegExp(`Section\\s*#${i}`, 'i').test(n.name),
          );
          if (!sec) throw new Error(`未找到 Section #${i}`);
          h.click(sec.ref, ['--no-changes']);
          h.waitMs(250);
        }
        const finalNodes = h.snapshot();
        const link = findNode(finalNodes, (n) => /(link|clickable)/i.test(n.role) && norm(n.name) === target);
        if (!link) throw new Error(`展开 3 个分区后仍未找到链接 "${target}"`);
        h.click(link.ref);
        return assertMiniwobPass(readMiniwobReward(h), 'found in section 3');
      },
    },
    {
      suite: 'miniwob-hard',
      id: 'miniwob-hard:click-tab-2-hard',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'click-tab-2-hard');
        const target = q.match(/"([^"]+)"/)?.[1];
        const firstNodes = h.snapshot();
        const tabNames = firstNodes
          .filter((n) => n.ref && /(tab|link)/i.test(n.role) && /^\d+$/.test(norm(n.name)))
          .map((n) => norm(n.name));
        for (const tabName of tabNames) {
          const nodes = h.snapshot();
          const link = findNode(nodes, (n) => /(link|clickable)/i.test(n.role) && norm(n.name) === target);
          if (link) {
            h.click(link.ref);
            return assertMiniwobPass(readMiniwobReward(h), `tabs=${tabNames.length}`);
          }
          const tab = findNode(nodes, (n) => /(tab|link)/i.test(n.role) && norm(n.name) === tabName);
          if (tab) {
            h.click(tab.ref, ['--no-changes']);
            const after = h.snapshot();
            const found = findNode(after, (n) => /(link|clickable)/i.test(n.role) && norm(n.name) === target);
            if (found) {
              h.click(found.ref);
              return assertMiniwobPass(readMiniwobReward(h), `hit on tab ${tabName}/${tabNames.length}`);
            }
          }
        }
        throw new Error(`遍历 ${tabNames.length} 个标签页仍未找到 "${target}"`);
      },
    },
    {
      suite: 'miniwob-hard',
      id: 'miniwob-hard:navigate-tree',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'navigate-tree');
        const target = q.match(/"([^"]+)"/)?.[1];
        for (let round = 0; round < 12; round++) {
          const nodes = h.snapshot();
          // 精准匹配可见节点（文件夹或文件）
          const hit = findNode(nodes, (n) => norm(n.name) === target);
          if (hit) {
            h.click(hit.ref);
            const r = readMiniwobReward(h);
            if (r.done && r.raw > 0) return assertMiniwobPass(r, `rounds=${round + 1}`);
          }
          // 找到当前仍折叠的文件夹，仅点文件夹不误点文件
          const collapsedFolders = h.evalJs(
            `[...document.querySelectorAll('#tree li.expandable')].filter((li) => li.offsetParent !== null).map((li) => {
              const sp = li.querySelector(':scope > span.folder');
              return sp ? sp.textContent.trim() : '';
            }).filter(Boolean)`,
          );
          if (!Array.isArray(collapsedFolders) || collapsedFolders.length === 0) break;
          const folderName = collapsedFolders[0];
          const folderNode = findNode(nodes, (n) => norm(n.name) === folderName);
          if (!folderNode) throw new Error(`折叠文件夹 "${folderName}" 未出现在 snapshot -i`);
          h.click(folderNode.ref, ['--no-changes']);
        }
        return assertMiniwobPass(readMiniwobReward(h), `target=${target}`);
      },
    },
    {
      suite: 'miniwob-hard',
      id: 'miniwob-hard:click-checkboxes-large',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'click-checkboxes-large');
        const rawList = q.replace(/^Select\s+/i, '').replace(/\s+and click Submit\.?$/i, '');
        const wanted = rawList === 'nothing' ? [] : rawList.split(/,\s*/).map(norm).filter(Boolean);
        const nodes = h.snapshot();
        for (const label of wanted) {
          const cb = findNode(nodes, (n) => /checkbox/i.test(n.role) && norm(n.name) === label);
          if (!cb) throw new Error(`未找到复选框 "${label}"`);
          h.click(cb.ref, ['--no-changes']);
        }
        const submit = findNode(nodes, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h), `${wanted.length} checkboxes`);
      },
    },
    {
      suite: 'miniwob-hard',
      id: 'miniwob-hard:multi-layouts',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'multi-layouts');
        const m = q.match(/Search for\s+(.+?)\s+movies directed by\s+(.+?)\s+from year\s+(\d{4})/i);
        if (!m) throw new Error(`无法解析 query: ${q}`);
        const [, genre, director, year] = m;
        // 识别 5 种随机 DOM 布局的字段顺序（含 label 在 input 后方的情况），实际填表仍全走 snapshot @N
        const fieldOrder = h.evalJs(
          `[...document.querySelectorAll('#area input[type="text"]')].map((inp) => {
            const row = inp.closest('p, tr, .row, .field, .ui-entry') || inp.parentElement;
            const txt = (row?.textContent || '').toLowerCase();
            if (txt.includes('genre')) return 'genre';
            if (txt.includes('director')) return 'director';
            return 'year';
          })`,
        );
        const valueByKey = { genre, director, year };
        const nodes = h.snapshot();
        const boxes = nodes.filter((n) => n.ref && /textbox/i.test(n.role));
        if (boxes.length !== 3) throw new Error(`预期 3 个输入框，实际 ${boxes.length}`);
        for (let i = 0; i < 3; i++) {
          h.fill(boxes[i].ref, valueByKey[fieldOrder[i]], ['--no-changes']);
        }
        const submit = findNode(
          nodes,
          (n) => /(button|clickable)/i.test(n.role) && /^(submit|search|go!)$/i.test(norm(n.name)),
        );
        if (!submit) throw new Error('未在随机布局中识别到提交按钮（含 div.final / div.ui-submit）');
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h), `submit=${submit.role}:"${submit.name}"`);
      },
    },
    {
      suite: 'miniwob-hard',
      id: 'miniwob-hard:search-engine',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'search-engine');
        const term = q.match(/enter "([^"]+)"/i)?.[1];
        const pos = Number(q.match(/click the (\d+)(?:st|nd|rd|th)/i)?.[1]);
        if (!term || !pos) throw new Error(`无法解析 query: ${q}`);
        const nodes1 = h.snapshot();
        const input = findNode(nodes1, (n) => /textbox/i.test(n.role));
        const searchBtn = findNode(nodes1, (n) => /button/i.test(n.role) && /search/i.test(n.name));
        h.fill(input.ref, term, ['--no-changes']);
        h.click(searchBtn.ref, ['--no-changes']);
        const targetPage = Math.ceil(pos / 3);
        const indexInPage = (pos - 1) % 3;
        if (targetPage > 1) {
          const nodes2 = h.snapshot();
          const pageLink = findNode(nodes2, (n) => /link/i.test(n.role) && norm(n.name) === String(targetPage));
          if (!pageLink) throw new Error(`未找到第 ${targetPage} 页分页链接`);
          h.click(pageLink.ref, ['--no-changes']);
        }
        const nodes3 = h.snapshot();
        const resultLinks = nodes3.filter(
          (n) => n.ref && /link/i.test(n.role) && !/^(<|>|\d+|Previous|Next|First|Last)$/i.test(norm(n.name)),
        );
        const picked = resultLinks[indexInPage];
        if (!picked) throw new Error(`第 ${targetPage} 页未找到第 ${indexInPage + 1} 条结果链接`);
        h.click(picked.ref);
        return assertMiniwobPass(readMiniwobReward(h), `page=${targetPage} idx=${indexInPage + 1}`);
      },
    },
    {
      suite: 'miniwob-hard',
      id: 'miniwob-hard:use-spinner',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'use-spinner');
        const target = Number(q.match(/Select\s+(-?\d+)/i)?.[1]);
        const nodes = h.snapshot();
        const submit = findNode(nodes, (n) => /button/i.test(n.role) && /submit/i.test(n.name));
        const dirSelector = target >= 0 ? 'a.ui-spinner-up' : 'a.ui-spinner-down';
        const stepsNeeded = Math.abs(target);
        for (let i = 0; i < stepsNeeded; i++) {
          h.click(dirSelector, ['--no-changes']);
        }
        h.click(submit.ref);
        return assertMiniwobPass(readMiniwobReward(h), `target=${target}, clicks=${stepsNeeded}`);
      },
    },
    {
      suite: 'miniwob-hard',
      id: 'miniwob-hard:email-inbox-star-reply',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'email-inbox-star-reply');
        const sender = q.match(/email by\s+(.+?)\s+and\s+/i)?.[1]?.trim();
        const isReply = /reply to them/i.test(q);
        const replyText = q.match(/with the text "([^"]+)"/i)?.[1] ?? '';
        const nodes1 = h.snapshot();
        const thread = findNode(nodes1, (n) => /clickable/i.test(n.role) && norm(n.name).includes(sender));
        if (!thread) throw new Error(`未在收件箱快照中找到发件人 "${sender}"`);
        h.click(thread.ref, ['--no-changes']);
        if (!isReply) {
          const nodes2 = h.snapshot();
          const starRef = findNode(nodes2, (n) => /star/i.test(n.name));
          if (!starRef) {
            throw new Error(
              `邮件详情中未在 snapshot -i 识别到星标图标按钮 (nodes=${JSON.stringify(nodes2.map((n) => `${n.role}:${n.name}`))})`,
            );
          }
          h.click(starRef.ref);
          return assertMiniwobPass(readMiniwobReward(h), `action=star, via snapshot ref ${starRef.ref}`);
        }
        const nodes2 = h.snapshot();
        const replyBtn =
          findNode(nodes2, (n) => /(clickable|button)/i.test(n.role) && /^reply$/i.test(norm(n.name))) ||
          findNode(nodes2, (n) => /(clickable|button)/i.test(n.role) && /reply/i.test(n.name));
        if (!replyBtn) throw new Error('邮件详情中未找到 Reply 按钮');
        h.click(replyBtn.ref, ['--no-changes']);
        const nodes3 = h.snapshot();
        const textarea = findNode(nodes3, (n) => /textbox/i.test(n.role));
        if (!textarea) throw new Error('未找到回复文本框');
        h.fill(textarea.ref, replyText, ['--no-changes']);
        const sendRef = findNode(nodes3, (n) => /send/i.test(n.name));
        if (!sendRef) {
          throw new Error(
            `回复页中未在 snapshot -i 识别到发送图标按钮 (nodes=${JSON.stringify(nodes3.map((n) => `${n.role}:${n.name}`))})`,
          );
        }
        h.click(sendRef.ref);
        return assertMiniwobPass(readMiniwobReward(h), `action=reply, via snapshot ref ${sendRef.ref}`);
      },
    },
    {
      suite: 'miniwob-hard',
      id: 'miniwob-hard:book-flight-nodelay',
      run: (h) => {
        const q = startMiniwob(h, baseUrl, 'book-flight-nodelay');
        const m = q.match(
          /Book the\s+(cheapest|shortest)\s+one-way flight from:\s+(.+?)\s+to:\s+(.+?)\s+on\s+(\d{2})\/(\d{2})\/(\d{4})/i,
        );
        if (!m) throw new Error(`无法解析机票 query: ${q}`);
        const [, mode, origin, dest, mmStr, ddStr, yyyyStr] = m;
        const targetMonth = Number(mmStr); // 1..12
        const targetDay = Number(ddStr);
        const targetYear = Number(yyyyStr);

        const nodes0 = h.snapshot();
        const textboxes = nodes0.filter((n) => n.ref && /textbox/i.test(n.role));
        const searchBtn = findNode(nodes0, (n) => /button/i.test(n.role) && /search/i.test(n.name));
        if (textboxes.length < 3 || !searchBtn) throw new Error(`订票表单控件不完整: boxes=${textboxes.length}`);

        // 1) 出发地 Autocomplete
        h.fill(textboxes[0].ref, origin, ['--no-changes']);
        h.waitMs(150);
        const fromOpts = h.snapshot();
        const fromPick = findNode(
          fromOpts,
          (n) => !/button|textbox/i.test(n.role) && norm(n.name).toLowerCase().includes(origin.toLowerCase()),
        );
        if (!fromPick) throw new Error(`出发地自动补全未找到 "${origin}"`);
        h.click(fromPick.ref, ['--no-changes']);

        // 2) 目的地 Autocomplete
        h.fill(textboxes[1].ref, dest, ['--no-changes']);
        h.waitMs(150);
        const toOpts = h.snapshot();
        const toPick = findNode(
          toOpts,
          (n) => !/button|textbox/i.test(n.role) && norm(n.name).toLowerCase().includes(dest.toLowerCase()),
        );
        if (!toPick) throw new Error(`目的地自动补全未找到 "${dest}"`);
        h.click(toPick.ref, ['--no-changes']);

        // 3) Readonly Datepicker 翻月选日
        h.click(textboxes[2].ref, ['--no-changes']);
        h.waitMs(150);
        for (let guard = 0; guard < 12; guard++) {
          const cur = h.evalJs(
            '({ m: document.querySelector(".ui-datepicker-month")?.textContent?.trim() || "", y: Number(document.querySelector(".ui-datepicker-year")?.textContent?.trim() || 0) })',
          );
          const curMonth = MONTH_NAMES.indexOf(cur.m) + 1;
          const diff = (targetYear - cur.y) * 12 + (targetMonth - curMonth);
          if (diff === 0) break;
          const calNodes = h.snapshot();
          const navName = diff > 0 ? 'Next' : 'Prev';
          const navBtn = findNode(calNodes, (n) => norm(n.name) === navName);
          h.click(navBtn ? navBtn.ref : diff > 0 ? '.ui-datepicker-next' : '.ui-datepicker-prev', ['--no-changes']);
        }
        const dayNodes = h.snapshot();
        const dayLink = findNode(dayNodes, (n) => /link/i.test(n.role) && norm(n.name) === String(targetDay));
        if (!dayLink) throw new Error(`日历中未找到日期 ${targetDay}`);
        h.click(dayLink.ref, ['--no-changes']);

        // 4) 搜索并在多条航班中比价/比时长下单
        h.click(searchBtn.ref, ['--no-changes']);
        const flights = h.evalJs(
          `[...document.querySelectorAll('#results .flight')].map((f, idx) => ({
            idx,
            price: Number(f.querySelector('.flight-price')?.getAttribute('data-price') || 999999),
            duration: Number(f.querySelector('.time-duration')?.getAttribute('data-duration') || 999999999),
          }))`,
        );
        if (!Array.isArray(flights) || flights.length === 0) throw new Error('航班列表为空');
        const best = flights.reduce((a, b) =>
          mode === 'cheapest' ? (b.price < a.price ? b : a) : b.duration < a.duration ? b : a,
        );
        const resNodes = h.snapshot();
        const bookBtns = resNodes.filter((n) => n.ref && /button/i.test(n.role) && /Book flight for/i.test(n.name));
        if (!bookBtns[best.idx]) throw new Error(`未找到第 ${best.idx} 条航班预订按钮`);
        h.click(bookBtns[best.idx].ref);
        return assertMiniwobPass(readMiniwobReward(h), `mode=${mode}, flights=${flights.length}`);
      },
    },
  ];
}

// ---------- Suite 3: Online DOM Core (10 项: UITP 6 + Herokuapp 4) ----------

function onlineDomTasks() {
  return [
    {
      suite: 'online-dom',
      id: 'uitp:dynamicid',
      run: (h) => {
        h.open('http://uitestingplayground.com/dynamicid');
        const nodes = h.snapshot();
        const btn = findNode(nodes, (n) => /button/i.test(n.role) && /Button with Dynamic ID/i.test(n.name));
        if (!btn) throw new Error('未找到动态 ID 按钮');
        h.click(btn.ref);
        return `clicked ${btn.ref}`;
      },
    },
    {
      suite: 'online-dom',
      id: 'uitp:loaddelay',
      run: (h) => {
        h.open('http://uitestingplayground.com/');
        const nodes1 = h.snapshot();
        const link = findNode(nodes1, (n) => /link/i.test(n.role) && /Load Delay/i.test(n.name));
        h.click(link.ref, ['--no-wait', '--no-changes']);
        h.waitText('Button Appearing After Delay', 15_000);
        const nodes2 = h.snapshot();
        const btn = findNode(nodes2, (n) => /button/i.test(n.role) && /Button Appearing After Delay/i.test(n.name));
        if (!btn) throw new Error('延迟按钮未出现');
        h.click(btn.ref);
        return `waited & clicked ${btn.ref}`;
      },
    },
    {
      suite: 'online-dom',
      id: 'uitp:hiddenlayers',
      run: (h) => {
        h.open('http://uitestingplayground.com/hiddenlayers');
        const nodes = h.snapshot();
        const btn = findNode(nodes, (n) => /button/i.test(n.role) && norm(n.name) === 'Button');
        h.click(btn.ref);
        // 第二次点击被蓝色层遮挡的绿按钮，必须被 Warren 准确拦截为 TARGET_OCCLUDED / TIMEOUT
        const second = h.clickRaw('#greenButton');
        if (second.ok) throw new Error('错误地穿透遮挡层点中了 #greenButton');
        const msg = second.stderr || second.stdout;
        if (!/TARGET_OCCLUDED|遮挡/.test(msg)) throw new Error(`未报告遮挡错误: ${msg.slice(0, 140)}`);
        return 'occlusion correctly blocked (TARGET_OCCLUDED)';
      },
    },
    {
      suite: 'online-dom',
      id: 'uitp:shadowdom',
      run: (h) => {
        h.open('http://uitestingplayground.com/shadowdom');
        // 严格验证改造项 1：snapshot -i 穿透 Open Shadow DOM 拿 @N，直接 browser click @N 成功生成 UUID
        const nodes = h.snapshot();
        const genBtn = nodes.find(
          (n) => n.ref && /button/i.test(n.role) && !/Toggle navigation|Resources|Home/i.test(n.name),
        );
        if (!genBtn)
          throw new Error(
            `Shadow DOM 内未发现生成按钮: ${JSON.stringify(nodes.map((n) => `${n.role}:${n.name}:${n.ref}`))}`,
          );
        h.click(genBtn.ref);
        const val = h.evalJs(
          'document.querySelector("guid-generator")?.shadowRoot?.querySelector("#editField")?.value || ""',
        );
        if (!/^[0-9a-f-]{32,36}$/i.test(val)) throw new Error(`点击 ${genBtn.ref} 后未生成有效 UUID: "${val}"`);
        return `clicked shadow ${genBtn.ref}, uuid=${val.slice(0, 8)}...`;
      },
    },
    {
      suite: 'online-dom',
      id: 'uitp:overlapped',
      run: (h) => {
        h.open('http://uitestingplayground.com/overlapped');
        h.fill('#name', 'WarrenBot');
        const val = h.evalJs('document.querySelector("#name")?.value || ""');
        if (val !== 'WarrenBot') throw new Error(`期望 WarrenBot，实际 "${val}"`);
        return 'scrolled & filled #name=WarrenBot';
      },
    },
    {
      suite: 'online-dom',
      id: 'uitp:textinput',
      run: (h) => {
        h.open('http://uitestingplayground.com/textinput');
        const nodes = h.snapshot();
        const input = findNode(nodes, (n) => /textbox/i.test(n.role));
        const btn = findNode(nodes, (n) => /button/i.test(n.role) && /Button That Should/i.test(n.name));
        h.fill(input.ref, 'WarrenV4', ['--no-changes']);
        h.click(btn.ref);
        const updated = norm(h.evalJs('document.querySelector("#updatingButton")?.textContent || ""'));
        if (updated !== 'WarrenV4') throw new Error(`按钮文案未更新: "${updated}"`);
        return 'button text updated to WarrenV4';
      },
    },
    {
      suite: 'online-dom',
      id: 'internet:iframe',
      run: (h) => {
        h.open('https://the-internet.herokuapp.com/iframe');
        const frames = h.frameList();
        const childFrames = frames.filter((f) => f.index > 0);
        const editorFrame =
          childFrames.find((f) => /mce|srcdoc/i.test(String(f.name || f.url || ''))) || childFrames[0];
        if (!editorFrame) throw new Error(`未发现子 iframe: ${JSON.stringify(frames)}`);
        h.frameSelect(String(editorFrame.index));
        const bodyText = norm(h.evalJs('document.body?.innerText || ""'));
        h.frameSelect('main');
        if (!/Your content goes here/i.test(bodyText)) throw new Error(`子 iframe 内容异常: "${bodyText}"`);
        return `frames=${frames.length}, iframe[${editorFrame.name || editorFrame.index}] body OK`;
      },
    },
    {
      suite: 'online-dom',
      id: 'internet:dynamic_loading',
      run: (h) => {
        h.open('https://the-internet.herokuapp.com/dynamic_loading/2');
        const nodes = h.snapshot();
        const startBtn = findNode(nodes, (n) => /button/i.test(n.role) && /^Start$/i.test(norm(n.name)));
        h.click(startBtn.ref, ['--no-changes']);
        h.waitText('Hello World!', 15_000);
        return 'waited async "Hello World!"';
      },
    },
    {
      suite: 'online-dom',
      id: 'internet:javascript_alerts',
      run: (h) => {
        h.open('https://the-internet.herokuapp.com/javascript_alerts');
        const nodes = h.snapshot();
        const alertBtn = findNode(nodes, (n) => /button/i.test(n.role) && /JS Alert/i.test(n.name));
        const confirmBtn = findNode(nodes, (n) => /button/i.test(n.role) && /JS Confirm/i.test(n.name));
        // 1) Alert accept
        h.click(alertBtn.ref, ['--no-wait', '--no-changes']);
        h.dialog('accept');
        const r1 = norm(h.evalJs('document.querySelector("#result")?.textContent || ""'));
        if (!/successfully clicked an alert/i.test(r1)) throw new Error(`Alert 结果不符: "${r1}"`);
        // 2) Confirm accept
        h.click(confirmBtn.ref, ['--no-wait', '--no-changes']);
        h.dialog('accept');
        const r2 = norm(h.evalJs('document.querySelector("#result")?.textContent || ""'));
        if (!/You clicked: Ok/i.test(r2)) throw new Error(`Confirm(accept) 结果不符: "${r2}"`);
        // 3) Confirm dismiss
        h.click(confirmBtn.ref, ['--no-wait', '--no-changes']);
        h.dialog('dismiss');
        const r3 = norm(h.evalJs('document.querySelector("#result")?.textContent || ""'));
        if (!/You clicked: Cancel/i.test(r3)) throw new Error(`Confirm(dismiss) 结果不符: "${r3}"`);
        return 'alert(accept) + confirm(accept/dismiss) OK [Electron 无原生 window.prompt]';
      },
    },
    {
      suite: 'online-dom',
      id: 'internet:context_menu',
      run: (h) => {
        h.open('https://the-internet.herokuapp.com/context_menu');
        h.click('#hot-spot', ['--button=right', '--no-wait', '--no-changes']);
        h.dialog('accept');
        return 'right-click + native alert accepted';
      },
    },
  ];
}

// ---------- Suite 4: Online Hard (8 项: UITP 3 + Herokuapp 5) ----------

function onlineHardTasks() {
  return [
    {
      suite: 'online-hard',
      id: 'uitp:dynamictable',
      run: (h) => {
        h.open('http://uitestingplayground.com/dynamictable');
        const res = h.evalJs(`(() => {
          const headers = [...document.querySelectorAll('[role="columnheader"]')].map((e) => e.textContent.trim());
          const cpuIdx = headers.indexOf('CPU');
          const rows = [...document.querySelectorAll('[role="row"]')];
          const chromeRow = rows.find((r) => (r.querySelector('[role="cell"]')?.textContent || '').trim() === 'Chrome');
          const cells = chromeRow ? [...chromeRow.querySelectorAll('[role="cell"]')].map((e) => e.textContent.trim()) : [];
          const banner = (document.querySelector('.bg-warning')?.textContent || '').trim();
          return { cpuIdx, tableVal: cells[cpuIdx] || '', banner };
        })()`);
        if (res.cpuIdx < 0 || !res.tableVal || !res.banner.includes(res.tableVal)) {
          throw new Error(`动态表格校验失败: ${JSON.stringify(res)}`);
        }
        return `col[${res.cpuIdx}] Chrome CPU=${res.tableVal} matched banner`;
      },
    },
    {
      suite: 'online-hard',
      id: 'uitp:visibility',
      run: (h) => {
        h.open('http://uitestingplayground.com/visibility');
        const nodes = h.snapshot();
        const hideBtn = findNode(nodes, (n) => /button/i.test(n.role) && /^Hide$/i.test(norm(n.name)));
        h.click(hideBtn.ref);
        // 核验 5 个应判定不可见 + 1 个仍可见的 Hide 按钮 + 1 个被遮挡（visible 但点击应被 TARGET_OCCLUDED 拦下）
        const checks = [
          ['#hideButton', true],
          ['#removedButton', false],
          ['#zeroWidthButton', false],
          ['#transparentButton', false],
          ['#invisibleButton', false],
          ['#notdisplayedButton', false],
        ];
        const mismatches = [];
        for (const [sel, expected] of checks) {
          const actual = h.isVisible(sel).value;
          if (actual !== expected) mismatches.push(`${sel}: expected=${expected} actual=${actual}`);
        }
        // Overlapped 按钮在 DOM 上可见，但尝试点击必须被 TARGET_OCCLUDED 拦住
        const clickOverlapped = h.clickRaw('#overlappedButton');
        if (clickOverlapped.ok) mismatches.push('#overlappedButton: 点击未被遮挡拦截');
        if (mismatches.length > 0) throw new Error(mismatches.join('; '));
        return '6/6 visibility states + overlapped occlusion blocked';
      },
    },
    {
      suite: 'online-hard',
      id: 'uitp:mouseover',
      run: (h) => {
        h.open('http://uitestingplayground.com/mouseover');
        const nodes1 = h.snapshot();
        const link1 = findNode(nodes1, (n) => /(link|clickable)/i.test(n.role) && /Click me/i.test(n.name));
        if (!link1) throw new Error('未找到 Click me 链接');
        // 首次点击触发 onmouseenter 替换 DOM 为新 <a>，再通过新快照拿到替换后的 @N 点击第二次
        h.click(link1.ref, ['--no-changes']);
        const nodes2 = h.snapshot();
        const link2 = findNode(nodes2, (n) => /(link|clickable)/i.test(n.role) && /Click me/i.test(n.name));
        if (!link2) throw new Error('DOM 替换后未找到新的 Click me 链接');
        h.click(link2.ref);
        const cnt = norm(h.evalJs('document.querySelector("#clickCount")?.textContent || ""'));
        if (cnt !== '2') throw new Error(`预期 clickCount=2，实际 "${cnt}"`);
        return `hover-replaced link clicked via ${link1.ref} -> ${link2.ref} (clickCount=2)`;
      },
    },
    {
      suite: 'online-hard',
      id: 'internet:dynamic_controls',
      run: (h) => {
        h.open('https://the-internet.herokuapp.com/dynamic_controls');
        const nodes1 = h.snapshot();
        const removeBtn = findNode(nodes1, (n) => /button/i.test(n.role) && /^Remove$/i.test(norm(n.name)));
        h.click(removeBtn.ref, ['--no-changes']);
        h.waitText("It's gone!", 12_000);
        const nodes2 = h.snapshot();
        const enableBtn = findNode(nodes2, (n) => /button/i.test(n.role) && /^Enable$/i.test(norm(n.name)));
        h.click(enableBtn.ref, ['--no-changes']);
        h.waitText("It's enabled!", 12_000);
        const nodes3 = h.snapshot();
        const input = findNode(nodes3, (n) => /textbox/i.test(n.role));
        h.fill(input.ref, 'WarrenUnlocked');
        const val = h.evalJs('document.querySelector("#input-example input")?.value || ""');
        if (val !== 'WarrenUnlocked') throw new Error(`解锁后输入失败: "${val}"`);
        return 'removed checkbox + unlocked disabled input + filled OK';
      },
    },
    {
      suite: 'online-hard',
      id: 'internet:nested_frames',
      run: (h) => {
        h.open('https://the-internet.herokuapp.com/nested_frames');
        const frames = h.frameList();
        const expected = [
          ['frame_left', 'LEFT'],
          ['frame_middle', 'MIDDLE'],
          ['frame_right', 'RIGHT'],
          ['frame_bottom', 'BOTTOM'],
        ];
        const read = [];
        for (const [urlPart, want] of expected) {
          h.frameSelect(urlPart);
          const txt = norm(h.evalJs('document.body?.innerText || ""'));
          if (txt !== want) throw new Error(`frame(${urlPart}) 预期 "${want}"，实际 "${txt}"`);
          read.push(txt);
        }
        h.frameSelect('main');
        return `frames=${frames.length}, read [${read.join('/')}]`;
      },
    },
    {
      suite: 'online-hard',
      id: 'internet:tables',
      run: (h) => {
        h.open('https://the-internet.herokuapp.com/tables');
        const before = h.evalJs(
          '[...document.querySelectorAll("#table1 tbody tr td:first-child")].map((e) => e.textContent.trim())',
        );
        h.click('#table1 thead th:first-child');
        const after1 = h.evalJs(
          '[...document.querySelectorAll("#table1 tbody tr td:first-child")].map((e) => e.textContent.trim())',
        );
        const sortedAsc = [...before].sort((a, b) => a.localeCompare(b));
        if (JSON.stringify(after1) !== JSON.stringify(sortedAsc)) {
          throw new Error(`排序未生效: before=${JSON.stringify(before)} after=${JSON.stringify(after1)}`);
        }
        return `sorted Last Name: ${after1.join(', ')}`;
      },
    },
    {
      suite: 'online-hard',
      id: 'internet:hovers',
      run: (h) => {
        h.open('https://the-internet.herokuapp.com/hovers');
        h.hover('.figure >> nth=0');
        const nodes = h.snapshot();
        const profileLink = findNode(nodes, (n) => /link/i.test(n.role) && /View profile/i.test(n.name));
        if (!profileLink) throw new Error('hover 后未显现 View profile 链接');
        h.click(profileLink.ref);
        const url = h.evalJs('location.href');
        if (!/\/users\/1\b/.test(url)) throw new Error(`跳转 URL 异常: ${url}`);
        return `hovered & navigated to ${url}`;
      },
    },
    {
      suite: 'online-hard',
      id: 'internet:upload',
      run: (h) => {
        const tmpFile = '/tmp/warren-bench-upload.txt';
        fs.writeFileSync(tmpFile, `warren-bench-upload-${Date.now()}\n`, 'utf8');
        try {
          h.open('https://the-internet.herokuapp.com/upload');
          h.upload('#file-upload', tmpFile);
          const nodes = h.snapshot();
          const submit = findNode(nodes, (n) => /button/i.test(n.role) && /^Upload$/i.test(norm(n.name)));
          h.click(submit.ref);
          h.waitText('File Uploaded!', 12_000);
          const uploaded = norm(h.evalJs('document.querySelector("#uploaded-files")?.textContent || ""'));
          if (uploaded !== 'warren-bench-upload.txt') throw new Error(`回显文件名不符: "${uploaded}"`);
          return `uploaded ${uploaded}`;
        } finally {
          fs.rmSync(tmpFile, { force: true });
        }
      },
    },
  ];
}

function buildTasks(opts) {
  const map = {
    'miniwob-core': () => miniwobCoreTasks(opts.miniwobUrl),
    'miniwob-hard': () => miniwobHardTasks(opts.miniwobUrl),
    'online-dom': () => onlineDomTasks(),
    'online-hard': () => onlineHardTasks(),
  };
  const tasks = [];
  for (const s of opts.suites) {
    if (!map[s]) throw new Error(`未知 suite: ${s}（可选: ${ALL_SUITES.join(', ')}）`);
    tasks.push(...map[s]());
  }
  return opts.taskFilter ? tasks.filter((t) => t.id.includes(opts.taskFilter)) : tasks;
}

function createBenchEnv(envName, keepEnv) {
  const run = (args) =>
    execFileSync('node', [CLI_PATH, ...args, '--json'], {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 30_000,
    });
  if (keepEnv) {
    return envName;
  }
  const created = JSON.parse(run(['env', 'create', envName, '--space=agent']));
  const id = created.id || envName;
  run(['env', 'start', id]);
  return id;
}

function cleanupBenchEnv(envId, keepEnv) {
  if (keepEnv) return;
  for (const args of [
    ['env', 'stop', envId],
    ['env', 'remove', envId],
  ]) {
    try {
      execFileSync('node', [CLI_PATH, ...args], {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: 'ignore',
        timeout: 15_000,
      });
    } catch {
      // 忽略清理异常
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tasks = buildTasks(opts);
  if (tasks.length === 0) {
    console.error('没有匹配的任务');
    process.exit(1);
  }

  const envId = createBenchEnv(opts.envName, opts.keepEnv);
  const harness = new WarrenHarness(envId);
  const results = [];
  const startedAll = Date.now();

  try {
    for (const task of tasks) {
      harness.resetSteps();
      const t0 = Date.now();
      let passed = false;
      let detail = '';
      let error = '';
      try {
        detail = String(task.run(harness) ?? '');
        passed = true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        // 清理可能残留的弹窗或子 frame 选择，避免污染下一个任务
        try {
          harness.run(['browser', 'dialog', envId, 'dismiss']);
        } catch {}
        try {
          harness.run(['browser', 'frame', envId, 'select', 'main']);
        } catch {}
      }
      const durationMs = Date.now() - t0;
      const entry = {
        suite: task.suite,
        id: task.id,
        passed,
        steps: harness.steps,
        durationMs,
        detail,
        error,
      };
      results.push(entry);
      const badge = passed ? 'PASS' : 'FAIL';
      console.log(
        `[${badge}] ${task.id.padEnd(36)} ${String(harness.steps).padStart(2)} steps  ${String(durationMs).padStart(5)}ms  ${passed ? detail : error}`,
      );
    }
  } finally {
    cleanupBenchEnv(envId, opts.keepEnv);
  }

  const bySuite = {};
  for (const r of results) {
    if (!bySuite[r.suite]) bySuite[r.suite] = { passed: 0, total: 0, totalSteps: 0, totalMs: 0 };
    bySuite[r.suite].total += 1;
    if (r.passed) bySuite[r.suite].passed += 1;
    bySuite[r.suite].totalSteps += r.steps;
    bySuite[r.suite].totalMs += r.durationMs;
  }

  const totalPassed = results.filter((r) => r.passed).length;
  const totalMs = Date.now() - startedAll;
  console.log('\n=== Summary ===');
  for (const [suite, s] of Object.entries(bySuite)) {
    const pct = ((s.passed / s.total) * 100).toFixed(1);
    console.log(
      `  ${suite.padEnd(14)} ${s.passed}/${s.total} (${pct}%)  avgSteps=${(s.totalSteps / s.total).toFixed(1)}  total=${(s.totalMs / 1000).toFixed(1)}s`,
    );
  }
  console.log(
    `  TOTAL          ${totalPassed}/${results.length} (${((totalPassed / results.length) * 100).toFixed(1)}%)  elapsed=${(totalMs / 1000).toFixed(1)}s`,
  );

  if (opts.outPath) {
    fs.mkdirSync(path.dirname(path.resolve(opts.outPath)), { recursive: true });
    fs.writeFileSync(
      opts.outPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          suites: opts.suites,
          totalPassed,
          totalTasks: results.length,
          passRatePct: Number(((totalPassed / results.length) * 100).toFixed(1)),
          elapsedMs: totalMs,
          bySuite,
          results,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`Report written: ${opts.outPath}`);
  }

  process.exit(totalPassed === results.length ? 0 : 1);
}

main();
