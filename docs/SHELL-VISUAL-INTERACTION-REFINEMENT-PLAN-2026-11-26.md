# Warren 视觉微立体、身份微彩与交互减负详细改造方案

> 状态：**方案已定稿，待分阶段实施（Phase 1 优先落地）**  
> 日期：2026-11-26  
> 分支基线：`feat/shell-layout-interaction`（`b2d4f8d`）  
> 关联文档：[`docs/SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md`](./SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md)、[`docs/ui-design-language.md`](./ui-design-language.md)、[`docs/verification/shell-layout-interaction-2026-11-26/README.md`](./verification/shell-layout-interaction-2026-11-26/README.md)  
> 评审依据：7 套本地视觉与交互 Skill（`oil-ui`、`impeccable A+B`、`refactoring-ui`、`ux-heuristics`、`design-everyday-things`、`microinteractions`、`steve-jobs-design-review`）交叉核验结论。

---

## 0. 设计北极星、总原则与改造边界

### 0.1 视觉与交互北极星：**「精密微立体 + 身份 / 插件微彩」**

Warren 90% 的停留面属于 **Operate（高频生产力工作台）**，但同时拥有三个高辨识度产品峰值：**多环境隔离身份**、**AI 人机共驾护盾**、**独立插件伴随生态**。改造目标不是把浏览器做成花哨主题壳，而是把当前“零饱和死灰、零阴影、图标墙拥挤、多处交互死胡同”的工程灰模，打磨成**冷静克制、物理纵深分明、关键身份有温度且零盲猜的精密桌面浏览器**：

1. **工具静，身份彩**：高频浏览器基础 chrome（返回/前进/刷新、查找、下载、DevTools、工作台、设置、命令栏）保持克制单色线框，仅在激活/告警/进行中点亮语义色；把色彩预算集中投向**隔离环境身份色标**、**插件品牌双色标**、**真实网页 Favicon**、**AI 护盾与高风险安全护栏**。
2. **微凹槽 vs 微凸键**：用温和的物理材质对立重建被扁平化抹平的可供性——输入槽/搜索框/开关底轨略深微凹，选中标签/Space 滑块/环境胶囊/主按钮/浮层略亮微凸并带极细顶沿高光与真实柔散暗影。
3. **先做减法，再雕质感**：先砍掉误导入口、消除死胡同空态、解决遮挡与裁切（Phase 1 优先落地），再升级表面 Token、身份微彩与微动效（Phase 2–4），最后清干净「栅栏背面」工程债并建立诚实的合成截图验收门禁（Phase 5）。
4. **硬约束不可动摇**：
   - 严格保持 `Vault`（Keychain 加密、无明文回流）与 `com.warren.accounts`（本地明文库 + 常驻 `data-slot="account-plaintext-warning"`）的入口隔离；
   - 保持 `WindowLayerManager` 五层固定 Z-Order（`below → page → devtools → shield → overlay`）；
   - AI 护盾严格绘制在原生透明 `'shield'` 视图层，**严禁**向被控网页 DOM 注入任何标记或脚本；
   - 严守 Node ESM 单测链约束（不 `import electron`、不用 TS 参数属性、相对导入保留 `.ts`）。

### 0.2 明确保留的既有优势（改造中严禁破坏）

- `40px + 40px` 双层顶栏与侧栏头齐平骨架、全局模式顶栏解耦与工作区 DOM 保活（`src/renderer/app/App.tsx:268-275`）；
- 「我的空间」零接管噪音，仅在切入 `Agent` 空间时于顶栏展示控制胶囊（`src/renderer/app/app-titlebar.tsx:309-358`）；
- 未启动环境中央带具体环境名的主启动 CTA 与 `Enter` / 地址栏输入自动拉起链路（`src/renderer/features/environments/environment-stage.tsx:548-566`）；
- 事件流来源三色区分与 `scripts/regress/` 依赖的全部核心 `data-slot` 契约。

### 0.3 全部 8 项评审 Finding → 改造阶段闭环映射

| Finding ID | 严重度 | 评审核心问题 | 归属阶段 | 目标状态 |
| :--- | :---: | :--- | :---: | :--- |
| **F1** | Critical | 归档 16 张截图存在原生视图缺失（`13` 无命令面板、`08`/`15` 无护盾像素、`03-07`/`09` 纯灰占位） | **Phase 4.2 + Phase 5.2** | 修复多图层合成截屏，建立像素级 ROI 断言门禁，全 16 态真机诚实重拍 |
| **F2** | High | 「幻影入口」+ 零按钮空态（`04`/`05` 叫用户去顶栏找不存在的「代理/账号」页；`11`/`12` 空态无居中 CTA） | **Phase 1.1**（优先） | 扩展插件宿主导航 API；抽屉空态内置一键直达按钮；全局页空态正中放置主 CTA |
| **F3** | High | `top-right` Toast 盖死右上角工具栏、`</>` 与 Agent 接管键；`sonner.tsx` 硬编码 `theme="dark"` | **Phase 1.2**（优先） | Toast 迁至舞台右下安全区 + 互斥提示内嵌「改为底部停靠」一键按钮 + 跟随深浅主题 |
| **F4** | High | 键盘焦点隐形 Bug（`TabsTrigger`/`Switch` `border-0` 吃掉 `border-focus`）+ 18 纯图标缺 `aria-label` + 零按压触感 | **Phase 1.3 + Phase 2.3 + Phase 4.1** | 恢复可见焦点环、接入 `<Tooltip>` + `<Kbd>` 与 `aria-label`、移除 `active:translate-y-0` 重建微压触感 |
| **F5** | High | 右上角 10 枚无字单色图标矩阵 + `✨` 与 AI 概念撞车 + 侧栏停止键 `□` 酷似复选框且常显易误触 | **Phase 1.3 + Phase 1.5**（优先） | 砍 `✨`、地址栏右侧瘦身至 ≤4 核心位、复制 URL 内嵌、停止键改 hover 显露实心圆角方块 |
| **F6** | High | 工作台 360px 窄栏硬塞 9 个 Tab 且无溢出线索；事件流 18/21 行单行截断无法展开 | **Phase 1.4**（优先） | 拆分内置调试与插件伴随层次 + 补左右渐隐与滚动控制 + 事件流筛选与点击展开 |
| **F7** | High | 暗色零饱和死灰平面坍塌（`#141414/#181818` CR 1.038、`hover/selected` `#2a2a2a` 撞色、阴影 4% 归零、`outline=secondary` 无边框）+ 浅色 AA 对比度失败 | **Phase 2.1–2.3** | 暗色微冷 4 层台阶 + 真实双层阴影 + 顶沿高光；浅色三级灰白 + AA ≥4.5:1 全绿 |
| **F8** | Medium | 概念模型分裂 + 三套蓝色割裂 + `human` 语义色冲突 + 内部文档 `§9` 泄露 + 全局页版心分裂 + `KeyRound` 图标缺失 | **Phase 3.1–3.4 + Phase 5.1** | 统一品牌主色、启用 `--glyph-hue` 环境色标、插件双色图标、清理内部术语与背面胶合板 |

