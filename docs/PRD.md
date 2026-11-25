# Warren PRD

> 产品代号：Warren
> 文档状态：MVP PRD
> 文档日期：2026-10-13
> 第一产物：macOS Electron 桌面端 + `warren` CLI

## 1. 产品摘要

Warren 是一个面向 AI Agent 的本地隔离浏览器工作台。

用户可以创建多个独立 Environment。每个 Environment 拥有独立浏览器存储、独立代理和独立页面状态。AI 通过 CLI 操作指定 Environment；人通过 Electron 桌面端观察页面、查看事件和在需要时接管操作。

核心原则：

1. AI 和人看到、操作的是同一个 Environment 和同一个页面实例。
2. Environment 是核心概念，不引入 Worktree 作为产品模型。
3. 每个 mutation 操作必须显式指定 Environment，不存在隐式“当前环境”。
4. 同一时间一个 Environment 只能由一个主体进行写操作。
5. 插件扩展能力，但不能默认接触密码、Cookie、Session 数据或文件系统。
6. 第一版不做指纹伪装，不修改 Chromium 内核，不做反检测能力。

## 2. 用户问题

### 2.1 AI Agent 的问题

AI 在开发和测试项目时，通常需要反复操作浏览器：

- 打开页面
- 读取页面结构
- 点击、输入、提交
- 查看控制台和网络错误
- 保留某个登录态
- 在不同代理或不同账号环境下重复验证
- 在长流程中被人接管后继续执行

现有浏览器自动化工具通常只提供单个 Browser/Context，或者人和 AI 使用不同的浏览器实例。它们无法自然表达：

- 多个可命名、可持久化的隔离环境
- 每个环境一个代理
- Agent 明确操作某个环境
- 人可以实时看到同一个环境
- 人可以中途接管并交还
- 登录、Cookie、账号等能力以插件方式加入

### 2.2 人的观察问题

用户需要知道：

- 当前有哪些 Environment
- 哪些 Environment 正在运行
- 每个 Environment 当前页面是什么
- 当前代理是什么、出口是否有效
- AI 正在操作哪个 Environment
- AI 最近执行了什么动作
- 页面是否报错
- 何时可以接管

## 3. 目标与非目标

### 3.1 目标

MVP 必须实现：

- Electron 桌面端
- Environment 创建、启动、停止、删除
- Environment 独立持久化 Session
- Environment 独立代理
- 左侧 Environment 列表
- 右侧真实页面显示和快速切换
- CLI 控制 Environment
- CLI 读取结构化页面 Snapshot
- CLI 执行基础页面操作
- Agent/Human 单写者控制权
- Agent 操作时桌面端实时显示控制状态
- Human takeover / release
- 事件时间线
- 插件注册、启用、禁用和权限声明
- 第一个插件 API 示例

### 3.2 非目标

MVP 不做：

- 浏览器指纹伪装
- Chromium fork
- 外部反检测浏览器内核
- Worktree 自动发现和 Worktree 生命周期
- 云端同步
- 多用户远程协作
- 远程插件市场
- 任意第三方插件沙箱安全承诺
- 自动绕过验证码或平台风控
- 自动保存所有网站密码
- 兼容完整 Playwright API
- 完整商业浏览器功能（书签 / 历史 / 同步 / 多窗口）
  - 注：**标签页不在这个非目标里**。网页自己就会开新标签（`target="_blank"`、`window.open`），不支持就等于行为与真实浏览器不一致。标签活在 Environment 内部，共用它的 session / 代理 / 登录态。见 `docs/TAB-MODULE-PLAN.md`。

## 4. 目标用户和使用场景

### 4.1 Agent 开发测试

1. AI 创建 `alpha` Environment，设置代理 A。
2. AI 打开开发页面。
3. AI 使用 `warren exec alpha` 执行导航、Snapshot、点击和输入。
4. 用户在 Electron 右侧看到页面变化。
5. 用户发现 AI 误判页面，点击“接管”。
6. AI 的写操作被拒绝，用户修正页面。
7. 用户点击“交还”，AI 继续执行。

### 4.2 多代理环境对比

1. 创建 `us`、`jp`、`direct` 三个 Environment。
2. 每个 Environment 使用不同代理。
3. AI 分别访问同一个地址。
4. AI 调用 `warren env egress` 确认实际出口。
5. 用户从左侧快速切换，观察页面差异。

### 4.3 登录插件

