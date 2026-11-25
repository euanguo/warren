# Warren 浏览器能力实施计划（全量，一次做完）

> 前置：`docs/BROWSER-CAPABILITY-RESEARCH.md`（能力取舍已定，三方最新文档 2026-10-14 已核验：Playwright 八个 API 类全文、Browser Use llms-full 全量包、Ego Skill v2 全量 API）。本计划只讲**怎么做**：目标架构、模块清单、RPC/类型/CLI 全量定义、安全门控、测试与验收。
> 约束：HANDOFF §3 架构决策不推翻（单 session、单可见页面、遥测走原生事件、插件非沙箱、Vault 无 reveal）；现有 `Target` 对象与 RPC 全部向后兼容（只做加法，唯一例外见 §9.1）。

---

## 0. 目标与非目标

- 目标：§3 清单全部落地 + §8 的 Warren 原生增强。做完后 Warren 的 agent 能力是 Ego Page API 的超集（映射见调研 §7），语义差异只在 C/X 行。
- 非目标：route/mock、HAR/视频、多 context、整 profile 清除、指纹/换内核（调研 X1–X3，不做）。

---

## 1. 现状架构（改前）

```
bin/warren.mjs: makePage() → call('browser.*' / 'tab.*')
src/main/rpc.ts: #dispatch → manager.controllerFor(id, tab?) → BrowserController
src/main/browser-control.ts (293 行): navigate/waitFor/snapshot/screenshot/click/fill/press + 私有 target 解析
src/main/tabs.ts: TabManager（视图唯一入口）+ window.open 收敛
src/main/environments.ts: session/proxy/lease/遮罩 + controllerFor/tab 寻址
src/main/telemetry.ts: console/network 原生事件（按 tab 记，按 env 读）
```

痛点：`browser-control.ts` 再塞 30 个方法会到 2000 行；dialog/popup/download 无事件源；ref 无处放；waits 全是轮询 snapshot。

---

## 2. 目标架构（改后）

```
src/main/browser/
  controller.ts    门面：attach/detach、ref 表、events 缓冲、withReceipt；组合以下模块
  target.ts        纯函数：selector 字符串解析 + Target 归一 + 歧义判定（可单测）
  snapshot.ts      AX 树 → 节点（ref/subtree/full_page/actionMarks/stableLocator）
  actions.ts       click/dblclick/hover/drag/fill/selectOption/focus/press/setInputFiles
  waits.ts         waitForURL/Selector/Function/LoadState/Timeout/Event + goto/reload 的 waitUntil
  dialogs.ts       dialog 捕获（Page.javascriptDialogOpening）+ accept/dismiss + popup/download 队列消费
  input.ts         纯函数：chord 解析；mouse/keyboard 的 CDP 参数组装（可单测）
  evaluate.ts      evaluate/fetch/cdp（含 allowlist、凭据脱敏、路径护栏调用）
  policy.ts        纯函数：CDP allow/deny 表、路径护栏、fetch 凭据默认（可单测）
  refs.ts          纯类：RefTable（gen 计数、失效）（可单测）
src/main/browser-control.ts  只剩 `export *` 转出（老路径引用不断，见 AGENTS 已知问题 §2 同类处理）
src/main/tabs.ts             加 `onPopup` 回调（window.open 收敛处上报 opener 可选）
src/main/environments.ts     加每环境 pending 队列 {popups, downloads} + session will-download 落盘 + networkidle 取数
src/main/telemetry.ts        Console/NetworkEntry 加可选 `tabId`（加法）+ `lastActivityAt(tabId)`
src/shared/types.ts          加法：§4 类型
src/main/rpc.ts              加 §5 的 case（读不鉴 lease，写 assertWritable + assertVisible，见 §6 分级）
bin/warren.mjs               makePage 补全 + `browser info/events` 直达命令 + `acquire --wait`
tests/                       selector/chord/refs/policy/matcher 若干纯单测
fixtures/capability/         dialog/download/upload/form/drag/shadow/iframe.html
```

关键接线（只说三处）：

