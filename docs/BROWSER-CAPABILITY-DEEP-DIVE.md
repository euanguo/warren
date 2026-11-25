# 页面操作能力实现级深度调研：Playwright vs Warren

> 定位：`BROWSER-CAPABILITY-RESEARCH.md` 回答的是「**能力取舍**」（做不做、对标谁），本文件回答的是「**实现机制**」——Playwright 内部怎么做的、我们内部怎么做的、差在哪、差的部分值不值得补。
> 方法：Playwright 侧读的是 `microsoft/playwright` 主线**源码与官方文档原文**（`server/dom.ts`、`server/frames.ts`、`server/input.ts`、`injected/injectedScript.ts`、`injected/roleUtils.ts`、`injected/ariaSnapshot.ts`、`docs/src/actionability.md`、`docs/src/dialogs.md`）；Warren 侧逐文件读 `src/main/browser/*.ts`（2792 行）。
> 时间：2026-10-15。

---

## 0. 一句话结论

**是简化实现，但不是均匀简化。** 对外 API 语义层我们基本对齐（有意做子集）；**定位层是近似实现**；**动作层缺的是 Playwright 最核心的那一层——「等元素可用 + 失败重试 + 命中诊断」**。

说得更直白：

| 层 | 我们 vs Playwright | 判定 |
|---|---|---|
| 对外 API 形状（方法名/参数） | 有意的子集，命名对齐 | 对齐 |
| 定位（role/text/label/css/xpath/ref） | 语义近似，靠启发式补 | **简化** |
| ARIA 语义 | 用 Chromium 的 AX 树；Playwright 自己在页面里算 | **换了一条路**（不是简化，是分叉） |
| Actionability（能不能动） | **没有** | **缺失** |
| 重试与超时 | 只包住「解析目标」一步，不重试 | **缺失** |
| 输入合成（键鼠） | 直发 CDP，无状态机 | 简化 |
| 导航自动等待 | URL 轮询 | 简化 |
| 安全/隔离/审计（lease、vault、白名单、脱敏、遥测） | Playwright **完全没有** | **我们更强** |

我们现在的 `click` 在语义上等价于 Playwright 的 `click(..., { force: true })`——**恰好放弃了 Playwright 最有价值的那部分**。

---

## 1. Playwright 是怎么实现的

### 1.1 架构：两端，语义在页面里

Playwright 不是「一个 CDP 客户端」。它是**双端**的：

- **server 端**（Node，`packages/playwright-core/src/server/`）：超时、重试、帧管理、输入合成、事件。
- **injected 端**（`packages/injected/src/`）：一段注入到每个页面/帧里的脚本，负责**所有 DOM 语义**——选择器匹配、ARIA role 与可访问名计算、可见性/稳定性判定、命中检测、ariaSnapshot 生成。

关键点：**角色、名字、可见性这些判断都在页面里算，不依赖 CDP 的 AX 树，也不依赖 Chromium 版本。** server 只用 CDP 干两件事：发输入（`Input.*`）、拿帧结构（`Page.getFrameTree` / auto-attach）。

这套设计的直接后果：Chrome / Firefox / WebKit 三端语义一致（Firefox 走 Juggler、WebKit 走自己的协议，但 injected 脚本是同一份）。

### 1.2 定位器

`page.getByRole('button', { name: 'Submit' })` 不是去查 AX 树，而是拼成一个内部选择器字符串再交给 injected：

```ts
// packages/isomorphic/locatorUtils.ts
export function getByRoleSelector(role, options) {
  const props = [];
  if (options.checked !== undefined) props.push(['checked', String(options.checked)]);
  if (options.disabled !== undefined) props.push(['disabled', String(options.disabled)]);
  if (options.selected !== undefined) props.push(['selected', String(options.selected)]);
  if (options.expanded !== undefined) props.push(['expanded', String(options.expanded)]);
  if (options.includeHidden !== undefined) props.push(['include-hidden', ...]);
  if (options.level !== undefined) props.push(['level', String(options.level)]);
  if (options.name !== undefined) props.push(['name', escapeForAttributeSelector(options.name, !!options.exact)]);
  ...
  return `internal:role=${role}${props.map(...).join('')}`;
}
```

injected 侧解析 `internal:role=`，用 `roleUtils` 现算每个元素的 role 和 accessible name 再比对。`internal:text=` / `internal:label=` / `internal:testid=` 同理。

