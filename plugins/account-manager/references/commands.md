# 账号管理插件命令参考（`com.warren.accounts`）

仅在需要新增/更新账号、管理回收站、批量导入、生成密码或查阅完整 RPC/命令参数时读取本文件；实时帮助也可执行 `warren plugin run com.warren.accounts --help`。

## 全量 19 个操作速查（16 CLI + 3 仅 RPC）

| 命令 | 暴露范围 | 用途 | 关键参数 |
|---|---|---|---|
| `list` | CLI & RPC | 列出/搜索（无明文） | `query`, `tag`, `includeDeleted`, `onlyDeleted`, `sortBy` (`updated`\|`recent`\|`frequent`\|`name`), `pinnedFirst` |
| `get` | **仅 RPC** | 读取单条元数据 | `id` |
| `create` | CLI & RPC | 新增账号 | `name`(必填), `url`, `urls[]`, `username`, `password`, `totpSecret`, `extraFields{}`, `selectors{}`, `allowedHosts[]`, `envIds[]`, `pinned`, `manualVerificationHint`, `note`, `tags` |
| `update` | CLI & RPC | 修改字段（Agent 不可改 `url`/`urls`/`allowedHosts`，报 `ACCOUNT_DOMAIN_BINDING_UI_ONLY`） | `id`(必填) + 任意允许修改的字段 |
| `match` | CLI & RPC | 智能站点匹配 | `url`, `host`, `environmentId`, `query`, `limit` |
| `detectFields` | CLI & RPC | 隔离世界探测登录框 | `environmentId` |
| `fill` | CLI & RPC | 定向填充（可选选择器） | `id`, `environmentId`, `fields?`, `submit?`, `noWaitAfter?` |
| `autoFill` | CLI & RPC | 自动匹配并填充 | `environmentId`, `id?`, `pickBest?`, `submit?`, `fields?` |
| `togglePin` | CLI & RPC | 置顶/取消置顶 | `id`, `pinned?` |
| `saveSelectors` | CLI & RPC | 合并或覆盖选择器模板 | `id`, `selectors`, `replace?` |
| `generatePassword` | CLI & RPC | 生成高强度密码 | `length`(8-128), `uppercase`, `lowercase`, `numbers`, `symbols`, `excludeAmbiguous` |
| `importAccounts` | CLI & RPC | 批量导入 | `content`, `format` (`auto`\|`json`\|`csv`\|`chrome-csv`), `strategy` (`skip`\|`overwrite`\|`duplicate`) |
| `trash` / `restore` / `purge` | CLI & RPC | 软删、恢复与清空回收站 | `id`（`purge` 支持 `all: true`） |
| `remove` | CLI & RPC | 删除（默认彻底删除） | `id`, `soft?`（`true` 走软删） |
| `reveal` / `totpCode` | **仅 UI RPC** | 读取明文密码或动态码 | `id`（Agent 调用报 `ACCOUNT_REVEAL_UI_ONLY` / `ACCOUNT_TOTP_UI_ONLY`） |
| `export` | **仅 UI**（CLI/Agent 拒绝） | 导出明文备份（仅人工在桌面界面执行） | `confirm: "plaintext"`（Agent 调用报 `ACCOUNT_EXPORT_UI_ONLY`） |
