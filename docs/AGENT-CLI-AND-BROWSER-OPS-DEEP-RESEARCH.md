# AI 浏览器 CLI 与底层操纵能力深度源码调研与 Warren 对标增强蓝图

> 日期：2026-11-26  
> 调研基线：Warren `c8620d2`（含 Wave 4 `70e1f35` Agent CLI v2 与 `src/main/browser/ops/`），承接线程 `@thread:thr_8ypk8hvsfp` 与 [WARREN-2.0-ARCHITECTURE-PLAN.md](./WARREN-2.0-ARCHITECTURE-PLAN.md) §5。  
> 方法论：**全部基于一手源码与实机 CLI 核验**（GitHub 最新主干源码 + 本机已装 CLI 实测），不采信二手博客转述。

---

## 0. 核心结论（Executive Summary）

1. **Warren 的护城河在「安全隔离工作台」，短板在「页面感知深度、动作精准度、长尾边界处理与 CLI 人体工程学」**：
   - **Warren 显著领先开源竞品的 6 项底层优势**（必须 100% 守住）：多 Environment 强隔离 + 独立代理（无凭据即拒）+ 单环境 `trustedCa` 验签；Person/Agent 双 Space 共存与 Lease 人机协作仲裁；不开放 `--remote-debugging-port` 且不开 `Runtime.enable`/`Network.enable`（天然规避 Patchright 重点修补的最大检测面）；Vault 零明文直填与域名白名单；原生网络 Mock/HAR/Whistle 联调链路；后台离屏不抢前台。
   - **但对照 2026 年头部开源库源码，Warren Wave 4 仅落地了「语法外壳」，内核精准性与边界鲁棒性仍有代差**：本次源码审计在 Warren 现有实现中直接定位到 **8 大类、34 处具体缺陷与盲区**（含 `.` 键撞 `VK_DELETE`、`Enter` 缺 `\r`、双击缺首次点击、React 受控日期框写不进、Portal 菜单 `scrollIntoView` 触发收起、环形缓冲满 300 条后 `batch` 网络增量恒为空、`-d` 误用 heading `level` 当树深、flat snapshot 丢失父子语义等）。
2. **2026 年主流 AI 浏览器操控已经收敛出 7 条行业共识架构**：
   - **CLI-First + 常驻 Daemon/Socket 替代重型 MCP Schema**（`agent-browser`、`playwright-cli`、连 Google 官方 `chrome-devtools-mcp` 都补了 `chrome-devtools` daemon CLI；`stagehand` 推出独立 `browse` CLI；`browser-use` 推出 ultrafast CDP `ax.py` + daemon CLI）。
   - **语义层级树 + 稳定 Ref + 混合 DOM 补盲**：纯 CDP AX 树远远不够，头部项目全部演化为 **AX 树 + 隔离世界 DOM 探针混合层**（补齐 `cursor:pointer`/`onclick` 非 ARIA 控件、隐藏 radio/checkbox 的 `<label>` 提升、隐藏 `<input type=file>` 找回、过滤 `opacity:0` 幽灵文本、分级 Token 预算/80-20 首尾截断）。
   - **点击点几何与命中验证升级到 Browser 侧 Quad + 跨帧安全检查**：弃用 `DOM.getBoxModel` 改用 `DOM.getContentQuads` 最大行盒 + 内部整数点 + `DOM.getNodeForLocation` + 隔离世界 `<label>` 关系判定 + Sticky 遮挡多对齐轮换滚动 + Portal 浮层免滚动直点 + 顶层 Modal 自动收敛。
   - **事件驱动的智能 Settle 取代固定 Sleep**：合并 `readyState` + 忽略长轮询/WS/SSE（>1.5–2s）的在途请求计数 + 过滤动画样式与无操作属性重写的 `MutationObserver`。
   - **少回合闭环**：动作级/批处理级真实 **Delta Receipt（含可用新 Ref）** + 表单失败回传合法选项列表 + 面向 Agent 的**可执行单行 `remedy`**。
   - **内建安全与上下文防护**：输出字节上限 + 自动溢出落盘提示、IDPI 不可信网页边界转义（防 `</untrusted_web_content>` 闭合逃逸）、ANSI 终端转义剥离、密码定宽脱敏（不漏长度）。
   - **2026 新一代高杠杆原语**：**WebMCP**（`agent-browser` / `playwright-cli` / `chrome-devtools-mcp` 三家齐上）、`read` 优先探测 `llms.txt` / `Accept: text/markdown`、可参数化复用的只读 `flow`、带 Ref 编号标注的 `--annotate` 截图、像素级 `diff screenshot`、React Fiber/Vitals/Axe 研发诊断。

---

## 1. 扩散式开源生态全景对标（11 个一手项目，2026-11 基线）

