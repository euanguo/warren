# Warren 外壳布局、交互重整与 AI 操作蒙层改造计划

> 状态：**决策已拍板，待分阶段实施**  
> 日期：2026-11-26  
> 关联前置：`AGENTS.md`、`docs/HANDOFF.md`、`docs/WARREN-2.0-ARCHITECTURE-PLAN.md`、`docs/CHROME-SHELL-PLAN.md`、`docs/PLUGIN-CAPABILITY-DESIGN.md`  
> 参考探索画布（Doop 方案 B）：`https://doop.design/c/-FRone_QvM`（仅作空间分层参考；**视觉 Token 与组件库重绘推迟到本计划布局交互调准之后**）

---

## 0. 改造边界与总原则

1. **先调结构与交互，暂不动组件库与视觉 Token**：
   - 本期不重做 `src/renderer/components/ui/*`、`src/renderer/theme/surface.ts` 及色板体系，仅按需调整 `src/renderer/theme/theme-tokens.css` 中的少量外壳宽高布局变量。
2. **保留全部既有安全硬约束与主进程架构基线**：
   - `Vault`（系统 Keychain 加密、无明文回传）与 `账号管理` 插件（`com.warren.accounts` 本地明文库 + 强制 `data-slot="account-plaintext-warning"` 提示）**严禁混淆入口**；
   - 保持 `WindowLayerManager` 五层固定 Z-Order：`below → page → devtools → shield → overlay`（`src/main/ui/layer-manager.ts`）；
   - AI 蒙层动画**严格绘制在独立原生透明视图 `'shield'` 槽位**（`src/main/input-shield.ts`），不向被控网页 DOM 注入任何标记或脚本；
   - **第一阶段暂不上双环境分屏（Split View）**，待单窗单环境布局交互稳定且底层 `'page'` 槽位支持多栏后再另行立项。

---

## 1. 问题诊断与已拍板的核心交互裁决

### 1.1 针对方案 B 草稿与现行外壳的 6 项结构修正

| # | 原方案 / 现行代码痛点 | 引发的用户体验问题 | 本次修正方向 |
|---|---|---|---|
| 1 | 方案 B 删掉了 `EnvironmentSpaceSwitcher`；现行 `app-titlebar.tsx` 在「我的空间」也始终渲染 `Agent 空闲 [接管 Agent]` | 用户无法在「我的」与「Agent」双空间间切换观察；停在「我的」空间却看到接管按钮，误点会把视角强行切进 Agent 空间 | **保留并前置 `我的(n) \| Agent(n)` 到 Row 1 紧跟环境胶囊之后**；控制权胶囊只在切入 `Agent` 空间时展示接管/交还动作 |
| 2 | 方案 B 将 Chrome DevTools 强塞入右侧 320px 互斥工作台抽屉，并与地址栏 `</>` 形成双入口 | 320px 太窄导致 DevTools 难以查看 Elements/Network，且无法底部停靠或与 Whistle/检查器同看 | **DevTools 保持独立停靠宿主（右/底/独立窗）**；抽屉只做 Warren 专属调试，地址栏 `</>` 只管原生 DevTools |
| 3 | 去掉 `AppRail` 后将 `warren://settings` 伪装成单环境 Tab；现行 `App.tsx` 打开全局页时 `sidebarVisible = false` 直接卸载侧栏 | 全局设置挂在 `alpha` 标签下造成归属错乱；切回环境时侧栏搜索词、滚动位置丢失且触发首帧宽度重算 | 切入全局视图时 **Row 1 切换为明确的全局导航条（`← 返回环境 [<name>]`）**；侧栏改用视觉隐藏保活、不卸载 DOM |
| 4 | 高频开关（视口预设、`⌘F`）被藏进 `⋯`；工具栏中 `Vault` 与明文 `账号` 插件概念混贴、插件名称写死在地址栏 | 研发工具发现性下降；混用破坏安全信任心智；新增插件会导致地址栏横向溢出 | 显性保留视口/查找/下载/DevTools；通过统一扩展入口动态挂载插件 `popover` 与全屏 `railPage`，严格区分 Vault 与账号插件 |
| 5 | `Agent 操作中` 四重重复提示，且 `input-shield.ts` 底部 `bottom: 14px` 胶囊常驻遮挡页面底部按钮 | 遮挡网页底部结账栏、分页条或固定底部 CTA | 取消常驻底部黑药丸；改用**边缘呼吸光晕 + 实时 AI 动作轨迹 + 误点才在指针旁轻量提示** |
| 6 | 选中未启动环境后，中央空态提示「点击左侧 `▶` 启动」，多一次折返移动；分屏在单 `page` 槽位下语义未闭环 | 单击左侧停机环境出现死路提示，操作断裂 | 空舞台中央直接放置 **`启动「<env.name>」`** 主操作与快捷键；第一阶段暂不上分屏 |

