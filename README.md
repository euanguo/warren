<img src="assets/icon.png" alt="Warren" width="72">

# Warren

面向 AI Agent 的本地隔离浏览器工作台。

一个 **Environment** = 独立浏览器存储 + 独立代理 + 独立页面实例。
AI 通过 `warren` CLI 操作指定环境，你在桌面端看同一个环境的同一个页面，需要时接管。

> **名字的由来**：warren 是兔子的地下洞网络——一整片地道，**每个洞有自己的出入口**。
> 这正是这个项目要做的事：每个环境一个独立身份、一个独立出口，整片洞属于同一个系统。
> 前身叫 `worktree-profiles`，那是错的：这个应用不认识 worktree，它只认识隔离的环境和隔离的代理。

> 这个仓库的前身是一个独立 Chrome 进程看板，已移到 `legacy/`。
> 当前产品形态见 `docs/PRD.md`，技术选型见 `docs/TECH-STACK-RESEARCH.md`。

## 快速开始

```bash
npm install
npm start                 # 启动桌面端（同时启动 Core 和本地 RPC）
```

另一个终端：

```bash
node bin/warren.mjs env list
```

## 核心概念

| 概念 | 含义 |
|---|---|
| Environment | 可寻址的隔离浏览器运行单元：独立 Session、独立代理、独立页面 |
| Core | Electron 主进程。持有 Environment、Session、WebContentsView、控制权、事件流 |
| `warren` | Agent 的接口。形态参考 ego-browser：一次调用可以跑一整段脚本 |
| Lease | 写操作许可。同一环境同一时间只有一个主体（agent / human）能改页面 |

**读取不需要 lease，写入必须持 lease。左侧选中环境 ≠ 获得写权限。**

## CLI

```bash
# 环境
warren env list
warren env create alpha --proxy=http://127.0.0.1:9001 --start-url=https://example.com
warren env start|stop|remove|select <name>
warren env hibernate|wake <name>   # 休眠 / 唤醒（休眠保留配置与标签快照）
warren env acquire <name>          # 取写权限，返回 leaseId
warren env release <name> --lease=<leaseId>
warren env takeover <name>         # 模拟人工接管
warren env egress <name>           # proxy / trustedCa / 页面状态（nodes 不再取 AX 快照）

# 读
warren browser snapshot <env>
warren browser screenshot <env> --output=/tmp/a.png

# 写
warren browser open <env> <url> --lease=<leaseId>

# 页面内取数（cache 可选：reload / no-store / force-cache 等标准 RequestCache）
warren exec alpha <<'JS'
const result = await page.fetch('https://cdn.example/app.js', {
  cache: 'reload',
  saveAs: '/tmp/app.js',
});
console.log(result.status);
JS

# Agent 主入口：一次调用跑一整段，自动 acquire/release
warren exec alpha <<'JS'
await page.goto('https://example.com');
const snap = await page.snapshot();
console.log(snap.url, snap.nodes.length);
await page.getByRole('link', { name: 'Learn more' }).click();
JS

warren events [env]

# 凭据：只暴露「列清单」和「填进页面」，没有 reveal
warren vault list
warren vault add <provider> --label=<name>     # 秘密从 stdin 读，不走 argv
warren vault remove <ref>
warren vault fill <ref> --env=<env> --field=password --target='{"kind":"label","text":"密码"}'

# 插件
warren plugin list
warren plugin install path:<目录>
warren plugin install npm:<包名>[@版本]
warren plugin install git:<仓库>#<ref>
warren plugin update <id>
warren plugin enable|disable|uninstall <id>
warren plugin grant <id> <permission...>
warren plugin run <id> <command> --env=<env>
```

Whistle 预设可按场景组合，避免每次手选规则组：

```bash
# online：仅预发布 CDN
# test：预发布 CDN + 官方完整测试后端
# local：本地静态资源替换（预发布 CDN 仍在）
# preview：预发布 CDN，显式关闭本地静态资源替换
warren plugin run com.warren.whistle presetPreview --env=<env> --input='{"scenario":"test"}'
warren plugin run com.warren.whistle presetApply --env=<env> \
  --input='{"storage":"<instance>","scenario":"test","expectedHash":"<preview-hash>"}'
```

`page` 可用：`goto` `snapshot` `screenshot` `waitFor` `click` `fill` `press`
`getByRole().click()/fill()` `getByText().click()` `getByLabel().fill()` `locator().click()/fill()`。

脚本运行在 `node:vm` 受限上下文里，只有 `page` / `console` / 定时器；
不暴露 `process` / `require` / `fs` / 子进程 / 网络模块。

## 凭据（Vault）

- 用 Electron `safeStorage` 加密，密钥由系统密钥存储保管（macOS 走 Keychain）
- 落盘文件 `<userData>/core/vault.json`，权限 `0600`，内容是密文
- **对外只有两个动作**：`vault.list`（返回 `ref` + 打码用户名 `v***@example.com`）和
  `vault.fill`（把值填进页面字段，返回 `{filled:true, field}`）。**没有 reveal 通道**
