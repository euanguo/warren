# 审批策略 · 内嵌代理面板 · 记忆插件 · 数据统一到一个根：施工图

> 状态：**W1–W5 全部完成**（逐项实测见 §9）
> 日期：2026-10-18
> 范围：四件事，互不依赖，可分别验收
> 前置阅读：`docs/HANDOFF.md` §4（硬约束）、`docs/WHISTLE-PLUGIN-PLAN.md`（代理插件）、
> `docs/PLUGIN-CAPABILITY-DESIGN.md`（插件机制）
>
> 四块：**A** 审批策略（§3）· **B** 内嵌代理面板（§4）· **C** 记忆插件（§5）· **D** 数据根（§6）

---

## 1. 现状：这个仓库里到底有几道「要人点头」的门

先把事实摆清楚。全仓只有 **两道** 真正的「人工审批」，加一道反向保护。

### 门 1：控制权（lease）—— 最影响 AI 自主性的那道

**单点**：`EnvironmentManager.acquire()`（`src/main/environments.ts:1000`）。

```ts
if (current && current.expiresAt > Date.now()) {
  if (current.owner === owner) { /* 续租 */ }
  throw new Error(`environment ${id} is controlled by ${current.owner}`);  // ENV_BUSY
}
```

**为什么它是唯一需要改的地方**：所有 agent 写操作都从这里拿权限，只有三条入口，全部收敛到 `acquire()`：

| 入口 | 位置 |
|---|---|
| CLI 的 `withLease()`（`tab` / `net` / `browser` 写命令） | `bin/warren.mjs:382` |
| CLI 的 `exec` 自动取租 | `bin/warren.mjs:1129` |
| 插件写操作（`host.ts` 的 `#withLease`） | `src/main/plugins/host.ts:533` |

**现在的行为**：人点过「接管控制权」之后，lease 归 `human`，**agent 的任何写操作都报 ENV_BUSY**，
要等人显式「交还给 Agent」或者等 TTL（60s）自然过期。人持权时输入遮罩撤掉、agent 被挡在外面
（`#syncShield`，`environments.ts:799`）。

> 注意：**人不会自动拿到 lease**。渲染层里没有任何自动 acquire（grep 过），
> 只有右键菜单的「接管控制权」（`environment-sidebar.tsx:406`）会取。所以「agent 被挡」= 人确实点过接管。

### 门 2：插件能力确认（confirm 层）

**单点**：`src/shared/permissions.ts` 的三层表 + `PluginHost` 的 `needsConfirmation` / `grant`。

- `confirm` 层的权限（`browser.navigate`、`browser.input`、`vault.fill`、`network.*`、
  `storage.cookie.port`、**`environment.write`**）安装时**不自动授予**，要人在插件面板点「全部批准」
  （`plugins-panel.tsx:210`）。
- 运行时门控在 `PluginHost.#has()`（`host.ts:522`）—— **只看 `granted`**。

### 反向的那道（保护 agent，不动）

`main.ts` 的 `humanNetWrite()`：agent 持权时**人**改网络规则会被拒（`ENV_BUSY`）。
方向相反，是防止人跟正在跑的 agent 抢，本次不动。

---

## 2. 需求（原话拆解）

### A. 审批要可配置

> 「一些操作必须在人工审批通过之后，AI 才允许执行……比如这个环境是 AI 创建的，那这些操作由 AI
> 操作时就不用审批……或者直接设置为不审批，不管是人创建还是 AI 创建，都不用审批。需要灵活一点。」

三个场景，正好三个档位：

1. 默认：要人点头（现状）
2. **AI 创建的环境**：AI 操作不用点头
3. 全部不点头

### B. 代理面板不要甩到外部浏览器

> 「不要在外部浏览器打开，而是在我们这个软件里面，要不就在面板上挂一个 WebView，
> 要不就是在 Tab，新 Tab，对应环境的 Tab 里面打开。」

### C. 笔记插件要做成真正的记忆

> 「好好开发一下，不要过于简易……给 AI 去操作环境时，做一些 todo 记忆，以及信息记忆。」

### D. 数据不要散着放

> 「不管是代理这个软件，或者是插件产生的数据，又或者是应用产生的数据……要不就放在应用的目录下
> 统一管理，要不就放在根目录下的应用根文件夹（`~/.应用名/`）统一管理，而不是零散地放在各文件夹，
> 应该都可以统一指定吧？」

两个可接受形态：**应用目录** 或 **`~/.应用名/`**；核心诉求是「一个根」+「可指定」。

---

## 3. 设计 A：审批策略

### 3.1 两个轴，两个作用域

| 轴 | 作用域 | 档位 | 默认 |
|---|---|---|---|
| `control`（门 1，控制权） | 全局 + **环境级覆盖** | `ask` / `agent-created` / `auto` | `ask` |
| `plugin`（门 2，插件能力确认） | 只有全局 | `ask` / `auto` | `ask` |

环境级覆盖：`EnvironmentConfig.approval: 'inherit' | 'ask' | 'auto'`（默认 `inherit`）。

