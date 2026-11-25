# Warren 技术栈调研与选型方案

> 状态：Draft
> 日期：2026-10-13
> 目标产品：Electron 桌面端 + CLI 驱动的多 Environment 浏览器工作台

## 1. 产品定义

本项目不是 Worktree 管理器、反检测浏览器或普通的 Profile 切换器。

核心对象是 `Environment`：一个可独立运行、可独立配置代理、可被 AI 或人操作的浏览器环境。

一个 Environment 包含：

- 独立的 Electron Session
- 独立的持久化存储目录
- 独立代理配置
- 一个或多个页面
- Agent / Human 控制权状态
- 页面观察数据、操作事件和错误日志
- 可选的账号、Cookie、登录插件和 Mock 能力

Worktree、项目目录、Dev Server 不是核心概念，只能作为未来插件或环境附属资源接入。

## 2. 已确认的官方能力

| 能力 | 结论 | 依据 |
|---|---|---|
| 持久化独立 Session | Electron `session.fromPath(path)` 支持 | Electron session API |
| Session 级代理 | `ses.setProxy(config)` 支持 | Electron session API |
| 页面承载 | `WebContentsView` 是当前推荐的原生网页视图；`BrowserView` 已弃用 | Electron WebContentsView / BrowserView 文档 |
| 页面 CDP 控制 | `webContents.debugger.attach()`、`sendCommand()`、`message` 事件支持 | Electron Debugger API |
| Electron 安全边界 | `contextIsolation`、sandbox、限制 IPC、禁止远程内容 Node 集成 | Electron Security / Context Isolation 文档 |
| 本地凭据加密 | `safeStorage` 使用系统密钥存储；推荐异步 API | Electron safeStorage 文档 |
| 代理认证 | Electron 的页面导航需要由主进程处理认证挑战；不能把密码暴露给页面或普通插件 | Electron `login` 事件 + Secret Vault 设计 |
| Agent 自动化 | Playwright 有成熟的 locator、snapshot、storage、route 能力，但它默认控制自己创建的 Browser/Context | Playwright Browser / BrowserContext 文档 |
| Chrome 扩展 | Playwright 支持 persistent context 和 MV3 service worker；Electron 扩展能力不完整，应作为独立插件能力评估 | Playwright Chrome Extensions 文档 |
| 构建 | Electron Forge 官方 Vite 插件支持 main、preload、renderer 多入口和 HMR | Electron Forge Vite Plugin |

### 2.1 版本检查

2026-10-13 在当前环境对 npm registry 做了检查：

- Electron：`44.7.0`
- Playwright：`1.64.0`
- React：`19.3.0`
- TypeScript：`7.0.2`

生产项目不在文档里硬编码这些版本，实际以锁文件为准；升级必须经过 Electron、Chromium、Playwright、插件 API 的回归测试。

## 3. 最终架构选择

### 3.1 选择：Electron 主进程持有真实环境

```text
┌────────────────────────────────────────────────────────────┐
│ Electron Main Process                                      │
│                                                            │
│  EnvironmentRegistry                                       │
│  SessionManager        ProxyManager        ControlLease    │
│  BrowserController     PluginHost          EventBus        │
│  LocalRpcServer        CredentialVault                     │
└──────────────┬──────────────────────────┬──────────────────┘
               │                          │
         WebContentsView              Local RPC
               │                          │
         右侧真实页面                 warren CLI / Agent
               │
        Environment Session
        Cookie + Storage + Proxy
```

Electron 是第一产物的合理宿主，因为用户明确要求：

- 有桌面端
- 左侧 Environment 列表
- 右侧打开真实页面
- 快速切换 Environment
- 有时人直接接管页面

但核心状态必须由 Main Process 管理，不能由 Renderer 或某个插件持有。

### 3.2 不采用“每个 Environment 一个外部 Chrome”作为第一版

第一版使用：

```text
一个 Electron 应用
  ├─ Environment A -> Session A -> WebContentsView A
  ├─ Environment B -> Session B -> WebContentsView B
  └─ Environment C -> Session C -> WebContentsView C
```

