---
name: warren
description: Operate a browser through Warren's isolated Person and Agent spaces — navigate, inspect accessibility snapshots, click, fill, and debug sites with independent profiles and proxies. Use when a task needs a real browser session, a local site exercised end to end, or background browser automation that must not steal focus.
---

# Warren

Warren 是本地隔离浏览器工作台。一个 **Environment** 是一套独立浏览器存储
（Cookie / localStorage / 登录态）+ 独立代理出口。Environment 内部有两个 **Space**：

- **Person Space**：人的工作区，永远由人控制，不需要 lease。
- **Agent Space**：Agent 的工作区，写操作使用独立 lease。

两个 Space 共用同一个 Environment 的登录态、Cookie 和代理，但各自有独立的 Tab 集合和控制权。
Agent 默认只操作 **Agent Space**。

人可以在 Agent 操作 Agent Space 的同时继续使用 Person Space，不会互斥。
人要查看或接管 Agent 的 Tab 时，会切到 Agent Space 并取得 `owner=human` 的控制权；
这时 Agent 的写操作会被拒绝。

## 开场

```bash
warren env list
warren env start <env>
warren env acquire <env>       # 取 Agent Space 写权限；返回 leaseId
warren tab list <env>          # 默认列 Agent Space；--space=person 才列人的空间
```

Agent 第一次操作某个环境时，如果 Agent Space 还没有 Tab，Warren 会懒建一个，
优先从 Person Space 当前 URL 复制入口。不要先切到 Person Space 再操作。

## 必须遵守

1. **每次调用都带 env**。没有隐藏的“当前环境”；列表选中不等于有写权限。
2. **不要操作 Person Space**。除非用户明确要求人工工作区的诊断操作，否则不要使用
   `--space=person` 新建、切换或关闭 Tab。
3. **写操作要 Agent Space lease**。人接管 Agent Space 后，你的下一次写会得到
   `CONTROL_REVOKED` 或新的 acquire 得到 `ENV_BUSY`。这时停下来问人，或
   `warren env acquire <env> --wait=5000` 等人交还。
4. **不要抢前台**。Warren 可以关闭到托盘、离屏运行；后台点击、键盘和表单输入已经被支持。
   不要调用 `debug.focusWindow`、`app.focus`，也不要要求用户先把窗口切到前台。
5. **一次调用跑一整段脚本**。`warren exec` 是主要入口：

```bash
warren exec <env> --lease=<id> <<'JS'
await page.goto('http://localhost:3000');
console.log(await page.title());
await page.click('button:has-text("登录")');
console.log(await page.snapshot());
JS
```

`--lease` 可以省略：省略时 CLI 会为 Agent Space 自动 acquire 并在脚本结束后释放。

## exec 里有什么

VM 里的全局就这几个：`page`、`console`、`setTimeout`、`clearTimeout`、`emitResult`。
**没有 fs、`require`、`process` 或任何模块加载器**——落盘、算哈希、拼文件一律由调用方在宿主侧做；
脚本只用 `emitResult(payload)` 把结构化结果交回去（宿主按 `__CONSOLE_E2E_RESULT__` 前缀取）。

`page` 是 Playwright 形状的子集，不是完整 Playwright：

- 导航与等待：`goto` `reload` `waitFor` `waitForURL` `waitForSelector` `waitForFunction`
  `waitForLoadState` `waitForTimeout` `waitForEvent`
- 动作：`click` `dblclick` `hover` `dragAndDrop` `fill` `selectOption` `focus` `press`
  `setInputFiles` `waitForFileChooser`
- 观察：`snapshot` `screenshot` `info` `url` `title` `console` `network` `events` `highlight`
- 弹框与下载：`acceptDialog` `dismissDialog` `downloadSaveAs` `downloadCancel` `downloadStatus`
- 定位器：`locator` `getByRole` `getByText` `getByLabel`
- 逃生舱：`evaluate` `fetch` `cdp` `clearDataForOrigin`
- 坐标与键盘：`mouse` `keyboard`
- Agent Space 标签：`tabs` `newTab` `selectTab` `closeTab` `reopenTab`

没有 `context()` / `expect()` / `route()` / `setViewportSize()`。

不要去猜还有没有别的方法：跑 `warren exec --capabilities`，它打印 `globals` / `page` / `locator` /
`mouse` / `keyboard` 的方法名，由代码反射生成，不会和实现漂移。

`snapshot` 返回的是**结构对象**（`url` + `title` + `nodes` 数组），不是字符串。
`console.log(await page.snapshot())` 打印的是 JSON；要截断先 `JSON.stringify(...)`，不要直接 `.slice()`。

## 看页面：先 snapshot

`page.snapshot()` 返回可访问性树，是主观察通道。`screenshot()` 只在确实需要视觉判断时使用。

`@N` ref 只属于当前那份快照；导航、重拍或页面重渲染后，旧 ref 会失效。

## 截图边界

`browser.screenshot` / `page.screenshot()` 在 Warren 后台运行时直接可用，不会激活窗口。
它先用 CDP 取可见视口；CDP 拿不到 surface 时，可见视口默认回退到 Electron `capturePage()`。

- 优先改用 `snapshot()`。
- 不要执行 `open -a Warren`、`osascript ... activate`、`debug.focusWindow`、`app.focus` 或 `wc.focus()`。
- `fullPage` / `clip` 依赖 CDP；后台 surface 不可用时这两类请求仍可能失败，错误要如实上报。

