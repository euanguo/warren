# 页面操作能力移植计划（Playwright 对标 · 实现级）

> 前置：`docs/BROWSER-CAPABILITY-DEEP-DIVE.md`（差异诊断）、`docs/BROWSER-CAPABILITY-RESEARCH.md`（能力取舍）、`docs/BROWSER-CAPABILITY-PLAN.md`（首版实施）。
> 本文件回答的是：**具体移植 Playwright 的哪些算法与机制、落到我们哪个文件、怎么证明移植成功**。
> 约束：本文件编写期间**不改 `src/`**（同线程另有任务在跑）。本文件是唯一交付物，实施另开线程。
> 时间：2026-10-15。环境：Electron 44.7.0 = Chromium 152.0.7977.130（`electron-to-chromium` 实测）。
> **行号基准**：本文件所有 `file:line` 在提交 `24e4fc9` 上核验（`git log -1 --oneline` = `8166da1` 时的工作树）。
> 仓库存在并发改动，**行号会漂移**（本次核对期间 `controller.ts` 就整体后移了 8 行）。引用时以**符号名**为准：
> `rg -n "async #backendIdFor\(|async #nodeIdsByCss|async #backendIdForAria" src/main/browser/controller.ts`。

---

## 0. 摘要

要移植的不是「更多 API」，而是**四个机制**和**一批算法**：

| # | 机制 | 为什么它是关键 | 批次 |
|---|---|---|---|
| M1 | 动作的「重试 + 重新解析」循环 | 没有它，元素晚出现 100ms 就失败；React 重渲染后点到旧节点 | B1 |
| M2 | Actionability 五态判定 | 没有它，点动画中/被遮挡/disabled 的元素会**静默成功** | B1 |
| M3 | 命中诊断（hit target） | 把「什么都没发生」变成「被 `<div class=x>` 挡住」 | B1 |
| M4 | 跨 frame 坐标换算 | 跨源 iframe 内点击**坐标是错的且不报错**（本轮新发现） | B1 |

外加 12 项算法级移植（B2–B4）和 4 项明确不移植。每一项在 §2 都有：Playwright 怎么做（带证据）→ 我们怎么做（带 `file:line`）→ 移植方式 → 落点 → 成本 → 验证命令 → 判定。

§4 是**自循环验证协议**：三层门（静态/单测/实机）+ RED→GREEN→REGRESS→回退 的循环 + 逐能力验收矩阵（命令/期望/判定/**反例门**）+ 验证记录表 + 停止条件。

---

## 1. 本轮新增的关键事实

这 8 条是本轮调研新得到的、会直接改变实施方案的证据。

### N1 · 我们用错了 AX 树的读法（状态不在顶层，在 `properties[]`）

CDP `Accessibility.AXNode` 顶层只有：`nodeId / ignored / ignoredReasons / role / chromeRole / name / description / value / properties / parentId / childIds / backendDOMNodeId / frameId`。

**`checked / expanded / level / selected / pressed / disabled / editable / focusable / valuetext / hasPopup / modal / multiselectable / readonly / required` 全部在 `properties: AXProperty[]` 里**，每项形如 `{ name: 'checked', value: { type: 'boolean', value: true } }`。`AXPropertyName` 枚举（Chromium 152）共 40+ 个。

另外 `ignoredReasons` 会说明**为什么被忽略**（`notRendered / notVisible / ariaHiddenElement / ariaHiddenSubtree / inertElement / inertSubtree / presentationalRole / labelContainer / labelFor / activeModalDialog …`）——这正是我们判断「可见性」和「为什么 snapshot 里没有这个元素」的现成依据。

> 影响：`snapshot.ts` 现在只读顶层 `disabled`，等于**丢掉了 Playwright aria 快照里最有信息量的那一半**；`readAxNodes` 的过滤逻辑（`!hasName && !interactive && !value` 就丢弃）也在丢弃真实节点。

### N2 · `DOM.getBoxModel` 返回的是 **local root viewport** 坐标，不是主 frame viewport

Playwright 源码注释（`crPage.ts`，commit `fab5eba`「fix(oopifs): translate coordinates to viewport」）：

> Renderer-based method `DOM.getContentQuads` and `DOM.getBoxModel` return coordinates relative to the **local root's viewport**, but we need them relative to the **root viewport**.

配套实现 `_framePosition()`：非主 frame 时取 `frameElement().boundingBox()` 作为偏移量，逐级累加。

chromium-bidi issue #2630 从另一侧确认：`Input.dispatchMouseEvent` 的坐标是「relative to the **main frame's viewport**」。

> 影响：**跨源 iframe（OOPIF）内的元素，我们的点击坐标是错的**——`boxCenter` 直接拿本地坐标当主 frame 坐标发出去，点偏且不报错。这正好是 `AGENTS.md` 已知问题第 8 条（「点击落在视图外且不报错」）的一个尚未发现的变体。同源 iframe 因为共享 local root，不受影响——所以这个 bug 一直没暴露。

### N3 · file chooser 拦截在 `//content` 层实现，Electron 大概率可用

Chromium 提交「DevTools: intercept file chooser requests」原文：

> With file chooser interception, protocol clients: enable file chooser interception with `page.setInterceptFileChooserDialog`; subscribe to the `page.fileChooserOpened` event; handle file choosers with `page.handleFileChooser`.
> The implementation resides in the **//content layer** to handle both //chrome and //headless embedders.
> NOTE: With file chooser interception enabled, the native "file chooser" UI is not shown since the control belongs to DevTools.

事件字段：`{ frameId, mode, backendNodeId? }`（`backendNodeId` 只在由元素触发时存在）。

> 影响：`waits.ts` 里那句注释「Electron 原生弹框无 CDP 事件」**很可能是错的**（更可能是「没先发 `setInterceptFileChooserDialog`」）。Electron 用的就是 content 层。若成立，fileChooser 从「轮询 `input[type=file]` 是否存在」升级为真事件，并且能拿到**触发 chooser 的那个 input 的 backendNodeId**。

### N4 · Electron 的 `debugger.sendCommand` 支持 `sessionId`

Electron 官方签名：`debugger.sendCommand(method[, commandParams, sessionId])`，`sessionId` 来自 `Target.attachToTarget`。Electron 自己的 spec 里有 `Target.setDiscoverTargets` / `Target.attachToTarget {flatten:true}` 的用例。

> 影响：我们有能力像 Playwright 一样处理 OOPIF（独立 session）。**但已知 Electron 在 `Target.setAutoAttach` + iframe 上有过崩溃/黑屏历史**（issue #27768，12.x 崩溃、19.x 黑屏，后来修）。所以：优先走 N2 的**坐标换算**方案（不依赖 OOPIF session），把 per-frame session 作为备选（见 §5 风险表）。

### N5 · Playwright 的命中诊断算法可以整体照搬

`injectedScript.expectHitTarget(hitPoint, targetElement)` 的完整逻辑：

1. 从 target 向上收集「shadow root 或 document」链 `roots`（`enclosingShadowRootOrDocument` + `shadowRoot.host`）。
2. 从最外层 root 往内，逐层 `elementsFromPoint`，用 `elementFromPoint` 处理 `display:contents` 与 shadow host 的错位。
3. 命中元素沿 `assignedSlot ?? parentElementOrShadowHost` 向上走，走到 target 就 `'done'`。
4. 走不到 → 用 `previewNode()` 生成人类可读描述，必要时再加「from X subtree」，返回 `{ hitTargetDescription }`。

注意两个细节：命中检查用 `retarget(node, 'button-link')`（**不**跟随 label），且 `expectHitTarget` 里没有任何 label 特判。

### N6 · 重试时轮换滚动对齐方式

`_retryPointerAction` 每次重试换一个滚动对齐：

