# 右侧浏览器模块：标签页能力对齐 计划文档

> 目标读者：接手实现的 agent / 人
> 前置阅读：`docs/ELECTRON-BROWSER-SHELL-RESEARCH.md`（参考项目的调研与实测数据）
> 状态：**阶段 1 已实现、已提交（`6c89c25`）并实测通过**；阶段 2 一条都没做（清单见 §11，逐条写了「能不能做」）。
> 2026-10-14 复核：favicon 曾经**根本没显示**（渲染层 CSP 拦掉远程图标，全部退化成地球占位图），已修；同时修掉「导航后图标不清」和「图标 404 一次就永久黏住」。见 §1.1 #2 与 §15。
>
> **实现记录（2026-10-13）**：新增 `src/main/domain/tabs.ts`（纯逻辑 + 10 个单测）、`src/main/tabs.ts`（Tab / TabManager）、`src/renderer/features/environments/environment-tabstrip.tsx`；改造 `environments.ts`（`#views` → `#tabs`）、`telemetry.ts`（按标签 + 修 session 监听器）、`rpc.ts` / `main.ts` / `preload.ts` / `bin/warren.mjs` / `shared/types.ts`。实测：四种网页开标签场景全部落成同一 Environment 的标签；跨标签共享登录态；关掉当前标签选右边邻居；关掉最后一个 → 环境 stopped；遮罩只盖当前环境且切标签后仍在最上层；后台环境开标签不会把视图盖到当前页面上；`npm test` 44/44、`tsc --noEmit` 干净、渲染层构建通过。
>
> **复核记录（2026-10-14）**：提交 `6c89c25`。复核了「标签条上的图标/标题/其他 Chrome 行为」（§1.1 全表实测）。修掉 3 个 favicon 缺陷：① 主进程用**环境自己的 session** 取图标并转 data URL（渲染层 CSP 只允许 `img-src 'self' data:`，直接 `<img src="http://…">` 会被静默拦掉）；② `did-navigate` 时清掉旧图标；③ 渲染层 `Favicon` 的 `broken` 状态改用 `key` 重挂，不再「404 一次就永远地球」。
> 模型已确认：**Environment 在最外层，标签活在 Environment 里面**

---

## 1. 目标

把右侧那块从「一个 Environment = 一页 `WebContentsView`」升级成「一个 Environment = 一组标签页」，能力对齐 electron-browser-shell：

| 能力 | 阶段 |
|---|---|
| 一个 Environment 内多标签；新建 / 切换 / 关闭 | 1 |
| 网页里的 `target="_blank"`、⌘/Ctrl+点击、中键、Shift+点击、`window.open` 全部按真实浏览器语义落成标签 | 1 |
| 切标签后 Agent 的 CDP、遥测、遮罩、lease 全部正确跟随 | 1 |
| CLI 能显式管理标签；`warren exec` 能寻址标签 | 1 |
| favicon、loading、audible、快捷键、右键菜单、中键关标签 | 2 |
| 真·多窗口、弹窗拦截、标签持久化（会话恢复） | 3（按需） |

### 1.1 能力对照（2026-10-14 逐条复核）

**状态**：✅ 已做并实测 · 🟡 没做（**能做**，已排进 §11）· ⛔ 明确不做（非目标）· 🔴 做不了（Electron 限制，有实测/源码依据）

#### A. 标签条本身（"有没有图标、标题、Chrome 的那套手感"）

| # | Chrome 行为 | 状态 | 说明 |
|---|---|---|---|
| 1 | 标签标题跟着页面 `document.title` | ✅ | `page-title-updated` → `TabState.title`。实测 `PNG Icon Page` / `Fixture Login` 都对 |
| 2 | 标签图标（favicon） | ✅ | **本次刚修好**。主进程在 `page-favicon-updated` 时用**环境的 session** `fetch()` 取图标 → 转 data URL 塞进 `TabState.favicon`。实测：`<link rel=icon>` 的 PNG / SVG 都能显示；无图标页退回地球占位图。修之前渲染层 CSP（`img-src 'self' data:`）把远程图标全拦了，`new Image()` 加载 `http://…/icon.png` 返回 error，所以每个标签都是地球 |
| 3 | 导航后旧图标要清掉 | ✅ | `did-navigate` 时 `favicon: undefined`。修之前会留着上一个页面的图标 |
| 4 | 图标加载失败不能永久黏住 | ✅ | `Favicon` 的 `broken` 状态挂在 `key={favicon}` 上，换图标就重挂 |
| 5 | 加载中转圈 | ✅ | `did-start-loading` / `did-stop-loading` → `<Spinner>` |
| 6 | 标签溢出横向滚动 | ✅ | `SurfaceTabStrip` 自带 `overflow-x-auto` + `scroll-fade-x` |
| 7 | hover 显示完整 URL / 标题 | ✅ | `title={tab.url}` |
| 8 | 关闭按钮（hover 出现，不误触选中） | ✅ | `SurfaceTab` 的 action 区已 `stopPropagation` |
| 9 | 中键关标签 | 🟡 | 渲染层 `onAuxClick`（`event.button === 1`）即可，纯前端 |
| 10 | 标签右键菜单（重新加载 / 复制链接 / 关闭 / 关闭其他 / 关闭右侧） | 🟡 | `components/ui/context-menu.tsx`（base-ui）已有；注意 `Item` 用 `onClick` 不是 `onSelect`，`Label` 必须在 `Group` 里 |
| 11 | 有声标签的喇叭图标 + 静音 | 🟡 | `audible` **已经采集**（`media-started-playing` / `media-paused`），只是 UI 没画；静音用 `webContents.setAudioMuted`，主进程加一个 `tab.mute` 即可 |
| 12 | 拖拽调整标签顺序 | 🟡 | 领域层 `TabList.reorder()` 已经写好但**没人调用**；UI 加拖拽 + `tab.reorder` RPC 就能用 |
| 13 | `+` 新建标签 | ✅ | 但开的是 `about:blank`（白板），Chrome 是「新标签页」——见 #26 |
| 14 | 快捷键 ⌘T / ⌘W / ⌘1..9 / ⌘R / ⌘L | 🟡 | **主进程现在完全没有应用菜单**（全仓库搜不到 `setApplicationMenu`）。要新建 `src/main/menu.ts`；页面抢键时用 tab 的 `before-input-event` 兜底 |
| 15 | ⌘⇧T 恢复刚关掉的标签 | 🟡 | 需要主进程存一个「最近关闭」栈（`{url, index}`），纯自己实现 |
| 16 | 地址栏可编辑（输入 URL 回车导航） | 🟡 | 现在只**显示** URL（只读）+ 复制按钮；`environment-stage.tsx` 的 URL 区域改成 input 即可，写操作要过 lease |
| 17 | 前进 / 后退 / 刷新 | ✅ | `environment-stage.tsx` 已有按钮，走 `browser-control` 的 `goBack/goForward/reload` |

#### B. 开窗与导航语义（"网页自己开标签"这一块）

