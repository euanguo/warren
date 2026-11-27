/**
 * `warren exec` API 权威 Schema、内置 `help()` 与未知方法模糊纠错（单一事实源）。
 *
 * 零外部依赖、零文件 I/O，可直接供 `bin/exec-runtime.mjs` 与 `bin/page-contract.mjs` 共用。
 */

export const EXEC_API_SCHEMA = {
  globals: {
    page: {
      signature: 'page',
      summary: '当前环境受控页面对象（Playwright 子集 + Warren 扩展，全部通过 RPC 经由主进程执行）',
    },
    state: {
      signature: 'state: Record<string, unknown>',
      summary: '跨 exec 调用的持久化内存对象（随环境存活，env.stop/remove 自动清空；即使报错/超时也会自动回写）',
      example: 'state.cursor = (state.cursor ?? 0) + 1; state.items ??= [];',
    },
    checkpoint: {
      signature: 'await checkpoint(name: string, value: unknown): Promise<{ path, bytes, name, savedAt }>',
      summary: '将结构化进度原子落盘到 ~/.warren/checkpoints/<env>/<name>.json（受路径与密钥防护约束）',
      example: 'await checkpoint("orders-batch-1", { count: state.items.length, items: state.items });',
    },
    help: {
      signature: 'help(topic?: string): string',
      summary: '在脚本内零开销查询可用全局、page/locator/mouse/keyboard 签名与示例',
      example: 'console.log(help("snapshot")); console.log(help("state"));',
    },
    sleep: {
      signature: 'await sleep(ms: number): Promise<void>',
      summary: '异步等待指定毫秒数（0..60000ms），替代手写 new Promise(r => setTimeout(r, ms))',
      example: 'await sleep(500);',
    },
    emitResult: {
      signature: 'emitResult(payload: unknown): unknown',
      summary: '以 __CONSOLE_E2E_RESULT__ 哨兵行输出结构化结果并原样返回 payload',
      example: 'emitResult({ ok: true, total: 42 });',
    },
    console: {
      signature: 'console.{log,warn,error,info}(...args)',
      summary: '输出诊断日志（受统一输出缓冲与 Hard-Stop 净化保护）',
    },
    setTimeout: {
      signature: 'setTimeout(fn, ms)',
      summary: '标准定时器',
    },
    clearTimeout: {
      signature: 'clearTimeout(id)',
      summary: '取消定时器',
    },
  },
  page: {
    // 观察
    snapshot: {
      signature:
        'await page.snapshot(opts?: { scope?, interactiveOnly?, compact?, urls?, filter?, maxDepth?, maxTokens?, selector?, boxes?, noFold? })',
      summary:
        '采集层次 AX 树与稳定 @N 引用（返回对象 { url, title, nodes, viewport?, compact? }，带不可枚举 toString()）',
      example: 'const snap = await page.snapshot({ interactiveOnly: true, compact: true });',
    },
    read: {
      signature:
        'await page.read(opts?: { selector?, data?, links?, scroll?, match?, outline?, filter?, llms?, block?, fields?, where?, limit? })',
      summary: '抽取页面干净正文、大纲、表格、嵌入 JSON 与链接',
    },
    readAll: {
      signature:
        'await page.readAll(urlsOrOpts: string[] | { urls: string[], concurrency?, selector?, data?, links?, outline?, filter?, maxChars? })',
      summary: '在隔离后台 offscreen 读池并发读取多个同环境登录态 URL（不打断当前 Tab）',
      example: 'const pages = await page.readAll(["https://a.test/1", "https://a.test/2"]);',
    },
    get: {
      signature: 'await page.get(prop: "url"|"title"|"text"|"html"|"value"|"attr"|"box", target?, attr?)',
      summary: '读取页面或目标元素单个属性',
    },
    is: {
      signature: 'await page.is(state: "visible"|"enabled"|"checked", target): Promise<boolean>',
      summary: '判断元素是否可见/可用/勾选',
    },
    diff: {
      signature: 'await page.diff(opts?: { interactiveOnly? })',
      summary: '对比当前快照与上次快照的行级结构差异',
    },
    screenshot: {
      signature: 'await page.screenshot(opts?: { path?, format?, fullPage?, encoding?, annotate? })',
      summary: '截图并落盘或返回元数据',
    },
    info: { signature: 'await page.info()', summary: '获取当前 url、title、loading、dialog、tab 与 env 信息' },
    events: { signature: 'await page.events()', summary: '消费并返回待处理的 dialog/popup/download 事件' },
    url: { signature: 'await page.url(): Promise<string>', summary: '获取当前页 URL' },
    title: { signature: 'await page.title(): Promise<string>', summary: '获取当前页标题' },
    console: { signature: 'await page.console()', summary: '读取控制台日志遥测' },
    network: { signature: 'await page.network()', summary: '读取网络请求遥测' },
    highlight: { signature: 'await page.highlight(target?)', summary: '高亮元素边框（无参取消高亮）' },
    // 诊断与 WebMCP
    vitals: { signature: 'await page.vitals()', summary: '采集页面性能指标（TTFB/FCP/LCP/CLS）' },
    a11y: { signature: 'await page.a11y()', summary: '执行可访问性静态审计' },
    react: { signature: 'await page.react(opts?: { maxNodes? })', summary: '检查 React Fiber 组件树' },
    webmcpList: { signature: 'await page.webmcpList()', summary: '列出页面声明的 WebMCP 工具' },
    webmcpCall: { signature: 'await page.webmcpCall(tool, args?)', summary: '调用页面声明的 WebMCP 工具' },
    pdf: {
      signature: 'await page.pdf(path, opts?: { landscape?, printBackground?, scale? })',
      summary: '导出当前页为 PDF',
    },
    // 仿真与 Frame
    set: {
      signature: 'await page.set(setting)',
      summary: '设置 viewport/device/geo/offline/headers/media/tz/locale/reset',
    },
    frames: { signature: 'await page.frames()', summary: '列出所有 frame（含 OOPIF）' },
    selectFrame: { signature: 'await page.selectFrame(target)', summary: '切换当前定位与快照聚焦的 frame' },
    // 导航
    goto: {
      signature: 'await page.goto(url, opts?: { waitUntil?, timeoutMs?, referer?, includeDelta? })',
      summary: '导航到指定 URL',
    },
    reload: { signature: 'await page.reload(opts?)', summary: '刷新当前页' },
    goBack: { signature: 'await page.goBack()', summary: '历史后退' },
    goForward: { signature: 'await page.goForward()', summary: '历史前进' },
    // 等待
    waitFor: {
      signature: 'await page.waitFor(predicate, opts?: { timeoutMs? })',
      summary: '按谓词等待（text/role/selector/url/function/loadState/event）',
    },
    waitForURL: { signature: 'await page.waitForURL(matcher, opts?)', summary: '等待 URL 匹配字符串、glob 或正则' },
    waitForSelector: {
      signature: 'await page.waitForSelector(target, opts?: { state?, timeoutMs? })',
      summary: '等待元素进入目标状态',
    },
    waitForFunction: { signature: 'await page.waitForFunction(fn, arg?, opts?)', summary: '等待页面函数返回真值' },
    waitForLoadState: {
      signature: 'await page.waitForLoadState(state?, opts?)',
      summary: '等待 commit/domcontentloaded/load/networkidle',
    },
    waitForTimeout: { signature: 'await page.waitForTimeout(ms)', summary: '在浏览器侧等待指定毫秒' },
    waitForEvent: {
      signature: 'await page.waitForEvent(kind, opts?)',
      summary: '等待 popup/download/dialog/fileChooser 事件',
    },
    waitForFileChooser: { signature: 'await page.waitForFileChooser(opts?)', summary: '等待文件选择器事件' },
    // 元素动作
    click: {
      signature:
        'await page.click(target, opts?: { button?, newTab?, humanize?, noWaitAfter?, timeoutMs?, includeDelta? })',
      summary: '等待可用性并点击元素',
    },
    dblclick: { signature: 'await page.dblclick(target, opts?)', summary: '真实两连击双击元素' },
    hover: { signature: 'await page.hover(target, opts?)', summary: '悬停元素' },
    dragAndDrop: { signature: 'await page.dragAndDrop(source, target, opts?)', summary: '拖拽元素（支持 HTML5 降级）' },
    dropFiles: { signature: 'await page.dropFiles(target, paths, opts?)', summary: '向拖放区注入文件 DataTransfer' },
    fill: {
      signature: 'await page.fill(target, value, opts?: { submit?, clearFirst?, timeoutMs?, includeDelta? })',
      summary: '智能清空并填写输入框/富文本/表格单元格',
    },
    selectOption: {
      signature: 'await page.selectOption(target, value, opts?: { by?, timeoutMs? })',
      summary: '选择下拉或 ARIA combobox/多值 chip 选项',
    },
    check: { signature: 'await page.check(target, opts?)', summary: '幂等勾选 checkbox/radio/switch' },
    uncheck: { signature: 'await page.uncheck(target, opts?)', summary: '幂等取消勾选' },
    scrollIntoView: { signature: 'await page.scrollIntoView(target)', summary: '将元素居中滚动至视口' },
    scroll: { signature: 'await page.scroll(deltaX = 0, deltaY = 500)', summary: '按增量滚动视口' },
    focus: { signature: 'await page.focus(target, opts?)', summary: '聚焦元素' },
    press: { signature: 'await page.press(keyOrTarget, chord?, opts?)', summary: '发送按键或针对目标发送组合键' },
    setInputFiles: { signature: 'await page.setInputFiles(target, paths)', summary: '向 file input 注入本地文件' },
    // 弹窗与下载
    acceptDialog: { signature: 'await page.acceptDialog(prompt?)', summary: '确认 JS 对话框' },
    dismissDialog: { signature: 'await page.dismissDialog()', summary: '取消 JS 对话框' },
    setDialogPolicy: {
      signature: 'await page.setDialogPolicy("none"|"accept"|"dismiss")',
      summary: '设置自动弹窗处理策略',
    },
    downloadSaveAs: { signature: 'await page.downloadSaveAs(downloadId, path)', summary: '将下载另存到安全路径' },
    downloadCancel: { signature: 'await page.downloadCancel(downloadId)', summary: '取消进行中下载' },
    downloadStatus: { signature: 'await page.downloadStatus(downloadId)', summary: '查询下载状态' },
    // 逃生舱
    evaluate: { signature: 'await page.evaluate(fn, arg?)', summary: '在主世界执行表达式或函数' },
    fetch: { signature: 'await page.fetch(url, opts?)', summary: '带环境身份上下文发起同源 fetch' },
    cdp: { signature: 'await page.cdp(method, params?)', summary: '发送受白名单门控的 CDP 命令' },
    clearDataForOrigin: {
      signature: 'await page.clearDataForOrigin(origin, types?)',
      summary: '清除单个 origin 的站点存储',
    },
    // 标签、记忆与 Flow
    tabs: { signature: 'await page.tabs()', summary: '列出当前 Agent Space 标签' },
    newTab: { signature: 'await page.newTab(url?)', summary: '新建标签页' },
    selectTab: { signature: 'await page.selectTab(ref)', summary: '切换活动标签' },
    closeTab: { signature: 'await page.closeTab(ref)', summary: '关闭指定标签' },
    reopenTab: { signature: 'await page.reopenTab()', summary: '恢复最近关闭的标签' },
    notesGet: { signature: 'await page.notesGet(site)', summary: '读取站点经验笔记' },
    notesAppend: { signature: 'await page.notesAppend(site, text)', summary: '追加站点经验笔记' },
    runFlow: {
      signature: 'await page.runFlow(name, opts?: { params?, where?, fields?, limit? })',
      summary: '执行已保存的只读 Saved Flow',
    },
    // 定位器
    locator: { signature: 'page.locator(selector)', summary: '构造 CSS/语义定位器' },
    getByRole: { signature: 'page.getByRole(role, { name? })', summary: '按无障碍角色与名称构造定位器' },
    getByText: { signature: 'page.getByText(text)', summary: '按可见文本构造定位器' },
    getByLabel: { signature: 'page.getByLabel(text)', summary: '按表单标签构造定位器' },
  },
  locator: {
    click: { signature: 'await locator.click(opts?)', summary: '点击定位目标' },
    dblclick: { signature: 'await locator.dblclick(opts?)', summary: '双击定位目标' },
    hover: { signature: 'await locator.hover(opts?)', summary: '悬停定位目标' },
    fill: { signature: 'await locator.fill(value, opts?)', summary: '填写定位目标' },
    selectOption: { signature: 'await locator.selectOption(value, opts?)', summary: '选择定位目标选项' },
    check: { signature: 'await locator.check(opts?)', summary: '勾选定位目标' },
    uncheck: { signature: 'await locator.uncheck(opts?)', summary: '取消勾选定位目标' },
    scrollIntoView: { signature: 'await locator.scrollIntoView()', summary: '滚动定位目标入视口' },
    focus: { signature: 'await locator.focus(opts?)', summary: '聚焦定位目标' },
    press: { signature: 'await locator.press(chord, opts?)', summary: '向定位目标发送按键' },
    setInputFiles: { signature: 'await locator.setInputFiles(paths)', summary: '向 file input 注入本地文件' },
    dropFiles: { signature: 'await locator.dropFiles(paths, opts?)', summary: '向拖放区注入文件' },
    dragTo: { signature: 'await locator.dragTo(dest, opts?)', summary: '拖拽至另一目标' },
    get: { signature: 'await locator.get(prop, attr?)', summary: '读取目标属性' },
    is: { signature: 'await locator.is(state)', summary: '判断目标可见/可用/勾选态' },
  },
  mouse: {
    click: { signature: 'await page.mouse.click(x, y, opts?)', summary: '按视口 CSS 坐标点击' },
    move: { signature: 'await page.mouse.move(x, y, opts?)', summary: '移动指针到视口坐标' },
    down: { signature: 'await page.mouse.down(opts?)', summary: '按下鼠标键' },
    up: { signature: 'await page.mouse.up(opts?)', summary: '松开鼠标键' },
    wheel: { signature: 'await page.mouse.wheel(deltaX, deltaY, opts?)', summary: '触发滚轮事件' },
  },
  keyboard: {
    down: { signature: 'await page.keyboard.down(key)', summary: '按住按键' },
    up: { signature: 'await page.keyboard.up(key)', summary: '释放按键' },
    press: { signature: 'await page.keyboard.press(chord, opts?)', summary: '按下并释放按键/组合键' },
    type: { signature: 'await page.keyboard.type(text, opts?)', summary: '逐字符键入文本' },
    insertText: { signature: 'await page.keyboard.insertText(text)', summary: '直接插入文本（支持中文/IME）' },
    paste: { signature: 'await page.keyboard.paste(content)', summary: '粘贴纯文本或 { text, html }' },
  },
};

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/** 针对拼错或 Playwright 习惯名返回最相近的合法方法名。 */
export function suggestClosestMethods(query, candidates, max = 3) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!q || !Array.isArray(candidates) || candidates.length === 0) return [];
  const scored = candidates.map((name) => {
    const low = String(name).toLowerCase();
    let score = editDistance(q, low);
    if (low.startsWith(q) || q.startsWith(low)) score -= 2.5;
    else if (low.includes(q) || q.includes(low)) score -= 1.5;
    return { name: String(name), score };
  });
  return scored
    .filter((item) => item.score <= Math.max(3, Math.ceil(q.length * 0.6)))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((item) => item.name);
}