1. dialog 事件：`controller.attach()` 时加 `wc.debugger.on('message')`（每个 webContents 一次），`Page.enable` 后 `Page.javascriptDialogOpening` 进本 tab 的 events 缓冲。检测面备注：只开了 Page 域，`Runtime/Network.enable` 仍不开。
2. popup：`TabManager.#onWindowOpen` 的 `createWindow` 里调 `onPopup({tabId, url})` → manager 的 pending 队列。`waitForEvent('popup')` 消费它；写动作 receipt 附带动作开始后新入队的。
3. download：`manager.start()` 里 `ses.on('will-download', ...)` → 临时区 `os.tmpdir()/warren-downloads/<envId>/`（`setSavePath`，文件名消毒），记 `{downloadId, url, filename, path, state}`。`saveAs` 等 `done` 后拷到绝对路径（建父目录）。

---

## 3. 全量清单（RPC / page / CLI 三列对照）

`→` 表示 page 方法名与 RPC 名不同。写/读门控见 §6。

| # | RPC | page | CLI | 说明 |
|---|---|---|---|---|
| O1 | `browser.snapshot`（加参） | `snapshot(opts?)` | `browser snapshot` | `{scope, root, limit, includeActionMarks, includeStableLocator}`；节点加 `ref/actions/locator?` |
| O2 | `browser.screenshot`（加参） | `screenshot(opts?) → base64` | `browser screenshot` | `{format, fullPage, clip}`；`captureBeyondViewport` 做 fullPage |
| O3 | `browser.info` | `info()` | `browser info` | `{url,title,loading,dialog,tab:{id,index},env}`；dialog 只 peek 不消费 |
| O4 | `browser.events` | `events()` | `browser events` | 读并清空本 tab 缓冲：dialog/popup/download/fileChooser |
| N1 | `browser.navigate`（加参） | `goto(url, opts?)` | `browser open` | `{referer,timeoutMs,waitUntil}`；超时错误带 `{committed,url,readyState}` |
| N2 | `browser.reload`（新增） | `reload(opts?)` | —（exec） | 修掉“reload 走 navigate 传 undefined 必 BAD_REQUEST”的暗坑 |
| W1 | `browser.waitFor`（加 predicate） | `waitFor(pred, opts?)` | — | 加 `url/function/loadState/event` 四种（§4.3），老三种不动 |
| W2 | `browser.waitForURL` | `waitForURL(matcher, opts?)` | — | matcher 见 §4.3 |
| W3 | `browser.waitForSelector` | `waitForSelector(sel, opts?)` | — | `{state: attached/detached/visible/hidden/enabled/disabled, timeoutMs}` |
| W4 | `browser.waitForFunction` | `waitForFunction(fn, arg?, opts?)` | — | `{timeoutMs, polling}` |
| W5 | `browser.waitForLoadState` | `waitForLoadState(state?, opts?)` | — | `commit/domcontentloaded/load/networkidle`，networkidle 用原生遥测空闲 500ms |
| W6 | `browser.waitForTimeout` | `waitForTimeout(ms)` | — | 服务端睡，保脚本原子性 |
| W7 | `browser.waitForEvent` | `waitForEvent(kind, opts?)` | — | `popup/download/dialog/fileChooser`；先 arm 后触发仍是调用方义务 |
| E1 | `browser.click`（加参） | `click(t, opts?)` | — | `{button,clickCount,delay,position,timeoutMs,label}` |
| E2 | `browser.dblclick` | `dblclick(t, opts?)` | — | clickCount=2 直发 |
| E3 | `browser.hover` | `hover(t, opts?)` | — | mouseMoved |
| E4 | `browser.drag` | `dragAndDrop(src, dst, opts?)` | — | down → steps move → up |
| E5 | `browser.fill`（加参） | `fill(t, value, opts?)` | — | `{clearFirst, timeoutMs}`；focus→全选→insertText→读值确认 |
| E6 | `browser.selectOption` | `selectOption(t, v, opts?)` | — | string/`{value,label,index}`/数组；`null/[]` 清空 |
| E7 | `browser.focus` | `focus(t, opts?)` | — | 元素/可交互祖先/唯一可编辑后代 |
| E8 | `browser.press`（加参） | `press(sel?, chord, opts?)` | — | 老 `press(key)` 全局调用仍可用（sel 缺省）；chord 消化 `ControlOrMeta` |
| E9 | `browser.setInputFiles` | `setInputFiles(t, paths)` | — | `DOM.setFileInputFiles`；路径须存在 |
| E10 | `browser.waitForFileChooser` | `waitForFileChooser(opts?)` | — | 实现 = 等 `input[type=file]` attached（Electron 无原生 chooser 事件，如实文档化） |
| D1 | `browser.acceptDialog` | `acceptDialog(prompt?)` | — | `Page.handleJavaScriptDialog{accept:true}` |
| D2 | `browser.dismissDialog` | `dismissDialog()` | — | `{accept:false}` |
| F1 | `browser.downloadSaveAs` | `downloadSaveAs(id, path)` | — | 等 done 后拷贝；建父目录 |
| F2 | `browser.downloadCancel` | `downloadCancel(id)` | — | `item.cancel()` |
| F3 | `browser.downloadStatus` | `downloadStatus(id)` | — | `{state, receivedBytes, totalBytes, url, filename}` |
| S1 | `browser.evaluate` | `evaluate(fn, arg?)` | — | `Runtime.evaluate`，awaitPromise，返回值 JSON 可串行化检查 + 凭据脱敏 |
| S2 | `browser.fetch` | `fetch(url, opts?)` | — | 页面内 `window.fetch`；二进制走 `{saveAs}`；凭据默认见 §6.3 |
| S3 | `browser.cdp` | `cdp(method, params?)` | — | 白名单制（§6.4），命中黑名单 `CDP_BLOCKED` + 记事件 |
| S4 | `browser.clearDataForOrigin` | `clearDataForOrigin(origin, types?)` | — | 仅单 origin；整 profile 清除无 RPC（调研 §2.9） |
| M1–M5 | `browser.mouseClick/mouseMove/mouseDown/mouseUp/mouseWheel` | `mouse.click/move/down/up/wheel` | — | CSS 像素；`label` 写事件流 |
| M6–M11 | `browser.keyboardDown/keyboardUp/keyboardPress/keyboardType/keyboardInsert/keyboardPaste` | `keyboard.*` | — | macOS paste 走原生剪贴板并恢复（`{text,html?}`） |
| C1 | —（无新 RPC） | `acquire --wait`（CLI 侧轮询） | `env acquire --wait=ms` | `waitForControl` 的 Warren 映射：CLI 循环调 `env.acquire` 直到拿到或超时 |
| C2 | receipt 加法 | — | — | 全部写动作返回值加 `{popups?, dialog?}`；`click` 的 `{x,y,url}` 保留 |