**严格模式**：`locator` 解析后必须唯一，多匹配直接报错，错误里列出每个候选的完整定位路径。这不是「顺手加的检查」，是设计前提——所有动作都建立在「解析到一个确定元素」之上。

**retarget**：injected 的每个动作方法开头都是 `this.retarget(node, 'follow-label')`。点 `<label>` 会自动落到它关联的 `<input>`；`fill` 也走同一条。这是「按人理解的方式操作」的一层，而不是「按 DOM 结构操作」。

### 1.3 ARIA 与 snapshot

`injected/src/roleUtils.ts` 自己实现了：role 推断（原生元素 + `role=` 属性 + ARIA 规则）、accessible name 计算（`aria-labelledby` → `aria-label` → 原生 label → 内容文本 → `title` …）、`aria-hidden` 导致的隐藏判定。

`injected/src/ariaSnapshot.ts` 用上面这套在**页面内**生成 aria 快照，`mode: 'ai'` 时带 `[ref=eN]`，且**保留层级**（YAML 缩进）：

```yaml
- button "Submit" [ref=e2]
```

文档里给的另一个例子能看出它的信息密度：

```html
<input type="text" value="Enter your name">
```
```yaml
- textbox: Enter your name
```

ref 之后可以用 `page.getByRef('e2')` 直接定位（v1.5x+），语义与我们的 `@N` 一致。

### 1.4 Actionability + 重试（**核心，我们缺的就是这层**）

官方动作检查矩阵（`docs/src/actionability.md`）：

| Action | Visible | Stable | Receives Events | Enabled | Editable | Not Inert |
|---|---|---|---|---|---|---|
| `click` / `dblclick` / `check` / `setChecked` / `tap` / `uncheck` | Yes | Yes | Yes | Yes | - | Yes |
| `hover` / `dragTo` | Yes | Yes | Yes | - | - | - |
| `fill` / `clear` | Yes | - | - | Yes | Yes | Yes |
| `selectOption` | Yes | - | - | Yes | - | - |
| `focus` / `press` / `setInputFiles` / `blur` | - | - | - | - | - | - |

各状态的定义：

- **Visible**：有非空 bounding box，且 `visibility` 不是 `hidden`。零尺寸、`display:none` 不算可见（注意：`opacity:0` 和移出屏幕**算可见**）。
- **Stable**：bounding box 连续两帧（两个 `requestAnimationFrame`）不变。
- **Enabled**：原生 `disabled` 属性/特性。
- **Editable**：enabled 且没有 `readonly`。
- **Receives Events**：用 hit target 检测——元素中心点 `elementFromPoint` 命中的是不是它（或其后代）。

服务端的执行骨架（`packages/playwright-core/src/server/dom.ts`）：

```ts
if (!force) {
  const elementStates = action.waitForEnabled ? ['visible', 'enabled', 'stable'] : ['visible', 'stable'];
  const result = await progress.race(this.evaluateInUtility(async ([injected, node, { elementStates, frameVisible }]) => {
    return await injected.checkElementStates(node, elementStates, frameVisible);
  }, { elementStates, frameVisible }));
  if (result) return result;   // 不满足 → 回到外层重试
}
```

外层是一个**重试循环**：不满足就 `progress` 等一会儿再来一遍，直到 `timeout`（默认 30s）才抛 `TimeoutError`。每次重试都会**重新解析元素**——所以 React 重渲染把节点换掉之后，它点的是新节点，我们点的是旧 `backendNodeId`。

命中检测还不止 `elementFromPoint`。injected 在 `Window` 上以 `capture: true` 挂了一组**拦截器**：

```ts
this._mouseHitTargetInterceptorEvents = new Set(['mousedown','mouseup','pointerdown','pointerup','click','auxclick','dblclick','contextmenu']);
```

事件真发出去之后，拦截器逐个校验事件坐标命中的元素对不对；不对就**拦掉后续事件**并报出「被谁挡住」。这就是为什么 Playwright 的失败信息是「`<div class="overlay">` intercepts pointer events」而不是「什么都没发生」。

`force: true` 才跳过这一整套。**我们永远处在这个模式。**

### 1.5 输入层

