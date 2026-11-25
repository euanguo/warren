# Warren 浏览器能力调研（Ego / Playwright / Browser Use 对标）

> 状态：调研结论（2026-10-14，已用三方最新文档核验）。只记录事实与取舍，不含实施步骤（实施见 `BROWSER-CAPABILITY-PLAN.md`）。
> 核验来源（均为 2026-10-14 当天抓取）：
> - Ego：本地 Skill v2.0.0（2026-09-09）`SKILL.md` 全文 + `references/api.md`（由 `public-api-schema.ts` 生成，脚本逐条提取 76 个 API）+ `references/clearing-state.md`。注：`ego-browser` CLI（0.5.1.13 / chromium 152）在 agent 沙箱里连不上 bootstrap（须 Full Access 或宿主直接跑），运行时行为以 Skill 文档为准。
> - Playwright：`playwright.dev/docs/api/` 八个类文档全文解析（Page / Frame / Keyboard / Mouse / Dialog / Download / FileChooser / BrowserContext，最新稳定版，含 v1.49+ `ariaSnapshot`、v1.62+ `signal`、v1.63 `ariaSnapshotJSON`）。
> - Browser Use：`docs.browser-use.com/.well-known/llms-full.txt` 全量包（46 万字符）+ `llms.txt` 索引：开源库内置动作表、Tools registry、`ActionResult`、`sensitive_data`、hooks、Actor API（legacy）、CLI、MCP server、skills、Cloud V4 语义。
> Warren 现状来自本仓库代码（`browser-control.ts` / `rpc.ts` / `environments.ts` / `tabs.ts` / `bin/warren.mjs`）。

---

## 1. Warren 现状（实测基线）

`browser.*` 8 个 + `tab.*` 4 个 + `vault.fill`，观察主通道是 AX 树。`exec <env>` 一次跑整段脚本的形态已对齐 `ego-browser nodejs`。

| 分类 | Warren 已有 | 说明 |
|---|---|---|
| 观察 | `snapshot`（AX 全量前 400，无 ref）、`screenshot`（整视口 PNG/JPEG）、`url/title`（隐含在 snapshot 返回里）、`console/network`（原生事件遥测，各 300 条） | 主通道 AX 树，截图次通道；`debug.layout/rendererEval` 仅 dev |
| 导航 | `navigate(url)`（等 `did-stop-loading`，30s 兜底） | 无 `referer/waitUntil/timeout` |
| 等待 | `waitFor({text/role/selector})` 轮询 15s | 无 URL/函数/loadState/事件等待 |
| 元素 | `click(target)`、`fill(target,value)`、`press(key)`（全局，不绑定元素） | Target 只有 `role/text/label/selector` 四种；无超时、无双击/悬停/拖拽/下拉 |
| 标签 | `tab.list/new/select/close`，`--tab=N` 作用到非激活标签 | `window.open` 全收敛成同环境标签；`ENV_NOT_VISIBLE` 后台不可操作 |
| 协作 | `env.acquire/release/takeover` + lease（60s TTL）+ 原生遮罩 | 人和 agent 看同一页面实例 |
| 逃生舱 | 无 | 无 `evaluate/fetch/cdp`，复杂页面直接卡死 |
| 弹窗文件 | 无 | dialog/popup/download/upload 全无 |
| 键鼠坐标 | 无 | canvas/富文本/表格/地图不可用 |

关键架构约束（不能推翻，见 HANDOFF §3）：单 Environment 单 session（标签共享登录态/代理）、窗口里同时只有一个环境的页面可见、遥测走原生事件不碰 CDP `Runtime/Network.enable`、插件非沙箱、Vault 无 reveal、`storage.cookie.*` 在 denied 层。

---

## 2. Ego 全量能力（76 个 API，去重后）

已用脚本逐条提取 `references/api.md`，按组归纳（参数细节以该文件为准）：

### 2.1 观察（7）