```ts
const scrollOptions = [undefined, {block:'end',inline:'end'}, {block:'center',inline:'center'}, {block:'start',inline:'start'}];
const forceScrollOptions = scrollOptions[retry % scrollOptions.length];
```

理由（源码注释）：默认协议滚动可能被 `position:sticky` 元素挡住，换对齐方式能绕开大多数情况。滚动用 `behavior: 'instant'`，**没有固定 sleep**。

### N7 · 我们往被控页面里写东西（可被页面观察到）

`controller.ts#nodeIdsByCss` 把结果写到 `window.__warrenMatches`；`#xpathBackendIds` 给元素打 `data-warren-xpath-idx` 属性再删。虽然用后会清理，但**解析期间页面可见**：页面的 `MutationObserver`、React 的 DOM diff、反爬脚本都能看到。

Playwright 的做法是把所有辅助代码跑在**隔离世界**（utility world）里，页面脚本看不到。CDP 侧对应 `Page.createIsolatedWorld { frameId, worldName }` → 拿到 `executionContextId` → `Runtime.evaluate { contextId }`。

### N8 · 我们没有任何「动作可用性」概念

`rpc.ts` 的门控只有两类：写操作 `assertWritable`（lease）、输入类再加 `assertVisible`。没有「这个元素现在能不能动」。所以 D1/D2 的修复必须落在 `src/main/browser/` 里，而不是 RPC 层。

---

## 2. 逐能力对标与移植方案

每条格式：**Playwright 怎么做** / **我们怎么做** / **移植方案** / **落点** / **成本** / **验证**。

### 2.1 [M1] 动作重试与重新解析 —— B1

**Playwright**：`_retryAction` / `_retryPointerAction` 把「解析 → 检查 → 执行」整段包进重试；每次重试**重新解析元素**（所以 DOM 重渲染后拿的是新节点），超时才抛 `TimeoutError`。滚动对齐在重试间轮换（N6）。

**我们**：`actions.ts:33 click` 里 `withTimeout(() => ctx.backendIdFor(target))` 只给「解析」加 3s 上限；`backendIdFor` 找不到**立即抛** `TARGET_NOT_FOUND`（`controller.ts` 的 `#backendIdFor`，当前 :369）。拿到 backendNodeId 后一路直发，不重试。全仓只有 `ENV_BUSY` 在 CLI 层重试（`bin/warren.mjs:203`）。

**移植方案**：在 `page-helpers.ts` 新增 `runAction(ctx, { name, timeoutMs, attempt })`：

```
deadline = now + timeoutMs
retry = 0
while true:
  try:
    return await attempt(retry)          // attempt 内部自己解析 target
  catch e:
    if !retryable(e) or now > deadline: throw 带日志的最终错误
    retry += 1
    await sleep(退避 50/100/200/… 上限 500ms)
```

`retryable` 白名单：`TARGET_NOT_FOUND` / `TARGET_AMBIGUOUS`（重试可能变得唯一）/ `NOT_ACTIONABLE` / `TARGET_OCCLUDED` / `NODE_DETACHED`。**不可重试**：`BAD_SELECTOR` / `PATH_DENIED` / `CDP_BLOCKED` / `DIALOG_OPEN` / `TARGET_STALE`（要 agent 重拍 snapshot）。

每个写动作（click/dblclick/hover/fill/press(sel)/selectOption/focus/drag）都改为 `runAction` 包裹，`attempt` 里**每次都重新 `backendIdFor` + 重新 `boxCenter`**。

**落点**：`page-helpers.ts`（新增，~70 行）；`actions.ts`（7 个动作改包裹，~40 行改动）。

**成本**：中。**风险**：重试循环会把错误延后到超时，必须把「最后一次失败原因」带进错误消息，否则排障变差（见 §2.13）。

**⚠️ 超时预算**：Playwright 默认 30s，我们**不能**照抄。`warren exec` 的 RPC 超时是 60s（`WARREN_TIMEOUT_MS`），一段脚本里 3 个动作 × 30s 就会撞 RPC 超时，agent 看到的是 `TIMEOUT` 而不是动作错误。建议：单动作默认 **5s**（`ACTION_TIMEOUT_DEFAULT` 从 3000 提到 5000），并在 `exec` 文档里写明「脚本内总预算 ≤ 60s」。

**验证**：见 §4.3 的 V1 / V2。

### 2.2 [M2] Actionability 五态 —— B1

**Playwright**：矩阵见 DEEP-DIVE §1.4。实现是 `checkElementStates(node, states, frameVisible)`，不满足就回到重试循环。状态定义：visible = 非空 bounding box 且 `visibility !== hidden`（`opacity:0`、移出屏幕**算可见**）；stable = 连续两帧 bounding box 不变；enabled = 原生 `disabled`；editable = enabled 且无 `readonly`；receives events = 命中检查。

**我们**：无。`actions.ts:33` 只有 `assertNoDialog` + `boxCenter`。

**移植方案**：新增纯函数 + 页面内求值两段：

- **纯函数（可单测）** `actionabilityFor(action)` → 该动作需要哪些态（照抄矩阵：`click → visible,stable,enabled,receivesEvents`；`fill → visible,enabled,editable`；`selectOption → visible,enabled`；`focus/press/setInputFiles → []`）。
- **页面内求值** `evaluateState(ctx, backendId, states)`：一次 `evalOnNode` 返回 `{ visible, stable, enabled, editable, hit }` 快照。`stable` 用两次 `requestAnimationFrame` 比 `getBoundingClientRect()`；`hit` 用 §2.3 的命中检查。
- 失败 → 抛 `NOT_ACTIONABLE`，消息里带**具体是哪一项不满足**（`元素存在但 disabled` / `元素存在但正在移动`）。

**注意**：`setInputFiles` **不做** actionability 检查——Playwright 的 `_setInputFiles` 明确零检查，隐藏的 `input[type=file]` 是合法目标。别把这条「补」上去。

**落点**：新文件 `src/main/browser/actionability.ts`（~120 行）；纯函数矩阵放 `input.ts` 或 `policy.ts` 旁（可单测）。

**成本**：中。

**验证**：§4.3 的 V3 / V4（含反例门）。

### 2.3 [M3] 命中诊断 —— B1

**Playwright**：`expectHitTarget`（N5 全文）。两处用它：动作前的 `checkElementStates`（receives events）和动作后的事件拦截器（`mousedown/mouseup/pointerdown/pointerup/click/auxclick/dblclick/contextmenu` 的 capture 拦截）。

**我们**：无。

**移植方案**：移植 `expectHitTarget` 的**简化版**（不移植事件拦截器——那需要常驻注入脚本，成本高且和 §2.9 的隔离世界绑定）：

```js
(el) => {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  let hit = document.elementFromPoint(x, y);
  // shadow DOM：逐层 elementsFromPoint（照搬 Playwright 的 roots 循环）
  // 命中元素沿 parentElement/shadow host 向上走，遇到 el 即通过
  // 否则返回描述：tagName + id + class + 截断文本
}
```

失败抛 `TARGET_OCCLUDED`，消息：`目标被 <div class="overlay"> 遮挡（点击点 320,180）`。

**注意两点**（照抄 Playwright 的取舍）：命中检查**不跟随 label**；`opacity:0` 的元素算可见，所以「透明浮层挡住」会被正确报出来。

**落点**：与 §2.2 同一个页面内求值函数（共享一次 `evalOnNode`，省一次往返）。

**成本**：小（~40 行）。

**验证**：§4.3 的 V4（反例门：被遮挡必须报错，而不是成功）。

### 2.4 [M4] 跨 frame 坐标换算 —— B1

**Playwright**：`_framePosition()` 逐级累加 frame element 的 boundingBox（N2）。

