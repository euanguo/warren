# Warren 插件能力设计（对标 BB Plugin SDK）

> 状态：**历史设计稿**。现行包契约与安装方式见
> `docs/PLUGIN-PACKAGE-MIGRATION-PLAN-2026-10-20.md`；本文保留能力设计与取舍背景。
> 日期：2026-10-15
> 对标对象：BB 的插件机制（本机 bb `0.28.1` / plugin-sdk `0.4.87`；`bb-plugin-authoring` 技能 19 篇 reference + 本机 73 个已装插件、`bb-plugin-nested-sidebar` 的真实源码）
> 前置阅读：`docs/PRD.md` §10（插件系统 PRD）、`docs/WHISTLE-PROXY-FEASIBILITY.md`（第一个真正需要 host runtime 的插件）
>
> **现行前端 API 设计**：`docs/PLUGIN-FRONTEND-API-PLAN.md`（`app.host` 只读白名单、
> `app.settings`、`envBadge` surface、调用级环境上下文）。本文件 §5 的历史方案以那份为准。

---

## 1. 一句话结论

warren 今天的插件是「一个跑在 vm 里的命令函数」：**没有界面、没有数据库、没有生命周期**。要让它长成 BB 那样，缺的不是权限表，是三样东西：

1. **挂载点** —— 插件能往界面里放东西（页面 / 设置分节 / 环境动作）
2. **存储** —— 插件能写自己的库（kv + 每插件一个 SQLite）
3. **运行时分级** —— 能力插件继续留在 vm 里；需要 fs / 子进程 / 第三方依赖的插件跑在独立 Node 进程里

顺序建议：先做**声明 + 数据**（P0，界面仍由 warren 自己的组件渲染，不引入任何加载器），再做**挂载页面**（P1，要动 CSP 和前端加载器），最后做 **host runtime**（P2）。

---

## 2. 现状盘点

### 2.1 已有的（都核对过代码）

| 能力 | 位置 | 说明 |
|---|---|---|
| 清单校验 | `src/main/plugins/manifest.ts:31` | `id` / `version` / `apiVersion`（必须 `'1'`）/ `name` / `entry`（必须在插件目录内）/ `permissions` |
| 权限三层 | `src/shared/permissions.ts:29` | `granted` / `confirm` / `denied`，12 项，**单一来源** |
| 声明降级可见 | `manifest.ts:60`、`manifest.ts:116` | 声明了 `denied` 的权限 → `downgraded`；`confirm` 级未批准 → `needsConfirmation` |
| 安装 | `host.ts:130` | 校验 → 拷进 `<coreDir>/plugins/<id>` → 默认 **disabled**；升级新增权限直接拒（`PLUGIN_PERMISSION_ESCALATION`） |
| 启用 / 禁用 / 卸载 / 授权 | `host.ts:178` / `:192` / `:170` / `:198` | 状态在 `<coreDir>/plugins/state.json` |
| 执行 | `host.ts:315` | `run(id, command, { environmentId })`：`vm.createContext` 跑入口 → 调 `exports[command](ctx)` |
| 沙箱全局 | `host.ts:333` | 只有 5 个：`module` / `host` / `console` / `setTimeout` / `clearTimeout` |
| host API | `host.ts:223` | `environment` / `browser`(navigate/snapshot/click/fill) / `vault`(listRefs/fill) / `storage`(get/set) / `events.emit` / `ui.notify` |
| 插件自存 | `host.ts:278`、`host.ts:51` | 一个 per-plugin JSON blob，落在共用的 `state.json` 里 |
| UI | `src/renderer/features/plugins/plugins-panel.tsx` | 设置 → 插件：列表 + 安装 + 启停 + 授权。**插件本身不能挂任何界面** |
| CLI / RPC / IPC | `bin/warren.mjs:466`、`src/main/rpc.ts:376`、`src/main/main.ts:198` | `plugin.list/install/enable/disable/uninstall/grant/run` |
| 测试 | `tests/plugin-manifest.test.ts` | 只覆盖清单校验 |

### 2.2 五个具体缺口（都能直接指着代码说）

