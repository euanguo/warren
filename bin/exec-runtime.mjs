/**
 * `warren exec` 的运行时构造 —— **exec 里有什么，只有这一份**。
 *
 * 单独成文件的理由和 `bin/commands.mjs` 一样：`bin/warren.mjs` 一被 import 就会执行整个 CLI，
 * 所以要测「注入了哪些全局 / page 上有哪些方法」必须把这些逻辑放到可独立加载的模块里。
 *
 * 约束：**只能 import node 内置**（这里其实一个都不用）。不要把 `fs` 或任何模块加载器带进 VM ——
 * exec 脚本来自 agent，给它文件通道等于绕开 lease / 授权（见早期 E2E 改造方案的 WP2 方案 A）。
 */

/** exec VM 里注入的全局名。顺序即文档顺序。 */

import { guardApi, guardPage, withSnapshotText } from './page-contract.mjs';

export const EXEC_GLOBALS = ['page', 'console', 'setTimeout', 'clearTimeout', 'emitResult'];

/**
 * `emitResult(payload)` 打印的哨兵前缀。
 *
 * 与外部 E2E 宿主约定的**同一个**前缀：宿主侧按行扫这个前缀取结构化结果，
 * 不必再从日志里反解析，也不必让脚本自己拼一行 `console.log`。
 */
export const RESULT_SENTINEL = '__CONSOLE_E2E_RESULT__';

/**
 * 构造 `emitResult`。
 *
 * `write` 是注入点：CLI 用 `console.log`，测试给一个收集器。
 */
export function createEmitResult(write = (line) => console.log(line)) {
  return (payload) => {
    write(RESULT_SENTINEL + JSON.stringify(payload === undefined ? null : payload));
    return payload;
  };
}

/**
 * `page` 的形状。Playwright 形状的**子集**，不是完整 Playwright：
 * 没有 `context()` / `expect()` / `route()` / `setViewportSize()`，未知方法直接是 `undefined`。
 *
 * `call` 由 CLI 注入（`(method, params) => RPC`），所以这个模块不依赖运行中的核心。
 * 这是 `page` 的**唯一实现**：`--capabilities` 反射它，`warren exec` 装配它。
 */