`getByRole/getByText/getByLabel/locator` 四个 helper：补齐缺的方法（dblclick/hover/fill/selectOption/focus/press/setInputFiles），并允许传 `opts`。

---

## 4. 详细设计

### 4.1 Target 与选择器（`target.ts`，纯函数 + 单测）

- RPC 的 `target` 接受**老对象或新字符串**：`{kind:role/text/label/selector}` 原样兼容；字符串走解析器。
- 解析器支持（按序试）：`@21`/`ref=21` → `{kind:'ref'}`；`text=`（引号精确，否则模糊）；`loc=css:/role:/href:`（role 支持 `[name="x"]` 精确与 `[name*="x"]` 子串）；`xpath=` → `{kind:'xpath'}`；`css=`；裸 CSS；末尾 `>> nth=N`（-1=末个）。`:has-text/:text-is` 只做末尾形（Ego 子集）。
- 解析失败 → `BAD_SELECTOR`（带位置信息），**不猜**。
- 匹配数 0 → `TARGET_NOT_FOUND`；>1 → 新增 `TARGET_AMBIGUOUS`（带 count + 前 3 个候选的 role/name），调用方加 nth 或换定位。
- xpath 求值：`Runtime.evaluate` 跑 `document.evaluate` 取首 N 个的 backendId（经 `DOM.describeNode` 换算）；CSS 批量：`DOM.querySelectorAll` + `pushNodesByBackendIdsToFrontend` 反查。
- wrapper 规则（Ego §2.7 照搬）：`focus/press` 可上浮可交互祖先/下钻唯一可编辑后代；`fill/setInputFiles` 只下钻唯一兼容控件，否则 `TARGET_NOT_FILLABLE`。