### 1.2 三项交互细节裁决（已确认）

1. **右侧互斥策略（1A）**：当 DevTools 设为右侧停靠且屏幕/舞台宽度较紧凑（打开会挤压网页剩余宽度 `< 520px`，或 `< 1280px` 视口下）时，**原生 DevTools（右侧）与 Warren 工作台抽屉二选一互斥**（开一收一）；若用户将 DevTools 设为 `bottom` 或 `detach`，可与右侧工作台抽屉自由并存。
2. **「环境未启动」点击直觉（2A）**：左侧列表**单击仅选中不误拉起进程**；舞台正中央直接提供醒目的 **`启动「<env.name>」`** 按钮（并支持 `Enter` 快捷键及在 Omnibox 直接输入 URL 回车自动启动后导航）。
3. **`Agent` 空间空闲态控制权（3A）**：进入 `Agent` 空间且 `owner === 'none'` 时，**保持只读防误操作**（避免人手点时恰好与脚本抢锁），顶部状态区明确显示「Agent 空间空闲（只读）· `[接管编辑]`」，点击后主动获取 human lease。

---

## 2. 调整后的总体布局与信息架构

| 区域 | 职责与展示内容 | 关键交互与生命周期规则 |
|---|---|---|
| **Row 1 · 窗口与上下文行** | macOS 红绿灯留位 · `☰` 侧栏折叠 · **当前环境胶囊**（状态点+名称+出口摘要，右键复刻环境菜单） · **`我的(n) \| Agent(n)` 空间切换器** · 当前空间 Tabs + `+` · 右侧：`[控制权胶囊（仅 Agent 空间显示）]` + `⌘K` + `⊞ 全局扩展入口` + `⚙ 设置` | 进入 `设置` 或 `插件全屏页` 时，这行整体切换为全局导航条（`← 返回环境 [<name>]` + 全局页切换 Tabs），隐藏环境胶囊与地址栏；切回环境零延迟恢复 |
| **Row 2 · 地址与研发条** | `← → ↻` · **Omnibox**（安全态 + URL + 加载态；未启动回车可先启后跳；`Agent` 只读态锁定） · `[缩放% ≠100%显]` · `[视口预设]` · `[页内查找 ⌘F]` · `[下载]` · `[复制 URL]` · `[DevTools </>]` · `[插件快捷入口]` · `[工作台抽屉 ◧]` | `</>` 只管 Chrome 原生 DevTools（左键开关，右键切 `right/bottom/detach`）；`◧` 只管 Warren 工作台抽屉 |
| **Left · 环境树** | 顶部单行 `[搜索框] [+ 新建]` · 可折叠分组列表 · 稳定排版环境行（状态点 + 名字 + 出口 + 占锁方/`envBadge`） · 底部运行统计 + `+ 分组` | 支持 `⌘B` 彻底收起至 `0px`；点击 `envBadge` / 错误计数可直接跳转到对应检查器面板；状态切入全局页时不卸载组件树 |
| **Center · 网页主舞台** | 纯净网页视图 + 左下角 `update-target-url` 悬停预览；停机态中央展示 `启动环境` CTA；`Agent` 态上覆透明 `'shield'` 蒙层 | `PopoverHost` 与 `OverlayHost` 独立子窗悬浮于顶层，**绝不隐藏底层网页** |
| **Right · Warren 工作台抽屉** | 专注「伴随当前环境页面」的高频调试面板：`事件` · `快照` · `控制台` · `网络` · `规则` · `存储` + 插件注册的**环境随行 Tab**（Whistle 快捷预设、当前站账号一键直填、页面笔记） | 全量 CRUD 类视图（多 Whistle 实例管理、全量账号编辑/导出、笔记全库、插件管理）统一保留在全屏模式，不硬塞进窄抽屉 |

---

## 3. 分阶段实施路线图

### Phase 1：外壳重构（两层顶栏 + 去除 `AppRail` + 全局状态保活）

- **核心文件**：
  - `src/renderer/app/App.tsx`
  - `src/renderer/app/app-titlebar.tsx`、`src/renderer/app/app-rail.tsx`
  - `src/renderer/features/environments/environment-stage.tsx`
  - `src/renderer/features/environments/environment-space-switcher.tsx`、`environment-tabstrip.tsx`
  - `src/renderer/state/navigation-store.ts`
  - `src/renderer/features/settings/settings-page.tsx`
  - `src/renderer/theme/theme-tokens.css`
