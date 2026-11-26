<img src="assets/icon.png" alt="Warren" width="72">

# Warren

面向 AI Agent 的本地隔离浏览器工作台。

一个 **Environment** = 独立浏览器存储（Cookie / localStorage / 登录态）+ 独立代理出口 + 独立双空间页面实例（**Person Space** 与 **Agent Space**）。
AI 通过 `warren` CLI 操作 **Agent Space**，你在桌面端实时查看并可随时无缝接管，同时保留自己独立的 **Person Space** 浏览区。

> **名字的由来**：warren 是兔子的地下洞网络——一整片地道，**每个洞有自己的出入口**。
> 每个环境一个独立身份、一个独立出口，整片洞属于同一个系统。
> 旧 Chrome 看板原型已移入 `legacy/`；产品契约见 [`docs/PRD.md`](docs/PRD.md)，技术选型见 [`docs/TECH-STACK-RESEARCH.md`](docs/TECH-STACK-RESEARCH.md)，总交接见 [`docs/HANDOFF.md`](docs/HANDOFF.md)。

## 快速开始

```bash
npm install
npm start                 # 启动桌面端（Electron Core + 本地 Unix Socket RPC）
```

另一个终端：

```bash
node bin/warren.mjs env list
node bin/warren.mjs help
```

## 核心概念

| 概念 | 含义 |
|---|---|
| **Environment** | 可寻址的隔离浏览器运行单元：独立 `session`、独立代理、独立 `trustedCa` 与标签页集合 |
| **Person / Agent Space** | 同环境共享 Cookie 与代理出口的两套独立 Tab 工作区：人用 Person Space 免 lease，Agent 默认只操作 Agent Space |
| **Core** | Electron 主进程。管理生命周期、Session、5 层原生视窗栈、控制权、遥测与插件宿主 |
| **`warren` CLI** | AI Agent 接口（`bin/warren.mjs` → `bin/cli.mjs`）：支持原子命令、`batch` 批处理、`exec` VM 脚本、`--skill` 动态说明书 |
| **Lease** | Agent Space 写许可；同一时刻只有 Agent 或人一方能写。Agent 持锁时页上浮透明原生 AI 护盾挡住人工误触 |

**读取不需要 lease，写入必须持 lease。左侧选中环境 ≠ 获得写权限。**

## 桌面壳与原生视窗架构

- **两层极简桌面壳 + 全球保活页**：
  - Row 1 顶栏（`40px`）：侧栏折叠（`⌘B`）、当前环境胶囊、`我的 | Agent` Space 切换器、标签条、Agent 上下文控制权胶囊、`⌘K` 命令面板、全局设置；
  - Row 2 地址栏（`40px`）：导航控制、URL 拆层高亮 + 一键复制、Omnibox 历史联想、插件快捷微标/浮窗槽（`statusBadge` / `popover`）、缩放/视口预设/下载/DevTools/检查器开关；
  - 进入「设置」或插件全屏 `railPage` 时保留底层侧栏与网页状态，切回零重建。
- **5 层固定原生视窗栈（`WindowLayerManager`）**：`below → page → devtools → shield → overlay`（统一 `8px` 圆角），彻底避免原生 `WebContentsView` 被渲染层 DOM 误遮挡或弹出浮层藏页。
  - **`OverlayHost`**：透明无边框预热顶层窗，承载 `⌘K` 命令面板与新建/确认弹窗；
  - **`PopoverHost`**：低延迟弹出宿主，承载地址栏历史联想、页内查找与插件 `popover` 独立浮窗；
  - **`DevToolsHost`**：基于 `setDevToolsWebContents` 的停靠式原生 Chrome DevTools（支持 `right` / `bottom` / `detach` 三态切换）。
- **右侧检查器 & 6+N 设置中心**：
  - 右侧按需开关检查器 drawer 含 6 个内置面板（`events`、`snapshot`、`console`、`network`、`rules`、`storage`）与插件贡献 `inspectorTab`；
  - 可搜索设置中心含 6 个内置分节（`general`、`browser`、`agent`、`vault`、`plugins`、`diagnostics`）与插件贡献 `settingsSection`；
  - 支持浅色 / 深色（`#181b21`）/ 跟随系统 4-seed 主题体系（`src/renderer/theme/theme-tokens.css`），全局 `<Toaster position="top-center" />`。
- **透明 AI 护盾（`src/main/input-shield.ts`）**：Agent 持 lease 时仅在四周浮现高对比光学光晕与阻尼虚拟动作光标/锚框，中心 100% 透视；拦人误点击但允许 Agent CDP 事件直达。

## CLI 与能力总览