1. 用户安装 GitHub 登录插件。
2. 插件声明 `browser.navigate`、`browser.input`、`vault.fill` 权限。
3. 用户为 Environment 选择一个 GitHub 账号。
4. 插件启动登录流程。
5. 密码由 Vault 填入目标字段，插件不能读取密码明文。
6. 登录成功后，用户选择是否保存 Session 状态。

### 4.4 Cookie 搬运

1. 用户在 Environment A 中完成登录。
2. 用户打开 Cookie 管理插件。
3. 选择域名和目标 Environment B。
4. 系统显示导入范围和风险。
5. 用户确认后导入。
6. 所有 Cookie 值不出现在普通事件日志和 Agent 输出中。

## 5. 产品概念

### 5.1 Environment

Environment 是可寻址的隔离浏览器运行单元。

每个 Environment 包含：

- 唯一 ID
- 显示名称
- 持久化 Session
- Session 存储目录
- 代理引用
- 页面集合
- 当前选中页面
- 当前运行状态
- 控制权租约
- 操作事件
- 可选插件状态

Environment 不等于：

- Git 分支
- Worktree
- 单个账号
- 单个页面
- 单个进程

这些都可以通过插件或未来扩展关联，但不能进入核心数据模型。

### 5.2 主体

系统有两类操作主体：

- `agent`：通过 `warren` 执行操作
- `human`：通过 Electron UI 执行操作

系统还需要支持多个 Agent 名称，但同一 Environment 同一时间只有一个 mutation owner。

### 5.3 读取与写入

读取操作：

- 查看状态
- 查看页面 Snapshot
- 查看截图
- 查看 URL/title
- 查看控制台和网络元数据
- 查看出口信息

写入操作：

- 导航
- 点击
- 输入
- 键盘操作
- 页面脚本执行
- Cookie 写入
- 代理修改
- 登录插件执行
- 文件上传

读取操作不需要 Lease；写入操作必须拥有有效 Lease。

## 6. 用户流程

### 6.1 创建 Environment

桌面端：

1. 点击“新建 Environment”。
2. 输入名称。
3. 选择存储模式：持久化 / 临时。
4. 选择代理配置。
5. 选择启动时是否显示窗口。
6. 选择启动 URL。
7. 点击创建。

CLI：

```bash
warren env create alpha \
  --proxy proxy-jp \
  --persistent \
  --headed \
  --start-url https://example.com
```

验收：

- 名称重复时拒绝创建。
- Environment 创建后可以被 `warren env list` 看到。
- Session 目录只由 Core 管理。
- 代理密码不进入 Environment JSON 和普通日志。

### 6.2 启动和切换

桌面端：

- 点击列表项即可选中。
- 未运行的 Environment 显示“启动”。
- 运行中的 Environment 点击后，右侧加载其 WebContentsView。
- 切换过程中不创建第二个页面实例。
- 已登录状态和页面滚动位置保持。

CLI：

```bash
warren env start alpha
warren browser open alpha https://example.com
warren env status alpha
```

### 6.3 Agent 操作页面

CLI 脚本示例：

```bash
warren exec alpha <<'JS'
await page.goto('https://example.com');
console.log(JSON.stringify(await page.snapshot()));
await page.getByRole('link', { name: 'More information' }).click();
console.log(await page.title());
JS
```

MVP API：

```ts
interface AgentPage {
  goto(url: string): Promise<void>;
  snapshot(options?: SnapshotOptions): Promise<AccessibilitySnapshot>;
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;
  getByRole(role: string, options?: { name?: string }): Locator;
  getByText(text: string): Locator;
  getByLabel(text: string): Locator;
  locator(selector: string): Locator;
  waitFor(options: WaitOptions): Promise<void>;
  press(key: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
}

interface Locator {
  click(options?: ActionOptions): Promise<void>;
  fill(value: string, options?: ActionOptions): Promise<void>;
  textContent(): Promise<string | null>;
  isVisible(): Promise<boolean>;
}
```

限制：

- `evaluate` 默认关闭，需 CLI flag 或 Environment 权限开启。
- 所有写操作自动记录事件。
- 所有操作检查 Lease。
- 操作目标只能属于传入 Environment。

### 6.4 人工接管

当 Agent 持有 Lease 时，桌面端显示：

```text
AI 正在操作 Alpha
页面操作已锁定
[查看] [接管]
```

用户点击“接管”：

1. Core 标记 takeover 请求。
2. Agent Lease 被撤销。
3. Agent 正在执行的 mutation 返回 `CONTROL_REVOKED`。
4. 右侧页面解除输入阻断。
5. Human 获得 Lease。
6. 时间线记录 takeover。

