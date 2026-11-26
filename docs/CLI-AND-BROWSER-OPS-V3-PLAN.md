# Warren Agent CLI & Browser Ops v3 全面增强施工计划（P0 → P2）

> **编制日期**：2026-11-26  
> **调研依据**：[AGENT-CLI-AND-BROWSER-OPS-DEEP-RESEARCH.md](./AGENT-CLI-AND-BROWSER-OPS-DEEP-RESEARCH.md)（横向深挖 11 个头部开源项目，审计出 34 项缺口 `G1`–`G34`）  
> **安全底线**：100% 守住 `AGENTS.md` 硬约束与 `WARREN-2.0-ARCHITECTURE-PLAN.md` §0.2（不暴露 `--remote-debugging-port`、不常开 `Runtime.enable`/`Network.enable`、Vault 永无 reveal、Cookie 宽权限留 `denied`、权限单一来源、`app_settings`/`approval` 仅 IPC 可写、凭据/密码严禁明文落库或回显）。

---

## 一、总体波次与缺口映射

| 波次 | 主题 | 覆盖缺口 | 核心落点 |
|---|---|---|---|
| **P0-A** | 输入内核、双击状态机、`PendingRelease` 与精准几何点击点 | `G1`, `G2`, `G3`, `G4`, `G5`, `G19`, `G20` | `input.ts`, `click-point.ts`(新), `mouse-state.ts`, `input-synthesis.ts`, `actions.ts`, `keymouse.ts`, `controller.ts` |
| **P0-B** | 可用性检测、Sticky 滚动轮转、Portal 保护、顶层模态与 AX 遮挡诊断 | `G6`, `G7`, `G8`, `G9`, `G10` | `actionability.ts`, `page-helpers.ts`, `actions.ts` |
| **P0-C** | 现代 SPA 表单引擎（`fill` / `selectOption` / `check` / `uncheck` / `drag` / `drop`） | `G11`, `G12`, `G13` | `actions.ts`, `controller.ts`, `rpc-dispatch.ts` |
| **P0-D** | 语义缩进快照树、混合 DOM 补盲、分层预算、稳定自愈 Ref、OOPIF/Closed Shadow | `G14`, `G15`, `G16`, `G17`, `G18`, `G33` | `shared/types/browser.ts`, `snapshot.ts`, `ops/snapshot-compact.ts`, `refs.ts`, `controller.ts` |
| **P1** | 原子 CLI 命令、Telemetry 在途请求与游标修复、`smartSettle`、带 Ref 的 Delta、`read`/`diff` 重写、输出安全与 Remedy/Budget | `G21`, `G22`, `G23`, `G24`, `G25`, `G26`, `G27`, `G28`, `G30` | `telemetry.ts`, `waits.ts`, `ops/batch.ts`, `ops/reader.ts`, `ops/diff.ts`, `ops/remedy.ts`(新), `ops/output-guard.ts`(新), `ops/budget.ts`(新), `rpc.ts`, `rpc-dispatch.ts`, `rpc-methods.ts`, `bin/{commands,warren,exec-runtime}.mjs` |
| **P2** | 标注截图、浏览器仿真、WebMCP、只读 Saved Flows、诊断工具箱（Vitals/A11y/React/PDF）、自动弹窗策略 | `G29`, `G31`, `G32`, `G34` | `ops/annotate.ts`(新), `ops/emulation.ts`(新), `ops/webmcp.ts`(新), `ops/flow.ts`(新), `ops/diagnostics.ts`(新), `db.ts`, `store.ts`, `controller.ts`, `rpc-dispatch.ts`, `bin/warren.mjs` |
| **验收** | 全量单测、`SKILL.md` & `HANDOFF.md` 同步、5 条强制门禁、Electron 实机回归 | 全部 | `tests/*`, `skills/warren/SKILL.md`, `docs/HANDOFF.md`, `scripts/serve-fixture.mjs` |