---

## 1. Phase 1（优先落地 · 模块 A）：交互减负与死胡同修复

> **优先级：P0（首批实施）**  
> **目标**：在不强依赖大换肤的前提下，先彻底消除所有「点不到、找不到、猜不出、被遮挡、误点击」的高频交互硬伤，解决 F2、F3、F5、F6 及 F4 的可访问性部分。

### 1.1 打通插件宿主导航并消灭「幻影入口」与零按钮空态（解决 F2）

**现状根因**：
- `plugins/whistle/app.js:996` 与 `plugins/account-manager/app.js:618` 在空态卡片里指引“在顶栏切至全局「代理/账号」页”，但工作区顶栏（`src/renderer/app/app-titlebar.tsx:360-381`）只有无字拼图图标 `🧩`，根本没有文字入口；
- `src/renderer/lib/plugin-runtime.ts:327-353` 的 `PluginAppApi` 未向插件前端暴露安全导航方法，导致伴随面板无法一键跳转回自己的全局全屏页；
- `plugins/whistle/app.js:900-911` 与 `plugins/account-manager/app.js` 的全局空态仅在居中放 32px 灰图标，把唯一主按钮远挂在右上角（距空态文案 >1000px）。

**具体改动**：
1. **扩展 `PluginAppApi` 安全导航能力（纯加法，兼容 `apiVersion: "4"`）**：
   - 文件：`src/renderer/lib/plugin-runtime.ts`、`packages/plugin-sdk/`（同步类型）
   - 新增 `app.navigation`：
     - `openPage(surfaceId: string): void`：仅允许跳转**当前插件在 manifest 中声明过的 `railPage`**（`declared.has('railPage:' + surfaceId)`，fail-closed），内部调用 `openPluginPage(plugin.id, surfaceId)`（来自 `src/renderer/state/navigation-store.ts`）；
     - `openSettings(section?: 'general' | 'browser' | 'agent' | 'vault' | 'plugins' | 'diagnostics'): void`：只允许跳往白名单内安全设置分区（供账号插件引导用户到加密 `vault`）。
2. **修复 Whistle 与账号管理抽屉空态（`04`、`05`）**：
   - `plugins/whistle/app.js`（`WhistleInspectorTab` L978-998）：无已创建实例时，删除「在顶栏切至全局页」说教文案，卡片底部直接放置 `<Button size="sm" variant="default" onClick={() => app.navigation.openPage('whistle')}>前往新建代理实例 →</Button>`；有已创建实例但未绑定时保留快捷绑定列表并在底部提供「管理全部实例 →」次级入口。
   - `plugins/account-manager/app.js`（`AccountInspectorTab` L610-620）：无账号时卡片底部直接放置 `<Button size="sm" variant="default" onClick={() => app.navigation.openPage('accounts')}>新增测试账号 →</Button>`；同时在 `data-slot="account-plaintext-warning"` 明文警示卡末尾加一个轻按钮 `高敏凭据改用 Vault →`（调 `app.navigation.openSettings('vault')`）。
3. **修复全局账号/代理页空态主 CTA 远距问题（`11`、`12`）**：
   - 在 `plugins/whistle/app.js:900-911` 的 `<Empty>` 内补充 `<EmptyContent>`，直接渲染 `NewInstanceDialog` 主触发按钮（`+ 新建第一个代理实例`）；
   - 在 `plugins/account-manager/app.js` 的空态 `<Empty>` 内补充 `<EmptyContent>`，直接放 `+ 新增第一个测试账号` 主按钮；
   - 将两页头部裸露的 `variant="ghost"` 文本 `刷新` 按钮改为带 `Refresh` 图标的 `variant="outline"`（配合 Phase 2 恢复边框），消除“像静态文本”的可供性丢失。
4. **补齐内置检查器空态操作**：
   - `src/renderer/features/environments/environment-inspector.tsx:284-286`：快照未加载空态直接内嵌 `读取当前页面快照` 按钮（调 `onRefreshSnapshot`），不再只让用户去找右上角旋转图标。

### 1.2 修复 Toast 遮挡工具栏与 `sonner` 主题脱节（解决 F3）

**现状根因**：
- `src/renderer/app/App.tsx:376` 配置 `<Toaster position="top-right" offset={{ top: 8, right: 12 }} />`，刚好完全覆盖 Row 1 最右 `⌘ / 🧩 / ⚙`（以及 Agent 空间紧急「接管」按钮）和 Row 2 的 `</>`、工作台开关；
- `src/renderer/features/environments/environment-stage.tsx:220-252` 互斥提示耗时仅 3s，文字教用户「右键 `</>` 切换底部停靠」，但不仅遮住了 `</>`，还缺少一键切换按钮且没有长循环衰减；
- `src/renderer/components/ui/sonner.tsx:8` 硬编码 `theme="dark"`，浅色模式下 Toast 突兀黑块。

**具体改动**：
1. **迁至原生视图不遮挡且不盖按钮的安全区**：
   - 因 Electron `WebContentsView`（`page` / `devtools`）位于主渲染层 `below` 之上，全局 `<Toaster>` 必须留在顶栏 `80px` 安全带内才不会被网页遮住；在 `src/renderer/app/App.tsx:376` 改为 `position="top-center" offset={{ top: 6 }}`（避开右侧 `⌘ / 🧩 / ⚙`、`</>`、`◫` 与 Agent 接管胶囊）；
   - 将右侧互斥通知升级为 **地址栏下方、舞台上方的 32px 轻量 Infobar（`data-slot="panel-exclusivity-bar"`）**：位于 `stageContainerRef` 上方，自动由 `ResizeObserver` 推动原生视图下移，**100% 不被网页遮挡且 0% 遮挡顶栏/地址栏任何按钮**，内嵌一键操作按钮 **`改用底部停靠并行查看`** 与关闭按钮，并实现 Long Loop 衰减（前 3 次带教学副文案，第 4 次起精简为单行短提示 + 按钮）。