- `snapshot({scope, root, includeActionMarks, includeStableLocator})`：scope = `only_within_viewport`（默认，含可见 iframe）/ `full_page` / `subtree`（配 iframe 的 ref）；节点带稳定 `ref`（如 `@21`），跨动作凭 ref 或 `loc=` 重定位；导航后需重新 snapshot。
- `screenshot({path, fullPage, clip, scale, raw})`：PNG 落盘，自动建父目录。
- `url()` / `title()` / `info()`：后者含 popup/dialog 等即时状态。
- `console/network`：Ego 走 CDP；Warren 已用原生事件实现，不必改。
- `events()`：读并清空本 Page 缓冲的 CDP 事件（非 EventEmitter）。

### 2.2 导航与等待（10）

- `goto(url, {referer, timeout, waitUntil})` / `reload({timeout, waitUntil})`：`waitUntil = commit/domcontentloaded/load/networkidle`（默认 load；networkidle = 500ms 无网络活动）；超时错误带 `committed/url/readyState`。
- `waitForURL(matcher)` / `waitForSelector(sel, {state})` / `waitForFunction(fn, arg, {timeout,polling})` / `waitForLoadState(state, {idleMs})` / `waitForTimeout(ms)` / `waitForEvent(popup/download/dialog/fileChooser)`。
- 规则：先 arm 再触发（`const p = waitForEvent(...); await click(...); await p`）；snapshot 只拍当前时刻，不等待稳定。

### 2.3 元素（11）

- `click/dblclick/hover/dragAndDrop`：统一 `{button, clickCount/delay, position, force, timeout(默认3000), label}`；`click/fill/hover/drag` 自动滚入视口（wheel 输入）；`force` 跳过指针遮挡检查。
- `fill(sel, value, {clearFirst, timeout})`：找到 field / editing host / 唯一可填后代，填完确认生效。
- `selectOption(sel, valueOrValues, {timeout})`：字符串匹配 value 或 label，`{value,label,index}`，数组多选，`null/[]` 清空；select 本身须可用，禁用的 option 仍可编程选中。
- `focus(sel)`：元素 / 最近可交互祖先 / 唯一可编辑后代。
- `press(sel, chord, {delay, timeout})`：先聚焦再按键；命名键大小写不敏感，单字符保留大小写；`ControlOrMeta` 可移植。
- `setInputFiles(sel, paths)` / `waitForFileChooser()` / `close()`。

### 2.4 弹窗与对话（4）

- 高层动作回执 `receipt.popups: [{label, targetId}]` + `receipt.dialog`；显式等待优先。
- `acceptDialog(promptText?)` / `dismissDialog()`：同步 JS 对话框出现后、继续前必须处理。
- `task.tabs()` 含非托管 tab `{label?, page, targetId, title, url, active, openedBy}`；`adopt` 纳管、`release` 交还用户、`close` 只关 agent 建的页；`openedBy: unknown` 按用户页对待。

### 2.5 文件与请求（10）

- 上传：已有 input 直接 `setInputFiles(绝对路径)`；动态 input 先 `waitForFileChooser` 再点。
- 下载：先 arm `waitForEvent('download')` 再点；`saveAs(绝对路径)` 等完成并建父目录；`path()` 只给回合内临时文件（回合结束删除，`saveAs` 必须在脚本内调用）；`failure/cancel/delete` 管生命周期；禁止用 raw CDP 设全局下载目录（每次下载只配当前 Page 会话）。
- `fetch(url, opts)`：跑在页面里的 `window.fetch`（相对 URL、cookie、SW、浏览器 CORS 全跟页面走），返回 `{ok,status,statusText,url,headers,body}`；二进制用 `{saveAs}` 直接落盘不转文本；与 Node `fetch` 分工明确。

### 2.6 逃生舱（3）

- `evaluate(fnOrString, arg)`：只进页面，闭包读不到外层变量与 Node 模块；唯一 JSON 参数；无 timeout 选项，大任务拆成有界调用，安全超时后看 `executionStopped/mayHaveLateEffects` 决定是否先 reload/close。
- `page.cdp(method, params)`：Page/Runtime/DOM/Network/Input 等走 page；`task.cdp`：Target/Browser 域走 task。raw CDP 使 ref 失效，`targetId` 不跨回合持久。
- Ego 明确非 Playwright：`locator/getByRole/context/expect/route` 等不可推断，没有就走 `evaluate/cdp`。

### 2.7 选择器