- **鼠标**：`Mouse` 类维护位置与**按键位掩码状态机**（`down` 之后 `move` 自动带 `buttons`），`click` 展开为 `move → down → up`（`clickCount` 支持双击语义）。
- **键盘**：`Keyboard` 维护 `_modifiers` 集合（`down('Shift')` 之后所有后续事件自动带 Shift，`up` 清除）与按下键集合。`press` 对可打印字符发 `keydown` + **char** + `keyup` 三段，对命名键发 `rawKeyDown` + `keyup`。`type` 逐字符发，`insertText` 只发输入不产生按键事件。
- **`fill`** 是**两段式**，这是最容易看漏的一处：

  ```ts
  // injectedScript.ts
  fill(node, value) {
    ...
    // date/time/color/range/month/week：直接赋值 + 派发 input/change，返回 'done'
    if (kInputTypesToSetValue.has(type)) { input.focus(); input.value = value; ... return 'done'; }
    ...
    this.selectText(element);
    return 'needsinput';   // 还需要服务端输入
  }
  ```

  页面内先把内容**选中**（真 selection，不是合成 ⌘A），服务端再发 `Input.insertText`。`number` 会校验是不是数字、`color` 转小写、非法值抛 `Malformed value`。
- **`selectOption`** 也在页面内做：按 `valueOrLabel` / `value` / `label` / `index` 匹配，**禁用 option 直接报 `error:optionnotenabled`**，选中后派发 `input`（`composed: true`）+ `change`，返回选中项的 value 数组。

### 1.6 导航自动等待：SignalBarrier

点一个会跳转的按钮，Playwright 不需要你写 `waitForNavigation`。所有动作都被包在：

```ts
// packages/playwright-core/src/server/frames.ts
async waitForSignalsCreatedBy<T>(progress, waitAfter, action) {
  if (!waitAfter) return action(progress);
  const barrier = new SignalBarrier(progress);
  this._signalBarriers.add(barrier);
  try {
    const result = await action(progress);
    await progress.race(this._page.delegate.inputActionEpilogue());
    await barrier.waitFor(progress);
    await new Promise<void>(f => setImmediate(f));
    return result;
  } finally { this._signalBarriers.delete(barrier); }
}
```

重点是它等的是「**本次动作触发的**导航」——barrier 只吃动作之后新产生的 `InternalNavigation` 信号，无关导航不算。`noWaitAfter` 可以关掉这个行为。

### 1.7 dialog / download / fileChooser

- **dialog**：`Page.javascriptDialogOpening` → `Dialog` 对象。**没人监听时 Playwright 默认 auto-dismiss**（官方文档明说）。我们的设计相反（见 §4-D11）。
- **download**：`Browser.setDownloadBehavior` 按 context 设置落盘位置，`page.waitForEvent('download')` 拿 `Download` 对象（`suggestedFilename/saveAs/path/failure/cancel/delete`）。
- **fileChooser**：有原生事件 `Page.fileChooserOpened`（需先 `Page.setInterceptFileChooserDialog`），`FileChooser.setFiles` 直接落到那个 input 上。

### 1.8 超时与错误

`ProgressController` 统一管超时（默认 30s）、取消（`signal`）、以及**日志**：每次重试都会 `progress.log(...)` 记录「在等哪些状态」「元素当前是什么状态」。超时抛出的 `TimeoutError` 带着这段历史，而不是一句「timed out」。

对 agent 场景这点很重要：**错误文本就是 agent 的反馈信号**。

### 1.9 帧

`Frame` 是一等公民：每个 frame 有自己的执行上下文，OOPIF 通过 auto-attach 单独连接（`crPage.ts` 里对「CDP connect 场景下已附加的 OOPIF 跳过重挂载」有明确注释）。定位、动作、快照都在 frame 作用域内解析。

---

## 2. Warren 是怎么实现的

模块划分（`src/main/browser/`，2792 行）：

```
session.ts      CDP 会话（wc.debugger.attach('1.3') + 只开 Page 域）+ dialog 消息分发
controller.ts   门面：导航 / info / events / #backendIdFor*（选择器 → backendNodeId）
snapshot.ts     Accessibility.getFullAXTree 逐帧取树 → 扁平节点数组 + ref 分配 + 截图
waits.ts        7 种等待，一律 150ms 轮询
actions.ts      click/dblclick/hover/drag/fill/selectOption/focus/press/setInputFiles + dialog/download
keymouse.ts     坐标键鼠（含 lastMouse）
input.ts        纯函数：chord 解析 + CDP 参数组装
page-helpers.ts nodeId 换算 / boxCenter / withTimeout / waitForNavigation / 收据
escape.ts       evaluate / fetch / cdp / clearDataForOrigin（带脱敏）
policy.ts       CDP 白名单 + 路径护栏 + 凭据默认
refs.ts         RefTable（@N → backendNodeId + gen）
pending.ts      环境级 popup/download 队列；downloads.ts 落盘接线
```

