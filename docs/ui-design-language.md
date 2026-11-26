# UI Design Language (web-next)

> 目标：按本文即可还原 web-next 控件几何、表面与交互，无需对照外部产品。  
> 来源：本仓库已落 token / recipe（`theme-tokens.css`、`surface.ts`、`components/ui`）。  
> 实现入口：`src/renderer/theme/theme-tokens.css`、`src/renderer/theme/surface.ts`、`src/renderer/components/ui/*`。

---

## 0. 改造总原则

1. **Token 先于组件** — 几何、色、模糊、elevation 只改 token；组件只引用语义名。
2. **Recipe 先于局部 class** — 字段 / 菜单 / tooltip / focus 用 `@/theme/surface` 共享类，禁止每个文件重写一套。
3. **DEFAULT 即正确** — 业务侧 **省略 `size`**；`IconButton` 管图标，`Button` 管文字。
4. **角 = 半径 + 形状** — 只对齐 `border-radius` 仍会「更圆」；chrome 必须 `corner-shape: superellipse(1.5)`（pill/avatar 除外）。
5. **浮层分型** — tooltip ≠ menu ≠ dialog；不要一套玻璃打天下。
6. **不要点名才改** — 新控件默认走 contract；全局规则优先于个案。

---

## 1. 色与表面（精密微立体 · 深浅双轨独立校准）

### 1.1 Seeds（换肤只动这些）

| Token                   | Dark 实测/取值 | Light 实测/取值 | 用途                     |
| ----------------------- | -------------- | --------------- | ------------------------ |
| `--theme-surface-under` | `#111317`      | `#e9edf3`       | 最底托盘 / 顶栏 / 侧栏   |
| `--surface-drawer`      | `#15181e`      | `#f4f6fa`       | 右侧伴随工作台抽屉       |
| `--theme-surface`       | `#181b21`      | `#ffffff`       | 主背景 / 网页舞台        |
| `--surface-elevated`    | `#20242d`      | `#ffffff`       | 卡片 / 凸键 / 选中胶囊   |
| `--surface-recessed`    | `#0c0e12`      | `#e2e7ef`       | 网页舞台外凹槽           |
| `--theme-ink`           | `#f4f6fa`      | `#111621`       | 主文字                   |
| `--theme-accent`        | `#5b8cff`      | `#3b5bdb`       | Warren 统一品牌靛蓝      |

### 1.2 语义色、对比度底线与微立体光影

- **WCAG AA 底线**：暗/浅双模式下所有正文与次级标签（含 `--subtle-foreground`、`--muted-foreground`、`--warning`、`--success`、`--accent-seed`）在对应底色上均 **≥ 4.5:1**；非文本状态点（含 `--status-idle`）与护盾边界 **≥ 3.0:1**；功能中文最低字号 **11px**（`--font-size-micro`，禁止 `10px`）。
- **悬停与选中分离**：暗色下 `--surface-hover`（6.5%）与 `--surface-selected`（12%）明确拉开，严禁同色撞车。
- **微凹槽 vs 微凸键**：输入槽/开关轨带 `--shadow-recessed`；`Button variant="outline"`、选中 Tab、滑动滑块、环境胶囊与卡片带 `--shadow-raised`（顶沿 `1px` 高光 + 柔和底影）；浮层带真实双层暗影 `--elevation-popover`。
- **工具静，身份彩**：高频通用工具图标保持单色线框（仅激活/告警态点亮语义色）；隔离环境使用 `--glyph-hue-1..8`（`.env-identity-chip`），插件生态使用专属双色徽标（`.plugin-brand-icon` / `.plugin-brand-chip`）。

**Primary 按钮** = ink 反色填充（带轻高光与柔影），保证高对比主焦点；**Outline 按钮** = 独立描边 + 微凸起（与无框 `secondary` 明确区分）。

### 1.3 交互不变量

- **Destructive 菜单项**：默认与 hover/highlight **始终保持 `text-destructive`**，只加深底（`bg-destructive/10`），禁止 hover 变成 foreground 白字。