`@21` / `ref=21` / `text=`（不引号：折叠空白、忽略大小写、子串；引号：精确区分大小写）/ `loc=css:/role:/href:` / `xpath=` / 裸 CSS；Playwright 子集：`css=`、末尾 `:has-text/:text-is`、`>> nth=N`（-1 或非负）、`loc=role:...[name*="..."]`，其余不支持。动作要求唯一匹配；wrapper 语义：`focus/press` 可上浮到可交互祖先或下钻到唯一可编辑后代，`fill/setInputFiles` 只下钻到唯一兼容控件；CSS 穿透 open shadow root；先顶文档后搜 frame。

### 2.8 任务协作

一个目标一个 TaskSpace（建一次、打印 `spaceId`、后继回合复用；新人格只在用户明示时开）；卡住不另开 space 恢复；每调用新 Node 进程，变量不跨回合，space/tab/label 跨回合；新 space 从 `p1` 开始，原地 `goto` 复用；`handOff` 交人（后继 `takeOverTaskSpace` + `userPage`）、`waitForControl` 原地等；完成默认 `finish({keep: []})`（只调一次，调完再汇报），`keep` 仅在用户明示或结果页需留人看时用；权限弹窗/设备选择等浏览器自有 UI 必须交人，不绕行；`[ego-browser:notice]` 见后收尾再提示升级。

### 2.9 状态清除（见 `references/clearing-state.md`，重点）

- `Network.deleteCookies`（单个）/ `Storage.clearDataForOrigin`（单个 origin）/ `Page.reload{ignoreCache}`（单次加载）是安全档。
- `Network.clearBrowserCookies` / `Network.clearBrowserCache` / 无 `browserContextId` 的 `Storage.clearCookies` 是**整 profile**（实测一 profile 3478 cookie / 1161 域），不可撤销，事前必须报数并经用户批准； scoped 方法能办就不用整 profile 的；`page.cdp` 选的是发送会话，不缩小作用域。

---

## 3. Playwright 对照（2026-10-14 官方文档已核验）

> 方法清单来自 `playwright.dev/docs/api/` 八个类全文：Page 约 100 方法、Frame 约 80、Keyboard 7、Mouse 7、Dialog 7、Download 10、FileChooser 6。定位器推荐 `page.getByRole/getByText/getByLabel/getByPlaceholder/getByTestId/getByTitle/locator`，旧 `page.click/fill/...` 标 Discouraged（仍可用）。

- 定位器：`getByRole/getByText/getByLabel/getByPlaceholder/getByTestId/getByTitle/locator(css/xpath)`；`strict: true` 要求唯一（多匹配抛错——这正是计划里 `TARGET_AMBIGUOUS` 的对标）；`nth/first/last/filter({has, hasText})/and/or`；`ariaSnapshot({mode:'ai', boxes, depth})`（v1.49+，AI 优化版带 `[ref=e2]` 引用，与 Ego ref 同构）/`ariaSnapshotJSON`（v1.63）。
- 动作（统一 `timeout/strict/signal(AbortSignal, v1.62+)/force/position/trial/noWaitAfter(已废弃)`）：`click/dblclick/hover/dragTo/fill/press/selectOption/check/uncheck/setChecked/setInputFiles/pressSequentially/type/dispatchEvent/tap/blur`。`fill` 自动清空（关联 label 的 control 代填）；`selectOption` 按 value/label/index，返回成功选中的 value 数组，触发 change+input；`press` 键名见 keyboard（`F1-F12/Digit0-9/KeyA-Z/Shift/Control/Alt/Meta/ShiftLeft/ControlOrMeta`，mac 上 `ControlOrMeta`=Meta，`Control+o`/`Control+Shift+T` 形 chord，单字符区分大小写；`keyboard.type` 修饰键无效、非美式键盘只发 input 事件，文档明确“能用 fill 就别用 type”，pressSequentially 做逐键）。
- 等待：`waitForSelector/waitForURL/waitForFunction/waitForLoadState/waitForEvent/waitForRequest/waitForResponse/waitForTimeout` + `waitForNavigation`；`waitUntil` 含 networkidle；等待默认 30s（可 `setDefaultTimeout` 改，`0` 禁用）；`expect(locator).toHaveText/toMatchAriaSnapshot` 自带重试（Warren 不做断言库，agent 侧用 waitForFunction 替代）。
- 读取：`innerText/innerHTML/textContent/inputValue/getAttribute/isChecked/isDisabled/isEditable/isEnabled/isHidden/isVisible/boundingBox/content/getByRef/url/title/consoleMessages/pageErrors/requests`。注意：`locator.all()` 不等待、动态列表用它会 flaky（Warren snapshot 同理：只拍当前时刻，不等稳定，文档已写明）。
- 框架：BrowserContext（cookie/storage 隔离）、多页、`frameLocator`、视频/trace/HAR、`route/unroute/routeFromHAR/routeWebSocket` mock、`request` 独立上下文、`pdf/addInitScript/exposeFunction`。Warren 只取**动作与等待语义**，不取 Context/route/HAR/视频（与单 session + 人机同视架构冲突）。
- Mouse/Keyboard/Dialog/Download/FileChooser 口径：mouse `click/move/down/up/dblclick/wheel`；keyboard `type/down/up/insertText/press/fill/pressSequentially`；dialog `{type,message,defaultValue,page}/accept/dismiss`（Warren 的 `DIALOG_OPEN` 语义对标其 auto-dismiss 之前的阻塞态）；download `{url/page/suggestedFilename/saveAs/path/createReadStream/failure/cancel/delete}`（Warren 取 `saveAs/path/failure/cancel` 子集，流式读不做）；fileChooser `{element/isMultiple/page/setFiles}`。

