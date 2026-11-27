# Warren UI Design Language（OpenBot 扁平精密体系 + 可抽离配色皮肤契约）

> 架构入口：
> - 配色皮肤契约与 12 色派生引擎：[`src/shared/skin.ts`](../src/shared/skin.ts)
> - 锁定基础结构 Token 与默认 `neutral` 静态回退：[`src/renderer/theme/theme-tokens.css`](../src/renderer/theme/theme-tokens.css)
> - 共享表面与交互 Recipe：[`src/renderer/theme/surface.ts`](../src/renderer/theme/surface.ts)
> - 主题与皮肤运行时切换（含 View Transition 径向波纹）：[`src/renderer/lib/theme.ts`](../src/renderer/lib/theme.ts)
> - 产品基础组件单源：[`src/renderer/components/ui/`](../src/renderer/components/ui/)

---

## 0. 两层严格隔离架构

Warren 将视觉系统严格拆分为「**基础结构层（Foundation）**」与「**配色皮肤层（Skin）**」：

1. **基础结构层（锁定，皮肤不可改写）**：
   - 字体栈（`Geist Variable` + 系统无衬线，`font-synthesis: none; text-rendering: geometricPrecision`）；
   - 排版字号阶梯（`11 / 12 / 13 / 14 / 15 / 16 / 18 / 24px`）；
   - 控件高度阶梯（`20 / 24 / 28 / 32 / 36 / 40px`）；
   - 标准圆弧圆角阶梯（`4 / 6 / 8 / 12 / 14 / 20 / 30 / 999px`，全面移除 `corner-shape: superellipse`）；
   - 物理动效时长与曲线（`--duration-hover: 0ms`、`--ease-out`、`--ease-panel`、`--ease-menu`、`--ease-slide`）；
   - 外壳几何尺寸（`38px` 顶栏与地址栏、`4px` 外框唇边、`14px` 主工作区圆角卡片、`248px / 72px / 0px` 三态侧栏）。

2. **配色皮肤层（可抽离、可配置，严格仅限色板）**：
   - 皮肤接口定义在 [`src/shared/skin.ts`](../src/shared/skin.ts)，每套皮肤只允许声明暗/浅双轨各 **12 个 `#rrggbb` Hex 颜色**：
     `frame`、`canvas`、`sidebar`、`surface`、`border`、`text`、`textMuted`、`accent`、`accentForeground`、`success`、`warning`、`danger`。
   - 外部覆写（`AppSettings.skinOverrides` 或设置页 JSON 导入）经 `sanitizeSkinColorPatch` / `validateSkinOverridesInput` 强校验：**任何非颜色字段（如圆角、字号、高度、间距、动画时长）都会被直接过滤并拒绝生效**。
   - `deriveSkinCssVars()` 通过 `color-mix(in srgb, ...)` 派生全站语义色，并经 `applyTheme` 同步应用到主窗口、独立 `OverlayHost` 与 `PopoverHost`。
   - 内置 4 套可切换双模皮肤：`neutral`（纯中性默认）、`graphite`（冷调石墨）、`paper`（暖墨宣纸）、`obsidian`（极夜纯黑）。

---

## 1. 默认 `neutral` 纯中性色板

| 角色 | Dark（默认） | Light（纯值覆写） | 用途 |
| ---- | ------------ | ----------------- | ---- |
| `frame` (`--bg-frame`) | `#0d0d0d` | `#e8e8eb` | 窗口外框、顶栏底色、4px 外缘唇边 |
| `canvas` (`--bg-canvas`) | `#1a1a1a` | `#f5f5f6` | 单一 `14px` 主工作区圆角卡片、地址栏、检视器底色 |
| `sidebar` (`--bg-sidebar`) | `#1a1a1a` | `#f5f5f6` | 左侧环境栏与设置导航栏底色 |
| `surface` (`--bg-surface` / `--bg-control`) | `#212121` | `#ffffff` | 控件表面、分组卡片、实色菜单与 Popover |
| `border` (`--border` / `--border-strong`) | `#38383a` 派生发丝边 | `#c7c7cc` 派生发丝边 | `1px` 极细边框、分隔线、`dialog-ring` |
| `text` / `textMuted` | `#ffffff` / `#979797` | `#141414` / `#6b6b70` | 正文与辅助说明阶梯 |
| `accent` | `#007cf7` | `#007cf7` | 强调色、激活指示条与链接 |
| `success` / `warning` / `danger` | `#31cf76` / `#ff9412` / `#fd2f3b` | `#1fa85a` / `#f08a00` / `#e8222d` | 语义状态与破坏性操作 |

### 视觉与交互不变量

- **严格零伪立体噪音**：卡片零阴影，浅色菜单/弹窗/选中项严格零阴影（对齐 OpenBot `tokens-light.css`），纯靠 `1px` 发丝边界定型；暗色菜单与弹窗保持克制阴影与 `1px --menu-highlight` 顶边微光。
- **0ms 悬停响应**：列表项、菜单项、按钮、标签悬停瞬时切换，不产生粘滞拖尾；按钮按压 `active:scale-[0.97]`，列表行按压 `active:scale-[0.99]`。
- **单 1px 中性焦点**：输入框/选择框 `focus-visible:border-focus`（单层不叠加），无框按钮/列表/标签用 `focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]`。
- **破坏性操作克制显色**：`variant="destructive"` 恒定柔红底红字；`variant="destructive-ghost"` 与行内次级启停按钮默认静息低噪、悬停才亮语义柔底（对齐 OpenBot `primitives.css`）。
- **实色浮层同源**：Tooltip 与 DropdownMenu / ContextMenu 共享 `--bg-sheet`（暗 `#141414` / 浅 `#ffffff`）+ `1px --menu-edge`，菜单内边距 `6px` + 同心 `10px` 菜单项 + `32px` 行高 + 图标默认 muted 悬停提亮。

