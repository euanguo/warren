#!/usr/bin/env node
/**
 * 改动定向无头测试运行器（不启动 Electron 窗口）。
 *
 * 按 git 变更文件自动映射受影响的 `tests/*.test.ts` 与 `tests/ui/*.test.tsx`：
 * - 日常小改动只跑命中的无头用例，秒级反馈；
 * - 重大架构改造或跨多域变更时使用 `npm test` 或传 `--all` 跑全量无头测试；
 * - 支持 `--list` 仅打印命中清单，支持 `--base <ref>` 对比指定提交。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const forceAll = args.includes('--all');
const baseIdx = args.indexOf('--base');
const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : undefined;

const allUnitTests = readdirSync(path.join(ROOT, 'tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `tests/${name}`);

const allUiTests = readdirSync(path.join(ROOT, 'tests/ui'))
  .filter((name) => name.endsWith('.test.tsx'))
  .sort()
  .map((name) => `tests/ui/${name}`);

function collectChangedFiles() {
  const files = new Set();
  if (baseRef) {
    const out = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    for (const line of out.split('\n')) {
      const f = line.trim();
      if (f) files.add(f);
    }
  }
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    const renamed = raw.includes(' -> ') ? raw.split(' -> ').pop() : raw;
    if (renamed) files.add(renamed.replace(/^"|"$/g, ''));
  }
  return [...files];
}

const PATH_RULES = [
  {
    match: /^src\/renderer\/|vitest\.config\.ts$/,
    ui: allUiTests,
    unit: ['tests/shell-layout-interaction.test.ts', 'tests/icon-names.test.ts'],
  },
  { match: /^src\/renderer\/lib\/address-input\.ts$/, unit: ['tests/address-input.test.ts'] },
  {
    match: /^src\/shared\/popover-sizing\.ts$|^src\/main\/ui\//,
    unit: allUnitTests.filter((t) => /popover|devtools|layer|shell|shield/.test(t)),
    ui: ['tests/ui/shell-and-regressions.test.tsx'],
  },
  {
    match: /^src\/main\/browser\//,
    unit: allUnitTests.filter((t) =>
      /browser|input|snapshot|refs|target|login|batch|ops|remedy|page-contract|exec|paths|pending|wave0/.test(t),
    ),
  },
  { match: /^src\/main\/net\//, unit: allUnitTests.filter((t) => /net-|trusted-ca/.test(t)) },
  {
    match: /^src\/main\/(plugins\/|plugin-protocol\.ts|skills\/|agent-integration\.ts)|^packages\/plugin-sdk\//,
    unit: allUnitTests.filter((t) => /plugin|skill|account-manager|wave0/.test(t)),
  },
  { match: /^plugins\/account-manager\//, unit: ['tests/account-manager.test.ts', 'tests/wave0-hardening.test.ts'] },
  { match: /^plugins\/whistle\//, unit: allUnitTests.filter((t) => /whistle|wave0/.test(t)) },
  {
    match: /^src\/main\/(rpc\.ts|rpc\/|rpc-dispatch\.ts)/,
    unit: allUnitTests.filter((t) => /rpc|browser|env-|memory-management|wave0/.test(t)),
  },
  {
    match: /^src\/main\/(environments\.ts|env\/|tabs\.ts|domain\/|memory-monitor\.ts|telemetry\.ts)/,
    unit: allUnitTests.filter((t) =>
      /environment|env-|tabs|spaces|store|group|external-url|cookies|devtools|layer|paths|pending|memory-management|approval|wave0/.test(
        t,
      ),
    ),
  },
  {
    match: /^src\/main\/(db\.ts|store\.ts|store\/)/,
    unit: allUnitTests.filter((t) => /store|memory-management|plugin-registry|group|wave0/.test(t)),
  },
  {
    match:
      /^src\/main\/(main\.ts|ipc-routes\.ts|paths\.ts|doctor\.ts|diagnostics\.ts|newtab\.ts)|^src\/preload\/|^forge\.config\.cjs$/,
    unit: allUnitTests,
    ui: allUiTests,
  },
  {
    match: /^bin\//,
    unit: [
      'tests/cli-help.test.ts',
      'tests/rpc-dispatch.test.ts',
      'tests/memory-management.test.ts',
      'tests/wave0-hardening.test.ts',
    ],
  },
  {
    match: /^src\/shared\//,
    unit: allUnitTests,
    ui: allUiTests,
  },
];

const unitSet = new Set();
const uiSet = new Set();

if (forceAll) {
  for (const t of allUnitTests) unitSet.add(t);
  for (const t of allUiTests) uiSet.add(t);
} else {
  const changed = collectChangedFiles();
  for (const file of changed) {
    if (file.startsWith('tests/') && file.endsWith('.test.ts')) {
      unitSet.add(file);
      continue;
    }
    if (file.startsWith('tests/ui/') && file.endsWith('.test.tsx')) {
      uiSet.add(file);
      continue;
    }
    let matchedRule = false;
    for (const rule of PATH_RULES) {
      if (rule.match.test(file)) {
        matchedRule = true;
        for (const t of rule.unit ?? []) {
          if (allUnitTests.includes(t)) unitSet.add(t);
        }
        for (const t of rule.ui ?? []) {
          if (allUiTests.includes(t)) uiSet.add(t);
        }
      }
    }
    // 仅在未命中明确路径规则时按文件名精确匹配，避免 store/memory.ts 误撞 memory-management.test.ts
    if (!matchedRule) {
      const base = path.basename(file, path.extname(file));
      for (const candidate of allUnitTests) {
        if (candidate === `tests/${base}.test.ts`) unitSet.add(candidate);
      }
    }
  }
}

const unitList = [...unitSet].sort();
const uiList = [...uiSet].sort();

if (unitList.length === 0 && uiList.length === 0) {
  console.log('定向无头测试：当前改动无匹配测试用例，跳过。');
  process.exit(0);
}

console.log(`定向无头测试命中：unit ${unitList.length} 个，ui ${uiList.length} 个`);
if (listOnly) {
  for (const f of [...unitList, ...uiList]) console.log(`  - ${f}`);
  process.exit(0);
}

if (unitList.length > 0) {
  execFileSync(process.execPath, ['--test', ...unitList], { cwd: ROOT, stdio: 'inherit' });
}
if (uiList.length > 0) {
  const vitestBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
  execFileSync(vitestBin, ['run', ...uiList], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}
