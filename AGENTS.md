# AGENTS 指南（Warren）

## 交流与协作

- 全程使用中文沟通。
- 直接给结果和**实测输出**，不要过程叙述和废话。
- 涉及「代码定位 / 架构理解 / 符号关系」时优先用语义检索，拿到候选后再用精确匹配。
- 说「做完了」必须附实测证据。本项目多次出现过「看起来改了但没生效」（见「已知问题与排查」第 4 条）。

---

## 仓库结构（当前基线）

```
bin/warren.mjs              Agent CLI 薄入口（<40L，派发到 bin/cli.mjs + bin/commands/*.mjs）
src/shared/                 跨进程共享：types/*.ts + permissions.ts + plugin-host-api.ts + popover-sizing.ts
src/main/                   Electron 主进程
  main.ts                   应用入口、窗口生命周期（已拆出 ipc-routes.ts / plugin-protocol.ts）
  environments.ts + env/    Environment Facade + lifecycle / session-factory / lease-coordinator / view-coordinator
  tabs.ts + domain/tabs.ts  Tab / TabManager：标签集合、WindowLayerManager 视图挂载、加载错误
  ui/                       5 层原生视窗栈（layer-order / layer-manager / overlay-host / popover-host / devtools-host）
  browser/                  CDP 控制层（controller / locator / actions / pointer-actions / form-actions / snapshot / screenshot / waits / dom-scripts / ops/*）
  input-shield.ts           Agent 持 lease 时的透明原生输入遮罩与光标轨迹
  telemetry.ts              Console / Network 持久化采集（warren.db，停/休眠保留、remove 才清理）
  rpc.ts + rpc/             Unix socket RPC 服务端（~/.warren/runtime/envd.sock）+ 按域拆分的单一 RPC_REGISTRY
  db.ts + store/            唯一 SQLite 连接 + 按域拆分的 store/{common,environments,memory}.ts
  domain/environment.ts     纯领域逻辑（状态机、lease 规则，可单测）
  vault/                    safeStorage 凭据库
  plugins/                  package.json#warren 校验 + installer/lifecycle/host + runtime-{base,host,sandbox}.ts + api/*
  skills/ + agent-integration.ts  内置与已启用插件 Skill 自动合成与刷新
src/renderer/               渲染层（app/ + features/{environments,plugins,settings}/ + state/ + lib/ + theme/）
packages/plugin-sdk/        独立插件包的类型契约（已纳入 tsconfig.check.json）
plugins/README.md           插件作者入口：npm 包格式 / 安装来源 / app.ui / base-ui 的坑
plugins/*/                  独立插件包（示例 / Whistle lib+ui / 账号管理 ui）
fixtures/login/             本地测试站点
scripts/                    serve-fixture / serve-shots / ui-promote / test-changed / regress/{lib.sh,*.sh}
tests/                      node:test 单测 + Vitest/happy-dom 无头 UI 测试（tests/ui/） + helpers/
assets/                     品牌资产（app icon.icns / icon.png + tray 图标）
legacy/                     旧的独立 Chrome 看板原型（前身，勿参考）
docs/                       PRD / 技术选型 / 设计语言 / 交接与改造文档
```

### 路径别名

| 别名 | 指向 | 用在哪 |
|---|---|---|
| `@/*` | `src/renderer/*` | 渲染层内部 |
| `@shared/*` | `src/shared/*` | 渲染层引用共享类型/权限 |

主进程和 preload **不用别名**，走相对路径。别名配置在两处，改一处必须同步另一处：

- `tsconfig.json` → `compilerOptions.paths`
- `vite.renderer.config.mjs` → `resolve.alias`

---

## 前端目录所有权（重点）