---

## 4. Browser Use 对照（2026-10-14 全量文档包已核验）

> 来源 `llms-full.txt`（46 万字符）：开源库（79k★ Python）与 Cloud V4 是两套 API，不可混用。下面只取开源库侧（Warren 对标它），Cloud 侧（runs/sessions/workspaces/计费/并发）仅记录可借鉴点。

- 开源内置动作（`Tools` registry，agent 可 `exclude_actions` 裁剪）：导航 `search(DuckDuckGo/Google/Bing)/navigate/go_back/wait(秒)`；交互 `click(按index)/input/upload_file/scroll/find_text(滚到文本)/send_keys`；`evaluate(JS)`；标签 `switch/close`；`extract(LLM 抽取)/screenshot(下一状态带图)`；表单 `dropdown_options/select_dropdown`；文件 `write_file/read_file/replace_file`；`done` 常可用。
- Actor API（legacy，CDP 直连、Playwright 子集，官方声明“Not Playwright”）：`Browser/BrowserSession.new_page/get_pages/get_current_page/close_page`；Page `goto/go_back/go_forward/reload`、`get_elements_by_css_selector(立即返回不等可见)`、`get_element(backend_node_id)`、`get_element_by_prompt/must_get_element_by_prompt(LLM 找元素)`、`evaluate(箭头函数格式)`、`press/screenshot/set_viewport_size/get_url/get_title/extract_content(prompt, pydantic)`；Element `click/fill(clear)/hover/focus/check/select_option/drag_to/get_attribute/get_bounding_box/get_basic_info/screenshot`；Mouse `click/move/down/up/scroll`。Warren 已有 backendNodeId 链路，`get_element_by_prompt` 不做（Warren 用 snapshot ref + 选择器，确定性优先）。
- `ActionResult`（Warren receipt 的对标）：`{extracted_content(给 LLM，可 once)/long_term_memory(常驻上下文)/error/is_done/success/attachments/metadata}`。Warren 取其“收据与上下文分离”思想：写动作返回小收据（`{popups?, dialog?}`），大内容走 snapshot/events，不塞进返回值。
- 自定义动作：`@tools.action('描述')` 装饰器，参数必须叫 `browser_session: BrowserSession`（按名注入，写错静默失败）；可用 Playwright 函数混写；Warren 对应物是现有插件 `plugin.run`，不另造 registry（差异：Warren 插件跑在 node:vm + 权限门控，见硬约束）。
- `sensitive_data`（Warren Vault 的对标，语义值得抄）：`{alias: value}` 或按域名正则分账号；LLM 只见占位符，真值绕过 LLM 直填表单；配套 `allowed_domains` 限制导航 + `use_vision=False` 防截图泄密 + 优先 `storage_state` 复用登录。注意官方警告：填进去后值对页面可见，防不住有 browser/CDP 权限的 agent——Warren 的 Vault.fill 同理，文档要写同一句话。
- 生命周期 hooks：`on_step_start/on_step_end(agent)`，可读 `agent.tools/llm/browser_session/history/pause/resume/add_new_task`，可用 `event_bus.dispatch(ScreenshotEvent)`。Warren 不做常驻 agent 循环，hooks 无挂载点；对应能力落到 `events.list`（人类可读审计）+ 插件 `run`，本期不新增 hook 通道。
- MCP server 工具表（Warren 若以后做 MCP 可直接对标命名）：`retry_with_browser_use_agent`（兜底整任务）/ `browser_navigate/click/type/get_state/scroll/go_back` / `browser_list_tabs/switch_tab/close_tab` / `browser_extract_content/get_html/screenshot` / `browser_list_sessions/close_session/close_all`。
- CLI 形态（与 `warren exec` 同构，细节可抄）：`uvx browser-use <<'PY'` 跑 Python；三种浏览器模式（本地 Chrome CDP 复用登录态 / 云浏览器 / 任意 `BU_CDP_URL`）；`browser-use --doctor` 自检；具名云会话（`start_remote_daemon("work")` + `BU_NAME=work` 后继复用——对标 Warren `exec <env>` 每次带 env 寻址，无隐藏当前环境）；skill 经 skills.sh 分发（`npx skills add …`）。
- Cloud V4 可借鉴不照搬：`secret_bindings{alias, allowedDomains(裸 host，子域继承，20x20上限)}`（Vault.fill 可加 `allowedDomains` 参数，列入计划增补）；`liveUrl` 实时看屏（Warren 人机同视已覆盖）；`is_done` 只报终态、`is_successful` 需独立验证（Warren receipt 同理：只报派发+即时 popup/dialog，不验证应用态）；客户端超时不等于服务端取消（Warren RPC 60s 超时同理，文档已写明）；`after` 游标增量拉事件（`events.list` 若以后分页可抄）。