---

## 二、逐波次详细设计与验收标准

### 波次 P0-A：输入内核、双击状态机、Dialog 断键恢复与精准几何点

1. **完整 US 键盘 VK/Code/Text/Location 映射 (`src/main/browser/input.ts`)**
   - 修复标点 `windowsVirtualKeyCode` 错映（如 `.` 被算成 ASCII 46 = `VK_DELETE`），补全 US 键盘 `VK_OEM_*` 表（`; = , - . / \` [ \\ ] '`）及 Shift 标点反向推导（`! @ # $ % ^ & * ( ) _ + { } | : " < > ? ~`）。
   - 为命名键补齐标准 VK 码与 `text`：`Enter`（`vk=13, text='\r'`）、`Tab`（`vk=9, text='\t'`）、`Space`/`' '`（`vk=32, code='Space', text=' '`）、`Escape`（27）、`Backspace`（8）、`Delete`（46）、`ArrowLeft/Up/Right/Down`（37–40，`text=undefined` 保持现有单测契约）、`Home`/`End`/`PageUp`/`PageDown`/`Insert`/`F1`–`F12`、`Numpad0`–`9`。
   - 补全常用别名：`Esc` → `Escape`、`Return` → `Enter`、`Space` → `' '`、`Up`/`Down`/`Left`/`Right` → `Arrow*`、`Ctrl` → `Control`、`Cmd`/`Command` → `Meta`、`ShiftRight` 等；支持 `location`（Left=1, Right=2）。
   - 修复组合键误发文本：当 `modifiers & (1 | 2 | 4)`（Alt/Control/Meta）任一位开启时，`keyDown` 不发送 `text` 与 `unmodifiedText`。
   - 保持 `parseChord(chord)` 返回形状 `{ key, code, modifiers }`，不破坏 `tests/browser-pure.test.ts`。

2. **精准多边形点击点与跨 Shadow/Label 命中 (`src/main/browser/click-point.ts`)**
   - 纯几何函数：`quadArea`、`quadCenter`、`largestQuad`、`isPointInsideQuad`、`findIntegerPointInsideQuad`（先验重心取整，退化时采样四边中点与对角线插值）。
   - `contentQuadClickPoint`：优先 `DOM.getContentQuads` 取面积最大且有效的多边形并叠加 OOPIF 偏移，空结果时降级 `DOM.getBoxModel`。
   - `hitTestPoint`：使用 CDP `DOM.getNodeForLocation({ x, y, includeUserAgentShadowDOM: true, ignorePointerEventsNone: true })`，绕过页面脚本对 `document.elementFromPoint` 的劫持并穿透 Shadow DOM。
   - `checkTargetRelation`：隔离世界关系校验：命中节点等于目标、是目标后代、跨 Shadow host 归属，或是目标表单控件的关联 `<label>`（且点击路径上没有拦截事件的 `<a>`/`<button>` 嵌套交互元素）。

3. **真实双击、PendingRelease 与后台移动优化 (`actions.ts`, `mouse-state.ts`, `input-synthesis.ts`, `controller.ts`)**
   - `dblclick` 改为完整状态机：`Move → mousePressed(clickCount=1) → mouseReleased(1) → mousePressed(2) → mouseReleased(2)`。
   - `mouse-state.ts` 新增 `PendingRelease`（按 `wc.id` 存储未闭合的 `mousePressed` 坐标/按键/clickCount）；`controller.ts` 的 `#sendInput` 在因 dialog 提前返回时记录 pending release，`acceptDialog`/`dismissDialog` 处理完弹窗后立即补发 `mouseReleased` 清空浏览器内部按下态。
   - `input-synthesis.ts`：`inputPathEnabled()` 默认对未传 `humanize` 时返回 `false`（规避后台 tab 多步 `mouseMoved` 卡死 5s），仅当显式传入 `opts.humanize = true` 或环境变量 `WARREN_INPUT_PATH=1` 时启用贝塞尔轨迹。
   - `click` 支持 `newTab: true`（在 macOS 带 `Meta` 修饰键、非 macOS 带 `Control` 修饰键，并处理普通按钮/链接）。
   - `drag` 支持 `placement: 'before' | 'after' | 'center'`（目标边缘 15% 偏移，服务看板/排序列表）及 HTML5 `DataTransfer` 合成降级（`dragstart → dragenter → dragover → drop → dragend`），并新增 `drop`（`browser.drop`）把本地绝对路径文件以 `DataTransfer` 拖放进目标区（遵守 `checkInputFiles` 安全护栏）。