1. **插件没有任何界面落点。** 用户装完插件，只看到一张卡片；插件的动作全藏在 CLI 里。`example-login` 的「登录」在界面上无处可点。
2. **`contributes` 是死字段。** `manifest.ts:22` 解析了 `authProviders` / `commands`，但全仓**没有任何代码消费它**（`grep -rn "contributes" src bin plugins` 只命中 manifest.ts 和 example 插件自己）。后果：`warren plugin run` 不知道插件有哪些命令，没有 `--help`，agent 只能靠猜。
3. **插件存不了结构化数据。** 现在 `host.storage.get/set` 写的是 `state.json` 里一个 JSON blob（`host.ts:51`）：**所有插件共用一份文件**、**没有大小上限**、**没有事务/并发保护**、**没有查询能力**。想「写库」的插件（抓包记录、任务队列、缓存）全做不了。
4. **没有生命周期。** 只有 `enable/disable`。插件不能在自己的加载时机注册常驻东西（服务、定时任务、RPC 方法），没有 `dispose`，没有 `reload`，没有状态（running / error / needs-configuration），没有日志文件（出错只有一条 event）。
5. **每次 `run` 都抢 agent lease。** `host.ts:324` 无条件 `manager.acquire(env, 'agent', 'plugin:<id>')`。而 `acquire` 在人持权时直接抛 `ENV_BUSY`（`environments.ts:557`）。后果：**只读的插件命令也会把人从环境上顶掉（并抬起输入遮罩），人在用这个环境时插件直接失败**。读操作（snapshot / 取标题）本来不需要 lease。

---

## 3. BB 的机制（对标）

| 维度 | BB | warren 今天 |
|---|---|---|
| 清单 | `package.json` 的 `bb` 字段：`name`/`description`/`branding`(icon+logo+icons)/`server`/`app`/`host`/`skills`/`themes` + `engines.bb` | `manifest.json`：`id`/`name`/`version`/`apiVersion`/`entry`/`permissions`/`contributes` |
| 产物 | **三个 bundle**：`server`（进程内后端）、`app`（前端 ESM，React 由宿主 shim 提供）、`host`（独立全权 Node 22 守护进程，带 digest 校验、按代复用 worker） | 一个 vm 沙箱模块 |
| 界面 | 代码里注册 slot：`navPanel`（插件拥有 `/plugins/<id>/<path>/*` 整条路由 + 宿主 App 面板 + `fixedTabs`）、`settingsSection`、`homepageSection`、`experimental_appOverlay`、thread 列表替换、composer 定制、`contentScripts`（明说 full-trust、不是沙箱） | 无 |
| 存储 | `storage.kv`（每键 ≤256KB）+ `storage.database()`（每插件 `data.db`，better-sqlite3，WAL）+ `storage.migrate()`（下标即版本，只追加） | 一个共用 JSON blob |
| 设置 | 5 种描述符（string/number/boolean/select/project），`secret: true` 落 0600 文件、**永不进 db 与前端**，可挂 Standard Schema 校验；`bb plugin config <id> set` | 无 |
| 数据面 | 类型化 RPC（输入输出都校验，稳定错误码 `invalid_input`/`handler_error`/…）+ `realtime.publish` 广播 + `useRpc`/`useRealtime` | 无（插件只能单向调 `host.*`） |
| 后台 | `background.service`（带 abort signal，崩溃退避重启）+ `background.schedule`（5 段 cron，持久化到行） | 无 |
| Agent 面 | `cli.register`（一个顶层命令，`defineCli` 自动给 `--help`/`--json` 信封）+ `agents.registerTool`（zod 参数、行内呈现）+ `skills/` 目录 + `contributeInstructions` | `warren plugin run`（无 help、无自描述） |
| 生命周期 | factory 30s 超时；reload 先验证候选再切换；**abort → 反序 dispose**；每个窗口/标签各自实例；status（running/disabled/error/needs-configuration/degraded）；`safe-mode`；每插件日志文件 | enable/disable |
| 分发 | path / git / npm / builtin / 市场；engines 校验；保留 id；host bundle digest 校验 | path（本地目录） |
| 信任模型 | **明说不是安全沙箱**：内容脚本是 full-trust 同源页面代码，host bundle 是 full-trust Node。安全靠「安装时同意 + 显式 API + 秘密留在服务端」 | vm 沙箱 + 权限三层（AGENTS 硬约束 1 也写明 vm 挡不住恶意代码） |

### 3.1 BB 的三条设计判断（这才是真正值得抄的）

