# 桌面壳迁移计划（对齐 bb 形态）

> 来源：`get-bb/bb`，本地克隆在 `/private/tmp/bb-src`（commit `e9dafb6`，`0.46.1-nightly`）。
> 这份文档记录**已定的形态**与**分阶段计划**。动手前先读这份 + `HANDOFF.md`。
> 本文里的 bb 文件路径都相对 `/private/tmp/bb-src`。

---

## 0. 状态：阶段 1-4 已落地

实测证据在 `HANDOFF.md` 的「当前状态 → 已验证」表里（标题行 40 / rail 44 / 侧栏 260 / 三列顶行 36 /
卡片圆角 15px / 页面占位 y=121 / 检查器折叠 582→745 / 地址栏 goto 走通 / 裸词被拒 / ⌘L 选中全文）。

**实际做法和下面计划的三处差异**（都是刻意的，不是偷工）：

1. **环境身份放在窗口标题行，不是内容卡片的独立一行。** 原计划是「环境条 + 标签条 + 地址栏」三行
   = 128px 头部；实测太厚。现在环境身份（名字/组/状态/代理/接管/交还/快照）挤进本来就存在的
   2.5rem 标题行，内容卡片只留「标签行 36 + 地址行 44」= 80px，和 Chrome 的 80px 一致。
2. **侧栏宽度沿用 warren 的 260 / 200 / 420**（bb 是 320 / 240 / 460）。
3. **卡片边框复用 `--border`，没有新增 `--border-seam`。** warren 的 border ladder 已有三档，
   再加一档是 token 膨胀；bb 有 `--border-seam` 是因为它要区分「接缝」和「控件边框」。

**外壳配色（第一版做错了，已改）**：一开始把 `--surface-recessed` 写成「往黑里混」，
深色下算出来是 #0b0b0b —— 标题行 + rail + 卡片外的留白连成一圈纯黑，很闷。
现在改成 bb 的写法：**混 ink 而不是混黑**。

```css
--surface-recessed: color-mix(in oklab, var(--ink) 3.5%, var(--surface));
```

- 深色：ink 是白的 → 外壳 #212121，比卡片**亮**
- 浅色：ink 是深的 → 外壳 #f2f2f2，比卡片**暗**

一条公式两个方向都对，而且不会再出现纯黑的一圈。窗口的 `backgroundColor` 也跟着
从 `#0b0d10` 改成 `#1c1c1c`，避免启动首帧闪一圈黑。

**侧栏 footer 的分隔线删掉了**：`SidebarSeparator` 自带左右内边距，探不到卡片左边，
看起来像「分割线断了」。列表和 footer 本来就靠留白分开。

**踩到的坑（已修，别退回去）**：

1. **外层容器必须显式给宽度。** `SidebarProvider` 本身是 flex 行，不给 `w-full` 这个外壳会被
   收缩成内容宽度——实测面板组只有 566px，而窗口是 1440px。
2. **`defaultSize` 的像素值在冷启动时会算错。** v4 把它换算成百分比时用的是「首次布局那一刻」
   的面板组宽度：应用冷启动实测 `defaultSize={260}` 被算成 15.399%（渲染 214px），热重载重新挂载
   却是对的 260px。`App.tsx` 首帧之后按像素 `resize(260)` 兜了一次。
3. **`overflow-clip` 的卡片要包在 `ResizablePanel` 里**，卡片圆角落在 `#sidebar > div > div` 这一层
   （v4 的 Panel 自己会多包一层），探针别只看一层。

---

## 1. 目标形态

三个纵向区域 + 两个卡片，圆角在卡片上，不在窗口上。