- Hover 列表/菜单项：`surface-hover` + 文字/图标到满不透明。
- 菜单项默认透明度约 **0.7** → hover/active/highlight **1.0**（见 `menuItemInteractiveClass`）。
- Disabled：**opacity 0.4**（控件）/ 菜单 disabled **0.25**。
- Focus：**细 border-focus**，禁止 `ring-3 ring-ring/50` 光晕。
- 图标 chrome 常带 **1px transparent border**（几何稳定），不是描边盒。

---

## 2. 尺寸阶梯（Control ladder）

以 root **16px** 计。组件 **禁止** 写死 `h-8` / `size-7` 代替 token。

| Step      | px     | rem                  | 语义 DEFAULT                                                         |
| --------- | ------ | -------------------- | -------------------------------------------------------------------- |
| 2xs       | 20     | 1.25                 | 密排列表图标                                                         |
| xs        | 24     | 1.5                  | 紧凑图标                                                             |
| sm        | 26     | 1.625                | 略松工具图标                                                         |
| **icon**  | **28** | **1.75**             | **`IconButton` DEFAULT**（Header 开关等）                            |
| md        | 29     | 1.8125               | 紧凑文本行 / dense field                                             |
| **lg**    | **32** | **2**                | **`Button` / Toggle / Tabs DEFAULT**                                 |
| xl        | 39     | 2.4375               | legacy tall field (reference only)                                   |
| **field** | **32** | **→ control-height** | **`Input` / `SelectTrigger` / Textarea DEFAULT（产品：与按钮同高）** |

### 2.1 语义高度

```text
--control-height            → lg 32   文本控件 DEFAULT
--control-height-compact    → md 29   更密一行
--control-height-field      → **32 (= control-height)**  表单字段 DEFAULT（产品决策：与按钮对齐；参考对话框输入约 39 仅作参考）
--control-height-icon       → icon 28 图标按钮 DEFAULT
--control-height-icon-dense → 2xs 20
--control-height-icon-compact → xs 24
--control-height-icon-roomy → sm 26
```

### 2.2 Padding

| Token                       | px     | 用途                |
| --------------------------- | ------ | ------------------- |
| `--control-pad-x/y`         | 16 / 6 | 默认文本按钮        |
| `--control-pad-x/y-compact` | 8 / 4  | 行 / 菜单项 / dense |
| `--control-pad-x/y-field`   | 12 / 8 | 字段                |

### 2.3 实测锚点（不要改错档）

| 控件                 | 高     | 半径                | 备注                                |
| -------------------- | ------ | ------------------- | ----------------------------------- |
| Header 隐藏边栏      | 28     | 12.5 + superellipse | 图标 16                             |
| 对话框 Cancel/Save   | 32     | 12.5                | pad 6×16                            |
| 侧栏「新建任务」行   | 29     | 12.5                | pad-x 8                             |
| 列表 pin 等          | 20     | 10                  | dense                               |
| 对话框 Input（参考） | 39     | ~15                 | 参考；**产品 DEFAULT 用 32 / 12.5** |
| Tooltip              | ~28–29 | 12.5                | 见 §4                               |
| Menu 面板            | —      | 15 (xl)             | 见 §4                               |

**图标按钮 DEFAULT ≠ 文本按钮 DEFAULT**（28 vs 32），但是同一梯子上的相邻档。

---

## 3. 圆角与角形状

### 3.1 半径阶梯（× `--radius-scale: 1.25`）

| Token          | 计算            | ≈px@16            |
| -------------- | --------------- | ----------------- |
| `--radius-sm`  | 0.375rem × 1.25 | 7.5               |
| `--radius-md`  | 0.5rem × 1.25   | **10**            |
| `--radius-lg`  | 0.625rem × 1.25 | **12.5**          |
| `--radius-xl`  | 0.75rem × 1.25  | **15**            |
| `--radius-2xl` | 1rem × 1.25     | 20                |
| `--radius-3xl` | 1.25rem × 1.25  | 25（dialog 常用） |