### 交互态、等高标尺与 OpenBot 规范对照

| 场景 | Dark（暗色） | Light（浅色） | 统一契约 |
| ---- | ------------ | ------------- | -------- |
| **副顶栏等高标尺** | `44px` 副顶栏，内含 `32px` 药丸无框搜索框 + `32px` 圆形主动作 `+` 按钮 + `32px` 无框地址胶囊 | 同左 | 侧栏头部无多余横切线，左右搜索与地址栏同轴对齐 |
| **侧栏列表行选中** (`--surface-selected`) | OpenBot 原版 `bg-surface` (`#212121`)，**零边框零阴影** | **纯白抬升** `bg-surface` (`#ffffff`) + `1px` 极淡发丝边（**零阴影**） | 选中态悬停锁色不发脏，按压 `scale(0.99)` |
| **检视器 Pill 标签选中** (`--surface-tab-selected`) | OpenBot `.side-panel-tab` 原版 `bg-control-active` (`#2a2a2a`)，无框 | 纯白 `#ffffff` + `1px` 极淡发丝边，零阴影 | `TabsList` 严格隔离 `default` / `pill` / `line` 三变体 |
| **白底菜单 / Popover 悬停高亮** (`--surface-highlight`) | `text 6%` | `text 6%` | 对齐 OpenBot `--ui-menu-item-hover`，浅色菜单绝不白撞白 |
| **设置分组卡与主题单选** (`ItemGroup` + `SettingsPictureChoice`) | `12px` 圆角 `bg-surface` 无外硬框 + `16px` 缩进发丝分隔线 | `12px` 圆角纯白 + `1px` 极淡边 + `16px` 缩进发丝分隔线 | 外观模式与配色皮肤内置于分组卡，采用「圆角缩略图 + 居中标题 + `20px` 强调色圆形 Radio 勾 / 空心未选圆环」 |

---

## 2. 外壳骨架与核心面板交互

```text
+-----------------------------------------------------------------------------+
| [● ● ●] [侧栏] [环境胶囊] [我的|Agent]  ╭── 激活标签 ──╮ [标签2] [+]   [⌘K][插][设] |  ← 38px bg-frame
|  ╭───────────────────────────────────────────────────────────────────────╮  |
|  │ 侧栏 (248px / 72px 紧凑轨 / 0px) ┃ [←→↻] [   地址栏   ] [工具][DT][抽屉] │  |  ← 14px bg-canvas
|  │                                ┃ ──────────────────────────────────── │  |    主工作区卡片
|  │   环境列表 / 紧凑图标轨道        ┃      原生网页视图     ┃  伴随工作台抽屉 │  |    (4px 外框唇边)
|  │                                ┃   (WebContentsView)  ┃  (支持最大化)   │  |
|  ╰───────────────────────────────────────────────────────────────────────╯  |
+-----------------------------------------------------------------------------+
```

1. **顶栏凹角无界滑动标签（`TabShape` + `SurfaceTab variant="chrome"`）**：
   - 激活标签背景与下方 `bg-canvas` 一体衔接，底部两侧用 `radial-gradient` 绘制凹角圆弧。
   - 切换标签时前进边 `0ms` 立即启动、尾随边延迟 `70ms` 追赶，形成平滑弹性拉伸滑行。
2. **三态左侧环境栏 + 迟滞拖拽分割条（`PanelResizer`）**：
   - **Expanded**（默认 `248px`，范围 `176–400px`）：搜索框 + 分组折叠 + 双行环境信息 + 底部内存胶囊。
   - **Compact Icon Rail**（`72px`）：向左拖过 `110px` 阈值吸附进紧凑图标轨，向右拖过 `118px` 弹回展开（窄窗口 `<920px` 自动降级）；居中头像卡片配右侧富信息 Tooltip 与左缘强调条，双击分割条复位默认宽度。
   - **Closed**（`0px`）：`⌘B` 或顶栏按钮切换。
   - 拖拽期间在 `html` 上挂载 `.panel-resizing` 冻结 `240ms` 网格动画，松手恢复丝滑过渡；所有变化经 `ResizeObserver` + `transitionend` 同步到主进程原生 `WebContentsView` 坐标。
3. **右侧伴随工作台抽屉（`EnvironmentInspector`）**：
   - 打开时 `200ms` 滑入（`warren-side-panel-enter`）；左侧由无边框 `PanelResizer` 调节（默认 `360px`，双击复位）。
   - 标签栏采用 CSS `mask-image` 左右边缘渐隐（`.warren-fade-x`）替代翻页箭头，相邻非激活标签间用智能 `1px` 竖线分隔并在悬停/选中时隐去。
   - 新增 **最大化 / 还原** 按钮：最大化时自动隐藏原生 `WebContentsView`，让检查器或插件伴随页铺满整个工作区卡片；同时完整保留与右侧停靠 Chrome DevTools 的互斥裁决（`shouldExcludeRightPanels`）。
4. **物理动效体系**：
   - `Switch`：真实阻尼弹簧（`k=520, d=32`）+ 速度形变拉伸 + 指针拖拽；
   - `Tabs` / `EnvironmentSpaceSwitcher` / `global-nav`：共享 `250ms cubic-bezier(0.22, 1, 0.36, 1)` 滑动胶囊；
   - 主题与皮肤切换：支持原生 `document.startViewTransition` 从点击坐标展开径向波纹（遵循 `prefers-reduced-motion` 自动降级）。