```text
┌────┬──────────────────────┬────────────────────────────────────────────────┐
│ ☰  │ + 新建环境   ←  →    │环境名 · 组名 · ● 运行中           [ 右面板 ]   │ ← 3rem chrome 行
├┄┄┄┄┼┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┼┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤
│ H  │▾ 工作                │┌ 标签1 ┐┌ 标签2 ┐  +                           │
│    │   ● prod-a   运行中  │├──────────────────────────────────────────────┤
│ E  │   ● prod-b   已停止  ││ ←  →  ⟳   🔒 https://example.com/path     ⧉  │ ← 地址栏 44px
│    │▾ 个人                │├──────────────────────────────────────────────┤
│ P  │   ● test     接管中  ││                                              │
│    │                      ││   WebContentsView（原生浏览器视图）           │
│    │                      ││                                              │
│    │                      │├──────────────────────────────────────────────┤
│    │                      ││ [控制台] [网络] [事件] [快照]                 │
├┄┄┄┄┼┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┼┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤
│ S  │ [插件] [主题] [更多] │                                              │
└────┴──────────────────────┴────────────────────────────────────────────────┘
   44px        260px                     剩余
```

层次（从暗到亮，与 bb 的三级 ladder 一致）：

| 层 | bb | warren 对应 |
|---|---|---|
| 窗口外壳 + rail 底 | `--surface-recessed`（ink 6% over canvas） | **新增** `--surface-recessed`（派生 token） |
| 侧栏卡片 | `--sidebar`（ink 2.2%） | `--surface-under` |
| 内容卡片 | `--background`（canvas） | `--surface` |

---

## 2. 区域规格

单位全部走 token，禁止硬编码。

| 区域 | 值 | bb 依据 | warren 落点 |
|---|---|---|---|
| rail 宽 | `control-size + 2 × rail-padding` = 28+16 = **44px**（触屏 36+24=60） | `apps/app/src/components/sidebar/navRailWidth.ts`、`app.css:38-47` | 新增 `features/environments/environment-rail.tsx` |
| 标题栏 | **2.5rem**（`hiddenInset` 下 macOS 拖拽区 + 红绿灯预留） | `app.css:31`、`MACOS_TRAFFIC_LIGHT_RESERVE_PADDING_CLASS` | `App.tsx` 顶层 |
| chrome 行 | **3rem**（三列各自一行、同高） | `CHROME_ROW_CLASS`、`lib/bb-desktop.ts:21` | `App.tsx` |
| 侧栏宽 | 260（min 200 / max 420） | bb 是 320 / 240 / 460 —— **沿用 warren 现值** | `App.tsx` 已有 |
| 卡片圆角 | `rounded-xl` | `SIDEBAR_FRAMED_CARD_EDGE_CLASS`、`sidebar.tsx` | warren 用 `--radius-xl`（= 0.75rem × `--radius-scale` 1.25 = 15px） |
| 卡片边框 | `border-y border-l border-[--border-seam]` | 同上 | 新增 `--border-seam` 派生 token |
| 窗口内边距（lip） | 右/下 **0.5rem** | `--bb-window-frame-lip`、`SIDEBAR_FRAME_CLASS` | `App.tsx` |
| 分隔条 | 1px 线 + **12px 热区**，绝对定位压在接缝上，不占列宽 | `components/sidebar/SidebarChrome.tsx:55` | 改 `components/ui/resizable.tsx` |
| 地址栏 | 高 32（行高 44），`rounded-full`，`px-3` | `secondary-panel/BrowserTabContent.tsx:207-285` | `environment-stage.tsx` |
| 标签条 | 高 36 | `SecondaryPanelTabStrip.tsx` | 已有 `environment-tabstrip.tsx` |

### 圆角规则（bb 原文，逐条抄）

bb 是**两张**卡片各自圆角：侧栏 `rounded-l`、内容 `rounded-r`，中间不留缝。

**warren 改成一张卡片（偏离，记录在案）**：圆角套在「侧栏 + 内容」这一整块的外面，
左右两栏内部不再各自圆角。原因是实测分开放角会在浏览器区左边凭空出现一个圆角
（左栏的右上角 / 右栏的左上角），看着像渲染坏了；而且侧栏收起时还得给内容区补角，
多一处状态。现在无论侧栏开合，都是**一块圆角卡片 + 里面一条可拖的竖缝**。

