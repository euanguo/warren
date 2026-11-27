# Warren 插件开发指南

插件是一个独立 npm 包。`package.json` 是唯一清单，插件元数据放在 `warren` 字段（不再读取 `manifest.json`，也不兼容 `apiVersion` 1 / 2 / 3）。完整 TypeScript 契约见 [`@warren/plugin-sdk`](../packages/plugin-sdk/index.d.ts)。

```text
warren-plugin-example/
  package.json       npm 身份 + warren 契约（含 warren.skill 自动注入配置）
  server.js          runtime=sandbox 的后端入口（可拆分只依赖内置 JS）
  host.mjs           runtime=host 的后端入口（独立 Node 进程，可拆分 lib/*.mjs）
  app.js             前端 ESM 入口（可选，可直接 ESM import 同目录下 ui/*.js）
  ui/                前端子模块（零构建，经 warren-plugin://<id>/... 加载）
  SKILL.md           插件专用 Agent 手册（启用后自动索引到 Warren 主 Skill）
```

最小例子：

```json
{
  "name": "warren-plugin-example",
  "version": "0.1.0",
  "description": "示例插件",
  "warren": {
    "id": "com.example.plugin",
    "name": "示例",
    "apiVersion": "4",
    "runtime": "sandbox",
    "server": "server.js",
    "permissions": ["environment.read"],
    "skill": {
      "entry": "SKILL.md",
      "summary": "一句话能力摘要（≤240 字符）",
      "triggers": ["示例", "keyword"]
    },
    "contributes": {
      "commands": [{ "name": "hello", "summary": "打个招呼" }]
    }
  }
}
```

## 安装

```bash
warren plugin install path:plugins/account-manager
warren plugin install npm:warren-plugin-account-manager@^0.1.0
warren plugin install git:https://github.com/you/warren-plugin-account-manager.git#v0.1.0
warren plugin update com.warren.accounts
```

安装流水线：

1. 解析 `path:` / `npm:` / `git:`。
2. `npm pack`，只接受包内容（更新失败时自动回滚，并保留 `data.db*` 运行时数据文件）。
3. 校验 `package.json#warren` 与 `apiVersion: "4"`。
4. 如果有 `dependencies` 且包里没有 `node_modules`，执行 `npm install --omit=dev --ignore-scripts`。
5. 写入暂存目录并原子替换；启停、授权或更新后自动触发 Agent Skill 目录重合成。

## `warren.skill` 与自动注入

启用的插件默认开启 `skillExposed = true`（可通过 `warren plugin skill-exposure <id> on|off` 控制）：

- `entry`：包内 `SKILL.md` 相对路径；若省略，主进程按 `contributes.commands` 与 `rpc` 自动生成兜底手册。
- `summary` / `triggers`：注入主 `warren/SKILL.md` 的 `<!-- warren:enabled-plugins:begin -->` 索引表，完整文档落盘至 `<agent>/skills/warren/plugins/<id>/SKILL.md`。
- `references`：最多 8 个包内相对路径参考文件；单插件总正文受 `32KB`（`MAX_PLUGIN_SKILL_BYTES`）预算上限裁剪，且严禁在 Skill 文本中写入明文秘密。

## 前端：`register(app)` 与 8 种挂载面

插件前端是一份普通 ESM，由主进程经 `warren-plugin://<id>/app.js` 供给，可直接静态拆分并 `import` 同包内 `ui/*.js` 子模块（无需打包构建步骤）。React、组件库与宿主桥接均通过 `register(app)` 注入：

```js
export default function register(app) {
  const { h, React, ui, rpc, host, shell, useSettings, useSignal, surfaces } = app;
  const { Button, Input, Field, FieldLabel, cardSurfaceClass } = ui;

  const envBadge = surfaces.envBadge({ id: 'status', title: '状态', icon: 'Plug' });
  surfaces.inspectorTab({
    id: 'panel',
    title: '面板',
    icon: 'Plug',
    component: ({ pluginId, environmentId, space, url, openPluginPage, openInspectorTab }) =>
      h('div', { className: cardSurfaceClass }, `${pluginId} @ ${environmentId ?? '-'}`),
  });
}
```

### 8 种挂载面（Fail-Closed，必须在 `package.json#warren.contributes.surfaces` 预先声明）