| 项目 | 星标 / 语言（2026-11） | 架构与传输 | 感知与 Ref 模型 | 最值得 Warren 吸收的杀手级设计 | 核验源码入口 |
|---|---|---|---|---|---|
| **`vercel-labs/agent-browser`** | 54.1k★ · Rust | 原生 Rust CLI + 本地 Daemon；直连 CDP（Chrome）+ WebDriver BiDi（Firefox） | 缩进层级 AX 树 + 光标可交互扫描 + 隐藏控件提升 + `(frameId, loaderId)` 绑定 Ref | `click_point.rs` 多行 Quad 几何与 `DOM.getNodeForLocation`；`forms.rs` 全套前/后校验与选项回传；`interaction.rs` 完整键码/PendingRelease；`diff.rs` 忽略 Ref 噪声与像素 Diff；`read.rs` `llms.txt`/Markdown 协商；`policy.rs`；`webmcp.rs`；`react`/`a11y`/`--annotate` | `cli/src/native/{snapshot,click_point,element,interaction,forms,diff,policy,webmcp}.rs`, `cli/src/read.rs` |
| **`browser-use/browser-use`** | 122.1k★ · Python | Python CLI/REPL + `browser-harness` 常驻 Daemon；Ultrafast 直驱 CDP (`ax.py`) | 页序语义树 + `backendNodeId` 直接作 ID + `*` 标新增 + `VISIBLE_JS` 去 `opacity:0` 幽灵文本 | `PROBE_JS` 同源 iframe 递归监听 + 样式动画节流 + 无变化属性过滤；`settle()` 忽略 >1.5s 长连接；80/20 首尾截断保底弹窗按钮；Combobox 焦点转移追踪 (`MOVED_JS`)；`insertText` + 末字 `keyDown/Up` 触发自动补全；`commands:['selectAll']`；`chrome-error://` 真实网络错误回填；隐藏 `file` input 找回 | `browser_use/{ax,cli}.py`, `browser_use/browser/{browser,local}.py` |
| **`microsoft/playwright-cli` + `playwright`** | 15.5k★ CLI / 40.2k★ MCP / 101.1k★ Core · TS | CLI + 后台 Daemon 复用 `playwright-core` 引擎；大快照默认写 `.playwright-cli/page-*.yml` | YAML 缩进 ARIA 树 + `eN` Ref + `--boxes` + `find --regex` 上下文检索 | `domUtils.ts`（`inert`、`display:contents`、`checkVisibility()`、DOM Clobbering 防护、复用 `Range`）；`dom.ts` 四态滚动对齐轮换 + `findIntegerPointInsideQuad` + `setupHitTargetInterceptor`；`fill --submit`；外部文件 `drop --path`；`show --annotate` 人机批注；`webmcp-list/call` | `skills/playwright-cli/SKILL.md`, `packages/injected/src/{domUtils,ariaSnapshot}.ts`, `packages/playwright-core/src/server/dom.ts` |
| **`ChromeDevTools/chrome-devtools-mcp`** | 59.4k★ · TS | MCP + 新增 `chrome-devtools` Daemon CLI；直挂 Puppeteer/CDP + DevTools 面板联动 | 跨快照稳定 `uid` (`${loaderId}_${backendNodeId}`) + `$0` DevTools 选中联动 + ExtraHandles 插树 | `WaitForHelper.ts` 动作前预注册导航监听 + CPU/网络节流倍率自适应超时；`chrome-devtools-cli.ts` `shieldLiteralArgs` + `stripTerminalEscapes` + Agent 自教学参数报错；`LogpointManager` / `NetworkOverrideManager` / `HeapSnapshotManager` / `webmcp` | `src/{TextSnapshot.ts,formatters/SnapshotFormatter.ts,utils/WaitForHelper.ts,daemon/chrome-devtools-cli.ts}` |
| **`pinchtab/pinchtab`** | 10.6k★ · Go | 12MB 单文件 Go 二进制；HTTP API + CLI + 多实例编排 + 分级 Stealth | 分层预算截断（Actionable → Context → Remainder）+ Compact Diff (`[+]`/`[~]`/`[-]`) + 三态 Checked | `TopmostModalNodeID` 5 点穿透命中自动收敛顶层弹窗；`clickFloatingFlyoutItem` 绕过 Portal 菜单滚动脱焦；`remedy.go` CI 校验的可执行单行 Shell 补救指令；`idpi/guard_shield.go` 防闭合标签逃逸的不可信内容包裹；定宽密码脱敏 `"••••••••"`；`autoSwitchSession` 新标签自动切换 | `internal/bridge/{action_resolve,action_pointer,action_form}.go`, `internal/bridge/observe/{snapshot,snapshot_format}.go`, `internal/{remedy/remedy,idpi/guard_shield,stealth/bundle}.go` |
| **`openclaw/openclaw`** | 395.3k★ · TS | 全平台 AI 网关内建 `extensions/browser`（Playwright + Raw CDP 双栈） | 缩进角色树 + `cursor:pointer` 父子去重 + 敏感值脱敏 + Link URL 附加 | `act-policy.ts` 严谨的分层超时预算计算（避免内层动作/批处理撞外层传输看门狗）；`cdp-role-snapshot.ts` 父级已有 `cursor:pointer` 时跳过子元素防爆炸 | `extensions/browser/src/browser/{cdp-role-snapshot,cdp-role-snapshot-tree,act-policy}.ts` |
| **`ardia-browser/ardia`** | 3.1k★ · TS/C++/Rust | 自编译 Chromium + `ardia browse`（完全兼容 `agent-browser` 语法，驱动用户运行态浏览器） | 元素生命周期持久 Ref + 原地重绘自愈 + 同类长列表折叠 (`e8…e55`) | 每步动作自带变化回执；`flow save/run --param`（将 GET JSON 请求沉淀为单次数据调用）；`read <url1> <url2>` 并行后台多页阅读 + `--links`；`script` 跨调用持久 `state`；智能 `fill`（网格单元格）与 `select`（typeahead/chip）；`drag --before/--after` + 排序位置确认；`input_not_delivered` 落地校验；自动关 Cookie Banner | 本机 `ardia browse --help`、`SKILL.md`、`references/{flows,script,troubleshooting,automation}.md` |
| **`browserbase/stagehand` (`browse`)** | 26.2k★ · TS | 每会话独立 Daemon (`browse` CLI) + 本地/云端统一路由 + `browse.sh` 开放站点 Skill 目录 | 帧编码 Ref `@0-12` (`frameOrdinal-backendNodeId`) + `xpathMap`/`urlMap` + `--filter /regex/` 保留祖先链 | 跨帧统一编码 Ref；`snapshot --filter` 保留祖先上下文；`type --mistakes` 仿真输入；`browse skills add <site>` 站点经验分发机制；`--auto-connect` 自动发现本机调试端口 | `packages/cli/README.md`, `packages/cli/src/commands/*` |
| **`SawyerHood/dev-browser`** | 6.8k★ · TS | Daemon + 脚本执行模式（同 Warren `exec` 路线） | 注入式 ARIA 快照 + `ref-handler` | `wait-for-load.ts` 极简优雅的双端（宿主+页内）有界 Settle 契约（过滤 `/favicon.ico` 与 >2s 流式请求）；`fill.ts` React 原生 `HTMLInputElement.prototype` Setter 赋值 | `src/page/{wait-for-load,fill}.ts`, `src/page/snapshot/*` |
| **`Kaliiiiiiiiii-Vinyzu/patchright`** | 5.3k★ · TS | 深度补丁版 Playwright（专攻反检测与真实可用性） | 原生 Playwright Locator + **Closed Shadow Root 穿透（含 XPath）** | 消除 `Runtime.enable` / `Console.enable` 泄露（Warren 已具备！）；CDP `DOM.getDocument({pierce:true})` 支持 **Closed Shadow Root**；精细化启动参数白名单 | `README.md` |
| **`ego-browser` (v2.2.1)** | 本机实测 CLI | TaskSpace / Page 持久化模型 + `nodejs` 脚本入口 | Viewport 优先快照 + `[more content below]` 显式折叠提示 + `subtree` | 容器选择器自动向下寻找唯一可编辑/上传子控件（Wrapper Retargeting）；优先滚轮滚动失败再退回程序滚动；挂起导航超时自动 `stop` 避免页面卡死（`EGO_PAGE_UNRESPONSIVE`） | 本机 `ego-browser skill` |

> **扩散视野补充**：`lightpanda-io/browser`（42.6k★, Zig）主打纯无头极速 CDP 内核（不适合 Warren 桌面工作台定位，但验证了 CDP 最小化协议面）；`steel-dev/steel-browser`（8.0k★, TS）主打云端会话与 CAPTCHA/代理托管。

---

## 2. 底层核心机制深度拆解 × Warren 源码缺陷与盲区清单

按浏览器操控的 **8 条关键链路**，逐一对照 Warren 现行源码与开源标杆源码，列出已核实的 **34 个具体缺口**。

### 2.1 页面感知与 Snapshot / Ref 系统（精准性的第一瓶颈）