用户点击“交还”：

1. Human Lease 释放。
2. 页面恢复 Agent 可写状态。
3. Agent 必须重新 acquire，不能复用旧 lease ID。

### 6.5 Environment 删除

删除分为两种：

- `delete`：删除元数据，但保留 Session 目录
- `purge`：删除元数据、Session、插件状态和缓存

`purge` 必须二次确认，并显示：

- 目标 Environment
- Cookie/登录状态会被删除
- 插件状态会被删除
- 是否有正在运行的进程

## 7. 桌面端信息架构

### 7.1 主窗口

```text
┌──────────────────────────────────────────────────────────┐
│ 顶栏：搜索 | 新建 | 当前主体 | 接管/交还 | 设置           │
├───────────────┬──────────────────────────────────────────┤
│ Environment   │ 当前 Environment                         │
│ 列表          │ ┌──────────────────────────────────────┐ │
│               │ │ URL / 代理 / 控制者 / 状态             │ │
│ ● Alpha       │ ├──────────────────────────────────────┤ │
│ ○ Beta        │ │                                      │ │
│ ● Gamma       │ │         WebContentsView 页面           │ │
│               │ │                                      │ │
│               │ ├──────────────────────────────────────┤ │
│               │ │ 事件 / Console / Network / 插件面板   │ │
└───────────────┴──────────────────────────────────────────┘
```

### 7.2 Environment 列表项

每项显示：

- 名称
- 运行状态
- 代理标签
- 控制者：空闲 / AI / 人
- 当前页面标题
- 最近活动时间
- 错误标记

### 7.3 当前页面顶部

显示：

- Environment 名称
- 当前 URL
- 页面标题
- 代理名称和实际出口摘要
- Session 模式
- 控制者和 Lease 剩余时间
- 接管、交还、停止、刷新按钮

### 7.4 底部面板

标签页：

- Events
- Snapshot
- Console
- Network
- Plugins
- Storage（高风险，默认隐藏）

## 8. CLI 产品定义

> **这一节按实现现状写**（2026-10-16 校准过一遍：文档里出现过 `env delete` / `env purge` /
> `env status` / `browser tabs` / `browser close-tab` / `browser cookies` / `plugin permissions`
> 这些**根本没实现**的命令，现在改成了真实存在的）。`warren help` 是唯一权威；
> 改命令就改这里 + `bin/warren.mjs` 的帮助文本。

### 8.1 基础命令

```bash
warren env list
warren env create <name>
warren env update <name> [--name=新名字] [--proxy=URL] [--start-url=URL]
warren env start <name>
warren env stop <name>
warren env remove <name>            # 删环境（会话目录一并删）
warren env select <name>
warren env egress <name>
warren env acquire <name>
warren env release <name>
warren env takeover <name>
warren env move <name> --group=<分组ID|none>
```

**没有** `env purge`（`env remove` 就是删干净）、也没有 `env status`（状态在 `env list` /
`env egress` 里）。

### 8.2 浏览器命令

```bash
warren browser open <env> <url>
warren browser snapshot <env>
warren browser screenshot <env> --output=<path>
warren browser highlight <env> [选择器]
warren browser info <env>
warren browser events <env>
warren browser console <env>
warren browser network <env>

# 标签是独立的一组（不在 browser 下面）
warren tab list|new|select|close|reopen <env> [序号|tabId] [url]
```

**标签**在 `warren tab` 组里（`browser tabs` / `browser close-tab` 从没实现过）。
**Cookie 没有 CLI**：Cookie 是给插件的**只搬运不返回**通道（`host.cookie.*`，
见 `docs/PLUGIN-CAPABILITY-DESIGN.md` §9），CLI 侧不提供读写——那是人拿明文登录态的入口，
不该有。

### 8.3 插件命令

```bash
warren plugin list
warren plugin install path:<目录>
warren plugin install npm:<包名>[@版本]
warren plugin install git:<仓库>#<ref>
warren plugin update <id>
warren plugin enable <id>
warren plugin disable <id>
warren plugin grant <id> <permission...>
warren plugin uninstall <id>
warren plugin reload <id>
warren plugin status <id>
warren plugin logs <id> [-n 20]
warren plugin config <id> set <key> <value>
warren plugin run <id> <command> --env <name>
```

**没有** `plugin permissions <id>`：声明的权限与层级在 `plugin list` 里（每条带层级徽章），
授权是 `plugin grant`。