| kind | 落点 | 说明 |
|---|---|---|
| `railPage` | 全局导航栏插件全屏页 | 传 `{ id, title, icon?, path?, component }` |
| `settingsSection` | 设置中心右侧附加分节 | 传 `{ id, title, description?, icon?, component }` |
| `inspectorTab` | 右侧随行工作台抽屉页 | 传 `{ id, title, icon?, component }`，收到当前 `environmentId` / `space` / `url` |
| `envAction` | 侧栏/标题栏环境右键动作菜单（声明式） | 清单声明 `{ kind: "envAction", id, title, command }`，无需前端代码 |
| `envBadge` | 侧栏环境行状态芯片 | 返回 `{ set(envId, { label, tone }), clear() }`，最多 3 字符 |
| `popover` | 地址栏右侧快捷胶囊 & 独立 OS 浮窗 | `props` 含 `closePopover` / `openPluginPage` / `openInspectorTab`，支持 `shortcut` |
| `statusBadge` | 地址栏右侧精简微标（最多显示 3 个，其余折叠） | 传 `{ id, title, icon?, component? }` |
| `commandBarAction` | `⌘K` 命令面板动作项 | 支持执行后端 `command` 或前端 `onTrigger(environmentId)` |

### 前端 API 规范

- `app.shell`（唯一导航/外壳协同通道，**无**历史 `app.navigation`）：`closePopover()`、`resizePopover({ width, height })`、`openPopover(surfaceId, opts)`、`openPage(surfaceId?)`、`openSettings(section?)`、`openInspectorTab(surfaceId?)`、`openTab(envId, url, space?)`、`highlight(envId, selector?, space?)`、`notify(kind, title, description?)`、`openForm(request)`。
- `app.shell.openForm(request)`：用**宿主原生表单浮层**收一组值，能盖在原生网页视图之上（`railPage` / `inspectorTab` / `settingsSection` / `commandBarAction` 面板里的插件 DOM 弹窗会被网页视图盖住）。字段只支持 `text` / `textarea` / `number` / `select` / `switch`，返回 `Record<string, string | number | boolean> | null`（`null` = 取消）。提交是**值级**的：拿到值之后再做写操作，失败自己 `notify('error', …)`，弹窗不会回显服务端错误。独立浮窗（`popover`）调用会被拒绝——那里本来就在主窗之上，继续用自己的内联/DOM 表单。示例：

```js
const values = await app.shell.openForm({
  title: '新建分组',
  submitLabel: '创建',
  source: '我的插件',
  fields: [
    { type: 'text', key: 'name', label: '分组名', required: true, maxLength: 40 },
    { type: 'select', key: 'scope', label: '范围', options: [{ value: 'a', label: '全部' }] },
    { type: 'switch', key: 'notify', label: '创建后通知', initial: true },
  ],
});
if (values) await doCreate(String(values.name));
```
- `app.host`（只读宿主信息，无需声明额外权限，受 `shared/plugin-host-api.ts` 白名单约束）：`environment.list()`、`environment.get(id)`、`environment.activeContext()`、`browser.info(envId, { space? })`。
- `app.ui`：必须复用宿主组件库（见 [`src/renderer/lib/plugin-ui.ts`](../src/renderer/lib/plugin-ui.ts)），禁止写死 hex、裸 `rounded-lg`、`h-8` 或自造 chrome；语义色走 `text-[var(--warning)]` 这类 CSS 变量语法。

### base-ui 的坑

| radix 写法 | base-ui 写法 | 不换会怎样 |
|---|---|---|
| `<Trigger asChild><div/></Trigger>` | `<Trigger render={<div/>}>` | 类型报错 |
| `<Item onSelect={fn}>` | `<Item onClick={fn}>` | 类型通过，点击无反应 |
| `<Label>` 随便放 | `<Label>` 必须在 `<Group>` 里 | 抛错，整个 React 树被卸载成白屏 |

## 后端：`sandbox` / `host` 双运行时与子进程超时

两种运行时**均运行在独立的可强杀子进程**（Electron 下 `utilityProcess.fork`，单测下 `child_process.fork`），每次 `activate` / `command` / `rpc` 默认共享 **`30_000ms` 超时强制击杀**（可通过 `WARREN_PLUGIN_TIMEOUT_MS` 调整，超时报 `PLUGIN_TIMEOUT`）：

- `runtime: "sandbox"`（入口 `warren.server`）：子进程内部在受限 `node:vm` 上下文执行，**无 `require` / `process` / `fs` / `child_process` / 原生 `fetch`**，只有 `ctx.host`；`server.js` 保持单文件 CJS 导出。
- `runtime: "host"`（入口 `warren.host`）：独立 Node ESM 子进程，可用完整 Node API 与原生 `node_modules`，但跨 Warren 环境与页面操作依然通过 `ctx.host` 权限门控；可通过 `lib/*.mjs` 拆分组织逻辑，安装时向用户明确提示为全权 Node 代码。