export function createPageApi(call, { environmentId, leaseId, tabRef } = {}) {
  const scope = tabRef === undefined ? {} : { tabId: tabRef };
  const write = (method, params) => call(method, { id: environmentId, leaseId, ...scope, ...params });
  const read = (method, params) => call(method, { id: environmentId, ...scope, ...params });
  // 定位器 helper：Ego/Playwright 习惯的 getByXxx().click()，target 直接给字符串或老对象都行
  const locatorOf = (target) =>
    guardApi(
      {
        click: (opts) => write('browser.click', { target, ...opts }),
        dblclick: (opts) => write('browser.dblclick', { target, ...opts }),
        hover: (opts) => write('browser.hover', { target, ...opts }),
        fill: (value, opts) => write('browser.fill', { target, value, ...opts }),
        selectOption: (value, opts) => write('browser.selectOption', { target, value, ...opts }),
        focus: (opts) => write('browser.focus', { target, ...opts }),
        press: (chord, opts) => write('browser.press', { target, chord, ...opts }),
        setInputFiles: (paths) => write('browser.setInputFiles', { target, paths }),
        dragTo: (dest, opts) => write('browser.drag', { source: target, target: dest, ...opts }),
      },
      'page.locator(...)',
    );
  const page = {
    // 观察
    // snapshot 返回结构；挂个不可枚举 toString，`String(...)` / `.slice()` 也能用
    snapshot: async (options) => withSnapshotText(await read('browser.snapshot', options ?? {})),
    screenshot: (options) => read('browser.screenshot', options ?? {}),
    info: () => read('browser.info'),
    events: () => read('browser.events'),
    url: async () => (await read('browser.info')).url,
    title: async () => (await read('browser.info')).title,
    console: () => read('browser.console'),
    network: () => read('browser.network'),
    // 高亮给人看：不传 target = 清除。不改页面，所以是读。
    highlight: (target) => read('browser.highlight', { target }),
    // 导航
    goto: (url, options) => write('browser.navigate', { url, ...options }),
    reload: (options) => write('browser.reload', { ...options }),
    goBack: () => write('browser.goBack', {}),
    goForward: () => write('browser.goForward', {}),
    // 等待
    waitFor: (predicate, options) => read('browser.waitFor', { predicate, ...options }),
    waitForURL: (matcher, options) => read('browser.waitForURL', { matcher, ...options }),
    waitForSelector: (target, options) => read('browser.waitForSelector', { target, ...options }),
    waitForFunction: (fn, arg, options) =>
      read('browser.waitForFunction', {
        fn: typeof fn === 'function' ? fn.toString() : fn,
        arg,
        ...options,
      }),
    waitForLoadState: (state, options) => read('browser.waitForLoadState', { state, ...options }),
    waitForTimeout: (ms) => read('browser.waitForTimeout', { ms }),
    waitForEvent: (kind, options) => read('browser.waitForEvent', { kind, ...options }),
    // 元素动作
    click: (target, options) => write('browser.click', { target, ...options }),
    dblclick: (target, options) => write('browser.dblclick', { target, ...options }),
    hover: (target, options) => write('browser.hover', { target, ...options }),
    dragAndDrop: (source, target, options) => write('browser.drag', { source, target, ...options }),
    fill: (target, value, options) => write('browser.fill', { target, value, ...options }),
    selectOption: (target, value, options) => write('browser.selectOption', { target, value, ...options }),
    focus: (target, options) => write('browser.focus', { target, ...options }),
    // press(key) 老形式；press(target, chord) 先聚焦再按
    press: (a, b, c) =>
      typeof b === 'string'
        ? write('browser.press', { target: a, chord: b, ...c })
        : write('browser.press', { key: a, ...b }),
    setInputFiles: (target, paths) => write('browser.setInputFiles', { target, paths }),
    waitForFileChooser: (options) => read('browser.waitForEvent', { kind: 'fileChooser', ...options }),
    // 弹窗与下载
    acceptDialog: (prompt) => write('browser.acceptDialog', { prompt }),
    dismissDialog: () => write('browser.dismissDialog'),
    downloadSaveAs: (downloadId, path) => write('browser.downloadSaveAs', { downloadId, path }),
    downloadCancel: (downloadId) => write('browser.downloadCancel', { downloadId }),
    downloadStatus: (downloadId) => read('browser.downloadStatus', { downloadId }),
    // 逃生舱
    // 传函数对象也行：toString 后交给页面（VM 里的函数传不过 JSON）
    evaluate: (fn, arg) => write('browser.evaluate', { fn: typeof fn === 'function' ? fn.toString() : fn, arg }),
    fetch: (url, options) => write('browser.fetch', { url, ...options }),
    cdp: (method, params) => write('browser.cdp', { method, params }),
    clearDataForOrigin: (origin, types) => write('browser.clearDataForOrigin', { origin, types }),
    // 坐标键鼠（CSS 像素）
    mouse: {
      click: (x, y, options) => write('browser.mouseClick', { x, y, ...options }),
      move: (x, y, options) => write('browser.mouseMove', { x, y, ...options }),
      down: (options) => write('browser.mouseDown', { ...options }),
      up: (options) => write('browser.mouseUp', { ...options }),
      wheel: (deltaX, deltaY, options) => write('browser.mouseWheel', { deltaX, deltaY, ...options }),
    },
    keyboard: {
      down: (key) => write('browser.keyboardDown', { key }),
      up: (key) => write('browser.keyboardUp', { key }),
      press: (chord, options) => write('browser.keyboardPress', { chord, ...options }),
      type: (text, options) => write('browser.keyboardType', { text, ...options }),
      insertText: (text) => write('browser.keyboardInsert', { text }),
      paste: (content) => write('browser.keyboardPaste', { content }),
    },
    // 标签
    tabs: () => read('tab.list'),
    newTab: (url) => write('tab.new', { url }),
    selectTab: (ref) => write('tab.select', { ref }),
    closeTab: (ref) => write('tab.close', { ref }),
    reopenTab: () => write('tab.reopen', {}),
    // 定位器 helper
    locator: (selector) => locatorOf({ kind: 'selector', selector }),
    getByRole: (role, options = {}) => locatorOf({ kind: 'role', role, name: options.name }),
    getByText: (text) => locatorOf({ kind: 'text', text }),
    getByLabel: (text) => locatorOf({ kind: 'label', text }),
  };
  // 未知属性报 UNSUPPORTED_PAGE_API，并点名去哪看可用清单
  return guardPage(page);
}

/** 反射出一份实例的方法名。手写清单必然和实现漂移，所以能力清单一律从这里生成。 */
function methodsOf(target) {
  if (!target || typeof target !== 'object') return [];
  return Object.keys(target)
    .filter((key) => typeof target[key] === 'function')
    .sort();
}

/**
 * `warren exec --capabilities` 的输出。
 *
 * 反射而不是手写：加一个方法就自动出现在清单里，文档和技能不会落后于实现。
 */
export function describeCapabilities(page) {
  let locator = [];
  try {
    locator = methodsOf(page.locator('body'));
  } catch {
    locator = [];
  }
  return {
    globals: [...EXEC_GLOBALS],
    page: methodsOf(page),
    locator,
    mouse: methodsOf(page.mouse),
    keyboard: methodsOf(page.keyboard),
  };
}

/** 按 `EXEC_GLOBALS` 装配 VM 的全局对象，保证「注入的名字」和「声明的名字」不可能不一致。 */
export function createExecSandbox(globals) {
  const sandbox = {};
  for (const name of EXEC_GLOBALS) {
    if (!(name in globals)) throw new Error(`exec 沙箱缺少全局 ${name}`);
    sandbox[name] = globals[name];
  }
  return sandbox;
}