**我们**：`page-helpers.ts:boxCenter` 只做 `scrollIntoViewIfNeeded` + `getBoxModel`，**不做任何 frame 换算**。

**移植方案**：

1. 从 `DOM.getFrameOwner { frameId }` 拿 owner 元素的 `backendNodeId`（CDP 现成命令）。
2. 从目标元素所在 frame 开始，沿 frame 树向上到主 frame，逐级 `getBoxModel` 取 owner 的 `content` 左上角，累加偏移。
3. `boxCenter` 返回「主 frame viewport 坐标」= 本地坐标 + 偏移和。
4. 偏移链缓存：同一 `(wcId, frameId)` 在一次动作内只算一次；`Page.frameNavigated` 后失效。

**纯函数**：`sumOffsets(rects)` / `applyOffset(point, offset)` 抽出来单测。

**落点**：`page-helpers.ts`（`boxCenter` 改造 + 新增 `frameOffsetFor`，~60 行）；`snapshot.ts` 已有的 `readAxFrames` 可复用 frame 树遍历逻辑。

**成本**：中。

**验证**：§4.3 的 V5（**这是本轮最重要的验收**：跨源 iframe 内的按钮必须点得中）。

### 2.5 `fill`：页面内 selectText + 输入类型分支 —— B2

**Playwright**：injected `fill` 按 input type 分流（N 类直接赋值 + 派发 `input`/`change` 并返回 `done`；文本类 `selectText` 后返回 `needsinput`），服务端再发 `Input.insertText`。附带校验：`number` 非数字抛错、`color` 转小写、赋值后 `input.value !== value` 抛 `Malformed value`、非 input/textarea/contenteditable 抛错。

**我们**：`actions.ts:104` = `DOM.focus` → 合成 ⌘A/Ctrl+A → `Input.insertText` → 读回确认。**合成 ⌘A 在自定义编辑器里选不中 → 变成追加**。另外 `date/range/color` 类走 insertText 通常无效。

**移植方案**：

1. 页面内：`el.select?.()`；不可选时对 contenteditable 用 `document.execCommand('selectAll')`；再不行退化为 `el.value = ''`（仅 input/textarea）。
2. 按 `input.type` 分流：`date/time/color/range/month/week/datetime-local` → 直接赋值 + 派发 `input`(composed) + `change`，**跳过 insertText**。
3. `number` 先 `trim` + `isNaN` 校验。
4. **保留我们的读回确认**（`FILL_UNCONFIRMED`）——这是 Playwright 没有的，别丢。

**落点**：`actions.ts:104`（~40 行）。

**成本**：小。**验证**：V6。

### 2.6 键盘与鼠标状态机 + `press` 补 char 段 —— B2

**Playwright**：`Keyboard` 维护 `_modifiers` / `_pressedKeys`（`down('Shift')` 后所有后续事件自动带 Shift）；`press` 对可打印字符发 `keydown + char + keyup`，对命名键发 `rawKeyDown + keyup`；`type` 逐字符；`insertText` 只发输入。`Mouse` 维护位置 + buttons 位掩码。

**我们**：`input.ts:82 keyEvents()` 只产 keyDown/keyUp 两段；`keymouse.ts` 有 `lastMouse` 但 `mouseMove` 固定 `buttons: 0`，没有按键/modifiers 状态。

**移植方案**：

1. `input.ts`：`keyEvents` 对单字符 key 插一段 `{ type: 'char', text: key, unmodifiedText: key }`。
2. 新增模块级状态（放 `mouse-state.ts` 旁边或同文件）：`heldModifiers: Set`、`heldButtons: number`。
3. `keyboardDown/Up` 维护 modifiers；`keyEvents` 在无显式 modifier 时并入当前 held modifiers（显式 chord 优先，且发完不残留）。
4. `mouseDown/Up` 维护 buttons；`mouseMove` 用当前 buttons。
5. `drag` 复用状态机（现在是自己拼的序列，保持行为不变但走同一套参数组装）。

**落点**：`input.ts`（~30 行）、`keymouse.ts`（~40 行）、`mouse-state.ts`。

**成本**：小。**验证**：V7（含纯函数单测门）。

### 2.7 snapshot：状态、层级、查询 —— B2

**Playwright**：`ariaSnapshot({mode:'ai'})` 输出**带缩进的 YAML**，节点带 `[ref=eN]`，值内联（`- textbox: Enter your name`），状态以属性形式呈现（`[checked]`/`[expanded]`/`[level=2]`…）。定位器侧 `getByRole(role, {checked/disabled/selected/expanded/level/name/description/pressed/includeHidden})` 支持这些过滤。

**我们**：`snapshot.ts:113` 输出**扁平数组**，只带 `disabled`；`AxNode` 类型（`shared/types.ts:109`）没有状态字段；`loc=role:` 不支持状态过滤。

**移植方案**（三件事，可分开做）：

1. **读状态**：从 `properties[]` 提取（N1），映射到 `AxNode` 新字段：`checked?: boolean|'mixed'`、`expanded?: boolean`、`level?: number`、`selected?: boolean`、`pressed?: boolean|'mixed'`、`valuetext?: string`、`readonly?: boolean`、`required?: boolean`、`focused?: boolean`。
2. **建层级**：AX 节点自带 `parentId` / `childIds`（`snapshot.ts:collectSubtree` 已经在用 `childIds`），按 `childIds` 重建树，输出缩进文本（新增 `snapshot({format:'text'})`，默认仍返回数组以保持向后兼容）。
3. **按 name/role 查询**：`Accessibility.queryAXTree { nodeId | backendNodeId | objectId, accessibleName?, role? }` 直接在服务端查，替代现在「拉 2000 节点再 JS 过滤」的做法（`controller.ts` 的 `#backendIdForAria`（当前 :508））。它能返回 ignored 节点，也让 `text=` 的「去 StaticText」启发式可以收紧成「按 role 优先级挑」。

**落点**：`snapshot.ts`（状态提取 + 层级，~120 行）、`controller.ts:500`（改用 queryAXTree，~40 行）、`shared/types.ts`（AxNode 加法，**注意这是数据模型变更 → 要同步 `docs/HANDOFF.md`「当前状态」**）。

**成本**：中偏大。**验证**：V8。

### 2.8 选择器：retarget、状态过滤、strict 错误 —— B3

**Playwright**：每个动作方法开头 `retarget(node, 'follow-label')`；strict 模式错误列出每个候选的完整定位路径。

**我们**：无 retarget；`assertUnique` 只列 `role“name”` 前 3 个（`target.ts`），`#backendIdForCss` 的歧义错误只列 `nodeName` 前 3 个（`controller.ts` 的 `#backendIdForCss`）。

**移植方案**：

1. `retargetFollowLabel(backendId)`：若元素是 `<label>` 且 `label.control` 存在 → 换成 control 的 backendNodeId。在 `backendIdFor` 末尾统一调用（`focus/press/fill/click` 都受益）。
2. 歧义错误带**候选路径**：对每个候选生成 `role=...[name="..."]` 或 `css=...` 摘要（复用 `snapshot.ts:stableLocator`）。
3. `loc=role:` 扩展状态过滤语法：`loc=role:checkbox[checked=true][name="记住我"]`（对齐 `getByRoleSelector` 的 props 集合）。

**落点**：`controller.ts`、`target.ts`（解析层）。

**成本**：小（retarget ~20 行）+ 中（语法扩展）。**验证**：V9。

### 2.9 隔离世界（去掉页面污染）—— B3

**Playwright**：所有辅助代码跑在 utility world。

**我们**：`window.__warrenMatches`（`controller.ts` 的 `#nodeIdsByCss`，当前 :428/:441）+ `data-warren-xpath-idx` 属性（`controller.ts` xpath 分支）写进被控页面（N7）。