**判定是纯函数**，放 `src/main/domain/approval.ts`（可单测，不 import electron）：

```ts
export function controlModeFor(input: {
  policy: ControlPolicy;                        // 全局
  envApproval?: 'inherit' | 'ask' | 'auto';     // 环境级
  createdBy: 'human' | 'agent';
}): 'ask' | 'auto';
```

优先级：**环境级 > 全局**。`auto` 只有一个含义：**agent 需要写权限时，可以从人手里接管**。
人那一侧不受影响 —— 人随时能点「接管控制权」（`takeover()` 本来就是人的特权）。

### 3.2 落点（四处，都很小）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `src/main/db.ts` | 新表 `app_settings(key, value, updated_at)`（纯追加，老库不用迁移）；`environments` 加两列 `created_by` / `approval`（走已有的 `migrate()`） |
| 2 | `src/main/domain/approval.ts`（新） | 纯函数 `controlModeFor` / `pluginAutoApprove` |
| 3 | `src/main/environments.ts` `acquire()` | 人持权 + `owner === 'agent'` + 判定 `auto` → 接管并记 `control.autoTakeover` 事件 |
| 4 | `src/main/plugins/host.ts` `#has()` / `#decorate()` | 策略 `auto` 时，`confirm` 层视同已授予（`needsConfirmation` 恒为空） |

`acquire()` 里那段（示意）：

```ts
if (current && current.expiresAt > Date.now() && current.owner !== owner) {
  const mode = controlModeFor({ policy, envApproval, createdBy });
  if (owner !== 'agent' || mode !== 'auto') throw ENV_BUSY;
  this.#store.record(makeEvent('control.autoTakeover', `agent 按审批策略接管 ${id}`, 'agent', id));
}
```

### 3.3 环境创建者

`EnvironmentConfig.createdBy: 'human' | 'agent'`。

现在 `manager.create()` **硬编码 `actor: 'human'`**（`environments.ts:403`）—— 即使 agent 走 RPC 建的也记成
human。要改成由调用方传：RPC（`env.create`）= `agent`，IPC（`env:create`）= `human`。

### 3.4 安全：**这两项设置只有人（界面）能改**

这是本次设计里最要紧的一条约束：

- 全局策略**不进 RPC / CLI 的写通道**。`warren settings` 只读；写只有 IPC。
- 环境级 `approval` **不进 `env.update` 的 RPC 白名单**（那个 patch 是逐字段 allowlist 构造的，
  不读 `params.approval` 就行），只有 `env:update` IPC 能带。

**理由**：agent 能给自己放行的话，这道门就等于不存在。审批是**信任决定**，不是配置项。

> 已知边界（不新增风险）：插件前端跑在应用窗口里，能拿到 `window.envApi`，理论上能调那条 IPC。
> 这和 `PLUGIN-CAPABILITY-DESIGN.md` 里写的「插件前端是半可信代码」是同一件事，不是这次引入的。

### 3.5 界面

- **设置 → 新增「审批」一节**：两个下拉（控制权策略 / 插件能力确认），下面一行说明当前生效规则。
- **环境右键菜单 → 「审批策略」子菜单**：跟随全局 / 总是要审批 / 自动放行。
  （`components/ui/context-menu.tsx` 已经有 `ContextMenuSub*`，不用新加组件。）
- **环境行上给个标记**：只有策略**不是** `inherit` 时才显示一个小徽章，否则界面噪音太大。
- **事件流**：`control.autoTakeover` 会出现在事件面板里，谁在什么时候抢的看得见。

---

## 4. 设计 B：代理面板开在软件里（新 Tab）

### 4.1 选哪条路

| 方案 | 代价 | 结论 |
|---|---|---|
| 面板里挂 WebContentsView | 要处理原生视图与 DOM 的层叠、让位（`native-view-overlay-guard`）、尺寸同步 | 重，不选 |
| 面板里 iframe | 要放宽 CSP `frame-src`（现在 `default-src 'self'`），还要看 whistle 的 UI 允不允许被嵌 | 破设计边界，不选 |
| **在对应环境里新开一个 Tab** | `TabManager.newTab` / `warren tab new` 都是现成的 | **选它** |

Tab 还顺带拿到：整块舞台面积、地址栏、DevTools、随环境启停（`env stop` 一起关）、重启后按快照恢复。

### 4.2 需要的核心改动：一个 host API

插件现在**没有任何开标签的能力**（`BROWSER_CAPABILITIES` 里全是 controller 上的操作）。
新增一条：

```ts
'browser.openTab': { permission: 'browser.navigate', write: true, run: (c, [url]) => ... }
```

`write: true` 就自动走 `withLease` + `assertWritable`，和 `tab.new` RPC 一致。

### 4.3 插件侧改两处

- rail 面板的「打开面板」按钮：从 `window.open(...)` 改成 `rpc.call('open', { storage })`。
- 命令 `open`：从 `openInBrowser(url)`（spawn `open`）改成 `host.browser.openTab(url)`。
  **删掉 `openInBrowser`**，不再有「甩到系统浏览器」这条路径。