---

### 波次 P0-B：可用性检测、Sticky 滚动轮转、Portal 保护、顶层模态与 AX 遮挡诊断

1. **Sticky 遮挡四态滚动轮转 (`src/main/browser/page-helpers.ts`)**
   - `scrollIntoView(ctx, backendNodeId, retry = 0)`：按 `retry % 4` 轮转：
     - `0`：`DOM.scrollIntoViewIfNeeded`
     - `1`：`el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })`
     - `2`：`el.scrollIntoView({ block: 'end', inline: 'end', behavior: 'instant' })`
     - `3`：`el.scrollIntoView({ block: 'start', inline: 'start', behavior: 'instant' })`

2. **Portal 浮层菜单免滚动直点 (`src/main/browser/actionability.ts`, `actions.ts`)**
   - 检测 `role="menuitem"|"menuitemcheckbox"|"menuitemradio"|"option"` 且自身或祖先为 `position: fixed|absolute`（Radix/Base UI/MUI/Floating UI Portal）：若元素已在视口内，跳过 `scrollIntoView`，避免滚动触发浮层关闭导致 `NODE_DETACHED`。

3. **深度 Actionability + 顶层模态检测 + AX 语义遮挡描述 (`actionability.ts`, `page-helpers.ts`)**
   - `STATE_SCRIPT` 升级：
     - 用 `Element.prototype.tagName` 免疫 DOM Clobbering（如 `<form><input name="tagName"></form>`）。
     - 启用 `el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })` 与 `display: contents` 后代可见性检查。
     - 沿 Shadow host 向上遍历检测 `inert` 属性与禁用 `<fieldset disabled>`（跳过首个 `<legend>` 内子元素，符合 HTML 规范）。
     - 结合 CDP `DOM.getNodeForLocation` 命中校验 + `checkTargetRelation`（支持 `<label>` 代理）。
   - 顶层模态检测 `findTopmostModal`：若目标被遮挡，扫描 `:modal` / `[aria-modal="true"]` 做 5 点采样，精准识别阻塞模态框。
   - `describeAxBlocker`：被遮挡时调用 `Accessibility.getPartialAXTree({ backendNodeId: blockerId, fetchRelatives: false })`，输出人类/AI 可读的语义描述（如 `dialog "Cookie 设置"` 而非仅 `div.x1a2b`），附带结构化 `details.remedy`。

---

### 波次 P0-C：现代 SPA 表单引擎