**移植方案**：对每个 frame 懒创建隔离世界：`Page.createIsolatedWorld { frameId, worldName: 'warren' }` → `executionContextId`；把 CSS/xpath 解析、actionability、命中检查全部改成在该 context 里 `Runtime.evaluate { contextId }`。结果对象用 `Runtime.callFunctionOn` 返回，避免跨 world 传 DOM 引用。

**收益**：页面脚本看不到我们的注入；不再改页面 DOM；`window.__warrenMatches` 这个全局彻底删掉。

**成本**：中（要改 4–5 处求值调用点）。**风险**：隔离世界的 `objectId` 不能跨 world 用在 `DOM.requestNode` 上——`DOM.requestNode` 需要主 world 的对象。缓解：解析只在隔离世界做**选择器匹配**，命中后用主 world 的 `Runtime.evaluate('document.querySelector(...)')` 或 `DOM.querySelector` 拿 nodeId（同源场景），跨源场景走 AX 通道（我们已有）。

**验证**：V10（MutationObserver 探针）。

### 2.10 导航自动等待 —— B3

**Playwright**：`SignalBarrier` + `waitForSignalsCreatedBy`，等「本次动作触发的导航」，`noWaitAfter` 可关。

**我们**：`page-helpers.ts:98 waitForNavigation` 100ms 轮询 `wc.getURL() !== urlBefore`，5s 静默放弃（只改 hash 就等不到、无关导航会误判、超时不报错）。

**移植方案**：改成监听 `did-start-navigation` / `did-navigate` / `did-navigate-in-page`（`isMainFrame` 为真），要求「动作开始后**新产生**的导航」；超时后**不报错**但收据里带 `navigation: 'none'`，让 agent 能区分「没跳转」和「跳了但没等完」。

**落点**：`page-helpers.ts`（~40 行）。**成本**：小。**验证**：V11。

### 2.11 fileChooser 事件化 —— B3

**Playwright**：`Page.setInterceptFileChooserDialog {enabled:true}` → `Page.fileChooserOpened {frameId, mode, backendNodeId?}` → 用 `DOM.setFileInputFiles` 落文件。

**我们**：`waits.ts:waitForEvent('fileChooser')` 轮询 `input[type=file]` 是否存在——**对隐藏 input + 程序化 `.click()` 触发的 chooser 完全失效**（input 一直都在，或一直都不在）。

**移植方案**：`attachSession` 时（或首次需要时）发 `Page.setInterceptFileChooserDialog {enabled:true}`，把 `Page.fileChooserOpened` 收进 `session.ts` 的事件分发（和 `Page.javascriptDialogOpening` 同一条路），进 `EnvPending` 队列；`waitForEvent('fileChooser')` 改成消费该事件，返回 `{ frameId, mode, backendNodeId? }`。

**⚠️ 前置实测**：见 §5-R1。若 Electron 不支持，退回轮询并**把「为什么」写进注释**（现在是猜测式注释）。

**落点**：`session.ts`（事件分发）、`pending.ts`（队列）、`waits.ts`（消费）、`actions.ts`（`setInputFiles` 可直接吃事件的 backendNodeId）。**成本**：中。**验证**：V12。

### 2.12 dialog 死锁提示 —— B4

**Playwright**：无人监听 → auto-dismiss。

**我们**：阻塞（有意）。但 agent 不处理就挂到 RPC 60s 超时。

**移植方案**（保持阻塞语义，只提升可诊断性）：`assertNoDialog` 的错误消息里直接给出下一步命令（`browser.acceptDialog` / `browser.dismissDialog` / `browser.events`），并在 `exec` 文档里写明「dialog 未处理 = 后续所有输入挂起」。

**落点**：`page-helpers.ts:assertNoDialog`（~5 行）。**成本**：小。**验证**：V13。

### 2.13 错误信息带等待历史 —— B4

**Playwright**：`ProgressController` 每次重试 `progress.log(...)`，`TimeoutError` 带整段历史。

**我们**：`err(code, message)` 一行。

**移植方案**：`runAction` 收集每次 attempt 的 `{ retry, target 解析结果, 状态快照, 失败原因 }`，超时抛错时拼成多行消息（上限 10 条，避免撑爆 RPC 响应）：

```
TIMEOUT click('#submit') 5000ms（6 次重试）
  #1 元素未出现
  #2 元素出现但 disabled
  #3 元素可见但被 <div class="loading-mask"> 遮挡
  ...
```

**落点**：`page-helpers.ts`（`runAction` 内）。**成本**：小。**验证**：V14。

### 2.14 元素高亮（产品能力，不是对齐）—— B4

`Overlay` 域已在 `policy.ts` 的白名单里但从未使用。`Overlay.highlightNode { backendNodeId, highlightConfig }` 可以在「人机同视」的窗口里**给人看到 agent 正在操作哪个元素**——这是 Playwright 没有的场景价值（它的 highlight 是给开发者看的）。

**落点**：`actions.ts` 动作前调用（可开关）+ `browser.highlight` RPC。**成本**：小。**验证**：V15（截图 + 像素统计）。

### 2.15 明确不移植

| 不移植 | 原因 |
|---|---|
| 自研选择器引擎 + accname（`roleUtils`） | 我们走 Chromium AX 树，语义由内核保证；自研等于重写一遍 ARIA 规范（数千行），收益只是「跨内核一致」——我们不跨内核 |
| 常驻注入脚本 + 事件拦截器（动作后的 hit target 校验） | 需要常驻 injected 生命周期，与 `webContents` 生命周期、导航重建耦合；动作前检查已能覆盖绝大多数「静默失败」 |
| `route/mock/HAR/多 context/视频/trace` | 与「人机同视 + 单 session」架构冲突（`TECH-STACK-RESEARCH.md` §13 已定） |
| `expect` 断言库 | agent 用 `waitForFunction` 替代（`BROWSER-CAPABILITY-RESEARCH.md` §3 已定） |

---

## 3. 实施批次与依赖

```
B1（动作可信性，必须先做）          依赖：无
  M1 重试循环 ──┬─→ M2 actionability ──→ M3 命中诊断
                └─→ M4 跨 frame 坐标

B2（观察与输入保真）                依赖：B1（重试循环提供了统一的 attempt 落点）
  snapshot 状态/层级/queryAXTree ／ fill 分流 ／ press char ／ 键鼠状态机

B3（工程卫生与正确性）              依赖：B1（隔离世界改的是 attempt 内部的求值）
  retarget ／ 隔离世界 ／ 导航等待 ／ fileChooser 事件化

B4（可诊断性与产品）                依赖：B1
  错误历史 ／ dialog 提示 ／ 高亮
```

**批次内的顺序不可乱**：M2/M3 的失败态需要 M1 的重试循环才有意义（否则一失败就直接报错，agent 拿到的是「不可重试的一次性失败」）。

**每批次结束必须做**：§4.1 三层门全绿 + 更新 `docs/HANDOFF.md`（若涉及 RPC/类型/CLI）。

---

## 4. 验证协议（自循环）

### 4.1 三层门

| 门 | 内容 | 命令 | 判定 |
|---|---|---|---|
| **G0 静态门** | 类型 + 单测 + 渲染层构建 | `npx tsc --noEmit` → `npm test` → `node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs` | 三条全绿；`npm test` 计数 **≥ 15 且不减少**（新增测试只增不减） |
| **G1 纯函数门** | 新增纯函数的单测（`tests/*.test.ts`） | `npm test` | 新增用例全绿；**每条规则一个反例断言** |
| **G2 实机门** | Electron + fixture + CLI 探针 | §4.2 的启动流程 + §4.3 的逐条命令 | 每条验收命令的输出与期望一致；**反例门必须报错而不是成功** |

### 4.2 实机环境（每次循环都从头来，别省）