- **工作项**：
  1. 移除左侧常驻 `AppRail`，重构顶层头部区为 Row 1（环境模式）与全局导航条（`settings` / `pluginPage` 模式）双形态，保留 macOS `hiddenInset` 84px 左侧留白与 `[-webkit-app-region:drag]` 拖拽手感。
  2. 将 `EnvironmentSpaceSwitcher`（`我的 | Agent`）安放在 Row 1 环境胶囊右侧、Tabstrip 左侧；`Agent` 空间在后台运行时于 `Agent` 分段标以脉冲圆点。
  3. 重构控制权胶囊渲染条件：只在 `activeSpaceId === 'agent'` 时渲染 `接管` / `交还` / `接管编辑` 动作条；`person` 空间保持绝对安静。
  4. 增加全局扩展启动器按钮（Dropdown / Popover），动态枚举 `registry.railPages`（兼顾异常坏插件降级与 `PluginBoundary`）。
  5. 改造 `App.tsx` 的全局视图切换机制：保留 `ResizablePanelGroup`、`EnvironmentSidebar` 挂载不卸载（用 CSS 隐藏并暂停非活跃视图上的昂贵轮询，仅调 `setViewVisible(false)`），清理 `AppTitlebar` 与 `SettingsPage` 头部冗余。

### Phase 2：地址栏分工、侧栏交互补齐与未启动环境体验

- **核心文件**：
  - `src/renderer/features/environments/environment-address-bar.tsx`
  - `src/renderer/features/environments/environment-sidebar.tsx`
  - `src/renderer/features/environments/sidebar-env-row.tsx`
  - `src/renderer/features/environments/environment-stage.tsx`
- **工作项**：
  1. 梳理 Row 2 工具顺序与权限提示：非 100% 缩放微标、视口预设、`⌘F` 页内查找、下载、复制 URL、DevTools（含右键停靠选择）、插件 `popover` 入口、工作台开关。
  2. 接通 `src/renderer/lib/plugin-runtime.ts` 中已预留的 `registry.popovers` 挂载槽（通过 `Popover` 或按钮组展现），让插件高频微面板无需跳离网页。
  3. 改造 `!running` 空态（`environment-stage.tsx`）：渲染中央 `启动「<env.name>」` 按钮、`Enter` 快捷触发、以及 Omnibox 输入 URL 直接 `start → goto` 的连贯链路。
  4. 优化 `EnvironmentSidebar` 头部（搜索框与 `+` 新建合并单行），固定 `SidebarEnvRow` 行内元素主次占位与悬浮操作，避免代理标签在 hover 时上下跳行；支持从环境胶囊直接打开环境右键菜单。

### Phase 3：右侧职责分层与插件伴随面板补齐

- **核心文件**：
  - `src/renderer/features/environments/environment-stage.tsx`
  - `src/renderer/features/environments/environment-inspector.tsx`
  - `src/renderer/state/navigation-store.ts`
  - `src/main/ui/devtools-host.ts`、`src/main/env/view-coordinator.ts`
  - `plugins/whistle/package.json`、`plugins/whistle/app.js`
  - `plugins/account-manager/package.json`、`plugins/account-manager/app.js`
- **工作项**：
  1. **右侧互斥机制（1A）**：在 `environment-stage.tsx` 与 `navigation-store.ts` 实现规则——当 `devToolsState.dock === 'right'` 且舞台宽度无法满足两侧共屏最小宽度（默认 `< 1280px` 或网页可留宽 `< 520px`）时，打开工作台抽屉自动关闭右侧停靠 DevTools，打开右侧停靠 DevTools 自动折叠工作台抽屉；切换至 `bottom` / `detach` 后自动解除互斥。
  2. **Whistle 环境随行面板**：在保留 `railPage`（多实例与全局配置）的基础上，注册环境级 `inspectorTab`（仅在当前环境旁展示绑定实例状态、快速启用/停用预设组与规则命中，提供「打开完整管理页 / Web UI」跳转）。
  3. **账号管理环境随行面板**：在保留 `railPage` 的基础上，注册环境级 `inspectorTab`，按当前页域名高亮匹配账号提供「一键直填」；严格沿用现有明文安全警示横幅（`data-slot="account-plaintext-warning"`），Agent 渠道约束纹丝不动。

### Phase 4：AI 操作透明蒙层与实时动作轨迹动画（`'shield'` 槽位升级）

- **核心文件**：
  - `src/main/input-shield.ts`
  - `src/main/env/lease-coordinator.ts`
  - `src/main/browser/ctx.ts`、`src/main/browser/actions.ts`、`src/main/browser/keymouse.ts`、`src/main/browser/controller.ts`
  - `src/main/env/view-coordinator.ts`、`src/main/environments.ts`
