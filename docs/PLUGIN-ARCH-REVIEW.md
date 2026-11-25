# 插件架构复核（对标 BB）+ 重构方案

> 状态：**方案，未实施**
> 日期：2026-10-18
> 对标对象：本机 BB `0.39`（`bb-plugin-authoring` 技能 19 篇 reference + 已装插件源码）
> 前置：`docs/PLUGIN-CAPABILITY-DESIGN.md`（本仓库自己的插件设计）、`plugins/README.md`（插件作者入口）
>
> **修正**：本文件 §5–§9 的前端 API 方案已被
> `docs/PLUGIN-FRONTEND-API-PLAN.md` 取代。尤其不要把 §5.1 的通用 `app.host` Proxy
> 按原文实施——它会把 `settings.get` 明文暴露给渲染层，并放大跨插件冒充与并发串环境问题。

---

## 1. 结论速览

| 问题 | 结论 |
|---|---|
| 架构差多少 | **不多**。三 bundle 形状、清单、权限分层、生命周期、host 运行时都已经对齐 |
| UI 要不要暴露给插件 | **要，而且继续这么干**。BB 的「插件自己 vendor 一份 shadcn」是为第三方生态付的代价，我们不付 |
| 真正的缺口 | 都在**前端那一层**：宿主能力没有正式通道、设置读不到、可挂的界面位置只有 4 个 |
| 最值得抄的一条 | BB 的 **`experimental_setThreadRowStatus`** —— 它正好回答「插件怎么往环境行上放东西」 |
| 最不该抄的 | 构建步骤 + vendor（我们的插件和宿主**同一个仓库、一起发版**） |

---

## 2. BB 的做法（原文 + 源码证据）

### 2.1 有一条明写的规则：不给 UI kit

`references/frontend-components.md:8`：

> **This is the deliberate exception to the no-host-components rule: a stable product capability, not a UI kit.**

`@get-bb/plugin-sdk/app` 只导出**只有宿主做得出来**的东西：`ThreadChat`、
`experimental_ProviderModelPicker` / `PermissionModePicker` / `BranchPicker`、
`experimental_SourceCode` / `Diff`、`experimental_NewThreadComposer`、`experimental_VoiceInputTextarea`、
`Markdown`、`FileLink` / `UrlLink`、`experimental_Icon`。**Button / Dialog / Select 一个都没有。**

### 2.2 通用组件：插件自己 vendor 一份 shadcn

`references/frontend-hooks-and-ui.md:228`：

> **UI components use vendored shadcn source that you own.** The app module exports only focused BB capability components.

真实插件（`bb-plugin-cua-driver/app.tsx`）就是这么写的：

```tsx
import { Button } from "@/components/ui/button";              // ← 插件自己的源码
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { toast } from "sonner";                                // ← shim 到宿主
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
```

它目录里真的有 `components/ui/{button,dialog,tooltip,motion}.tsx` + 一份 `components.json`，
registry 指向 `@bb`，而那个 registry **是从 BB 应用自己的组件源码生成的**：

> `npx shadcn add @bb/select @bb/table` —— registry 里的组件是从 BB 应用自己的组件源码生成的，
> 所以 vendor 出来的代码**按构造就是版本匹配的**。随便改，**它们永远不会在你脚下变**。

### 2.3 但运行时（单例）是共享的

`references/frontend-registration.md:6`：React 和 SDK **从不打包**，`bb plugin build` 把它们
shim 到宿主的共享运行时。明确列出的「never bundled」清单分两类理由：

- **单例正确性**：react、所有会 portal 的 radix 家族、`sonner`、`vaul`、`@pierre/diffs`。
  原文的理由是「你 vendor 的浮层因此和宿主共享同一套 dismissable-layer / 焦点 / 滚动锁的世界」。
- **体积**：`clsx`、`tailwind-merge`、`cva`。