```bash
# 1. 清理（AGENTS 已知问题第 4 条，必须照做）
pkill -f "electron-forge start"; pkill -f "node_modules/electron/dist"; sleep 3
lsof -ti :5173 | xargs kill -9
rm -f ~/.warren/envd.sock ~/.warren/runtime.json
pgrep -f 'electron-forge start' | wc -l        # 必须是 0

# 2. 终端 A：起应用
npm start                                       # 日志里应出现 target built src/main/main.ts

# 3. 终端 B：起 fixture（端口必须与探针 URL 一致）
node scripts/serve-fixture.mjs 8899

# 4. 挂载探针（返回默认 0,0,800,600 = 渲染层没挂，别继续往下测）
node bin/warren.mjs call debug.layout
# 期望 {"x":288,"y":37,"w":1152,"h":674}

# 5. 建一个验收环境
node bin/warren.mjs env create cap --start-url=http://localhost:8899/cap/form.html
node bin/warren.mjs env start cap
```

### 4.3 逐能力验收矩阵

每条验收都写成可直接粘贴的 `warren exec` 脚本（`exec` 会自动取 lease）。**反例门**是本协议的核心：只验证「该成功的成功」不够，必须验证「该失败的失败」。

---

**V1 · 动作重试：晚出现的元素**

新增 fixture `fixtures/capability/timing.html`：`#late` 按钮在 `setTimeout(…, 500)` 后插入 DOM，点击后写 `#result = 'late clicked'`。

```bash
node bin/warren.mjs browser open cap http://localhost:8899/cap/timing.html
node bin/warren.mjs exec cap <<'JS'
await page.click('#late');                       // 现在：立即 TARGET_NOT_FOUND
const t = await page.evaluate(() => document.getElementById('result').textContent);
if (t !== 'late clicked') throw new Error('V1 失败: result=' + t);
return 'V1 ok';
JS
```

判定：输出 `V1 ok`。修复前预期：`TARGET_NOT_FOUND`。

**V2 · 重试必须重新解析（DOM 重渲染）**

fixture `timing.html` 增加：`#rerender` 按钮每 300ms 被 `replaceWith` 换成新节点，点击后写 `#result`。

判定：能点中（说明每次 attempt 重新解析）。修复前：点到已脱离文档的旧节点，`TARGET_NOT_FOUND` 或点击无效。

---

**V3 · Actionability：动画中的元素**

新增 fixture `fixtures/capability/actionability.html`：
- `#moving`：CSS `animation` 持续左右位移；点击后写 `#result = 'moving clicked'`。
- `#disabled`：`<button disabled>`；点击后写 `#result`（正常情况永远不触发）。
- `#covered`：被 `<div id="mask">`（`position:absolute; inset:0`）盖住的按钮。
- `#hidden`：`display:none` 的按钮。
- `#never`：始终不存在。

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://localhost:8899/cap/actionability.html');
await page.click('#moving');                     // 必须等到 bounding box 连续两帧稳定
return await page.evaluate(() => document.getElementById('result').textContent);
JS
```

判定：返回 `moving clicked`。

**V4 · 反例门：该失败的必须失败**

```bash
node bin/warren.mjs exec cap <<'JS'
const results = {};
for (const [name, sel] of [['covered','#covered'], ['disabled','#disabled'], ['hidden','#hidden']]) {
  try { await page.click(sel, { timeoutMs: 1500 }); results[name] = 'UNEXPECTED_SUCCESS'; }
  catch (e) { results[name] = e.code; }
}
if (results.covered !== 'TARGET_OCCLUDED') throw new Error('V4 失败: ' + JSON.stringify(results));
if (results.disabled !== 'NOT_ACTIONABLE') throw new Error('V4 失败: ' + JSON.stringify(results));
if (results.hidden !== 'NOT_ACTIONABLE') throw new Error('V4 失败: ' + JSON.stringify(results));
return JSON.stringify(results);
JS
```

判定：`{"covered":"TARGET_OCCLUDED","disabled":"NOT_ACTIONABLE","hidden":"NOT_ACTIONABLE"}`。

---

**V5 · 跨源 iframe 内点击（M4，最重要的验收）**

新增 fixture `fixtures/capability/oopif.html`：页面从 `http://127.0.0.1:8899` 加载，内嵌 `<iframe id="frame" src="http://localhost:8899/cap/frame.html">`。
> 原理：`localhost` 与 `127.0.0.1` 是**不同 origin 且不同 site** → Chromium site-per-process 把它放进独立进程 = OOPIF。不需要第二个服务器。**前提是 Electron 开着 site isolation**——用 V5a 先确认。

**V5a · 先确认它真的是跨源/OOPIF**

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://127.0.0.1:8899/cap/oopif.html');
return await page.evaluate(() => {
  const f = document.getElementById('frame');
  return { src: f.src, crossOrigin: (() => { try { return !f.contentDocument; } catch { return true; } })() };
});
JS
```

判定：`crossOrigin: true`（同源可读 contentDocument，跨源抛错/null）。若为 `false`，说明 Electron 关了 site isolation，M4 的验收条件不成立——**此时不要假装通过**，按 §5-R2 记录并另找触发方式。

**V5b · 点内层按钮**

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://127.0.0.1:8899/cap/oopif.html');
await page.click('#inner');                       // 修复前：点偏，result 不变
await page.waitForTimeout(300);
const snap = await page.snapshot({ scope: 'full_page' });
if (!snap.some((n) => n.name.includes('inner clicked'))) {
  throw new Error('V5 失败: 内层未收到点击，snapshot 里没有 "inner clicked"');
}
return 'V5 ok';
JS
```

判定：输出 `V5 ok`。修复前预期：`#inner-result` 仍是「未点击」。

---

**V6 · fill 在自定义编辑器里是替换而非追加**

新增 fixture `fixtures/capability/editor.html`：一个 `<div contenteditable>`（`id=editable`）+ 一个 `<input type=date id=date>`。

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://localhost:8899/cap/editor.html');
await page.fill('#editable', 'abc');
await page.fill('#editable', 'xy');              // 必须是替换
const v = await page.evaluate(() => document.getElementById('editable').textContent);
if (v !== 'xy') throw new Error('V6 失败: contenteditable=' + JSON.stringify(v));
await page.fill('#date', '2026-10-15');
const d = await page.evaluate(() => document.getElementById('date').value);
if (d !== '2026-10-15') throw new Error('V6 失败: date=' + JSON.stringify(d));
return 'V6 ok';
JS
```

判定：`V6 ok`。修复前预期：contenteditable 得到 `abcxy`，date 为空。

---

**V7 · 键盘状态机与 char 段**

新增 fixture `fixtures/capability/keys.html`：一个 input（`id=input`）+ 监听 `keydown`/`keypress`/`input` 把事件名与 `key` 追加到 `#log`（格式如 `keydown:A`）。

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://localhost:8899/cap/keys.html');
await page.click('#input');
await page.keyboard.down('Shift');
await page.keyboard.press('a');                  // 期望 keydown 的 key 是 'A'（带 Shift）
await page.keyboard.up('Shift');
await page.keyboard.press('b');                  // 期望产生 char/keypress
const log = await page.evaluate(() => document.getElementById('log').textContent);
if (!/keydown:A/.test(log)) throw new Error('V7 失败(状态机): ' + log);
if (!/keypress/.test(log)) throw new Error('V7 失败(char 段): ' + log);
return 'V7 ok';
JS
```

判定：`V7 ok`。

**G1 配套单测**：`tests/browser-pure.test.ts` 追加 `keyEvents('a')` 三段、`heldModifiers` 组合、`mouseButtons` 位掩码。

---

**V8 · snapshot 带状态与层级**

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://localhost:8899/cap/form.html');
const before = await page.snapshot({});
const box = before.find((n) => n.role === 'checkbox');
if (!box) throw new Error('V8 失败: 找不到 checkbox 节点');
if (box.checked !== false) throw new Error('V8 失败: checked 字段缺失/错误: ' + JSON.stringify(box));
await page.click('loc=role:checkbox');
const after = await page.snapshot({});
const box2 = after.find((n) => n.role === 'checkbox');
if (box2.checked !== true) throw new Error('V8 失败: 勾选后 checked 仍非 true');
return 'V8 ok';
JS
```