语义：

```text
--control-radius       → lg 12.5   按钮 / tip / 默认控件
--control-radius-icon  → md 10     更小图标芯片 / kbd
--control-radius-field → lg 12.5   输入/选择触发器（与按钮同半径）
--radius-menu          → xl 15     下拉面板
--radius-dialog        → 3xl 25    对话框外壳
```

### 3.2 角形状（必做）

```css
--corner-shape: superellipse(1.5);
```

- Chrome 控件、菜单、tooltip、字段：**superellipse(1.5)**
- `rounded-full` / avatar / switch / radio：**`corner-shape: round`**（真圆）

同 px 半径下，圆形圆弧会显得更「泡」；这是过去「数值对了仍更圆」的根因。

实现：全局见 `styles.css`；recipe 可再写 `[corner-shape:var(--corner-shape)]`。

---

## 4. 浮层分型（不要混用）

### 4.1 Tooltip（快捷键提示）

**实测：**

- `border-radius: 12.5px` + `superellipse(1.5)`
- **`1px solid` border** ≈ white 8.4%（`border-border`）
- **实心底** `rgb(45,45,45)`（`bg-popover`），**无 blur、无大阴影**
- pad **4×8**，字 **13px / sm**
- 内容：`标签` + `gap-2` + **`<Kbd>`**（不要 `"label (⌘B)"` 字符串）
- **Kbd 本身无边框**：r10、`bg-current/10`、px-1.5 py-0.5、text-xs；**边框在 tip 外壳**

Recipe：`elevatedTooltipSurfaceClass`。

### 4.2 Menu / Select / Dropdown 面板

**实测：**

- 半径 **15**（xl）+ superellipse
- **0.5px ring**（`ring-border-heavy` / elevation stroke），不是 1px card border
- 半透明底 + **`blur(8px)`**（`--blur-menu: 8px`）
- 内边距 **p-1**；列表 **`flex flex-col gap-0.5`**（约 2px 项间距）
- 项：compact pad、`menuItemInteractiveClass`（opacity 0.7→1 + hover 洗）

Recipe：`elevatedMenuSurfaceClass`。

### 4.3 Dialog

- 外壳半径 **~25**（3xl）
- 玻璃 + hairline + elevation（可强于 menu）
- 内容区 **p-5 (20)**，块间 **pt-3 (12)**
- Footer：**无底栏条带**；`justify-end gap-3`；按钮用 DEFAULT 32
- 关闭：**IconButton DEFAULT (28)**，ghost

### 4.4 Select 定位（重要）

- **默认 `alignItemWithTrigger={false}`**
- 打开方式：在 trigger **下方**（`side="bottom"`）+ **`sideOffset=4`**
- **`alignItemWithTrigger={true}` 会把当前选项对齐到 trigger 上，看起来像盖住触发器** — 仅在明确要「原生 select 对齐」时使用，**不是 参考 默认**。

---

## 5. 控件配方速查

| 控件                 | DEFAULT                              | 表面                                               | 备注                      |
| -------------------- | ------------------------------------ | -------------------------------------------------- | ------------------------- |
| `Button`             | h32 r12.5 pad16×6                    | 无描边；primary=ink 反色；secondary/outline=fog 洗 | omit size                 |
| `IconButton`         | **28** r12.5 glyph16                 | ghost；1px transparent border                      | omit size                 |
| `Input` / `Textarea` | h39 r15 pad12×8                      | `controlFieldClass` + focus 蓝发丝                 |                           |
| `SelectTrigger`      | 同 field；toolbar 可用 compact class | 同 field                                           | 面板见 §4.2–4.4           |
| `SelectItem`         | 行高由 pad+line 决定                 | menu item 交互                                     | 列表 gap-0.5              |
| `Toggle`             | h32                                  | wash / selected                                    |                           |
| `TabsList`           | h32                                  | muted 轨                                           | trigger 用 control-radius |
| `Checkbox`           | ~14 box                              | r≈10 token                                         |                           |
| `Kbd`                | h16 r10                              | 无边框                                             | 只在 tip/菜单里用         |