### 4.4 一个要实测的点

whistle 的 UI 是 `http://127.0.0.1:<port>/`。这个请求在环境 session 里会不会**又被代理一次**
（代理正好就是这个端口）？Chromium 默认**隐式绕过 loopback**（除非显式写 `<-loopback>`），
所以预期是直连。**实施时按 RED→GREEN 实测**：开 tab 之后看 whistle 自己的抓包列表里有没有
出现这条 UI 请求；出现了就补 `proxyBypassRules`。

---

## 5. 设计 C：把 example-notes 做成记忆插件

### 5.1 定位

**agent 的外置记忆**。agent 的上下文会被压缩 / 清空，插件库不会。所以它要解决的是
「这个环境现在该干什么」+「这个环境已经知道什么」。

### 5.2 命名与兼容（重要）

- **id 保持 `com.example.notes`、目录保持 `plugins/example-notes/`**。
  改 id = 插件的 `data.db` 和 kv 全丢（数据是按 id 分目录的），不值得。
- 显示名与 rail 标题从「笔记」改成「**记忆**」（`data-slot="notes-page"` 保留，少改测试）。
  连带要改：`scripts/regress/ui.cjs` 里按 `aria-label === '笔记'` 找 rail 的那两行。
- **命令保持向后兼容**：`addNote` / `list` / `stats` 和 `title` 设置不动，
  `scripts/regress/plugin.sh` 不用改（它盯着 `.result.notes.length`）。

### 5.3 数据模型（插件自己的 SQLite，migrate 下标 1）

```sql
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,              -- 'env' | 'global'
  env_id TEXT,                      -- scope='env' 时是环境 id
  kind TEXT NOT NULL,               -- 'todo' | 'fact'
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',   -- todo: open | doing | done | dropped（fact 恒为 'open'）
  priority INTEGER NOT NULL DEFAULT 0,   -- 越大越靠前
  tags TEXT NOT NULL DEFAULT '',         -- 逗号分隔
  source_url TEXT, source_title TEXT,    -- 记下来源页面，方便回溯
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX items_scope ON items (scope, env_id, kind, status, priority DESC, updated_at DESC);
```

一次性把老 `notes` 表搬进来（同一条迁移里 `INSERT INTO items ... SELECT ... FROM notes`，
`kind='fact'`, `scope='env'`）。

### 5.4 命令（agent 走 `warren plugin run com.example.notes <cmd> --env <env>`）

| 命令 | 作用 |
|---|---|
| **`context`** | **核心**：一次拿到「本环境未完成的 todo（按优先级）+ 最近的 fact + 全局置顶」，输出紧凑文本。agent 一进环境先跑它 |
| `add` | `--input='{"kind":"todo","title":"…","body":"…","tags":"a,b","priority":2,"scope":"env"}'` |
| `list` | 过滤：`kind` / `status` / `scope` / `tag`；返回 `{items, notes}`（`notes` 是老的形状） |
| `search` | 关键词（title + body + tags） |
| `update` | 改标题 / 正文 / 标签 / 优先级 |
| `setStatus` | todo 流转：open → doing → done / dropped |
| `remove` | 删 |
| `remember` | 从**当前页面**抓一条 fact（标题 + URL 自动带上） |
| `addNote`（保留） | 老的「把当前页面存成一条」= `remember` 的旧名字 |

### 5.5 面（给人看）

- `railPage`「记忆」：左侧过滤器（环境 / 类型 / 状态 / 标签）+ 列表 + 行内编辑 + 新增框。
- `inspectorTab`「记忆」：当前环境的条目，可直接勾完成。
- `envAction`「记一条」：把当前页面记成 fact（原来叫「存成笔记」）。
- `settingsSection`：使用说明 + 给 agent 的用法示例。

### 5.6 为什么这样对 agent 有用

1. `context` 是**一次调用**就能塞进上下文的东西（不用 agent 自己拼 3 个查询）。
2. todo 有**状态机**，不是一堆自由文本 —— agent 能回答「还剩什么没做」。
3. `source_url` 让每条记忆能回到当时的页面。
4. 环境作用域 + 全局作用域分开，跨 worktree 的共性知识不用抄 N 份。

---

## 6. 数据统一到一个根（WARREN_HOME）

### 6.1 现状：数据散在五个地方（`ls` 实测）

| 落在哪 | 内容 | 谁写的 |
|---|---|---|
| `~/Library/Application Support/Warren/` | 渲染层窗口的 Chromium profile：`Cache/` `Code Cache/` `Cookies` `Local Storage/` `Session Storage/` `GPUCache/` `DIPS` `blob_storage/` … | Electron 默认 session |
| `…/Warren/core/` | `warren.db`（环境 / 分组 / 事件 / 运行态 / 凭据 / 插件注册表 + kv + 日志 / 遥测）、`sessions/<env>/`（每环境 Chromium profile + 扩展 + `trusted-ca.pem`）、`plugins/<id>/`（插件代码 + 插件自己的 `data.db`） | 应用 |
| `~/.warren/` | `envd.sock`、`runtime.json`（RPC 端点 + token） | 应用（`rpc.ts:13`） |
| `~/.WhistleAppData/` | whistle 的规则 / 值 / **根证书** / 日志 | whistle 子进程（`WHISTLE_PATH`） |
| `~/.startingAppData/` | whistle 实例注册表（pid + port） | whistle 子进程（`starting` 包） |