1. **贡献面在代码里注册，清单只放身份与入口。** BB 的清单不写「我要加一个页面」，而是 `app.slots.navPanel({...})`。好处是清单和实现不会漂移；代价是装之前看不到插件要动哪些界面。warren 体量小、又强调「安装前让用户看清权限」，**这里应该反过来**：清单声明面，代码实现面，宿主在加载时校验两边一致。
2. **秘密永远留在服务端。** `secret` 设置只落 0600 文件，前端拿到的是「已配置/未配置」，不是值。warren 已经有 Vault（safeStorage）和 `vault.fill`（只填不返回），**这条 warren 已经在正确的路上，继续沿用**。
3. **生命周期是一等公民。** 超时、候选校验、反序 dispose、按窗口实例化、状态机——BB 花了大量篇幅在这上面，因为「插件坏了不能带走整个应用」。warren 现在完全空白。

---

## 4. 抄什么 / 不抄什么

**抄**：声明式设置 + 秘密留服务端、kv + 每插件 SQLite + migrate、类型化 RPC + 广播、面（surface）而不是自由 DOM、生命周期状态机、CLI 自描述、安装时显式同意。

**不抄**（每条都说明为什么）：

| 不抄的 | 为什么 |
|---|---|
| agent 工具注册表（`registerTool`） | warren 的 agent 就是「任何会跑 `bin/warren.mjs` 的编码 agent」。**工具面 = CLI**。加一个工具注册表等于再造一条 agent 通道，收益为零 |
| provider / machine / 市场 / 多窗口前端实例 | warren 没有这些概念，也没有多客户端 |
| `contentScripts`（往宿主 DOM 注入） | BB 自己都标注 full-trust、不是沙箱。warren 的界面是自家组件库，注入式扩展会绕过设计契约（token/recipe），收益低、代价高 |
| 前端 import map / build shim 那一套 | BB 要服务多个客户端版本才需要 shim。warren 只有一个 Electron 应用，直接给插件注入 `window.__WARREN__` 更省 |
| `themes` / `providers` | 与 warren 的产品定位无关 |

---

## 5. 目标设计

### 5.1 信任模型：两类 runtime（**这是最关键的一个决定**）

```
runtime: "sandbox"（默认，v1 兼容）
  跑在 vm 里，只有 host API。适合「登录 / 抓取 / 填表 / 校验」这类能力插件。
  fs、子进程、第三方依赖一律不可用。

runtime: "host"
  主进程用 utilityProcess.fork() 起一个独立 Node 进程跑插件的 host 入口。
  全权：fs / child_process / fetch / npm 依赖都行。
  适合「必须起进程或装库」的插件 —— 比如 whistle 实例托管。
```

**关键决定：`runtime` 是清单字段，不进权限表。**

权限表回答的是「能不能调某个 host API」——被拒了插件还能降级工作（比如不给 `browser.input` 就只读）。而「代码跑在哪」不能降级：一个要 `child_process` 的插件放进 vm 就是死的。所以它是**安装时必须让用户看见并同意的运行类别**，不是一个可授予/可拒绝的权限位。

这也正面回答了 AGENTS 的硬约束 1：warren 不再假装 vm 是沙箱。vm 的价值是**挡住误用**（拿不到 `process`/`require`/网络），不是挡住恶意代码；真正需要全权的插件走 `runtime: "host"`，用户装的时候就知道。

`runtime: "host"` 的插件仍然**拿不到 Vault 明文**、仍然只能通过 host API 碰环境——host 进程是「有 Node 能力」，不是「有核心权限」。

### 5.2 manifest v2

```json
{
  "id": "com.example.login",
  "name": "Example Login",
  "version": "0.2.0",
  "apiVersion": "2",
  "runtime": "sandbox",
  "description": "本地 fixture 的登录插件",
  "entry": "index.js",
  "host": "host.js",
  "icon": "./assets/icon.svg",
  "engines": { "warren": ">=0.2" },
  "permissions": ["environment.read", "browser.dom.read", "browser.navigate", "browser.input", "vault.fill"],
  "contributes": {
    "commands": [
      { "name": "login", "summary": "用 Vault 里的凭据登录当前环境" },
      { "name": "status", "summary": "看当前环境是否已登录" }
    ],
    "settings": [
      { "key": "baseUrl", "type": "string", "label": "登录页地址", "default": "http://127.0.0.1:8899/login.html" }
    ],
    "surfaces": [
      { "kind": "envAction", "id": "login", "title": "用插件登录", "command": "login", "icon": "KeyRound" },
      { "kind": "settingsSection", "id": "info", "title": "使用说明" }
    ],
    "rpc": ["getHistory"],
    "authProviders": ["example"]
  }
}
```