| 目录 | 归谁 | 规则 |
|---|---|---|
| `renderer/app/` | 应用装配 | 顶层布局、全局状态、provider。**不放业务组件** |
| `renderer/features/<域>/` | 业务组件 | 按业务域分目录（`environments/`、`plugins/`…）。跨域复用的组件才往上升 |
| `renderer/components/ui/` | **产品组件库** | 视觉单源。**改样式只改这里** |
| `renderer/components/ui-reference/` | shadcn stock 快照 | **禁止 import**。只由 `shadcn add` 写入 |
| `renderer/components/icons.tsx` | 图标单源 | 新图标加这里，不要在业务里直接引图标包 |
| `renderer/hooks/` | 通用 hooks | shadcn 产物落点（如 `use-mobile.ts`） |
| `renderer/lib/` | 渲染层工具 | `ipc.ts`（IPC 全局声明）、`labels.ts`（展示文案）、`utils.ts`（`cn`）、`disclosure-motion.ts` |
| `renderer/theme/` | 皮肤 token 与 recipe | `theme-tokens.css`、`surface.ts` |
| `renderer/globals.css` | 全局装配 | import 顺序 + 全局 corner-shape 段 |

### 镜像上游，不要挪动

`components/ui/`、`components/ui-reference/`、`components/icons.tsx`、`theme/`、`lib/utils.ts`、`lib/disclosure-motion.ts` 这几处**路径镜像上游 `web-next`**，目的是让组件库能低成本重新同步。
**不要**为了「目录好看」移动它们，也不要在这里放本项目独有的东西。

### 类型放哪

| 类型 | 位置 |
|---|---|
| 跨进程（主进程 ↔ preload ↔ 渲染层） | `src/shared/types.ts` |
| 只在一个进程内用 | 就近定义在该文件 |
| 组件 props | 组件文件内，不导出（除非跨文件复用） |

**判断标准**：这个类型会不会出现在 RPC 边界或 `contextBridge` 上？会 → `shared/`。

---

## 组件库工作流（重点）

```bash
npx shadcn@latest add <name> -o    # 落到 components/ui-reference/（stock）
npm run ui:promote -- <name> --force   # 提升到 components/ui/
npm run ui:diff                    # 对比 stock 与产品版差异
# 然后在 components/ui/<name>.tsx 里用 token + recipe 重绘
```

**禁止自己手写组件库已有的东西。** 需要按钮就 `@/components/ui/button`，需要菜单就 `@/components/ui/dropdown-menu` / `context-menu`，需要侧栏就 `@/components/ui/sidebar`。
先查 `ls src/renderer/components/ui/` 确认有没有，没有再 `shadcn add`。

### 三个必须知道的坑

1. **`npm run` 不透传参数**，`--force` 这类要给脚本的选项必须写成
   `npm run ui:promote -- <name> --force`，否则脚本收不到，会静默 skip。

2. **`shadcn add` 会覆盖同名 stock 文件**，且 `-y` 管不了这个确认（要 `-o`）。
   加组件前先 `--dry-run` 看它要写什么；被顺带覆盖的 stock 文件用
   `git checkout -- src/renderer/components/ui-reference/<f>.tsx` 还原。

3. **`shadcn add` 每次都会把 `cn` 塞进 `dependencies`** —— 这是 CLI 的固有 bug，
   不是需要的东西。加完组件检查 `git diff package.json`，把 `cn` 删掉。
   （`ui-reference` 里的 stock 文件引裸 `cn` 包，所以它已从 tsconfig 排除，
   见下条。）

### ⚠️ 这个组件库是 **base-ui**，不是 radix

`components/ui/` 里迁入的交互组件基于 `@base-ui/react`，API 与 radix 不同。按 radix 的习惯写会**通过类型检查但运行时静默不工作**：

| radix 写法 | base-ui 写法 | 不换会怎样 |
|---|---|---|
| `<Trigger asChild><div/></Trigger>` | `<Trigger render={<div/>}>` | 类型报错 |
| `<Item onSelect={fn}>` | `<Item onClick={fn}>` | **类型通过，点击无反应**（`onSelect` 是 React 的文本选择事件） |
| `<Label>` 随便放 | `<Label>` **必须在 `<Group>` 里** | **抛 `MenuGroupContext is missing`，整个 React 树被卸载成白屏** |

第三条尤其贵：坏的不是那一个菜单，是整个界面。所以渲染期异常要有 `ErrorBoundary` 兜底（`app/error-boundary.tsx`）。

### Sidebar 与 Resizable 的组合