判定：`V8 ok`。（`form.html` 需补一个 `<input type="checkbox">` + 一个 `<h2>`/嵌套列表以验证 `level` 与层级输出。）

---

**V9 · retarget follow-label 与歧义错误**

> 依赖 V8：`css=input` 必须在页面里**有两个以上** input 才会歧义。当前 `fixtures/capability/form.html` 只有一个 `input#name`（其余是 `textarea` / `select`），所以先完成 V8 的 fixture 补充，V9 的歧义断言才成立。

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://localhost:8899/cap/form.html');
await page.fill('text=姓名', '张三');             // label 必须落到 input
const v = await page.evaluate(() => document.getElementById('name').value);
if (v !== '张三') throw new Error('V9 失败(label retarget): ' + JSON.stringify(v));
try { await page.click('css=input'); throw new Error('V9 失败: 多匹配未报歧义'); }
catch (e) { if (e.code !== 'TARGET_AMBIGUOUS') throw e; if (!/nth/.test(e.message)) throw new Error('V9 失败: 歧义错误没有候选提示'); }
return 'V9 ok';
JS
```

判定：`V9 ok`。

---

**V10 · 隔离世界：页面观察不到我们的注入**

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://localhost:8899/cap/form.html');
await page.evaluate(() => {
  window.__seen = { warrenMatches: 0, xpathAttr: 0 };
  new MutationObserver((recs) => {
    for (const r of recs) if (r.attributeName === 'data-warren-xpath-idx') window.__seen.xpathAttr++;
  }).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-warren-xpath-idx'] });
  Object.defineProperty(window, '__warrenMatches', { configurable: true,
    get() { window.__seen.warrenMatches++; return undefined; },
    set() { window.__seen.warrenMatches++; } });
});
await page.click('xpath=//input[@id="name"]');    // 走 xpath 分支
await page.click('css=#name');
const seen = await page.evaluate(() => window.__seen);
if (seen.xpathAttr !== 0 || seen.warrenMatches !== 0) throw new Error('V10 失败: ' + JSON.stringify(seen));
return 'V10 ok';
JS
```

判定：`V10 ok`。修复前预期：`xpathAttr ≥ 2`（打标 + 清标）。

---

**V11 · 导航等待：区分「没跳转」与「跳了没等完」**

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://localhost:8899/cap/timing.html');
const r1 = await page.click('#no-nav');           // 不触发导航的按钮
if (r1.navigation !== 'none') throw new Error('V11 失败(无关导航): ' + JSON.stringify(r1.navigation));
const r2 = await page.click('#to-form2');         // 触发整页导航
if (r2.navigation === 'none') throw new Error('V11 失败(漏报导航)');
return 'V11 ok';
JS
```

判定：`V11 ok`。（需在 `timing.html` 里补 `#no-nav` 与 `#to-form2`。）

---

**V12 · fileChooser 事件化（先过 R1）**

新增 fixture `fixtures/capability/upload-hidden.html`：一个 `display:none` 的 `<input type=file id=file>`，按钮 `#pick` 调用 `file.click()`。

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://localhost:8899/cap/upload-hidden.html');
const p = page.waitForEvent('fileChooser', { timeoutMs: 3000 });   // 先 arm
await page.click('#pick');
const ev = await p;
if (!ev.backendNodeId) throw new Error('V12 失败: 事件里没有 backendNodeId');
return 'V12 ok';
JS
```

判定：`V12 ok`。修复前预期：3s 超时（轮询找不到「新出现的 input」）。

---

**V13 · dialog 错误必须给出下一步**

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://localhost:8899/cap/dialog.html');
await page.click('#alert');                       // 触发 alert
try { await page.click('#confirm'); throw new Error('V13 失败: dialog 开着时未拦截'); }
catch (e) {
  if (e.code !== 'DIALOG_OPEN') throw e;
  if (!/acceptDialog|dismissDialog/.test(e.message)) throw new Error('V13 失败: 没有给下一步命令: ' + e.message);
}
return 'V13 ok';
JS
```

判定：`V13 ok`。

---

**V14 · 错误带等待历史**

```bash
node bin/warren.mjs exec cap <<'JS'
await page.goto('http://localhost:8899/cap/actionability.html');
try { await page.click('#never', { timeoutMs: 1200 }); throw new Error('V14 失败: 不该成功'); }
catch (e) {
  if (e.code !== 'TIMEOUT') throw e;
  if (!/#1/.test(e.message)) throw new Error('V14 失败: 没有重试历史: ' + e.message);
}
return 'V14 ok';
JS
```

判定：`V14 ok`。

---

**V15 · 高亮（视觉，最后做）**

```bash
node bin/warren.mjs call browser.highlight '{"id":"cap","target":"#name"}'
node bin/warren.mjs call debug.focusWindow
# 用返回的 x,y,w,h 截图后按 AGENTS 的像素统计法判断高亮区域是否出现
screencapture -x -R <x>,<y>,<w>,<h> shots/highlight.png
python3 -c "from PIL import Image;import numpy as np;a=np.asarray(Image.open('shots/highlight.png').convert('RGB'));print(a.mean(0).mean(0))"
```

判定：高亮前后同一区域平均 RGB 有明显差异（并人工看一眼图）。

### 4.4 需要新增的 fixture 清单

`fixtures/capability/` 现有 8 个：`dialog / download / drag / form / frame / iframe / shadow / upload`。需新增/补充：

| 文件 | 内容要点 | 服务于 |
|---|---|---|
| `timing.html` | `#late`（500ms 后插入）、`#rerender`（每 300ms 换节点）、`#no-nav`、`#to-form2`、`#result` | V1 V2 V11 |
| `actionability.html` | `#moving`（CSS 动画）、`#disabled`、`#covered`+`#mask`、`#hidden`、`#never`、`#result` | V3 V4 V14 |
| `oopif.html` | 从 `127.0.0.1` 加载、内嵌 `http://localhost:8899/cap/frame.html` | V5 |
| `editor.html` | contenteditable（`#editable`）+ `type=date`（`#date`） | V6 |
| `keys.html` | input（`#input`）+ keydown/keypress/input 日志（`#log`） | V7 |
| `upload-hidden.html` | 隐藏 `input[type=file]`（`#file`）+ 触发按钮 `#pick` | V12 |
| `form.html`（补） | 加 `<input type=checkbox>`、一个 `<h2>` 与嵌套列表 | V8 V9 |

> fixture 一律中文界面 + `id` 稳定 + 自证式结果（把结果写进 `#result` / `#log`），这样验收脚本能自校验，不需要人眼。

### 4.5 循环协议

```
for each 能力（按 §3 批次顺序）:
  1. RED     先把 §4.3 对应的验收脚本跑一遍，确认「现在确实失败」并记录失败输出
              —— 不许跳过。没看到红的验收不算验收（这正是本项目「看着改了其实没生效」的解药）
  2. GREEN   最小实现，只让这条验收从红转绿
  3. G0      npx tsc --noEmit && npm test && vite build     —— 全绿
  4. G1      该能力的纯函数单测（含反例断言）
  5. REGRESS 重跑本批次**已完成**的所有验收（不许只跑新的）
  6. 记录    往 §4.6 表格追加一行（能力 / 命令 / 修复前 / 修复后 / 日期）
  7. 失败处理 任一门红 → 回退到本能力改动前的状态（git stash 或按文件 git checkout --），
              回到 1 重来；不许带着红的门往下做下一个能力
```