> 两种运行时都不是 OS 级安全沙箱。权限表、`app.host` 白名单和 `app.rpc` 是契约与误用防护，不是恶意代码隔离，请仅安装受信任插件。

### 调用方身份与双 Space 规则：`ctx.caller`

| 来源 | `ctx.caller` | 控制权与 Space 行为 |
|---|---|---|
| 插件自身 UI（渲染层 `plugin:rpc` IPC） | `'ui'` | 默认跟随当前激活 Space；在 `Person Space` 点击或填充页面免占 Agent lease |
| Agent / CLI（`warren plugin run` / `warren plugin rpc`） | `'agent'` | 强制锁定 `Agent Space`（显式传 `space: 'person'` 报 `SPACE_FORBIDDEN`），写操作惰性申请并释放 `plugin:<id>` lease |

### 核心 `ctx.host` 能力摘要

- **环境管理**：`host.environment.{list, get, update, start, stop}`（`update` 支持 `proxy` / `trustedCa` 传 `null` 清除）。
- **表单探测与零手写填充**：`host.browser.detectLoginFields(envId, { space? })`（在隔离世界识别 `username` / `password` / `totp` / `submit` / 多步登录与验证码状态）、`host.browser.fillSecret(envId, target, value, { space?, allowedDomains?, requireDomains? }) => Promise<{ filled, space }>`（值只在主进程内部进页面；调用方可按需传 `requireDomains`，不再按 caller 强制，Agent-first）。
- **完整页面控制与等待**：`browser.{url, title, info, snapshot, events, highlight, screenshot, navigate, reload, goBack, goForward, click, dblclick, hover, drag, fill, selectOption, focus, press, setInputFiles, openTab, acceptDialog, dismissDialog, console, network, waitFor, waitForSelector, waitForURL, waitForFunction, waitForLoadState, waitForTimeout, waitForEvent}`。
- **Vault 与打码**：`host.vault.{listRefs, fill, maskHint}`（无明文 reveal）。
- **受控 Cookie 搬运（`storage.cookie.port`）**：`host.cookie.{names, copy, import, clear}`（`names` 只返回名称、域与标志，**绝不返回 Cookie 值**；`copy` 在主进程内迁移；`storage.cookie.read` / `write` 永久 `denied`）。
- **事件总线与消息**：`host.events.{emit, subscribe, unsubscribe}`（只读脱敏事件流：`nav.committed`、`lease.changed`、`tab.created`、`tab.activated`、`space.switched`、`env.status`、`net.hit`）、`host.signal.publish`、`host.ui.notify`、`host.log.{debug, info, warn, error}`。
- **存储与设置**：`host.storage.kv.{get, set, delete, list}`、`host.storage.sql.{exec, run, query, migrate}`、`host.settings.get()`。

## 数据与隔离边界

```text
<WARREN_HOME>/core/plugins/<id>/       插件包 + node_modules + data.db
```

- `data.db` 是插件自己的 SQLite，迁移统一通过 `host.storage.sql.migrate([...])` 追加执行。
- 卸载会删除整个插件目录、`plugin_values` 和 `plugin_logs`。
- `secret` 设置存储在 Vault，前端只看到 `configured: boolean`。

### 账号管理插件产品例外

`plugins/account-manager/` 是唯一明确的产品例外：账号、密码、TOTP 密钥与扩展字段**明文存储**在插件自身 `data.db`，不接 Vault，界面固定展示明文警示。**Agent 通道绝不回传明文**：`list`/`match`/`get` 只返回 `hasPassword` / `hasTotp` / `usernameHint`，`reveal` 与 `totpCode` 仅限 `'ui'`，自动填充走隔离世界 `detectFields` + `host.browser.fillSecret`。

## 验收示例（零手写选择器）

```bash
node bin/warren.mjs plugin install path:plugins/account-manager
node bin/warren.mjs plugin enable com.warren.accounts
node bin/warren.mjs plugin run com.warren.accounts list --json
node bin/warren.mjs plugin run com.warren.accounts create \
  --input='{"name":"测试后台","url":"http://127.0.0.1:8899/login.html","username":"tester","password":"[REDACTED]","note":"本地 fixture"}'
# 匹配并返回脱敏结果（只有 hasPassword / usernameHint）
node bin/warren.mjs plugin rpc com.warren.accounts match --input='{"environmentId":"<env>"}'
# 零手写选择器自动探测并填充登录表单
node bin/warren.mjs plugin rpc com.warren.accounts autoFill --input='{"environmentId":"<env>","submit":true}'
```
