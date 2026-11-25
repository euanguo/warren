import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `<Icon name="…">` 里的名字必须真的在 `ICON_MAP` 里。
 *
 * `Icon` 对拼错的名字**不报错**，而是退到 fallback（闪电）。所以「设置」按钮写成
 * `name="Settings"`、而注册表里没有这个键时，界面上就是一个闪电，类型检查和运行
 * 都不吭声——实测同时出现过三个按钮全是闪电。这条测试把错名钉死在源码层。
 *
 * 走源码文本扫描而不是 import：`icons.tsx` 引 `@/lib/utils` 这个打包期别名，
 * `node --test` 直接加载 `.ts` 时解析不了（同 AGENTS 里 Node ESM 那条）。
 */

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RENDERER = path.join(root, 'src', 'renderer');
/** stock 快照永不 import，也不在 typecheck 里，不参与这条检查。 */
const SKIP = new Set(['ui-reference']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.tsx')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** 注册表里的键：`ICON_MAP` 字面量里缩进两格的 `Name: SomeIcon,`。 */
function registeredNames(): Set<string> {
  const source = readFileSync(path.join(RENDERER, 'components', 'icons.tsx'), 'utf8');
  const block = source.match(/const ICON_MAP = \{([\s\S]*?)\n\} as const satisfies/);
  assert.ok(block, 'icons.tsx 里找不到 ICON_MAP 字面量——注册表改名了，测试要跟着改');
  const names = [...block[1].matchAll(/^ {2}([A-Za-z0-9]+):/gm)].map((match) => match[1]);
  assert.ok(names.length > 0, 'ICON_MAP 解析出 0 个名字——正则和源码对不上了');
  return new Set(names);
}

test('every <Icon name="…"> is a name the registry actually has', () => {
  const known = registeredNames();
  const files = walk(RENDERER);
  assert.ok(files.length > 0, '一个渲染层文件都没扫到——扫描根目录错了');

  const unknown: string[] = [];
  let usages = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    // 只认字面量名字：`name={expr}` 是动态的，扫描器看不到也不该猜。
    for (const match of source.matchAll(/<Icon\b[^>]*?\bname="([^"]+)"/gs)) {
      usages += 1;
      if (!known.has(match[1])) {
        unknown.push(`${path.relative(root, file)}: name="${match[1]}"`);
      }
    }
  }

  // 没有用量的「全绿」等于扫描器坏了，不能算通过。
  assert.ok(usages >= 30, `只扫到 ${usages} 处 <Icon name="…">，正则多半失效了`);
  assert.deepEqual(unknown, [], `这些图标名不在 ICON_MAP 里，会静默退成 fallback：\n${unknown.join('\n')}`);
});