外加三处**故意不统一**的（见 §6.5）。

### 6.2 方案：一个根，`WARREN_HOME`

默认 `~/.warren`（用户点名的形态，而且这个目录**已经存在**——socket 就在那儿），`WARREN_HOME` 可覆盖。

```
~/.warren/
  app/          Electron userData：渲染层窗口的 Chromium profile
  core/         warren.db + sessions/<env>/ + plugins/<id>/   ← 就是现在的 coreDir
  runtime/      envd.sock + runtime.json                      ← 原来是 ~/.warren 根下
  whistle/      WHISTLE_PATH：规则 / 值 / 根证书              ← 原来是 ~/.WhistleAppData
  whistle/.startingAppData/   实例注册表                      ← 原来是 ~/.startingAppData
  logs/         Electron 日志
  crashDumps/
```

**为什么是 `~/.warren` 而不是 `~/Library/Application Support/Warren`**：CLI 与主进程必须算出**同一个**根，
算错就是「应用明明在跑却报没在跑」这种最难查的假象。`~/.warren` 一行就能算出来
（`WARREN_HOME ?? ~/.warren`），不需要在 CLI 里复刻 Electron 的平台路径规则；而且它符合 CLI-first
工具的习惯（`~/.docker` / `~/.kube` / `~/.npm`）。另一个选项（拿 userData 当根）省掉应用数据的迁移，
但要在 `bin/warren.mjs` 里重写一遍 macOS/Windows/Linux 的路径规则 —— 那正是会漂移的地方。

### 6.3 落点

| # | 位置 | 改动 |
|---|---|---|
| 1 | `src/main/paths.ts`（新） | `warrenHome()`（纯 Node、不 import electron，可单测）+ 各子目录；`ensureRoot()` 负责 mkdir 与 §6.5 的一次迁移 |
| 2 | `src/main/main.ts` 顶部 | **第一句** `ensureRoot()`（迁移 + 建目录），然后 `app.setPath('userData' / 'sessionData' / 'logs' / 'crashDumps', …)`；模块顶层就跑（`main.ts:23` 现在就在这里读 userData，`whenReady` 在 317 行）—— `app.setPath` 必须在 ready 之前，且目标目录必须已存在 |
| 3 | `src/main/rpc.ts` | `RUNTIME_DIR` 改成 `<root>/runtime` |
| 4 | `bin/warren.mjs` | 同一个根（**3 行，和 `paths.ts` 保持同步**，注释指向唯一来源；不一致的话 CLI 立刻连不上 socket，回归套件会红） |
| 5 | `src/main/browser/policy.ts` | 写路径护栏现在**硬编码 `~/.warren`**（`policy.ts:53`）；改成用解析出来的根 —— 统一之后这个护栏正好把整个数据根都护住 |
| 6 | `plugins/whistle/host.mjs` | spawn / stop 时带 `WHISTLE_PATH=<root>/whistle` 与 `STARTING_DATA_DIR=<root>/whistle`（见 §6.4） |
| 7 | `src/main/store.ts` | **`storagePath` 在 load 时重算**（不在当前 sessions 根下就用 `storagePathFor(id)`）—— 这段逻辑现在只在「导入老 JSON」那条路上有，根一搬就全悬空 |

### 6.4 两个决定性的实测结论

1. **whistle 的数据目录能指到任意位置**：`WHISTLE_PATH` 走 `getHomePath()`，不是 `.` 开头的值**原样当路径用**
   （`whistle/lib/util/common.js:401`）。
2. **`starting`（whistle 起守护进程用的包）认 `STARTING_DATA_DIR`**：`starting/lib/cli.js:21` 是
   `process.env.STARTING_DATA_DIR || os.homedir()`，所以实例注册表能跟着我们的根走，
   **不用改 HOME**（改 HOME 会牵动一堆别的东西）。

### 6.5 迁移：**手动做一次，不写迁移代码**

这个应用还没有别人在用，为一次性搬家写一套「检测旧布局 → 幂等搬 → 留标记」的迁移代码，
是在给一个不存在的用户写代码（而且是数据安全最敏感的那类代码，写错就是丢数据）。
所以：**实施时由人（我）手动把本地数据搬一次**，代码里只有新布局，没有旧布局的任何分支。

手动步骤（实施 W4 时执行，不在代码里）：