2. **修复 `sonner.tsx` 主题跟随**：
   - 在 `src/renderer/lib/theme.ts` 导出轻量 `useResolvedTheme(): 'dark' | 'light'`（基于 `MutationObserver` 监听 `document.documentElement.dataset.theme`）；
   - `src/renderer/components/ui/sonner.tsx` 改用 `theme={resolvedTheme}`，删除过时注释 `// 本应用固定深色`。

### 1.3 右上角与地址栏图标墙瘦身、语义去重与 Tooltip 补全（解决 F5 + F4 部分）

**现状根因**：
- Row 1 右侧 3 枚（`Command`、`Plug`、`Settings`）叠 Row 2 右侧 7 枚（`Viewport`、`Search`、`Download`、`Copy` | `Code`、`Sparkles`、`PanelRight`）构成 **10 枚纯线框灰图标盲猜矩阵**；
- `environment-address-bar.tsx:533` 用 `Sparkles (✨)` 充当插件随行菜单，在 AI 浏览器中造成严重认知撞车；
- 同一水平线（Row 2）出现两枚放大镜（左「搜索环境」vs 右「页内查找」）；
- `App.tsx:222` 挂了 `<TooltipProvider>`，但全仓 `<Tooltip>` 使用次数为 **0**，31 个 `<IconButton>` 仅靠慢延迟原生 `title=`，其中 **18 个缺失 `aria-label`**。

**具体改动**：
1. **彻底移除误导性 `✨` (`plugin-surfaces-trigger`)**：
   - 已核查 `scripts/regress/` 全目录 0 处引用 `plugin-surfaces-trigger`。
   - 伴随插件面板（Whistle / 账号 / 记忆）本身就是右侧工作台的 Tab；若未来插件注册 `popover` 微面板，统一收纳进工作台抽屉顶部或顶栏全局扩展菜单的「当前环境快捷面板」分组，不再在地址栏造第三个平行入口。
2. **地址栏右侧工具组从 7 枚压缩至 ≤4 个核心视觉位**：
   - **内嵌「复制 URL」进 Omnibox 右端**：平时隐藏，仅在鼠标悬停 Omnibox 或地址栏未编辑且有 URL 时于输入框内部最右侧浮现 20px 轻量复制按钮（点击就地变绿勾 `Check` 1.5s，见 Phase 4）；
   - **低频页面工具条件显性 + 合并进「页面工具 `Sliders` / `More`」弹窗**：
     - 常驻保留 3 枚核心高频研发控件：**`</>`（Chrome DevTools，右侧附微型停靠点或清晰 tooltip）** + **`◫`（Warren 工作台，或以轻文字胶囊/带活跃数字徽标呈现）** + **`⋯`（页面工具菜单：页内查找 `⌘F` / 模拟视口 / 下载记录 / 缩放）**；
     - **条件浮出（Active Chip）**：一旦 `zoomPercent !== 100`、`presetLabel` 激活或 `hasActiveDownload === true`，对应状态芯片自动显现在地址栏右侧，方便一键复位/查看，零信息丢失；
   - **地址栏 URL 主机/路径分层着色**（非编辑态）：覆盖一层与 `<input>` 完美对齐的只读展示层（focus 时切回 `<input>`），协议（`https://`）和路径（`/cap/form.html`）使用 `text-muted-foreground`，主机+端口（`127.0.0.1:8899`）使用 `text-foreground font-medium`，提升可读性与防钓鱼辨识度；
   - **侧栏收起后限制地址栏视觉跨度**：在 `environment-address-bar.tsx` 给地址栏外容器适当留白或最大阅读跨度约束（例如大屏下居中约束 `max-w-[820px]` 或弹性伸缩合理分配），避免 `09` 侧栏收起后拉成 1150px 长灰棍。
3. **Row 1 右上角全局区精简与辨识度提升**：
   - `⌘K` 命令栏按钮升级为微胶囊提示（图标 + 微弱 `⌘K` 键帽或更易识别的搜索命令提示，让 Trunk Test「搜索在哪」一眼通过）；
   - 顶栏 `Plug` 扩展按钮增加已安装活跃全局页数量微标或清晰下拉箭头，弹出菜单（尽可能切向应用内主题一致的 `DropdownMenu` 或保留原生菜单以防被网页遮挡，菜单项带上清晰分组与当前激活项勾选）。
4. **全量补齐 `<Tooltip>` + `<Kbd>` 与 18 处缺失 `aria-label`**：
   - 封装轻量 `<ActionTooltip label="..." shortcut="⌘B">{children}</ActionTooltip>`（基于已有 `@/components/ui/tooltip` + `<Kbd>`，复用 `elevatedTooltipSurfaceClass`）；
   - 优先覆盖 Row 1 与 Row 2 全部工具按钮（`environment-address-bar.tsx:337,346,355,471,482,486,499,510,537`、`environment-tabstrip.tsx:183`、`environment-sidebar.tsx:219`、`environment-stage.tsx:607`、`overlay-root.tsx:38`、`popover-root.tsx:148-222`），彻底消除纯图标无 `aria-label` 缺陷。

### 1.4 重构右侧 360px 工作台 9 Tab 导航与事件流（解决 F6）

**现状根因**：
- `src/renderer/features/environments/environment-inspector.tsx:199-240` 将 6 个内置调试 Tab（`事件`、`快照`、`控制台`、`网络`、`规则`、`存储`）与 3 个插件 Tab（`记忆`、`账号`、`代理`）平铺在同一条 360px 窄栏内并写死 `[scrollbar-width:none]`，造成 `03` 裁掉「代理」、`04`/`05` 裁掉「事件」且无任何溢出指示；
- `environment-inspector.tsx:258-272` 事件流强制单行 `truncate`，`03` 中 21 行有 18 行末尾截断，且无法过滤或展开详情。

**具体改动**：
1. **工作台 Tab 栏“双区语义分隔 + 溢出可见线索”**：
   - **视觉与心智分组**：保持全部 `[data-slot="tabs-trigger"]` 渲染在 `TabsList` 内（**100% 兼容 `scripts/regress/ui.cjs` 和 `net-n4.sh` 探针**），但用一条 `1px` 竖分隔线 + 插件微彩小图标明确区隔「内置观测（前 6 项）」与「插件伴随（后 3 项）」；
   - **溢出渐隐与翻页控制**：给滚动容器应用已有的 `scroll-fade-x` 渐隐遮罩（动态监测 `scrollLeft` / `scrollWidth > clientWidth` 仅在有溢出的一侧显示渐隐），并在左右溢出边缘提供极窄的 `18px` 轻量化 `‹ / ›` 步进按钮（或右侧提供一个「全部面板 `▾`」下拉快切菜单，列出「内置调试」与「环境插件」两大分组），彻底杜绝“隐藏 Tab 隐身”；
   - **字号底线**：确保 Tab 文字维持 `12px`（`text-xs`）+ `px-2.5` 呼吸留白，不再挤扁。