### 8.4 输出协议

默认输出适合人看；传入 `--json` 输出稳定 JSON：

```bash
warren env list --json
```

Agent 脚本错误必须带机器可读 code：

```json
{
  "ok": false,
  "error": {
    "code": "ENV_BUSY",
    "message": "Environment alpha is controlled by human",
    "environmentId": "alpha",
    "owner": "human",
    "retryable": false
  }
}
```

## 9. Agent-first 功能清单

这些能力不应等到“以后再说”，它们直接决定 Agent 能否稳定使用产品。

### P0

- 显式 Environment 寻址
- `snapshot` 结构化观察
- 统一 Locator API
- 操作事件记录
- Lease 和控制权错误码
- 代理出口验证
- 执行超时和取消
- Agent 操作 trace ID
- 页面当前 URL/title
- console error 摘要
- 失败时自动保存截图和 Snapshot

### P1

- 页面状态缓存和增量 Snapshot
- 等待条件：元素出现、URL 变化、网络空闲、文本出现
- Network 请求摘要
- 下载文件状态
- 弹窗处理
- 多 Tab 选择
- Agent 可读的 Environment health
- 操作重试策略
- Agent 任务恢复
- 事件订阅
- 人工 takeover/release
- 插件命令和插件返回结构化结果

### P2

- Trace viewer
- 页面操作录像
- 环境快照和恢复
- 可复现任务包
- Environment 克隆
- 多 Agent 队列
- 远程 daemon
- MCP adapter
- Playwright adapter

## 10. 插件系统 PRD

### 10.1 插件安装

插件是独立 npm 包，安装来源支持本地目录、npm 和 git：

```bash
warren plugin install path:./plugins/github-auth
warren plugin install npm:warren-plugin-github-auth@^1.0.0
warren plugin install git:https://github.com/acme/warren-plugin-github-auth.git#v1.0.0
```

远程市场不在 MVP 内；`plugin update` 按安装时记录的来源重新解析。

安装流程：

1. 解析 `path:` / `npm:` / `git:`。
2. `npm pack`，只接受包内容。
3. 读取 `package.json#warren`，校验 ID、版本、API 版本 `"4"`。
4. 显示权限列表与 runtime。
5. 安装运行时依赖（禁止 lifecycle script）。
6. 写入暂存目录并原子替换。
7. 默认 disabled，用户显式 enable；更新启用中的插件失败会回滚。

### 10.2 插件 Host API

插件只通过 Host API 请求能力：

```ts
interface PluginHostApi {
  environment: {
    get(id: string): Promise<EnvironmentSummary>;
    list(): Promise<EnvironmentSummary[]>;
  };
  browser: {
    navigate(envId: string, url: string): Promise<void>;
    snapshot(envId: string): Promise<AccessibilitySnapshot>;
    click(envId: string, target: Target): Promise<void>;
    fill(envId: string, target: Target, value: string): Promise<void>;
  };
  vault: {
    listRefs(provider: string): Promise<CredentialRef[]>;
    fill(ref: string, target: FieldTarget): Promise<void>;
  };
  storage: {
    getPluginValue(key: string): Promise<unknown>;
    setPluginValue(key: string, value: unknown): Promise<void>;
  };
  events: {
    emit(event: PluginEvent): Promise<void>;
  };
  ui: {
    notify(message: string): Promise<void>;
  };
}
```

`PluginHostApi` 不包含：

- `fs`
- `child_process`
- raw `BrowserWindow`
- raw `WebContents`
- raw Session
- 明文 password/token
- 全局 Cookie 数据库

### 10.3 第一个插件

第一个官方插件建议做 `Example Login`，使用本地测试站点，覆盖：

- 插件 manifest
- 权限申请
- 环境选择
- 页面导航
- Snapshot 定位
- Vault.fill
- 登录成功判断
- 保存 Session
- 日志脱敏

不要第一步就接真实平台登录。先用本地 fixture 验证插件生命周期和权限边界。

## 11. 安全要求

### 11.1 页面安全

- Remote WebContentsView 禁止 Node integration
- 开启 context isolation
- 开启 sandbox
- 不暴露 raw IPC
- 限制导航和新窗口
- 校验 permission request
- 禁止不必要的 `shell.openExternal`
- 默认只允许 HTTPS 和用户明确允许的 localhost

### 11.2 Agent 安全

Agent 脚本默认：