新增字段的取舍：

- `runtime`、`engines`、`icon`：必填/强校验。`icon` 指向插件目录内的 SVG（同 `entry` 的安全检查：必须在目录内、不许 `..`）。
- `contributes.surfaces` / `settings` / `rpc`：**清单声明**，安装前的权限对话框能逐条列出来；宿主在加载时校验插件实际注册的东西 ⊆ 清单，超出即拒绝加载（fail closed）。这是 §3.1 第 1 条那个反转。
- `contributes.commands` 从 `string[]` 升级成带 `summary` 的对象数组 —— 就为了 `warren plugin run --help` 能说人话。
- `contributes.authProviders` **落地成真实面**：环境右键菜单出现「用 <provider> 登录」，走插件的 `login` 命令。现在它是死字段。

### 5.3 挂载页面（用户最想要的那块）

warren 的真实挂载点（都对着现有代码）：

| surface | 挂在哪 | 复用现有代码 |
|---|---|---|
| `railPage` | rail 目的地 + 内容区整页 | `RailDestination`（`src/renderer/app/app-rail.tsx:7`）+ `App.tsx` 的 stage 区 |
| `settingsSection` | 设置 → 插件 → 详情 | `SettingsSection`（`src/renderer/features/settings/settings-dialog.tsx:12`，现在是写死的 `'plugins' \| 'vault'`，要改成动态） |
| `envAction` | 环境行内动作 / 右键菜单 | `environment-sidebar.tsx` 的动作槽与 `ContextMenu` |
| `inspectorTab` | 检查器里加一页（看插件自己抓的数据） | `environment-inspector.tsx` 现有四个分节 |
| `overlay` | 应用级浮层（P2 再说） | `Toaster` 同级 |

**加载方式（P1 的核心工程）**：

- 插件前端产物是一个 **ESM bundle**，由主进程通过自定义协议供给：
  `protocol.registerSchemesAsPrivileged([{ scheme: 'warren-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } }])` + `protocol.handle('warren-plugin', …)`，URL 形如 `warren-plugin://<id>/app.js`。
- **CSP 必须一起改**，否则插件页面永远白屏：`src/renderer/index.html:6` 现在是 `script-src 'self'`。要放宽成 `script-src 'self' warren-plugin:`——**只加 scheme，不加 `unsafe-inline` / `unsafe-eval`**。这是本设计里唯一的安全放松点，必须在 PRD 里写明。
- 插件**不打包第二份 React**。宿主在加载 bundle 前注入 `window.__WARREN__ = { React, jsxRuntime, ui: {...} }`，插件 `import` 不到裸包，直接用注入的。BB 用 build shim 达到同一目的（它要服务多个客户端版本，warren 不需要）。
- 每个 surface 外面包 `ErrorBoundary`（`src/renderer/app/error-boundary.tsx` 已有）。**一个坏插件不能白屏整个应用** —— AGENTS 记的 base-ui 坑就是「整棵 React 树被卸载成白屏」，插件代码比自家组件更容易踩。
- 插件页面拿不到原生页面视图（`WebContentsView` 永远在 DOM 之上），所以插件页面必须和现有浮层一样遵守 `lib/native-view-overlay-guard.ts` 的让位规则。

### 5.4 写库

```
storage.kv        → <coreDir>/plugins/<id>/kv.json
                    单键 ≤ 64KB，整库 ≤ 2MB，超了报错而不是静默截断
storage.db()      → <coreDir>/plugins/<id>/data.db
                    WAL + busy_timeout；handle 由核心托管，卸载/重载时关闭
storage.migrate() → 下标即版本号，只允许追加，不允许改已发布的语句
```

**用 `node:sqlite`，不加依赖。** 实测：Electron 44.7.0 内置 Node **24.21.0**，`require('node:sqlite').DatabaseSync` 存在（`ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -p …` → `sqlite=function`）。warren 现在没有任何数据库依赖（`package.json` 里没有 better-sqlite3），所以这是零成本路径。