| # | Chrome 行为 | 状态 | 说明 |
|---|---|---|---|
| 18 | `<a target="_blank">` 左键 → 前台新标签 | ✅ | 实测（`foreground-tab`） |
| 19 | ⌘/Ctrl+点击、中键 → **后台**新标签 | ✅ | 实测（`background-tab`，不抢激活） |
| 20 | Shift+点击 / 带 features 的 `window.open` → **新窗口** | 🟡 | 现在**收敛成标签**（记录在案的偏离，见 §4 决策 1）。真窗口要等阶段 3 |
| 21 | 具名窗口复用（`window.open(u,'name')` 第二次） | ✅ | Electron 自己复用，`handlerCalls=0`，实测 |
| 22 | `_self` / `_parent` / `_top` 原地导航 | ✅ | 不进 handler，Electron 自己导航，实测 |
| 23 | 脚本打开的标签调 `window.close()` 能关 | ✅ | 实测 `close`→`destroyed`，走统一移除路径；普通标签的 `window.close()` 被忽略（与 Chrome 一致） |
| 24 | `window.opener` / `postMessage` 关系 | ✅ | Electron 原生保留（同一个 webContents 组） |
| 25 | opener 关掉时连坐关掉脚本开的 popup | ⚠️ 偏离 | 我们用了 `outlivesOpener: true`，实测**子标签活着**。Chrome 会连坐关掉。判断：不跟（我们的 popup 是标签，连坐关掉会误伤用户正在看的页面），写进 §13 |
| 26 | 新标签页（Chrome 的搜索框/常用站点页） | 🟡 | 现在是 `about:blank`。要么给一个内置的 `warren://newtab` 静态页，要么 `+` 直接开环境的 `startUrl` |
| 27 | 弹窗拦截（无用户手势的 `window.open`） | 🔴→🟡 | Electron **没有**原生 popup blocker（源码 + 实测：`setTimeout` 里的 `window.open` 照样开）。要做只能自己包 `window.open` + 用户手势标记，**会改页面环境**（`window.open.toString()` 不再原生）→ §4 决策 2：做成开关、默认关，排阶段 3 |
| 28 | `<a download>` / `Content-Disposition: attachment` | ⚠️ 偏离 | 实测 Electron 给的是 `foreground-tab`（不是 `save-to-disk`），所以现在会开一个标签；同时 Electron 自己的下载通道照常走。下载管理本身是非目标 |
| 29 | 页面 HTML5 全屏（`requestFullscreen`） | ❓未验 | Electron 默认会进全屏（`enter-html-full-screen`）。在 `WebContentsView` 里的表现没验过，排阶段 2 顺带验 |

#### C. 持久化与更大的东西

| # | 行为 | 状态 | 说明 |
|---|---|---|---|
| 30 | 标签持久化 / 会话恢复（重启后回到上次那组标签） | 🟡 | 现在重启只回到 `startUrl`。`store.ts` 已经有持久化骨架，加一个 `tabs[]` 即可，排阶段 3 |
| 31 | 真·多窗口 | 🟡 | 能做（`new BrowserWindow`），但和产品模型冲突：新窗口跳出右侧区域 → **遮罩盖不住**、`stop(env)` 要多一套窗口注册表。排阶段 3，需产品决策 |
| 32 | 书签 / 历史 / 下载管理 / 密码 / 同步 | ⛔ | PRD 非目标 |
| 33 | Chrome 扩展（`chrome.tabs` / `chrome.*`） | ⛔ | 我们有自己的 `PluginHost`，不引 `electron-chrome-extensions` |
| 34 | 标签组 / 固定标签 / 标签休眠 / 拖出成新窗口 | ⛔ | 非目标（#12 的拖拽排序只做同窗口内排序） |
| 35 | 页面内查找 ⌘F / 缩放 / 打印 | ⛔ | 非目标（真要做：`findInPage` / `setZoomLevel` / `print`） |

> **一句话总结**：#18–#25 这套「网页自己开标签」的语义**已经和 Chrome 一致**（除了 #20、#25、#28 三处记录在案的偏离）；#1–#17 是标签条的手感，其中图标/标题/滚动/关闭/加载**已经做了**，还差**右键菜单、中键关、拖拽排序、有声图标、快捷键、地址栏**；真正**做不了**的只有 #27（Electron 没有 popup blocker，只能自己包 `window.open` 且会改页面环境）。

### 非目标（明确不做）

- 书签、历史记录、下载管理、密码管理、同步
- Chrome 扩展（`chrome.tabs` 等）——我们的插件体系是自己的 `PluginHost`
- 标签拖拽到窗口外（拆窗口）、标签组、标签休眠/丢弃
- 多窗口（阶段 3 之前）

> ⚠️ **PRD 需要同步改**：`docs/PRD.md` §3.2 非目标里写了「多窗口、多标签的完整商业浏览器功能」。这句话现在会挡住实现。要改成「不做**完整商业浏览器**功能（书签/历史/同步/多窗口）；标签页是必需的，因为网页会自己开新标签，不支持就等于行为与浏览器不一致」。

---

## 2. 参考项目是怎么做的（逐点）

### 2.1 它的分层

```
Browser（全局，main.js:104）
 └─ windows: TabbedBrowserWindow[]      ← 一个 OS 窗口
     ├─ this.window = BrowserWindow     ← 窗口本体
     ├─ this.webContents = 窗口的 webContents → 加载 webui.html（标签条 + 工具栏 UI）
     └─ this.tabs = Tabs(this.window)   ← 该窗口的标签集合
         └─ Tab = WebContentsView       ← 页面本体
```

关键点：**它的标签条 UI 和页面在同一个 OS 窗口里，但分属两个 webContents**（UI 是一个 webui 扩展页，页面是 `WebContentsView`）。

### 2.2 `Tabs` / `Tab`（`packages/shell/browser/tabs.js`，153 行，MIT）

| 做法 | 我们是否照抄 |
|---|---|
| `Tab` 持有一个 `WebContentsView`，自己 `addChildView` 到窗口 | ✅ 抄 |
| `Tab.show()/hide()` 用 `view.setVisible()` | ✅ 抄 |
| `invalidateLayout()` 硬编码 `toolbarHeight = 64` + `padding = 4`，监听窗口 `resize` 重算 bounds | ❌ **不要**。我们的 viewport 是渲染层用 `ResizeObserver` 实测矩形推给主进程的（`App.tsx`），加了标签条后矩形自动变小，主进程不需要知道任何 UI 高度 |
| `new WebContentsView(wcvOpts)` 前删掉 falsy 的 `webContents` / `webPreferences` | ✅ 必须抄（`window.open` 的 background-tab 场景 `opts.webContents` 是 undefined） |
| `destroy()`：先 `hide()` → `removeChildView` → `closeDevTools` → `webContents.emit('destroyed')` → `destroy()` | ✅ 抄（注意它注释里写 "TODO: why is this no longer called?"，说明 `destroyed` 事件得手动补发） |
| `Tabs.remove()`：删掉当前选中标签时选**右边邻居，没有就选左边** | ✅ 抄（这就是 Chrome 的语义） |
| `Tabs.remove()`：删到最后一个标签时 `this.destroy()`（销毁整个窗口） | ✅ 抄语义：关掉最后一个标签 = 停掉该 Environment |
| `Tabs.create()`：创建后立即 `tab.show()` 并 `select()` | ✅ 抄（view 必须真的可见，否则同步 `window.open` 会卡住主进程） |

### 2.3 新窗口接线（`packages/shell/browser/main.js:334`）

```js
webContents.setWindowOpenHandler((details) => {
  switch (details.disposition) {
    case 'foreground-tab':
    case 'background-tab':
    case 'new-window':
      return { action: 'allow', outlivesOpener: true,
        createWindow: ({ webContents: guest, webPreferences }) => {
          const win = this.getWindowFromWebContents(webContents)
          const tab = win.tabs.create({ webContents: guest, webPreferences })
          tab.loadURL(details.url)          // ← 必须自己导航
          return tab.webContents
        } }
    default:
      return { action: 'allow' }            // ← 唯一没做映射的分支：交给 Electron 开原生窗口
  }
})
```

它装在 `app.on('web-contents-created')` 里，也就是**每个新建的 webContents 都装一次**（包括标签自己）。我们只需要装在自己创建的 tab 上。

`getParentWindowOfTab()` 按 `tab.getType()` 分 `window` / `browserView` / `webview` / `backgroundPage` 去找父窗口——**我们不需要**：我们只有一个窗口，所有标签都是 `WebContentsView`。

### 2.4 标签条 UI（`packages/shell/browser/ui/webui.js`）

它的 UI **不读自己的 `Tabs` 对象**，而是订阅 `chrome.tabs.onCreated/onActivated/onUpdated/onRemoved` 事件后渲染。所以 UI 状态和标签状态是两条路。

我们反过来：**UI 状态从 `Environment.tabs` 来**（`env.list()` 已经带回来），走我们自己的 IPC，不需要扩展 API。它那套 UI 逻辑可以直接借鉴的有：

- `onUpdated` → `Object.assign(tab, details)` → 重渲染 + 若是 active 就刷新地址栏
- favicon 用 `img.onload/onerror` 判断能否显示（避免裂图）
- `audible` 显示音量按钮，`disabled = !tab.audible`
- 关闭按钮独立于标签点击（`stopPropagation`）

### 2.5 它**没有**做的（所以别指望抄）