- 圆角只在最外层那一个 div 上：`rounded-[var(--shell-card-radius)] border border-border overflow-clip`。
- rail 在卡片**外面**，贴在外壳底色上，不参与圆角。

---

## 3. 架构上的四个决定

### 3.1 rail 常驻，收起只折 body（照抄）

bb：`AppSidebar.tsx` 里 `<div className="flex flex-1">{rail}<SidebarCollapsibleBody>…`。rail 是固定宽列，body 是 `flex-1`；收起时面板宽度塌到 rail 宽，body 用 **`clip-path: inset(0 -6px 0 0)`** 裁掉，并加 `inert`（`components/ui/sidebar.tsx:796-845`）。

**关键点**：裁切而不是 `display:none`。否则展开动画里 body 会重排、跳一下。

warren 落点：`SIDEBAR_WIDTH.collapsed` 从 48 改成 rail 宽；`environment-sidebar.tsx:193` 的「状态点列」删除，改成 rail 常驻。

### 3.2 保留 react-resizable-panels，不抄 fixed + gap（**偏离，记录在案**）

bb 的面板是 `position: fixed` + 一个流内 `data-sidebar="gap"` 占位 div（`components/ui/sidebar.tsx:761,770`）。好处是拖拽/动画期间内容树不 reflow。

warren 的内容区是「一个占位 div + 一个原生 `WebContentsView`」，reflow 成本近乎为零，且 v4 的 `ResizablePanelGroup` 已经能跑。改成 fixed + gap 只会换来一堆自绘的拖拽代码。

**结论：保持 v4。** bb 真正值得抄的是 rail/body 的切分方式、卡片外壳、chrome 行、地址栏语义、图标注册表——不是它的定位方式。

### 3.3 分隔条改成覆盖层

现在是 `ResizableHandle` 占一列（v4 会给它一个宽度）。bb 的做法是绝对定位压在接缝上：`absolute -right-1.5 top-0 z-30 h-full w-3 cursor-col-resize`，1px 线是 `before:` 伪元素，只在 hover / 拖拽时显色。

落点：`src/renderer/components/ui/resizable.tsx`（组件库，改样式只改这里）。注意 v4 的 handle 是 `PanelResizeHandle`，覆盖层方案要确认它仍能拿到 pointer 事件（v4 用 `setPointerCapture`，热区必须比 1px 宽）。

### 3.4 顶部三列同高

rail 顶格、侧栏顶格、内容顶格**都是 3rem**，内容不同但高度一致，视觉上才是一条横线。

- rail 顶格：**空白**（bb 里就是空 div），`☰` 是固定覆盖层，收起后仍在。
- 侧栏顶格：`+ 新建环境` + 前进/后退（bb 放的是 `NavRailNewThreadButton` + `SidebarHistoryNavigationControls`）。
- 内容顶格：环境身份 + 接管/交还 + 右面板开关。

---

## 4. 地址栏（本次新增的重点）

### 4.1 位置

**标签条下面**，Chrome 式：标签行 → 工具栏行（前进/后退/刷新 + omnibox）→ 页面。

现在 warren 的导航按钮和地址栏挤在 stage 最上面的 `<header>`（`environment-stage.tsx:112-200`），标签条在它下面。要调换：导航控件跟着 omnibox 走，下移到标签条下面。

### 4.2 逐条规格（全部来自 bb 的 `BrowserTabContent.tsx:207-285`）