### 4.2 Snapshot 与 ref（`snapshot.ts` + `refs.ts`）

- `scope` 默认 viewport（即今日行为，limit 默认 400）；`full_page` = limit 放到 2000 且不截断（AX 树本来就含屏外节点，如实文档化：Warren 的 viewport/full 差异只是量级，不是浏览器算的裁剪）；`subtree{root}` = 以 root ref 的 backendId 为根，用 `childIds` 建父子表过滤。
- ref 分配：每次 snapshot 对输出节点编 `@1..@N`，`RefTable` 存 `ref→backendNodeId` + `gen`；`did-navigate`（整页）gen+1，老 ref 读到报 `TARGET_STALE`（提示重拍）；页内导航 gen 不变。
- `includeActionMarks`：按 role 标 `actions:['click'|'fill'|'select'|'focus']`；`includeStableLocator`：给 `loc=role:…[name="…"]` 或 `@ref` 回退。两字段都是加法、可选。
- 动作超时默认 3000ms：解析→等待 actionable（visible+enabled 轮询）→执行；`waitForSelector` 的 state 机复用同一套判定。

### 4.3 等待（`waits.ts`）

- `waitFor` 新 predicate：`{url: string|{regex}}`（子串/正则）、`{function: string, arg?}`（轮询 evaluate 真值）、`{loadState}`、`{event: popup/download/dialog/fileChooser}`（转调 W7）。老 `{text/role/selector}` 语义不动。
- `waitForURL` matcher：字符串=子串；`{regex}`；`{glob}`（`*` 通配，和 telemetry URL pattern 一样只做简单展开）。
- `waitForSelector` state：attached（DOM 存在）/detached（消失）/visible（盒模型非空且非 `display:none/visibility:hidden`，经 `DOM.getBoxModel` + 计算样式抽查）/hidden/enabled/disabled。checked 不做（用 `waitForFunction` 读 `checked`，文档写明）。
- `waitForLoadState`：commit=URL 已换/提交；domcontentloaded=`dom-ready` 或轮询 `readyState!=='loading'`；load=`did-stop-loading`；networkidle=load 且该 tab `lastActivityAt` 500ms 无新增（`idleMs` 可调）。全部加“已处在目标态则直接返回”。
- `waitForEvent`：dialog/fileChooser 读本 tab 缓冲（消费）；popup/download 读 manager pending 队列（消费）。超时 `TIMEOUT`，popup 超时附“检查是否被拦成 denied 事件”。

### 4.4 动作（`actions.ts`）

- click 全参：`position` 为元素内偏移；`delay` 为 down/up 间隔；label 只写事件流（无光标叠加层，不做 Ego 的可视化）。
- fill：`clearFirst` 默认 true（`ControlOrMeta+A` 全选后 insertText，与 Ego 一致）；之后读 AX value 或 DOM value 确认，不一致报 `FILL_UNCONFIRMED`（调用方可重试）。
- selectOption：`Runtime.evaluate` 在页面内按 value/label/index 置值并派 `input+change`；多选走数组；`null/[]` 清空。禁用的 option 仍可编程选中（Ego 语义）。
- press/chord（`input.ts` 纯解析）：`A`/`Enter`/`Escape`/`Tab`/`ArrowLeft…` 命名键大小写不敏感；`+` 连接修饰键（`Control/ControlOrMeta/Meta/Shift/Alt`，macOS 上 `ControlOrMeta`=Meta）；单字符保留大小写。拼成 `Input.dispatchKeyEvent` 的 key/code/modifiers（keyDown+keyUp，press(sel) 先 focus）。
- setInputFiles：`DOM.setFileInputFiles{nodeId, files}`；文件须存在、可读；目录拒绝。

### 4.5 弹窗/下载/上传（`dialogs.ts` + manager 接线）

