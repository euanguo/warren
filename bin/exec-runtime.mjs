/**
 * `warren exec` 的运行时构造 —— **exec 里有什么，只有这一份**。
 *
 * 约束：**只能 import node 内置**（这里零内置依赖）。不把 `fs` 或任何模块加载器带进 VM ——
 * exec 脚本来自 agent，给它文件通道等于绕开 lease / 授权。
 */

import { guardApi, guardPage, withSnapshotText } from './page-contract.mjs';

export const EXEC_GLOBALS = ['page', 'console', 'setTimeout', 'clearTimeout', 'emitResult'];

export const RESULT_SENTINEL = '__CONSOLE_E2E_RESULT__';

export function createEmitResult(write = (line) => console.log(line)) {
  return (payload) => {
    write(RESULT_SENTINEL + JSON.stringify(payload === undefined ? null : payload));
    return payload;
  };
}

/**
 * `page` 的形状。Playwright 形状的**子集** + Warren 高级能力：
 * 没有 `context()` / `expect()` / `route()` / `setViewportSize()`，未知方法直接报 `UNSUPPORTED_PAGE_API`。
 */
export function createPageApi(call, { environmentId, leaseId, tabRef } = {}) {
  const scope = tabRef === undefined ? {} : { tabId: tabRef };
  const write = (method, params) => call(method, { id: environmentId, leaseId, ...scope, ...params });
  const read = (method, params) => call(method, { id: environmentId, ...scope, ...params });

  const locatorOf = (target) =>
    guardApi(
      {
        click: (opts) => write('browser.click', { target, ...opts }),
        dblclick: (opts) => write('browser.dblclick', { target, ...opts }),
        hover: (opts) => write('browser.hover', { target, ...opts }),
        fill: (value, opts) => write('browser.fill', { target, value, ...opts }),
        selectOption: (value, opts) => write('browser.selectOption', { target, value, ...opts }),
        check: (opts) => write('browser.check', { target, ...opts }),
        uncheck: (opts) => write('browser.uncheck', { target, ...opts }),
        scrollIntoView: () => write('browser.scrollIntoView', { target }),
        focus: (opts) => write('browser.focus', { target, ...opts }),
        press: (chord, opts) => write('browser.press', { target, chord, ...opts }),
        setInputFiles: (paths) => write('browser.setInputFiles', { target, paths }),
        dropFiles: (paths, opts) => write('browser.drop', { target, paths, ...opts }),
        dragTo: (dest, opts) => write('browser.drag', { source: target, target: dest, ...opts }),
        get: (prop, attr) => read('browser.get', { prop, target, attr }),
        is: (state) => read('browser.is', { state, target }).then((r) => Boolean(r?.ok)),
      },
      'page.locator(...)',
    );

  const page = {
    // 观察
    snapshot: async (options) => withSnapshotText(await read('browser.snapshot', options ?? {})),
    read: (options) => read('browser.read', options ?? {}),
    get: (prop, target, attr) => read('browser.get', { prop, target, attr }),
    is: (state, target) => read('browser.is', { state, target }).then((r) => Boolean(r?.ok)),
    diff: (options) => read('browser.diff', options ?? {}),
    screenshot: (options) => read('browser.screenshot', options ?? {}),
    info: () => read('browser.info'),
    events: () => read('browser.events'),
    url: async () => (await read('browser.info')).url,
    title: async () => (await read('browser.info')).title,
    console: () => read('browser.console'),
    network: () => read('browser.network'),
    highlight: (target) => read('browser.highlight', { target }),
    // 诊断与 WebMCP
    vitals: () => read('browser.vitals'),
    a11y: () => read('browser.a11y'),
    react: (options) => read('browser.react', options ?? {}),
    webmcpList: () => read('browser.webmcp.list'),
    webmcpCall: (tool, args) => write('browser.webmcp.call', { tool, args }),
    pdf: (path, options) => write('browser.pdf', { path, ...options }),
    // 仿真与 Frame
    set: (setting) => write('browser.set', { setting }),
    frames: () => read('browser.frame.list'),
    selectFrame: (target) => write('browser.frame.select', { target }),
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
    dropFiles: (target, paths, options) => write('browser.drop', { target, paths, ...options }),
    fill: (target, value, options) => write('browser.fill', { target, value, ...options }),
    selectOption: (target, value, options) => write('browser.selectOption', { target, value, ...options }),
    check: (target, options) => write('browser.check', { target, ...options }),
    uncheck: (target, options) => write('browser.uncheck', { target, ...options }),
    scrollIntoView: (target) => write('browser.scrollIntoView', { target }),
    scroll: (deltaX = 0, deltaY = 500) => write('browser.mouseWheel', { deltaX, deltaY }),
    focus: (target, options) => write('browser.focus', { target, ...options }),
    press: (a, b, c) =>
      typeof b === 'string'
        ? write('browser.press', { target: a, chord: b, ...c })
        : write('browser.press', { key: a, ...b }),
    setInputFiles: (target, paths) => write('browser.setInputFiles', { target, paths }),
    waitForFileChooser: (options) => read('browser.waitForEvent', { kind: 'fileChooser', ...options }),
    // 弹窗与下载
    acceptDialog: (prompt) => write('browser.acceptDialog', { prompt }),
    dismissDialog: () => write('browser.dismissDialog'),
    setDialogPolicy: (policy) => write('browser.dialogPolicy', { policy }),
    downloadSaveAs: (downloadId, path) => write('browser.downloadSaveAs', { downloadId, path }),
    downloadCancel: (downloadId) => write('browser.downloadCancel', { downloadId }),
    downloadStatus: (downloadId) => read('browser.downloadStatus', { downloadId }),
    // 逃生舱
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
    // 标签与站点笔记 / 只读 Flow
    tabs: () => read('tab.list'),
    newTab: (url) => write('tab.new', { url }),
    selectTab: (ref) => write('tab.select', { ref }),
    closeTab: (ref) => write('tab.close', { ref }),
    reopenTab: () => write('tab.reopen', {}),
    notesGet: (site) => call('notes.get', { site }),
    notesAppend: (site, text) => call('notes.append', { site, text, updatedBy: 'agent' }),
    runFlow: (name, options) => read('flow.run', { name, ...options }),
    // 定位器 helper
    locator: (selector) => locatorOf({ kind: 'selector', selector }),
    getByRole: (role, options = {}) => locatorOf({ kind: 'role', role, name: options.name }),
    getByText: (text) => locatorOf({ kind: 'text', text }),
    getByLabel: (text) => locatorOf({ kind: 'label', text }),
  };
  return guardPage(page);
}

function methodsOf(target) {
  if (!target || typeof target !== 'object') return [];
  return Object.keys(target)
    .filter((key) => typeof target[key] === 'function')
    .sort();
}

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

export function createExecSandbox(globals) {
  const sandbox = {};
  for (const name of EXEC_GLOBALS) {
    if (!(name in globals)) throw new Error(`exec 沙箱缺少全局 ${name}`);
    sandbox[name] = globals[name];
  }
  return sandbox;
}