- **用 `collapsible="none"`**。默认的 `collapsible="icon"` 用 `position:fixed` + `w-(--sidebar-width)`，那个宽度相对**视口**解析，嵌进 `ResizablePanel` 会变成整窗宽（视觉上可能碰巧正常，但布局是错的）。
- `SidebarProvider` 默认只有 `min-h-svh`，**min-height 不能给子元素的 `height:100%` 提供确定高度**——不显式给 `h-svh`，`ResizablePanel` 的高度会塌成 0。
- **`Panel` 的 `onResize` 对命令式 `collapse()` 不触发**（宽度确实变了，回调没来）。要判断收起态就用 `ResizeObserver` 观察实际渲染宽度——宽度才是唯一真相。
- `react-resizable-panels` v4：**数字是像素**，字符串才是百分比；`Group` 用 `orientation` 不是 `direction`；没有 `autoSaveId`。

### `ui-reference` 不进 typecheck

`tsconfig.json` 的 `exclude` 里有 `src/renderer/components/ui-reference`。

原因：stock 文件 `import { cn } from "cn"`（裸包），而 `cn` 依赖被有意删除，
所以 stock **必然**类型报错。它本来就「永不 import、永不构建」，让 tsc 检查它只是噪音。
**不要**为了让它通过而把 `cn` 加回依赖。

### `ui:promote` 自动改写什么

`scripts/ui-promote.mjs` 提升时会自动修掉 registry 生成文件固有的三类问题：

| 产物 | 改写成 | 为什么 |
|---|---|---|
| `from "cn"` | `from "@/lib/utils"` | CLI 写成裸 specifier；本项目的 `cn` 在 lib/utils |
| `@/components/ui-reference/` | `@/components/ui/` | registry 按 `components.json` 的 `aliases.ui` 生成导入，而那个别名指向 stock。**产品层禁止依赖 stock** |
| `"use client"` | 删除 | Next.js 指令，本项目是 Electron + Vite |

所以新组件提升后**不需要**手工修这三处。发现新的产物问题就往 `REWRITES` 里加规则，
不要在业务文件里手工打补丁。

---

## 设计契约（每个组件都适用）

1. **Token 先于组件** —— 几何/色/模糊/elevation 只改 `theme/theme-tokens.css`。禁止硬编码 hex、`h-8`、裸 `rounded-lg`。
2. **Recipe 先于局部 class** —— 字段/菜单/tooltip/focus 用 `@/theme/surface` 的共享类（`controlFieldClass`、`elevatedMenuSurfaceClass`…），不要每个文件重造。
3. **DEFAULT 即正确** —— 业务侧省略 `size`；图标用 `IconButton`，文字用 `Button`。
4. **角 = 半径 + 形状** —— chrome 必须带 `corner-shape: superellipse(1.5)`（pill / avatar 除外）。
5. **浮层分型** —— tooltip ≠ menu ≠ dialog，不要一套玻璃打天下。
6. **不要点名才改** —— 新控件默认走 contract。
7. **换肤只动 4 个 seed** —— `--theme-surface` / `--theme-surface-under` / `--theme-ink` / `--theme-accent`。

完整设计语言见 `docs/ui-design-language.md`；组件契约速查见 `src/renderer/components/ui/README.md`。

### 颜色

`success` / `warning` / `info` **不走 utility 类**，走任意值语法：`bg-[var(--success)]`、`text-[var(--warning)]`。
禁止 Tailwind 调色板色（`bg-emerald-500` 之类）。

---

## 编码规范

- **导入**：渲染层内部用 `@/…`；引共享类型用 `@shared/…`；不要写 `../../shared/types` 这种相对路径。
- **命名**：组件文件 kebab-case（`environment-sidebar.tsx`），组件导出 PascalCase。
- **状态**：跨组件共享的状态放 `app/App.tsx` 或就近的 feature 里，不引入状态库。
- **副作用**：轮询 / 订阅写在 `useEffect` 里并返回清理函数（参考 `App.tsx` 的遥测轮询）。
- **中文文案**：UI 文案用中文；代码注释用中文。

### ⚠️ Node ESM 的扩展名陷阱

`node --test` **直接加载 `.ts` 源文件**（不做打包）。因此：

- **运行时**导入（`import { x } from './y'`）在**被测试加载的文件链上必须带 `.ts` 扩展名**，否则 `ERR_MODULE_NOT_FOUND`。
- `import type` 会被编译期擦除，不受影响。