理由：

- 不需要指纹伪装
- Session 级 Cookie / LocalStorage / Cache / Proxy 隔离已经满足需求
- 页面天然嵌入右侧工作区
- 人和 Agent 操作同一个页面实例
- 不需要维护外部 Chrome 进程、端口和 CDP 连接
- 代理认证、Cookie 管理和页面事件可以集中在 Electron 主进程

未来如果需要进程级隔离，保留 `BrowserBackend` 接口，新增 `ExternalChromiumBackend`，不改变 CLI、插件和 UI 合约。

### 3.3 不直接用 Playwright 接管右侧页面

Playwright 适合控制它自己创建的 BrowserContext。当前产品的右侧页面由 Electron `WebContentsView` 持有，直接把 Playwright 当作第二个浏览器控制平面会导致：

- 人看到的页面与 Agent 操作的页面可能不是同一个实例
- Session、Cookie、代理和页面生命周期出现两套状态
- Electron Chromium 与 Playwright 浏览器版本可能不同步
- 接管、截图、事件和插件需要跨两个运行时同步

第一版采用 `BrowserController`，底层调用 Electron `webContents.debugger` 的 CDP 命令，并提供 Playwright/Ego 风格的 CLI API：

```text
page.goto(url)
page.snapshot()
page.screenshot()
page.getByRole(role, name).click()
page.getByLabel(name).fill(value)
page.locator(selector).click()
page.press(key)
page.waitFor(condition)
page.evaluate(expression)       # 需要显式权限
```

这不是承诺完整兼容 Playwright，而是先实现稳定、可审计的 Agent 操作子集。

后续可以增加 `PlaywrightAdapter`：如果验证 Playwright 能稳定连接 Electron 的远程调试目标，再作为可选后端，不改变上层 API。

## 4. Electron 分层

### 4.1 Main Process

职责：

- Environment CRUD 和状态机
- `session.fromPath()` 创建和复用持久 Session
- Session 代理设置和代理认证挑战
- WebContentsView 创建、销毁、切换、后台回收
- CDP BrowserController
- Agent / Human Lease
- PluginHost
- CredentialVault
- SQLite 持久化
- CLI 本地 RPC
- 事件总线和审计日志

### 4.2 Renderer

Renderer 只负责本地 UI：

- Environment 列表
- 当前 Environment 详情
- 控制权状态
- 操作时间线
- 插件面板
- 设置页

Renderer 不直接访问 Node、文件系统、Session、Cookie 或代理密码。

必须启用：

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- typed `contextBridge`
- 只暴露白名单 IPC
- 所有 IPC 校验 sender 和参数

### 4.3 WebContentsView

每个 Environment 可以持有一个 WebContentsView：

- Session 在创建 WebContentsView 之前确定
- 当前 Environment 的 View 加入主窗口右侧区域
- 非当前 Environment 可以移除出可视树，但默认保留实例
- 超过资源阈值后按 LRU 休眠或销毁
- 不使用 `<webview>`
- 不使用已弃用的 `BrowserView`

注意：WebContentsView 是原生 View，不受 DOM z-index 控制。Agent 锁定遮罩应使用单独的原生 WebContentsView overlay，不能只在 Renderer DOM 里放一个 div。

## 5. CLI 和本地 RPC

### 5.1 CLI 定位

CLI 是 Agent 的主要操作入口，形态参考 `ego-browser`：

- 一条命令可以执行一整段脚本
- 结果使用紧凑 JSON / 文本输出
- 不需要 MCP 客户端配置
- 人和 Agent 可以执行同一条命令

### 5.2 RPC 设计

第一版：

- Electron Main Process 启动本地 RPC Server
- macOS/Linux 优先 Unix Domain Socket
- Windows 使用 named pipe 或 loopback HTTP
- RPC 只监听本机
- 每次启动生成随机 capability token，写入用户私有权限的 runtime 文件
- CLI 读取 token 后建立连接
- 所有 mutation 请求必须带 Environment ID 和 lease ID

后续：