| 元素 | bb 做法 | warren 怎么做 |
|---|---|---|
| 行高 | `h-11`（44px），`py-1.5 pl-2 pr-4 gap-1` | 同 |
| 前进/后退 | `BrowserChromeIconButton`，`disabled` 跟随 `state.canGoBack/canGoForward` | 已有，保持 lease 门控 |
| 刷新 | **加载中时图标变 `X`**（停止加载），否则 `RotateCcw` | 加这一条 |
| omnibox 外形 | `<form>` 里套 `div`：`h-8 rounded-full border border-border/70 bg-background/70 px-3 gap-2` | 同（现在 warren 是方角 `rounded-[var(--radius-menu)]`） |
| 左侧图标 | 三态：`https` → 锁（success）；`http` → 警告三角（warning）；其他 → 放大镜（muted） | 照抄，`getBrowserUrlSecurity` 语义 |
| 输入字体 | URL 用 `font-mono`，placeholder 用 `placeholder:font-sans` | 同 |
| 编辑模型 | **失焦显示实时 URL，聚焦切到草稿并全选**（`isEditing ? addressDraft : currentUrl`） | 照抄，这是浏览器地址栏的核心手感 |
| 提交 | `resolveBrowserAddressInput`：是地址就导航，否则走搜索引擎 | 见 4.3 —— **warren 缺 RPC** |
| 加载指示 | 地址栏行底部 `h-0.5` 的进度条，1/3 宽 `animate-pulse` | 照抄 |
| 右侧 | 插件工具栏槽 + 「在外部浏览器打开」按钮 | warren 先做「复制 URL」（已有）+ 外部打开（可选） |

参考实现（可直接搬语义）：`apps/app/src/lib/browser-url.ts` 的 `resolveBrowserAddressInput` / `getBrowserUrlSecurity` / `getBrowserUrlHost`。

### 4.3 warren 特有的两处，必须自己定

**① 地址栏是写操作。**

PRD 5.3：导航属于写操作，只有人持控制权（`owner === 'human'`）时才允许。所以：

- `owner !== 'human'` 或环境未运行时，omnibox **只读**，点击不聚焦，tooltip 说明「Agent 操作中，先接管」。
- 接管后自动聚焦（或保留焦点）。
- 这一点和 bb 不同——bb 没有 lease 概念，地址栏永远可编辑。**不要照抄成永远可编辑**，那会破坏控制权互斥这条硬约束。

**② 缺一个 RPC。**

现在 `src/shared/types.ts:147` 是 `type NavigationAction = 'back' | 'forward' | 'reload'`，`humanNavigate(id, action)` 只能做这三件事。地址栏回车需要「跳到任意 URL」。

→ 要新增 RPC（例如 `humanNavigate(id, { kind: 'goto', url })`，或独立的 `navigateTo(id, url)`）。
**这会改 RPC 面，必须同步 `HANDOFF.md` 的「当前状态」和 `docs/PRD.md` 的接口表。**

**③ 搜索引擎：不做兜底（已定）。**

bb 默认 Google。warren 是隔离身份浏览器，把输入的裸词默认发给搜索引擎是一个**隐私决策**：
等于拿这个环境的出口和身份去发一次请求。所以 `lib/address-input.ts` 解析不出地址就返回 `null`，
地址栏弹「这不是一个可访问的地址」。**这是记录在案的偏离，不要"顺手修好"。**

规则（`src/renderer/lib/address-input.ts`，4 个单测覆盖）：

- `scheme://…` → 只放行 `http` / `https`（`file:`、`javascript:` 一律拒绝）
- `example.com` / `example.com/a?b=1` → 补 `https://`
- `localhost:8899` / `127.0.0.1:8899` / `[::1]:8899` → 补 `http://`（本地 fixture 没有证书）
- 其余（含中文、带空格、单个词）→ `null`

**注意**：协议判定必须是 `scheme://` 而不是 `scheme:`，否则 `localhost:8899` 会被当成
scheme 叫 `localhost` 的 URL 拒掉。

---

## 5. 图标库迁移：Tabler → Hugeicons

### 5.1 bb 用的是什么

**Hugeicons**（不是 Lucide、不是 Tabler）：

- `@hugeicons/core-free-icons@^4.3.4` —— 纯数据，每个图标是一个 `IconSvgElement`（`["path", { d, stroke: "currentColor", strokeWidth: "1.5" }]` 的数组）。
- `@hugeicons/react@^1.1.6` —— `<HugeiconsIcon icon={…} />` 渲染器。
- 移动端用 `@hugeicons/react-native`（同一个 core-free-icons 数据源）。

