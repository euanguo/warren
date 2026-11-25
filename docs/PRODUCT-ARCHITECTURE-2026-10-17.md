# 产品架构梳理（2026-10-17）

> 状态：**梳理 + 建议，未实施**（§2 的视觉修复除外，已落地并实测）。
> 本文回答四件事：**插件架构怎么调整**、**前端组件为什么盖不住页面 / 怎么绕过**、
> **缺哪些安装入口**、**入口放哪里**。

---

## 0. 先说结论

| 问题 | 结论 |
|---|---|
| 前端组件盖不住页面 | **是 Electron 的结构性限制**（原生视图不参与 DOM 层叠），但**有两条可行绕法**，仓库里已有先例（`input-shield.ts`） |
| 页面被盖住会「停止」 | **不是限制，是我们选的绕法的副作用** —— `view.setVisible(false)` 让页面被判定为 backgrounded 而节流。**一行可修** |
| 插件架构 | 骨架完整（manifest v2 + 三层权限 + 双 runtime + kv/SQLite + 4 种 surface + rpc + signal），**主要缺「事件订阅」和「能力面」** |
| 安装入口 | 缺三样：插件脚手架、Skill 安装、应用本身的一键安装。**入口放设置里新开一节「Agent」** |

---

## 1. 插件架构：现状梳理

### 1.1 已经有了什么（核对代码）