1. 先停掉所有 whistle 实例与正在跑的应用
2. `~/Library/Application Support/Warren/` → `~/.warren/app/`
3. `~/.WhistleAppData/` → `~/.warren/whistle/`
4. 老的 `~/.warren/envd.sock` / `runtime.json` 删掉（临时文件，重启就重建）
5. `core/` 已经在 `~/.warren/core/`，不用动；`storagePath` 由 `store.load()` 重算（§6.3 第 7 条）

**代价说清楚**：以后要是有别人装了旧版本再升上来，他们的数据会「找不到」（应用会在新根下开一个空库，
旧数据还在原地没被删）。真要发布时再补迁移——那时才知道用户的真实升级路径。

**不搬（明确例外，写进文档而不是默默留着）**：

- `~/.claude/skills/warren/`、`~/.codex/skills/warren/` —— 那是**别的 agent 的目录约定**，
  搬到我们的根里它们就找不到了（`agent-integration.ts:27`）
- `os.tmpdir()/warren-downloads/<env>/` —— 临时下载落点，系统临时目录本来就该是临时的
  （环境删除时应用会清，`environments.ts:782`）
- 用户显式指定的 HAR / 截图输出路径 —— 路径是调用方给的

### 6.6 风险

1. **搬错就是数据全丢**：所以是手动搬（先停应用与实例），代码里没有迁移分支。
2. **`app.setPath` 有硬要求**：必须在 ready 之前调用，且目标目录必须已存在。
3. **实例注册表跟着走之后，用户手敲的 `w2 status` 看不到我们起的实例**（除非他也设 `STARTING_DATA_DIR`）。
   插件不依赖它（存活靠探 HTTP），但 `w2 stop` 依赖 —— 插件 spawn 和 stop 用同一套 env，所以自洽。
   **改根之前要先停掉所有实例**，否则旧实例会变成孤儿。
4. **`trustedCa` 是绝对路径**，落在旧 storagePath 下的会悬空 —— 重算 storagePath 时一并改写；
   改不动就走核心已有的「读不出来 → 不装钩子 + 记 `environment.trustedCaUnreadable` 事件」那条路，不静默放行。

---

## 7. 分期与验收

### W1 · 审批策略（A）

- 纯函数 `controlModeFor` 单测：6 种组合（3 档 x 创建者 / 环境级覆盖优先）。
- `acquire()` 实测：默认策略下人持权 → `ENV_BUSY`；策略 `auto` 下同一个动作 → 接管成功 + 事件。
- 插件 confirm：策略 `auto` 时 `needsConfirmation` 为空、`#has()` 放行；切回 `ask` 立刻恢复拦截。
- **反向验收（必须有）**：`env.update` 的 RPC **带 `approval` 不生效**（agent 不能给自己放行）。

### W2 · 内嵌代理面板（B）

- 面板按钮 → 环境里多一个 tab，URL 是 `http://127.0.0.1:<port>`，内容是 whistle 的 Web UI。
- 命令 `open` 同一条路径（不再 spawn `open`）。
- 实测 loopback 是否被代理（§4.4）。

### W3 · 记忆插件（C）

- 迁移：老的 `notes` 行在 `items` 里查得到（不丢数据）。
- `context` 输出实测（贴真实输出）。
- 界面：rail「记忆」页能列 / 能改 / 能勾完成；inspector 页跟着当前环境。
- 回归：`plugin.sh` 的 12.x / 15.x 全绿（老的 `list` / `addNote` / `stats` 没坏）。

### W4 · 数据统一到根（D）

- **手动搬家**（§6.5），不写迁移代码。
- 搬完启动：五个位置全部落在 `~/.warren/` 下（逐个 `ls` 贴出来），环境还在、能起来、`storagePath` 重算过。
- `WARREN_HOME=/tmp/warren-home` 时应用与 CLI 都跟着走（`env list` 通 = 两边算的是同一个根）。
- `policy.ts` 的护栏跟着根走（换个根之后仍然拒绝写数据目录）。

### W5 · 收尾

- 五道静态门 + `bash scripts/regress/run-all.sh`（预期 146+ PASS / 0 FAIL）。
- `docs/HANDOFF.md` 同步：新表 / 新列 / 新 host API / 新设置 / **新的数据根**（这条属于「运行方式」变更，必须写）。

---

## 8. 风险与不做

1. **`auto` 会让人机抢页面**：人正在页面里打字时，agent 一次写操作会把控制权抢走并盖上输入遮罩。
   这是用户明确要的自主性，但**默认必须是 `ask`**，且抢的时候记事件、界面上看得见。
2. **审批设置不能给 agent 写通道**（§3.4）。这条不能松。
3. **`browser.openTab` 是写操作**：人在 agent 持权时点「打开面板」会拿到 `ENV_BUSY`。
   这是和 `tab.new` 一致的行为，不特殊处理。
4. **whistle UI 在环境 tab 里的 loopback 代理问题**没验（§4.4），实施时实测。
5. **不做**（用户没要，说明理由）：
   - 审批策略的**按插件 / 按命令**细分 —— 两个档位已经覆盖用户说的三个场景。
   - 插件前端走 human 通道的机制 —— 那是插件信任模型的另一件事，不在本次范围。
   - 记忆插件的向量检索 / 语义搜索 —— SQLite 的 LIKE 够用，`search` 先做关键词。