- dialog：`Page.javascriptDialogOpening{url,message,type}` 进缓冲；`acceptDialog(prompt?)`/`dismissDialog()` 调 `Page.handleJavaScriptDialog`；未处理 dialog 阻塞后续输入时报 `DIALOG_OPEN`（带 message 摘要）而不是卡死。
- popup： receipt 与 `waitForEvent('popup')` 返回 `{tabId, index(1-based), url, title?}`；被 `deny` 的走现有 `popup.denied` 事件，等待超时里提示。
- download：`waitForEvent('download')` 在 will-download 时 resolve `{downloadId, url, suggestedFilename}`；`saveAs` 等 done（`state==='completed'`）后拷贝；`cancel` 调 item；临时区在 `env.stop` 时清（调用方须在停环境前 saveAs，文档写明；与 Ego“回合结束删临时文件”对应的是我们的“停环境清”，见调研 §5 F2 偏差说明）。

### 4.6 逃生舱（`evaluate.ts` + `policy.ts`）

- evaluate：`Runtime.evaluate{expression, returnByValue:true, awaitPromise:true, userGesture:false}`；函数与字符串都收（函数 toString 后包 IIFE，arg 经 JSON）；只接受 JSON 可串行化返回（`undefined→null` 归一如实说明）；服务端超时 race（默认 30s，可 `timeoutMs`），超时不保证页面侧停下（Ego 同款 `mayHaveLateEffects` 语义，文档写明 reload/close 建议）。
- 返回值凭据脱敏：key 命中 `password|passwd|secret|token|api[_-]?key|cookie|session`（大小写不敏感）的值替换 `[REDACTED]`（深拷贝递归，数组同样处理），并记一条脱敏事件（不记值）。
- fetch：页面内 `window.fetch(url, {method, headers, body})`；文本 body 上限 2MB（超了必须用 `saveAs` 二进制落盘）；`saveAs` 路径走 §6.5 护栏；返回 `{ok,status,statusText,url,headers,body?}`。
- cdp：见 §6.4。
- Vault.fill 增补 `allowedDomains?: string[]`（抄 Browser Use secret_bindings：裸 host、子域继承、不在名单的 origin 拒绝填充并记事件；不传则不限，与今日行为一致）。

### 4.7 键鼠（`input.ts`）

- mouse：`click/move/down/up` 组 `Input.dispatchMouseEvent`；`wheel{deltaX,deltaY}` 组 `mouseWheel`（调用前文档要求先 move 到滚动容器上，Ego 同款）。
- keyboard：`type` 逐字 `dispatchKeyEvent{type:'char'}`（可 `delay`）；`insertText` 一次 `Input.insertText`；`paste`：macOS=Electron clipboard 暂存→写入→`Meta+V`→恢复（`{text,html?}`），其他平台=insertText（Ego 同款降级）。
- 坐标单位 CSS 像素；后台/非激活 tab 的输入类调用报 `TAB_NOT_VISIBLE`（先 `tab.select`），读/evaluate 不限（Warren 增强：后台 tab 可读可算，不可点）。

---

## 5. RPC 参数/返回/错误速查（实现时照抄）

通用：`{id, leaseId?, tabId?}`；读操作不鉴 lease；写操作 `assertWritable + assertVisible`（输入类还要目标 tab==active，见 §6.2）。
新增错误码：`BAD_SELECTOR` / `TARGET_AMBIGUOUS` / `TARGET_STALE` / `TARGET_NOT_FILLABLE` / `TAB_NOT_VISIBLE` / `DIALOG_OPEN` / `FILL_UNCONFIRMED` / `CDP_BLOCKED` / `PATH_DENIED` / `DOWNLOAD_FAILED`。全部进 `rpc.ts` 的错误透传（现有 `code` 机制不变）。

（各方法 30+ 的逐字段表在此省略为规则代替：params 用小写驼峰 + `timeoutMs` 统一；`tabId` 复用现有 `optionalTab` 解析；返回体一律对象，写动作必带 `{popups?, dialog?}`。）

---

## 6. 安全与门控（硬约束 + 新增，一处看全）

