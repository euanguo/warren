# 账号管理（`com.warren.accounts`）

Warren 官方插件包，提供站点账号库、智能匹配、零手写选择器自动登录填充与 RFC 6238 动态 TOTP 验证码。

> **明文存储产品例外**：本插件按产品设计将账号、密码、TOTP 密钥及备注**明文存储**在插件目录自己的 SQLite（`data.db`），不经过系统 Vault；界面持续保留明显明文警告并附「前往加密 Vault」入口。仅用于测试或可丢弃账号，切勿存放高权限个人或生产密钥。

## 架构与模块划分

- **后端（`server.js`）**：运行在受限 `sandbox` 子进程；通过统一 `ACCOUNT_OPERATIONS` 注册表同时发布 CLI 命令与前端 RPC（仅 `get` / `reveal` / `totpCode` 仅走 RPC），启动时经 `sql.migrate` 增量建表。
- **前端（`app.js` + `ui/*.js`）**：零构建多文件 ESM，全部控件走 `app.ui` + 宿主 token；拆分为 `ui/shared.js`、`ui/popover.js`、`ui/inspector.js`、`ui/dialogs-page.js`、`ui/detail-editor.js`。

## 5 处协同挂载面

| 挂载面 (`kind`) | `id` | 作用 |
|---|---|---|
| `railPage` | `accounts` | 全屏 3 区主从管理台（分类与标签筛选、账号列表、详情编辑、强密码生成与回收站） |
| `inspectorTab` | `site-accounts` | 右侧随行工作台「账号」Tab（当前页智能匹配、一键填充、表单字段探测与选择器保存） |
| `popover` | `quick-autofill` | 地址栏右侧快捷填充浮窗（快捷键 `⇧⌘L`，支持搜索、跨站二次确认、TOTP 倒计时） |
| `statusBadge` | `match-badge` | 地址栏微标（实时显示当前页面命中账号数） |
| `commandBarAction` | `quick-fill` | `⌘K` 命令面板动作「一键填充当前页账号」（触发 `autoFill`） |

## 安全边界

1. **Agent 通道绝不返回明文**：`list` / `match` / `get` 对 `caller !== 'ui'` 只返回 `usernameHint`、`hasPassword`、`hasTotp`、`extraFieldKeys`；Agent 关键词搜索不会查询明文 `username`。
2. **`reveal` 与 `totpCode` 仅限 UI**：Agent 调用直接拒绝（`ACCOUNT_REVEAL_UI_ONLY` / `ACCOUNT_TOTP_UI_ONLY`）。
3. **强制域白名单与 Agent Space 锁定**：Agent 填充必须由 `url` / `urls` / `allowedHosts` 推导出非空 `allowedDomains`（空域名账号拒绝填充并报 `PATH_DENIED`），且仅可在 `Agent Space` 执行。
4. **明文导出保护**：`export` 仅在显式传入 `{"confirm":"plaintext"}` 时执行，仅供人工备份。