2. **事件流增强（`03`）**：
   - 顶部增加 `28px` 极紧凑筛选条：`全部` / `Agent` / `人工` / `系统` 分段胶囊 + 右侧小搜索框；
   - 时间列精简为 `HH:MM:SS` 或 `MM:SS`（完整时间戳放 tooltip），日志内容支持**单击单行展开全文**（默认单行截断保持高密度扫视，展开后等宽折行显示完整参数与复制按钮）。

### 1.5 左侧环境行重排与启停控件语法统一（解决 F5 + 截断）

**现状根因**：
- `src/renderer/features/environments/sidebar-env-row.tsx:104-140` 单行横塞「状态点 + 名称 + `max-w-[3.75rem]` Agent 标识 + 插件徽章 + 出口 + 动作键」，导致 Agent 占锁时：① `warren exec` 被截断成 `warren e...`；② 条件渲染 `env.owner === 'none'` 直接把最关键的代理出口标签隐藏了；
- `sidebar-env-row.tsx:143-152` 把「停止 `□`」设为 `alwaysVisible` 且无 `tone`（在 Hugeicons 中是空心方框，酷似未勾选复选框），而「启动 `▷`」却带 `tone="success"` 绿底盒，一裸一盒既割裂又极易在切换环境时误触停机。

**具体改动**：
1. **紧凑双行自适应结构（运行中/有副状态时自动展开轻次行）**：
   - **第一行（身份行）**：环境身份色标/运行态点 + 环境名（充分留宽，不易截断）+ 右侧统一启停动作位；
   - **第二行（状态元信息副行，`11.5px`–`12px`，紧贴名称左对齐）**：常驻展示代理出口（`直连` / `127.0.0.1:8899`），当 Agent 占锁或有插件 badge 时并排显示完整 `🤖 warren exec`（移除 `max-w-[3.75rem]` 硬截断）或插件状态芯片，**永不因为 Agent 占锁而吞掉代理出口信息**。
2. **统一启停控件语法并防误触**：
   - 停止图标改用清晰的实心/加粗圆角停止方块（或自定义精致 10px 实心圆角方块 SVG 放进 `icons.tsx`），彻底告别“像复选框”的歧义；
   - **防误触**：运行中环境的「停止」按钮改为仅在**行悬停 / 键盘聚焦**时浮现（且 hover 时呈现温和 `--destructive` 12% 红底提醒危险操作）；未启动环境的「启动 `▷`」保持柔和绿底芯片（或在选中/悬停时高亮），两者的底盒尺寸与圆角遵循完全一致的 `ListRowActionButton` 契约；
   - **补充加载过渡态**：点击启动/停止进入 `status === 'starting'` 时，行尾显示 `<Spinner />` 并禁用重复点击。
3. **顶栏环境胶囊意符补齐**：
   - `src/renderer/app/app-titlebar.tsx:253-266` 在 `• cap 直连` 胶囊右侧补上一枚 `12px` 微型 `ChevronDown` 图标，明确传达“可点击展开环境管理菜单”（同时可补齐 `focus-visible:border-focus`）。

---

## 2. Phase 2（模块 B）：微立体纵深体系与深/浅色对比度重校准

> **目标**：从单一 Token 源头（`theme-tokens.css` + `surface.ts` + `components/ui/`）根治 F7 与 F4，把死平无影的零饱和灰升级为「微冷、四阶纵深、WCAG AA 全绿」的精密桌面材质，并同步更新 `docs/ui-design-language.md`。

### 2.1 暗色模式：告别 `okC=0` 死灰，建立 4 层物理纵深与真实阴影

**量化目标对比表（`src/renderer/theme/theme-tokens.css` 暗色段）**：

| Token / 视觉层 | 现状（问题值） | 改造目标值（微冷锌靛灰阶） | 解决的实测缺陷 |
| :--- | :--- | :--- | :--- |
| `--theme-surface-under`（最底壳/侧栏/顶栏） | `#141414` (`okC=0`) | `#111317`（微冷深炭，1.5% 冷青蓝倾角） | 与主内容拉开明确明度与色温底座 |
| `--theme-surface`（工作台/卡片/设置主底） | `#181818` (`CR 1.038`) | `#181B21`（比 under 抬高 +7 RGB 阶，ΔokL ≈ 0.045） | 解决侧栏与内容区糊作一片 |
| `--surface-elevated`（新增：设置卡/活动胶囊/凸键） | 无（与 `#181818` 同底） | `#1F232B` + 顶沿 `inset 0 1px 0 rgba(255,255,255,0.06)` | 替代同底双层细框，建立微凸立体感 |
| `--input-fill`（地址栏/搜索/内凹滑槽） | `rgba(45,45,45,0.96)`（比底还亮，层次反转） | `#0E1014` + `inset 0 1px 2px rgba(0,0,0,0.45)` | 建立清晰「内凹槽」触觉隐喻 |
| `--surface-hover` vs `--surface-selected` | 7.8% vs 8.0%（**同为 `#2a2a2a`，CR 1.000 撞色**） | hover `rgba(255,255,255,0.065)`；selected `rgba(255,255,255,0.115)` + 顶边细高光 | 彻底分离悬停态与选中态 |
| `--surface-fog`（secondary/outline 底色） | 2.5% 白（`CR 1.062` 隐形） | `rgba(255,255,255,0.055)` | 次要按钮恢复可见实体感 |
| `--popover` / `--menu` | `rgb(45,45,45)` / `rgba(54,54,54,0.96)` | `#222630` / `rgba(34,38,48,0.92)` + `blur(14px)` | 浮层冷暖色温与底座统一 |
| `--elevation-popover` 阴影 | `0 3px 7.5px #0000000a`（**3.9% alpha ≈ 0 阴影**） | `0 0 0 0.5px rgba(255,255,255,0.12), inset 0 1px 0 rgba(255,255,255,0.08), 0 8px 24px rgba(0,0,0,0.48), 0 2px 6px rgba(0,0,0,0.32)` | 浮层/菜单/命令面板真正从底层“浮起来” |
| `--elevation-stage`（新增：网页舞台卡） | 无阴影 | `0 0 0 1px rgba(255,255,255,0.07), 0 4px 18px rgba(0,0,0,0.34)` | 网页画布获得精致装裱感 |
| `--subtle-foreground` | 50% 白（在 menu 上 CR 4.32 **FAIL AA**） | 58% 白（全底色 ≥ **5.4:1**，APCA Lc 显著提亮） | 消除次级中文与图标灰蒙发闷 |