- 弹窗拦截（popup blocker）——完全没有
- `disposition === 'default'` 的映射
- 标签持久化 / 会话恢复 / 标签丢弃
- 应用菜单里的标签快捷键（`menu.js` 只有 reload / devtools / zoom，没有 ⌘T/⌘W）
- 多窗口之外的窗口管理

### 2.6 它的扩展 popup（`electron-chrome-extensions/src/browser/popup.ts`）

扩展的 browserAction 弹层是**独立无边框 `BrowserWindow`**，用 `enablePreferredSizeMode` + `preferred-size-changed` 自适应尺寸，靠 `blur` 关闭。

我们**不需要**（没有 Chrome 扩展）。但如果阶段 3 做「真·多窗口」，它的 `updatePosition()`（把锚点矩形换算成屏幕坐标）和 `maybeClose()`（DevTools 打开时不关、焦点在应用外时不关）是现成参考。

---

## 3. 现状（我们的代码）

### 3.1 数据结构：一个 Environment 一个 view

```ts
// src/main/environments.ts:23
#views = new Map<string, WebContentsView>();      // envId -> 唯一页面
#controllers = new Map<string, BrowserController>();  // envId -> CDP 控制层
#shields = new Map<string, InputShield>();        // envId -> 输入遮罩
#leases = new Map<string, LeaseHandle>();
#viewport = { x, y, width, height };              // 渲染层实测推过来
#selected?: string;
```

### 3.2 关键方法（都要动）

| 方法 | 现在做什么 | 多标签下要变成 |
|---|---|---|
| `start(id)` | 建 session → 建 1 个 `WebContentsView` → 建 controller → 挂遥测 → `navigate(startUrl)` → `select(id)` | 建 session → 建 **TabManager** → 装 `setWindowOpenHandler` → 开第一个标签（`startUrl`）→ `select(id)` |
| `stop(id)` | `controller.detach()` → shield 拆 → 遥测拆 → `removeChildView` → `webContents.close()` | `tabs.destroy()`（销毁所有标签 + 所有 controller）→ shield 拆 → 遥测拆 |
| `select(id)` | 把该 env 的 view `addChildView` + `setBounds` | 把该 env 的 **active tab** 的 view `addChildView` + `setBounds`，然后 `#syncShield` |
| `setViewport(v)` | `view.setBounds(v)` + shield bounds | `tabs.setViewport(v)` + shield bounds |
| `#syncShield(id)` | `addChildView(shield)` / `removeChildView` | 不变（但要保证 shield 在所有 tab view **之后** add） |
| `controllerFor(id)` | 返回该 env 的 controller | **签名不变**，内部改成返回 active tab 的 controller |
| `navState` / `humanNavigate` | 作用于该 env 的 controller | 不变（内部跟着 active tab 走） |
| `#decorate(env)` | `currentUrl` / `title` 来自 controller + view | 来自 **active tab**；另外带上 `tabs` / `activeTabId` |

**关键设计**：`controllerFor(id)` 保持签名不变，多标签的实现藏在内部 —— 这样 `rpc.ts` 里十几处 `this.#manager.controllerFor(id)` 一行都不用改。

### 3.3 `browser-control.ts`（CDP 层）

```ts
constructor(wc: WebContents)   // 绑定一个 webContents，全程用它
attach() / detach()            // debugger.attach('1.3')
navigate / snapshot / click / fill / press / screenshot / waitFor
navigationState() / goBack() / goForward() / reload() / title() / currentUrl()
```

它是 **per-webContents** 的，天生适合"每个标签一个 controller"。**切标签时必须换 controller**，否则 `webContents.debugger` 会一直挂在旧标签上，agent 的 `snapshot` 会读到上一个页面。

设计：`#controllers: Map<tabId, BrowserController>`（tabId 全局唯一，所以不需要按 env 再分一层），懒创建，tab 关闭时 `detach()` 并从 map 删除。

### 3.4 `telemetry.ts`（这里有个真坑）

```ts
attach(id: string /* envId */, webContents, session) {
  webContents.on('console-message', ...)                      // 按 envId 记
  session.webRequest.onCompleted({ urls: ['<all_urls>'] }, cb) // 按 session 注册
}
detach(session) { session.webRequest.onCompleted(null) }        // 清掉整个 session 的监听
```

Electron 官方文档（`docs/api/web-request.md`）原文：

> ⚠️ Only the last attached `listener` will be used. Passing `null` as `listener` will unsubscribe from the event.

也就是说 **`session.webRequest.onCompleted` 每个 session 只能有一个监听器，后注册的覆盖先注册的**。现在一个 env 一个 session 一个 view，所以侥幸没事。一个 env 多个标签时：

- 第二个标签 `attach` 会把第一个标签的监听覆盖掉 → 第一个标签的网络请求全部丢失
- 任何一个标签 detach 都会 `onCompleted(null)` 把整个 session 的监听清空

**必须改成**：每个 session 只注册一次，回调里用 `details.webContentsId` 反查 tabId 再记录。移除时按 tab 移除映射，最后一个 tab 走的时候才解绑 session。

### 3.5 `input-shield.ts`

遮罩是"盖住 viewport 矩形的一个原生 `WebContentsView`"，**和标签无关**，不用改。但 z-order 有个约束：`addChildView` 是**后加的在上面**，所以每次把 tab view 放进 contentView 之后，如果 shield 是 attached 状态，必须重新 `addChildView(shield.view)` 或者先 detach 再 attach。现有 `select()` 的顺序（移除旧的 → add view → `#syncShield`）是对的，切标签要复用同一套顺序。

### 3.6 渲染层

- `App.tsx`：`stageRef` 上用 `ResizeObserver` 实测矩形 → `envApi.setViewport(rect)`。**加了标签条之后这个矩形自动变小**，主进程不用改。
- `App.tsx`：console/network/nav 每 1500ms 轮询一次。
- `environment-stage.tsx`：`header`（环境名 / URL / 接管按钮）→ `stageRef` 占位 div → 底部 `Tabs`（事件 / 快照 / Console / Network）。
- 标签条应该插在 `header` 和 `stageRef` 之间。

### 3.7 CLI / RPC

- `bin/warren.mjs`：`env` / `group` / `browser` / `exec` / `plugin` / `vault` 命令族。`exec <env> [--lease=]` 从 stdin 读脚本，`makePage(envId, leaseId)` 造出 `page` 对象（`goto/snapshot/click/fill/press/getByRole/...`）。
- `rpc.ts`：方法名是 `env.*` / `group.*` / `browser.*` / `vault.*` / `plugin.*` / `debug.*`。

---

## 4. 三个决策

### 决策 1：`new-window` 收敛成标签（阶段 1），真窗口留到阶段 3

**决定**：`foreground-tab` / `background-tab` / `new-window` **一律开成该 Environment 的新标签**。`new-window` 时把 `details.features` 里的尺寸信息记进事件（`tab.opened` 事件里带 `collapsedFromPopup: true`），方便排查。

**理由**：

1. 我们的产品模型是「一个 Environment = 右侧一块区域」。真开 OS 窗口会打破它：新窗口不在右侧区域里，**遮罩盖不住**（agent 持 lease 时人可以在弹窗里操作页面，lease 形同虚设），也不在 viewport 内，`stop(env)` 的清理路径也要多一套窗口注册表。
2. 页面能观察到的东西里，真正影响功能的部分在标签里**全部成立**：`window.open()` 仍然返回可用的 WindowProxy、具名窗口复用照旧、`window.opener` 关系保留、`postMessage` 通、`window.close()` 能关（已实测，见 §10 #12）。唯一不一致的是 `window.innerWidth/Height`（弹窗请求 600×700，标签是整块区域）。
3. 代价明确：Shift+点击在真 Chrome 里开新窗口，我们开新标签。**这是记录在案的偏离**，不是疏漏。

**阶段 3 做真窗口时要补的**：Environment 级窗口注册表、窗口关闭时回收、弹窗是否受遮罩约束的产品决定、`stop(env)` 关全部窗口。

### 决策 2：弹窗拦截实现，但**默认关闭**，按 Environment 开关（阶段 3）