- 支持 CLI 启动 hidden/headless Electron runtime
- GUI 和 CLI 连接同一个 runtime
- runtime 与 GUI 分离为独立 `envd` 后端

### 5.3 CLI 命令草案

```bash
warren env list
warren env create --name alpha --proxy http://127.0.0.1:9001
warren env start alpha
warren env stop alpha
warren env status alpha
warren env egress alpha
warren env acquire alpha --owner agent
warren env release alpha

warren browser open alpha https://example.com
warren browser snapshot alpha
warren browser screenshot alpha --output /path/a.png

warren exec alpha <<'JS'
await page.goto('https://example.com');
console.log(await page.snapshot());
JS
```

`warren exec` 的脚本运行在受限 host API 上，不向脚本暴露 `require`、文件系统、子进程或 Electron 对象。

## 6. Environment 数据模型

```ts
type Environment = {
  id: string;
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'paused' | 'error';
  storagePath: string;
  proxyId?: string;
  startUrl?: string;
  headed: boolean;
  createdAt: string;
  updatedAt: string;
};

type EnvironmentControl = {
  environmentId: string;
  owner: 'none' | 'agent' | 'human';
  leaseId?: string;
  ownerLabel?: string;
  expiresAt?: string;
  lastHeartbeatAt?: string;
};

type ProxyProfile = {
  id: string;
  name: string;
  scheme: 'direct' | 'http' | 'https' | 'socks5';
  host?: string;
  port?: number;
  credentialRef?: string;
  bypass?: string[];
};
```

`proxyId` 只引用代理配置，Environment 不保存明文代理密码。

## 7. 控制权模型

### 7.1 读取操作

不需要 Lease：

- `env.list`
- `env.status`
- `env.snapshot`
- `env.screenshot`
- `env.logs`
- `env.egress`
- UI 查看和切换选中环境

### 7.2 修改操作

必须持有 Lease：

- navigate
- click
- fill
- type
- press
- evaluate
- upload
- cookie 写入
- 登录插件执行
- 代理切换

### 7.3 Lease 规则

- Environment 同时只能有一个 mutation owner
- UI 选择环境不等于获得控制权
- Agent 和 Human 都必须 acquire
- Lease 有 TTL 和 heartbeat
- owner 崩溃或超时自动释放
- Human takeover 会撤销 Agent Lease
- Agent 后续调用返回 `CONTROL_REVOKED` 或 `ENV_BUSY`
- lock / acquire / takeover / release 全部写入事件流

## 8. 插件机制

### 8.1 插件目标

插件用于快速加入：

- 登录流程
- 账号管理
- Cookie 导入/导出/同步
- 代理供应商或代理检测
- 页面站点适配
- Mock 数据和请求规则
- Agent 专用命令
- Environment 初始化和清理
- UI 详情面板

### 8.2 插件不是普通 Renderer 代码

插件运行在独立 Plugin Worker/Utility Process 中，通过 Host RPC 使用能力。

第一版把插件视为“本机可信代码”，但仍然执行权限声明、用户确认和能力隔离；不把第三方插件宣传为安全沙箱。真正不可信插件需要后续 OS sandbox / 容器隔离。

禁止：

- 插件直接访问 Renderer DOM
- 插件直接读取 Session 目录
- 插件直接读取 Cookie 数据库
- 插件直接读取 Credential Vault
- 插件默认访问文件系统和子进程
- 插件向日志写入密码、Cookie、Token

### 8.3 插件类型

```text
auth        站点登录与账号绑定
account     账号元数据、账号切换、账号健康检查
cookie      Cookie / storage state 导入导出流程
proxy       代理校验、出口检测、代理池
mock        请求规则和 Mock 数据
environment Environment 创建/启动/销毁钩子
agent       CLI 命令和 Agent 操作扩展
ui          环境详情页和侧栏面板
```

### 8.4 插件 Manifest

```json
{
  "id": "com.example.github-auth",
  "version": "0.1.0",
  "apiVersion": "1",
  "name": "GitHub Login",
  "permissions": [
    "browser.navigate",
    "browser.dom.read",
    "browser.input",
    "vault.fill",
    "account.read"
  ],
  "contributes": {
    "authProviders": ["github"],
    "commands": ["account.login", "account.logout"]
  }
}
```