### 2.2 浅色模式：独立三级灰白表面阶梯 + WCAG AA 全项达标

**量化目标对比表（`src/renderer/theme/theme-tokens.css` `:root` 浅色段）**：

| Token / 视觉层 | 现状（问题值） | 改造目标值 | 解决的实测缺陷 |
| :--- | :--- | :--- | :--- |
| `--theme-surface-under`（顶栏+侧栏托盘） | `#eff1f4` | `#E9EDF2`（略深一档冷银灰） | 强化托盘对白卡片的托举感 |
| `--surface-drawer`（新增：右侧伴随工作台底） | `#ffffff`（与纯白网页粘连塌陷） | `#F5F7FA`（次浅灰，与 `#FFFFFF` 网页舞台清晰分层） | 解决 `14`/`15` 右侧工作台与纯白网页融成一片 |
| `--theme-surface`（网页舞台/凸起卡片/主画布） | `#ffffff` | `#FFFFFF` + 轻影 `0 1px 3px rgba(15,23,42,0.07), 0 0 0 1px rgba(15,23,42,0.07)` | 白色卡片立体浮出 |
| `--input-fill`（地址栏/搜索内凹槽） | 3.5% ink（融化在灰底里） | `rgba(15,23,42,0.055)` + 边框 `rgba(15,23,42,0.12)` + 微内影 | 解决 `14` 左上角搜索框轮廓融化 |
| `--subtle-foreground` | 50% `#141414`（**CR 3.36–3.48 FAIL AA**） | `#525B6B`（在 `#E9EDF2` 上 CR **5.8:1**，在白底 **6.9:1**） | 全站浅色 ghost 按钮/Tab/占位符全面通过 WCAG AA |
| `--warning` | `#d97706`（灰底 **CR 2.77 FAIL 3:1**） | `#B45309`（白底 **5.02:1**，灰底 **4.35:1**，配 `#FEF3C7` 暖琥珀底） | 明文账号安全警示在浅色模式下清晰有力 |
| `--accent-seed` / `--success` | `#0d6efd`（灰底 3.98）/ `#008635`（4.16） | `#2563EB`（或品牌深靛 `#3B5BDB`，灰底 ≥ **4.8:1**）/ `#047857`（≥ **4.7:1**） | 浅灰顶栏/侧栏上的语义文字全达 AA 4.5:1 |
| `StatusDot` `idle` | `muted/40`（浅色 **CR 1.76** / 暗色 **2.32**） | 独立 `--status-idle`（暗 `#64748B` ≥3.5:1 / 浅 `#64748B` ≥3.8:1） | 非文本状态指示全面通过 WCAG 3:1 |

### 2.3 基础原语与焦点/字号契约修补（解决 F4 + F7）

1. **分离 `Button` 的 `outline` 与 `secondary` 变体（`src/renderer/components/ui/button.tsx:32-35`）**：
   - `outline`：恢复真实描边 `border-border-heavy bg-surface-elevated/60 hover:bg-surface-hover` + 顶部极细高光 `shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]`（浅色微影 `shadow-2xs`），让 `02`「编辑配置」、`10`「打开目录」、`11`/`12`「刷新」一眼具备“可点击实体键”可供性；
   - `secondary`：保留无框柔雾洗（`bg-surface-fog` 提亮至 5.5%），用于低权重分段项；
   - `default`（主按钮）：保留高对比聚焦感，增加细腻微高光与柔和底影，在需要品牌情绪的入口（或全站统一评估）支持 `brand` 变体（见 Phase 3.1）。
2. **修复 `TabsTrigger` 与 `Switch` 隐形键盘焦点 Bug（`tabs.tsx:53-54`、`switch.tsx:20-23`）**：
   - 删除错误叠加的 `border-0`，改为 `border border-transparent`（保持与 `controlFocusClass` 的 `focus-visible:border-focus` 兼容，或对无框组件改用 `focus-visible:outline-1 focus-visible:outline-focus focus-visible:-outline-offset-1`），实测 Tab 键遍历全界面每个可交互控件均可见清晰发丝焦点。
3. **以面代线重修 `cardSurfaceClass`（`src/renderer/theme/surface.ts:37-39`）**：
   - 改为 `bg-surface-elevated/70 border border-border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]`（浅色 `bg-card border-border shadow-[0_1px_2px_rgba(15,23,42,0.04)]`），解决 `10` 设置页大卡片与背景死贴、内嵌双框线的问题。
4. **收口 Token 漂移**：
   - 清理全部 10 处 `text-[10px]`（提升至 `text-[length:var(--font-size-micro)]` 即 `11px` 或 `12px`，严禁中文功能字 `<11px`）；
   - 将 24 处裸 `text-[11px]` 收口到 `text-[length:var(--font-size-micro)]`；
   - 统一 `environment-stage.tsx:513` 舞台圆角与 `general-panel.tsx:99` 一致（`rounded-[var(--radius-sm)]` 或明确 `8px` 变量 `--shell-stage-radius`，并同步 `InputShield` `#aura` 圆角，解决 `6px` vs `8px` 缝隙）。

---

## 3. Phase 3（模块 C）：身份与插件微彩系统（工具静 · 身份彩）

> **目标**：解决 F8 的“三色割裂、品类可互换、满屏灰拼图”问题，让界面一眼认得出是 Warren，同时绝不污染浏览网页的纯净度。

### 3.1 统一 Warren 品牌主光色与空态材质桥接