## 地址栏历史

桌面端地址栏有一份**跨 Environment 共用**的 URL 历史，存在同一个 SQLite 数据库里。
聚焦地址栏会显示最近访问，输入后按 URL 子串联想，支持方向键、Enter、Esc 和鼠标选择。
它是 UI 辅助，不是 Agent API；自动化仍用 `page.goto()`。

## 填密码

```bash
warren vault fill <ref> --env=<env> --field=password --target='{"kind":"label","text":"密码"}'
```

值从 Vault 直接进入页面字段，不返回明文。
`storage.cookie.read` / `storage.cookie.write` 永久不可用。

账号管理插件 `com.warren.accounts` 是另一个东西：按产品要求，它将账号、密码和备注
**明文**保存在插件数据库中，不经过 Vault。不要把两者混用，也不要在未获用户要求时导出账号。

它的 agent 通道**永远不返回明文**：`list` / `get` 只给 `hasPassword` 与打码用户名；
登录时按 id 填：

```bash
warren plugin rpc com.warren.accounts fill \
  --input='{"id":1,"environmentId":"<env>","fields":{"username":"#account","password":"input[type=password]"}}'
```

`fill` 的返回体只有 `{ filled: [...], id }`；`reveal` 只对插件界面开放（agent 调会报
`ACCOUNT_REVEAL_UI_ONLY`）；`export` 必须显式 `--input='{"confirm":"plaintext"}'`。

## 错误码

| 错误码 | 意思 | 下一步 |
|---|---|---|
| `TARGET_AMBIGUOUS` | 匹配到多个 | 换更具体的选择器，或使用刚拍出的 `@N` |
| `TARGET_NOT_FOUND` | 没有出现 | 先 `snapshot()`；动作默认会等 5 秒 |
| `NOT_ACTIONABLE` | 不可见 / 在动 / disabled | 等页面稳定，或修正页面状态 |
| `TARGET_OCCLUDED` | 被页面元素挡住 | 错误消息里带挡路元素 |
| `NODE_DETACHED` | 节点被替换 | 重新 snapshot |
| `TIMEOUT` | 重试超时 | 错误里带每次尝试的原因 |
| `ENV_NOT_VISIBLE` | 当前页面视图被界面浮层或插件页让开 | 关掉浮层或切回环境页面；单纯“Agent 在后台”不应该再报这个错 |
| `TAB_NOT_VISIBLE` | 输入目标不是当前激活 Tab | 先用 `tab select <env> <序号|tabId>` |
| `CONTROL_REVOKED` | lease 失效或人接管了 | 停下问人，或重新 acquire |
| `ENV_BUSY` | 另一个主体持有 Agent Space | 用 `--wait` 等人交还，不要强抢 |
| `DIALOG_OPEN` | 有弹框没处理 | 用 `acceptDialog` / `dismissDialog` |
| `CDP_BLOCKED` | 用了白名单外的 CDP 域 | 换 `page.evaluate` |
| `SCREENSHOT_REQUIRES_FOCUS` | 旧版后台截图门禁；当前版本不应再出现 | 升级 Warren；不要切前台绕过 |

`WINDOW_NOT_FOCUSED` 已删除。后台输入通过 CDP 焦点仿真完成，不要按旧行为加前台守卫。

## Person / Agent 的 CLI 边界

Agent 的 `exec`、`browser.*`、`net.*` 和默认 `tab.*` 都作用于 Agent Space。

以下命令是人工诊断能力，不要主动使用：

```bash
warren tab list <env> --space=person
warren tab new <env> --space=person <url>
warren tab close <env> --space=person <序号|tabId>
warren env takeover <env>      # 模拟人接管 Agent Space
```

Person Space 的 Tab 操作不需要 lease，但“技术上能调用”不等于 Agent 应该去动它。

## 联调本地站点

```bash
warren env create dev --start-url=http://localhost:3000
warren env start dev
warren env acquire dev
warren exec dev --lease=<id> <<'JS'
await page.goto('http://localhost:3000');
console.log(await page.console());
console.log(await page.network());
console.log(await page.snapshot());
JS
```

页面报错先看 `warren browser console <env>`；接口问题先看
`warren browser network <env>`。

## Chrome 扩展

```bash
warren extension add <env> <解包目录> [--name=<目录名>]
warren extension list <env>
```

只接受解包目录；Electron 不支持 `.crx`。内容脚本能运行，DevTools 面板装不上，
但 React DevTools 的 hook 仍可通过 `page.evaluate` 读取。

## 插件现状

插件已经是独立 npm 包，使用 `package.json#warren`，`apiVersion` 只接受 `"4"`：

```bash
warren plugin install path:<目录>
warren plugin install npm:<包名>[@版本]
warren plugin install git:<仓库>#<ref>
warren plugin update <id>
warren plugin status <id>
```

Whistle 不是 Core 内置能力，而是 `com.warren.whistle` 插件（`runtime: "host"`）。
它负责按环境托管独立实例、规则、预设和代理绑定。

插件的安装、启停和权限变更会影响界面与运行时会话；只做用户要求的操作。

## 命令清单

`warren help` 是命令的权威来源。本文件只记录会影响决策的当前约定。