声明位置：`packages/shared-ui/package.json:368-369`、`apps/mobile/package.json:30-31`。

### 5.2 bb 的图标架构（值得抄的部分）

`packages/shared-ui/src/components/ui/icon.tsx` + `icon-registry.ts` + `icon-extended.tsx`：

1. **语义名注册表**。`CORE_ICON_MAP` 把产品语义名（`ChevronDown`、`Trash2`、`PanelLeft`、`Home`）映射到 Hugeicons 元素。业务侧写 `<Icon name="PanelLeft" />`，永远不直接 import 图标包。
2. **三层解析**：应用自定义图标（`setAppIcons`）→ 插件资源图标（SVG URL 走 `mask-image`，用 `currentColor` 染色）→ 内置。请求的名字不存在时退到 `fallback`（默认 `"Zap"`）。
3. **两个兜底**：`IconAncestors` context 防自引用死循环；`IconErrorBoundary` 让坏掉的自定义图标渲染成 `Zap` 而不是炸掉整棵树。
4. **统一尺寸契约**：每个图标根节点带 `data-icon-root=""`，尺寸由**父元素**用 CSS 变量控制，例如 `[&_[data-icon-root]]:size-(--bb-sidebar-control-icon-size)`。业务侧不传 `size`。
5. **扩展集懒加载**：`EXTENDED_ICON_NAMES`（120+ 个）单独一个 chunk，`icon-extended.tsx` 被 import 时调 `registerExtendedIcons()` 写进模块级注册表，渲染走 `useSyncExternalStore`，加载完自动补上。

### 5.3 warren 的迁移方案

现状：`src/renderer/components/icons.tsx`（150 行）用 `@tabler/icons-react`，`tabler()` 包一层固定 `size={16} stroke={1.5}`，导出 54 个 `XxxIcon` 组件 + 若干别名。

**好处：只有 3 个文件 import 它**（`environment-sidebar.tsx`、`environment-stage.tsx`、`environment-tabstrip.tsx`），迁移面很小。

要做：

1. 依赖换成 `@hugeicons/core-free-icons` + `@hugeicons/react`；删 `@tabler/icons-react`。
   - `@tabler/icons-react` 的残留：`components/ui/sidebar.tsx:25`、`components/ui-reference/context-menu.tsx`、`components/ui-reference/sheet.tsx`。**`ui-reference/` 是 stock 快照，不进 typecheck，不要动**；只改 `components/ui/sidebar.tsx`。
   - `lucide-react` 还在 `components/ui/sheet.tsx`、`components/ui/sonner.tsx`、`features/plugins/plugins-sheet.tsx`、`environment-stage.tsx` 用着。bb 全程只用 Hugeicons，建议一并收口，但可以放在图标迁移的同一阶段做。
2. `components/icons.tsx` 改成 bb 的形状：`ICON_MAP`（语义名 → `IconSvgElement`）+ `<Icon name fallback />`，根节点带 `data-icon-root`。
3. 3 个调用点改成 `<Icon name="…" />`。
4. **不抄懒加载**：54 个图标不值得拆 chunk。注册表文件保持独立，等图标数过百或 bundle budget 吃紧再拆——那时是个受控的小改动。

**光学差异提醒**：Hugeicons 的 `strokeWidth: 1.5` 烘在 24 格数据里，渲染到 16px 时有效描边 ≈ 1.0px。warren 现在 Tabler 也是 24 格 `stroke 1.5` 渲染到 16px ≈ 1.0px。**两者观感接近，不会突然变细或变粗**，这点不用调。

---

## 6. 分阶段计划（1-4 已完成）

每个阶段独立可验收，跑完才能进下一阶段。

### 阶段 1：图标库 ✅