| # | 机制 / 边界情况 | 头部开源库怎么处理（源码依据） | Warren 现状与具体缺陷（源码依据） | 严重度 |
|---|---|---|---|---|
| **G1** | **层级缩进与父子语义** | `agent-browser` (`snapshot.rs:1579-1892`)、`playwright-cli`、`chrome-devtools-mcp`、`pinchtab` 全部输出**缩进树**，并用 `compact_tree` 仅剪枝空结构包裹层、**保留有语义的祖先链**（dialog/form/row/listitem）。 | [snapshot-compact.ts](../src/main/browser/ops/snapshot-compact.ts#L70-L88) 输出完全扁平列表（`- button "编辑" [ref=@12]`）。列表/表格中多个同名按钮彻底丧失所在行、卡片、弹窗的归属上下文。 | **P0** |
| **G2** | **`-d / maxDepth` 实现错误** | `agent-browser` 在 `build_tree` 中递归计算真实 `TreeNode.depth`（`snapshot.rs:1700-1706`）。 | [snapshot-compact.ts](../src/main/browser/ops/snapshot-compact.ts#L75) 判断 `node.level > maxDepth` —— `node.level` 是 ARIA `aria-level`（仅 `heading`/`treeitem` 有值），导致 `-d 2` 对 95% 节点**完全不生效**！ | **P0** |
| **G3** | **长页面截断丢失底部弹窗与提交按钮** | **PinchTab** (`snapshot_format.go:203-280`) 采用**三级优先级预算截断**（Actionable → Context → Remainder），跳过单个超大节点防饿死后续控件，再按原文档顺序输出；**Browser Use** (`ax.py:658-665`) 采用 **80% 头 + 20% 尾** 截断，因为 Modal 的确认/提交按钮总在文档末尾。 | [snapshot-compact.ts](../src/main/browser/ops/snapshot-compact.ts#L84-L87) 与 [snapshot.ts](../src/main/browser/snapshot.ts#L307) 纯按文档前缀截断（400 节点），长页底部表单和挂载在 `<body>` 末尾的 React Portal 弹窗直接被砍掉！ | **P0** |
| **G4** | **非 ARIA 可点击元素（React/Vue `<div onClick>`）不可见** | `agent-browser` (`snapshot.rs:1229-1545`) 与 `openclaw` (`cdp-role-snapshot.ts:25-136`) 均执行**光标交互扫描**（`cursor:pointer`、`onclick`、`tabindex>=0`、`contenteditable`），且 OpenClaw 特意跳过「父节点已是 `cursor:pointer`」的子元素以防卡片内部 `<span>` 爆炸。 | [snapshot.ts](../src/main/browser/snapshot.ts#L292-L297) 与 [snapshot-compact.ts](../src/main/browser/ops/snapshot-compact.ts#L3-L4) 仅依赖 AX 角色正则；大量真实业务后台（管理台菜单、卡片、自定义图标按钮）未写 ARIA role，在 `-i` 下完全隐身。 | **P0** |
| **G5** | **隐藏控件与自定义样式组件丢失** | 1) **隐藏 radio/checkbox**：`agent-browser` (`snapshot.rs:1552-1577`) 将包裹 `display:none`/`sr-only` `<input type=radio|checkbox>` 的 `<label>` 提升为 `radio`/`checkbox` 角色并继承 `checked` 状态；2) **隐藏 `<input type=file>`**：`browser-use` (`ax.py:624-637`) 主动查询 DOM 并在快照顶部补列 `[id] file "name" (hidden)`；3) **原生 `<select>` 折叠**：`browser-use` (`ax.py:579-613`) 将 `MenuListPopup` 内 200 个 `<option>` 摘要为 `options: A \| B \| … 195 more`。 | Warren 均未处理：Tailwind/Shadcn 风格单选框在 AX 中退化为无 ref 的 `LabelText`；隐藏上传框完全看不见；含 200 个国家的 `<select>` 直接吃光 400 节点配额！ | **P0** |
| **G6** | **`opacity: 0` 幽灵文本污染与 `StaticText` 冗余** | `browser-use` (`ax.py:174-197`) 用 `checkVisibility({checkOpacity:true, checkVisibilityCSS:true})` 过滤 AX 保留的 `opacity:0` 预渲染成功提示；`agent-browser` (`snapshot.rs:1641-1683`) & `chrome-devtools-mcp` (`SnapshotFormatter.ts:60-76`) 合并连续 `StaticText` 并剔除与父节点 `name` 重复的单一文本子节点。 | [snapshot.ts](../src/main/browser/snapshot.ts#L283-L307) 原样输出 AX 节点，不滤 `opacity:0` 文本、不合并碎片文本、不剪枝重复子文本，既浪费 Token 又导致 AI 误判操作成功。 | **P1** |
| **G7** | **角色白名单遗漏与三态 `checked` / `url` / `nth` 缺失** | `agent-browser` `INTERACTIVE_ROLES` 含 `treeitem`/`listbox`/`DisclosureTriangle`/`ColorWell`/`gridcell`；`pinchtab` (`snapshot_format.go:10-25`) 明确输出 `[checked]` / `[unchecked]` / `[mixed]` 三态；`agent-browser` 支持 `-u` 附带链接 `href` 及同名元素自动 `[nth=N]`；`snapshot_format` / `pinchtab` 对密码字段使用**定宽脱敏 `"••••••••"`**（绝不泄露密码长度）。 | [snapshot-compact.ts](../src/main/browser/ops/snapshot-compact.ts#L3-L4,L31-L33)：漏掉 `treeitem`/`listbox`/`gridcell`；`checked === false` 被丢弃导致无法区分未勾选与不可勾选；缺少链接 `url` 开关；`node.value` 未对 `password` / `autocomplete=current-password` 做定宽脱敏！ | **P1** |
| **G8** | **Ref 稳定性、文档身份与自愈机制不足** | `agent-browser` (`element.rs:551-609`) 将每个 Ref 绑定到 `(sessionId, frameId, loaderId)`，子 iframe 静默重载也能精准判 stale；`chrome-devtools-mcp` (`TextSnapshot.ts:97-106`) 以 `${loaderId}_${backendNodeId}` 复用 `uid`，跨快照不重编号；`ardia` 更进一步支持**元素存活期持久 Ref + 原地重绘按 `(role, name, 所属 dialog/row/form)` 唯一性自愈**并报告 `→ @e4 was redrawn, now @e19`。 | [refs.ts](../src/main/browser/refs.ts#L7-L55) 仅在主 frame 导航时 `bump()`，每次 `snapshot()` 全量清空重排 `@1..@N`；跨源或同源子 iframe 内部重载时旧 Ref 不会判 stale。 | **P1** |
| **G9** | **Closed Shadow DOM 不可见 & OOPIF CSS/XPath 失效** | `patchright` 与 `chrome-devtools-mcp` 使用 CDP `DOM.getDocument({depth:-1, pierce:true})` / `DOM.describeNode({pierce:true})` 可穿透 **Closed Shadow Root**；`agent-browser` 支持 `frame <sel|@ref|name|url>` 上下文切换及全帧查找。 | [controller.ts](../src/main/browser/controller.ts#L140-L194,L704-L724) 的 `selectorWalkScript` 与 `#xpathBackendIds` 仅遍历主会话 `document` 与 `el.shadowRoot`（无法穿透 Closed Shadow Root），且**完全不搜索 OOPIF 子会话**——`browser find testid/placeholder/css/xpath` 在跨源 iframe 中 100% 失败！ | **P1** |

---

### 2.2 点击、悬停、拖拽与 Actionability（精准性的核心战场）

| # | 机制 / 边界情况 | 头部开源库怎么处理（源码依据） | Warren 现状与具体缺陷（源码依据） | 严重度 |
|---|---|---|---|---|
| **G10** | **多行折行链接 & CSS 旋转变换元素点击偏移** | `agent-browser` (`click_point.rs:179-236`) 用 `DOM.getContentQuads` + 鞋带公式算面积取**最大行盒 Quad 中心**；`playwright` (`dom.ts:1041-1069`) 用 `findIntegerPointInsideQuad` 尝试四个取整方向，确保落点严格在四边形内部且不踩右下边界。 | [page-helpers.ts](../src/main/browser/page-helpers.ts#L213-L221) 用 `DOM.getBoxModel` 取外接轴对齐矩形中心：折行 `<a>` 中心落在两行之间的空白处，旋转按钮中心可能落出元素外！ | **P0** |
| **G11** | **Sticky Header / Footer 遮挡无自动躲避** | `playwright` (`dom.ts:389-396`) 重试循环依次轮换滚动对齐：`[默认, end, center, start]`；`browser-use` (`ax.py:713-721`) 被遮挡时自动 `scrollIntoView({block:'center', inline:'center', behavior:'instant'})` 二次重试。 | [page-helpers.ts](../src/main/browser/page-helpers.ts#L177-L181) 每次重试只重复发 `DOM.scrollIntoViewIfNeeded`（元素已在视口内即为空操作），被顶部固定导航栏/底部悬浮条挡住时会在 5 秒内死循环重试直到超时！ | **P0** |
| **G12** | **Floating Portal 菜单项（Radix / Base UI / MUI）滚动触发关闭** | `pinchtab` (`action_pointer.go:82-123`) 识别 `role="menuitem"\|"option"` 且祖先为 `position:fixed\|absolute` 时，跳过 `DOM.scrollIntoViewIfNeeded`，改用 `focus({preventScroll:true}); this.click()`，防止滚动触发浮层重渲染卸载节点。 | [actions.ts](../src/main/browser/actions.ts#L119) 对所有点击无条件先调 `scrollIntoView`，极易导致 Floating UI / Base UI 弹出菜单收起并报 `NODE_DETACHED`。 | **P0** |
| **G13** | **双击 `dblclick` 协议不完整** | `agent-browser` (`interaction.rs:996-1051`) 与 Playwright 严格执行 `Move → Press(1) → Release(1) → Press(2) → Release(2)`。 | [actions.ts](../src/main/browser/actions.ts#L163-L169) 直接调 `click(ctx, target, { clickCount: 2 })`，只发了一次 `mousePressed(2)` + `mouseReleased(2)`，缺少第一次点击序列！ | **P0** |
| **G14** | **命中检测与可见性/可交互性盲区** | 1) `agent-browser` (`click_point.rs:268-353`) 用 CDP `DOM.getNodeForLocation`（文档坐标 = 视口坐标 + `visualViewport.pageX/pageY`）做防篡改跨帧命中测试，并区分表单控件 `<label>` 关系（拦截 `<label>` 内夹杂的 `<a>` 链接，避免勾同意框误点条款链接！）；2) `playwright` (`domUtils.ts:51-58,136-188`) 检查 `inert` 属性、`display:contents` 子节点可见性、`element.checkVisibility()`（覆盖关闭的 `<details>`、`content-visibility:hidden`）；3) `browser-use` (`ax.py:723-757`) 遮挡报错时向上回溯 AX 树报出**语义挡路者**（如 `[1204] dialog "Cookie Preferences"`）；4) `pinchtab` (`action_resolve.go:203-302`) 5 点穿透自动检测**顶层模态框**（`:modal` / `[aria-modal=true]`）避免误操作背景层。 | [actionability.ts](../src/main/browser/actionability.ts#L96-L123)：用页内 `document.elementFromPoint`（可被页面脚本重写、跨帧断链、不认 `<label for>`）；未检 `inert`、`display:contents`、`opacity:0`、关闭 `<details>`、disabled `<fieldset>`；遮挡只报 `<div.css-1a2b3c>` 无语义；无顶层 Modal 感知。 | **P0** |
| **G15** | **点击中途触发 JS Dialog 导致鼠标按键卡在按下态** | `agent-browser` (`interaction.rs:947-1137`) 用 `PendingRelease` 记录被同步 Dialog 打断的 `Press(n)`，在 Dialog 处理完毕后补发 `mouseReleased`。 | [controller.ts](../src/main/browser/controller.ts#L322-L342) `#sendInput` 检测到 `#peekDialog()` 直接提前返回，后续处理完 Dialog 后不会补发 `mouseReleased`，可能导致页面进入异常拖拽/按压状态。 | **P1** |
| **G16** | **后台标签 `mouseMoved` 潜在卡顿 & 拖拽不支持 HTML5 DnD / 排序位置反馈** | `browser-use` (`ax.py:759-765`) 实测后台无头标签发 `mouseMoved` 可阻塞 ~5s；`pinchtab` (`action_pointer.go:155-163`) 与 `ardia` 默认瞬时直达，显式 `--humanize` 才走贝塞尔路径；`ardia` `drag` 自动落点在目标远半区并支持 `--before`/`--after`、HTML5 `draggable` 协议及排序后新位置校验（`moved to 5 of 5`）。 | [actions.ts](../src/main/browser/actions.ts#L88-L104) 默认对所有点击发多段 `mouseMoved`（即使在后台标签）；`drag` 只做中心到中心纯鼠标移动，未校验 `target` 的 actionability，不支持 `--before`/`--after` 与 HTML5 DnD / 文件 `drop`。 | **P1** |

---

### 2.3 键盘与表单操控（最容易被忽视的真实 Bug 聚集区）

| # | 机制 / 边界情况 | 头部开源库怎么处理（源码依据） | Warren 现状与具体缺陷（源码依据） | 严重度 |
|---|---|---|---|---|
| **G17** | **标点 VK 码撞键（`.` = `VK_DELETE`）与功能键缺 `text`/VK 码** | `agent-browser` (`interaction.rs:1139-1372`) 完整映射 US 键盘 `VK_OEM_*`（`.`=190 而非 ASCII 46）、`Enter` 带 `text:"\r"` & VK=13、`Tab` 带 `text:"\t"` & VK=9；当按住 `Alt\|Control\|Meta` 时强制置 `text=None`；支持 `Esc`/`Return`/`Space`/`Up`/`Ctrl`/`Cmd`/`ShiftRight` 等别名与 `location` (Left=1/Right=2)。 | [input.ts](../src/main/browser/input.ts#L99-L160) 存在 4 个硬 Bug：① `.` 发 `windowsVirtualKeyCode=46` (`VK_DELETE`)；② `Enter`/`Tab` 缺 `text` 与 VK 码；③ `Control+a`/`Meta+c` 错误附带 `text:'a'`；④ 不认 `Esc`/`Space`/`Cmd`/`Ctrl`/`Up`/`ShiftRight`。 | **P0** |
| **G18** | **`fill` 不滚进视口 & React 受控非文本输入赋值失效** | `dev-browser` (`fill.ts:39-52`) 与 `browser-use` (`ax.py:241-245`) 对 `date/time/color/range` 使用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)` 绕过 React 实例 setter 拦截；失败时恢复旧值并给出格式示例。 | [actions.ts](../src/main/browser/actions.ts#L60-L67,L269-L270)：`fill()` **未调用 `scrollIntoView`**；直接写 `el.value = v`，导致 React 受控日期/滑块/颜色输入框状态不更新。 | **P0** |
| **G19** | **Autocomplete / Combobox 焦点转移与按键事件触发缺失** | `browser-use` (`ax.py:824-850`) 点击后检测 `document.activeElement`（穿透 Shadow DOM）是否转移到了弹出的覆盖输入框（`MOVED_JS`），若已转移则不抢焦点直接往新焦点输入；且对 `chars[:-1]` 用 `insertText`、**最后一个字符用真 `keyDown`/`keyUp`** 触发自动补全/日期选择器监听！清场使用 CDP `rawKeyDown` + `commands:['selectAll']`。 | [actions.ts](../src/main/browser/actions.ts#L271-L292) 强制 `DOM.focus(originalNodeId)` + 纯 `Input.insertText`：遇到点击后弹出浮层输入框的 Combobox（AntD/MUI/Notion/Algolia）直接失效，且监听 `keydown`/`keyup` 的联想框完全不触发。 | **P0** |
| **G20** | **表单读回验证误杀（Password / Email / Mask / Maxlength）** | `agent-browser` (`forms.rs:683-724,848-922`) 对 `password` 跳过读回比较；对 `email` 归一化首尾空格；对 `contenteditable` 折叠空白；按 UTF-16 计算 `maxlength` 截断并输出结构化 `value_truncated` 警告（**只报长度，绝不回显明文**）；面对格式化输入掩码降级为非致命 warning 而非报错中断。 | [actions.ts](../src/main/browser/actions.ts#L282-L292) 对所有字段做严格 `readBack !== value` 直接抛 `FILL_UNCONFIRMED` 错误！遇到 `email` 自动 trim、手机号/金额掩码（`138 0013 8000`）、`maxlength` 截断或密码清空策略全部假失败。 | **P0** |
| **G21** | **`selectOption` 仅限原生 `<select>`，且失败不回传可选项** | `agent-browser` (`forms.rs:1088-1236`) 与 `ardia` 同时支持原生 `<select>`、ARIA `combobox`/`listbox`、typeahead 与 chip 输入；校验 `option_disabled`/`not_multiple`/`ambiguous`；失败时在结构化错误中附带 **`available_options`** (`[{value, label}]`)，让 Agent 零回合自纠正。 | [actions.ts](../src/main/browser/actions.ts#L318) 写死 `if (!(el instanceof HTMLSelectElement)) throw`，现代组件库自定义下拉框 100% 不可用；失败时不列合法选项，不校验选项是否 `disabled`。 | **P0** |
| **G22** | **缺少幂等 `check`/`uncheck` 与 `<label>`/Wrapper 重定向** | `agent-browser` (`forms.rs:729-737,1262-1361`) & `ego-browser`：`bind_control` 将 `<label>` 重定向到 `el.control`、将 wrapper 重定向到唯一可编辑子控件；`check`/`uncheck` 已达目标态直接幂等成功，拒绝 uncheck `radio` 并给出指引，仅对原生隐藏 input 允许 DOM click 兜底，**绝不对自定义 ARIA checkbox 二次重试**（防撤销异步切换）。 | Warren 既无 `check`/`uncheck` 命令（无论 CLI 还是 `exec`），也无 `<label>`/wrapper 重定向。 | **P1** |

---

### 2.4 等待、Settle、Batch 与变化回执（Agent 少回合效率的命门）

| # | 机制 / 边界情况 | 头部开源库怎么处理（源码依据） | Warren 现状与具体缺陷（源码依据） | 严重度 |
|---|---|---|---|---|
| **G23** | **Batch 网络增量在 300 条后永久为空（真实 Bug）** | `chrome-devtools-mcp` / `ardia` / `browser-use` 基于请求递增 ID 或动作前时间戳/游标做增量切片。 | [batch.ts](../src/main/browser/ops/batch.ts#L213-L216) 用 `after.slice(Math.min(before.length, after.length))`，而 [telemetry.ts](../src/main/telemetry.ts#L25,L105-L122) 固定 `LIMIT = 300`！一旦页面累计超过 300 条请求，`before.length === 300` 且 `after.length === 300`，`networkSummary` **恒返回 `[]`**！ | **P0** |
| **G24** | **Delta Receipt 里的增量节点没有 Ref，省不了回合** | `ardia` 的每个写动作及 `batch` 回执中，新增元素全部自带**立即可用的新 `@eN` Ref**，长列表同类项折叠（`+ 48 options (e8…e55)`）。 | [batch.ts](../src/main/browser/ops/batch.ts#L246,L359) 调 `snapshot()`（不注册 ref）而非 `snapshotWithRefs()`，导致 `delta.interactiveDelta.added` 中所有条目 `ref: undefined`——Agent 拿完回执仍被迫再跑一轮 `snapshot -i`！ | **P0** |
| **G25** | **`networkidle` 与 `batch` Settle 存在结构性误判** | `dev-browser` (`wait-for-load.ts:60-245`) & `browser-use` (`ax.py:109-172,408-450`) & `chrome-devtools-mcp` (`WaitForHelper.ts:54-317`)：① 同时追踪**在途请求（request start → finish/fail）**，并**忽略存活超过 1.5–2s 的流式/长轮询/WS/SSE/favicon**；② 联合 `document.readyState` + `MutationObserver`（过滤动画 `style` 高频写入与 `oldValue === newValue` 空写，递归监听同源 iframe）；③ `WaitForHelper` 在**动作发送前**即监听 `Page.frameStartedNavigating`，且超时随节流倍率缩放。 | 1) [telemetry.ts](../src/main/telemetry.ts#L149-L163) 只挂 `onCompleted` 不挂 `onBeforeRequest`，[waits.ts](../src/main/browser/waits.ts#L357) `awaitIdle` 对正在进行中的慢接口误判为空闲！2) [batch.ts](../src/main/browser/ops/batch.ts#L354-L355) 仅靠写死的 `setTimeout(150)`；3) [batch.ts](../src/main/browser/ops/batch.ts#L262-L268) `back`/`forward` 同步调用不等待导航落地。 | **P0** |
| **G26** | **Batch 动词覆盖不全 & 单步无独立选项** | `ardia browse batch` 支持几乎全部 CLI 动词（含 `find`/`check`/`select`/`scroll`/`wait`/`dialog`/`upload`/`tab`/`frame`/`eval`/`screenshot`/`close`）及行内参数（`--no-changes`、`--bail`、`--out`）。 | [batch.ts](../src/main/browser/ops/batch.ts#L7-L19) 仅支持 12 组基础动词，缺少 `find`/`check`/`uncheck`/`scroll`/`wait --selector\|--url\|--text\|--load`/`dialog`/`upload`/`tab`/`frame`/`eval`/`screenshot`。 | **P1** |
| **G27** | **挂起导航与嵌套超时预算管理缺失** | `openclaw` (`act-policy.ts:110-266`) 按动作种类、批处理步数与导航宽限期**动态计算总执行预算 + 传输松弛量**；`ego-browser` 对超时未提交的导航主动调用 `stop` 恢复页面可用并报 `EGO_PAGE_UNRESPONSIVE`；`browser-use` 对 `chrome-error://` 注入真实底层 `Network.loadingFailed.errorText`。 | Warren 统一硬编码 `ACTION_TIMEOUT_DEFAULT = 5000` 和 CLI `CALL_TIMEOUT_MS = 60_000`，多步 `batch` 或慢等待极易撞外层 RPC 超时；无 `chrome-error://` 病因透传。 | **P1** |

---

### 2.5 页面阅读（`read`）、对比（`diff`）与研发诊断

| # | 机制 / 边界情况 | 头部开源库怎么处理（源码依据） | Warren 现状与具体缺陷（源码依据） | 严重度 |
|---|---|---|---|---|
| **G28** | **`browser read` 抽取质量弱、漏 Shadow DOM 与内嵌滚屏容器** | 1) `agent-browser` (`read.rs:12-255`) 优先发 `Accept: text/markdown` 协商、探测 `/llms.txt` / `/llms-full.txt`（`--llms index\|full`）、支持 `--outline` 标题大纲与 `--filter` 章节过滤；2) `ardia` 支持 `read <url1> <url2>` 并行后台多页阅读、`read --links <pattern> -s <sel>` 批量抓链阅读、`read --scroll -s <container> --match <text>` 滚动特定容器并按文本停止、`--out file.csv` 直接输出表格、`open <url> --read` 一步直读。 | [reader.ts](../src/main/browser/ops/reader.ts#L27-L133)：`cloneNode(true)` 直接丢失 Shadow DOM；不剔除 `display:none`/`aria-hidden` 隐藏块；`walk` 只认 `H1-H6/LI/TR/PRE/CODE/P/BLOCKQUOTE`，React/Vue 里纯 `<div>` 页面要么漏正文要么回退成一整段 32KB 乱糊字符串；`SCROLL_STEP_FN` 只滚 `window`，对内嵌 `overflow:auto` 列表完全失效。 | **P1** |
| **G29** | **`diff snapshot` 噪声大，`diff screenshot` 仅算 SHA-256** | `agent-browser` (`diff.rs:21-148,278-326`)：① `diff_snapshots` 先剥离非引号内的 `[ref=eN]` 再用 Myers 统一行 Diff（带 3 行上下文，Ref 重编号不产生假变更）；② `diff_screenshot` 做真实 **RGBA 逐像素欧氏距离对比**（可配 `--threshold`），输出 `different_pixels`、`mismatch_percentage`、`dimension_mismatch` 与红灰高亮 Diff PNG；③ 支持 `diff url <u1> <u2>` 双页对比。 | [diff.ts](../src/main/browser/ops/diff.ts#L53-L149)：`diffSnapshots` 按 `role::name::idx` 桶匹配，顶部插入一项会导致后面所有同名节点全部错位误报；`diffScreenshots` 仅比较文件 SHA-256，差 1 个抗锯齿像素即判失败且无差异图和百分比。 | **P1** |
| **G30** | **缺少 2026 研发与高杠杆诊断原语** | `agent-browser` + `ardia` + `playwright-cli` + `chrome-devtools-mcp` 已普遍具备：**WebMCP**（`webmcp list/call`）、**Annotated Screenshot**（`--annotate` 在图上绘制编号 Ref 框）、**环境仿真**（`set viewport/device/geo/offline/headers/media`）、**React Fiber/Renders 诊断**（`react tree/inspect/renders`）、**Core Web Vitals**（`vitals`）、**Axe 无障碍审计**（`a11y`）、**PDF 导出**、**Chrome Trace/CPU Profile**、**只读参数化 `flow save/run`**。 | Warren 目前仅具备基础 `console`/`network`/`evidence`/`highlight`/`net mock & HAR`，尚无 WebMCP、`--annotate` 截图、完整 `set` 仿真 CLI、`pdf`、`vitals`/`a11y`/`react` 诊断及 `flow`。 | **P2** |

---

### 2.6 CLI 易用性、输出治理与安全边界

| # | 机制 / 边界情况 | 头部开源库怎么处理（源码依据） | Warren 现状与具体缺陷（源码依据） | 严重度 |
|---|---|---|---|---|
| **G31** | **缺少原子 CLI 动作命令，单步交互过于繁琐** | `agent-browser`、`playwright-cli`、`ardia browse`、`stagehand browse` 全部提供开箱即用的顶层/子级原子动作：`click` / `dblclick` / `fill`（含 `--submit`）/ `type` / `press` / `check` / `uncheck` / `select` / `hover` / `drag` / `drop` / `scroll` / `upload` / `download` / `wait` / `dialog` / `eval` / `frame` / `pdf` / `set`。 | [commands.mjs](../bin/commands.mjs#L26-L42) `warren browser` 只有观察类 + `open/back/forward/find`，**没有**直接 `click`/`fill`/`type`/`press`/`check`/`select`/`scroll`/`wait`/`dialog`/`eval`/`frame`，导致 Agent 做单个动作也必须写 `batch <<'EOF'` 或 `exec <<'JS'`！ | **P0** |
| **G32** | **无输出上限与溢出落盘保护、无 ANSI 注入过滤、无 IDPI 边界包裹** | 1) `ardia`（默认 12k/6k 字符上限）与 `playwright-cli`（快照默认写 `.playwright-cli/*.yml`）超限自动落盘并告诉 Agent 文件路径与缩窄命令；2) `chrome-devtools-mcp` (`chrome-devtools-cli.ts:281`) 强制 `stripTerminalEscapes` 防止网页标题/文本通过 OSC 52 等转义序列攻击终端；3) `agent-browser` (`--content-boundaries`) 与 `pinchtab` (`guard_shield.go:120-141`) 用不可信内容边界包裹网页输出，并针对 **GHSA-r4f2-qghj-v4hf** 用宽松正则把网页里伪造的 `</UNTRUSTED_WEB_CONTENT >` 转义为 `&lt;`，防止 Prompt Injection 逃逸边界！ | Warren CLI 原样把高达 32KB+ 的网页文本/快照直接吐到 stdout：既可能撑爆 Agent 上下文，也未剥离 ANSI 控制序列，且无 `--content-boundaries` 边界防护选项。 | **P1** |
| **G33** | **错误消息缺少机器可执行 `remedy` 与参数解析护栏** | 1) `pinchtab` (`remedy.go:1-260`) 将错误拆为 `hint`（自然语言）和 `remedy`（经 CI 校验针对真实命令树的**单行可执行 Shell 命令**）；2) `chrome-devtools-mcp` (`chrome-devtools-cli.ts:97,134-162`) 提供 `shieldLiteralArgs` 防止 `-` 开头的 JS/CSS 被 flag 解析器吞掉，并在参数用错时给出结构化 Agent 纠错范例；3) `agent-browser` (`policy.rs`) 支持 `allow`/`deny`/`confirm` 动作策略热重载。 | [commands.mjs](../bin/commands.mjs#L131-L147) `parseCliFlags` 会把 `-1` 或 `--foo` 参数值误判为 flag；错误响应只有中文 `message` 无结构化 `remedy` / `data`（如可选项、挡路者 ref）。 | **P1** |
| **G34** | **Dialog 默认策略僵硬 & `warren exec` 缺少跨轮状态与新能力对齐** | `agent-browser`/`ardia` 默认自动放行阻塞性 `alert`/`beforeunload` 并把文案写进输出（提供 `--no-auto-dialog` 关闭）；`ardia browse script` 提供会话级持久 `state` 对象与 `--out <file>`、`browse()` 逃生舱。 | Warren 遇到任意 `alert` 即全面锁死报 `DIALOG_OPEN`，需 Agent 额外耗费回合调用 `acceptDialog`；[exec-runtime.mjs](../bin/exec-runtime.mjs#L64-L149) 缺少 `read`/`find`/`get`/`is`/`diff`/`check`/`uncheck`/`scroll`/`notes` 及跨脚本 `state`。 | **P2** |

---

## 3. 架构原则：如何融会贯通而不破坏 Warren 护城河

在增强 Warren 时，必须严守 **4 条不变量**：

1. **绝不引入外部第二套浏览器栈或开放 `--remote-debugging-port`**：所有增强均落在 Warren 现有 `src/main/browser/`（唯一权威 CDP 引擎）与 `bin/`（唯一 CLI 入口），保持单进程真相与零端口探测面。
2. **绝不开 `Runtime.enable` / `Network.enable` 常驻监听**：
   - 网络在途计数改由 **Electron 原生 `session.webRequest.onBeforeRequest` + `onCompleted` + `onErrorOccurred`** 实现（零 CDP 隐身泄露！），同时修复 `Telemetry` 环形缓冲游标问题（给 `network_entries` / `console_entries` 返回 SQLite 自增 `id`，增量按 `id > beforeLastId` 切片，彻底根治 300 条满后增量为空的 Bug）。
   - 页内探针（`PROBE_JS` / `VISIBLE_JS` / 光标交互扫描 / 命中关系校验）**一律跑在 `Page.createIsolatedWorld` 隔离世界**，页面脚本完全不可见、不可篡改，延续 Warren 既有的反检测优势。
3. **100% 守住十大安全红线**：
   - 任何 Snapshot / Form Warning / Error Data / Read 输出对 `password` 与 `autocomplete="current-password|new-password"` 一律使用**定宽脱敏 `"••••••••"`**，绝不回传明文或泄露长度。
   - 新增 `storage` / `cookies` CLI 命令严格受限：`storage.cookie.read`/`write` 永留 `denied`，Cookie 搬运继续只走 `storage.cookie.port`；Vault 仍无 `reveal` 通道。
   - 新增 WebMCP 或网页返回内容必须标注 `untrusted: true`，配合 `--content-boundaries` 转义闭合标签与 ANSI 剥离。
4. **保持双 Space 与显式 `<env>` 契约**：所有新增命令与原语仍显式带 `<env>`（同时支持 `WARREN_ENV` 环境变量作为可选默认以降低重复输入，显式参数优先），写操作统一走 Agent Space Lease，默认不抢窗口前台。

---

## 4. Warren CLI v3 与浏览器内核增强路线图（P0 → P3 施工蓝图）

### Phase P0：精准性止血与核心缺陷根治（最高 ROI，建议立刻做）

> 目标：消除所有导致「点不中、输不进、看不清、假报错、假成功」的底层硬伤，使单步操作成功率追平 `agent-browser` + `Playwright` + `Browser Use`。

1. **键盘与点击物理层修复**（[input.ts](../src/main/browser/input.ts)、[actions.ts](../src/main/browser/actions.ts)、[page-helpers.ts](../src/main/browser/page-helpers.ts)）：
   - 重写 `input.ts`：引入完整 US 键盘 `VK_OEM_*` 表（彻底解决 `.` = `VK_DELETE`）、补齐 `Enter` (`"\r"`, VK=13) / `Tab` (`"\t"`, VK=9) 与全部导航键 VK 码、`Alt|Control|Meta` 组合键置空 `text`、补齐 `Esc`/`Return`/`Space`/`Up`/`Down`/`Left`/`Right`/`Ctrl`/`Cmd`/`ShiftRight` 别名与 `location`。
   - 修复 `dblclick`：改为 `Press(1) → Release(1) → Press(2) → Release(2)` 完整状态机，并引入 `PendingRelease` 在 Dialog 解决后补发挂起的 `mouseReleased`。
   - 升级点击几何（新建 `src/main/browser/click-point.ts`）：改用 `DOM.getContentQuads` 最大面积 Quad + `findIntegerPointInsideQuad`；改用 `DOM.getNodeForLocation`（叠加 `Page.getLayoutMetrics().visualViewport` 偏移）+ 隔离世界 `RELATION_JS`/`FORM_CONTROL_RELATION_JS`（支持 `<label>` 激活且拦截中间 `<a>` 链接、校验跨帧归属）。
   - 后台标签默认关闭多段 `mouseMoved` 路径（保留 `--humanize` 显式开启贝塞尔路径 + 拟人击键）。

2. **Actionability 与遮挡自恢复升级**（[actionability.ts](../src/main/browser/actionability.ts)、[actions.ts](../src/main/browser/actions.ts)）：
   - `runAction` 滚动对齐轮换：`[scrollIntoViewIfNeeded, {block:'center'}, {block:'end'}, {block:'start'}]`，自动绕过 Sticky Header/Footer。
   - **Portal 浮层保护**：`role="menuitem"|"option"` 位于 `fixed`/`absolute` 祖先内时跳过 `scrollIntoViewIfNeeded`，使用 `focus({preventScroll:true}); click()` 防止浮层关闭脱焦。
   - 补齐可见性/可用性检查：`element.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})`、`display:contents` 子节点检查、`inert` 祖先链检查、disabled `<fieldset>` 检查、DOM Clobbering 防护 (`elementSafeTagName`)。
   - 遮挡报错通过 `Accessibility.getPartialAXTree` 向上回溯输出语义挡路者（`被 [dialog "Cookie 设置"] 遮挡`）并附带可执行 `remedy`。
   - 新增**顶层模态框检测**（`:modal` / `[aria-modal="true"]` 5 点穿透），解决背景层与弹窗同名元素冲突。

3. **表单引擎深度加固**（[actions.ts](../src/main/browser/actions.ts)）：
   - `fill()` 补齐 `scrollIntoView` + `<label>`/`wrapper` 重定向；非文本输入（`date`/`time`/`color`/`range`）改用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)` 兼容 React/Vue 受控组件。
   - 清空逻辑升级为 CDP `rawKeyDown('a', commands: ['selectAll'])` + 选区兜底；点击后检测 `MOVED_JS`（穿透 Shadow DOM 的 `activeElement` 焦点转移，兼容 Combobox 浮层输入框）；采用 `insertText(chars[:-1]) + keyDown/keyUp(last)` 触发自动补全与日期选择器监听。
   - 读回校验分级：跳过 `password`、归一化 `email`/`contenteditable`、检测 UTF-16 `maxlength` 输出 `value_truncated` 警告（仅报长度不回显值），不再对格式化掩码硬抛 `FILL_UNCONFIRMED`。
   - 升级 `selectOption`：同时支持原生 `<select>` 与 ARIA `combobox`/`listbox`/typeahead；校验 disabled；失败时返回 `availableOptions` 列表。
   - 新增幂等 `browser.check` / `browser.uncheck`（含 radio 保护与自定义 ARIA checkbox 禁二次重试防撤销）。

4. **Snapshot 树重构 & 混合补盲**（[snapshot.ts](../src/main/browser/snapshot.ts)、[ops/snapshot-compact.ts](../src/main/browser/ops/snapshot-compact.ts)、[refs.ts](../src/main/browser/refs.ts)）：
   - `snapshot-compact.ts` 重写为**真实缩进层级树** + `compactTree` 保留有语义祖先链 + 合并连续 `StaticText` + 剔除冗余子 `StaticText`；修复 `-d / maxDepth` 按真实树深裁剪。
   - 引入 **3 项 DOM 混合补盲**（全部在隔离世界执行）：
     1. 光标交互扫描（`cursor:pointer` 且父非 pointer、`onclick`、`tabindex>=0`、`contenteditable`）；
     2. 隐藏 radio/checkbox 的 `<label>` 角色提升；
     3. 隐藏 `<input type=file>` 顶部补列 + `VISIBLE_JS` 过滤 `opacity:0` 幽灵文本。
   - 补齐 `INTERACTIVE_ROLES`（加 `treeitem`/`listbox`/`gridcell`/`DisclosureTriangle`/`ColorWell`）、三态 `[checked]`/`[unchecked]`/`[mixed]`、`-u` 链接 URL、`[nth=N]` 同名消歧、`<select>` `MenuListPopup` 选项摘要、密码定宽脱敏 `"••••••••"`。
   - 截断策略升级为**分级 Token 预算截断（Actionable → Context → Remainder）+ 80/20 首尾保底**，并附明确截断提示行。
   - `RefTable` 升级：每个 Ref 绑定 `(sessionId, frameId, loaderId, backendNodeId, role, name, scopeContext)`；同文档跨快照复用 Ref ID（不重编号）；原地重绘且 `(role, name, 所属容器)` 唯一时自动自愈并提示新 Ref。
   - 修复 OOPIF CSS/XPath 查询：遍历全部 `childSessions()` 隔离世界，并引入 `DOM.getDocument({pierce:true})` 支持 Closed Shadow Root 查找。

---

### Phase P1：少回合闭环、智能 Settle 与原子 CLI 体验对齐

> 目标：让外部 Agent 使用 `warren` 的流畅度、Token 效率与容错率全面追平 `agent-browser` + `ardia browse` + `playwright-cli`。

1. **补齐原子级 `warren browser` 动作命令 + `batch` 动词全量对齐**（[bin/warren.mjs](../bin/warren.mjs)、[bin/commands.mjs](../bin/commands.mjs)、[ops/batch.ts](../src/main/browser/ops/batch.ts)）：
   - `warren browser` 新增直接命令：`click [--new-tab]`、`dblclick`、`fill [--submit]`、`type [--delay]`、`press`、`hover`、`focus`、`check`、`uncheck`、`select [--by=value|label]`、`drag [--before|--after]`、`drop (--path|--data)`、`scroll [dir] [px] [-s sel]`、`scrollintoview`、`upload`、`download`、`wait <sel|ms|--text|--url|--load|--fn|--state>`、`dialog [status|accept|dismiss]`、`eval [--stdin|-b] [ref]`、`frame <sel|@ref|name|url|main>`、`pdf`。
   - `batch` 同步支持全部上述动词 + 行内 `--no-changes` / `--no-text` + `back`/`forward` 导航等待。
   - `warren exec`（[bin/exec-runtime.mjs](../bin/exec-runtime.mjs)）补齐 `check`/`uncheck`/`scroll`/`read`/`find`/`get`/`is`/`diff`/`notes` 与跨脚本持久化 `state`（环境会话级内存对象）。

2. **修复并升级 Delta Receipt 与智能 Settle**（[telemetry.ts](../src/main/telemetry.ts)、[waits.ts](../src/main/browser/waits.ts)、[ops/batch.ts](../src/main/browser/ops/batch.ts)）：
   - `Telemetry` 增挂 `session.webRequest.onBeforeRequest` + `onErrorOccurred`：维护每 Tab 在途请求 Map（忽略 WS/EventSource/Media/Ping/favicon 及存活 >1500ms 的长轮询），记录最后一次文档导航错误（供 `chrome-error://` 病因提示）；`networkEntries` 返回 SQLite 自增 `id`，`batch` 按 `id > beforeLastId` 切片，彻底修掉 300 条满后增量为空的 Bug！
   - 实现 `smartSettle()`（替代 `batch.ts` 的硬编码 150ms）：在动作前预挂导航监听器，动作后等待 `readyState !== 'loading'` + 无 1.5s 内在途请求 + 隔离世界 `MutationObserver` 安静 100ms（过滤同值属性空写与 200ms 内重复 `style` 动画），上限 3000ms 且永不抛异常。
   - `batch` 及可选单步写动作（默认开，支持 `--no-changes` 关）结束时调用增量 `snapshotWithRefs`：**Delta Receipt 中所有新增/变更节点自带立即可用的 `@N` Ref**，长列表同类节点自动折叠。

3. **重写 `browser read` 与 `browser diff`**（[ops/reader.ts](../src/main/browser/ops/reader.ts)、[ops/diff.ts](../src/main/browser/ops/diff.ts)）：
   - `read`：支持 `open <url> --read`；页内提取改用遍历 Shadow DOM + `checkVisibility` + 语义块/表格/`<div>` 文本回退；`--scroll` 支持自动识别页面最大可滚动容器或 `-s <sel>` 滚动并支持 `--match <text>`；新增 `--outline`、`--filter`、多 URL 后台并行读、`--out file.csv`；支持 `--llms index|full` 与 Markdown 内容协商（走独立环境代理与 CA）。
   - `diff`：`diff snapshot` 先剥离非引号 `[ref=@N]` 再做 Myers 统一行 Diff（附 3 行上下文）；`diff screenshot` 引入纯 JS/Electron `NativeImage.toBitmap()` 逐像素对比（无需重型原生依赖！直接用 Electron 自带 `nativeImage.createFromBuffer().toBitmap()` 拿 BGRA 像素数组即可算 `mismatchPercentage` 并生成红灰 Diff PNG！）；新增 `diff url <u1> <u2>`。

4. **CLI 安全输出治理与 Agent 友好报错**（[bin/warren.mjs](../bin/warren.mjs)、[bin/commands.mjs](../bin/commands.mjs)）：
   - 全局 `--max-output <chars>`（默认 12,000，`--full` 或 `--json` 不截断）：超限自动写入 `$WARREN_HOME/tmp/out-<ts>.txt` 并在末行输出文件路径与缩窄指令。
   - 全局 `stripTerminalEscapes` 剥离网页来源的 ANSI/OSC 转义序列；新增 `--content-boundaries`（带随机 nonce + 宽松正则转义闭合标签，防御 IDPI）。
   - 升级 `parseCliFlags` 支持 `shieldLiteralArgs` 与 `--` 终结符；为所有常见失败（`TARGET_STALE`、`DIALOG_OPEN`、`TAB_NOT_VISIBLE`、`TARGET_AMBIGUOUS`、`CONTROL_REVOKED`）补充结构化 `details.remedy`（单行可执行 `warren ...` 命令，由单测反查 `SUBS` 防漂移）与 `details.data`。
   - 新增动态超时预算分配（对标 OpenClaw `act-policy.ts`），并根据 `batch` 步数自动抬升单次 RPC 看门狗超时。

---

### Phase P2：研发联调与多模态高阶能力（差异化领先）

1. **标注截图 (`browser screenshot --annotate`)**：在隔离世界或离屏合成当前 Snapshot 各 `@N` 的边界框与编号角标，让视觉模型在 Canvas/地图/复杂图表场景下直接看图报 `@N`。
2. **环境仿真原语 (`warren browser set <env> ...`)**：支持 `viewport <w> <h> [scale]`、`device <name>`、`geo <lat> <lng>`、`offline [on|off]`、`headers <json>`、`media [dark|light] [reduced-motion]`、`tz` / `locale`（统一经 CDP `Emulation.*` 与 `Network.setExtraHTTPHeaders`）。
3. **WebMCP 协议原生支持 (`warren browser webmcp <env> list|call`)**：紧跟 2026 标准（`agent-browser` / `playwright-cli` / `chrome-devtools-mcp` 已全部落地），在 Snapshot 顶部声明页面提供的 `untrusted` WebMCP 工具，一键调用绕过复杂 UI 表单。
4. **可复用只读 Flow (`warren flow steps|save|run|list|rm`)**：借鉴 Ardia，基于现有 `Telemetry` + 录制能力，把已探索过的只读 GET/JSON 数据流沉淀为带 `--param`/`--fields`/`--where`/`--limit` 的一键调用（严格禁止落盘 Cookie/Auth Header/密码字段）。
5. **研发专项诊断 (`vitals` / `a11y` / `react` / `trace`)**：集成 Core Web Vitals 采样、Axe-core 无障碍扫描、可选 `--enable react-devtools` 的 Fiber 树与重渲染追踪、Chrome Trace/Heap 导出，强化 Warren「研发联调工作台」主阵地。
6. **动作策略与默认 Dialog 策略**：引入可选 `--auto-dialog`（自动放行阻塞性 `alert`/`beforeunload` 并在回执报告文案）与每环境 `allow`/`deny`/`confirm` 细粒度动作策略。

---

## 5. 优先级与投入产出矩阵

| 批次 | 核心模块 | 预估工作量 | 对 Agent 操控精准度/可用性提升 | 风险与兼容影响 |
|---|---|---|---|---|
| **P0-A** | 键盘 VK 码修复 + `dblclick` + `PendingRelease` + `click-point.ts` (Quads + `getNodeForLocation` + `<label>` 关系) | 2 天 | **极高**：根治标点/回车/双击/折行链接/旋转元素的静默失灵 | 零破坏，纯内部增强 + 新增单测 |
| **P0-B** | Actionability 滚动轮换 + Portal 浮层直点 + `checkVisibility`/`inert`/`display:contents` + 顶层 Modal + 语义遮挡诊断 | 2 天 | **极高**：大幅消灭 Sticky 遮挡与 Radix/MUI 弹窗点击超时 | 零破坏，可沿用现有 152 条 GUI 回归验证 |
| **P0-C** | 表单引擎（React Setter + `MOVED_JS` + `selectAll` + 末字击键 + 读回分级 + ARIA `select` + 选项回传 + `check`/`uncheck`） | 2.5 天 | **极高**：打通现代 React/Vue SPA 表单、Combobox、自定义下拉框 | 注意 `FILL_UNCONFIRMED` 兼容回归断言 |
| **P0-D** | 层级缩进 Snapshot + `-d` 修复 + 混合 DOM 补盲（cursor/hidden radio/file/`opacity:0`）+ 分级预算截断 + 文档身份 Ref + OOPIF CSS/XPath | 3 天 | **极高**：解决“看不见控件、分不清行归属、底部弹窗被截断、Ref 漂移” | 保留 `--json` 原数据结构，仅增强 `compact` 文本与增量字段 |
| **P1** | 原子 CLI 动作命令 + `Telemetry` 在途计数与游标修复 + `smartSettle` + 含 Ref 的 Delta Receipt + `read`/`diff` 像素对比重写 + 输出治理/IDPI/Remedy | 4 天 | **高**：Agent 交互轮次再降 40%–60%，防上下文爆炸与注入 | 严格加法，不破坏已有命令签名 |
| **P2** | `--annotate` 截图 + `browser set` 仿真 + WebMCP + 只读 `flow` + `vitals`/`a11y`/`react` 诊断 | 5–7 天 | **中高**：补齐 2026 旗舰差异化能力与全栈联调深度 | 可按需分批上线，全部遵循十大安全边界 |

---

## 6. 一手参考来源索引

- **Warren 本地代码**：`bin/{warren,commands,exec-runtime,page-contract}.mjs`、`src/main/browser/{actionability,actions,controller,input,keymouse,page-helpers,refs,session,snapshot,target,waits}.ts`、`src/main/browser/ops/{batch,diff,inspector,reader,snapshot-compact}.ts`、`src/main/{rpc-dispatch,telemetry}.ts`
- **vercel-labs/agent-browser** (`main`, 2026-11-26)：`cli/src/native/{snapshot,click_point,element,interaction,forms,diff,policy,webmcp}.rs`、`cli/src/read.rs`、本机 `agent-browser skills get core --full`
- **browser-use/browser-use** (`main`, 2026-11-26)：`browser_use/{ax,cli}.py`、`browser_use/browser/{browser,local}.py`
- **microsoft/playwright & playwright-cli** (`main`, 2026-11-26)：`skills/playwright-cli/SKILL.md`、`packages/injected/src/{domUtils,ariaSnapshot}.ts`、`packages/playwright-core/src/server/dom.ts`
- **ChromeDevTools/chrome-devtools-mcp** (`main`, 2026-11-26)：`src/{TextSnapshot.ts,formatters/SnapshotFormatter.ts,utils/WaitForHelper.ts,daemon/chrome-devtools-cli.ts}`
- **pinchtab/pinchtab** (`main`, 2026-11-24)：`internal/bridge/{action_resolve,action_pointer,action_form}.go`、`internal/bridge/observe/{snapshot,snapshot_format}.go`、`internal/{remedy/remedy,idpi/guard_shield,stealth/bundle,stealth/popup_guard}.go`
- **openclaw/openclaw** (`main`, 2026-11-26)：`extensions/browser/src/browser/{cdp-role-snapshot,cdp-role-snapshot-tree,act-policy}.ts`
- **ardia-browser/ardia** (`main`, 2026-11-26)：`apps/cli/install.sh`、本机 `ardia browse --help` 与 `~/.agents/skills/ardia/{SKILL.md,references/*.md}`
- **browserbase/stagehand** (`main`, 2026-11-25)：`packages/cli/README.md`、`packages/cli/src/commands/*`
- **SawyerHood/dev-browser** (`main`, 2026-11-03)：`src/page/{wait-for-load,fill}.ts`
- **Kaliiiiiiiiii-Vinyzu/patchright** (`main`, 2026-11-13)：`README.md`
- **ego-browser** (v2.2.1)：本机 `ego-browser skill`