```bash
# 环境与分组
warren env list
warren env create alpha --proxy=http://127.0.0.1:9001 --start-url=https://example.com
warren env start|stop|hibernate|wake|remove|select <name>
warren env acquire <name> [--wait=5000]          # 获取 Agent Space 控制权
warren env renew|release <name> --lease=<leaseId>
warren env doctor <name>                        # 代理 / 证书 / 登录 / 本地端口体检
warren env egress <name>                        # 查看出口代理、CA 与当前状态

# 高密读取、语义查找与增量差分
warren browser open <env> <url> [--read]
warren browser snapshot <env> -i -u [--filter=...] [--content-boundaries]
warren browser read <env> --outline --links --data
warren browser click|fill|check|select <env> @1 ...
warren browser find <env> role button click --name=登录
warren browser get <env> title|url|text|html|value|attr|box [target]
warren browser is <env> visible|enabled|checked <target>
warren browser diff <env> snapshot|screenshot|urls
warren browser screenshot <env> [--annotate] [--output=/tmp/a.png]
warren browser set <env> viewport 1280 800
warren browser vitals|a11y|react|webmcp <env>
warren browser console|network|events <env>

# 批处理（带 Delta Receipt）与站点笔记 / 只读 API Flow
warren batch <env> --bail <<'EOF'
goto https://example.com
snapshot -i
EOF
warren notes set example.com "登录需要两步跳转"
warren flow steps <env>

# VM 脚本（仅暴露 5 个全局：page, console, setTimeout, clearTimeout, emitResult）
warren exec alpha <<'JS'
await page.goto('https://example.com');
const snap = await page.snapshot();
emitResult({ url: snap.url, count: snap.nodes.length });
JS

# RPC 目录、Skill 合成与外部同步
warren methods
warren --skill [--base-only|--full|--plugin=<id>]
warren skills status|install|refresh|plugin
```

`warren exec` 脚本运行在独立 `node:vm` 受限上下文内，只注入 `page` / `console` / `setTimeout` / `clearTimeout` / `emitResult`，绝不暴露 `process` / `require` / `fs` / 网络模块。

## 数据根目录与 Vault 凭据

- **统一数据根目录（`src/main/paths.ts` / `bin/paths.mjs`）**：默认 `~/.warren`（可用 `WARREN_HOME` 覆盖）：
  - `<WARREN_HOME>/app/`：Electron 窗体 `userData`
  - `<WARREN_HOME>/core/warren.db`：唯一 SQLite 数据库（WAL），保存环境、分组、历史、遥测、域名偏好、站点笔记、`saved_flows`、插件注册表与 **Vault 密文表（`vault`）**
  - `<WARREN_HOME>/core/sessions/<env>/` & `plugins/<id>/`
  - `<WARREN_HOME>/runtime/envd.sock` & `runtime.json`：本地 Unix Socket RPC 端点与随机 `0600` token
  - `<WARREN_HOME>/whistle/`：Whistle 实例注册表与共用根证书（`WHISTLE_PATH`）
- **Vault 安全边界**：
  - 使用 Electron `safeStorage` 加密，CLI `warren vault add <provider> --label=<name>` **只从 stdin 读秘密**；
  - 对外只有 `vault.list`（返回 `ref` + 打码 `usernameHint`）与 `vault.fill`（受控域白名单校验并直填页面字段），**没有明文 `reveal` 通道**，并拒绝 `"toString"` 等原型字段访问；
  - 代理认证在 `app.on('login')` 按 host 查找 `provider=proxy` 凭据，未命中直接拒绝认证。

## 插件体系（v4）

插件是独立 npm 包，契约声明在 `package.json#warren`（只接受 `apiVersion: "4"`），类型声明见 [`packages/plugin-sdk`](packages/plugin-sdk/index.d.ts)，详细开发规范见 [`plugins/README.md`](plugins/README.md)。

内置与示例插件包括：`account-manager`（`com.warren.accounts`）、`whistle`（`com.warren.whistle`，内置 `whistle@2.10.15`）、`example-login`、`example-cookies`、`example-notes`、`example-host`。

> **账号管理插件产品例外**：`com.warren.accounts` 按产品设计将账号/密码/TOTP/扩展字段明文存入自身 `data.db`（界面持续展示警示），但 **Agent 通道绝不返回明文**：`list`/`match`/`get` 只返回 `usernameHint` / `hasPassword` / `hasTotp`，`reveal` 与 `totpCode` 仅限 `'ui'`，自动填充强制校验非空 `allowedDomains`。

### 权限三层（单一来源：`src/shared/permissions.ts`，共 19 项）