- 改：`package.json`、`src/renderer/components/icons.tsx`、`components/ui/sidebar.tsx`
- 改调用点：`environment-sidebar.tsx`、`environment-stage.tsx`、`environment-tabstrip.tsx`、`features/plugins/plugins-sheet.tsx`、`components/ui/sheet.tsx`、`components/ui/sonner.tsx`
- 验收：`npx tsc --noEmit`；`npm test`；渲染层构建；`debug.rendererEval` 数 `document.querySelectorAll('[data-icon-root]').length > 0`

### 阶段 2：外壳 ✅

- 新增 `features/environments/environment-rail.tsx`（rail 本体 + tooltip side=right）
- 改 `theme/theme-tokens.css`：新增 `--surface-recessed`、`--border-seam`、`--shell-title-bar-height`、`--shell-frame-lip`、`--rail-*`、`--icon-size` 系列（全部从 seed 派生）
- 改 `App.tsx`：标题栏 + lip + 三列 chrome 行 + 卡片圆角 + 分隔条覆盖层
- 改 `environment-sidebar.tsx`：删收起分支，收起只由外层负责
- 改 `components/ui/resizable.tsx`：分隔条样式
- 验收：`debug.layout` 探针；`debug.rendererEval` 读卡片矩形与 `border-radius`；像素统计确认 rail 底比卡片暗

### 阶段 3：浏览器行 + RPC ✅

- `NavigationAction` 改成可辨识联合（`{kind:'goto'; url}` 等）。**CLI 没有 human nav 命令，所以只动了 IPC 面，没动 CLI。**
- 新增 `environment-address-bar.tsx`（三态安全图标、草稿/实时双态、⌘L）+ `lib/address-input.ts`（4 个单测）
- 验收：见 `HANDOFF.md` 的「当前状态」

### 阶段 4：细节 ✅

- 标签条：中键关闭（改在 `components/ui/surface-tab.tsx`，组件库内）；`+` 紧跟在最后一个标签后面而不是被推到最右（`SurfaceTabStrip` 传 `flex-initial` 覆盖默认的 `flex-1`）
- `⌘L` 聚焦地址栏 + 全选。**`⌘R` / `⌘W` 没做**：会和 Electron 的默认行为打架，要先在 `before-input-event` 里拦，留作后续
- 检查器可折叠（页面占位 582 → 745，原生视图 bounds 自动跟上）
- 触屏档位没做（见「明确不做」）

---

## 7. 验收命令（每阶段都跑）

```bash
npx tsc --noEmit
npm test
node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
```

涉及主进程/运行时的改动，按 `AGENTS.md`「已知问题 4」清理后 `npm start`，再：

```bash
node bin/warren.mjs call debug.layout
node bin/warren.mjs call debug.rendererEval '{"script":"JSON.stringify([...document.querySelectorAll(\"[data-slot=sidebar]\")].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height,getComputedStyle(e).borderTopLeftRadius]}))"}'
```

---

## 8. 明确不做

- 不抄 bb 的 `position: fixed` + gap 面板定位（见 3.2）。
- 不抄 bb 的移动端 vaul 抽屉侧栏。
- 不抄 bb 的侧栏内部 tab 分屏（`SidebarSplitContainer.tsx`，1013 行）和内容区分屏（`lib/split-layout`，最多 8 个 pane）。
- 不抄 bb 的插件图标 `mask-image` 通道（warren 的插件现在不提供图标）。
- 不做懒加载图标 chunk（见 5.3）。
- **不做右侧 secondary panel**：计划里没排，也没放一个点了没反应的 `[▤]` 占位按钮。
- 不做标签拖拽重排（warren 的 `SurfaceTab` 现在没有 dnd）。

## 9. 已定

1. 地址栏裸词：**不搜索，解析不出就报错**（见 4.3）。
2. 侧栏宽度：**沿用 warren 的 260 / 200 / 420**。
3. 内容卡片头部：**环境身份并进窗口标题行**，内容卡片只留标签行 + 地址行（见第 0 节）。