## 9. 验收记录

### W1 · 审批策略（2026-10-18）

**迁移**（老库上直接加列 + 加表，环境没丢）：

```
$ sqlite3 warren.db "PRAGMA table_info(environments)" | tail -3
10|trusted_ca|TEXT|0||0
11|created_by|TEXT|0||0
12|approval|TEXT|0||0
$ sqlite3 warren.db "SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'"
app_settings
$ warren call env.get '{"id":"cap"}'
createdBy = human | approval = None        # 老环境补成「人建的」（保守的那一侧）
```

**门 1（控制权）RED → GREEN**：

```
# RED：默认 ask，人持权
$ warren call env.takeover '{"id":"cap"}'   → owner = human
$ warren tab new cap
  ENV_BUSY: environment cap is controlled by human

# 从界面改策略（唯一写通道）
$ debug.rendererEval → window.envApi.setSettings({ controlPolicy: "auto" })
  {"controlPolicy":"auto","pluginPolicy":"ask"}

# GREEN：同一个动作
$ warren tab new cap                        → 标签建出来了
$ warren events cap
  17:49:14  agent  cap  agent 按审批策略从 human 接管 cap
  17:49:14  agent  cap  agent acquired cap (warren tab new)
  17:49:14  agent  cap  agent released cap
```

**切回去立刻恢复拦截**（不是单向门）：`setSettings({controlPolicy:'ask'})` → 同一个 `tab new cap` 又报 `ENV_BUSY`。

**agent-created 只放行 AI 建的环境**：

```
$ warren env create agent-env && warren call env.get '{"id":"agent-env"}'
  createdBy = agent                        # RPC 建的记 agent，界面建的记 human
$ setSettings({controlPolicy:"agent-created"})
$ tab new agent-env   → 成功
$ tab new cap         → ENV_BUSY           # cap 是人建的，不放行
```

**环境级覆盖压过全局（两个方向）**：

```
agent-env 上写 approval="ask"（全局是 agent-created） → ENV_BUSY
cap       上写 approval="auto"（全局是 agent-created）→ 成功
cap       上写 approval=null → 回到「跟随全局」
侧栏标记：只有偏离全局时才出现（实测 marks = ["审批：自动放行", "直连"]）
```

**门 2（插件能力确认）RED → GREEN**：

```
# 默认 ask、environment.write 未授权
$ warren plugin list | grep whistle
  待确认: environment.write
$ warren plugin run com.warren.whistle bind --env cap --input='{"storage":"perm"}'
  PLUGIN_PERMISSION_DENIED: 插件 com.warren.whistle 没有 environment.write 权限

# 界面把插件策略改成 auto
$ setSettings({pluginPolicy:"auto"})  → plugin list 里「待确认」消失
$ 同一个 bind
  proxy = http://127.0.0.1:8900
  trustedCa = .../sessions/cap/trusted-ca.pem      ← 过门并真的干活了
```

**反向验收（agent 不能给自己放行）**：`tests/rpc-dispatch.test.ts` 里断言
`env.update` 带 `approval` 时递下去的 patch **只有 `{name}`**（approval 被丢掉）；
RPC 侧根本没有 `settings.set` 这个方法，只有 `settings.get`。

**静态门**：`npm test` **221/221**（新增 8：approval 6 条 + rpc-dispatch 2 条）·
`npm run lint` 0 警告 · `prettier` ✓ · `tsc` 0 错 · 渲染层 build ✓。

**全量回归**：145 PASS / 1 FAIL，唯一 FAIL 是 V5b（跨源 iframe 点击的时序抖动——
单独重跑 capability.sh 两次都 PASS，与本次改动无关）。设置分节多了「审批」一节，
`ui.cjs` 的 10.1 / 10.2 不用改（它只要求包含「插件 / Agent / 凭据」且每节非空）。

### W2 · 内嵌代理面板（2026-10-18）

**新增 host API** `browser.openTab`（`browser.navigate` 权限，写操作走 lease）。

**面板按钮 → 环境标签**：

```
$ warren plugin run com.warren.whistle open --env cap
  { "url": "http://127.0.0.1:8900", "tabId": "6494ed33-…", "title": "" }
$ warren tab list cap
  ●  5  Whistle Web Debugging Proxy   http://127.0.0.1:8900/
$ warren exec cap --tab=5
  { url: "http://127.0.0.1:8900/", title: "Whistle Web Debugging Proxy", container: true }
```

**面板上的「打开面板」按钮**（rendererEval 点真按钮）：`disabled=false` → 点完标签从 4 个变 5 个。
**不再有系统浏览器这条路径**（`openInBrowser` 与 `child_process.spawn` 都删了）。

**§4.4 的 loopback 问题：实测结论是「不用管」**。决定性实验——给 whistle 写一条
`127.0.0.1:8900/ 127.0.0.1:9`（如果 UI 的请求走了代理，这条规则会把 UI 打死）：

