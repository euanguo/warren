---
name: account-manager
description: 使用 Warren 账号管理插件（com.warren.accounts）进行站点账号匹配、零手写选择器自动登录与 TOTP 填充。
---

# 账号管理插件（`com.warren.accounts`）

用于管理测试/工作站点明文账号库，并通过宿主受控通道向 `Agent Space` 页面安全填充账号、密码、扩展字段与动态 TOTP 验证码。

## 安全边界红线（绝对遵守）

1. **Agent 通道绝不读取明文**：`list`、`match`、`get` 对 Agent 只返回 `usernameHint`、`hasPassword`、`hasTotp`、`extraFieldKeys` 等元数据，不返回明文 `username`、`password`、`totpSecret` 与 `extraFields` 值。
2. **禁止调用 UI 专属方法**：`reveal` 与 `totpCode` 仅限插件 UI（`caller === 'ui'`），Agent 调用会直接被拒（`ACCOUNT_REVEAL_UI_ONLY` / `ACCOUNT_TOTP_UI_ONLY`）。
3. **禁止擅自明文导出**：`export` 仅用于人手工备份（要求 `{"confirm":"plaintext"}`），不得在自动化流程里把全库明文打印进上下文。
4. **严锁 Agent Space 与域名白名单**：Agent 侧填充强制锁定 `Agent Space`（传 `space: "person"` 会报 `SPACE_FORBIDDEN`），且自动校验账号 `url` / `urls` / `allowedHosts` 推导出的 `allowedDomains`，防止跨站钓鱼（不匹配报 `PATH_DENIED`）。

## 标准 AI 登录流程

### 1. 匹配当前页账号

```bash
warren plugin run com.warren.accounts match --env=<envId> --input='{"environmentId":"<envId>"}'
```

- 返回 `{ url, host, matches: [{ account, score, reasons }] }`，按精确 origin > 同 host > 同主域 > 偏好环境 > 置顶/最近使用排序。
- 若多个账号同站竞争且需要人/上下文区分，查看 `account.name`、`account.usernameHint`、`account.note`、`account.tags` 后指定 `id`。

### 2. 自动填充（推荐零手写选择器流）

```bash
warren plugin run com.warren.accounts autoFill --env=<envId> --input='{"environmentId":"<envId>","submit":true}'
```

- 唯一高分匹配时直接完成探测与填充；若多个高分候选竞争且未传 `id` / `pickBest: true`，会报 `ACCOUNT_AMBIGUOUS` 并附带候选列表。
- 已确定 `id` 时，可直接调用 `fill`（省略 `fields` 即按「账号已存 `selectors` 模板 → 隔离世界 `detectLoginFields`」自动填入）：

```bash
warren plugin run com.warren.accounts fill --env=<envId> --input='{"id":1,"environmentId":"<envId>","submit":true}'
```

### 3. 两步登录 / MFA / 人工验证处理

- 若页面是两步登录（`step === "username-only"`）：先 `autoFill` / `fill`（可设 `submit: true`），等待页面跳转到密码页后再执行一次 `fill`，自动识别 `password-only` 并填入密码。
- 若页面出现 TOTP 输入框（`step === "totp-only"` 或单页含验证码）：只要账号配置了 `totpSecret`（支持 Base32 或 `otpauth://totp/...`），`fill` / `autoFill` 会实时计算当前动态码直接注入页面，**绝不回传验证码**。
- 若返回体包含 `manualVerificationHint` 或 `detectFields` 显示 `hasCaptcha: true`（滑块/图形/扫码验证），停止自动重试，把 `manualVerificationHint` 转告用户接管处理。

### 4. 探测与沉淀选择器模板

当复杂页面首次自动探测不完整时：

1. 先调 `detectFields` 查看隔离世界探测到的字段与 `candidates`：
   ```bash
   warren plugin run com.warren.accounts detectFields --env=<envId> --input='{"environmentId":"<envId>"}'
   ```
2. 指定 `fields` 精确填充后，用 `saveSelectors` 把可靠选择器沉淀到该账号：
   ```bash
   warren plugin run com.warren.accounts saveSelectors --input='{"id":1,"selectors":{"username":"#email","password":"#pwd","submit":"button[type=submit]"}}'
   ```

## 命令速查

| 命令 | 用途 | 关键参数 |
|---|---|---|
| `list` | 列出/搜索账号 | `query`, `tag`, `includeDeleted`, `onlyDeleted`, `sortBy` (`updated`\|`recent`\|`frequent`\|`name`), `pinnedFirst` |
| `create` | 新增账号 | `name`(必填), `url`, `urls[]`, `username`, `password`, `totpSecret`, `extraFields{}`, `selectors{}`, `allowedHosts[]`, `envIds[]`, `pinned`, `manualVerificationHint`, `note`, `tags` |
| `update` | 修改账号 | `id`(必填) + 任意待改字段 |
| `match` | 智能站点匹配 | `url`, `host`, `environmentId`, `query`, `limit` |
| `detectFields` | 探测页面登录框 | `environmentId` |
| `fill` | 定向填充账号 | `id`, `environmentId`, `fields?`, `submit?`, `noWaitAfter?` |
| `autoFill` | 自动匹配并填充 | `environmentId`, `id?`, `pickBest?`, `submit?`, `fields?` |
| `togglePin` | 置顶/取消置顶 | `id`, `pinned?` |
| `saveSelectors` | 保存选择器模板 | `id`, `selectors`, `replace?` |
| `generatePassword` | 生成随机密码 | `length`(8-128), `uppercase`, `lowercase`, `numbers`, `symbols`, `excludeAmbiguous` |
| `importAccounts` | 批量导入 | `content`, `format` (`auto`\|`json`\|`csv`\|`chrome-csv`), `strategy` (`skip`\|`overwrite`\|`duplicate`) |
| `trash` / `restore` / `purge` | 回收站生命周期 | `id`（`purge` 支持 `all: true` 清空回收站） |
| `remove` | 删除账号 | `id`, `soft?`（`true` 走软删除，默认彻底删除） |

## 常见错误码与恢复

- `ACCOUNT_NO_MATCH`：当前页无匹配账号 → 用 `list` 确认账号 `url`/`urls`/`allowedHosts` 是否漏配，或新建测试账号。
- `ACCOUNT_AMBIGUOUS`：当前页命中多个高分账号 → 结合 `usernameHint` / `note` 选出目标 `id`，传 `id` 重调 `autoFill` 或 `fill`。
- `ACCOUNT_NO_FIELDS`：未探测到可填字段或传入了空 `fields: {}` → 调 `detectFields` 或 `warren page snapshot` 定位控件后显式传 `fields`。
- `PATH_DENIED`：当前页域名不在账号推导的 `allowedDomains` 白名单内 → 核对是否走错页面，确需授权多域名请让用户更新 `urls` / `allowedHosts`。
- `SPACE_FORBIDDEN`：Agent 尝试写入 `Person Space` → 去掉 `space: "person"`，仅在 `Agent Space` 操作。
- `LEASE_REQUIRED`：环境未持控制租约 → 先 `warren env acquire <envId>` 获取 lease 再执行填充。