例：`src/main/plugins/package.ts` 引 `shared/permissions.ts` 必须写
`from '../../shared/permissions.ts'`（见该文件顶部注释）。
Vite 打包路径能吃 `.ts` 扩展名，所以这个写法对两端都成立。

**症状**：`npm test` 里某个测试文件整块消失、总数从 15 掉到 9——不是断言失败，是文件加载失败。

**同一条链上的第二个坑：TS 参数属性不能用。**
`node --test` 加载 `.ts` 走的是 **strip-only** 模式，`constructor(private readonly x: T) {}`
会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。**必须写成显式字段**：

```ts
#deps: Deps;
constructor(deps: Deps) { this.#deps = deps; }   // 不要 constructor(private readonly deps: Deps) {}
```

**第三个坑：被测试加载的文件链上不许 `import electron`。**
`node:test` 里没有 electron。要测的模块必须**只做 type-only import**
（`import type { Session } from 'electron'` 会被编译期擦除），或者**把真货用工厂注入进来**
（`net/ops.ts` 就是这么做的：`createInterceptor` 是个依赖，真货由 `environments.ts` 传）。

---

## 硬约束（安全边界，不是「暂时没做」）

1. **插件不是安全沙箱**。插件是独立 npm 包，清单在 `package.json#warren`，`apiVersion` 只有 `"4"`。
   `node:vm` 挡的是误用和越权 API 调用，**不是恶意代码**。UI 上不能谎称沙箱。
   要全权的插件走 `runtime: "host"`（独立 Node 进程，安装时明示）；渲染层 CSP 为插件开了
   `script-src 'self' warren-plugin:`，**只到 scheme 这一层，不许加 `unsafe-inline` / `unsafe-eval`**。
2. **Vault 没有 reveal 通道**。对外只有 `vault.list`（`ref` + 打码用户名）和 `vault.fill`（填进页面字段），**没有**读明文的通道。
3. **`warren vault add` 从 stdin 读秘密，不走 argv** —— 否则会出现在 `ps` 和 shell history 里。
4. **代理认证找不到凭据就拒绝认证**，不静默放行。
5. **Cookie 的宽形状权限仍在 `denied` 层**（`storage.cookie.read` / `write`，声明了也不给）。
   「只搬运不返回」的受控通道已经设计并落地：`storage.cookie.port`（confirm 层，值只在主进程内部流动，
   插件只拿到名字/域/过期/标志与计数），设计见 `docs/PLUGIN-CAPABILITY-DESIGN.md` §9。
   **新的 cookie 能力加在那条通道上，不要回头开 read / write。**
6. **权限分层是单一来源** —— `src/shared/permissions.ts`。**禁止**在任何一侧再抄一份表。
7. 凭据测试值一律 `[REDACTED]`。
8. **账号管理插件的明文存储是明确产品例外**。`com.warren.accounts` 把账号、密码、备注明文写进插件自己的
   `data.db`，不接 Vault；界面必须持续显示警告。不要把这条例外扩散到 Vault、代理凭据或其他插件。
   **agent 通道永远不返回明文**：`list`/`get` 只给 `hasPassword` + 打码用户名，登录走 `fill`
   （值只在主进程内部进页面），`reveal` 只对插件界面（`caller='ui'`）开放，`export` 需显式
   `{"confirm":"plaintext"}` 且仅供人手工备份。

---

## 已知问题与排查

### 1. 命令输出「看着有内容其实全是 undefined」

`bin/formatters.mjs` 的 `print(value, asJson, format)` —— **`format` 必须由调用方显式传**。
不同命令的数组元素形状完全不同（环境 / 事件 / 插件），给一个通用 formatter 会让所有数组套上环境的字段。
新增返回数组的命令时，必须同时写它的 `formatXxxLine`，否则默认逐条打 JSON（难看但不撒谎）。

### 2. 权限表出现两份

已修：统一从 `src/shared/permissions.ts` 直接引入（已在 Wave 1 移除 `package.ts` 二次转出）。**不要再抄**。

### 3. CDP DOM 域报 `Document needs to be requested first`

`DOM.pushNodesByBackendIdsToFrontend` 失败。每次 DOM 操作前必须先 `DOM.getDocument`。

### 4. 重启未生效的假象

