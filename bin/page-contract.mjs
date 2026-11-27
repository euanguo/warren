/**
 * `warren exec` 里那个 `page` 对象的契约修正。
 *
 * 单独成文件是为了能测：`bin/warren.mjs` 一被 import 就会执行整个 CLI。
 *
 * 两件事都来自早期内部 E2E 审计（P1-6，审计文档未随仓库公开）：
 * 1. `snapshot()` 返回的是**结构**（`{url,title,nodes}`），agent 按字符串 `.slice()` 会报
 *    `undefined is not a function`；加一个 `toString()` 让它能当文本用，输出与
 *    `warren browser snapshot` 完全一致（同一份 `JSON.stringify(value, null, 2)`）。
 * 2. Playwright 里存在、这里没有的方法（`getByRole().nth()` / `locator.all()`）以前报
 *    `page.xxx is not a function`，agent 会以为是页面坏了；现在报 `UNSUPPORTED_PAGE_API`
 *    并点名去哪看可用清单（`warren exec --capabilities`）。
 */

/** `JSON.stringify(value, null, 2)` —— 与 `print()` 打印非数组结果时逐字一致。 */
export function snapshotText(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * 给 snapshot 结果挂一个**不可枚举**的 `toString`。
 *
 * 不可枚举是必须的：`JSON.stringify(snapshot)` 还得是原来那份结构，
 * `console.log(await page.snapshot())` 的输出也不能因此变样。
 */
export function withSnapshotText(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  Object.defineProperty(snapshot, 'toString', {
    value: () => snapshotText(snapshot),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return snapshot;
}

/**
 * 这些属性名**必须**返回 undefined 而不是报错：
 * - `then`：`await page` / `Promise.resolve(page)` 会去读它，报错会把「顺手 await 一下」变成崩；
 * - `toJSON` / `inspect`：`JSON.stringify` 与 `console.log` 的探测。
 */
const PROBED_PROPS = new Set(['then', 'toJSON', 'inspect']);

import { suggestClosestMethods } from './exec-api-schema.mjs';

/**
 * 包一层 Proxy：**只有访问不存在的属性**才报 `UNSUPPORTED_PAGE_API`，并附带最相近的合法方法推荐。
 *
 * 已存在的属性（含原型上的）原样返回；`in`、`ownKeys`、`JSON.stringify` 全都透传，
 * 所以 `JSON.stringify(page)`、`Object.keys(page)`、解构都不会受影响。
 *
 * `label` 只用于报错文案：`page` / `page.locator(...)` —— 说清是**哪一层**没有这个方法。
 */
export function guardApi(api, label) {
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
      if (PROBED_PROPS.has(prop)) return undefined;
      const suggestions = suggestClosestMethods(
        String(prop),
        Object.keys(target).filter((k) => typeof target[k] === 'function'),
        3,
      );
      const hint =
        suggestions.length > 0
          ? `；最相近的合法方法：${suggestions.join(', ')}（可用 help("${suggestions[0]}") 或 warren exec --capabilities --detailed）`
          : '，可用 help() 或 warren exec --capabilities --detailed 查清单';
      throw Object.assign(new Error(`UNSUPPORTED_PAGE_API: ${label}.${String(prop)} 不存在${hint}`), {
        code: 'UNSUPPORTED_PAGE_API',
        ...(suggestions.length > 0 ? { suggestions } : {}),
      });
    },
  });
}

export function guardPage(page) {
  return guardApi(page, 'page');
}