---

## 5. 去重后完整能力矩阵 → Warren 取舍

| # | 能力 | 对标来源 | Warren 决策 |
|---|---|---|---|
| O1 | snapshot ref + viewport/full_page/subtree | Ego | 做。无 ref 则一切动作都贵且脆 |
| O2 | screenshot path/fullPage/clip | Ego/Playwright | 做（`clip/fullPage`，`scale/raw` 首版固定默认） |
| O3 | url/title/info | Ego | 做 `browser.info`（url+title+loading+dialog+tab） |
| O4 | events 缓冲读取消 | Ego | 做 `browser.events`（dialog/popup/download/fileChooser 聚合，原生+CDP 事件统一口） |
| N1 | goto/reload `{referer,timeout,waitUntil}` | Ego/Playwright | 做；networkidle 用遥测 `webRequest.onCompleted` 空闲窗口实现 |
| W1 | waitForURL/Selector(state)/Function/LoadState/Timeout/Event | Ego/Playwright | 全做；`waitForTimeout` 服务端实现保脚本原子性 |
| E1 | click/dblclick/hover/dragAndDrop `{timeout,position}` | Ego/Playwright | 做；`force` 接受参数但 Warren 恒为直发（无遮挡检查可跳，文档写明） |
| E2 | fill `{clearFirst}` + 生效确认 | Ego/Playwright | 做（focus → 全选 → insertText → 读值确认） |
| E3 | selectOption/focus/press(sel,chord) | Ego/Playwright | 做；chord 支持 `ControlOrMeta` |
| E4 | 选择器 `ref/text=/loc=/xpath=/css=/nth` | Ego | 做解析层（归一到现有 Target + 新增 ref/xpath），不支持的报 `BAD_SELECTOR` 不猜 |
| D1 | dialog accept/dismiss + popup 先等后取 + receipt | Ego | 做；dialog 经 `Page.javascriptDialogOpening` 捕获 |
| F1 | setInputFiles + waitForFileChooser | Ego/Playwright | 做；chooser 以“文件 input 存在性轮询”实现（Electron 原生弹框无 CDP 事件） |
| F2 | download wait + saveAs | Ego/Playwright | 做；每环境 session `will-download` 落临时区，`saveAs` 移走；禁全局下载目录 |
| S1 | evaluate/fetch/cdp | Ego | 做，**全部走 lease 写门控**；cdp 白名单制（见 §6） |
| M1 | mouse.click/move/down/up/wheel 坐标 | Ego | 做；CSS 像素；`label` 写事件流供人看 |
| M2 | keyboard.down/up/press/type/insertText/paste | Ego | 做；macOS paste 走原生粘贴并恢复剪贴板 |
| C1 | adopt/release/userPage | Ego | 不做独立语义：Warren 全标签已托管，`release` = 保留标签不关（文档映射），`userPage` = 当前激活标签 |
| C2 | handOff/waitForControl/finish(keep) | Ego | 映射不另造：`handOff` = `env.release` 交人；`waitForControl` = 带超时的 acquire 轮询；`finish` 不做（环境生命周期已有 start/stop） |
| C3 | profiles/spaces | Ego | 映射：profile = Environment，space 操作 = env/tab 命令，不另造一层 |
| X1 | route/mock/HAR/视频/多 context | Playwright | 不做：与“人机同视 + 单 session”冲突，且多一倍内存/复杂度 |
| X2 | 整 profile 清除 | Ego（禁） | 不做：只给 `clearDataForOrigin` 级别（见 §6） |
| X3 | 指纹/内核替换 | 竞品 | 不做（HANDOFF §3.1 已否决） |