### 2.1 定位：三条路

`controller.ts:361 #backendIdFor` 分派：

- **`ref`（`@N`）**：查 `RefTable`，导航后 `gen` 变化即报 `TARGET_STALE`（`refs.ts:21`）。
- **CSS / `loc=css:` / `loc=href:`**（`controller.ts:420 #nodeIdsByCss`）：**不用 `DOM.querySelectorAll`**（它不穿 open shadow root），改成页面内 JS 递归遍历 `document` + 每层 `shadowRoot` + 同源 `contentDocument`，把结果挂到 `window.__warrenMatches`，再用 `DOM.requestNode` 逐个换回 nodeId → `DOM.describeNode` 拿 backendNodeId。`href` 先转成 `a[href*="..."]`；`:has-text/:text-is` 是拿到元素后逐个 `innerText` 过滤。
- **`role` / `text` / `label`**（`controller.ts:500 #backendIdForAria`）：读 `readAxNodes`（AX 树），按 role 精确比对、name 子串/精确比对；`label` 近似成「role 是 textbox/searchbox/combobox 且 name 包含」；`text=` 额外做了两处启发式——按 backendNodeId 去重、优先丢掉 `StaticText/InlineTextBox/LineBreak`。
- **xpath**：页面内 `document.evaluate` 打临时 `data-warren-xpath-idx` 标记，再 CSS 反查。

多匹配一律报 `TARGET_AMBIGUOUS`（带 count + 前 3 候选）。`snapshot.ts:26 readAxFrames` 按 `Page.getFrameTree` 逐帧取 `Accessibility.getFullAXTree`（因为 AX 树不返回子 frame 内容），带 120ms TTL 缓存。

### 2.2 snapshot

`snapshot.ts:113` 把逐帧 AX 节点拍成**扁平数组**，过滤 `ignored` 和「无名字、非交互、无值」的节点，带上 `role/name/value/description/disabled/backendNodeId/frameId`，然后 `refs.register()` 分配 `@1..@N`。可选 `includeActionMarks`（推断可点的动作）和 `includeStableLocator`（生成 `loc=role:...[name="..."]`）。

只有 `snapshot()` 会写 RefTable，其它内部解析走只读的 `readAxNodes()`——这是为了不把 agent 手上的 `@N` 悄悄重编号（`snapshot.ts` 顶部注释）。

### 2.3 动作

`actions.ts:33 click` 的完整流程：

```
assertNoDialog → withTimeout(解析 target) → boxCenter（先 DOM.scrollIntoViewIfNeeded 再 DOM.getBoxModel 取中心）
→ mouseMoved → mousePressed → mouseReleased
→ 等 5s 内的 URL 变化（waitForNavigation，不报错）
→ 返回 {x, y, url, ...receipt}
```

`fill`（`actions.ts:104`）：`DOM.focus` → 合成 ⌘A/Ctrl+A（`Input.dispatchKeyEvent` 两段）→ `Input.insertText` → **读回确认**（不一致抛 `FILL_UNCONFIRMED`）。

`press`：`keyEvents()` 只产出 **keyDown + keyUp 两段**（`input.ts:82`）。

`selectOption`（`actions.ts:130`）：整段在页面内 `evalOnNode` 里做，支持 `{value,label,index}`、多选、`null` 清空，最后派发 `input` + `change`。

`#sendInput`（`controller.ts`）有个特殊设计：输入命令与「dialog 是否已打开」赛跑，dialog 一出现就交还控制权（否则点击触发 `alert()` 的那次 `mouseReleased` 永不返回）。**注意**：`if (Date.now() > deadline) return;`——3 秒没回就**静默当作成功**。

### 2.4 等待与超时

全部 150ms 轮询：`waitForURL` / `waitForSelector`（六态）/ `waitForFunction` / `waitForLoadState`（commit/domcontentloaded/load/networkidle，networkidle 用遥测活动时间）/ `waitForEvent`（popup/download/dialog/fileChooser，fileChooser 退化成「轮询 `input[type=file]` 是否存在」）。

`ACTION_TIMEOUT_DEFAULT = 3000`（`page-helpers.ts:23`），`withTimeout`（`page-helpers.ts:84`）是个 `Promise.race`。

---

## 3. 差距清单（按严重度）