配套改动：

- `uninstall` 必须删整个 `<coreDir>/plugins/<id>/`（现在删目录 + `state.storage[id]` 键，数据位置变了要跟着改）。
- 现有 `state.json` 里的 per-plugin blob 做一次性迁移：读出来写进 `<id>/kv.json`，然后从 `state.json` 里删掉。`state.json` 从此**只留 `enabled` 与 `granted`**（这两个是安全状态，不该和插件数据混在一个文件里——现在一个坏写入会连授权一起丢）。

### 5.5 数据面（插件界面 ↔ 插件后端）

复用现有 IPC/RPC 通道，新增两条：

```
plugin.rpc    { id, method, input } → { ok: true, result } | { ok: false, code, message }
plugin.signal { id, channel, payload } → 广播给渲染层（前端 usePluginSignal(channel, fn)）
```

- `method` 必须在清单 `contributes.rpc` 里（白名单），否则 `PLUGIN_RPC_UNKNOWN`。
- 输入输出**只允许 JSON**：拒绝 `undefined` / 循环引用 / `bigint` / 函数 / 类实例（`JSON.stringify` 前先跑一遍校验），并设大小上限（比如 1MB）。
- 错误码固定：`PLUGIN_RPC_UNKNOWN` / `PLUGIN_RPC_INVALID_INPUT` / `PLUGIN_RPC_HANDLER_ERROR`。
- **字段级校验交给插件自己。** warren 没有 zod，也不值得为这个加依赖；核心只保证「是合法 JSON、方法在白名单、体积可控」——核心是信任边界，插件前端的字段校验是插件自己的事。

### 5.6 设置与秘密

- 清单 `contributes.settings` 声明描述符（`string` / `number` / `boolean` / `select` / `secret`）。
- `secret: true` 的值进 Vault（warren 已有 safeStorage），**永不返回插件前端**，前端只看到「已配置」；插件后端通过 `host.settings.get()` 读，和现在的 `vault.fill` 同一个思路。
- 设置页由 warren 自己的组件渲染（`Field` / `Input` / `Switch` 都是现成的产品组件），插件只提供描述符——这就是 P0 不需要加载器也能落地的原因。
- CLI：`warren plugin config <id> set <key> <value>`、`unset`、无参打印当前值（secret 打码）。

### 5.7 生命周期

```
enable   → activate(ctx)：插件在这里注册 rpc 方法 / 常驻服务，可抛 NeedsConfiguration
disable  → dispose()：反序释放（rpc → services → listeners），并 abort 所有在跑的调用
reload   → 先加载新实例，验证注册合法，再切；失败保留旧实例并在状态里报告
status   → disabled | running | error | needs-configuration
logs     → <coreDir>/plugins/<id>/plugin.log（JSONL），warren plugin logs <id> [-n N]
```

- `activate` 超时 10s（现有 vm 求值超时就是 10s，沿用）。
- 一次性 `run` 保留（v1 兼容），但新插件应该走 `activate` + `rpc`。
- **lease 语义要修**（缺口 5）：`browser.dom.read` 类只读操作不抢 lease；只有 `browser.input` / `browser.navigate` 这类写操作才 `acquire`，而且失败要返回明确的 `ENV_BUSY` 让调用方决定（现在是无条件抢，把人顶掉）。

### 5.8 权限 v2

新增（层级按「用户能看懂」来定）：

| 权限 | 层级 | 理由 |
|---|---|---|
| `ui.mount` | granted | 挂界面本身不危险，但要在安装对话框里列出来 |
| `storage.write` | granted | 写自己的库 |
| `rpc.serve` | granted | 给自己的前端用 |
| `network.fetch` | confirm | 从插件后端出网（agent 侧本来就能上网，这里只是把它显式化） |
| `process.spawn` / `filesystem.read` | **仍然 denied** | 想全权请用 `runtime: "host"`（§5.1） |

不变式保持：权限表仍是 `src/shared/permissions.ts` 单一来源；插件声明 → `denied` 降级可见（`downgraded`）；升级新增 `confirm` 权限 → 拒绝安装要求重新确认（现有机制不动）。

### 5.9 面向 agent 的面