```
$ curl -X POST /cgi-bin/rules/project … 'rules=…
127.0.0.1:8900/ 127.0.0.1:9'
$ warren tab reload cap 2 && warren exec cap --tab=2
  { url: "http://127.0.0.1:8900/", title: "Whistle Web Debugging Proxy", container: true }
```

UI 照常加载 → **Chromium 的隐式 loopback 绕过生效，UI 的请求根本没走代理**。
所以不需要 `proxyBypassRules`，也不会在抓包列表里出现自己。

**顺带修掉两个真 bug**：

1. **插件 rpc 的返回值不能带 `undefined`**（`host.ts` 的 `toJson` 会拒），而 `TabListItem`
   有 `favicon` / `error` 两个可选字段 → `PLUGIN_RPC_NON_JSON: 插件返回值里有 undefined`。
   `open` 改成只回 `{url, tabId, title}`；顺手把规则行也归一（whistle 不保证 `selected` 存在）。
   注意命令那条路**不做** JSON 校验，所以同一个函数在 `plugin run` 下能过、在 `rpc` 下会炸 —— 这个不对称是坑。
2. **渲染层的插件 bundle 是按 `id@version` 缓存的**：改了插件前端但没升版本号，重装后界面
   一直跑旧代码（实测：按钮还是老的 `window.open` 行为）。改成按 **digest** 缓存。

### W3 · 记忆插件（2026-10-18）

`plugins/example-notes/` 从「存一行文本」做成 agent 的外置记忆。**id 与目录不动**（改 id = 数据全丢），
显示名与 rail 标题改成「记忆」，`data-slot="notes-page"` 保留；老的 `addNote` / `list` / `stats` / `title`
全部保留（回归套件不用改语义，只改了一处 `count` → `total`）。

**数据模型**：一张 `items` 表（`kind` = todo / fact，`scope` = env / global，todo 有状态机
open / doing / done / dropped，带 priority / tags / source_url）。迁移下标 1 建表并把老 `notes` 一次性搬进去。

```
$ sqlite3 …/plugins/com.example.notes/data.db "SELECT (SELECT COUNT(*) FROM notes), (SELECT COUNT(*) FROM items), (SELECT COUNT(*) FROM items WHERE kind='fact' AND scope='global')"
27|27|27                       # 老数据一条没丢，都变成「全局记忆」
```

**核心命令 `context`（RED → GREEN）**：

```
# RED：刚迁移完，还没有待办
$ warren plugin run com.example.notes context --env cap
环境 cap · 待办 0 · 记忆 20
待办：
- （没有未完成的待办）

# 加两条待办（一条本环境、一条全局）+ 一条记忆
$ warren plugin run com.example.notes add --env cap \
    --input='{"kind":"todo","title":"修登录跳转","body":"回调地址写死了","tags":"auth,urgent","priority":2}'
$ warren plugin run com.example.notes add --env cap --input='{"kind":"todo","title":"给所有环境配代理","scope":"global"}'
$ warren plugin run com.example.notes add --env cap --input='{"kind":"fact","title":"登录走 SSO，回调在 /auth/cb","tags":"auth"}'

# GREEN
$ warren plugin run com.example.notes context --env cap
环境 cap · 待办 2 · 记忆 20
待办：
- [open] 修登录跳转 #auth #urgent p2
  回调地址写死了
- [open] 给所有环境配代理（全局）
```

`setStatus` → `[doing]`；`search '{"query":"登录"}'` → `['修登录跳转', '登录走 SSO，回调在 /auth/cb']`。

**界面（rendererEval 读 DOM）**：

```
rail 目的地        = ["环境", "记忆", "代理", "设置"]
点「记忆」→ [data-slot=notes-page] 挂载，31 条，新增框与过滤器都在
行文本             = 待办 | 修登录跳转 | #auth #urgent | cap | 编辑 | 删除 | 回调地址写死了
UI 加一条          → 31 → 32 行，落到 scope=global
UI 勾完成          → data-status=done，后端 context 里这条消失
UI 编辑正文        → 保存后 search '{"query":"正文由 UI 写入"}' 查得到
检查器标签         = 事件 / 快照 / 控制台 / 网络 / 规则 / 存储 / 记忆
检查器「记忆」页   = 「待办 2 · 共 32 条（含全局）」+ 新增框
```

**顺带修掉第三个真 bug**：**光按摘要换 Map 键还不够** —— `import()` 的结果被浏览器的模块表
按 URL 永久缓存，所以 rail 标题一直停在旧的「笔记」。URL 上要带 `?v=<摘要>` 才会重新求值
（实测：不加的话重装插件、重启应用都还是旧标题）。

**静态门**：`npm test` 221/221 · lint 0 警告 · prettier ✓ · tsc 0 错 · renderer build ✓。
**全量回归**：**146 PASS / 0 FAIL**（先修了 `plugin.sh` 的 12.2：`stats` 的 `count` 已更名 `total`）。