1. **智能 `fill` (`src/main/browser/actions.ts`)**
   - 开头先 `scrollIntoView` + `<label>`/包装器自动重定位到真实可输入控件（`for` 属性或内部单个 `input`/`textarea`/`[contenteditable]`）。
   - 特殊原生类型（`date`/`time`/`datetime-local`/`month`/`week`/`color`/`range`）使用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` 绕过 React/Vue 值追踪器，并给出清晰格式校验提示（如 `YYYY-MM-DD`）。
   - 文本类清空：优先 CDP `Input.dispatchKeyEvent({ type: 'rawKeyDown', commands: ['selectAll'] })` + `Backspace`（若 `el.select()` 失败或为 `contenteditable` 富文本编辑器）。
   - 焦点转移检测（`MOVED_JS`）：穿透 Shadow DOM 读取真实 `activeElement`，兼容点击触发 Combobox 弹窗把焦点挪到浮层输入框的场景。
   - 混合输入法：`value.length > 0` 时对前 `n-1` 字符用 `Input.insertText`、最后 1 字符（ASCII 可打印字符）补发真实 `keyDown`/`keyUp` 触发 autocomplete / React onKeyDown / 日期筛选。
   - 分级回读确认：
     - `type="password"` 跳过值比对、绝不在错误或警告里回显明文；
     - `type="email"` / `contenteditable` 做空白归一化比对；
     - 遇到 `maxLength` 按 UTF-16 截断、格式化掩码（电话/金额/日期）改写时返回 `{ ok: true, warning: { kind, expectedLength, actualLength } }`，不再误抛致命 `FILL_UNCONFIRMED`；仅当输入完全未生效（空串或原值纹丝不动）时报错。
   - 支持 `submit: true`（`--submit`），填完自动发 `Enter`。

2. **原生 + ARIA `selectOption` (`src/main/browser/actions.ts`)**
   - 原生 `<select>`：检查 `opt.disabled`（选中禁用项直接报错），支持 `--by value|label|index`，找不到匹配项时抛 `TARGET_NOT_FOUND` 并在 `details.data.availableOptions` 返回前 30 个可用选项 `{ value, label, disabled }`。
   - 自定义 ARIA `combobox` / `listbox`：点击打开下拉 → 必要时键入过滤 → 扫描可见 `[role="option"]` 匹配文本或 `data-value` 并点击；未命中同样返回 `availableOptions`。

3. **幂等 `check` / `uncheck` (`src/main/browser/actions.ts`, `controller.ts`, `rpc-dispatch.ts`)**
   - `browser.check` / `browser.uncheck`：先读当前状态（`checked` / `aria-checked`），已满足直接返回 `{ ok: true, changed: false, checked }`（避免误反选）；
   - `radio` 拒绝 `uncheck`（报 `NOT_ACTIONABLE` 说明 HTML 规范不允许直接取消单选框）；
   - 对 CSS 隐藏的原生 checkbox（`sr-only` / `opacity:0`）自动定位关联 `<label>` 点击或触发 DOM `click()`，并校验状态翻转。

---

### 波次 P0-D：语义缩进快照树、混合 DOM 补盲、分层预算、稳定自愈 Ref、OOPIF/Closed Shadow

1. **类型扩展 (`src/shared/types/browser.ts`)**
   - `AxNode` 增量字段：`depth?: number`、`url?: string`、`nth?: number`、`cursorInteractive?: boolean`、`hiddenInput?: boolean`、`optionsSummary?: string[]`、`sensitive?: boolean`、`loaderId?: string`、`isNew?: boolean`、`box?: { x: number; y: number; width: number; height: number }`。
   - `SnapshotOptions` 增量字段：`compact?: boolean`、`urls?: boolean`、`maxDepth?: number`、`maxTokens?: number`、`filter?: string`、`includeCursor?: boolean`、`boxes?: boolean`、`frame?: string`。
   - `NetworkEntry` / `ConsoleEntry` 增加可选自增 `id?: number`。
   - `RpcResponse['error']` 增加可选 `details?: { hint?: string; remedy?: string; data?: Record<string, unknown> }`。

2. **层次化 AX 树 + 混合 DOM 补盲 (`src/main/browser/snapshot.ts`)**
   - 基于 `childIds` 深度优先遍历 AX 树记录真实 `depth`（而非拍平丢失层级）；收集各 frame 的 `loaderId`（来自 `Page.getFrameTree`）。
   - 合并相邻 `StaticText`、剪除与父按钮/链接同名的冗余子 `StaticText`、把 `MenuListPopup` / `<select>` 的选项摘要合并到父 `combobox` 节点。
   - 隔离世界 DOM 补盲（可按 `includeCursor` 等按需开启，默认开启密码脱敏与隐藏元素过滤）：
     - **密码脱敏**：识别 `input[type="password"]` 及 `autocomplete="current-password|new-password"`，强制将 `node.value` 脱敏为固定宽度 `"••••••••"`（不泄漏密码长度），设 `sensitive: true`。
     - **幽灵文本过滤**：剔除 `opacity: 0` / `visibility: hidden` 的视觉隐藏节点（保留文件输入框）。
     - **Cursor 交互补盲**：`includeCursor`（默认在 `-i` / `compact` 模式开启）扫描 `cursor: pointer`（父已 pointer 时去重，不把整块大容器误报）、`onclick`、`tabindex >= 0`、`[contenteditable]`，把 AX 漏掉的 clickable `<div>`/`<span>` 补为可交互节点并分配 `@N`。
     - **隐藏控件救回**：发现被自定义 UI 隐藏的 `<input type="radio|checkbox">`（提升关联 `<label>`）与 `<input type="file">`（标 `hiddenInput: true` 保留可上传 ref）。
     - **`-u` 链接解析**：`urls: true` 时提取 `a[href]` 真实 URL 附着到 `link` 节点。

3. **2 空格缩进语义树与分层 Token 预算 (`src/main/browser/ops/snapshot-compact.ts`)**
   - 修复 `-d`（`maxDepth`）改用真实 `node.depth`（修复原先错比 `node.level` 的 bug）。
   - 渲染真实 2 空格缩进语义树，`-i` 模式下支持保留关键语义祖先（`dialog`/`navigation`/`main`/`form`/`table`/`region`）或扁平交互列表（兼容现有单测格式断言 `- textbox "用户名" [value="alice", required, ref=@1]`）。
   - 3 态完整输出：`checked` / `unchecked`（checkbox/radio/switch 显式区分未勾选）/ `checked=mixed`。
   - 扩展交互角色集：`treeitem`, `listbox`, `gridcell`, `DisclosureTriangle`, `ColorWell`。
   - 同名 `(role, name)` 重复项自动附加 `nth=1`, `nth=2` 消歧标记；链接在 `urls: true` 时附 `/url`。
   - 支持 `--filter <text|/regex/>` 剪枝同时保留命中节点祖先链。
   - **分层 Token 预算截断**（`maxTokens`，默认按需保护）：Tier 1（可交互节点 + 模态框/表单内节点）→ Tier 2（标题/警报/状态语义上下文）→ Tier 3（其余文本），超预算时 80/20 首尾保留，避免截断底部弹窗/提交按钮，尾部打印清晰截断提示与 `--selector`/`--filter` 建议。

4. **跨快照稳定 & 自愈 Ref (`src/main/browser/refs.ts`, `snapshot.ts`, `controller.ts`)**
   - 保留 `register(backendIds)` 原有语义，100% 兼容 `tests/refs.test.ts` 与 `tests/browser-pure.test.ts`。
   - 新增 `registerStable(entries, frameLoaders)`：
     - 每条记录绑定 `(sessionId, frameId, loaderId, backendId, role, name, nthInRoleName)`；
     - 同一文档未导航时，相同 `backendId` 复原其原有 `@N` 编号，新增节点分配递增量新号并标记 `isNew: true`；
     - 解析时校验对应 `frameId` 的 `loaderId`，子 iframe 导航精确失效该 frame 的 ref 而不误伤主文档；
     - 新增 `tryHeal(ref, currentNodes)`：若原 `backendId` 因 React 重绘脱离 DOM，但在当前快照中 `(frameId, role, name)` 唯一匹配 1 个新节点，则自动自愈到新 `backendId` 并回传 `healed: true`。

5. **OOPIF 全选择器覆盖 + Frame 作用域 + Closed Shadow (`src/main/browser/controller.ts`)**
   - CSS (`#backendIdsBySelector`) 与 XPath (`#xpathBackendIds`) 扩展至全部 OOPIF `childSessions()`（按 `sessionId` 缓存各自隔离世界 `contextId`），主/子会话统一返回 `{ backendNodeId, sessionId }`。
   - 新增 `frame` 作用域状态（`browser.frame`：`list` / `select` / `main`），选中子 frame 后快照与定位默认限定在该 frame。
   - CSS 常规遍历零命中时，新增 CDP `DOM.getDocument({ depth: -1, pierce: true })` 兜底搜索 Closed Shadow Root 节点。