**这两条和我们现在的做法完全同思路**：React 由宿主注入、`toast` 用宿主的 Toaster
（「never mount your own `<Toaster>`」）、图标从宿主取（否则每个插件塞 100MB 的 hugeicons）。

### 2.4 行状态：命令式的 setter，不是拉数据

`references/frontend-core-slots.md`（content scripts 的 `mount` 入参）：

> `mount` receives `{ pluginId, generation, signal, experimental_setThreadRowStatus? }` ——
> 那个 setter 用 `{ icon, label, tone? }` 定位一个明确的 thread 行，用 `null` 清掉。
> **宿主把状态限定在调用它的插件名下，并在那个前端代（generation）失效时自动清掉。**

这条设计比「插件提供一个批量 rpc，宿主每行去拉」好得多：**没有 N×M 的调用风暴，
宿主负责渲染与清理，插件停用自动消失**。

---

## 3. 逐条对比

| 维度 | BB | warren 今天 | 判断 |
|---|---|---|---|
| 产物形状 | server / app / host 三个 bundle | entry(sandbox) / app / host(utilityProcess) | **已对齐** |
| 清单 | `package.json` 的 `bb` 字段 | `manifest.json` | 形式不同，等价 |
| 贡献面声明 | 代码里 `app.slots.*` 注册 | **清单声明 + 加载时校验 ⊆ 清单**（fail closed） | warren 更严，是刻意的 |
| 权限 | 无表；靠安装同意 + API 边界 | 三层 `granted` / `confirm` / `denied`，单一来源 | **warren 更细** |
| 生命周期 | abort → 反序 dispose；reload 先验证候选 | `activate` / `dispose` / `reload` / `status` / `logs` | 基本对齐（warren 单窗口） |
| 实时 | `useRealtime` + 连接状态 | `useSignal`（主进程 push，无重连概念） | 够用 |
| 前端 UI | **插件 vendor** shadcn | **宿主注入** `app.ui`（70 个键） | **不同，见 §4** |
| 宿主能力组件 | 12 个（聊天 / picker / 源码查看器…） | 0（我们没有「只有宿主能做」的界面） | 不是缺口，是产品形态不同 |
| 前端数据通道 | `useSdk()` 类型化客户端 | `window.envApi`（**能用但没文档化**）+ 插件自己的 rpc | **缺口** |
| 设置 | `useSettings()` | 只能走自己的 rpc 转发 | 小缺口 |
| 导航 | `useBbNavigate()` | 无 | 缺口，但今天没有消费者 |
| 图标 | 宿主 + 插件可注册 | 宿主 `Icon` | 缺注册，今天没有消费者 |
| 可挂的界面位置 | ~12 个槽位 | **4 个**（railPage / settingsSection / envAction / inspectorTab） | **真缺口** |
| 行状态 | `experimental_setThreadRowStatus` | 无 | **真缺口** |
| content scripts | ✓（自己标注 full-trust） | 明确不做（设计稿 §4 写了理由） | 不做 |
| 前端测试 | `renderSlot()` + `inspection.sdkCalls` | 无（只有实机 `debug.rendererEval`） | **真缺口，但成本高** |
| API 演进纪律 | `experimental_` 前缀 + `docs/api_to_audit.md` | `apiVersion` 声明 | 够用 |

---

## 4. UI 要不要暴露给插件：**要，继续暴露**

**BB 为什么 vendor**：它的插件是**第三方 npm 包**，装进来之后要能扛住宿主升级。
「vendor 的源码永远不会在你脚下变」正是为这件事付的代价——代价是插件作者必须有一个
TS + Vite 的构建工程，宿主必须维护一个从自己源码生成的 registry。

**warren 为什么不该学**：

1. **插件和宿主在同一个仓库、一起发版**（`plugins/*` 跟着应用走）。没有「第三方插件要扛升级」
   这回事——宿主改了组件，插件跟着改就行。