### W4 · 数据统一到根（2026-10-18）

**手动搬家**（应用先停；没有写任何迁移代码）：

```
$ mkdir -p ~/.warren/app
$ mv "~/Library/Application Support/Warren/core" ~/.warren/core
$ mv "~/Library/Application Support/Warren"/* ~/.warren/app/      # 剩下的都是渲染层窗口的 Chromium profile
$ mv ~/.WhistleAppData ~/.warren/whistle
$ rm -rf ~/.startingAppData                                        # 只剩两个失效的 pid 文件
$ rm -f ~/.warren/envd.sock ~/.warren/runtime.json                 # 临时文件，重启就重建
```

**搬完启动（全部落在新根下）**：

```
$ ls ~/.warren
app  core  crashDumps  logs  runtime  whistle
$ ls ~/.warren/runtime
envd.sock  runtime.json
$ sqlite3 ~/.warren/core/warren.db "SELECT id, storage_path FROM environments LIMIT 1"
cap|<WARREN_HOME>/core/sessions/cap        ← storagePath 被 load() 重算过
$ ls -d ~/Library/Application\ Support/Warren ~/.WhistleAppData ~/.startingAppData
（三个都不存在了）
```

**whistle 插件的数据也跟着走**（spawn 时带 `WHISTLE_PATH` + `STARTING_DATA_DIR`）：

```
$ warren plugin run com.warren.whistle fork --input='{"storage":"root2",…}'
$ ls ~/.warren/whistle/.whistle/custom_dirs        → panel perm root2
$ ls ~/.warren/whistle/.startingAppData            → %23root2%23  error.…
$ warren plugin run com.warren.whistle stop --input='{"storage":"root2"}'   → alive=[False]
```

**`STARTING_DATA_DIR` 是实测确认的**（whistle 用 `starting` 包起守护进程，它的 `lib/cli.js:21`
是 `process.env.STARTING_DATA_DIR || os.homedir()`）。同一套 env 下 `w2 stop -S <storage>`
读的是同一个注册表，所以「起」和「停」自洽 —— 这一点单独跑过实验：带 env 起 `t1`，
`~/.startingAppData` 与 `~/.WhistleAppData` 都没被创建，`w2 stop -S t1` 正常停掉。

**护栏跟着根走**（不是硬编码 `~/.warren`）：

```
$ warren net record stop cap --output=<WARREN_HOME>/core/evil.har
  PATH_DENIED: PATH_DENIED 禁止写入 <WARREN_HOME> 数据目录
$ warren net record stop cap --output=/tmp/w4-ok.har       → 正常落盘
```

**`WARREN_HOME` 端到端**（应用与 CLI 都跟着走）：

```
$ WARREN_HOME=/tmp/warren-alt npm start
$ ls /tmp/warren-alt                    → app core crashDumps logs runtime
$ WARREN_HOME=/tmp/warren-alt warren env list   → （空：新根是新库）
$ warren env list                       → ENOENT: connect ENOENT <WARREN_HOME>/runtime/envd.sock
```

**顺带修掉两个真 bug**：

1. **`warren help` 竟然要求应用在跑**：`readRuntime()` 在模块顶层就读运行时文件，
   读不到直接 `exit(1)`。干净机器上（CI 的静态门）`tests/cli-help.test.ts` 的 5 条必然全红。
   改成懒加载，只有真要发 RPC 时才读。
2. **回归脚本硬编码了旧数据目录**（`scripts/regress/browser.sh` 的 `DB=…`），
   搬家之后 23.3 直接读不到库。改成 `${WARREN_HOME:-$HOME/.warren}/core/warren.db`。

**静态门**：`npm test` **225/225**（新增 paths 4 条）· lint 0 警告 · prettier ✓ · tsc 0 错。
**全量回归**：**146 PASS / 0 FAIL**。

### W5 · 收尾（2026-10-18）

- 五道静态门：`npm run lint` 0 警告 · `prettier --check` ✓ · `tsc --noEmit` 0 错 ·
  `npm test` **225/225** · 渲染层 build ✓。
- 全量回归：**146 PASS / 0 FAIL**。
- `docs/HANDOFF.md` 同步：硬约束加了「审批策略只能人改」「数据根只有一个」两条；
  代码地图加了 `paths.ts` / `domain/approval.ts` / `example-notes`；「当前状态」加了一节。
- `AGENTS.md` 的历史文档表把这份从「待实施」改成已落地。

**四批各自一个 commit**（每个都是「实现 → 静态门 → 实机实测 → 全量回归 → 提交」）：
W1 审批策略、W2 内嵌代理面板、W3 记忆插件、W4 数据根。这一批之前还单独提交了
Whistle 代理插件（上一轮的成果）。

**四个真 bug 是实施过程中撞出来的**，都不在计划里：host 运行时命令丢 ctx、插件 rpc 返回值不能带
`undefined`、插件前端 bundle 的双层缓存、`warren help` 要求应用在跑。