**背景**：Electron **完全没有** popup blocker。实测：`setTimeout` 里、`await` 之后调用的 `window.open`（无用户手势）照样开标签。Chrome 会拦掉并返回 `null`。

**决定**：实现，但做成 `Environment` 上的开关 `popupBlocker: boolean`，**默认 `false`**。

**理由**：

- 拦截的实现必须改页面环境：在 tab 上挂一个 preload，包一层 `window.open` 记录 `navigator.userActivation.isActive`，用 `ipcRenderer.sendSync` 把标记同步送给主进程（`setWindowOpenHandler` 必须同步返回，只能这么传）。包了 `window.open` 之后，`window.open.toString()` 不再等于原生实现 —— 对"开发自己的网页"这个主用途来说，**改页面环境比偶尔多一个弹窗更糟**。
- 主要用户是拿它看自己的开发页。开发页的弹窗通常是自己要看的（OAuth 兜底、调试面板），拦掉反而碍事。
- 真正需要拦的是公网页面（广告、埋点），那时用户会主动开这个开关。
- 只在 `window.open` 这一条路上生效；`target="_blank"` 链接点击天然带用户手势，本来就不该拦。

**开关打开后的语义**（与 Chrome 对齐）：非用户手势 → `{ action: 'deny' }`，`window.open()` 返回 `null`，并记一条 `popup.blocked` 事件。

### 决策 3：Agent 默认作用于**当前激活标签**，`--tab` 可显式寻址

**决定**：

- `warren exec <env>` / `warren browser * <env>` 默认作用于该 Environment 的 active tab。
- 新增 `--tab <序号|tabId>` 显式寻址（序号 1-based，和 ⌘1..9 一致）。
- 新增 `tab` 命令族：`warren tab list|new|select|close <env> [...]`。
- `page` 对象新增 `tabs()` / `newTab(url)` / `selectTab(n)`。
- 每次写操作的事件里**记录实际作用的 tabId**，事后可追溯。

**理由**：

- 这不是"隐式当前环境"那种坏设计。PRD 的第一条核心原则就是「AI 和人看到、操作的是**同一个 Environment 和同一个页面实例**」——默认 active tab 正是这条原则的实现：人正在看哪一页，agent 就在操作哪一页。
- 强制要求 `--tab` 会让最常见的用法（agent 看当前页）变得啰嗦，而 agent 在上下文压缩后也记不住自己上次用的 tabId。
- 但要给 agent 一个**显式**的逃生口（`--tab` / `tab select`），并且在事件里留痕，这样并行调用出问题时能查。

**`tab.new` 的激活语义**：默认激活（和 Chrome 的 `foreground-tab` 一致），`--background` 可切。理由同上：人看得见 agent 在开什么。

---

## 5. 目标模型

```
Environment（= 一个隔离单元）
├─ Session（storagePath，独立 Cookie / localStorage / 代理）
├─ Lease（写权限，env 级，不按标签分）
├─ 标签列表（共用上面那个 Session）
│   ├─ Tab #1（WebContentsView + 自己的 BrowserController）
│   ├─ Tab #2  ← active
│   └─ Tab #3
├─ TabManager（该 env 的标签集合 + active 指针）
└─ InputShield（env 级，盖整个右侧区域，不分标签）
```

**归属规则（写死在文档里，以后别改）**：

| 东西 | 归属 | 理由 |
|---|---|---|
| Session / 代理 / 登录态 | Environment | 隔离的核心 |
| Lease / 控制权 | Environment | 人接管的是"这个环境"，不是某一页 |
| 遮罩 | Environment | 它盖的是右侧区域矩形，不是某个 view |
| CDP controller | Tab | 一个 webContents 一个 debugger |
| Console / Network 缓冲 | Tab（读取时按 env 聚合） | 页面级数据 |
| 标签顺序 / active | TabManager | |

---

## 6. 数据模型与类型

### 6.1 `src/shared/types.ts` 新增

```ts
/** 标签的运行态。跨 IPC 边界，所以放 shared。 */
export interface TabState {
  id: string;            // 稳定 id（crypto.randomUUID），不用 webContents.id
  title: string;
  url: string;
  favicon?: string;
  loading: boolean;
  audible: boolean;
  /** 页面是否阻止了关闭（beforeunload） */
  blockedFromClosing?: boolean;
  createdAt: string;
}

/** 标签寻址：1-based 序号或 tabId。CLI / IPC / UI 共用。 */
export type TabRef = number | string;

export interface Environment {
  // ...现有字段
  /** 只在 running 时有值 */
  tabs?: TabState[];
  activeTabId?: string;
}
```

`Environment.currentUrl` / `title` **保留**，语义收紧为"active tab 的 url / title"（渲染层和 CLI 的既有格式化代码不用改）。

### 6.2 `src/main/domain/tabs.ts`（新，纯逻辑，可单测）

不 import electron，只做状态机：

```ts
export interface TabRecord { id: string; title: string; url: string; favicon?: string;
  loading: boolean; audible: boolean; createdAt: string }

export class TabList {
  add(tab: TabRecord, opts: { activate: boolean }): void
  /** 返回下一步该激活谁；empty=true 表示最后一个标签被关掉了 */
  remove(id: string): { nextActiveId?: string; empty: boolean }
  select(id: string): boolean
  update(id: string, patch: Partial<TabRecord>): void
  reorder(orderedIds: string[]): void
  resolve(ref: TabRef): string | undefined   // 序号 / id -> id
  get activeId(): string | undefined
  get list(): TabRecord[]
  indexOf(id: string): number
}
```

要写死的行为（对应 Chrome）：

1. `add(activate: true)` → 新标签变成 active；`activate: false` → active 不变。
2. `remove(activeId)` → 选**右边邻居**，没有就选**左边**；都没有 → `empty: true`。
3. `remove(非 active)` → active 不变。
4. `remove(不存在)` → 幂等，不改任何东西。
5. `resolve(n)`：1-based 序号；越界返回 `undefined`（不抛，调用方给 `TAB_NOT_FOUND`）。

### 6.3 `src/main/tabs.ts`（新，Electron 绑定）

```ts
class Tab {
  readonly id: string;
  readonly view: WebContentsView;
  constructor(id, opts: { session: Session; webContents?: WebContents; url?: string })
  loadURL(url): Promise<void>
  show() / hide() / setBounds(b) / destroy()
}

class TabManager {
  constructor(opts: {
    envId: string;
    window: BrowserWindow;
    session: Session;
    onOpenRequest: (details) => ...   // 由 EnvironmentManager 注入分流逻辑
    onTabsChanged: () => void;
    onEmpty: () => void;              // 最后一个标签关掉 -> 停环境
    createController: (wc: WebContents) => BrowserController;
  })
  create(opts?: { url?: string; activate?: boolean; webContents?: WebContents; webPreferences? }): Tab
  select(ref: TabRef): Tab
  close(ref: TabRef): void
  setViewport(bounds): void
  attach(window) / detach(window)
  list(): TabState[]
  active(): Tab | undefined
  controller(): BrowserController | undefined
  destroy(): void
}
```

`TabManager` 是**创建 view 的唯一入口**，`setWindowOpenHandler` 也在这里装（每个 tab 的 webContents 都装）。

**可测性**：`TabManager` 依赖的 Electron 对象通过构造参数注入，纯状态机在 `domain/tabs.ts`。`tests/tabs.test.ts` 只测 `TabList`。

---

## 7. 主进程改动清单

### 7.1 `src/main/environments.ts`（主改）

| 改动 | 说明 |
|---|---|
| `#views: Map<string, WebContentsView>` → `#tabs: Map<string, TabManager>` | 唯一结构变化 |
| `#controllers` → `Map<string /* tabId */, BrowserController>` | 按 tab 索引，全局唯一 |
| `start()` | 建 TabManager；装分流；开第一个标签；`select(id)` |
| `stop()` | `tabs.destroy()`（内部销毁所有 controller） |
| `select(id)` | 走 `tabs.attach(window)`，再 `#syncShield(id)` |
| `setViewport(v)` | `tabs.setViewport(v)` + shield bounds |
| `#syncShield(id)` | 不变 |
| `controllerFor(id, ref?)` | 返回指定/active 标签的 controller |
| `navState(id)` / `humanNavigate(id, action)` | 走 active 标签 |
| `#decorate(env)` | `tabs` / `activeTabId` / `currentUrl` / `title` 来自 active 标签 |
| 新增 `tabsOf(id)` / `newTab(id, url?, opts?)` / `selectTab(id, ref)` / `closeTab(id, ref)` | 供 IPC 与 RPC |
| `#handleWindowOpen(envId, details)` | **分流逻辑集中在这里**（见 §7.2） |