| 层级 | 权限项 | 行为 |
|---|---|---|
| `granted` (6) | `environment.read`、`browser.dom.read`、`browser.screenshot`、`ui.mount`、`storage.write`、`rpc.serve` | 安装即授予 |
| `confirm` (8) | `environment.write`、`browser.navigate`、`browser.input`、`vault.fill`、`network.observe`、`network.fetch`、`storage.cookie.port`、`events.subscribe` | 须显式批准（`warren plugin grant` 或界面授权） |
| `denied` (5) | `browser.evaluate`、`storage.cookie.read`、`storage.cookie.write`、`process.spawn`、`filesystem.read` | **永久禁用**，声明了也不会授予 |

### 插件运行时边界与强杀超时

- **`runtime: "sandbox"` 与 `runtime: "host"` 均运行在可强杀子进程内**（Electron 下 `utilityProcess.fork` / 测试下 `child_process.fork`），单次 `activate` / `command` / `rpc` 调用均受 **`30_000ms` 默认超时强制击杀保护**（可通过 `WARREN_PLUGIN_TIMEOUT_MS` 调整，超时返回 `PLUGIN_TIMEOUT`）。
- `sandbox` 在子进程内加一层受限 `node:vm` 挡住误用与越权 API（无 `require` / `fs` / `process`）；`host` 在独立 Node ESM 子进程拥有完整 Node API。
- **两者均非 OS 级恶意代码安全沙箱**，只应安装受信任的插件。

```bash
# Whistle 预设模板示例（基于 instance storage 合成并防并发覆盖）
warren plugin run com.warren.whistle presetPreview --input='{"storage":"<instance>","scenario":"test"}'
warren plugin run com.warren.whistle presetApply --input='{"storage":"<instance>","scenario":"test","expectedHash":"<preview-hash>"}'
```

## CDP 与遥测边界

- **禁止长驻 `Runtime.enable` / `Network.enable`**：`browser/session.ts` 只长开 `Page.enable` 与按需 `Target.setAutoAttach`（OOPIF 跨源 iframe 支持）；Console / Network 遥测完全走 Electron 原生 `console-message` 与 `webRequest` 事件并持久化入 `warren.db`（每标签保留 300 条，停用/休眠保留历史、删除环境彻底清理）。
- 页面定位与操控在**隔离世界**（`Page.createIsolatedWorld`）或受控 `Runtime.callFunctionOn` / `DOM.*` / `Accessibility.getFullAXTree` / `Input.*` / `Emulation.*`（`browser set` 与视口覆盖）上运行，绝不向页面全局挂载可被反爬脚本篡改的变量。

## 仓库结构

```text
bin/                          Agent CLI（入口 warren.mjs + cli.mjs / commands/*.mjs / exec-runtime.mjs / output-guard.mjs）
src/shared/                   跨进程单一契约（permissions.ts / plugin-host-api.ts / popover-sizing.ts / types/*.ts）
src/main/                     Electron 主进程（Core）
  main.ts / ipc-routes.ts     应用入口、窗口装配、IPC 路由与自定义协议（plugin-protocol.ts）
  environments.ts / env/      Environment Facade 与 lifecycle / session-factory / lease-coordinator / view-coordinator
  ui/                         5 层原生窗口栈（layer-order / layer-manager / overlay-host / popover-host / devtools-host）
  browser/                    CDP 控制与高阶浏览器能力（controller / locator / actions / waits / snapshot / screenshot / ops/*）
  net/                        网络拦截器与 HAR 录放（interceptor / ops / rules / har）
  plugins/                    插件宿主（host / package / source / installer / lifecycle / registry / api/* / runtime-* / worker-process）
  skills/ & agent-integration.ts  内置 Skill 与已启用插件 Skill 自动合成同步
  rpc/                        按域拆分的单一 RPC_REGISTRY 与派发器
  store/ & db.ts & vault/     SQLite WAL 数据库、分域仓储与 safeStorage 凭据库
src/preload/                  contextBridge 类型安全 IPC 桥
src/renderer/                 React 19 + Vite 8 + Tailwind v4 + base-ui 桌面界面（app/ / features/ / state/ / lib/ / theme/）
packages/plugin-sdk/          @warren/plugin-sdk 类型契约（已纳入 tsconfig.check.json）
plugins/                      内置与示例插件（account-manager / whistle / example-*）
scripts/                      fixture 服务、变更筛选测试及 regress 套件
tests/                        node:test 单元测试 + Vitest/happy-dom 无头 UI 测试（tests/ui/）
docs/                         架构设计、交接（HANDOFF.md）与改造记录
```

## 开发与校验

```bash
npm run check:changed         # 日常推荐：lint + format:check + typecheck + 关联无头单测与 UI 测试
npm run test:ui               # 仅跑无头 React UI 测试（Vitest + happy-dom）
npm run check                 # 重大改造全量门禁：oxlint + prettier + tsc + 全量 node:test + vitest + vite build
npx tsc -p tsconfig.check.json  # 覆盖 src/ + tests/ + packages/plugin-sdk/index.d.ts 的全量类型检查
```