- CLI 的 `vault add` 从 stdin 读秘密，不走 argv——否则会出现在 `ps` 和 shell history 里
- 代理认证：`app.on('login')` 里按 host 去 Vault 找 `provider=proxy` 的凭据；找不到就
  拒绝认证，**不会静默放行**

## 插件

插件是独立 npm 包，契约在 `package.json#warren`。不再使用独立的 `manifest.json`；
`apiVersion` 只接受 `"4"`。安装来源支持 `path:` / `npm:` / `git:`，详见 `plugins/README.md`。

```bash
node scripts/serve-fixture.mjs 8899 &
echo '{"username":"tester@example.com","password":"[REDACTED]"}' | warren vault add example --label=fixture
warren plugin install path:plugins/example-login
warren plugin enable com.example.login
warren plugin run com.example.login login --env=alpha
warren plugin grant com.example.login browser.navigate browser.input vault.fill
warren plugin run com.example.login login --env=alpha
```

现有插件：`example-login`、`example-cookies`、`example-notes`、`example-host`、
`whistle`、`account-manager`。Whistle 的 npm 依赖在插件自己的安装目录里，默认不需要系统预装 `w2`。

账号管理插件 `com.warren.accounts` **按产品要求明文存储**账号、密码和备注，不接 Vault；
只放不重要账号。

### 权限分三层

| 层 | 权限 | 行为 |
|---|---|---|
| `granted` | `environment.read` `browser.dom.read` `browser.screenshot` | 安装即授予 |
| `confirm` | `browser.navigate` `browser.input` `vault.fill` `network.observe` | 必须显式 `plugin grant` |
| `denied` | `browser.evaluate` `storage.cookie.*` `process.spawn` `filesystem.read` | **声明了也不给**，只会被静默降级并显示给用户 |

`denied` 那层是刻意的：**「声明的权限都自动给」等于把清单当成提权手段。**

升级新增的 `granted` 权限自动生效；新增的 `confirm` 权限留在待确认列表，必须再批准。

### 插件能拿到什么

`host` API 覆盖环境、浏览器、Vault 受控填充、插件 kv/SQLite、设置、日志、信号和 UI 通知；
具体能力看 `src/main/plugins/api.ts`，权限门控看 `src/shared/permissions.ts`。

**没有** `fs`、`child_process`、`require`、`process`、raw Session、raw WebContents、
明文密码。插件调用 `vault.fill` 得到的只有「填好了」。

插件写页面会自动 acquire 一个 `plugin:<id>` 的 lease，跑完在 `finally` 里释放——
所以插件和 agent / 人不会同时写同一个环境。

### 插件的真实边界（别当成沙箱）

- `sandbox` 插件跑在 `node:vm` 上下文里，**这不是安全沙箱**；它挡住的是误用和越权 API 调用，
  不是恶意代码。
- `host` 插件跑在独立 Node 进程里，有完整 `fs` / `child_process` / 第三方依赖能力。
- `vm` 的 `timeout` 只覆盖模块求值，**不覆盖插件异步 `run()` 的执行时间**。
- 因此只应安装你信任的插件；UI 上也必须如实这么写。

## 桌面端

左侧 Environment 列表，右侧当前环境的真实页面（`WebContentsView`），底部四个标签页：
**事件 / Agent 快照 / Console / Network**。顶部显示当前 URL、控制者和接管/交还按钮，
左侧顶部有「插件」入口（插件列表 + 权限确认 + 凭据管理）。

### 输入遮罩（同一时间只有一个主体能操作）

Agent 持有 lease 时，页面会被一个原生遮罩盖住，人点不动；点顶部「接管」后遮罩立刻撤掉。

为什么必须是原生 View：环境页面本身就是 `WebContentsView`，它不参与 DOM 层叠，
渲染层放什么都会被它盖住。要挡住它只能在它上面再放一个原生视图。

**遮罩只拦人**：Agent 走 CDP 直接对目标渲染进程发输入事件，不经过遮罩。实测确认——
遮罩盖上时 Agent 的 `click` 依然生效。

`warren call debug.layout` 可以看当前几何和遮罩状态：

```json
{ "viewport": {...}, "selected": "alpha", "viewBounds": {...},
  "shieldAttached": true, "owner": "agent" }
```

如果它显示默认的 `0,0,800,600`，说明渲染层没挂载。

### Console / Network

用 Electron 原生事件采集（`console-message` + `webRequest.onCompleted`），
**不碰 CDP 的 `Runtime.enable` / `Network.enable`** —— 既省掉检测面，也不用为了看日志
把页面置于调试状态。

```bash
warren browser console <env>
warren browser network <env>
```

两者都是主进程侧的环形缓冲（各 300 条），界面每 1.5 秒轮询一次。

前端用 **shadcn/ui + Tailwind v4**：

```bash
npx shadcn@latest add <component>     # 加组件
npx shadcn@latest info                # 看当前配置
```

- 全局样式：`src/renderer/globals.css`（shadcn 语义 token，固定深色，`<html class="dark">`）
- 组件：`src/renderer/components/ui/`，业务组件在 `src/renderer/components/`
- 别名：`@/*` → `src/renderer/*`（`components.json` + `tsconfig.json` + vite alias 三处已对齐）
- 图标统一走 `@/components/icons`（Hugeicons 单源），组件内图标用 `data-icon`，不加尺寸类