### 7.2 新窗口分流（核心，已按实测定稿）

**实测确定的分流表**（Electron 44.7 / macOS，真实鼠标手势 + 本地 http 站点，见 §14）：

| 页面动作 | `disposition` | 我们的动作 | 和 Chrome 一致？ |
|---|---|---|---|
| `<a target="_blank">` 左键 | `foreground-tab` | 新标签 + 激活 | ✅ |
| ⌘/Ctrl + 点击、中键 | `background-tab` | 新标签 + 不激活 | ✅ |
| Shift + 点击 | `new-window` | 新标签 + 激活（**偏离**，见决策 1） | ⚠️ |
| `window.open(url)` | `foreground-tab` | 新标签 + 激活 | ✅ |
| `window.open(url,'_blank','width=..')` | `new-window` | 新标签（**偏离**），事件带 `collapsedFromPopup` | ⚠️ |
| `window.open(url,'name')` 第二次 / `<a target="name">` | **不进 handler** | 什么都不用做，Electron 自己复用那个 guest 并导航 | ✅ |
| `window.open(url,'_self' / '_parent' / '_top')` | **不进 handler** | 什么都不用做，Electron 自己原地导航 | ✅ |
| `<a href="/dl" target="_blank">`（`Content-Disposition: attachment`） | `foreground-tab`（**不是** `save-to-disk`） | 新标签 | ✅ |
| 无用户手势的 `window.open` | `foreground-tab` | 默认也开标签（**偏离**，见决策 2） | ⚠️ |

```ts
// 每个 tab 的 webContents 上装。注意：只有下面三档会真的进来。
wc.setWindowOpenHandler((details) => {
  switch (details.disposition) {
    case 'foreground-tab':
    case 'background-tab':
    case 'new-window': {
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: (opts) => {
          const tab = manager.create({
            webContents: opts.webContents,     // background-tab / new-window 时可能是 undefined
            webPreferences: opts.webPreferences,
            url: details.url,                  // 必须自己导航（见 §10 坑 4）
            activate: details.disposition !== 'background-tab',
          });
          store.record(makeEvent('tab.opened',
            `${details.disposition} → tab ${tab.id}` + (details.disposition === 'new-window' ? ' (popup 收敛成标签)' : ''),
            'system', envId));
          return tab.view.webContents;
        },
      };
    }
    default:
      // 实测这两档到不了这里（见上表）。纯防御：deny，绝不让页面开出不受 Environment 管控的原生窗口。
      store.record(makeEvent('popup.denied', `${details.disposition} ${details.url}`, 'system', envId));
      return { action: 'deny' };
  }
})
```

**为什么兜底分支不用纠结**（实测 + 源码双重确认）：

- `default` = Chromium 的 `CURRENT_TAB`（源码 `Converter<WindowOpenDisposition>`）。而 Electron 的 `WebContents::OpenURLFromTab` 对 `CURRENT_TAB` 有提前返回：自己 `LoadURLParams` 原地导航，**不 emit 事件、不调 handler**。实测 `window.open('/next','_self')` → `handlerCalls=0` 且页面 URL 变了。所以 `default` 根本进不来。
- `other` = `UNKNOWN` / `SUPPRESS_OPEN` / `SINGLETON_TAB` / `OFF_THE_RECORD` / `IGNORE_ACTION`。`SUPPRESS_OPEN` 是 Chromium 弹窗拦截器用的，而 Electron 不实现拦截器，所以也不会出现。
- `save-to-disk` 在源码里存在但**官方文档没写**，实测 `<a download target=_blank>` 给的是 `foreground-tab`。真出现就 `deny`，让下载走 Electron 自己的 `will-download` 通道（下载和窗口创建本来就是两条路）。
- **具名窗口复用不需要我们做**：`window.open(u,'name')` 第二次和 `<a target="name">` 都**不再触发 handler**，Electron 直接复用我们上次返回的那个 guest 并导航它，`window.open` 返回同一个 WindowProxy。所以我们**不要**自己维护 `frameName → tab` 的映射。


### 7.3 `src/main/telemetry.ts`

| 改动 | 说明 |
|---|---|
| 记录键：`envId` → `tabId` | `#console: Map<tabId, Entry[]>` / `#network: Map<tabId, Entry[]>` |
| 新增 `#tabToEnv: Map<tabId, envId>`、`#wcToTab: Map<number, tabId>` | 反查用 |
| `attachTab(envId, tabId, wc)` | 只挂 `console-message` |
| `attachSession(envId, session)` | 每个 session **只注册一次** `webRequest.onCompleted`；回调里 `details.webContentsId` → `#wcToTab` → tabId，记到对应 tab |
| `detachTab(tabId)` | 删映射 + 缓冲；该 env 无 tab 时才 `detachSession` |
| 读取：`consoleEntries(envId)` / `networkEntries(envId)` | 聚合该 env 所有 tab（按时间排序） |

### 7.4 `src/main/input-shield.ts`

不改。只在 `TabManager.attach()` / `select()` 里保证 shield 在 tab view 之后 `addChildView`。

### 7.5 `src/main/main.ts`

新增 IPC handler（和现有 `handle()` 同一套，带 sender 校验）：

```
tab:list     (envId) -> TabState[]
tab:create   (envId, url?) -> TabState
tab:select   (envId, ref) -> TabState
tab:close    (envId, ref) -> void
```

### 7.6 `src/main/rpc.ts`

新增方法（`tab.*`），`browser.*` 全部接受可选 `tabId`：

```
tab.list   { id } -> TabState[]
tab.new    { id, url?, background? } -> TabState
tab.select { id, ref } -> TabState
tab.close  { id, ref } -> { ok: true }
```

### 7.7 `src/main/menu.ts`（新，阶段 2）

快捷键。现在 warren **没有**应用菜单，需要新建并用 `Menu.setApplicationMenu()`：

| 快捷键 | 动作 |
|---|---|
| ⌘T | 当前 Environment 新标签 |
| ⌘W | 关当前标签（最后一个 → 停环境） |
| ⌘1..9 | 切到第 N 个标签 |
| ⌘R / ⌘⇧R | 刷新 / 强制刷新（active 标签） |
| ⌘L | 聚焦地址栏（如果做地址栏） |

注意：页面有焦点时，应用菜单的 accelerator 在 macOS 上优先于页面 —— 这正是我们要的（和 Chrome 一致）。同时给 tab 的 webContents 加 `before-input-event` 兜底，防止某些页面吞掉按键。

---

## 8. 渲染层改动

### 8.1 新增 `src/renderer/features/environments/environment-tabstrip.tsx`

- 位置：`environment-stage.tsx` 里 `header` 之下、`stageRef` 占位 div 之上。
- 内容：每个标签 = favicon（`img` + `onError` 隐藏）/ spinner（loading）/ title（截断）/ 音量图标（audible）/ 关闭按钮（`✕`，`stopPropagation`）；末尾 `+` 新建按钮。
- active 高亮；横向滚动（标签多了不能挤爆布局）。
- 中键点击 = 关闭（阶段 2）。
- 右键菜单（阶段 2）：新建标签 / 复制 URL / 关闭 / 关闭其他。
- **不要**直接套 `ui/tabs.tsx`（Radix Tabs）：它的 trigger 是 ARIA tab 语义，不适合可关闭、可滚动的浏览器标签条。用 `ui/` 里的 `Button` / `ContextMenu` 拼，样式只改 `ui/` 下的组件。

### 8.2 `environment-stage.tsx`

- 插入 `<EnvironmentTabstrip />`。
- 其余不变（`stageRef` 的矩形自动变小）。

### 8.3 `App.tsx`

