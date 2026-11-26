# 账号管理

Warren 插件 `com.warren.accounts`。

- 站点账号、密码、TOTP（RFC 6238，支持 Base32 与 `otpauth://` URI）、扩展字段、备注、标签与置顶
- 智能站点匹配（`match`）、隔离世界登录表单探测（`detectFields`）与零手写选择器自动填充（`fill` / `autoFill`）
- 密码生成器（`generatePassword`）、Warren JSON / 通用 CSV / Chrome CSV 导入（`importAccounts`）、明文备份导出（`export`）
- 软删除回收站（`trash` / `restore` / `purge`）
- 严格安全边界：Agent 通道只返回 `usernameHint` 与 `hasPassword` / `hasTotp`，`reveal` 与 `totpCode` 仅限插件界面（`caller === 'ui'`）
- 数据保存在插件自己的本地 SQLite（`data.db`）

**按产品要求明文存储，不使用 Vault。** 只放不重要、丢失也无所谓的账号。