### 8.5 权限分级

| 权限 | 默认 | 说明 |
|---|---:|---|
| `environment.read` | 允许 | 读取环境状态 |
| `browser.dom.read` | 允许 | 读取快照和页面文本 |
| `browser.screenshot` | 允许 | 截图 |
| `browser.navigate` | 用户确认 | 导航到 URL |
| `browser.input` | 用户确认 | 点击、输入、上传 |
| `browser.evaluate` | 禁止 | 执行页面 JS，需显式授权 |
| `storage.cookie.read` | 禁止 | 读取 Cookie 是高风险能力 |
| `storage.cookie.write` | 禁止 | 写入 Cookie 是高风险能力 |
| `vault.fill` | 用户确认 | 只能将秘密填入指定字段，不返回明文 |
| `network.observe` | 用户确认 | 读取请求和响应元数据 |
| `process.spawn` | 禁止 | 启动本地程序 |
| `filesystem.read` | 禁止 | 读取本地文件 |

### 8.6 登录和账号管理

账号模型与凭据模型分离：

```text
Account
  ├─ provider: github
  ├─ label: personal
  ├─ usernameHint: user@example.com
  └─ credentialRef: vault://...

Credential Vault
  └─ username/password/token/TOTP seed
```

插件只能请求：

```text
vault.fill(credentialRef, targetFieldRef)
```

插件不能得到密码字符串。登录流程完成后，Core 可以在用户确认后保存：

- Session Cookie
- localStorage
- IndexedDB 中可安全导出的状态
- Playwright-compatible storage state

Cookie 导入/导出必须：

- 明确显示目标 Environment
- 明确显示目标域名
- 用户确认后执行
- 默认脱敏日志
- 支持撤销和删除
- 不进入普通事件日志

### 8.7 插件生命周期

```text
installed -> enabled -> running -> stopped -> disabled -> removed
```

插件升级前：

- 校验 API 版本
- 显示权限差异
- 备份插件配置
- 禁止自动扩大权限

## 9. 凭据与 Cookie 选型

### 9.1 Vault

第一版使用 Electron `safeStorage` 加密本地 Vault 数据：

- macOS 使用 Keychain
- Windows 使用系统保护机制
- Linux 依赖可用的系统密码管理器
- 使用异步 API
- 生产构建必须稳定签名，避免 macOS Keychain 反复询问
- Vault 解密只发生在 Main/Core

CLI 不直接读取 Vault；CLI 通过 RPC 请求 Core 执行填充或使用短期 capability。

### 9.2 Cookie

第一版不直接修改 Chromium SQLite Cookie 数据库。

通过 Electron Session API 和受控页面脚本完成：

- 列出指定域 Cookie 的元数据
- 删除指定域 Cookie
- 导入受控 Cookie 集
- 导出经过用户确认的 Cookie/storage state

## 10. 数据持久化

选择 SQLite 作为正式存储：

- environments
- proxy_profiles
- accounts
- credentials metadata
- leases
- plugins
- plugin_permissions
- events
- settings

Electron 原生模块必须通过 `@electron/rebuild` 和打包 CI 验证。

M0 可以先用 JSON 作为启动配置，但不能把 JSON 作为最终事件和凭据数据库。

推荐：

- ORM/query：Drizzle
- DB：SQLite + `better-sqlite3`
- migrations：Drizzle migrations
- 备份：SQLite 文件复制 + schema version

## 11. UI 技术栈

- Electron Forge
- Vite plugin
- React
- TypeScript
- Zustand：轻量 UI 状态
- TanStack Query：RPC query/cache
- CSS：优先现有 CSS Modules 或轻量 design tokens，不在 M0 引入复杂组件库
- Lucide React：图标

主窗口布局：