- **不建工具注册表**。agent 的工具就是 CLI。
- `warren plugin run <id> --help` 从清单的 `contributes.commands` 生成（缺口 2 的修复）。
- `--json` 输出统一信封 `{ ok, result } | { ok: false, code, message }`（现在 `print(value, asJson, format)` 的老坑见 AGENTS 第 1 条，插件命令的数组形状各不相同，必须各写各的 `formatXxxLine`）。
- 插件自带 `skills/<name>/SKILL.md`（可选）：`warren plugin install` 时把插件目录里的 skills 暴露给 agent（warren 已经有给 agent 用的 skills 概念，直接复用路径约定即可，不要新造一层）。

### 5.10 分发与版本

- P0：只支持本地目录（现状）。
- P1：`git:` 源 + `engines.warren` 校验 + 保留 id 前缀（`com.warren.` / `com.example.` 之类不允许第三方占用）。
- P2：npm / 市场（先不做）。下载来源要做摘要校验（BB 对 host bundle 就是这么干的）。

---

## 6. 分期与验收

### P0：声明 + 数据（不引入前端加载器）

清单 v2 + `contributes` 落地（commands / settings / surfaces / authProviders）+ kv + SQLite + `activate`/`dispose`/`status`/`logs` + 设置页渲染描述符 + `envAction` 动作（复用现有按钮/菜单）+ `plugin.rpc`。

**关键约束：P0 插件不提供 React 组件**，只提供「声明 + 数据」，界面由 warren 自己的组件渲染。这样 P0 完全不碰 CSP、协议、加载器，风险最小。

验收：

```bash
npx tsc --noEmit && npm test && node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
node bin/warren.mjs plugin list --json
node bin/warren.mjs plugin run example-login --help
node bin/warren.mjs plugin run example-login login --env <env>
ls ~/Library/Application\ Support/warren/core/plugins/example-login/     # 有 kv.json / data.db
node bin/warren.mjs plugin logs example-login -n 20
# 界面：设置 → 插件 → example-login 能看到描述符渲染出的表单
node bin/warren.mjs call debug.rendererEval '{"script":"document.querySelectorAll(\"[data-slot=plugin-setting-field]\").length"}'
# 只读命令不再抢控制权：人在持 lease 时跑 status，应当成功且 lease 不变
```

### P1：挂载页面

`warren-plugin://` 协议 + CSP 放开 scheme + surface 注册 + `ErrorBoundary` + `plugin.signal`。

验收：装一个带 `railPage` 的插件 → rail 出现目的地 → 页面渲染出内容；把插件页面故意改成抛异常 → 应用不白屏、其它功能照常；`warren plugin disable` 后 rail 目的地消失。

### P2：host runtime

`utilityProcess.fork` + 清单 `runtime: "host"` + 依赖处理 + 摘要校验。用 `docs/WHISTLE-PROXY-FEASIBILITY.md` 的 whistle 托管当第一个真实用例（它正好需要起子进程）。

---

## 7. 风险与不做

## 9. Cookie 受控通道（`storage.cookie.port`，2026-10-16）

硬约束 5 写着：`storage.cookie.*` 在 `denied` 层，声明了也不给，**前置条件是先设计一个
「只搬运不返回」的受控通道（形如 `vault.fill`）**。这一节就是那个设计，也是实现的依据。

### 威胁模型

一个 cookie 值 = 一份可直接冒充用户的登录态。所以问题不是「要不要给插件 cookie 能力」，
而是**值能不能跨过插件边界**：

- **读值**（`cookies.get` / `session.cookies.get` / `getAllCookies`）：永远不开。
  `storage.cookie.read` 保持 `denied`。
- **写值**（`cookies.set` / `remove` / `sessionData`）：形状太宽（插件可以拿整份
  `sessionData` 再自己解析），也保持 `denied`。
- 新开的是**窄通道**：值只在**主进程内部**流动，返回值里只有名字、域、过期、标志和计数。

### 通道（4 条，全部只回元数据 / 计数）

| API | 方向 | 回什么 |
|---|---|---|
| `host.cookie.names({ url? })` | 读元数据 | `[{ name, domain, path, secure, httpOnly, session, expirationDate }]` —— **没有 value** |
| `host.cookie.copy({ from, to, domain?, name? })` | 环境 → 环境，值不离开主进程 | `{ copied, names }` |
| `host.cookie.import({ cookies: [{ name, value, domain, ... }] })` | 插件 → 环境（值是**插件给的**，不是我们读出来的） | `{ written, names }` |
| `host.cookie.clear({ domain? })` | 删 | `{ removed }` |