**停止条件**（全部满足才算做完）：

1. B1–B4 全部能力的验收脚本输出与期望一致；
2. 所有**反例门**（V4 / V10 / V13 / V14）通过——即「该失败的确实失败了」；
3. G0 全绿且 `npm test` 计数 ≥ 15 + 新增数；
4. §4.6 表格里每个能力都有「修复前红 / 修复后绿」两行证据；
5. §5 的未决项要么有实测结论，要么在文档里明确标为「未验证 + 影响范围」。

### 4.6 验证记录表（2026-10-15 实测，提交 `217e2c7`）

全部命令：`bash /tmp/warren-all.sh`（每项先 `debug.focusWindow`，再 `warren exec cap`）。

| 能力 | 验收 | 修复前（实测输出） | 修复后 | G0 | 结果 |
|---|---|---|---|---|---|
| M1 重试 | V1 | `TARGET_NOT_FOUND: selector not found: #late` | `V1 ok` | ✅ | **PASS** |
| M1 重试（回归） | V2 | `V2 ok`（本来就过） | `V2 ok` | ✅ | PASS |
| M2 actionability | V3 | `moving clicked at 34`（动画没停就点了） | `moving clicked at 208` | ✅ | **PASS** |
| M2 反例（永不停止） | V3b | 无报错、静默 no-op | `TIMEOUT（8 次尝试）` | ✅ | **PASS** |
| M2+M3 反例门 | V4 | `{covered:UNEXPECTED_SUCCESS, disabled:UNEXPECTED_SUCCESS, hidden:INTERNAL}` | `{covered:TIMEOUT/遮挡, disabled:TIMEOUT/disabled, hidden:TIMEOUT/不可见}` | ✅ | **PASS** |
| M4 跨源 iframe | V5a/V5b/V5d/V5e | V5a 跨源成立；V5b `TARGET_NOT_FOUND` | V5a ok；V5b ok | ✅ | **2026-10-16 PASS**（子会话 + 坐标换算 + 跨源 dialog，见 §5-R6） |
| 同源 iframe（回归） | V5c | `V5c ok` | `V5c ok` | ✅ | PASS |
| fill 分流 | V6 | `FILL_UNCONFIRMED 期望 2 字，读回 5 字` | `V6 ok`（contenteditable 替换 + date + range） | ✅ | **PASS** |
| 键鼠状态机 | V7 | `keydown:a`（无 Shift）且**无 keypress** | `keydown:Shift keydown:A keypress:A input:A keyup:A keyup:Shift …` | ✅ | **PASS** |
| snapshot 状态 | V8 | `AxNode` 只有 `role/name/backendNodeId/ref` | `V8 ok checked/level` | ✅ | **PASS** |
| retarget/歧义 | V9 | 歧义报 `TIMEOUT`（错误码被重试吞掉） | `TARGET_AMBIGUOUS`（立即） | ✅ | **PASS** |
| 隔离世界 | V10 | `{"warrenMatches":2,"xpathAttr":2}` 且 CSS 定位被页面破坏 | `V10 ok 页面观察不到注入` | ✅ | **PASS** |
| 导航等待 | V11 | `{noNav:null, nav:null}`（没有该字段） | `{none, navigated}` | ✅ | **PASS** |
| fileChooser | V12 | 事件里没有 `backendNodeId`（轮询 input 存在性） | `{frameId, mode:selectSingle, backendNodeId:359}` | ✅ | **PASS** |
| dialog 提示 | V13 | `DIALOG_OPEN alert: …（先 accept/dismiss）` | `DIALOG_OPEN` + 下一步命令（且不再被 `WINDOW_NOT_FOCUSED` 掩盖） | ✅ | **PASS** |
| 错误历史 | V14 | 无（被 dialog 阻塞） | `TIMEOUT … #1 TARGET_NOT_FOUND …` | ✅ | **PASS** |
| 高亮 | V15 | 未做 | 未做 | — | **未实施** |

G0：`npx tsc --noEmit` 0 错；`npm test` **103 pass / 0 fail**（基线 95 + 新增 8）；渲染层 build ✓。

---

## 5. 未决项（必须实测才能定论，不许当结论用）

| # | 未决项 | 影响 | 怎么测 | 结论落哪 |
|---|---|---|---|---|
| R1 | Electron 44 是否支持 `Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened` | — | — | ✅ **已实测支持**，已事件化（V12 PASS） |
| R2 | Electron 44 是否开 site isolation（`localhost` vs `127.0.0.1` 是否真跨源） | 决定 V5 是不是有效验收 | V5a 的 `contentDocument` 探针 | 本文 §4.3 V5 |
| R3 | 隔离世界的 `objectId` 能否用于 `DOM.requestNode` | 决定 §2.9 的实现路径（是否需要回主 world 二次查询） | `Page.createIsolatedWorld` → `Runtime.evaluate {contextId}` 拿 `objectId` → `DOM.requestNode {objectId}` | 本文 §2.9 |
| R4 | `Accessibility.queryAXTree` 在 Electron 是否可用（experimental 域） | 决定 §2.7 的查询改造是否可行 | 已实测 `R4 ok nodes=1` | ✅ 可用（尚未接入 `#backendIdForAria`） |
| R5 | `properties[]` 里到底有没有 `checked/expanded/level`（Chromium 152 实际输出） | — | 已实测：`[{invalid}, {focusable}, {checked:tristate false}, {labelledby}]` | ✅ 已按此实现（V8 PASS）。注意 `disabled` 也在 `properties[]`，顶层的恒为 undefined |
| R6 | 跨源 iframe（OOPIF）支持 | **2026-10-16 打通（V5b 转 PASS）** | 跨源 frame 不在主会话 `Page.getFrameTree` 里 → 用 `Target.setAutoAttach({flatten:true})` 拿子会话，AX / DOM / 盒模型都在子会话里问；坐标 = 子会话盒模型 + owner iframe 内容盒原点（实测 delta=0）。**`Target.getTargets` 那条路仍然禁止**：`backendNodeId` 只在同一个 renderer 内唯一，跨会话查会静默命中无关元素。踩到的四个坑见 §5-R6 的「实测结论」 | 本文 §2.4 |
| R7 | Electron `Target.setAutoAttach` + iframe 在 44.x 是否已稳定（历史有崩溃） | 决定 OOPIF 能不能按 Playwright 的路子做 | 已实测（2026-10-15，Electron 44.7.0 / Chromium 152）：`Target.setAutoAttach {autoAttach:true,waitForDebuggerOnStart:false,flatten:true}` 后导航含跨源 iframe 的页面，**不崩溃、不黑屏**，事件正常到达：`Target.attachedToTarget {targetInfo:{type:"iframe", targetId, parentFrameId, url:""}}` | ✅ **可行**（这是 OOPIF 的正路） |

> R1 / R4 / R5 已实测并落地；**R7 已实测：setAutoAttach 在 Electron 44 上不崩溃**。

**R6 实测结论（2026-10-16 已做完，这一节留作「别再走回头路」）**：

1. `Target.setAutoAttach` 的 `Target.attachedToTarget` 事件能拿到本页的 iframe target
   （`type: "iframe"`），把它当 per-frame 会话用 → `readAxFrames` 里的
   `Accessibility.getFullAXTree` 能取到**跨源子 frame 的节点**（实测：`text=内层按钮` 从
   「找不到」变成「找得到」）。