`pkill` 后新实例可能因 Vite 端口 5173 被占直接退出，日志里不显眼，症状是「改了代码没反应」。

**固定清理步骤，别省**：

```bash
pkill -f "electron-forge start"; pkill -f "node_modules/electron/dist"; sleep 3
lsof -ti :5173 | xargs kill -9
rm -f ~/.warren/runtime/envd.sock ~/.warren/runtime/runtime.json
pgrep -f 'electron-forge start' | wc -l    # 必须是 0 再启动
```

### 5. 主进程单独跑 `vite build` 会报 `Cannot resolve entry module index.html`

**这是正常的**，不是错误。主进程入口由 electron-forge 的 vite 插件在运行时注入。
验证主进程构建要看 `npm start` 的日志（`target built src/main/main.ts`）。

### 6. 遥测 hook 抛异常会让目标半初始化

`webRequest` 的过滤器是 **URL 模式不是 glob**（`'*'` 会抛 `Invalid url pattern *: Missing scheme separator`，要写 `<all_urls>`）。
它从 `Telemetry.attach` 抛出会打断 `manager.start()`，导致视图建了但没初始化完，**之后所有 CDP 调用不是报错而是永久挂住**。
**诊断层永远不能弄坏它观察的东西** —— 遥测整体包在 try/catch 里。

### 7. CLI RPC 无超时会挂死 agent 回合

默认 60s 超时（`WARREN_TIMEOUT_MS` 可覆盖），返回独立 `TIMEOUT` 错误码。

### 8. 点击落在视图外且不报错

点击前必须 `DOM.scrollIntoViewIfNeeded`。静默失败最难查。

已加固（见 `docs/BROWSER-CAPABILITY-PORT-PLAN.md`）：动作现在会等元素可用（visible/stable/enabled）
并在超时内重试，被遮挡报「被 <x> 挡住」。**改动作相关的代码不要绕过 `actionability.ts` 的
`runAction` / `checkActionable`**，否则又回到「命令成功、页面没反应」。

### 9. `backendNodeId` 只在同一个 renderer 内唯一

拿一个 `backendNodeId` 去**另一个 CDP 会话**（另一个 target）里查 DOM，不会报错，
而是**静默命中那个会话里的无关元素**（实测：把环境页的节点 id 拿到 UI 窗口会话里查，
点到了 x=1445 的假坐标）。跨源 iframe 必须走 `Target.setAutoAttach` 拿本页自己的
OOPIF 会话，不能用 `Target.getTargets` 扫全浏览器的 target。

### 10. 插件前端的自定义协议必须在建窗口之前注册

`warren-plugin://` 靠 `protocol.handle()` 供给插件 bundle。**它必须在第一个渲染进程创建之前注册**
（即 `createWindow()` 之前）；注册晚了渲染层的请求**根本到不了处理器**，主进程一条日志都没有，
症状是渲染层报 `Failed to fetch dynamically imported module`。另外自定义 scheme 要
`registerSchemesAsPrivileged` 里带 `corsEnabled: true`，响应要带 `access-control-allow-origin`。

### 11. 被控页面能看见我们的注入

CSS / XPath 解析一律跑在**隔离世界**（`Page.createIsolatedWorld`，见 `controller.ts` 的
`#isolatedContext`）。**不要**再往被控页面写全局变量或打 `data-*` 标记——页面上的
`MutationObserver` / 反爬脚本看得见，页面上定义同名存取器还能直接把我们的定位搞失效（实测）。

---

## 修改后校验（分层策略，默认无头定向）

所有日常测试默认在**无头测试框架**运行（`node:test` + `vitest`/`happy-dom`，**不启动 Electron 窗口**）：

- **日常局部改动**（默认）：只跑静态检查 + 与改动相关的定向无头测试，避免每次全量耗时过长：

```bash
npm run check:changed                             # lint + format:check + typecheck + 改动定向无头测试
npm run test:changed                              # 仅跑与 git diff 关联的无头单测与 UI 测试
npm run test:ui                                   # 仅跑无头 React UI 套件（tests/ui/*.test.tsx，不启 Electron）
node --test tests/<相关文件>.test.ts              # 精确单文件无头验证
```

- **重大改造 / 跨多域变更**（涉及架构、公共契约或依赖升级）：跑全量无头门禁：