### D1 · 没有 actionability 检查，动作等于永远 `force: true` —— 最严重

**现象**：点动画中的元素、被浮层遮住的元素、`disabled` 的按钮，命令**成功返回**，页面没反应。

**根因**：`actions.ts` 里 click 的检查只有 `assertNoDialog` + `boxCenter`（`scrollIntoViewIfNeeded`）。没有 visible/stable/receives-events/enabled 任何一项。对比 Playwright 的 `checkElementStates` 矩阵（§1.4）。

**影响**：这是「静默失败」的最大来源，也正是 `AGENTS.md` 已知问题第 8 条（「点击落在视图外且不报错」）在**语义层**的同类问题——我们只修了坐标，没修「点了但没生效」。

**补法**：在 `page-helpers.ts` 加一个 `checkActionable(ctx, backendId, states)`，用 `evalOnNode` 在页面内算（可见性用 `getBoundingClientRect` + `getComputedStyle`；稳定用两次 `requestAnimationFrame` 比 box；命中用 `elementFromPoint` 比对是否为目标或其后代）。成本约 80–120 行 + 纯函数单测。

### D2 · 动作不重试、不等元素出现 —— 同样严重

**现象**：`click('#submit')` 在按钮 200ms 后才出现的页面上直接报 `TARGET_NOT_FOUND`；SPA 重渲染后点击落在已脱离文档的旧节点上。

**根因**：`withTimeout(() => ctx.backendIdFor(target))` 只是给「解析」加了个 3s 上限，`backendIdFor` 找不到就**立即抛错**（`controller.ts:381`），不是等。拿到 backendNodeId 之后一路直发，中间任何一步失败都不重试。整个仓库只有 `ENV_BUSY` 在 CLI 层重试（`bin/warren.mjs:203`）。

**对比**：Playwright 是「解析 → 检查 → 执行」整段循环，每次重试重新解析，直到 30s 超时。

**影响**：agent 必须自己记得在动作前手动 `waitForSelector`，忘了就脆。而且 `waitForSelector` 是**另一个 RPC**，中间有窗口期。

**补法**：给 `actions.ts` 的写动作包一层统一的 `retryUntilTimeout(progress, action)`，超时/不可用就退避重试（重试内重新 `backendIdFor`）。这一步做完，D1 的检查才真正有用——**两者必须一起做**。

### D3 · 没有命中诊断（被谁挡住）

**现象**：元素被浮层挡住 → 点击无效果、无错误。

**补法**：点击前 `elementFromPoint(x, y)` 拿最上层元素，与目标（或其祖先/后代/label）比对；不匹配就抛 `TARGET_OCCLUDED`，消息里带上挡路元素的 tag/class/文本。成本约 20 行，**性价比最高的一条**。Playwright 更彻底（事件发出后还挂 capture 拦截器二次校验），但我们对「发之前先查一次」就够了。

### D4 · `fill` 的选中方式是合成按键，不是真 selection

**现象**：自定义富文本编辑器 / 虚拟列表输入框里，`fill` 变成**追加**而不是替换（合成 ⌘A 没选中）。

**根因**：`actions.ts:104` 用 `Input.dispatchKeyEvent` 发 ⌘A。Playwright 是页面内 `this.selectText(element)`（selection API）+ `Input.insertText`。

**补法**：改成 `evalOnNode(... el.select?.() ?? document.execCommand('selectAll'))` + 保留现有的读回确认。

**顺带**：我们的**读回确认是 Playwright 没有的**，别丢（见 §5）。

### D5 · `press` 不发 `char` 事件

**根因**：`input.ts:82 keyEvents()` 只产出 keyDown/keyUp 两段。Playwright 对可打印字符发 `keydown + char + keyup`。

**影响**：只监听 `keypress`/`input` 的页面收不到输入；受控输入框（React）在 `press('a')` 后不回显。

**补法**：`keyEvents` 对单字符 key 插一段 `{type:'char', text: key}`。

### D6 · 键鼠没有状态机

**根因**：`input.ts` 每次调用自带 modifiers；`keymouse.ts` 只有 `lastMouse` 记坐标，`mouseMove` 固定 `buttons: 0`，没有按键状态集合。

**影响**：`keyboard.down('Shift')` 后 `keyboard.press('a')` 得到的是 `a` 而不是 `A`；`mouse.down()` 后 `mouse.move()` 不会带左键按下（拖拽只能走 `drag()` 一次性完成）。