2. 我们的插件是**手写的 ESM**，被 `warren-plugin://` 原样吐出去，**没有编译**。
   vendor 这条路要求先给插件加一整套前端工具链（TS + Vite + registry + npm 包），
   于是「写一个插件」从「写一个 app.js」变成「起一个 npm 项目」。**插件数量还少的时候加这个，
   是给一个不存在的生态付成本。**
3. 反过来，注入的代价是「宿主改组件会同时改到插件界面」——**同仓同发版时这个代价几乎为零**。

**所以：保留 `app.ui`，但把它当契约管**（现在只是「倒出去 70 个键」）：

- `plugins/README.md` 里**分级**：稳定语义（Button / Dialog / Select / Field… 的 props 形状）
  vs 跟着设计系统变（recipe、间距、圆角、颜色 token）。插件作者据此判断什么能依赖。
- 公共面**增删改 = 改 `apiVersion`**，写进 README（现在只有一句「加是加法」）。

---

## 5. 该补的三块（按 BB 的形状）

### 5.1 `app.host.*` —— 前端直连宿主能力的正式通道

今天插件前端要拿宿主状态（环境列表、当前页面 URL），得**在自己的后端写一个纯转发方法**，
再 rpc 过去。whistle 的 `list`、notes 的 `pageInfo` 都是这个形状。

做法：`app.host` 是一个 **Proxy**，任意 `app.host.a.b.c(...args)` → `rpc.call('host.a.b.c', args)`；
主进程的 `PluginHost.rpc` 认 `host.` 前缀，转发到**已有的 host API 表**。

- **零枚举**：Proxy 不需要宿主把路径抄一份给渲染层。
- **权限门控照旧**：落到 `api.ts` 的同一张表，`require(permission)` 一个都不少。
  （相对插件后端不是提权；但同 realm 下插件可以借 `pluginRpc` 调别的插件，
  所以不能把它当成安全边界——见新计划的 §2.1。）
- **`contributes.rpc` 白名单不适用**于 `host.` 前缀——那条白名单管的是插件自己的方法。

收益：插件不再为「读一下宿主状态」写后端样板。notes 的 `pageInfo` 里那两行宿主数据
（`host.browser.url()` / `.title()`）可以直接删掉，前端自己调；计数仍然走它自己的库。

### 5.2 `app.useSettings()` —— 前端读自己的设置

现在只能走自己的 rpc（notes 的 `stats` 里塞了 `title` / `filter` / `hasApiKey`）。
做法：`plugin:settings` IPC（复用 `plugin.list` 里那份 `PluginSettingValue[]`），
`app.useSettings()` 返回 `{ values, isLoading, reload }`。**secret 只有 `configured`，没有值**——
和 BB 的 `useSettings()` 一致（「secret settings are excluded; read them server-side only」）。

### 5.3 新 surface：**环境行状态芯片**（抄 `setThreadRowStatus`）

这就是你上一轮问的「让插件控制环境行显示什么」。BB 的答案是命令式 setter，不是拉数据：

```js
// 插件前端，在它自己的组件里
app.setEnvBadge(envId, { icon: 'List', label: '3', tone: 'info' });  // 或 null 清掉
```

宿主这一侧的规矩：

- **一个槽**：行上只有一个徽章位（不然又回到「五样东西抢宽度」）。
  多插件都设了 → 按 `contributes.surfaces` 里的声明顺序取第一个，其余在行 tooltip 里列出。
- **宿主渲染**：形状固定（一个图标 + ≤3 字符），插件给不了任意 DOM。
- **自动清**：插件停用 / 卸载 / 前端代失效 → 它的徽章立刻消失（BB 就是这么做的）。
- **宽度**：徽章进的是行尾那一簇，和归属 / 审批图标同级；名字仍然是 `flex-1`。

消费者：whistle 显示「这个环境绑的实例端口」（虽然出口那一栏已经显示了端口，所以它**不一定会用**）；
notes 显示「N 条未完成待办」（这个是真有用）。

---

## 6. 重构方案