1. 沿用 HANDOFF §4 六条（插件非沙箱表述、Vault 无 reveal、stdin 读秘、代理无凭据拒绝、cookie denied、`[REDACTED]`）。
2. 读写分级：读=`snapshot/screenshot/info/events/console/network/url/title`（免 lease）；写=其余全部，含 `evaluate/fetch/cdp/dialog/downloadSaveAs/setInputFiles/clearData`。写统一 `assertWritable(id, lease)`；其中**输入类**（click 系/fill/press/mouse/keyboard/dialog 处理）再加 `assertVisible(id)` 且目标 tab 须 active，否则 `TAB_NOT_VISIBLE`/`ENV_NOT_VISIBLE`；`evaluate/fetch/cdp` 允许后台 tab（只读不了输入，但可变页面状态——仍要 lease，文档写明这条边界）。
3. fetch 凭据：缺省同站 `include`、跨站 `omit`（main 里比 origin）；显式 `include` 跨站放行但记事件。
4. cdp 白名单：域只放 `Page/Runtime/DOM/Accessibility/Input/Emulation/Overlay`；方法黑名单：`Network.clearBrowserCookies`、`Network.clearBrowserCache`、`Storage.clearCookies`（无 scope 版）、`Browser.*`（`getVersion` 这种只读也不放，先紧后松）、`Target.*` 全体。命中 → `CDP_BLOCKED` + `events` 记一条。`page.cdp` 不缩小作用域（Ego clearing-state 同款警告写进注释）。
5. 路径护栏（`setInputFiles/saveAs/fetch.saveAs`）：须绝对路径；禁 `~/.warren/`、`core/` 数据目录、`/etc /bin /sbin /usr/bin` 等系统区白名单外；`saveAs` 自动建父目录；`setInputFiles` 文件须已存在。
6. 脱敏：`evaluate/fetch` 返回值过 §4.6 脱敏；`vault.fill` 仍是密码唯一入口（`fill` 填密码不禁，但文档引导走 vault）。
7. 超时：动作默认 3000ms；导航 30s；`evaluate` 30s；RPC 全局 60s（`WARREN_TIMEOUT_MS`）不变。

---

## 7. 测试计划（`npm test` 必须全绿）

纯单测（node:test，既有风格）：`target.test.ts`（解析器全分支 + nth + 歧义）、`chord.test.ts`、`refs.test.ts`（gen 失效）、`policy.test.ts`（allow/deny 表 + 路径护栏 + fetch 凭据默认）、`wait-matcher.test.ts`（url matcher/readyState 判定）。目标：新增 ≥5 文件，断言覆盖错误码。
集成（手跑，不进 CI）：fixtures 6 页 + §10 验收表逐项过；`npx tsc --noEmit` + 渲染层 build 照旧。

---

## 8. Warren 原生增强（超出 Ego 的 6 件，已在上面落实）

1. 后台 tab 可读可算（§6.2）；2. receipt 统一 + label 写事件流（§3 C2）；3. 超时错误带 committed/url/readyState（N1）；4. networkidle 基于原生遥测零 CDP 检测面（W5）；5. 下载“停环境前有效”（§4.5，适配 CLI 一次性脚本）；6. `acquire --wait`（C1）；7. Vault.fill 的 `allowedDomains`（抄 Browser Use secret_bindings，加分项，向后兼容）。

---

## 9. 重构与兼容说明

1. 唯一行为变更两处：① `press(key)` 保留但推荐 `press(sel, chord)`；② 选择器多匹配从“取第一个”改为 `TARGET_AMBIGUOUS` 报错。两处都要进 HANDOFF。
2. `browser-control.ts` 改转出文件；`environments.ts`/`tabs.ts`/`telemetry.ts` 只做加法（新回调/新字段/新方法）。
3. `bin/warren.mjs` 的 `makePage` 是 agent 的事实 SDK：新方法命名与 Ego 对齐（`goto/snapshot/waitForURL/...`），老名字（`snapshot/screenshot/waitFor/click/fill/press/tabs/...`）全保留。

---

## 10. 验收表（宣称完成前逐项实测，贴输出）