- `current.tabs` / `current.activeTabId` 来自 `env.list()`，不用新状态。
- 新增回调：`onTabSelect(ref)` / `onTabClose(ref)` / `onTabCreate()` → `window.envApi.*`。
- 轮询那段（console/network/nav）不变，但 `navState` 现在跟着 active tab 走 —— 切标签后下一次轮询（≤1.5s）就对了。可以顺手在 `onTabSelect` 后立刻 `pull()` 一次，避免视觉延迟。

### 8.4 `preload.ts` / `lib/ipc.ts` / `shared/types.ts`

按 §6.1、§7.5 补齐 `EnvApi` 的四个 tab 方法。

---

## 9. CLI 改动（`bin/warren.mjs`）

```
warren tab list   <env>                     # 序号 / tabId / active / title / url
warren tab new    <env> [url] [--background]
warren tab select <env> <n|tabId>
warren tab close  <env> <n|tabId>

warren exec <env> [--lease=] [--tab=<n|tabId>] < script.js
```

`makePage(environmentId, leaseId, tabRef)` 增加：

```js
tabs:      () => read('tab.list'),
newTab:    (url) => read('tab.new', { url }),
selectTab: (ref) => read('tab.select', { ref }),
closeTab:  (ref) => read('tab.close', { ref }),
```

`page` 里其余方法（`goto` / `snapshot` / `click` / …）把 `tabId` 一起带进参数。

---

## 10. 坑（实测 + 文档确认 + 待实测）

### 实测结论（Electron 44.7 / macOS）

| # | 事实 | 后果 |
|---|---|---|
| 1 | `setWindowOpenHandler` 必须**同步**返回 | 想"问一下再决定"必须先同步开占位标签 |
| 2 | `createWindow` 里**必须复用** `opts.webContents`；自己 `new WebContentsView()` 再返回 → 页面的 `window.open()` 把**整个主进程卡死**（连兜底定时器都不跑） | 参考项目 `tabs.js:12` 那两行 delete 就是这个坑的补丁 |
| 3 | `background-tab` / `new-window` 时 **`opts.webContents` 可能是 `undefined`**（官方文档明说 creation can be deferred） | 必须自建 view 并手动 `loadURL(details.url)`；不处理 → 同样死锁 |
| 4 | `createWindow` 返回的 guest **不会自动导航**（实测 guest URL 为空） | 必须自己 `loadURL(details.url)` |
| 5 | Electron **没有弹窗拦截**：无用户手势的 `window.open` 照样开 | 见决策 2 |
| 6 | `disposition` 与 Chrome 完全一致（foreground/background-tab、new-window、⌘点击、中键、Shift 点击） | 分流可以直接按它做 |
| 7 | 没有任何 handler 时，`target="_blank"` 会**静默开出游离原生窗口**（实测 `handlerCalls=0`，窗口数 1、webContents 数 2） | 这就是我们现在的问题，见 §11 |
| 8 | **agent 走 CDP 触发 `window.open` 不会死锁**：`debugger.attach()` + `Runtime.evaluate("window.open(...)")` 正常返回 `{type:'object'}`，handler 被调用一次 | `browser-control.ts` 不需要为它加规避 |
| 9 | `session.webRequest` 每个 session **只有一个监听器**（官方文档） | §3.4 必须改 |
| 10 | `window.open(u,'_self'/'_parent'/'_top')` **不进 handler**，Electron 自己原地导航（`will-navigate` 触发、URL 变了） | §7.2 兜底分支不会命中 |
| 11 | 具名窗口复用**不进 handler**，Electron 自己复用 guest 并导航，`window.open` 返回同一个 WindowProxy | 不要自己维护 `frameName → tab` 映射 |
| 12 | **脚本打开的标签调 `window.close()` 会被真的销毁**：webContents 依次触发 `close` → `destroyed`，然后 `view.webContents` 变成 `undefined`。`event.preventDefault()` **无效**（`destroyed` 照样触发）。**主进程无死锁** | 必须把「页面自己关掉」当成「标签被关闭」：在 `destroyed` 里从 TabManager 移除该 tab 并**丢弃 view**（之后不能再碰 `view.webContents`，否则 TypeError） |
| 13 | 普通标签（非脚本打开）调 `window.close()` **被忽略**，无任何事件 | 和 Chrome 一致（Chrome 也是只允许关脚本打开的窗口） |
| 14 | `<a href="/dl" target="_blank">`（服务端 `Content-Disposition: attachment`）给的仍是 `foreground-tab`，不是 `save-to-disk` | 下载场景不需要特判 |
| 15 | Electron 有**未文档化**的 `webPreferences.disablePopups`（`<webview allowpopups>` 用的）：在 `CanCreateWindow` 里直接 `return false` | 它是**全拦**（连用户手势的 popup 也拦），不是 Chrome 语义 → 不用它，见决策 2 |

> ⚠️ 勘误：本文档早期版本写过「页面调 `window.close()` 会把主进程卡住」。**那是错的** —— 那是 harness 在 `destroyed` 之后访问 `view.webContents` 抛 TypeError 导致进程空转，不是死锁。已按 #12 修正。

### 实现阶段发现并修掉的（代码里看不出来，实测才能撞到）

| # | 现象 | 原因 | 修法 |
|---|---|---|---|
| A | 后台环境自己开标签时，它的视图会盖到当前显示的页面上 | `addChildView` 是后加的在上面，`#showActive()` 无条件往窗口里加视图 | `TabManager` 加 `#visible` 门控：没显示就绝不加视图。并给 `debug.layout` 加 `showing` 字段作为这条不变量的断言 |
| B | 对后台环境发输入：不报错、什么也没发生 | 视图没挂到窗口上时 Chromium 直接丢掉 CDP 输入事件 | 新增 `assertVisible()`：输入类 RPC（click/fill/press）显式报 `ENV_NOT_VISIBLE`。导航/读取不受影响 |
| C | 持 t1 的 lease 时切到 t2，遮罩跟着盖到 t2 页面上 | `#syncShield` 没有判断是否当前选中 | 只在 `#selected === id` 时挂遮罩；`select()` 改用 `shield.detach()` 而不是裸 `removeChildView` |
| D | 关掉最后一个标签后，环境停了但 lease 还挂 60s | `stop()` 不清 lease | `stop()` 里 `#leases.delete(id)` |
| E | 输入类实测经常“点了没反应” | 窗口被别的窗口盖住时 `visibilityState=hidden`，Chromium 丢掉输入 | `debug.focusWindow` 改成 `app.focus({steal:true})` + `show()` + `focus()`；实测前先确认 `visibilityState === 'visible'` |
| F | `warren tab list` 里当前标签显示成 `○` | `TabState` 里根本没有 `active` 字段，CLI 用了个不存在的字段 | `TabManager.list()/item()` 返回 `TabListItem = TabState & { active }` |

### 仍需实测（写代码时顺带验，不阻塞设计）

| # | 问题 | 为什么必须知道 | 怎么测 |
|---|---|---|---|
| 1 | ~~`outlivesOpener: true` 时关掉 opener 标签，被它 `window.open` 出来的标签会不会被一起销毁？~~ | — | **已实测（2026-10-14）：不连坐**。先关掉 opener，它 `window.open` 出来的标签照样活着 → 记为偏离（§13） |
| 2 | `beforeunload` 时 `webContents.close({ waitForBeforeUnload: true })` 的行为；`will-prevent-unload` 怎么反映到 UI | 关标签会丢未保存内容 | 造带 `beforeunload` 的页面，走 `tab close` |
| 3 | 切标签后重新 `debugger.attach()` 是否稳定（有没有 race、旧 attach 是否真的释放） | 决定 agent 的 CDP 能不能跨标签 | **已实测单轮（2026-10-14）**：切到 tab1 后 `snapshot` 拿到 tab1、默认拿到 active，不串页。**来回切 20 次的长循环没压过**，排阶段 2 顺带压 |

### 其他设计约束（写代码时必须守）