权限：**`storage.cookie.port`**（`confirm` 层，安装时要用户点同意）。
写操作（copy / import / clear）和别的写一样**惰性取 lease**——人正持着控制权时不该被插件改登录态。

### 三条不能破的线

1. **返回值里永远没有 value**：`names()` 走**显式字段白名单**（逐字段挑），不是
   `delete cookie.value`——少写一个字段就漏，而漏了不会有人发现。
2. **`import` 不回显输入**：只回 `{ written, names }`，绝不把传进来的值 echo 回去
   （否则它就成了「读回来」的通道）。
3. **错误消息 / 事件 / 日志里也不带值**：写失败时报名字和域，不报值。

### 不做

- **导出成文件 / JSON 字符串**：`runtime: "host"` 的插件有 fs，任何「落到盘上」的导出
  等于把值交出去（插件读文件就行）。要备份登录态就备份整个 session 目录——那是**人**的操作，
  不经插件。
- **Partitioned cookies / CHIPS**：Electron 的 `session.cookies` 现在给不到，等它给再说。
- **按域批量导出**：同上，导出即泄漏。

### 验收（实测）

见 `docs/HANDOFF.md` §6「Cookie 受控通道」：`example-cookies` 插件在 cap 上 `names` →
返回值里搜不到那个值；`copy` 到另一个环境 → 另一个环境带上了同名 cookie
（用 `/cap/api/echo` 回显判断「有这个名字」，**不打印值**）。

- **CSP 放松**是真实的安全边界变化（`script-src` 多一个 scheme）。只加 scheme，不加 `unsafe-*`；这条要在 PRD 的硬约束里写明。
- **插件前端是半可信代码**：它能拿到 renderer 的全部能力（DOM、`window.envApi` IPC 桥）。安装对话框必须说清「插件能看见你在这个应用里看到的界面内容」，**不许谎称沙箱**（AGENTS 硬约束 1）。
- **React 实例必须唯一**：插件 bundle 若自带一份 React，hooks 会直接崩。靠注入 `window.__WARREN__` 解决，不做 import map。
- **插件页面与原生视图的层级**：`WebContentsView` 永远在 DOM 之上，插件页面要遵守 `native-view-overlay-guard` 的让位规则。
- **卸载要删数据**：现在 `uninstall` 只删目录；数据挪到 `<id>/` 后必须整目录删。
- **不做**：agent 工具注册表、provider、machine、市场、多窗口实例、内容脚本注入、主题、插件自带前端构建工具链（P1 的 bundle 由插件作者自己产出 ESM，`warren plugin build` 留到有人真的需要时再做）。

---

## 8. 附录：BB 的面清单（实现时对照）

- **后端**：`log` / `settings`(5 种描述符 + schema + secret) / `storage`(kv + database + migrate) / `http`(route + websocket，auth: local|token|none) / `rpc`(类型化 + 校验) / `realtime`(广播) / `background`(service + cron schedule) / `cli`(defineCli) / `agents`(registerTool + configure + contributeInstructions) / `ui.requestInput` / `providers` / `events.on` / `experimental_hooks` / `status` / `server` / `hosts` / `onDispose` / `onInstall`
- **前端**：`contentScripts.register` / slots：`navPanel`(fixedTabs + sidebarAccessory + headerContent) / `settingsSection` / `homepageSection` / `experimental_appOverlay` / `threadPanelAction` / `experimental_newThreadPanelAction` / `pendingInteraction` / `messageDirective` / `experimental_threadList`(替换侧栏) / `composer.customize` / `experimental_sidebarFooter`；hooks：`useRpc` / `useRealtime` / `useSettings` / `useBbContext` / `useBbNavigate`
- **生命周期语义**：factory 30s；reload 先验证候选再切；abort → 反序 dispose，每个 disposer 最多调用一次；按窗口/标签各自实例；status：running / disabled / error / needs-configuration / degraded；`safe-mode` 停掉所有第三方插件
- **信任规则**：插件是可信代码、**不是沙箱**；秘密只留服务端；前端传来的值和持久化的值都当不可信输入；CLI 与工具输出要有界