观察/导航：snapshot 三 scope + subtree 取 iframe 内节点；screenshot fullPage/clip；info；events 消费语义；goto referer/waitUntil(networkidle)；reload；超时带 committed。
等待：URL/Selector 各 state/Function/LoadState 四态/Timeout/Event 四种。
动作：dblclick/hover(菜单展开)/drag(滑块或 DnD 页)/fill 回填确认/selectOption 多选+清空/focus/press chord(`ControlOrMeta+A`)；歧义报 AMBIGUOUS；stale 报 STALE。
弹窗文件：alert/confirm/prompt 的 accept/dismiss；popup 新 tab 信息；下载 saveAs 落盘可读；上传 fixture 文件名回显。
逃生舱：evaluate 求和/dom 抽取；fetch 同站带 cookie/跨站 omit；cdp 白名单过、黑名单 `CDP_BLOCKED`；脱敏（返回含 password 字段变 `[REDACTED]`）。Vault：`allowedDomains` 命中放行、未命中拒绝并记事件。
键鼠：坐标 click；wheel 滚动；paste 富文本；后台 tab 输入报 TAB_NOT_VISIBLE、evaluate 可跑。
回归：AGENTS 强制三件套（tsc/15+单测/vite build）+ `npm start` 后 fixture 全流程 + `debug.layout` 挂载探针。
文档：HANDOFF「当前状态」增补（RPC/CLI/数据模型三节，见 AGENTS 项目变更记录要求）。

---

## 11. 文件清单（新建/大改）

新建：`src/main/browser/` 9 文件、`tests/target.test.ts chord.test.ts refs.test.ts policy.test.ts wait-matcher.test.ts`、`fixtures/capability/` 6 页、本计划 + 调研已落盘。 大改：`rpc.ts`（+30 case）、`bin/warren.mjs`（makePage 翻倍）、`shared/types.ts`（加法）、`environments.ts`（pending 队列 + will-download）、`tabs.ts`（onPopup）、`telemetry.ts`（tabId + lastActivityAt）。

---

## 12. 实施记录（2026-10-14 落地，实测过）

§3 清单全部落地并实测。落地时相对本计划有 5 处**偏离**，都以实测为准：

| # | 计划写法 | 实际落地 | 为什么 |
|---|---|---|---|
| 1 | `src/main/browser/` 拆 9 文件 | 拆成 8 个（`controller/session/target/refs/input/matcher/policy/pending`） | `snapshot/actions/waits/dialogs/evaluate` 全在一个 controller 里更短；拆开后每个文件都要重复注入 ctx，收益不抵成本。`pending.ts` 是计划外的（环境级队列需要一个可单测的落点） |
| 2 | `keyboard.paste` = 写剪贴板 + 原生 ⌘V + 恢复 | 直接插内容（`insertText` / `execCommand('insertHTML')`） | CDP 合成的 ⌘V 在 Electron 里**不会**触发原生粘贴（Chromium 的粘贴是浏览器侧行为）。原方案是静默失败。代价：不触发 `paste` 事件、不碰用户剪贴板 |
| 3 | `prompt` 型 dialog 可 accept(promptText) | 代码路径保留，但 Electron 里 `window.prompt()` 调用即抛 | 平台限制，实测。alert/confirm 正常 |
| 4 | `waitForFileChooser` = 原生 chooser 事件 | 轮询 `input[type=file]` attached | Electron 无原生 chooser 事件（计划已预判，落地确认） |
| 5 | `subtree{root}` 用 childIds 过滤 | 同 frame 用 childIds；root 是 iframe 时换成**子 frame 整棵** | `getFullAXTree` 不返回子 frame 内容，childIds 在 iframe 上是空的 |

落地时新增的 3 条硬校验（都在实测里发现「静默失败」才补的）：

1. `assertInputFocus()` → `WINDOW_NOT_FOCUSED`：macOS 窗口不在前台时 CDP 输入被系统丢掉（坐标对、命令成功、页面没反应）。`acceptDialog/dismissDialog` 不受此限，否则 dialog 卡住时无法自救。
2. `#assertNoDialog()` 前置到 `navigate/reload/evaluate`：未处理的 dialog 会把它们挂到 RPC 60s 超时。`session.ts` 把「当前 dialog」和「事件队列」分开记，`events()` 读走副本不影响守卫。
3. `#sendInput()`：输入命令与「dialog 是否已打开」赛跑，避免「点击触发 alert」把脚本挂死。

另外补的两处计划外修正：`text=` 匹配优先可交互节点（否则每个按钮都会被自己的 StaticText 子节点搞成歧义）；CSS 选择器走页面内递归（穿透 open shadow root + 同源 iframe），不再用 `DOM.querySelectorAll`。