| 面 | 实现 | 位置 |
|---|---|---|
| 声明 | manifest v2：`runtime` / `engines` / `contributes` / `permissions` | `plugins/manifest.ts`（354 行） |
| 权限 | **17 条 + 三层**（granted / confirm / denied），单一来源 | `shared/permissions.ts` |
| 运行时 | `sandbox`（`node:vm`）/ `host`（`utilityProcess.fork` 独立进程） | `plugins/runtime.ts`（447 行） |
| 生命周期 | install / enable / disable / uninstall / reload / `activate` / `dispose` | `plugins/host.ts`（686 行） |
| 数据 | kv（`plugin_values` scope=kv）+ 每插件自己的 `data.db`（`node:sqlite`） | `plugins/storage.ts` |
| 设置 | 描述符式（string/number/boolean/select/**secret**）；secret 进 Vault，永不回前端 | `plugins/settings.ts` |
| 界面 | **4 种 surface**：`railPage` / `settingsSection` / `envAction` / `inspectorTab` | `plugins/api.ts` + 渲染层 |
| 调用 | `plugin.run`（命令）+ `plugin.rpc`（插件前端 → 插件后端）+ `plugin.signal`（插件 → 前端） | — |
| 权限门控 | 写操作**惰性取 lease** | `plugins/api.ts` |

**设计上做对的两件事**（`PLUGIN-CAPABILITY-DESIGN.md` §6 的决定，值得保持）：

1. **P0 插件不提供 React 组件**，只给「声明 + 数据」，界面由 Warren 自己的组件渲染 —— 不碰 CSP、协议、加载器。
2. **`denied` 层不因为声明就开放** —— 「声明了就给」等于把 manifest 当提权手段。

### 1.2 五个缺口（这是要调整的地方）

| # | 缺口 | 现状 | 影响 |
|---|---|---|---|
| 1 | **能力面窄** | 页面能力只有 `dom.read` / `screenshot` / `navigate` / `input` / `evaluate` | 插件做不了「等元素」「坐标键鼠」「标签操作」「网络规则」「下载上传」——而这些**主进程全都有**（`browser/` 19 个模块 + `net/` 3 个） |
| 2 | **只能被调用，不能订阅** | 插件是被动的（命令 / RPC）。`plugin.signal` 是插件→前端，**不是主进程→插件** | 插件无法响应「页面导航了」「lease 换人了」「环境启动了」。事件总线**主进程已经有**（`makeEvent` + `events` 表） |
| 3 | **没有拦截点** | 无 | 插件无法在动作前后插逻辑。**这个要谨慎**：修改型钩子会拖慢动作、还可能改掉行为 |
| 4 | **surface 写死 4 种** | `SURFACE_KINDS` 是常量数组 | 加挂载点要改代码 |
| 5 | **插件之间不能协作** | 无依赖声明、无互相调用 | 复杂插件只能各做各的 |

### 1.3 建议的调整（按性价比排序）

**A. 把 `browser.*` 从「几个方法」升级成「受权限门控的 capability 对象」**（收益最大）

现在 `plugins/api.ts` 是一条条手写方法。改成：主进程把 `BrowserController` 按权限**裁剪**成一个子集交给插件：

```ts
// 示意：按声明的权限挑出允许的方法，而不是逐个 if
const page = capabilityOf(controller, manifest.permissions);
// page.snapshot() / page.click() / page.waitFor() … 只有声明过的才在
```

好处：**加能力不用改门控代码**（新增方法自动进入裁剪表），灵活性直接上来。
代价：要维护一张「方法 → 权限」的映射表（这张表本身就是文档）。

**B. 加事件订阅 `events.subscribe`**（收益第二）

主进程已经有事件总线。给插件一个**只读**订阅口（权限 `events.subscribe`，`confirm` 层），
按环境过滤。这样插件能对「导航完成」「lease 变更」做反应，而不用轮询。

**C. surface 做成注册表**

`SURFACE_KINDS` 从常量数组变成注册表（`registerSurface(kind, renderer)`），
加挂载点不用动 `api.ts`。

**D. 钩子（hooks）—— 建议只做「观察型」**

`onAfterAction` / `onNavigate` 这类**只读回调**可以做；
**修改型钩子（能改请求、能改动作）不做** —— 理由：它会变成动作链上的一段未知延迟，
和 `AGENTS.md` 已知问题 8（「命令成功、页面没反应」）是同一类风险。

**E. 插件间协作 —— 先不做**

没有真实用例之前加依赖解析只会增加复杂度。**有第二个真实插件要用到再说。**

---

## 2. 前端组件为什么盖不住页面（含修复）

### 2.1 是 Electron 的限制吗？**是**

`WebContentsView` 是原生 Cocoa 视图（`NSView`），由窗口服务器合成，**不参与渲染层的 DOM 层叠**。
渲染层里 `z-index: 99999` 也盖不住它。`HANDOFF.md` §3.6 早就写清了这一点。

### 2.2 「盖了之后页面会停止」—— 不是限制，是绕法的副作用

现在的做法是 `setViewVisible(false)` → `tabs.ts:391` 调 `view.setVisible(false)`。
**注意：它不是移除视图，只是让它不可见。**

而 Chromium 对不可见/被遮挡的 webContents 会**判定为 backgrounded 并节流**：
定时器变慢、动画停、`requestAnimationFrame` 停、**并且 `Page Visibility API` 跟着变**
（`document.hidden` 变 true）。这就是「页面停止」。

**一行修复**（`src/main/tabs.ts` 的 `VIEW_PREFERENCES`）：

```ts
backgroundThrottling: false,
```

Electron 官方注释原文：

> Whether to throttle animations and timers when the page becomes background.
> This also affects the **Page Visibility API**. When at least one webContents displayed in a
> single browserWindow has disabled `backgroundThrottling` then frames will be drawn and swapped
> for the whole window and other webContents displayed by it. Defaults to `true`.

**副作用要认**：关掉之后，**后台环境也不再节流** → 多环境同时跑时 CPU 占用上升。
环境数量少（Warren 的用法是几个）时可以接受；要精确控制可以只在「被临时遮住」时关。

⚠️ **这条必须实测两件事**（还没测）：
1. 关掉之后 `document.hidden` 是不是真的不跟着变了；
2. 多环境下的 CPU 开销到底涨多少（`debug.layout` 里有 `telemetryWrite` 之类的量，
   但没有 CPU 计量，要另外量）。

### 2.3 要让 UI 真的盖在页面上：三条路

| 路 | 做法 | 代价 | 判断 |
|---|---|---|---|
| **A. 隐藏页面视图**（现状） | `view.setVisible(false)` | 页面被节流（**§2.2 修掉**）；页面看不见 | 已在用，修完副作用后可用 |
| **B. 透明原生叠层** | 再放一个 `WebContentsView`，`setBackgroundColor('#00000000')`，插在页面之上 | **中**：叠层是第二个 renderer | **推荐** |
| **C. 把页面换成 `<webview>` 标签** | 页面进 DOM 树 → z-index 生效 | **大**：要重做标签/遮罩/lease/viewport 一整套；`TECH-STACK-RESEARCH.md` §4.3 明确拒绝过 | 不做 |

**路 B 已经有先例，就在本仓库里**：`input-shield.ts` 是

```ts
this.#view = new WebContentsView({ webPreferences: {...} });
this.#view.setBackgroundColor('#00000000');
this.#view.webContents.loadURL(`data:text/html,...`);   // 一段透明的 HTML 盖在页面上
```

**它证明了两件事**：透明叠层**能盖在页面视图之上**，而且**页面照常跑**（遮罩期间页面没有停）。

**路 B 的关键约束（实测类型定义）**：`setIgnoreMouseEvents` 只在 `BaseWindow` / `BrowserWindow` 上，
**`WebContentsView` 没有鼠标穿透**。所以叠层**必须按浮层尺寸精确摆放**，不能做全屏透明层 ——
全屏层会把页面所有点击吃掉。

**落地形状**（建议）：

1. `OverlayHost`：一个透明 `WebContentsView`，`addChildView(view, index)` 插在页面之上；
2. 渲染层测量浮层的 rect → IPC 发给主进程 → `overlay.setBounds(rect)`；
3. 叠层里渲染的是**声明式的浮层**（menu / popover / dialog / toast），
   渲染层发 `{ component, props, rect }`，叠层按同一个组件库渲染；
4. **页面视图不再隐藏** —— 只有叠层那一小块盖上去。

代价集中在一处：**浮层组件要能在第二个 renderer 里渲染**（要么复用一个精简入口，要么走声明式协议）。
**这是这个方案唯一真正的工作量。**

---

## 3. 安装入口：缺什么、放哪里

### 3.1 现在有什么（核对 CLI）

```bash
warren plugin install <dir>     # 只支持本地目录，装完要 enable + grant
```

**没有**：插件脚手架、Skill 安装、应用本身的一键安装。

### 3.2 缺的三样

| # | 缺什么 | 做法 | 优先级 |
|---|---|---|---|
| 1 | **`warren plugin create <name>`** | 生成 manifest + `index.js` + `app.js` 骨架（照 `plugins/example-notes/` 的形状） | **高**：没有它，第三方写插件要先读 8000 行文档 |
| 2 | **Skill 安装** | 把自带的 Skill 装到 agent 目录（见 §4） | **高**：这是"让外部 agent 认识 Warren"的入口 |
| 3 | **应用一键安装** | `brew install --cask warren` / dmg / 安装脚本 | 中：`RELEASE.md` 已经有 makers（zip + dmg）和签名门控，缺的是分发渠道 |

### 3.3 入口放哪里 —— **设置里新开一节「Agent」**

**判断依据**：

- **不是首页**：首页是环境工作台（列表 + 页面 + 检查器），一次性的接入配置不该占位。
- **不是插件页**：Skill 不是插件 —— 插件跑在 Warren 里，Skill 是给**外部 agent**（Claude Code / Codex / Cursor）的接入物。混在一起会让"插件"这个词失焦。
- **放设置里**：设置已经有「插件 / 凭据 / Notes 使用说明」三节，加一节结构一致；而且它是低频、一次性的。

**这一节放什么**：

1. **安装 Skill 到 agent 目录** —— 勾选目标 agent（Claude Code / Codex / Cursor / 其他），一键写入；
   显示写入路径与结果。
2. **`warren` CLI 状态** —— 路径、是否在 `PATH`、一键复制 `PATH` 设置命令。
   （现在 `warren` 靠 `package.json` 的 `bin` 暴露，用户不一定装了。）
3. **接入说明** —— 给 agent 的一段话（"用 `warren env list` 看环境…"），可复制。

**插件脚手架**则放在**设置 → 插件**页：那一页已经有插件列表，加一个「新建插件」按钮，
生成到用户选的目录。

---

## 4. 自带 Skill（对应「生成一个 Skill 装到 agent 目录」）

Warren 自带一个 Skill，装到各 agent 的 skills 目录，让 agent 知道怎么用 `warren` CLI。
形态参考 `ego-browser` 那个 skill（本机已装，可直接对照）：
**一个 `SKILL.md` + 少量 references**，内容围绕"怎么用 CLI 完成任务"。

**要写进 Skill 的东西**（都是本项目已经确定的事实）：

- `warren env list` / `env start <env>` / `env acquire <env>` 的三步开场
- **每次调用都要带 env 寻址**，没有隐式"当前环境"（`HANDOFF.md` §3.4）
- `warren exec <env>` 一次跑一整段脚本的形态
- `browser snapshot` 是主观察通道（AX 树），截图是次通道
- 写操作要 lease；人持权时 agent 会拿到 `CONTROL_REVOKED`
- `vault.fill` 只填不返；`storage.cookie.read/write` 永远不可用
- 常见错误码：`ENV_NOT_FOUND` / `ENV_BUSY` / `WINDOW_NOT_FOCUSED`（⚠️ 见
  `OPTIMIZATION-PLAN-2026-10-17.md` §1.1，这条正在复核）/ `TARGET_AMBIGUOUS` / `TIMEOUT`

**不做**：不写"Warren 是 Electron 应用"这类实现细节 —— Skill 是给 agent 的操作手册，不是架构文档。

---

## 5. 与既有文档的关系

- `PLUGIN-CAPABILITY-DESIGN.md` / `PLUGIN-MODERNIZATION-PLAN.md` —— 插件架构的**设计与施工图**，
  本文 §1 是**在它们之上的再评估**（缺口的出处）。
- `HANDOFF.md` §3.6 —— 「输入遮罩必须是原生 View」这个决策。本文 §2 是它的延伸：
  同一个机制（透明原生叠层）可以用来做 UI 浮层。
- `OPTIMIZATION-PLAN-2026-10-17.md` —— `backgroundThrottling` 的实测要做在那里（§2.2 的两条）。
- `RELEASE.md` —— 应用分发渠道（§3.2 第 3 项）落在这里。

---

## 6. 已实施（2026-10-17 晚，同一轮）

| 本文的建议 | 状态 | 落点 |
|---|---|---|
| 设置从弹窗改成替换 stage | **已做，已实测** | `settings-dialog.tsx` → `settings-page.tsx`；`App.tsx` 的 `stageReplaced`；`app-rail.tsx` 的 `settingsActive` |
| 设置里新开「Agent」一节 | **已做，已实测** | `features/settings/agent-panel.tsx` + `src/main/agent-integration.ts` |
| 自带 Skill | **已做** | `skills/warren/SKILL.md`（109 行）；`forge.config.cjs` 的 `extraResource` |
| `browser.*` 做成受权限裁剪的能力表 | **已做** | `plugins/api.ts` 的 `BROWSER_CAPABILITIES`（7 条 → 24 条） |
| 事件订阅 `events.subscribe` | **未做（有意）** | 见 §6.3 |

### 6.1 设置页改动的实测数字

- 分隔线：`h-fit` 时导航列 116px / 容器 420px（画不到底）；改成 `h-auto!` 后 **870 = 870**。
  必须带 `!` —— 组件基础变体里有 `group-data-vertical/tabs:h-fit` 在抢。
- 离开设置：点 rail 的「环境」后 `[data-slot="settings-page"]` 消失、`stage-placeholder` 回来。
  设置现在是 stage 的一个视图，和插件页抢同一块地方，所以
  `stageReplaced = pluginPageOpen || settingsOpen` 决定要不要让原生页面视图让位。
- 回归 10.1 现在断言的分节是 **插件 / Agent / 凭据 / Notes 使用说明**。

### 6.2 能力表的形状

```ts
const BROWSER_CAPABILITIES: Record<string, { permission; write?; run(controller, args) }>
```

`createHandlers` 遍历它生成 handler：读操作直接跑，写操作自动 `withLease` + `assertWritable`。
**加能力只改这张表。** 以前每加一个方法都要手抄一遍 `require` + `write` + `assertWritable`，
抄漏一次就是提权。

新增的面：`reload` / `info` / `events` / `screenshot` / `highlight` / 七种 `waitFor*` /
`dblclick` / `hover` / `drag` / `selectOption` / `focus` / `setInputFiles` /
`acceptDialog` / `dismissDialog`。

**没进表的只有两条**：`browser.console` / `browser.network` —— 它们的数据来自 Telemetry，
不是 controller 上的方法，放表里反而要伪造一个 controller 参数。

### 6.3 `events.subscribe` 为什么没做

它需要一个**主进程 → 插件**的推送通道，而现有只有反向的（`signal.publish`：插件 → 前端）。
两种运行时各要一套：

- `sandbox`（`node:vm`）：要往 vm 里注册回调，并管它的生命周期（插件 reload / dispose 时要摘掉）
- `host`（`utilityProcess`）：要走 JSON-RPC 的**通知**方向（现在是请求-响应）

两套都要配权限门控（`events.subscribe`，`confirm` 层）和「按环境过滤」。
**这是一个子系统，不是一次改动** —— 半做出来的订阅会在插件 reload 后变成泄漏的回调。
建议单独一轮做，设计先落在 `PLUGIN-CAPABILITY-DESIGN.md`。
