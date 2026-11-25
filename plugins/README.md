# 插件

插件是一个独立 npm 包。`package.json` 是唯一清单，插件元数据放在 `warren` 字段。

```text
warren-plugin-example/
  package.json       npm 身份 + warren 契约
  server.js          runtime=sandbox 的后端入口
  host.mjs           runtime=host 的后端入口
  app.js             前端 ESM（可选）
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
2. `npm pack`，只接受包内容。
3. 校验 `package.json#warren` 与 `apiVersion: "4"`。
4. 如果有 `dependencies` 且包里没有 `node_modules`，执行
   `npm install --omit=dev --ignore-scripts`。
5. 写入暂存目录并原子替换；启用中的插件更新失败会回滚。

不再读取 `manifest.json`，也不兼容 `apiVersion` 1 / 2 / 3。

## 前端

插件前端是一份普通 ESM，由主进程经 `warren-plugin://<id>/app.js` 供给。React 和宿主组件库由 `register(app)` 注入：

```js
export default function register(app) {
  const { h, React, ui } = app;
  const { Button, Input, Field, FieldLabel, cardSurfaceClass } = ui;
  // ...
}
```

规则：

- 先用 `app.ui` 里的组件，不要手写 chrome。
- token / recipe 从 `cardSurfaceClass`、`controlFieldClass` 和组件默认值来。
- 不写死 hex，不写裸 `rounded-lg` / `h-8`。
- 语义色用 `text-[var(--warning)]` 这类任意值语法。
- 插件只能注册 `package.json#warren.contributes.surfaces` 里声明过的面。

### base-ui 的坑

| radix 写法 | base-ui 写法 | 不换会怎样 |
|---|---|---|
| `<Trigger asChild><div/></Trigger>` | `<Trigger render={<div/>}>` | 类型报错 |
| `<Item onSelect={fn}>` | `<Item onClick={fn}>` | 类型通过，点击无反应 |
| `<Label>` 随便放 | `<Label>` 必须在 `<Group>` 里 | 抛错，整个 React 树被卸载成白屏 |

## 后端

`runtime: "sandbox"`：

- 入口：`warren.server`
- 只有 `ctx.host`，没有 `require` / `process` / `fetch`
- 适合普通 API 操作、SQLite、页面读写

`runtime: "host"`：

- 入口：`warren.host`
- 跑在独立 Node 进程里，有完整 fs / child_process / 第三方依赖
- 仍然只能通过 host API 碰 Warren 的环境与页面
- 安装时必须让用户知道它是全权 Node 代码

两种运行时都不是安全沙箱。权限表、`app.host` 白名单和 `app.rpc` 是契约与误用防护，不是恶意代码隔离。

### 调用方类型：`ctx.caller`

插件的 `rpc` 方法会拿到 `ctx.caller`：

| 来源 | `caller` |
|---|---|
| 插件自己的界面（渲染层 → `plugin:rpc` IPC） | `'ui'` |
| CLI / agent（`warren plugin rpc` → RPC 派发表） | `'agent'` |

默认按 `'agent'` 处理——漏标只会更保守，不会把「只给人看」的通道误开给 agent。
典型用法是账号插件的 `reveal`：只有 `'ui'` 能拿到明文，agent 通道报 `ACCOUNT_REVEAL_UI_ONLY`。

### 秘密进页面：`host.browser.fillSecret`

```js
await host.browser.fillSecret(environmentId, '#password', value);
// → { filled: true }
```

- 权限是 `vault.fill`（confirm 层），语义就是「允许把秘密填进页面」。
- 值只走主进程内部，不回传、不打日志、不进事件。
- 和 RPC 的 `vault.fill` 共用 `src/main/browser/fill-secret.ts`（后台输入准备 + 域名名单）。

### 打码：`host.vault.maskHint`

`vault.maskHint(username)` 返回 Vault 列表同一套打码（首字符 + 域名）。sandbox 插件 import
不了主进程模块，所以规则由宿主提供一份；它只变换调用方传进来的字符串，不读存储，因此不需要权限。


## 数据

```text
<WARREN_HOME>/core/plugins/<id>/       插件包 + node_modules + data.db
```

- `data.db` 是插件自己的 SQLite，迁移只允许追加。
- 卸载会删除整个插件目录、`plugin_values` 和 `plugin_logs`。
- `secret` 设置仍然存 Vault，前端只看到 `configured`。

## 账号管理插件

`plugins/account-manager/` 是一个明确的产品例外：账号和密码**按用户要求明文存储**在插件自己的 `data.db`。

- 不接 Vault。
- 界面固定显示明文存储警告。
- 只用于不重要账号；不要把系统密码或生产高权限凭据放进去。
- **agent 通道永远拿不到明文**：`list` / `get` 只回 `hasPassword` 与 `usernameHint`；
  登录走 `fill`（值在宿主内部进页面，返回体只有字段名）；`reveal` 只对 `caller: 'ui'` 开放；
  `export` 必须 `--input='{"confirm":"plaintext"}'`，且仅供人手工备份。

## 验收

```bash
node bin/warren.mjs plugin install path:plugins/account-manager
node bin/warren.mjs plugin enable com.warren.accounts
node bin/warren.mjs plugin run com.warren.accounts list --json
node bin/warren.mjs plugin run com.warren.accounts create \
  --input='{"name":"测试后台","username":"tester","password":"[REDACTED]","note":"本地 fixture"}'
# list 不带密码（只有 hasPassword / usernameHint）
node bin/warren.mjs plugin rpc com.warren.accounts list --input='{}'
# 登录：按 id 填进页面字段，返回体不含值
node bin/warren.mjs plugin rpc com.warren.accounts fill \
  --input='{"id":1,"environmentId":"<env>","fields":{"username":"#account","password":"input[type=password]"}}'
```
