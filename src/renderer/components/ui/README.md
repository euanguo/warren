# components/ui — 产品视觉单源（OpenBot 扁平精密体系）

**完整设计语言：** [`docs/ui-design-language.md`](../../../../docs/ui-design-language.md)

从 **`@/components/ui/*`** 导入所有基础控件。
`src/renderer/components/ui-reference` 仅为 shadcn stock 快照，**禁止 import**。

## 核心契约（每个组件默认遵循）

1. **双层严格隔离**：
   - **基础结构层（锁定）**：高度阶梯、圆角（标准圆弧，**无 superellipse**）、字号、间距、动效曲线、z-index 锁定在 `@/theme/theme-tokens.css`。
   - **配色皮肤层（可抽离/可配置）**：颜色变量由 `@shared/skin` 的 12 色板派生，皮肤**只能改色板**，不能越界修改结构 Token。
2. **扁平发丝精密**：卡片与浅色浮层零阴影；控件使用 `1px` 发丝边框 + `1px` 中性焦点环（无蓝光晕）；悬停 `0ms` 瞬时响应；可点击控件按下 `active:scale-[0.97]`。
3. **Recipe 先于局部 class**：表单字段、菜单、弹窗、Tooltip 与焦点统一复用 `@/theme/surface`。
4. **DEFAULT 即正确**：调用侧默认省略 `size`；纯图标用 `IconButton`，文字按钮用 `Button`，设置分组用 `SettingsSection` + `ItemGroup` / `Item`。

## 控件高度阶梯（锁定）

| Step | px | 语义 DEFAULT |
| ---- | -- | ------------ |
| `2xs` | 20 | 密排行内图标 |
| `xs` | 24 | 紧凑按钮 / 紧凑图标 |
| `sm` / `icon` | 28 | **IconButton DEFAULT** / 紧凑输入与列表行 |
| `md` | 32 | **Button / Input / Select / Tabs / Toggle DEFAULT** |
| `lg` | 36 | 大号动作按钮 |
| `xl` | 40 | 紧凑侧栏图标瓦片 / 头部大控件 |

## 标准圆弧阶梯（锁定）

`xs 4px` · `sm 6px` · `md 8px`（按钮/输入/选择/默认控件） · `lg 12px`（Alert/紧凑侧栏按钮） · `card 14px`（卡片/菜单/主画布卡片） · `xl 20px`（Dialog/AlertDialog） · `modal 30px` · `pill 999px`

## 核心原语与物理动效

| 原语 | 文件 | 职责 |
| ---- | ---- | ---- |
| `Button` / `IconButton` | `button.tsx` | 7 变体（含 `destructive-ghost`）、`0ms` 悬停、`scale(0.97)` 按压 |
| `Switch` | `switch.tsx` | 阻尼弹簧（`k=520, d=32`）+ 速度形变 + 指针拖拽 |
| `Tabs` | `tabs.tsx` | 水平默认态带 `250ms` 滑动胶囊指示条，垂直态自动平铺高亮 |
| `TabShape` | `tab-shape.tsx` | 顶栏凹角无界标签滑块（前进边 0ms、尾随边 70ms 延迟） |
| `PanelResizer` | `panel-resizer.tsx` | 16px 隐形热区 + 1px 渐隐发丝线 + 双击复位 + 迟滞吸附紧凑态 |
| `SettingsSection` / `ItemGroup` / `Item` | `item-group.tsx` | `14px` 圆角分组列表与 `1px` 发丝分隔线 |
| `Badge` | `badge.tsx` | 实心 / 柔色 / 描边语义徽章（`success`/`warning`/`destructive`/`primary-light` 等） |
| `SurfaceTab` | `surface-tab.tsx` | `variant="chip"`（扁平芯片）与 `variant="chrome"`（顶栏凹角无界标签） |