- **根除三套蓝色分裂**：
  - 现状：`WarrenMark` 3D 兔子（紫蓝 `#5B6CFF`/`#7C3AED`）vs `--theme-accent` 系统蓝（`#339cff`/`#0d6efd`）vs `InputShield` 天蓝→靛紫（`#38bdf8 → #818cf8`）。
  - 方案：从 `WarrenMark` 提炼唯一品牌种子色 **`--theme-accent`**：
    - 暗色：`#5B8CFF`（电光靛蓝，既呼应兔子色相，在 `#181B21` 底上 CR ≈ **6.1:1** 远超 AA）；辅色渐变终点 `#38BDF8`（仅用于 AI 护盾扫光与品牌微光）；
    - 浅色：`#3B5BDB`（沉稳靛蓝，在 `#E9EDF2` 灰底上 CR **5.3:1** 达 AA）；
  - 全站 Focus 发丝、设置页选中态、Agent 控制胶囊与 AI 护盾边缘统一取自这套品牌色系，实现“从 Logo 到交互”的完整血统贯通。
- **消除 `02` 未启动空态 3D 兔子与平灰底的材质断层**：
  - 在 `environment-stage.tsx:518-520` 为 `<WarrenMark>` 增加柔和的承载舞台：一个带极淡同色系径向环境微光（`radial-gradient` 靛蓝 10% 透明渐变）+ 微凸磨砂圆角托盘（`size-16 rounded-[var(--radius-2xl)] bg-surface-elevated/80 border border-border-heavy`），并在空态下方紧凑补充环境摘要芯片（出口代理、已保存站点/上次 URL、绑定插件徽章），让休眠环境像“待唤醒的独立工作舱”。

### 3.2 激活 `--glyph-hue-1..8` 隔离环境身份色标系统

- **已预埋但闲置的资产**：`src/renderer/theme/theme-tokens.css:160-167` 已定义了 8 组色相（`210 / 160 / 35 / 280 / 10 / 320 / 190 / 55`）。
- **设计方案**：
  - 在 `src/renderer/lib/env-identity.ts`（纯前端映射，后续可按需扩展 `Environment.colorHue?: number` 持久化）按 `env.id` 稳定哈希映射到 8 组精选低刺眼 OKLCH 身份色（暗色高明度低饱和 `oklch(0.72 0.12 H)`；浅色中深明度 `oklch(0.52 0.14 H)`）；
  - **落点 1 — 侧栏环境行**：每个环境名左侧展示一枚 `18×18` 圆角身份微章（柔和 14% 身份色底 + 首字母/环境小图标 + 右下角 `6px` 真实运行态绿/灰/红圆点），**彻底解耦“这是哪个环境”与“它是否在运行”**；
  - **落点 2 — 顶栏环境胶囊（`app-titlebar.tsx:253`）**：左侧携带同一枚环境身份色微章，实现从左侧树到顶栏的一眼色彩映射。

### 3.3 建立插件专属双色/微彩徽标体系

- **清单与运行时补齐**：
  - 给现有内置插件 `package.json#warren` 补齐顶层 `icon` 与语义色相（或在 `src/renderer/lib/plugin-brand.ts` 维护内置插件品牌色与通用第三方插件基于 `pluginId` 哈希的回退色）：
    - `com.warren.whistle`（Whistle 代理）：图标 `Globe` / 路由网标 + **青碧色（hue 190）**；
    - `com.warren.accounts`（账号管理）：图标 `Key` + **暖琥珀色（hue 38）**；
    - `com.example.notes`（记忆）：图标 `List` / 书签标 + **靛紫色（hue 275）**；
  - **修复 Bug**：将 `plugins/example-login/package.json:56` 中不存在的 `"icon": "KeyRound"` 修正为 `"icon": "Key"`（或在 `icons.tsx` 补充别名），消除静默退回 `Zap` 的问题；
  - **设置侧栏去同质化**：在 `src/renderer/lib/plugin-runtime.ts` 让 `PluginSettingsSection` 透传 `icon?: string`，修改 `src/renderer/features/settings/settings-page.tsx:128` 优先读 `pluginSection.icon` 或插件顶层 `icon`，不再把「插件管理 / 记忆使用说明 / Whistle 使用说明」全写死成 `Plug` 灰拼图！
- **4 处克制落地（绝不喧宾夺主）**：
  1. 全局顶栏居中导航胶囊（`10`/`11`/`12`）：每个插件 Tab 图标使用 16px 双色微彩（未选中 75% 饱和度，选中 100% + 微底光）；
  2. 右侧工作台伴随插件 Tab（`03`/`04`/`05`）：插件 Tab 标题前带 12px 专属微彩图标，一秒区分“内置调试 6 项”与“插件能力”；
  3. 设置 → 插件管理 `PluginCard`（`src/renderer/features/plugins/plugins-panel.tsx:162-226`）：卡片左上角增加 `32×32` 柔和品牌色底圆角图标盒，彻底摆脱“干瘪纯文字灰框”观感；
  4. 全局扩展菜单与插件全屏页头部：页头左侧配 `28×28` 插件微彩图标盒 + `text-lg font-semibold` 清晰主标题。

### 3.4 统一全站语义色

- 将 `src/renderer/features/environments/environment-inspector.tsx:27` 的 `actorClass.human` 从 `text-[var(--warning)]`（警告橙）修正为 `text-[var(--success)]`（翡翠绿），与顶栏接管胶囊、侧栏用户图标、Space 切换器 100% 统一；
- 统一全仓 `--theme-accent` 与 `--info` 混用（业务语义状态统一走 `--info`，焦点/选中交互统一走 `--accent-seed` / `--focus`）。

---

## 4. Phase 4（模块 D）：微交互手感与 AI 护盾招牌时刻

> **目标**：把“点在静态 PDF 图上”的生硬跳变升级为 `<100ms` 响应、`150–220ms` 物理过渡的灵动桌面手感，并把 AI 护盾打造成 Warren 最具记忆点的 Signature Moment。

### 4.1 物理触感与高频微交互打磨（解决 F4 触感部分）

1. **按钮与列表行触感复活**：
   - `src/renderer/components/ui/button.tsx:22`：移除死锁的 `active:translate-y-0`，对文本按钮与主操作增加 `transition-[background-color,border-color,box-shadow,transform] duration-150 active:scale-[0.98]`（`motion-reduce:active:scale-100`）；
   - `src/renderer/components/ui/list-row.module.css`：为 `.row` 与 `.actions` 添加 `transition: background-color 140ms ease, opacity 140ms ease`；添加 `.row:active` 微压暗反馈；修复无 `tone` 动作按钮的 `background: transparent !important` 覆盖问题，允许 hover/active 展现清晰反馈。