/** 在 `warren exec` 脚本内或 `--capabilities --detailed` 中渲染可读 API 帮助。 */
export function helpApi(topic) {
  const q = typeof topic === 'string' ? topic.trim().toLowerCase() : '';
  if (!q) {
    return [
      'Warren Exec 可用全局与命名空间：',
      `  globals : ${Object.keys(EXEC_API_SCHEMA.globals).join(', ')}`,
      `  page    : ${Object.keys(EXEC_API_SCHEMA.page).join(', ')}`,
      `  locator : ${Object.keys(EXEC_API_SCHEMA.locator).join(', ')}`,
      `  mouse   : ${Object.keys(EXEC_API_SCHEMA.mouse).join(', ')}`,
      `  keyboard: ${Object.keys(EXEC_API_SCHEMA.keyboard).join(', ')}`,
      '用法: help("snapshot") | help("state") | help("locator") | help("mouse")',
    ].join('\n');
  }

  if (q in EXEC_API_SCHEMA) {
    const group = EXEC_API_SCHEMA[q];
    return [
      `[${q}] 可用 API:`,
      ...Object.entries(group).map(([name, meta]) => `  - ${name}: ${meta.signature} — ${meta.summary}`),
    ].join('\n');
  }

  const hits = [];
  for (const [groupName, group] of Object.entries(EXEC_API_SCHEMA)) {
    for (const [name, meta] of Object.entries(group)) {
      const full = groupName === 'globals' ? name : `${groupName}.${name}`;
      if (name.toLowerCase().includes(q) || full.toLowerCase().includes(q) || meta.summary.toLowerCase().includes(q)) {
        hits.push({ full, ...meta });
      }
    }
  }
  if (hits.length === 0) {
    const allNames = Object.values(EXEC_API_SCHEMA).flatMap((g) => Object.keys(g));
    const suggestions = suggestClosestMethods(q, [...new Set(allNames)], 4);
    const hint = suggestions.length > 0 ? `；相近项：${suggestions.join(', ')}` : '';
    return `未找到匹配 "${topic}" 的 API${hint}（调用 help() 查看全量分组）`;
  }
  return hits
    .slice(0, 12)
    .map((h) => `${h.full}\n  签名: ${h.signature}\n  说明: ${h.summary}${h.example ? `\n  示例: ${h.example}` : ''}`)
    .join('\n\n');
}
