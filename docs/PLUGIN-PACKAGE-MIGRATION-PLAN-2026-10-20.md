# 插件全量迁移：独立 npm 包 + 账号管理插件

> 状态：已落地（静态门 / 实机安装 / Whistle 内置依赖 / 账号插件 / UI 均验证）
> 日期：2026-10-20
> 目标：把插件从仓库内目录 + `manifest.json` 迁移为独立可发布的 npm 包；删除旧版本兼容层；现有插件全部迁移；新增明文账号管理插件。

## 1. 结论

插件运行时（sandbox / host / 权限 / surface / RPC）保持不变，替换的是**包契约、安装来源和生命周期**。

新契约：

- `package.json` 是唯一清单。插件元数据放在 `warren` 字段。
- 顶层 `name` / `version` / `description` 是 npm 身份；`warren.id` / `warren.name` 是产品身份。
- `apiVersion` 只接受 `4`。删除 `1` / `2` / `3` 兼容。
- `warren.server` 是 sandbox 后端入口；`warren.host` 是 host 运行时入口；`warren.app` 是前端 ESM。删除通用 `entry`。
- 安装来源统一为：
  - `path:<目录>`
  - `npm:<包名>[@版本]`
  - `git:<仓库>#<ref>`
- 插件包必须能通过 `npm pack` 产出；核心只安装 pack 后的内容，避免把开发目录里的 `.git`、构建垃圾和本机状态带进去。
- 运行时依赖必须由插件包自己声明；安装阶段执行 `npm install --omit=dev --ignore-scripts`。
- 不再读取 `manifest.json`、旧 `state.json`、旧 `kv.json`、旧 `settings.json`，不再兼容旧插件包。

## 2. 目标目录

```text
packages/plugin-sdk/                 独立类型包（插件作者构建时使用）
plugins/
  account-manager/                   package.json + server.js + app.js
  example-cookies/
  example-host/
  example-login/
  example-notes/
  whistle/                           package.json + host.mjs + app.js + 依赖 whistle
src/main/plugins/
  package.ts                         package.json#warren 校验
  source.ts                          path / npm / git 解析、npm pack、依赖安装
  host.ts                            安装、更新、启用、回滚、运行
  registry.ts                        只读写 warren.db
  storage.ts                         只读写 warren.db + data.db
  settings.ts                        只读写 warren.db + Vault
```

## 3. 迁移项

### 3.1 包契约

- 新增 `warren` 字段类型与校验。
- 删除 `PluginManifest.entry`，替换为 `server` / `host`。
- 删除死字段 `authProviders`。
- 命令声明只接受对象 `{ name, summary }`，不再接受裸字符串。
- `apiVersion` 只接受 `4`。
- `warren.engines.warren` 继续校验。
- 路径字段统一禁止绝对路径、`..`、盘符。

### 3.2 安装源

- `source.ts` 解析 `path:` / `npm:` / `git:`。
- 三种来源最终都走同一条安装流水线：`npm pack` → 解包 → 校验 → 依赖安装 → 原子替换。
- npm 来源解析到具体版本；git 来源记录 commit；path 来源记录绝对路径。
- 安装记录新增 `source` / `resolved` / `packageName`。
- 新增 `plugin update <id>`：复用记录的 source 重新解析并安装；启用中的插件安装失败必须保留旧版本。
- `npm install` 禁止 lifecycle script，避免安装阶段执行任意代码。

### 3.3 数据层

- `plugins` 表新增 `source` / `resolved` / `package_name`。
- 删除 `state.json`、`kv.json`、`settings.json` 的一次性导入代码。
- 插件代码目录和运行时数据继续共用 `<plugins>/<id>/`，但安装时先写暂存目录，再原子替换。
- 卸载仍然删除整个插件目录和 `plugin_values` / `plugin_logs`。

### 3.4 运行时

- sandbox 从 `warren.server` 加载。
- host 从 `warren.host` 加载。
- 前端从 `warren.app` 加载。
- 插件包的 `node_modules` 保留在安装目录，host 运行时可直接解析自己的依赖。
- Whistle 默认启动插件内置依赖：