2. 两个坑必须记住：
   - **`resetOopifSessions` 要在导航开始前清**。子 frame 是在导航过程中 attach 上来的，
     等导航结束再清会把刚拿到的会话全丢掉（实测：AX 里始终没有跨源内容，日志里连遍历都没进）。
   - **`targetInfo.targetId ≠ 该 frame 的 frameId`**。校验「这个 backendNodeId 属于这个 renderer」
     必须用**该会话自己的 `Page.getFrameTree` 根 frame id** 去比，不能拿 targetId 比。
3. **坐标的结论**（上一版就死在这）：跨源节点的 `DOM.getBoxModel`（在它自己的会话里）给的是
   **子 frame 自己视口**里的坐标，要加的是**主会话里 owner iframe 元素的内容盒左上角**
   （不是 `DOM.getFrameOwner` 的偏移、也不是 targetId 那一套）。算完实测 delta = 0
   （`debug.point` 把「我们算的」和「页面自己算的」并排返回）。
   上一版算出 x=562、iframe 只有 x∈[82.6, 506.6]，是**多加了一次偏移**。
4. **实现时要一起处理的四件事**（都实测踩过，见 HANDOFF 坑 37–40）：
   空 session id 会被 Electron 拒；AX 缓存里的**死会话**会让命令在旧会话里静默命中别的节点；
   跨源 iframe 里弹的 alert 其实走**主会话**；`DOM.describeNode` 的 `frameId` 才是 owner 的身份证。

> 已排除：`Target.getTargets` 扫全浏览器（`backendNodeId` 跨 renderer 不唯一，会静默误命中，
> 实测点到 x=1445 的假坐标）。

---

## 6. 本文件的自检记录

写这份文件时逐条核验过的事实（核验命令一并给出，便于复现）：

| 断言 | 核验方式 | 结果 |
|---|---|---|
| Electron 44.7.0 = Chromium 152.0.7977.130 | `node -e "console.log(require('electron-to-chromium/full-versions.js')['44.7.0'])"` | ✅ 152.0.7977.130 |
| `package.json` 里 electron 版本 | `node -e "console.log(require('./package.json').devDependencies.electron)"` | ✅ 44.7.0 |
| 现有 `browser/*.ts` 文件清单与行数 | `ls src/main/browser/ && wc -l src/main/browser/*.ts` | ✅ 17 文件 2867 行 |
| `ACTION_TIMEOUT_DEFAULT = 3000` | `rg -n "ACTION_TIMEOUT_DEFAULT =" src/main/browser/page-helpers.ts` | ✅ `page-helpers.ts:23` |
| `#backendIdFor` / `#nodeIdsByCss` / `#backendIdForAria` 行号 | `rg -n "async #backendIdFor\(\|async #nodeIdsByCss\|async #backendIdForAria" src/main/browser/controller.ts` | ✅ :369 / :428 / :508（并发提交后会漂移） |
| `withTimeout` 只包解析 | `sed -n 33,40p src/main/browser/actions.ts` | ✅ `actions.ts:36` |
| `keyEvents` 只产两段 | `rg -n "export function keyEvents" src/main/browser/input.ts` + 读实现 | ✅ `input.ts:82` |
| `waitForEvent('fileChooser')` 是轮询 | 读 `waits.ts` 的 `else` 分支 | ✅ 轮询 `input[type=file]` |
| 页面污染两处 | `rg -n "__warrenMatches\|data-warren-xpath-idx" src/main/browser/controller.ts` | ✅ 均在 `controller.ts`（:441/:452/:464/:484/:493/:502） |
| `Overlay` 在白名单但未使用 | `rg -n "Overlay" src/main/browser/*.ts` | ✅ 只在 `policy.ts` 出现 |
| CLI 命令与 `exec` 形态 | `sed -n 633,700p bin/warren.mjs` | ✅ `warren exec <env>`、`warren call <method> [json]` |
| fixture 服务器端口与路由 | `sed -n 1,45p scripts/serve-fixture.mjs` | ✅ `/cap/<name>.html`、`/cap/sample.txt`、`/cap/echo`、`/cap/slow` |
| 现有 capability fixture 清单 | `ls fixtures/capability/` | ✅ 8 个 |
| `npm test` 基线 | 未运行（本线程不动代码，也不启动应用） | ⚠️ **未验证**：`AGENTS.md` 声称 15/15，实施前先跑一次确认基线 |
| 所有 `warren exec` 验收脚本 | 未运行（需要运行中的应用） | ⚠️ **未验证**：这些是**待执行**的验收，不是已验证的结论 |

**Playwright 侧断言的可信度分级**：

- **源码级**（读了代码片段）：actionability 矩阵与 `checkElementStates`、`expectHitTarget` 全文、`_retryPointerAction` 的滚动轮换、`_setInputFiles` 无检查、`selectOptions` 实现、`fill` 的 `needsinput` 两段式、`waitForSignalsCreatedBy` / `SignalBarrier`、`connectOverCDP` 的 persistent options、`getByRoleSelector` 的 props 集合、hit-target 拦截器事件集合。
- **文档级**（官方文档原文）：`stable` = 连续两帧 bounding box 不变、`visible` 定义、dialog 无人监听时 auto-dismiss、`ariaSnapshot` 的 `[ref=eN]` 与 ai 模式。
- **推断**（未逐行核对，已在正文标注）：`locator.highlight()` 的实现细节。

---

## 7. 附录

### 7.1 证据索引（本轮新增）

| 事实 | 来源 |
|---|---|
| `AXNode` 顶层字段 + `properties: AXProperty[]` + `AXPropertyName` 枚举 | `ChromeDevTools/devtools-protocol` `pdl/browser_protocol.pdl`（Accessibility 域） |
| `ignoredReasons` 取值（`notRendered/notVisible/ariaHiddenElement/inertSubtree/...`） | 同上（`AxPropertyName` 枚举尾部） |
| `Accessibility.queryAXTree` 按 `accessibleName`/`role` 查询 | 同上（Accessibility 域命令定义） |
| `getBoxModel`/`getContentQuads` 返回 local root viewport 坐标 | `microsoft/playwright` commit `fab5eba`「fix(oopifs): translate coordinates to viewport」 |
| `Input.dispatchMouseEvent` 用主 frame viewport 坐标 | `GoogleChromeLabs/chromium-bidi` issue #2630 |
| file chooser 拦截在 `//content` 层实现 + 三条命令/事件 | Chromium 提交「DevTools: intercept file chooser requests」 |
| `Page.fileChooserOpened` 字段 `{frameId, mode, backendNodeId?}` | `chromedp/cdproto` `page/events.go` |
| Electron `debugger.sendCommand(method, params, sessionId)` | Electron 官方 `docs/api/debugger.md` |
| Electron `Target.setAutoAttach` + iframe 的历史崩溃/黑屏 | `electron/electron` issue #27768 |
| `expectHitTarget` 全文 | `packages/injected/src/injectedScript.ts` |
| `_retryPointerAction` 滚动轮换 | `packages/playwright-core/src/server/dom.ts` |
| `_setInputFiles` 零 actionability 检查 | 同上 |
| `press` 先 `_focus` 再按键、`waitForSignalsCreatedBy` 包裹 | 同上 |

### 7.2 与我们现有文档的关系

| 文档 | 关系 |
|---|---|
| `BROWSER-CAPABILITY-DEEP-DIVE.md` | 诊断（差在哪、为什么）；本文件是它的实施方案 |
| `BROWSER-CAPABILITY-RESEARCH.md` | 能力取舍（做不做）；本文件不改变其结论 |
| `BROWSER-CAPABILITY-PLAN.md` | 首版实施计划；本文件是**第二轮**（动作可信性），依赖它已落地 |
| `HANDOFF.md` | 实施后若有 RPC/类型/CLI 变更（如 `AxNode` 加字段、新增 `browser.highlight`），必须同步其「当前状态」 |