`WebContentsView` 是原生视图，不遵守 DOM 布局，所以渲染层会把右侧占位区的实际矩形
通过 IPC 报给主进程，由主进程设置视图 bounds。`warren call debug.layout` 可以看到
渲染层实际报上来的几何——如果它显示默认的 `0,0,800,600`，说明渲染层没挂载。

## Agent-first 的设计取舍

- **寻址，不切换**：每个调用都带环境 ID，没有隐式的「当前环境」。
- **结构化观察优先**：`snapshot()` 返回可访问性树（role + name + backendNodeId），
  不是截图。截图只给人和视觉模型。
- **只用 CDP 的干净子集**：`Page.navigate` / `Page.captureScreenshot` /
  `Accessibility.getFullAXTree` / `DOM.*` / `Input.*`。不碰 `Runtime.*`、`Console.*`、`Emulation.*`。
- **不引入第二套浏览器**：Agent 操作的就是右侧那个页面实例，不是 Playwright 起的另一个浏览器。

## 当前状态

已完成：

- Electron 桌面端（shadcn/ui + Tailwind v4）：Environment 列表、右侧真实页面、快速切换、事件 / Agent 快照面板
- Environment 独立 Session（`session.fromPath`）+ 独立代理（`session.setProxy`）
- 本地 RPC（Unix socket + 启动时生成的随机 token，权限 0600）
- `warren` CLI：环境管理、快照、导航、点击、输入、按键、等待、截图
- 控制权 Lease：acquire / release / takeover，写操作校验
- 代理认证走主进程 `login` 事件 + Vault，密码不进入页面
- **M3 Vault**：`safeStorage` 加密、无 reveal 通道、`vault.fill` 直填页面
- **M4 PluginHost**：npm 包契约、三层权限、sandbox / host 运行时、自动 lease、插件存储
- **第一个插件**：`plugins/example-login`（本地 fixture，含 3 个命令）
- **M2 输入遮罩**：Agent 持 lease 时原生遮罩挡住人工输入，接管后立刻撤掉
- **M2 遥测**：Console / Network 面板（Electron 原生事件，不碰 CDP 的 enable）
- **插件 UI**：插件列表、三层权限展示与授权、凭据列表

未完成（按 `docs/PRD.md` 的里程碑）：

- **M2 剩余**：超时与取消（`vm` 的 timeout 不覆盖异步体）、trace ID
- **M4 剩余**：插件市场
- **M5**：打包签名（LRU 环境回收、崩溃恢复、SQLite 迁移已落地）

已知边界：

- 插件不是安全沙箱（见上文「插件的真实边界」）。
- 插件异步 `run()` 没有执行时限——`vm` 的 timeout 只管模块求值。要真限制得放进子进程。
- `storage.cookie.*` 宽形状权限仍在 `denied` 层；Cookie 插件只能走
  `storage.cookie.port` 的「只搬运元数据 / 不返回值」通道。
- 环境数量没有上限，也还没有 LRU 休眠；同时开很多环境会吃内存。
- 点击依赖 `DOM.scrollIntoViewIfNeeded`，视口外的元素会先滚进来。
- 应用退出时不会 kill 掉 Electron 的辅助进程；`manager.shutdown()` 只销毁 WebContentsView。
- 遥测缓冲在主进程内存里，环境重启即清空。

## 结构

```
src/main/            Electron 主进程 = Core
  main.ts            应用入口、窗口、IPC
  environments.ts    Environment 生命周期、Session、WebContentsView、Lease、遮罩联动
  tabs.ts            Tab / TabManager：标签集合、新窗口分流、视图挂载
  input-shield.ts    Agent 持 lease 时盖在页面上的原生输入遮罩
  telemetry.ts       Console / Network 环形缓冲（Electron 原生事件）
  browser/           CDP 浏览器控制层（controller / snapshot / waits / actions / policy…）
  rpc.ts             本地 Unix socket RPC 服务端 + token
  rpc-dispatch.ts    RPC 派发表（不 import electron，所以能被单测加载）
  store.ts           持久化（M0 用 JSON，M5 迁 SQLite）
  domain/            纯领域逻辑（状态机、lease 规则），有单元测试
  vault/             safeStorage 加密的凭据库（无 reveal 通道）
  plugins/           package.json#warren 校验、来源安装、三层权限、PluginHost
src/preload/         contextBridge 白名单 IPC
src/renderer/        React 界面（shadcn/ui + Tailwind v4）
  globals.css        shadcn 语义 token
  components/ui/     shadcn 组件
  components/        业务组件（sidebar / stage / plugins-sheet）
bin/warren.mjs       Agent 的 CLI
plugins/             独立插件包（示例 / Whistle / 账号管理）
fixtures/            本地测试站点
scripts/             fixture server
tests/               node:test 单元测试
legacy/              旧的独立 Chrome 看板原型
```

## 开发

```bash
npm run typecheck
npm test
node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs   # 单独验证渲染层构建
```