---

### 波次 P1：原子 CLI、Telemetry 在途请求与游标修复、`smartSettle`、`read`/`diff` 重写与安全输出治理

1. **Telemetry 增强（零 CDP `Network.enable`）(`src/main/telemetry.ts`, `session-factory.ts`, `environments.ts`, `view-coordinator.ts`)**
   - `attachSession` 同步挂 `onBeforeRequest` / `onCompleted` / `onErrorOccurred`（`detachSession` 同步传 `null` 解绑）：
     - 维护 per-tab 在途请求表 `inFlight(tabId)`（自动过滤 `webSocket`/`media`/`ping`/`cspReport`/favicon 及超过 1.5s 的长轮询挂起请求）；
     - 记录每 tab 最近一次主文档导航失败错误 `lastNavError(tabId)`（用于诊断 `chrome-error://` 页的真实 `ERR_CONNECTION_REFUSED` / `ERR_NAME_NOT_RESOLVED` / `ERR_CERT_*`）；
     - `networkEntries` / `consoleEntries` 返回 SQLite 自增 `id`，新增 `networkEntriesSince(envId, afterId)`。

2. **真实 `networkidle` + 事件驱动 `smartSettle` (`src/main/browser/waits.ts`)**
   - `awaitIdle` 结合 `ctx.inFlightCount()` 与 `ctx.lastActivityAt()`（在途为 0 且安静窗口达标才放行）。
   - 新增 `smartSettle(ctx, opts)`：动作后检测是否触发导航 → 等 `readyState` + 在途请求清零 + 隔离世界 `MutationObserver`（过滤 `oldValue === newValue` 噪声和 >200ms 持续动画，递归同源 iframe），硬上限 3000ms。

