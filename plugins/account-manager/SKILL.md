---
name: account-manager
description: 使用 Warren 账号管理插件（com.warren.accounts）进行测试与非高敏站点的账号匹配、零手写选择器自动登录及 TOTP 填充；高密凭据请改用 warren vault。
---

# 账号管理插件（`com.warren.accounts`）

管理测试/工作站点明文账号库，并通过宿主受控通道向 `Agent Space` 页面填入账号、密码、扩展字段与动态 TOTP 验证码。

## 安全与访问边界

1. **Agent 通道无明文返还**：`list` / `match` / `get` 仅返 `usernameHint`、`hasPassword`、`hasTotp`、`extraFieldKeys`；Agent 搜索不会探测明文 `username`。
2. **禁止调用 UI 专属方法**：`reveal` 与 `totpCode` 限 UI（`caller === 'ui'`），Agent 调用返回 `ACCOUNT_REVEAL_UI_ONLY` / `ACCOUNT_TOTP_UI_ONLY`。
3. **禁止自动化导出全库明文**：`export`（`{"confirm":"plaintext"}`）仅用于人工手工备份，不得将结果输出到对话上下文。
4. **锁定 Agent Space 与非空域名白名单**：禁止传 `space: "person"`；账号必须由 `url` / `urls` / `allowedHosts` 推导出非空 `allowedDomains` 才允许 Agent 填充，未配任何域名的账号会被拦截（`PATH_DENIED`）。

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
| `PATH_DENIED` | 当前域名不在账号允许列表或账号未配域名；核对当前页面或请用户补充域名 |
| `SPACE_FORBIDDEN` / `ENV_NOT_LEASED` | 移除 `space: "person"`；写前确保已 `warren env acquire <envId>` |

- 需要增删改、回收站、强密码生成、批量导入或全量参数详表，读取 [`references/commands.md`](references/commands.md) 或运行 `warren plugin run com.warren.accounts --help`。