```bash
npm run check                                     # lint + format:check + typecheck + 全量无头 test:unit & test:ui + 渲染层构建
```

> 依赖版本约束与定期升级节奏见 `docs/DEPENDENCY-POLICY.md`。

- **全量真机 GUI 回归脚本（默认仅本地按需触发，已从 CI 移除）**：
  `scripts/regress/run-all.sh` 默认直接拒绝运行（不作为日常改动步骤，CI 也不再运行 `gui-regression`），UI 回归已迁移至无头 `tests/ui/`（Vitest + happy-dom）。仅在跨多域大改造或发版前确需真机全量验证时，手动在本地执行 `bash scripts/regress/run-all.sh --allow-full`。

这几条无头门禁对应 CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）的 `static-gates` job；push 到 `main`、`v*` tag 或手动触发时还会运行 `package-macos` 产出 `.dmg` / `.zip` 安装包。

**lint 说明**：用 `oxlint` 而不是 eslint——`typescript-eslint` 硬拒绝本项目的
TypeScript 7.0.2（原生预览版），装不上。规则与忽略清单在 `.oxlintrc.json`，
版本钉死（新版本会加新规则，让 CI 无故变红）。`react` / `jsx-a11y` 插件**已开**，
只剩 `label-has-associated-control` 一条关着（它只可能在 `Label` 原语里触发，关联是调用方的
`htmlFor`）。另外两条是**行内豁免**，不是规则级关闭：`prefer-tag-over-role` 的 5 处命中
各留一行 `oxlint-disable-next-line` 加理由，`react/set-state-in-effect` 开着且 11 处已重构。
**新加 ignore / 关规则 / 行内豁免，必须照这个格式写清为什么。**

**format 说明**：prettier 只管**本项目自己的代码**（`printWidth: 120` + 单引号）。
`.prettierignore` 排掉了三类别碰的东西：**镜像上游 `web-next` 的路径**（上游是双引号，
格式化它们等于每次同步都多一份冲突）、`fixtures/`（紧凑 CSS 是刻意的）、`docs/` 与 `*.md`
（手写长文，重排只有噪音）。加文件前先看这份 ignore 清单。

**仅在改到 Electron 主进程窗口 / 原生视图 / 视觉排版且确需真机核验时**，按需定向重启并实测改动点（不要默认跑全量 `run-all.sh`）：

```bash
# 按上文「第 4 条」清理后
npm start
node scripts/serve-fixture.mjs 8899    # 另一个终端

node bin/warren.mjs call debug.layout  # 探针：返回 0,0,800,600 说明渲染层没挂载
```

**渲染层挂载探针**：`debug.layout` 返回 `viewport: {x:306,y:121,width:1124,height:790}`（实测值，窗口尺寸变了会变）说明挂上了；返回默认 `0,0,800,600` 说明没挂。
判据看 `viewVisible: true` 和 `viewport` 不是默认值，**不要**照抄某个具体数字。

### 界面「对不对」怎么验

**优先用 `debug.rendererEval` 读 DOM**——界面是 DOM，直接查结构比看像素可靠得多：

```bash
node bin/warren.mjs call debug.rendererEval '{"script":"document.querySelectorAll(\"[data-slot=sidebar-menu-button]\").length"}'
```

一次调用里跑一段 async IIFE 可以测交互（右键菜单、折叠、点击）：

```js
(async () => {
  const btn = document.querySelector('[data-slot="sidebar-menu-button"]');
  const r = btn.getBoundingClientRect();
  btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2, buttons: 2, clientX: r.left + 30, clientY: r.top + 10 }));
  await new Promise((s) => setTimeout(s, 300));
  const popup = [...document.querySelectorAll('[data-slot="context-menu-content"]')].filter((e) => e.hasAttribute('data-open'));
  return popup.flatMap((m) => [...m.querySelectorAll('[data-slot="context-menu-item"]')].map((e) => e.textContent.trim()));
})()
```

**坑**：查菜单只认 `data-open` 的。base-ui 的 popup 关闭后仍留在 DOM 里，`querySelector` 会命中上一个已关闭的菜单，让你以为渲染错了。