3. **Batch 升级与网络游标修复 (`src/main/browser/ops/batch.ts`)**
   - 修复网络增量：按最后一条 `entry.id > beforeLastId` 计算增量（彻底修复满 300 条后 `slice(300)` 永远返回空数组的 bug），无 id 降级集合差集。
   - 结束时用 `smartSettle` 替代固定 150ms sleep（单测传 `settleMs: 0` 时保留跳过），并改用 `snapshotWithRefs` 让 `delta.interactiveDelta.added` 自带可直接复用的 `@N`。
   - `back`/`forward` 等待导航提交；扩展 batch 动词支持：`find`, `check`, `uncheck`, `scroll`, `wait <ms|selector|text|url|load|networkidle>`, `dialog accept|dismiss`, `upload`, `tab`, `frame`, `eval`, `screenshot`，支持 `--no-changes` / `--no-text`。

4. **`read` 与 `diff` 全面重写 (`src/main/browser/ops/reader.ts`, `src/main/browser/ops/diff.ts`)**
   - `reader.ts`：
     - 放弃 `cloneNode(true)`，改为实时 DOM + Shadow DOM 遍历 + `checkVisibility` 过滤，提取 React SPA 的纯 `<div>` 文本块、表格、标题、列表、代码块；
     - `--scroll` 智能识别目标 `-s` 或最大可滚动容器（而非只滚 `window`），支持 `--match <text>` 滚动命中即停；
     - 新增 `--outline`（仅标题结构）、`--filter <text|/regex/>`、多 URL 并发后台阅读、`.csv` / `.json` / `.md` 输出，以及 `--llms index|full`（抓取 `/llms.txt` / `/llms-full.txt` 或带 `Accept: text/markdown` 协商）。
   - `diff.ts`：
     - `diffSnapshots`：先剥离 `[ref=@N]` 做 Myers 行级统一 Diff（输出 `unifiedDiff` 3 行上下文），同时保留 `added`/`removed`/`changed` 结构兼容现有单测；
     - `diffScreenshots`：内置零依赖纯 JS PNG 解码/编码器（利用 Node 原生 `node:zlib` 解压/压缩 IDAT + 5 种 PNG filter 反滤），计算真实逐像素 RGBA 差异（`differentPixels`, `totalPixels`, `mismatchPercentage`, `threshold`），可选写出红/灰标注差异 PNG（`--out`）；对单测中 24 字节最小 PNG 头优雅降级到 SHA-256 + 尺寸对比；
     - 新增 `diffUrls`（同环境顺序/双页快照与正文对比）。