- **工作项**：
  1. **两态模式切换（`agent` vs `idle`）**：
     - 给 `InputShield` 增加 `setMode('agent' | 'idle')`（兼容保留 `setShowControlPill`、`setCallerLabel` 以保证 `tests/env-coordinators.test.ts` 通过）。
     - `owner === 'agent'`：启用边缘 16–28px 向内衰减柔光呼吸光晕 + 1.5–2px 呼吸边框 + 顶部 2px 轻流光扫过，**中心 100% 透明不压暗、不模糊**。
     - `owner === 'none'`：展示静默 1.5px 细灰边与禁点光标，关闭全部动画，杜绝假状态信号。
  2. **去底部常驻黑药丸，改指针旁误触轻提示**：
     - 取消底部固定遮挡胶囊，把页面底部 CTA 完全还给用户；仅当用户鼠标在 `#catch` 上触发 `pointerdown` 时，在指针附近弹出 1.3s 自动淡出的磨砂轻提示（提示点顶部按钮「接管」）。
     - 用户点击「接管」时，`LeaseCoordinator.takeover()` 立即摘除 `'shield'` 鼠标阻断，零退场卡顿。
  3. **实时动作轨迹播报链路**：
     - 在 `PageContext` 新增可选轻量回调 `onVisualAction?: (action: { kind: 'click' | 'fill' | 'hover' | 'move'; x: number; y: number; rect?: { x: number; y: number; width: number; height: number }; label?: string }) => void`。
     - `actions.ts`（在 `scrollIntoView` + `boxRect` / `boxCenter` 之后）与 `keymouse.ts` 上报动作坐标；主进程按当前页面缩放比（`zoomFactor`）换算后仅向当前可见且已附着的 `InputShield` 推送轨迹：
       - **平滑虚拟指针**：`cubic-bezier(0.22, 1, 0.36, 1)` 阻尼滑移；
       - **目标控件锚框**：元素外围 1.5px 高亮框 + 顶部动作短标（如 `Claude · fill`），动作结束淡出；
       - **点击瞬时波纹**：单环扩散 450ms 消散；尊重系统 `prefers-reduced-motion` 自动降级为静态锚点定位。

### Phase 5：回归选择器迁移、测试补齐与实机验收

- **回归与选择器迁移**：
  - 审查并同步更新 `scripts/regress/ui.cjs` 与 `scripts/regress/run-all.sh` 中依赖 `[data-slot="app-rail"]`、`[data-slot="app-titlebar"]` 的探针（为新的 Row 1、全局扩展入口、`space-switcher`、`stage-start-button` 等保留语义化稳定 `data-slot`）。
  - 维持 `inspector` 内 `[data-slot="tabs-trigger"]`、`[data-slot="net-rule"]`、账号警示 `[data-slot="account-plaintext-warning"]` 等既有探针选择器不变。
- **单测补齐（`tests/`）**：
  - `navigation-store`：全局视图切换保活逻辑、右侧 `DevTools(right)` 与工作台抽屉宽度互斥裁决；
  - `lease-coordinator` & `input-shield`：`agent` / `idle` 模式分离、`onVisualAction` 轨迹推送触发边界、旧 `showControlPill` 兼容断言；
  - 停机环境在地址栏回车输入 URL 先启动后导航的状态流。
- **强制收尾门禁（按 `AGENTS.md`）**：
  1. 执行 `npm run check`（`oxlint`、`prettier:check`、`tsc --noEmit`、`npm test`、`vite build`）全绿；
  2. 按 `AGENTS.md` 清理残余进程与 `~/.warren/envd.sock` 后重启 `npm start` + fixture，验证 `debug.layout`、`debug.rendererEval`、真机截图及 `bash scripts/regress/run-all.sh` 全量通过；
  3. 同步更新 `docs/HANDOFF.md`「当前状态」与 `docs/README.md`。

---

## 4. 风险与注意点清单

- **Node ESM 单测约束**：凡进入 `tests/` 直接运行链路的主进程模块，继续严守「不 `import electron`（仅 `import type`）、不用 TS 参数属性、内部相对导入保留 `.ts` 扩展名」。
- **`shield` 坐标系换算**：页面存在缩放（`zoomFactor`）或 `viewportPreset`（如 `390×844` 居中或裁剪）时，需核实 `boxRect` 相对 `'page'` 视口与 `'shield'` 边界的偏移映射，必要时由实机截图校准后再锁定比例。
- **性能保护**：`'shield'` 动画仅在 `owner === 'agent'` 且窗口内正在展示该环境（`viewVisible === true`）时触发，窗口隐藏或切走环境后立即挂起/清理计时器。