```text
process.execPath + ELECTRON_RUN_AS_NODE=1
  + <插件目录>/node_modules/whistle/bin/whistle.js
```

- `w2Path` 设置作为外部 fork 覆盖项，不再要求系统预装 `w2`。

### 3.5 CLI / UI

- `warren plugin install <path|npm|git 源>`。
- `warren plugin update <id>`。
- `plugin create` 生成 `package.json + server.js`。
- `plugin list` 展示 `packageName` / `source` / `resolved`。
- 设置页安装按钮的文案从「选择插件目录」改为「选择插件包目录」。

### 3.6 现有插件迁移

- `example-cookies`：sandbox，`server.js`
- `example-login`：sandbox，`server.js`
- `example-notes`：sandbox，`server.js` + `app.js`
- `example-host`：host，`host.mjs`
- `whistle`：host，`host.mjs` + `app.js`，依赖 `whistle@2.10.12`
- 删除全部 `plugins/*/manifest.json`

## 4. 账号管理插件

插件 id：`com.warren.accounts`。运行时：`sandbox`。存储：插件自己的 `data.db`，**明文**。

数据模型：

```text
accounts(
  id, name, url, username, password, note, tags,
  created_at, updated_at
)
```

功能：

- rail 页面：搜索、列表、新建、编辑、删除。
- 备注：独立多行 `note` 字段，列表里展示摘要，编辑时完整展示。
- 密码：明文保存、可显示/隐藏、可复制；界面明确提示「本地明文存储」。
- 标签：逗号分隔，支持搜索。
- CLI/RPC：`list` / `create` / `update` / `remove` / `get` / `export`。
- 不接入 Vault；账号插件的数据与 Vault 完全分离。

## 5. 验收

1. `rg "manifest\.json|apiVersion: ['\"]2|apiVersion: ['\"]3|state\.json|kv\.json|settings\.json"` 不应命中插件契约代码（扩展 manifest 除外）。
2. 所有插件包能通过 `npm pack --dry-run`。
3. `warren plugin install path:plugins/account-manager` 成功。
4. `warren plugin run com.warren.accounts create ...` 与 `list` 返回明文数据。
5. `warren plugin install path:plugins/whistle` 成功；默认能找到插件内置 `whistle`。
6. 五道强制校验全部通过：

```bash
npm run lint
npm run format:check
npx tsc --noEmit
npm test
node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
```

7. 更新 `docs/HANDOFF.md` 当前状态与 `AGENTS.md` 的插件架构说明。

## 6. 明确不做

- 插件市场、远程 catalog、签名体系。
- 第三方插件供应链审计。
- 账号数据的加密存储（按用户要求明文）。
- 旧插件包自动迁移（明确破坏性变更）。

## 7. 实测记录（2026-10-20）

- `plugin install path:plugins/account-manager`：成功，`com.warren.accounts` 默认 disabled。
- `plugin enable com.warren.accounts`：`running`；CLI `create / list / update / remove / export` 均可用。
- 账号插件 UI：rail 出现「账号」；`[data-slot=account-manager-page]` 与
  `[data-slot=account-plaintext-warning]` 均挂载；备注和密码明文回读。
- `plugin install path:plugins/whistle`：成功；安装目录内存在
  `node_modules/whistle/bin/whistle.js`；`list` 返回 `bundled:...`。
- `plugin run com.warren.whistle fork --input='{"storage":"smoke-1"}'`：真实起实例，
  `version 2.10.12`，端口 8900，`allowMultipleChoice=true`。
- `plugin run com.warren.whistle doctor ...`：`ok=true`，HTTPS capture / HTTP2 /
  multiple choice / root CA 全部通过；随后 stop + remove。
- `plugin update com.warren.whistle`：启用中的 host 插件更新后仍为 `running`，
  内置 `w2` 仍存在。
- 单测：266 条。全量回归中的账号插件断言改为相对数量，避免污染或依赖用户现有账号。
- `scripts/regress/run-all.sh`：**152 PASS / 0 FAIL**（vault 5.7 SKIP），
  包含账号管理页 + 明文警告的 UI 实机断言。