5. **安全输出治理、结构化 Remedy 与动态超时预算 (`ops/remedy.ts`, `ops/output-guard.ts`, `ops/budget.ts`, `rpc.ts`, `bin/warren.mjs`)**
   - `output-guard.ts`：`stripTerminalEscapes`（清理 ANSI/OSC/控制字符防终端注入）、`wrapUntrustedContent`（随机 nonce 标签 + 宽松转义闭合标签防 IDPI 逃逸）、`applyOutputBudget`（默认 `--max-output 12000`，`--full` 关闭，溢出落盘 `$WARREN_HOME/tmp/out-<ts>.txt` 并提示路径与节选）。
   - `remedy.ts`：按错误码生成单条合法 `warren ...` 自愈命令 + `hint` + 结构化 `data`；经 `src/main/rpc.ts` 透传到 `RpcResponse.error.details` 并在 `bin/warren.mjs` 渲染。
   - `budget.ts`：为 `batch` / `wait` / `open` 动态计算客户端 RPC 超时（大于内部动作超时 + 5s 缓冲，防止客户端先于动作历史被掐断）。
   - `bin/commands.mjs` & `bin/warren.mjs`：
     - `parseCliFlags` 支持 `--` 终止符和 `shieldLiteralArgs`（防 `fill @1 "--flag"` 误吞）；
     - 支持 `WARREN_ENV` 环境变量省略 `<env>`（当命令需要 env 且首个位置参数可推断省略时，明确文档化且不破坏现有 `<env>` 必填习惯）；
     - 补齐 `warren browser` 全量原子命令：`click`, `dblclick`, `fill`, `type`, `press`, `hover`, `focus`, `check`, `uncheck`, `select`, `drag`, `drop`, `scroll`, `scrollintoview`, `upload`, `download`, `wait`, `dialog`, `eval`, `frame`, `pdf`, `set`, `webmcp`, `vitals`, `a11y`, `react`；`browser open` 新增 `--read`；
     - 同步扩展 `bin/exec-runtime.mjs` 的 `page` 与 `locator` API（新增 `check`, `uncheck`, `scroll`, `read`, `find`, `get`, `is`, `diff`, `pdf`, `set`, `vitals`, `a11y`, `webmcp`, `frame`, `drop`, `notes`，保持 `EXEC_GLOBALS` 与禁用 Playwright 方法断言完全绿灯）。

---

### 波次 P2：2026 旗舰能力

1. **标注截图 (`src/main/browser/ops/annotate.ts`, `browser screenshot --annotate`)**
   - 先拍 `snapshotWithRefs({ interactiveOnly: true })` 获取每个 `@N` 视口矩形；在隔离世界注入只读 `pointer-events: none` 高对比编号框层 → 截图 → `finally` 立即移除覆盖层；返回 `annotations: Array<{ ref, role, name, box }>`。