**拖拽**（`ResizableHandle`）无法用合成事件模拟——它要 `setPointerCapture`。键盘方向键可以：分隔条可聚焦，ArrowLeft/Right 调整宽度。

视觉模型不可用时，才退回像素统计：

```bash
node bin/warren.mjs call debug.focusWindow   # → {x,y,width,height}
screencapture -x -R x,y,w,h shots/out.png
python3 -c "from PIL import Image;import numpy as np;a=np.asarray(Image.open('shots/out.png').convert('RGB'));print(a.mean(0).mean(0))"
```

判据示例：暗色主题左侧栏对应 `--theme-surface: #181b21`（RGB ≈ 24, 27, 33）；区域暗像素占比可验证遮罩/横幅是否渲染。

---

## 项目变更记录

涉及以下任一变更，**必须**同步更新 `docs/HANDOFF.md` 的「当前状态」一节：

- 目录结构 / 路径别名
- RPC 方法或 CLI 命令的增删改
- 数据模型（`Environment`、`Group`…）
- 硬约束或权限分层
- 运行方式（端口、运行时目录、环境变量）

---

## 历史文档说明

| 文档 | 定位 |
|---|---|
| `docs/PRD.md` | 产品需求、Environment 数据模型、里程碑、验收标准 |
| `docs/TECH-STACK-RESEARCH.md` | 技术选型与被拒方案及理由 |
| `docs/ui-design-language.md` | 完整设计语言（无实机对照时用这份） |
| `docs/UI-KIT-MIGRATION.md` | 组件库迁移来源与适配记录 |
| `docs/HANDOFF.md` | **会话交接：决策 / 当前状态 / 踩坑 / 接手起点**。新线程先读这份 |
| `docs/WHISTLE-PROXY-FEASIBILITY.md` | 每环境一个 whistle 实例的可行性调研：卡点、实测数据、改动清单、分期（§6 的「必须核心托管」已被 `WHISTLE-PLUGIN-PLAN.md` 推翻） |
| `docs/WHISTLE-PLUGIN-PLAN.md` | **Whistle 代理插件施工图 + 实测**：调研数据、架构决定、核心三处改动、插件设计、W1–W4 验收记录 |
| `docs/APPROVAL-EMBED-MEMORY-PLAN.md` | **审批策略**（控制权 / 插件确认可配置）、**代理面板开在环境 Tab 里**、**记忆插件**、**数据统一到 `WARREN_HOME`**：施工图 + W1–W4 逐项实测 |
| `docs/PLUGIN-CAPABILITY-DESIGN.md` | **插件能力设计（对标 BB Plugin SDK）**：现状缺口、surface 挂载点、kv/SQLite、runtime 分级、分期验收 |
| `docs/PLUGIN-MODERNIZATION-PLAN.md` | **插件改造施工图 + 实测记录**：模块图、逐文件改动、落地踩到的 7 个坑、明确的边界 |
| `docs/PLUGIN-PACKAGE-MIGRATION-PLAN-2026-10-20.md` | **插件全量迁移**：独立 npm 包、path/npm/git 安装、v4 契约、账号管理插件 |
| `docs/BROWSER-CAPABILITY-DEEP-DIVE.md` | **实现级**对标：Playwright 内部机制 vs `src/main/browser/` 逐模块，差距清单 + 补法排序 |
| `docs/BROWSER-CAPABILITY-PORT-PLAN.md` | **移植计划**：要移植哪些算法/机制、落到哪个文件、逐条验收命令 + 自循环验证协议（RED→GREEN→REGRESS） |
| `docs/NET-INTERCEPT-PLAN.md` | **网络拦截通用能力**：`ses.protocol.handle` 方案（R8–R11 已实测）、规则模型、批次与验收。whistle 降级为兜底 |
| `docs/FULL-REGRESSION-2026-10-15.md` | **全量回归记录**：`scripts/regress/run-all.sh` 跑什么与历史修复记录 |
| `docs/CODE-ARCHITECTURE-QUALITY-PLAN-2026-11-27.md` | **全仓库零 Shim 代码质量与架构质量改造计划**：Wave 0–4 实施路线、第 5 节文档校准清单与第 6 节端到端实测协议 |

`legacy/` 是前身原型（独立 Chrome 进程看板），**不作为当前实现依据**。