2. **Signature Moment #1 — 实体滑动指示块（Sliding Pill）**：
   - 应用于两处最高频分段切换：`EnvironmentSpaceSwitcher`（`我的 | Agent`）与全局导航条（`设置 | 记忆 | 账号 | 代理`）；
   - 外轨采用微凹槽材质（`--input-fill` + `border-border`），激活滑块采用微凸键材质（`--surface-elevated` + 顶沿 `1px` 高光 + 柔和暗影），切换时以 `200ms cubic-bezier(0.22, 1, 0.36, 1)` 平滑滑动到位（尊重 `prefers-reduced-motion`）。
3. **就地微反馈（零打扰闭环）**：
   - 地址栏「复制 URL」与环境菜单「复制 CLI 寻址」：点击后图标就地切换为绿色 `Check` 并伴随微缩弹出动画（`1.5s` 后平滑复原），同时对 CLI 复制给极简短确认，消除“点完不知成没成”的评估鸿沟；
   - 设置/插件全屏覆层切换（`App.tsx:346-370`）与 Hover URL 预览条（`environment-stage.tsx:571`）：补充 `150ms` 轻淡入过渡，消除瞬闪。
4. **邻近映射优化（Space 切换与控制权胶囊）**：
   - 在 `app-titlebar.tsx` 保持 `控制权胶囊` 仅在 Agent 空间出现的同时，为 `EnvironmentSpaceSwitcher` 的 `Agent` 分段增加清晰状态色圈（AI 活跃时靛蓝脉冲环、人类接管时翡翠绿环），切入 Agent 空间时控制胶囊以轻柔 `180ms` 展开入场，建立“点这里 → 看那边接管”的因果视觉连线。

### 4.2 AI 护盾真机高辨识度升级与空闲态减压（解决 F1 部分 + 体验峰值）

1. **提升 `InputShield` 光学对比度（`src/main/input-shield.ts`）**：
   - 统一使用 Warren 品牌靛蓝→青色流光（暗色 `#5B8CFF → #38BDF8`；浅色白底采用高对比深靛→深青 `#2563EB → #0284C7`，边缘主框 `2.5px` + 内晕 `28px`），确保在纯白网页上依然满足 **≥3:1** 清晰外框辨识度；
   - **解决长思考期状态失语**：在护盾舞台右上内角（避开左下 URL 预览和右下 Toast，且支持被目标锚框靠近时自动平移避让）增加一枚极薄毛玻璃微型活动胶囊（如 `✦ warren exec · 正在填写表单` / `等待下一步指令…`），不会像旧版底部黑药丸那样遮挡页面底部结账栏或分页条，却让视线停在网页内部的用户始终有安全锚点；
   - **人机交接签名动效**：从 `agent` 切换到 `human`（点击「接管」）时，触发一次 `260ms` 边缘由靛蓝转翡翠绿并向外收拢淡出的交接光波，再卸载阻断层，赋予“从 AI 手中接过方向盘”的真实掌控感。
2. **缓和 `07` Agent 空闲只读态的压迫感**：
   - `input-shield.ts:27` 空闲态（`data-mode="idle"`）移除令人误以为卡死的全局红色/灰色 `cursor: not-allowed`，改用温和默认指针 + 清晰 `1.5px` 低饱和虚线/冷灰内边 + 顶部/右上极轻可折叠引导签（`Agent 空间当前空闲 · 点击右上「接管编辑」可手动操作`），既保住 `3A` 防与脚本抢锁的只读安全裁决，又彻底消除新用户误判软件死机的情绪低谷。

---

## 5. Phase 5（模块 E + 诚实演示门禁）：清理「栅栏背面」工程债与真机合成验收

> **目标**：把平时没人爱演示的设置页、插件全页、检查器空态、验收截图流程全部打磨到与主界面同等工艺水准，彻底闭环 F1 与 F8。

### 5.1 清理「栅栏背面」工程债与内部术语泄露

1. **清除内部工程术语泄露**：
   - `src/renderer/features/environments/environment-inspector.tsx:382`：将 `（见 PLUGIN-CAPABILITY-DESIGN §9）` 替换为面向最终用户的平实安全说明：`出于安全策略，此处仅展示 Cookie 名称、作用域与安全标志，不回传明文值（S = Secure，H = HttpOnly）。`；
   - `src/renderer/features/environments/environment-inspector.tsx:96-98`：将裸命令行提示包装成带可一键复制芯片的结构化指引卡（保留 CLI 命令给高级用户，同时说明也可在 Whistle 代理页图形化配置规则）。
2. **统一三套全局全屏页的版心网格与主标题层级（`10`、`11`、`12`）**：
   - 制定统一全局页容器契约：无侧栏全局全页（`11` 账号管理、`12` Whistle 代理、记忆全页）统一居中版心 **`max-w-[1040px] mx-auto px-6 py-5`**；页头统一结构为「左侧 28px 插件微彩图标盒 + `text-lg font-semibold` 主标题 + 柔和副指标，右侧标准操作按钮组」；
   - 修复 `10` 设置页（`src/renderer/features/settings/settings-page.tsx:237`）右侧内容区在大屏左贴产生 500px 黑洞的问题：内容区放宽至 `max-w-3xl` 并合理留白居中于右侧主面板；
   - **修正 `10` 设置页标签/数值层级倒置与说明减负**：
     - `general-panel.tsx:113-114`：数据根目录改为上方 `12px muted` 辅助标签「数据根目录（WARREN_HOME）」，下方 `13.5px foreground font-mono` 突出显示真实路径；
     - `general-panel.tsx:59-75`：主题选择卡为「深色 / 浅色 / 跟随系统」补上极简 48×30 迷你窗口预览缩略图，提亮副文案对比度（去掉二次 `opacity-75` 叠加）；
     - 精简各设置卡片下过长的说教文案（落实 Krug「删掉一半字」原则），并评估将「网页与 DevTools 8px 圆角」开关默认收口或归入高级折叠区，减少低价值偏好噪音。
3. **精简冗余文案**：
   - `02` 未启动态去掉地址栏 placeholder 与中央底部说明的同屏复读（地址栏保持简洁「输入网址回车自动启动…」，中央辅助行精简为 `按 Enter 立即启动`）；
   - `05`/`11` 账号明文警示条压缩至 20 字内高信息密度句，辅以暖琥珀底色（`bg-[var(--warning)]/12 border-[var(--warning)]/35`）+ `高敏凭据用加密 Vault →` 跳转按钮。

### 5.2 修复原生多图层合成截图与自动化像素门禁（根治 F1）