**补法**：加一个模块级 `modifiers` / `buttons` 状态（`keymouse.ts` 已有 `mouse-state.ts` 这个落点，扩展它即可）。成本很小。

### D7 · snapshot 是扁平表，丢了层级和状态

**根因**：`snapshot.ts:113` 输出扁平数组，只带 `disabled`。Playwright 的 ariaSnapshot 是带缩进的 YAML，且 role 选择器支持 `checked/selected/expanded/level/pressed` 等状态。

**影响**：agent 看不出「这个 menuitem 在哪个 menu 下」「这个 checkbox 勾没勾」「这个 heading 是几级」「这个 tab 是不是展开态」——表格/树/菜单类页面上，agent 得靠猜或额外 `evaluate`。

**补法**：AX 节点本身就有 `childIds`（`snapshot.ts` 的 `collectSubtree` 已经在用），可以重建层级并输出缩进文本；`checked/expanded/level` 在 AX 节点里也有对应字段，取出来带上即可。这是**对 agent 收益最大的一条**，成本中等（一个新函数 + 输出格式决策）。

### D8 · ARIA 定位是近似实现

**根因**：我们用 Chromium 的 AX 树 name 做子串匹配，并用「去 StaticText」的启发式消歧（`controller.ts:500` 附近的注释）。Playwright 是自己实现完整的 role 推断 + accessible name 算法。

**影响**：

- `text=` 在「同名 StaticText 与可交互祖先」这类结构上，靠启发式，边界情况会误判（我们的注释本身就承认「不去掉必然报歧义」）。
- `label` 定位只在 textbox/searchbox/combobox 上近似，`<label for>` 关联、`aria-labelledby` 的完整解析不做。
- 没有 `includeHidden`、没有按 `checked/expanded/level` 过滤。

**补法**：不建议自研 accname。可行的低成本改法是**给 `text=` 加一个「优先可交互祖先」的显式规则并写进文档**，其余维持近似；真要完整语义就得走 injected 路线（成本高，见 §7）。

### D9 · 没有 retarget（`follow-label`）

**现象**：`click('text=记住我')` 命中 `<label>`，点上去……大概率也能勾上（浏览器原生行为），但 `fill` 落在 label 上就会直接报错。

**补法**：在 `backendIdFor` 之后加一步「若是 `<label>` 且有 `.control`，换成那个 control」。约 15 行。

### D10 · 错误信息没有等待历史

**根因**：我们的错误只有 `code + 一行 message`（`err()` 到处用）。

**对比**：Playwright 的 `TimeoutError` 带「等了哪些状态、每次重试看到什么」。

**影响**：agent 拿到 `TIMEOUT` 无法自我修正（是元素没出现？还是被挡住？还是没 enabled？）。

**补法**：D1/D2 做完之后，把最后一次检查结果塞进错误消息即可（`元素存在但被 <div class="mask"> 遮挡`、`元素存在但 disabled`、`元素未出现`）。

### D11 · dialog 语义与 Playwright 相反（**有意的，不是缺陷**）

Playwright 没人监听就 auto-dismiss；我们是**阻塞**（`DIALOG_OPEN` 守卫，`assertNoDialog` 拦住所有输入命令，`#sendInput` 与 dialog 赛跑）。

我们的取舍更适合「人机同视」——不替用户做决定。**但风险是死锁**：agent 不处理就一路挂到 RPC 60s 超时。建议在 `DIALOG_OPEN` 的错误文本里直接给出 `browser.acceptDialog() / dismissDialog()` 的下一步提示（`page-helpers.ts:assertNoDialog` 已有一半）。

### D12 · 导航自动等待是 URL 轮询

**根因**：`page-helpers.ts:98 waitForNavigation` 用 100ms 轮询 `wc.getURL() !== urlBefore`，5s 后静默放弃。

**差异**：① 等的是「URL 变了」而不是「本次动作触发的导航完成」——SPA 里点一个只改 hash 的链接会立刻「完成」，真正的 XHR 后跳转不会被等；② 无关导航也可能被算进来；③ 超时不报错，收据里只是带个 URL。

**补法**：改为监听 `did-navigate` / `did-start-navigation` 且要求 `isMainFrame`，并区分「动作开始后新产生」的导航。成本小。

### D13 · fileChooser 退化成轮询（平台限制，**待验证**）