---

## 6. 安全与约束（硬约束不变，新增三条）

1. 沿用：插件非沙箱不谎称；Vault 无 reveal（`evaluate/fetch` 返回值过凭据脱敏，`fill` 仍是唯一密码入口）；`vault add` 走 stdin；代理无凭据拒绝；`storage.cookie.*` denied。
2. 新增：`evaluate/fetch/cdp` 默认**写操作**（可变页面），必须 `assertWritable + assertVisible`；`fetch` 默认禁跨站凭据外带（`credentials: omit`，同站才跟 cookie）；`cdp` 白名单域 `Page/Runtime/DOM/Accessibility/Input/Emulation/Overlay`，黑名单方法 `Network.clearBrowserCookies/clearBrowserCache、Storage.clearCookies（无 browserContextId）、Browser.*/Target.*（除白名单内只读）`，命中黑名单报 `CDP_BLOCKED` 并记事件。
3. 新增：`clearData` 只暴露 `Storage.clearDataForOrigin{origin, storageTypes}` 单 origin 版；整 profile 清除无 RPC；`setInputFiles/saveAs/fetch.saveAs` 路径必须绝对路径且禁 `~/.warren` / `core/` 数据目录；下载临时区回合内有效，`saveAs` 必须在同脚本内调用（与 Ego 一致）。
4. 落地后新增的平台级限制（Electron 与真 Chrome 的差异，实测）：`window.prompt()` 调用即抛；CDP 合成 ⌘V 不触发原生粘贴；窗口不在前台时输入被系统丢弃。三条都已在 `BROWSER-CAPABILITY-PLAN.md` §12 与 `HANDOFF.md` 记录，能力对标时**不要按 Ego/Playwright 的语义假设它们可用**。

---

## 7. 术语映射（防串台）

| Ego / Playwright 词 | Warren 词 |
|---|---|
| TaskSpace / profile | Environment（`env.*`） |
| Page(p1/p2…) | Tab（`tab.*`，`--tab` / `tabId` 寻址） |
| `task.page(label)` | 当前激活标签（缺省）或 `--tab` 显式寻址 |
| `handOff/waitForControl` | `env.release` / 带超时 `env.acquire` 轮询 |
| `finish({keep})` | 不做；用 `tab.close` / `env.stop` |
| receipt popups/dialog | 写动作返回值里的 `{popups?, dialog?}` + `browser.events` |
| label（光标旁文案） | `label` 参数 → `events.list` 人可见描述（无光标叠加层，不做） |
