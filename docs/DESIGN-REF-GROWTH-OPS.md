# 参考稿设计提取：Growth Ops（Pipeline 视图）

> 来源：用户提供的 4 面板拼图（4096×2978 PNG）。四个面板是同一界面的不同状态。
> 基准：单面板按 **1440 设计宽**（原图 2009 宽 ÷ 1.4），下面所有数字都是这个基准下的 CSS px。
> 方法：PNG 逐像素采样 + 区域裁剪放大。不是 Figma 源文件，**几何可信、交互态是推断**。
> 落地对照见文末；代码在 `theme-tokens.css` / `app-rail.tsx` / `app-titlebar.tsx` / `App.tsx`。

## 1. 骨架

```
画布（#cfcfcf）
└─ 应用卡片  r14 · 白底 · 无阴影
   ├─ header  50 高 · 底部 1px 线
   │  ├─ logo 20（紫）
   │  ├─ 面包屑 13：Growth Ops / Pipelines / Lead enrichment（末级加深）
   │  ├─ LIVE 徽章（淡紫底 · 紫点 · 11 mono）
   │  └─ 右侧：头像组 · Pause run（描边）· Deploy v13（黑底）
   └─ 主体（三列，同一白底，只靠 1px 线分隔）
      ├─ rail     52 宽 · 右侧 1px 线
      ├─ 内容     padding 24
      └─ 详情栏   350 宽 · 左侧 1px 线 · padding 24
```

**没有底色分层**：rail / 内容 / 详情栏是同一个白底，分隔只靠 1px 淡线（`#f0f0f0`）。
卡片不投阴影，只有圆角和边框。

## 2. 尺寸（1440 基准）

| 项 | 值 |
|---|---|
| 卡片圆角 | 14 |
| header 高 | 50 |
| rail 宽 | 52 = 32 控件 + 2×10 padding（全部落在既有阶梯上） |
| rail 控件 | 32×32，圆角 12.5（`--control-radius`） |
| rail 图标 | 16（stroke 线性，可见笔画 14） |
| rail 控件间距 | 4（`--space-1`；图标中心距 36） |
| rail 顶部留白 | 20（图标列比内容首行低一档） |
| 详情栏宽 | 350 |
| 内容 / 详情栏 padding | 24 |
| 按钮高 | 28–34，圆角 8–10 |
| 输入框高 | 36，圆角 999（胶囊） |
| 徽章高 | 22，圆角 999 |
| 表格行高 | 44（子行 34） |
| 进度条高 | 6，圆角 3，段间隙 4 |
| 任务条高 | 24–28，圆角 6 |
| 代码块 | 圆角 8，padding 10 |
| 字段行高 | 30（label 左 / value 右） |

## 3. 字号（1440 基准）

| 角色 | 值 |
|---|---|
| 页面标题 | 22 / 500 / -0.02em |
| 区块标题 | 13 / 500 |
| 正文 | 13 / 400 |
| 次要 | 12 / 400 |
| 微字（大写标签） | 10 / 500 / +0.04em |
| 数值 | 11–12 mono / tabular |

## 4. 颜色

| 语义 | 值 | 用在哪 |
|---|---|---|
| surface | `#ffffff` | 卡片、三列 |
| surface-subtle | `#f7f7f7` | 代码块、segmented 底 |
| surface-hover | `#f0f0f0` | rail 选中块、行 hover |
| surface-selected | `#f8f7ff` | 运行中的行（淡紫） |
| divider | `#f0f0f0` / `#efeff1` | 所有 1px 线 |
| ink | `#1a1a1a` | 主文字 |
| ink-secondary | `#6b6b6b` | 次要文字、rail 图标 |
| ink-tertiary | `#9a9a9a` | 微字、queued 点 |
| accent | `#472cf5` | running、now 线、主 CTA |
| accent-soft | `#eaecff` | LIVE 徽章底 |
| success | `#18af62` | done |
| warning | `#f08132` | needs human |
| track | `#f1f1f1` | 进度条 / 任务条底 |

## 5. 组件规格

- **rail 按钮**：32×32 r12.5，图标 16 居中；默认图标 `#6b6b6b`，选中 `#1a1a1a` + 底 `#f0f0f0`；
  无边框、无阴影。
- **segmented**：底 `#f7f7f7` r8 pad 2；选中项白底 r7 + 1px 边框。
- **按钮**：primary 黑底白字；secondary 白底 + 1px `#e5e5e5`；28–34 高 r8–10，12/500。
- **徽章**：22 高 r999，11 mono，淡色底 + 同色文字。
- **进度条**：6 高 r3，分段渲染，段间 4px 间隙。
- **任务条**：24–28 高 r6，running 用 accent，done 用 success，queued 用 `#f1f1f1` 虚线框。
- **表格**：表头 10px 大写 `#9a9a9a`；行 44 高；行间无横线，只靠时间网格竖线定位。
- **字段行**：30 高，label 左（`#6b6b6b` 12px），value 右（`#1a1a1a` 12px mono）。
- **代码块**：`#f7f7f7` r8 pad10，mono 11，无边框。

## 6. 落地对照

| 参考稿 | Warren 原来 | 现在 |
|---|---|---|
| rail 52 / 控件 32 / 图标 16 / gap 4 / pad 10 | 44 / 28 / 16 / gap 4 / pad 8 | **已采用**（`--rail-*`，圆角沿用 12.5） |
| rail 顶部留白 20 | 8 | **已采用**（`--rail-padding-y`） |
| rail 在卡片内，右侧 1px 常显线 | rail 在卡片外、贴凹陷外壳 | **已采用** |
| header 是卡片第一行，底部 1px 线 | 标题行在卡片外 | **已采用**（`App.tsx`） |
| header 高 50 | 40 | **已采用**（`--shell-title-bar-height: 3rem`） |
| 三列同底色 | 侧栏 `--surface-under` 更深 | **已采用**（`--sidebar: var(--surface)`） |
| 面板接缝 1px 常显 | 接缝平时透明，hover 才显 | **已采用**（`resizable.tsx`） |
| divider `#f0f0f0` | 无 | 新增 `--divider`（浅色 ink 6% / 深色 8%） |
| 内容 padding 24 | 侧栏/内容 6–12 | **不采用**：桌面密度，参考稿是展示稿 |
| 表格行 44 / 正文 13 | 行 29 / 正文 14 | **不采用**：同上 |
| 主色紫 `#472cf5` | 蓝 `#0d6efd` | **不采用**：品牌色，不动 |
| success `#18af62` / warning `#f08132` | `#008635` / `#d97706` | **不采用**：参考值只做圆点/条形，做文字对比度不足 |
| header 左侧 logo + 面包屑 | ☰ + 环境名 | **不采用**：红绿灯占 84px，面包屑换成环境身份 |

## 7. 未验证

- 所有交互态（hover / pressed / focus）都是推断，参考稿只有静态图。
- 参考稿是浅色；Warren 默认深色。深色下 `--divider` 用 8%（6% 实测看不见）。
- 参考稿的 header 是应用内 header；Warren 的 header 还要承载 macOS 红绿灯和拖拽区，
  所以左边 84px 是留白，logo 留在 rail 底部而不是 header 左上。