`waits.ts` 注释写明「Electron 无原生 chooser 事件」，所以用轮询 `input[type=file]` 存在性代替。Playwright 用的是 `Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened`。**这一条需要实测确认 Electron 是否真的不支持**（见 §8），如果能用，就从轮询升级成事件。

### D14 · `#sendInput` 超时静默放过

`controller.ts` 的 `#sendInput` 在 3s deadline 到点时 `return`（当作成功）。这与「静默失败最难查」的原则冲突——至少应记一条事件或返回标记。

---

## 4. 我们比 Playwright 强、不该抄的地方

调研的另一半结论：**不要把 Playwright 的全套当标准**，它假设「被控页面是可信的、整个浏览器归它管」。我们有它没有的一整层：

1. **人机同视 + lease + 原生输入遮罩**：同一页面实例、同一时刻只有一个写者。Playwright 没有这个概念。
2. **每环境独立 Session/代理/存储**，per-env 下载临时区（`downloads.ts`）、下载句柄上限（`pending.ts` 的 `maxDownloads`）。
3. **权限与安全**：CDP 白名单（`policy.ts`，`Browser/Target` 全禁）、路径护栏（禁 `~/.warren`、系统目录）、`fetch` 默认同站带凭据、`evaluate/fetch` 返回值凭据脱敏、`vault.fill` 是唯一密码入口。
4. **审计**：`browser.action` / `browser.download` / `browser.cdpBlocked` 事件流，人可读。
5. **`fill` 的读回确认**（`FILL_UNCONFIRMED`）——Playwright 填完不验，页面自己吞掉输入它是不知道的。
6. **ref 表导航失效**（`refs.ts` 的 `gen`）——`@N` 跨导航明确报 `TARGET_STALE`，而不是静默指到别的元素。
7. **遥测走原生事件**，不 `Runtime/Network.enable`（省检测面）。
8. **不开口的调试端口**：`webContents.debugger` 进程内会话 vs `--remote-debugging-port`。

---

## 5. Playwright 值得学的（原则级，比抄代码重要）

1. **语义在页面里算，不在协议里算**。injected 路线让它在三个浏览器内核上语义一致，也不受 CDP 版本差异影响。我们的 AX 树路线吃的是 Chromium 的算法——稳，但改不动、也没法跨内核。
2. **一切动作走同一条管道**：`解析 → retarget → 检查 → 执行 → 等导航`。语义一致，不会某个动作忘了等。
3. **失败必须可诊断**：hit-target 拦截器存在的唯一理由，就是把「什么都没发生」变成「被 `<div class=overlay>` 挡住」。
4. **超时是带日志的重试，不是一次性放弃**。错误文本是 agent 的反馈信号。
5. **默认值站在「像人一样操作」那边**：`follow-label`、`fill` 自动清空、`selectOption` 认 label、`check` 幂等。
6. **状态机**（键盘 modifiers、鼠标 buttons）让低层 API 可组合，而不是只能跑一次性脚本。
7. **给模型看的格式要和给人看的不一样**：`ariaSnapshot({mode:'ai'})` 专门为 AI 优化（层级 + `[ref=eN]` + 值内联）。

---

## 6. 建议的补法排序

| 优先级 | 事项 | 改动点 | 成本 | 收益 |
|---|---|---|---|---|
| **P0** | 动作重试循环 + 等元素出现（D2） | `actions.ts` + `page-helpers.ts` | 中 | 直接提升 agent 成功率，消掉最常见的一类脆 |
| **P0** | actionability 检查 visible/stable/enabled/receives-events（D1） | `page-helpers.ts` 新函数 | 中 | 治「点了没反应」 |
| **P0** | 命中诊断 `TARGET_OCCLUDED`（D3） | `actions.ts` click 前 20 行 | 小 | 同上，且错误可自解释 |
| **P1** | snapshot 层级 + 状态标记（D7） | `snapshot.ts` | 中 | agent 理解力提升最大 |
| **P1** | `fill` 用页面内 selectText（D4） | `actions.ts` | 小 | 治富文本/自定义编辑器 |
| **P1** | `press` 补 char 段（D5） | `input.ts` | 小 | 治受控输入框 |
| **P1** | 键鼠状态机（D6） | `mouse-state.ts` 扩展 | 小 | 低层 API 可组合 |
| **P2** | 错误文本带最后一次检查结果（D10） | 随 P0 一起 | 小 | agent 自纠错 |
| **P2** | retarget follow-label（D9） | `controller.ts` | 小 | 少一类误操作 |
| **P2** | 导航等待改事件驱动（D12） | `page-helpers.ts` | 小 | SPA 正确性 |
| **P2** | `#sendInput` 超时不静默（D14） | `controller.ts` | 小 | 少一类静默失败 |
| **P3** | 元素高亮（Overlay 域已在白名单里但没用） | 新方法 | 小 | **产品点**：agent 操作时给人看目标在哪 |
| **P3** | `text=` 消歧规则写进文档（D8） | 文档 | 小 | 减少误用 |
| **不做** | 自研 injected 选择器引擎 / accname / route / HAR / 多 context | — | 很大 | 与单 session + 人机同视冲突（见 TECH-STACK-RESEARCH §13） |