- 无文件系统
- 无子进程
- 无网络库
- 无 Electron API
- 无 Vault 明文
- 无任意 Cookie 写入

高风险能力必须通过独立命令和权限确认开启。

### 11.3 插件安全

MVP 插件是“用户安装的本地可信代码”，不是安全沙箱。

产品 UI 必须明确显示：

> 本地插件可以执行其自身代码。权限声明限制它可使用的 Host API，但不等同于操作系统级沙箱。

后续真正支持不可信插件时，使用独立进程 + IPC schema + OS sandbox/容器，不能只依赖 JavaScript 变量隔离。

## 12. 持久化模型

核心表：

```text
environments
proxy_profiles
accounts
credential_refs
leases
plugins
plugin_permissions
environment_plugins
events
settings
```

敏感数据原则：

- `proxy_profiles` 只保存 `credentialRef`
- `credential_refs` 保存 Vault key，不保存明文
- `events` 默认禁止 value/password/cookie/token 字段
- Session 目录不通过 UI 或 CLI 直接暴露

## 13. MVP 验收标准

### A. Environment

- 可以创建两个 Environment。
- 两个 Environment 使用不同持久化 Session。
- A 登录后，B 看不到 A 的 Cookie 和登录态。
- 两个 Environment 可以配置不同代理。
- 切换左侧列表后，右侧页面保持各自状态。

### B. CLI

- CLI 可以列出 Environment。
- CLI 可以启动和停止 Environment。
- CLI 可以打开 URL。
- CLI 可以取得 Snapshot。
- CLI 可以截图。
- CLI 可以执行 click、fill、press、wait。
- CLI 操作的页面变化在桌面端右侧立即可见。

### C. 控制权

- Agent acquire 后，人不能直接修改页面。
- 人接管后，Agent mutation 返回 `CONTROL_REVOKED`。
- Lease 超时后自动释放。
- Core 重启后旧 Lease 无效。
- 查看操作不受 Lease 阻断。

### D. 插件

- 可以安装、启用、禁用本地插件。
- 插件 manifest 权限会显示给用户。
- 插件能调用浏览器导航和 Snapshot。
- 插件能请求 Vault.fill，但不能收到密码明文。
- 插件事件进入时间线，但敏感字段会脱敏。

### E. 安全

- 页面不能访问 Node/Electron API。
- Renderer 不能直接读取文件系统。
- CLI 不能直接读取 Vault。
- 任意 mutation 都有 Environment ID 和 Lease ID。
- Agent 脚本不能调用任意 Node 模块。

## 14. 里程碑

### M0：Electron 页面工作台

- Forge + Vite + React + TypeScript
- Main/Preload/Renderer 分层
- Environment registry
- Session fromPath
- Session setProxy
- WebContentsView
- 左侧列表和右侧页面
- 两环境隔离 Spike

### M1：浏览器控制和 CLI

- CDP BrowserController
- snapshot
- screenshot
- goto
- locator click/fill
- 本地 Unix Socket RPC
- `warren` 命令

### M2：控制权和事件

- Lease
- Agent/Human lock
- takeover/release
- 事件时间线
- console/network 摘要
- 超时/取消/trace ID

### M3：Vault 和 Cookie

- safeStorage async API
- credential refs
- Vault.fill
- Cookie 域管理
- storage state 导入导出
- 敏感日志脱敏

### M4：插件 Host

- Plugin manifest
- 权限声明和确认
- Plugin Worker/Utility Process
- Host API
- Example Login 插件
- Example Cookie 插件

### M5：稳定性

- LRU 环境回收
- Crash recovery
- SQLite migration
- 打包、签名、自动更新
- macOS 权限和 Keychain 回归

## 15. 第一条技术 Spike

在开始做完整 UI 之前，必须完成以下闭环：

1. 创建 Environment A 和 B。
2. A、B 使用不同 Session 目录。
3. A、B 配置不同代理或本地代理测试端口。
4. A、B 各打开测试页面。
5. CLI 对 A 执行 `snapshot` 和 `click`。
6. Electron 右侧看到 A 的页面变化。
7. B 页面、Cookie 和代理状态不受影响。
8. 人获取 A 的 Lease 后，Agent 的后续 click 被拒绝。
9. 人释放 Lease 后，Agent 可以重新 acquire。
10. Electron 退出并重启后，持久化 Environment 能恢复页面状态。

这条 Spike 通过后，再开始真实站点插件和复杂 UI；否则所有插件、账号和 Agent 体验都建立在未验证的浏览器控制基础上。