业务侧：

```tsx
// 好
<Button variant="outline">Cancel</Button>
<IconButton aria-label="Search"><SearchIcon /></IconButton>
<SelectContent>{/* 默认下方弹出 */}</SelectContent>

// 避免
<Button size="sm">…</Button>
<Button size="icon-sm">…</Button>
<SelectContent alignItemWithTrigger>…</SelectContent>
```

---

## 6. 图标

- 库：**Hugeicons**（`@hugeicons/core-free-icons` + `@hugeicons/react`），统一从 `@/components/icons` 引入。
- 写法：**`<Icon name="PanelLeft" />`**，语义名注册表在 `components/icons.tsx` 的 `ICON_MAP`。业务侧不 import 图标包。
- 默认：**16×16** + **stroke 1.5**（24 格数据缩到 16px，有效描边 ≈ 1.0px，与迁移前的 Tabler 观感一致）。
- 按钮 hit target 仍是 `IconButton` DEFAULT **28**；不要为了「显小」把盒改成 14。
- 每个图标根节点带 `data-icon-root`；尺寸可以由父元素统一控制（`[&_[data-icon-root]]:size-3.5`）。
- 禁止业务直接 import 任何图标包（`lucide-react` / `@tabler/icons-react` 已从依赖里删掉，避免 stroke/size 漂移）。

## 7. 字体与字重

- UI 字重 参考 约 **445**（可变字体中间态）；我们用 **`font-normal` (400)** 贴近，避免 `font-medium` 发黑。
- 正文控件 **text-sm**；tooltip **text-sm**；kbd **text-xs**。
- 字体栈：Geist / system，不强制复刻到像素。

---

## 8. Motion

- Disclosure 开合：**220ms ease-out**（`disclosure-motion` / `--motion-disclosure-*`）。
- 浮层：短 fade/zoom ~100ms；不要夸张弹跳。

---

## 9. 工程结构

```text
shadcn add        → src/renderer/components/ui-reference/   (stock，禁止 import)
ui:promote        → src/renderer/components/ui/             (产品单源，只改这里)
业务 import       → @/components/ui/*
共享色与几何      → src/renderer/theme/theme-tokens.css
共享 recipe       → src/renderer/theme/surface.ts
全局 corner-shape → src/renderer/globals.css
```

---

## 10. 改造检查清单（每个组件）

- [ ] 高度/ padding/ 半径是否只引用 `--control-*` / `--radius-*`？
- [ ] 是否挂上 **superellipse**（或正确 round 例外）？
- [ ] 浮层属于 tip / menu / dialog 哪一类？边框是 **1px 实线** 还是 **0.5 ring**？要不要 **blur**？
- [ ] Focus 是否发丝而非 ring bloom？
- [ ] 默认态是否在 **不传 size** 时已正确？
- [ ] Select/Menu 是否 **盖住 trigger**？（检查 `alignItemWithTrigger`）
- [ ] 列表项之间是否有 **~2px gap** 或等价内边距呼吸？
- [ ] 有无硬编码 hex / `h-8` / 裸 `rounded-lg`？

---

## 11. 已知非目标 / 近似

- Superellipse 在不支持的引擎上回退为普通圆角。
- 字重 445 vs 400 的细微差。
- 部分 参考 内部仍混用 `round` 与 superellipse；**Header / tip / 主 chrome 以 superellipse 为准**。
- Vibrancy / 系统材质不做 1:1，用 token 玻璃近似。

---

## 12. 变更时怎么更新本文

1. CDP 测 参考：`border-radius`、`corner-shape`、border、bg、blur、h/pad。
2. 只改 token 或单一 recipe。
3. 更新本节「实测锚点」表。
4. 禁止只改一个 call site 的魔法数。