```text
┌──────────────────────────────────────────────────────┐
│ Toolbar: 新建 / 搜索 / 当前控制者 / 接管              │
├───────────────┬──────────────────────────────────────┤
│ Environment   │ Warren                   │
│ List          │ WebContentsView                       │
│               │                                      │
│ Alpha         │                                      │
│ Beta          │                                      │
│ Gamma         │                                      │
├───────────────┴──────────────────────────────────────┤
│ Event timeline / console / network / plugin panel      │
└──────────────────────────────────────────────────────┘
```

第一版必须支持：

- Environment 列表和搜索
- 新建 / 删除 / 启动 / 停止
- 代理状态
- 控制权状态
- 当前 URL / title
- Agent 操作状态
- 人工接管 / 交还
- 右侧页面快速切换

## 12. 测试和质量门槛

### 单元测试

- Environment 状态机
- Lease acquire/release/expiry
- Proxy 配置校验
- Plugin manifest 和权限合并
- Vault 引用解析
- CLI 参数解析

### 集成测试

- 每个 Environment Session Cookie 隔离
- 每个 Environment Proxy 设置独立
- WebContentsView 切换不丢页面状态
- CLI 与 Electron Main RPC 往返
- Agent Lease 阻断 Human mutation
- Human takeover 阻断 Agent mutation
- 插件无权限读取 Cookie/Vault
- Electron 退出清理 lease 和页面资源

### E2E

- 创建 Environment
- 配置代理
- 打开页面
- CLI snapshot
- CLI click/fill
- UI 切换 Environment
- Agent 操作时 UI 显示锁定
- UI 接管后 Agent 得到 `CONTROL_REVOKED`
- 登录插件完成一次虚拟站点登录
- Cookie 导入需确认且不出现在日志

## 13. 被拒绝的方案

### 外部 Chrome + CDP 作为第一版

优点是进程隔离，但会破坏“右侧页面就是 Agent 正在操作的页面”的第一产物体验，并增加端口、进程、窗口、认证和回收复杂度。

保留为后端接口，不作为 M0。

### Playwright 直接管理另一套浏览器

会导致人看到的页面和 Agent 操作的页面不是同一实例。Playwright 作为 API 设计参考和后续适配器，不作为第一版的真实页面宿主。

### 在 Renderer 里直接放 Node/Electron API

违反 Electron 安全模型，禁止。

### 允许插件直接拿密码和 Cookie

不可接受。插件只能拿 capability 或调用受控的 `vault.fill`。

## 14. 关键风险和验证门

| 风险 | 验证门 |
|---|---|
| Electron CDP 的 AX snapshot / locator 不够稳定 | M1 做真实页面 snapshot/click/fill 原型 |
| WebContentsView 原生 View 遮罩困难 | M0 实现 input shield 原型 |
| Electron Session 代理认证行为差异 | M0 使用 HTTP 认证代理做端到端验证 |
| `better-sqlite3` 与 Electron ABI | M0 构建并执行 `electron-rebuild` |
| 插件权限无法形成真正安全沙箱 | M2 先声明“可信本地插件”，不开放远程市场 |
| 多个持久 Session 的内存成本 | M0 测试 1/5/10 个环境，定义 LRU 休眠阈值 |
| macOS Keychain 在未签名开发包中反复提示 | 开发态和签名构建分开验证 |

## 15. 推荐落地顺序

1. Electron Forge + React + TypeScript 工程
2. Environment CRUD + SQLite/临时 JSON adapter
3. Session fromPath + setProxy
4. WebContentsView 左右布局与快速切换
5. Main 内部 BrowserController：navigate / screenshot / AX snapshot
6. Local RPC + warren
7. Lease、input shield、human takeover
8. 事件流、操作时间线、console/network 元数据
9. Vault 和 Cookie 管理
10. PluginHost 和第一个登录插件

第一条真正的技术 Spike 不是 UI，而是：

> 创建两个 Environment，分别使用两个 Session 和两个代理；让两个页面同时打开；CLI 对其中一个执行 snapshot/click；桌面端右侧看到同一个页面变化；另一个 Environment 不受影响。

这个 Spike 通过之后，再扩大插件和 Agent 能力面。