### B1 · 前端 API 契约化（§5.1 + §5.2）

- `app.host`（Proxy → `host.` 前缀 rpc）+ `PluginHost.rpc` 的前缀分支
- `app.useSettings()` + `plugin:settings` IPC + `EnvApi` 声明
- `plugins/README.md` 补两节：**稳定性分级**、**`app.host` 的用法**
- 验收：notes 的 `pageInfo` 不再转发宿主数据（URL / 标题前端直接调 `app.host.browser.*`），
  计数仍走它自己的库；检查器页显示不变

### B2 · 环境行状态芯片（§5.3）

- `shared/types.ts` 加 `EnvBadge`；`plugin-runtime` 暴露 `app.setEnvBadge`
- `App.tsx` 持有「插件 → 环境 → 徽章」的表，行里渲染；插件停用时清
- 验收：notes 打开时环境行出现「待办 N」；`plugin disable` 之后徽章立刻消失；
  行宽不变（名字仍然完整）

### B3 · 插件重构

- **notes**：`pageInfo` 不再转发宿主数据；`stats` 里 `title` / `filter` / `hasApiKey` 移到 `useSettings`
  （只留计数）；环境行徽章显示未完成待办数
- **whistle**：环境列表改 `app.host.environment.list()`（它自己的 `list` 只回实例）；
  面板/行上的设置项改 `useSettings`
- 验收：两个插件的功能逐条复跑（`plugins/README.md` 的清单 + 实机 `rendererEval`）

### B4 · 收尾

- 五道静态门 + `bash scripts/regress/run-all.sh`
- `docs/HANDOFF.md` 同步；`AGENTS.md` 的文档表加这份

---

## 7. 不做，以及为什么

| 不做 | 理由 |
|---|---|
| 给插件加构建步骤 + vendor shadcn registry | 同仓同发版，代价远大于收益（§4）。**哪天有第三方插件再谈** |
| `useBbNavigate()` 那种导航 API | 今天没有消费者。插件前端本来就能 `window.envApi.select(id)` |
| 插件注册图标（`experimental_icons.register`） | 没有消费者；插件用宿主的 `Icon` 已经够 |
| content scripts | 设计稿 §4 已经否决过（会绕过 token/recipe，收益低代价高） |
| 插件前端测试 harness（`renderSlot` 那种） | 要引 jsdom + testing-library，而实机 `rendererEval` 今天够用。**记在账上** |
| `experimental_` 前缀纪律 | 我们的插件同仓，改公共面直接改 `apiVersion` 就行，不需要前缀 |

## 8. 必须写清的一条边界（不是本次新增，是一直存在）

**插件前端跑在应用窗口里，能用整个 `window.envApi`** —— 包括 `env.update` / `env.remove`
这种写操作，**绕开插件权限模型**（权限只在后端那条路上卡）。同一个 realm，技术上挡不住。

设计稿已经把它归为「插件前端是半可信代码」，但**没有写进 `plugins/README.md`，
安装对话框里也没说**。这次补上：

- README：明确「`app.host` 是**约定**，不是边界；同 realm 里 `window.envApi` 一直都在」
- 安装对话框的信任说明里加一句

## 9. 风险

1. **`app.host` 会放大前端的能力面**：通用 Proxy 会把 `settings.get` 等路径也带出去。
   不能靠「只读」口头约定，必须用显式白名单；写操作、secret、`storage.*` 都不进。
   `environment.update/start/stop` 本来就不挂 lease，不能笼统说「写操作走 rpc 就有 lease」。
   见 `docs/PLUGIN-FRONTEND-API-PLAN.md` §2.2。
2. **行徽章又会挤宽度**：所以定死「一个槽 + 图标 + ≤3 字符」。
3. **`plugin:settings` 是新的 IPC 面**：secret 必须只有 `configured`，不能顺手把值带出去
   （复用 `settings.list()` 已有的实现，不要另写一份）。