1. **`state:changed` 的刷新风暴**：`page-title-updated` / `did-start-loading` / `did-stop-loading` / `page-favicon-updated` / `did-navigate` 每个都会触发 `#onChange()` → 渲染层全量 `refresh()`（list + groups + events）。一个页面加载会触发十几次。`TabManager` 内部要对 `onTabsChanged` 做 **100ms 节流**。
2. **`BrowserController.navigate()` 的 30s 超时 + `did-stop-loading`**：多标签下每个 controller 独立，没问题；但 `navigate` 在后台标签上也会等 —— 这是对的（Chrome 后台标签也加载）。
3. **CDP attach 的资源**：`debugger.attach()` 会让页面进入"被调试"状态。现在只在第一次 CDP 调用时懒 attach（`#send` 里 `this.attach()`）。多标签下每个标签各自懒 attach，不要一次性全 attach。
4. **`domain/tabs.ts` 的 import 必须带 `.ts` 扩展名**：`node --test` 直接加载源文件，不走打包（`store.ts` 里已有这个注释和先例）。
5. **不要为了"标签"给 `WebContentsView` 加 preload**（阶段 1、2）。加了 preload 会改变页面环境（检测面），而 PRD 明确"第一版不做指纹伪装"，能不加就不加。决策 2 的拦截 preload 是唯一例外，且默认关。
6. **`window.close()` 与 view 生命周期**（实测 #12/#13）：
   - 页面 `window.close()` 会**真的销毁** webContents，触发 `close` → `destroyed`；`preventDefault()` 拦不住。
   - `destroyed` 之后 `view.webContents` 是 `undefined` —— **必须立刻把该 tab 从 TabManager 移除并丢弃 view**，任何后续访问都会 TypeError。
   - 所以 `TabManager` 要监听每个 tab 的 `destroyed`，走和用户点关闭按钮**完全相同**的移除路径（选中邻居、`empty` 判定）。
   - `tab.close()` 自己主动关标签时：先 `removeChildView` → `webContents.close()` → 在 `destroyed` 里清 map。不要在 `destroyed` 之后再去动 view。
   - 普通标签的 `window.close()` 被 Electron 忽略，不需要额外处理。

---

## 11. 分阶段实施

### 阶段 1：核心 —— ✅ 已完成并提交（`6c89c25`）

1. 阻塞性未知项已在调研阶段实测完毕（§10），直接开工。
2. `src/main/domain/tabs.ts` + `tests/tabs.test.ts`（纯逻辑，先绿）。
3. `src/main/tabs.ts`（Tab / TabManager）。
4. `src/main/environments.ts` 改造 + 分流逻辑。
5. `src/main/telemetry.ts` 改成按 tab（含 §3.4 的 session 监听修复）。
6. `src/main/main.ts` + `preload.ts` + `shared/types.ts` 的 tab IPC。
7. `src/main/rpc.ts` 的 `tab.*` + `browser.*` 的 `tabId`。
8. `bin/warren.mjs` 的 `tab` 命令族 + `exec --tab` + `page.tabs/newTab/selectTab/closeTab`。
9. 渲染层：`environment-tabstrip.tsx` + `environment-stage.tsx` + `App.tsx`。

**阶段 1 完成的标准**：§12 的验收清单全过。

### 阶段 2：浏览器手感（**2026-10-16 已全做完**，逐条实测记录见 HANDOFF §6「标签手感」）

按「用户能立刻感觉到」排序，前 6 条建议一个 commit 一个：

| # | 事项 | 落点 | 依赖 / 注意 |
|---|---|---|---|
| 2.1 | 标签右键菜单：重新加载 / 复制链接 / 关闭 / 关闭其他 / 关闭右侧 | `environment-tabstrip.tsx` + `components/ui/context-menu.tsx` | base-ui 坑：`Item` 用 `onClick`、`Label` 必须在 `Group` 里 |
| 2.2 | 中键关标签 | 同上，`onAuxClick` | 纯前端 |
| 2.3 | 快捷键 ⌘T / ⌘W / ⌘1..9 / ⌘R / ⌘L / ⌘⇧T | 新建 `src/main/menu.ts` + `Menu.setApplicationMenu` | 现在**没有任何应用菜单**。⌘⇧T 需要主进程的「最近关闭」栈 |
| 2.4 | 地址栏（可编辑，回车导航） | `environment-stage.tsx` 的 URL 区域 → input | 写操作要过 lease（`browser.navigate` 已要求） |
| 2.5 | 有声标签的喇叭图标 + 静音按钮 | tabstrip + `tab.mute` RPC | `audible` 已采集；静音用 `setAudioMuted` |
| 2.6 | 拖拽排序 | tabstrip + `tab.reorder` RPC | 领域层 `TabList.reorder()` 已写好，只差接线 |
| 2.7 | `+` 打开「新标签页」而不是 `about:blank` | `TabManager.create` 的默认 url | 给个内置静态页或退回 `startUrl` |
| 2.8 | `beforeunload` 关闭确认 | `TabManager.close` / `will-prevent-unload` | §10「仍需实测 2」还没验，先测再定语义 |
| 2.9 | 页面 HTML5 全屏在 `WebContentsView` 里的表现 | 实测 | §1.1 #29 |

### 阶段 3：按需（能不做就先不做，做之前要先决策）

| # | 事项 | 状态 | 前置决策 |
|---|---|---|---|
| 3.1 | 真·多窗口（`new-window` 不再收敛） | 能做，有产品冲突 | 新窗口不在右侧区域 → 遮罩盖不住；要不要允许？`stop(env)` 要不要关掉全部窗口？ |
| 3.2 | 弹窗拦截开关（决策 2） | 能做，代价明确 | 必须包 `window.open` → 改页面环境。默认关 |
| 3.3 | 标签持久化 / 会话恢复 | 能做 | 恢复时要不要顺带恢复 URL（含 POST 过的页面恢复不了） |
| 3.4 | 标签组 / 固定标签 / 休眠 / 拖出成窗口 | ⛔ 非目标 | — |

---

## 12. 验收标准

### 功能（手工，真实鼠标）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 开发页里 `<a target="_blank">` 左键 | 同一 Environment 新标签并切过去 |
| 2 | ⌘/Ctrl + 点击 | 同一 Environment 新标签，**不**切过去 |
| 3 | 中键点击 | 同上 |
| 4 | Shift + 点击 | 新标签（记录在案的偏离：Chrome 是新窗口） |
| 5 | 页面 `window.open(url)` | 新标签并切过去，返回值是可用 WindowProxy |
| 6 | 页面 `window.open(url,'_blank','width=400,height=300')` | 新标签（同上偏离），事件里带 `collapsedFromPopup` |
| 7 | 连续开 5 个标签，关掉 active | 选中右边邻居；关最右那个 → 选左边 |
| 8 | 关掉最后一个标签 | 该 Environment 变成 `stopped` |
| 9 | 在标签 A 登录，切到标签 B 访问同站点 | **已登录**（同一 session） |
| 10 | 标签 A 用代理 X，标签 B 也访问外网 | 出口 IP 相同（同一 Environment 代理） |

### Agent 侧（必须有实测输出）

| # | 命令 | 期望 |
|---|---|---|
| 1 | `warren tab list <env>` | 能看到 agent 自己开出来的标签 |
| 2 | `warren exec <env>` 里 `await page.snapshot()` | 拿到的是 **active tab** 的内容 |
| 3 | 切标签后立刻 `snapshot` | 拿到新标签的内容（验证 CDP 跟随，不串页） |
| 4 | `warren exec <env> --tab=2` 里 `page.snapshot()` | 拿到第 2 个标签的内容 |
| 5 | agent 持 lease 时切标签 | 遮罩仍在最上层（人点不动页面） |
| 6 | agent 脚本触发 `window.open` | 不死锁，新标签出现（已实测） |

### 单测（`node --test`）

- `tests/tabs.test.ts`：`TabList` 的 add/remove/select/reorder/resolve + 上面 5 条 Chrome 语义
- 现有测试（`environment.test.ts` / `store.test.ts` / `group.test.ts` / `vault.test.ts` / `plugin-manifest.test.ts`）必须继续绿

### 静态检查

- `npm run typecheck` 通过
- `npm test` 通过

---

## 13. 风险与偏离记录

