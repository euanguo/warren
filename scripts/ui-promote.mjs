#!/usr/bin/env node
/**
 * Promote shadcn stock (ui-reference) → product components/ui.
 *
 *   shadcn add <name>  →  npm run ui:promote [name...]  →  edit components/ui
 *
 * 提升时会自动修掉 shadcn CLI 的产物问题（见下 REWRITES）——这些是 registry
 * 生成的文件固有的，不该由人每次手工修。
 */
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fromDir = join(root, 'src/renderer/components/ui-reference');
const toDir = join(root, 'src/renderer/components/ui');

const args = process.argv.slice(2).filter((a) => a !== '--force');
const force = process.argv.includes('--force');

/**
 * shadcn CLI 的产物问题，提升时自动改写：
 *
 * 1. `from "cn"` —— CLI 把 cn 写成裸 specifier，且顺手把 `cn` 包塞进 dependencies。
 *    本项目的 cn 在 @/lib/utils。
 * 2. `@/components/ui-reference/` —— registry 按 components.json 的 aliases.ui 生成
 *    导入，而那个别名指向 stock。产品层**禁止**依赖 stock，必须改指产品层。
 * 3. `"use client"` —— Next.js 指令，本项目是 Electron + Vite，没有意义。
 */
const REWRITES = [
  [/from\s+"cn"/g, 'from "@/lib/utils"'],
  [/@\/components\/ui-reference\//g, '@/components/ui/'],
  [/^["']use client["'];?\r?\n/gm, ''],
];

function promote(name) {
  const base = name.endsWith('.tsx') ? name : `${name}.tsx`;
  const src = join(fromDir, base);
  const dest = join(toDir, base);
  if (!existsSync(src)) {
    console.error(`missing stock: ${src}`);
    process.exitCode = 1;
    return;
  }
  if (existsSync(dest) && !force) {
    console.log(`skip existing product (use --force): ${base}`);
    return;
  }
  mkdirSync(toDir, { recursive: true });

  let text = readFileSync(src, 'utf8');
  const fixes = [];
  for (const [pattern, replacement] of REWRITES) {
    const before = text;
    text = text.replace(pattern, replacement);
    if (text !== before) fixes.push(String(pattern));
  }
  writeFileSync(dest, text);

  const note = fixes.length ? `  (已改写: ${fixes.length} 处 CLI 产物问题)` : '';
  console.log(`promoted ${base} → components/ui/${note}`);
}

const names = args.length > 0 ? args : readdirSync(fromDir).filter((f) => f.endsWith('.tsx'));

for (const n of names) promote(n);