**根因排查重点**：
- `WindowLayerManager` 将 `page`、`devtools`、`shield`、`overlay` 作为独立原生 `WebContentsView` 挂载在 `BrowserWindow` 上。使用 `screencapture -x -o -l <CGWindowID>` 抓图时，若窗口未处于前台激活态、未等待子 `WebContentsView` 的 GPU 合成帧提交（`invalidate()` + `rAF`）、或目标环境页面未真正完成加载导航，子视图图层会退化为纯灰占位底（`RGB=[36,36,36]`）或完全漏截（如 `13` 命令面板与 `08`/`15` 护盾）。

**具体修复与门禁方案**：
1. **升级实机验证抓图链路**：
   - 在验证脚本中先调用 `debug.focusWindow` 确保窗口位于当前 Space 前台并获取真实窗口矩形；
   - 触发状态切换（切 Tab、开 DevTools、激活动作轨迹、弹 `⌘K` Overlay）后，显式等待对应视图就绪信号（`debug.layout` 验证 `viewVisible` / `overlayOpen` / `shieldMode` + 至少 2 个合成帧间隔）；
   - 使用 `screencapture -x -R x,y,w,h`（或核验 Electron `win.webContents.capturePage` 与屏幕区域截取的合成差异），确保包含全部原生合成图层。
2. **新增强制像素/ROI 断言（不通过禁止宣称 PASS）**：
   - **`03`–`07`、`09`（带网页/DevTools）**：裁剪舞台 ROI，断言像素标准差 `std > 5.0`（杜绝纯灰占位 `RGB=36, std=0` 蒙混过关）；
   - **`06a`/`06b`（DevTools）**：校验右侧或底部 DevTools 区域像素分布与非零宽度/高度；
   - **`08`/`15`（AI 活跃护盾）**：对舞台四边 `8px` 边缘环带进行像素采样，**断言品牌靛蓝/青色像素占比超过设定阈值**，同时在 `showAction` 触发瞬间截获虚拟指针与锚框像素；
   - **`13`（`⌘K` 命令面板）**：断言窗口中央 500×360 ROI 存在显著弹窗面板对比度且四周背景存在压暗遮罩。
3. **重拍并替换归档**：全部 5 个 Phase 落地后，在 `docs/verification/` 重新生成完整 16 张诚实实机截图并做新一轮盲审复核（目标：`impeccable` ≥ **32/40**，其余 5 框架 ≥ **8/10**）。

---

## 6. 影响文件清单与回归保护矩阵

### 6.1 分阶段核心改动文件

| 阶段 | 核心改动文件 |
| :--- | :--- |
| **Phase 1（优先）** | `src/renderer/lib/plugin-runtime.ts`、`packages/plugin-sdk/*`、`plugins/whistle/app.js`、`plugins/account-manager/app.js`、`src/renderer/app/App.tsx`、`src/renderer/components/ui/sonner.tsx`、`src/renderer/lib/theme.ts`、`src/renderer/app/app-titlebar.tsx`、`src/renderer/features/environments/environment-address-bar.tsx`、`src/renderer/features/environments/environment-stage.tsx`、`src/renderer/features/environments/environment-inspector.tsx`、`src/renderer/features/environments/sidebar-env-row.tsx`、`src/renderer/components/icons.tsx` |
| **Phase 2** | `src/renderer/theme/theme-tokens.css`、`src/renderer/theme/surface.ts`、`src/renderer/components/ui/button.tsx`、`src/renderer/components/ui/tabs.tsx`、`src/renderer/components/ui/switch.tsx`、`src/renderer/components/ui/status-dot.tsx`、`docs/ui-design-language.md` |
| **Phase 3** | `src/renderer/lib/env-identity.ts`（新建）、`src/renderer/lib/plugin-brand.ts`（新建）、`src/renderer/features/settings/settings-page.tsx`、`src/renderer/features/plugins/plugins-panel.tsx`、`plugins/whistle/package.json`、`plugins/account-manager/package.json`、`plugins/example-notes/package.json`、`plugins/example-login/package.json` |
| **Phase 4** | `src/renderer/components/ui/button.tsx`、`src/renderer/components/ui/list-row.module.css`、`src/renderer/features/environments/environment-space-switcher.tsx`、`src/renderer/app/app-titlebar.tsx`、`src/main/input-shield.ts` |
| **Phase 5** | `src/renderer/features/settings/general-panel.tsx`、`src/renderer/features/settings/settings-page.tsx`、`src/renderer/features/environments/environment-inspector.tsx`、`plugins/whistle/app.js`、`plugins/account-manager/app.js`、`docs/HANDOFF.md`、`docs/verification/*` |

### 6.2 回归选择器保护清单（严禁破坏）

- `[data-slot="inspector-toggle"]`（含 `aria-expanded`，被 `scripts/regress/ui.cjs`、`net-n4.sh` 使用）
- `[data-slot="env-capsule"]`、`[data-slot="control-pill"]`、`[data-slot="surface-tab"]`、`[data-space="agent"][data-active]`（`ui.cjs`）
- `[data-slot="tabs-trigger"]`、`[data-slot="net-rule"]`（`net-n4.sh`、`ui.cjs`）
- `[data-slot="account-plaintext-warning"]`（安全合规探针，`ui.cjs`）
- `[data-slot="devtools-toggle"]`、`[data-slot="stage-start-button"]`

---

## 7. 验收标准与强制门禁（每个 Phase 完成后执行）

1. **静态与构建全门禁**：`npm run check`（串联 `oxlint`、`prettier:check`、`tsc --noEmit`、`npm test`、`vite build`）全绿，单测只增不减（补充 `plugin-runtime` 导航白名单单测、`env-identity` 色标映射单测、`sonner`/对比度检查与 `input-shield` 护盾模式单测）。
2. **对比度量化验收**：复用 Python WCAG 2.1 脚本复测暗/浅两套主题全部文本与非文本 Token，正文与次级标签 **100% ≥ 4.5:1**，非文本图标/状态点/护盾边框 **100% ≥ 3.0:1**，暗色 `hover` 与 `selected` 明显分离。
3. **无障碍与交互自检**：纯键盘 `Tab` 遍历全界面（含 `TabsTrigger`、`Switch`、环境胶囊）焦点环 100% 可见；所有 `<IconButton>` 均具备 `aria-label` 与统一 `<Tooltip>`。
4. **实机回归与诚实截图复审**：按 `AGENTS.md` 清理进程与 `~/.warren/envd.sock` 后重启实机，通过 `debug.layout`、`bash scripts/regress/run-all.sh`（0 FAIL）及带像素 ROI 断言的 16 态真机重拍，最终执行一轮独立盲审验收。
