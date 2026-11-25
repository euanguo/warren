# UI 组件库与皮肤迁移说明

> 来源：`~/orca/workspaces/synara-official-replay-e87742-20260709/agent-driver-refactor/apps/web-next`
> 源提交：`c0880d107`（2026-08-27，分支 `verger-guo/agent-driver-refactor`）
> 迁移日期：2026-10-13

## 为什么

web-next 的组件库不是"shadcn 原版"，而是**逐组件重绘过的产品视觉单源**：
shadcn 下载落到 `ui-reference`（stock，禁止 import）→ `ui:promote` 提升 →
在 `components/ui` 里用 token + recipe 重绘。皮肤层只换 4 个 chrome seed，
其余 180+ 语义 token 全部由 seed 派生。

这套东西已在本项目落地，作为产品 UI 的唯一视觉来源。

## 迁移了什么

| 类别 | 源 | 目标 |
| --- | --- | --- |
| 皮肤 token | `src/theme/theme-tokens.css` | `src/renderer/theme/theme-tokens.css` |
| 表面 recipe | `src/theme/surface.ts` | `src/renderer/theme/surface.ts` |
| 产品组件库 | `src/components/ui/*` | `src/renderer/components/ui/*` |
| stock 基线 | `src/components/ui-reference/*` | `src/renderer/components/ui-reference/*` |
| 图标单源 | `src/components/icons.tsx` | `src/renderer/components/icons.tsx` |
| 展开动效 | `src/shared/disclosure-motion.ts` | `src/renderer/lib/disclosure-motion.ts` |
| 设计语言 | `docs/ui-design-language.md` | `docs/ui-design-language.md` |
| 提升脚本 | `scripts/ui-promote.mjs` | `scripts/ui-promote.mjs` |
| 全局装配 | `src/styles.css`（滚动条 chrome + corner-shape 段） | `src/renderer/globals.css` |
| Tailwind utilities | `@import "shadcn/tailwind.css"`（`data-open`/`data-closed`/`data-checked`… variant、`scroll-fade-*`、`shimmer`、`no-scrollbar`） | `globals.css` 同序 import |
| 字体 | `@fontsource-variable/geist`（`--font-sans` 的首选） | `globals.css` import + 依赖 |
| shadcn 配置 | `components.json` | `components.json` |

路径改写：`@/shared/class-names` → `@/lib/utils`；`@/shared/disclosure-motion` →
`@/lib/disclosure-motion`。其余 `@/theme/*`、`@/components/*` 因两侧 `@/*` 都指向
源码根，无需改动。

## 没有迁移的

| 源文件 | 原因 |
| --- | --- |
| `src/theme/theme-model.ts` + `.test.ts` | 依赖源 app 的 `@/preferences/preferences-model`；本项目固定深色（`index.html` 硬编码 `class="dark"`），没有主题切换宿主 |
| `src/components/ui/surface-tab.test.tsx` | vitest 测试；本项目用 `node --test`，且 Node 不能剥离 `.tsx` 的 JSX |
| `AGENTS.md` | 源项目整体开发规范（目录所有权、Commands/Shortcuts 等），不属于组件库本身；组件库契约已由 `components/ui/README.md` 承载 |

## 适配过的

| 文件 | 改动 |
| --- | --- |
| `src/renderer/components/ui/shortcut-hint.tsx` | 原版从 shell 的快捷键注册表解析 binding；本项目没有该宿主，改为调用方直接传 `sequence` 字符串 |
| `src/renderer/components/ui/card.tsx` | 去掉 `shadow-sm`，改用 `--radius-menu` + `corner-shape` token（原为 Tailwind 默认值） |
| `src/renderer/components/ui/sheet.tsx` | 浮层从 `bg-background shadow-lg` 改为 `bg-menu` + `ring-[0.5px] ring-border-heavy` + `--elevation-popover` + `--blur-dialog`；关闭按钮的 `focus:ring-2` bloom 改为 `--focus` 细线 |
| `docs/ui-design-language.md`、`components/ui/README.md`、`scripts/ui-promote.mjs` | 文档与脚本里的源路径改为本项目路径，`bun` 命令改为 `npm` |
| `environment-sidebar.tsx`、`environment-stage.tsx`、`plugins-sheet.tsx` | 8 处 Tailwind 调色板色（`bg-emerald-500` / `text-amber-500` / `text-blue-500` / `border-amber-500`）改为语义 token：`bg-[var(--success)]`、`text-[var(--warning)]`、`text-[var(--info)]`。与源项目一致 —— `success`/`warning`/`info` 不走 utility 类，走任意值语法 |

## 保留的本项目原有组件

`components/ui/` 里这 4 个是迁入前就有的，不属于 web-next 那套：

- `alert.tsx`、`card.tsx` — 纯 Tailwind，无基座依赖
- `sheet.tsx` — 基于 `radix-ui` 的 Dialog 侧边面板（web-next 那套没有 sheet）
- `sonner.tsx` — toast，固定深色

它们与迁入的 `@base-ui/react` 组件并存；两者消费同一套 token。

## 新增依赖

| 包 | 用途 |
| --- | --- |
| `@base-ui/react` | 迁入的 22 个交互组件的基座 |
| `@hugeicons/core-free-icons` + `@hugeicons/react` | `src/renderer/components/icons.tsx` 的图标源（2026-10 从 Tabler 换过来，`lucide-react` 一并删掉） |
| `shadcn` | 提供 `shadcn/tailwind.css`（上面那批 variant/utility），同时供 `npx shadcn add` 使用 |
| `@fontsource-variable/geist` | `--font-sans` 的首选字体 |

## 工作流

```bash
npx shadcn add <name>         # 落到 src/renderer/components/ui-reference/
npm run ui:promote <name>     # 复制到 components/ui/（已存在则跳过，--force 覆盖）
npm run ui:diff               # 对比 stock 与产品版差异
```

改样式**只改 `components/ui/`**；`ui-reference/` 是 stock 快照，禁止 import。

## 契约要点

摘自 `components/ui/README.md`：

1. **Token 先于组件** — 几何/色/模糊/elevation 只改 `theme/theme-tokens.css`。
2. **Recipe 先于局部 class** — 字段/菜单/tooltip/focus 用 `@/theme/surface` 共享类。
3. **DEFAULT 即正确** — 业务侧省略 `size`；`IconButton` 管图标，`Button` 管文字。
4. **角 = 半径 + 形状** — chrome 必须带 `corner-shape: superellipse(1.5)`（pill/avatar 除外）。
5. **浮层分型** — tooltip ≠ menu ≠ dialog，不要一套玻璃打天下。
6. **不要点名才改** — 新控件默认走 contract。

换肤只改 4 个 seed：`--theme-surface` / `--theme-surface-under` / `--theme-ink` / `--theme-accent`。
