---
name: account-manager
description: 使用 Warren 账号管理插件（com.warren.accounts）进行测试与工作站点的账号匹配、零手写选择器自动登录及 TOTP 填充；凭据只经宿主受控通道填入页面，不向 Agent 返回明文。
---

# 账号管理插件（`com.warren.accounts`）

管理测试/工作站点明文账号库，并通过宿主受控通道向 `Agent Space` 页面填入账号、密码、扩展字段与动态 TOTP 验证码。

## 安全与访问边界

1. **Agent 通道无明文返还**：`list` / `match` / `get` 仅返 `usernameHint`、`hasPassword`、`hasTotp`、`extraFieldKeys`；Agent 搜索不会探测明文 `username`（只匹配名称、网址、别名、备注、标签）。
2. **禁止调用 UI 专属方法**：`reveal`、`totpCode` 与 `export` 均仅限 UI 通道（`caller === 'ui'`），Agent 调用返回 `ACCOUNT_REVEAL_UI_ONLY` / `ACCOUNT_TOTP_UI_ONLY` / `ACCOUNT_EXPORT_UI_ONLY`。
3. **Agent-first 域名绑定**：`url` / `urls` / `allowedHosts` 可由 Agent 通过 `update` 直接维护（CLI 与 RPC 均可），不再有 UI-only 门槛；插件界面仍可编辑。
4. **锁定 Agent Space 与按白名单校验**：禁止传 `space: "person"`；账号若由 `url` / `urls` / `allowedHosts` 推导出非空 `allowedDomains`，填充时按名单校验，名单外站点仍报 `PATH_DENIED`（`allowCrossOrigin` 仅插件界面可显式二次确认）。未配任何域名的账号不再被强制拒绝，Agent 可自行补齐域名后登录。

## 标准 AI 登录流程与停止判据

1. **先匹配后填充（优先零选择器路径）**：
   - 运行 `match` 查看按 origin > host > 主域 > 绑定环境排序的候选；若场景清晰可直接执行 `autoFill`。
   - 遇到多账号竞争（`ACCOUNT_AMBIGUOUS`）时，依据返回的 `usernameHint`、`note`、`tags` 选出目标 `id`，改调 `fill`（省略 `fields` 时按已存 `selectors` 或隔离世界 `detectFields` 自动填入）。
2. **处理多步登录、TOTP 与验证码（停止条件）**：
   - **两步登录（`step === "username-only"`）**：带 `"submit": true` 执行首次填充并等跳转至密码页，再调一次 `fill` 自动填入密码。
   - **TOTP（`step === "totp-only"` 或单页含验证码）**：账号已配 `totpSecret`（Base32 或 `otpauth://totp/...`）时由服务端实时计算并直接注入页面，不返回动态码。
   - **人工验证停止条件**：一旦返回体带 `manualVerificationHint` 或 `detectFields` 返回 `hasCaptcha: true`（图形/滑块/扫码），**立即停止自动重试**，将 `manualVerificationHint` 转告用户接管。
3. **复杂页面沉淀选择器**：自动探测不完整时，先用 `detectFields` 获取候选框定位，用精确 `fields` 填入并通过 `saveSelectors` 固化模板供后续复用。

```bash
warren plugin run com.warren.accounts match --env=<envId> --input='{"environmentId":"<envId>"}'
warren plugin run com.warren.accounts autoFill --env=<envId> --input='{"environmentId":"<envId>","submit":true}'
warren plugin run com.warren.accounts fill --env=<envId> --input='{"id":1,"environmentId":"<envId>","submit":true}'
warren plugin run com.warren.accounts detectFields --env=<envId> --input='{"environmentId":"<envId>"}'
warren plugin run com.warren.accounts saveSelectors --input='{"id":1,"selectors":{"username":"#email","password":"#pwd","submit":"button[type=submit]"}}'
```

## 决策型错误恢复与参考

| 错误码 | 恢复动作 |
|---|---|
| `ACCOUNT_NO_MATCH` | 调 `list` 确认账号是否缺少 `url`/`urls`/`allowedHosts`，或新建测试账号 |
| `ACCOUNT_AMBIGUOUS` | 按 `usernameHint` / `note` 选定 `id`，显式传 `id` 调 `fill` / `autoFill` |
| `ACCOUNT_NO_FIELDS` | 先 `detectFields` 或 `warren browser snapshot <env>`，再显式传 `fields` 调 `fill` |
| `PATH_DENIED` | 当前域名不在账号允许列表；核对当前页面，或用 `update` 补齐 `allowedHosts` / `url` |
| `ACCOUNT_EXPORT_UI_ONLY` | 明文导出仅限 UI 通道，请用户在 Warren「账号管理」界面手工备份 |
| `SPACE_FORBIDDEN` / `ENV_NOT_LEASED` | 移除 `space: "person"`；写前确保已 `warren env acquire <envId>` |

- 需要增删改、回收站、强密码生成、批量导入或全量参数详表，读取 [`references/commands.md`](references/commands.md) 或运行 `warren plugin run com.warren.accounts --help`。