| 项 | 类型 | 说明 |
|---|---|---|
| Shift+点击 / 带 features 的 `window.open` 开成标签而不是窗口 | **偏离**（决策 1） | 真 Chrome 是新窗口。理由见 §4.1；阶段 3 可补 |
| 无用户手势的 `window.open` 默认不拦 | **偏离**（决策 2，默认关） | 真 Chrome 会拦。开关打开后对齐；默认关是为了不改页面环境 |
| 弹窗尺寸请求（`width/height`）被忽略 | 偏离 | 标签是整块区域，页面的 `innerWidth` 比请求值大 |
| 不做标签持久化 | 缺失 | 重启后每个 Environment 只回到 `startUrl` |
| `disposition === 'default'` / `'other'` / `'save-to-disk'` | **已定** | 实测这三档都到不了 handler（`_self`/`_parent` 由 Electron 原地导航；具名窗口由 Electron 复用）。兜底分支只做防御性 `deny` + 记事件 |
| `window.close()` 语义 | **已定** | 脚本打开的标签能自关（`close`→`destroyed`，主进程无死锁），普通标签被忽略 —— 与 Chrome 一致。要求 TabManager 监听 `destroyed` 走统一移除路径（§10 约束 6） |
| agent 通过 CDP 触发 `window.open` | **已定** | 实测不死锁，`Runtime.evaluate` 正常返回。无需规避 |
| `session.webRequest` 单监听器 | 已识别 | §3.4 有明确修法 |
| `state:changed` 刷新风暴 | 已识别 | 100ms 节流 |
| **CDP 输入只对当前显示的环境生效** | **限制** | 后台环境的视图没挂到窗口上，输入会被 Chromium 丢掉。已改成显式 `ENV_NOT_VISIBLE`，不再静默失败；要真支持「后台环境也能被操作」得另想办法 |
| 不持久化标签 | 缺失 | 重启后每个 Environment 只回到 `startUrl`（阶段 3） |
| opener 关闭时**不**连坐关掉它 `window.open` 出来的标签 | **偏离** | Chrome 会连坐关掉脚本开的 popup。我们用了 `outlivesOpener: true`（实测子标签活着）。不跟的理由：我们的 popup 是正经标签，连坐关掉会误伤用户正在看的页面 |
| `<a download>` / `Content-Disposition: attachment` 会先开一个标签 | **偏离** | 实测 Electron 给的是 `foreground-tab` 而不是 `save-to-disk`。下载本身仍走 Electron 自己的通道；下载管理是非目标 |
| 标签图标必须是 data URL | 设计约束 | 渲染层 CSP 只允许 `img-src 'self' data:`，所以图标由主进程取好再转 data URL。别改回 `<img src="http://…">`（会被静默拦掉，症状是"所有标签都是地球"） |

---

## 14. 附：实测 harness

| 位置 | 用途 |
|---|---|
| `/tmp/etest/` | `main.js`（`HANDLER=allow\|none\|deny`、`CASE=A\|A2\|A3\|B\|C\|D\|E`）+ `page.html` + `cases.sh`（每用例独立进程 + 看门狗）。**文件页 + 隐藏窗口**也能量到输入事件 |
| `/tmp/etest3/` | 真实场景全套：本地 http 站点（`/`、`/next`、`/popup`、`/dl` 带 `Content-Disposition: attachment`）、真实鼠标手势、`_self`/`_parent`/具名窗口/下载、`window.close()`、CDP `Runtime.evaluate`。`run.sh <case...>`，`SHOWWIN=1` 显示窗口 |
| `/tmp/etest2/` | 早期 `window.close()` / `outlivesOpener` 骨架（**注意它的结论已被 etest3 取代**） |
| 跑法 | `cd /tmp/etest3 && SHOWWIN=1 ./run.sh self parent named namedlink download closebtn-user closebtn-script cdp` |
| Electron 二进制 | `<ELECTRON_BIN>`（独立于 warren 自带版本，避免和别的线程抢） |

两个必须记住的 harness 约定，否则会得出**错误结论**：

1. **每个用例一个独立 Electron 进程**。同步 `window.open` 的失败模式是「整个主进程卡住」，跑在一个进程里会互相污染。
2. **`sendInputEvent` 只在窗口真的 `show()`（并且等约 900ms 让渲染进程拿到可见性）之后才送达渲染进程**。隐藏窗口 + http 页面时事件会**静默丢弃**（实测：`document` 上一个 `mousedown` 都没收到，`handlerCalls=0`），看起来像"这个行为不发生"，实际是事件没送到。

第三个坑（差点让我写错结论）：**不要在 `destroyed` 之后再去访问 `view.webContents`** —— 它已经变成 `undefined`，抛出的 TypeError 会让主进程空转，看起来像"死锁"。

---

## 15. 复核记录（2026-10-14）：标签条的图标 / 标题 / Chrome 行为

复核方式：起真实实例，用本地站点（`/tmp/favtest`：PNG 图标页 / SVG 图标页 / 无图标页）+ `debug.rendererEval` 读 DOM + `tab list` 读状态。结论已并入 §1.1，这里只留证据与踩坑。

### 15.1 标题 —— 本来就是好的

`page-title-updated` → `TabState.title`，实测 `PNG Icon Page` / `Fixture Login` 都正确。**没改。**

### 15.2 图标 —— 之前**一个都显示不出来**，三个缺陷叠在一起

| 缺陷 | 现象 | 根因 | 修法 |
|---|---|---|---|
| A | 所有标签都是地球占位图，哪怕页面有 icon | 渲染层 CSP 是 `img-src 'self' data:`（`src/renderer/index.html`），`<img src="http://127.0.0.1:8901/icon.png">` 被**静默拦掉** → `onError` → 退回占位图 | 主进程用**环境自己的 session** `fetch()` 取图标 → `data:image/...;base64` 塞进 `TabState.favicon`（`src/main/tabs.ts` 的 `#loadFavicon` / `#fetchFavicon`）。顺带解决「要代理才连得上的站点取不到图标」和「图标请求从应用自己的出口发出去」 |
| B | 导航到别的页面后，标签还挂着上一页的图标 | `did-navigate` 只同步了 url | `sync({ url, favicon: undefined })` |
| C | 一个标签只要图标 404 过一次，之后**永远**是地球 | `Favicon` 组件的 `broken` state 挂在标签位置上，React 复用实例 | `<Favicon key={tab.favicon} …>`，换图标就重挂 |

**实测证据**（修复后）：

```
# 有 icon 的页 → 标签拿到 data URL
{"title":"PNG Icon Page","favicon":"data:image/png;base64,iVBORw0KGgoAAAANSU"}
# 渲染层真的画出来了
[{ label: "PNG Icon Page", img: "data:image/png;base64,iVBO" },
 { label: "Favicon Fixture", img: "data:image/svg+xml;base64," },
 { label: "No Icon Page",   img: "占位" }]        ← 无图标页正确退回地球
# 导航到无图标页 → 图标被清掉
{"title":"No Icon Page","favicon":"NONE(已清掉)"}
```

顺带记两个**差点写错结论**的坑：

1. **测 favicon 前先确认本地服务器还活着**。我用 `nohup … &` 起的 `python3 -m http.server` 随 shell 一起被杀，页面变成错误页 → `page-favicon-updated` 不触发 → 我一度得出「SVG/PNG 图标都取不到」的错误结论。`lsof -ti :8901` 是必查项。
2. **`page-favicon-updated` 会给一个"猜的" URL**：页面没有 `<link rel=icon>` 时，Electron 仍然报 `http://host/favicon.ico`，哪怕它 404。所以「有 favicon 字段」≠「图标能显示」，必须真去取一次。

### 15.3 其他 Chrome 行为

逐条结论见 §1.1。三个要点：

- ~~能立刻做、且是明显缺口的~~：右键菜单、中键关、拖拽排序、有声图标、快捷键、地址栏（§11 阶段 2.1–2.6）**2026-10-16 已全部落地**（外加 `⌘⇧T` 与内置新标签页）。
- **做不了的只有一条**：弹窗拦截。Electron 没有 popup blocker（源码 `ShouldDisablePopups()` 是全拦、不是 Chrome 语义；实测无手势 `window.open` 照样开），要做得自己包 `window.open`，代价是改页面环境 → §4 决策 2：默认关，排阶段 3。
- **三处记录在案的偏离**：Shift+点击/带 features 的 `window.open` 收敛成标签（#20）、opener 关闭不连坐关掉子标签（#25）、附件下载会先开一个标签（#28）。