2. **浏览器仿真 (`src/main/browser/ops/emulation.ts`, `warren browser set`)**
   - 支持 `viewport <w> <h> [--dpr=N] [--mobile]`、`device <name>`（内置 iPhone 15 / Pixel 8 / iPad / Desktop 预设）、`geo <lat> <lng> [acc]`、`offline on|off`、`headers <json>`、`media dark|light|reduced-motion|reset`、`tz <iana>`、`locale <tag>`、`reset`。全部走 `writeCall` 租约门控。

3. **WebMCP 工具发现与调用 (`src/main/browser/ops/webmcp.ts`, `warren browser webmcp`)**
   - 在隔离/主世界只读探测 `navigator.modelContext` 及已注册 WebMCP 工具清单（附 `untrusted: true` 与描述长度硬上限防注入）；`browser.webmcp.call` 按名调用页面注册工具（走 `writeCall` 门控）；snapshot 在检测到 WebMCP 工具时附加 `# webmcp-tools` 摘要。

4. **只读参数化 Saved Flows (`src/main/db.ts`, `src/main/store.ts`, `src/main/browser/ops/flow.ts`, `warren flow`)**
   - `db.ts` 增量建表 `saved_flows (name PRIMARY KEY, site, spec_json, updated_by, updated_at)`；
   - 严守安全红线：**仅允许只读 GET 请求**，落库前递归剥离 `Cookie` / `Authorization` / `X-API-Key` 等认证头并跑 `assertNoteSafe` 拒存凭据；
   - 子命令：`warren flow steps <env>`（从当前环境遥测候选只读 JSON API 生成草稿）、`save <name>`、`run <env> <name> [--param k=v] [--fields a,b] [--where k=v] [--limit N]`、`list`、`show <name>`、`rm <name>`；返回结构带字段漂移告警（schema drift）。

5. **DevTools 诊断工具箱与自动弹窗策略 (`src/main/browser/ops/diagnostics.ts`, `session.ts`)**
   - `browser.pdf`：`Page.printToPDF` 落盘（遵守 `guardSavePath`）；
   - `browser.vitals`：采集 Navigation Timing + Paint Timing + PerformanceObserver（TTFB / FCP / LCP / CLS / DOM nodes / JS Heap）；
   - `browser.a11y`：结构化 WCAG 审计（缺 `alt` 图片、缺 label 表单项、标题跳级、重复 `id`、空按钮/链接、`tabindex > 0`、坏 `aria-labelledby`/`aria-describedby` 引用）；
   - `browser.react`：无侵入探测 `__REACT_DEVTOOLS_GLOBAL_HOOK__` / `__reactFiber$` 还原组件树与脱敏 props/state 摘要；
   - `--auto-dialog accept|dismiss`（按次配置 `browser.dialogPolicy` 或在命令前自动处理非预期弹窗，绝不静默丢弃事件，仍在收据记录）。

---

## 三、验收与门禁清单

1. **静态与单测强门禁**（全绿）：
   - `npm run lint`（oxlint 零警告）
   - `npm run format:check`（prettier）
   - `npx tsc --noEmit`（TypeScript 7.0.2）
   - `npm test`（保留全部既有测试 + 新增 P0–P2 全覆盖测试，含 `rpc-gating`、`cli-help`、`skill-contract`、`exec-capabilities`、`remedy` 合法性防漂移）
   - `node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs`
2. **文档同步**：
   - `skills/warren/SKILL.md`、`docs/HANDOFF.md`、`docs/README.md`、`bin/warren.mjs` `help` 同步更新，零漂移。
3. **实机运行时验收**：
   - 按 `AGENTS.md` 第 4 条清理残留进程与 `:5173`，启动 Warren 与 `node scripts/serve-fixture.mjs 8899`；
   - `debug.layout` 确认渲染层挂载；
   - 实测 `snapshot -i -u`、`click` / `dblclick` / `fill` / `check` / `uncheck` / `select`、`batch --bail`、`read --outline`、`diff`、`screenshot --annotate`、`set viewport/media/reset`、`vitals`、`a11y`、`flow`、`methods`。