---

## 7. 待验证清单（**别把上面的推断当实测**）

1. **iframe 内元素的点击坐标**：`boxCenter` 用主 frame 的 `DOM.getBoxModel` 取坐标，元素在（同源/跨源）子 frame 里时坐标是否可直接用于 `Input.dispatchMouseEvent`？Playwright 因为帧是一等公民不存在这个问题，我们这里必须实测。
2. **Electron 是否支持 `Page.setInterceptFileChooserDialog` / `Page.fileChooserOpened`**（决定 D13 能不能修）。
3. **`Accessibility.getFullAXTree` 是否返回 `checked/expanded/level/selected`**（决定 D7 的成本）。
4. **`elementFromPoint` 在跨源 iframe 场景的可用性**（决定 D3 的覆盖面）。
5. Playwright 侧的两处说法来自官方文档而非源码逐行核对：`stable` 的「连续两帧」定义、dialog 的 auto-dismiss 默认行为。

---

## 8. 附录：源码索引

**Playwright**（`github.com/microsoft/playwright`）

| 路径 | 内容 |
|---|---|
| `packages/injected/src/injectedScript.ts` | 定位、retarget、fill/selectOptions、命中拦截器、checkElementStates |
| `packages/injected/src/roleUtils.ts` | role 推断 + accessible name/description |
| `packages/injected/src/ariaSnapshot.ts` | 页面内 aria 快照生成（含 `[ref=eN]`） |
| `packages/playwright-core/src/server/dom.ts` | `_performPointerAction`、actionability 重试循环 |
| `packages/playwright-core/src/server/frames.ts` | `waitForSignalsCreatedBy` / SignalBarrier |
| `packages/playwright-core/src/server/input.ts` | Keyboard/Mouse 状态机 |
| `packages/playwright-core/src/server/chromium/crPage.ts` | OOPIF / CDP 连接细节 |
| `packages/isomorphic/locatorUtils.ts` | `getByRole` → `internal:role=...` |
| `docs/src/actionability.md` | 动作检查矩阵与各状态定义 |
| `docs/src/dialogs.md`、`docs/src/downloads.md`、`docs/src/aria-snapshots.md` | dialog 默认行为 / 下载 / aria 快照 |

**Warren**（本仓库）

| 文件:行 | 内容 |
|---|---|
| `src/main/browser/session.ts:49` | `wc.debugger.attach('1.3')` + dialog 分发 |
| `src/main/browser/controller.ts:361` | `#backendIdFor` 分派 |
| `src/main/browser/controller.ts:420` | `#nodeIdsByCss`（穿 shadow root / 同源 iframe） |
| `src/main/browser/controller.ts:500` | `#backendIdForAria`（AX 树匹配 + 去 StaticText 启发式） |
| `src/main/browser/snapshot.ts:26` | `readAxFrames`（逐帧取 AX，120ms TTL） |
| `src/main/browser/snapshot.ts:113` | `snapshot()`（扁平输出 + ref 分配） |
| `src/main/browser/refs.ts:21` | `RefTable.register`（每次快照整表重建） |
| `src/main/browser/actions.ts:33/104/130` | click / fill / selectOption |
| `src/main/browser/input.ts:82` | `keyEvents`（keyDown+keyUp 两段） |
| `src/main/browser/page-helpers.ts:23/30/84/98` | 超时默认值 / nodeId 换算 / withTimeout / waitForNavigation |
| `src/main/browser/policy.ts` | CDP 白名单、路径护栏、凭据默认 |

**相关文档**：`BROWSER-CAPABILITY-RESEARCH.md`（能力取舍）、`BROWSER-CAPABILITY-PLAN.md`（实施计划）、`TECH-STACK-RESEARCH.md` §3.3/§13（为什么不直接用 Playwright 接管页面）。
