# 插件能力改造方案（P0–P2 全量）

> 状态：**历史施工图（已落地后被 npm 包迁移取代）**。现行契约见
> `docs/PLUGIN-PACKAGE-MIGRATION-PLAN-2026-10-20.md`。
> 日期：2026-10-15
> 目标：把插件从「vm 里的命令函数」改造成「能挂界面、能写库、能起独立进程」的完整插件系统，**P0/P1/P2 一次做完**。

---

## 1. 改造后的整体架构

```
┌─ 渲染层（React / Vite） ────────────────────────────────────────────
│  plugin-runtime.ts    载入插件前端 bundle（warren-plugin://<id>/app.js）
│                       import() → register(app) → 注册面
│  plugin-surfaces.tsx  面注册表 + 每个面外面包 ErrorBoundary
│  App.tsx              rail 目的地 / 插件整页（DOM）/ 隐藏原生视图
│  settings-dialog.tsx  动态分节（内置 plugins|vault + 插件声明）
│  environment-sidebar  envAction（插件往环境菜单里加动作）
│  environment-inspector inspectorTab（插件往检查器里加一页）
└───────────────┬────────────────────────────────────────────────────
                │ IPC（preload 的 envApi.plugin*）
┌───────────────┴─ 主进程（Electron） ───────────────────────────────
│  main.ts            protocol.handle('warren-plugin') / IPC / 广播 signal
│  plugins/host.ts    PluginHost：安装·启停·重载·状态·日志·RPC·信号
│  plugins/manifest.ts 清单 v2 校验（含 contributes 深度校验）
│  plugins/api.ts       host API（权限门控 + 惰性 lease）
│  plugins/runtime.ts   两种运行时适配器
│      ├─ sandbox：vm.createContext（5 个全局 + host API）
│      └─ host   ：utilityProcess.fork + JSON-RPC（全权 Node，摘要校验）
│  plugins/storage.ts   每插件 kv.json + data.db（node:sqlite）
│  plugins/settings.ts  设置描述符；secret 进 Vault，永不回前端
└────────────────────────────────────────────────────────────────────
```

三条不变量（改造后仍然成立）：

1. **权限表只有一个来源**：`src/shared/permissions.ts`。插件声明 → `denied` 降级可见 → `confirm` 未批准要显式 grant。
2. **秘密只留服务端**：插件设置里的 `secret` 走 Vault；前端只拿到「已配置」。
3. **插件不是沙箱**：`sandbox` 运行时挡误用不挡恶意；要全权请用 `runtime: "host"`，安装时明示。

---

## 2. 数据模型改动（要同步 HANDOFF）

| 位置 | 改动 |
|---|---|
| `EnvironmentConfig` | **不动** |
| `PluginManifest` | v2：`runtime` / `engines` / `icon` / `app` / `host`；`contributes` 从 `{authProviders,commands:string[]}` 变成结构化（commands 带 summary、settings 描述符、surfaces、rpc 白名单） |
| `InstalledPlugin` | 加 `runtime` / `status` / `statusDetail` / `contributes` / `settings`(值或"已配置") / `hasApp` / `digest` |
| 插件状态文件 | `<coreDir>/plugins/state.json` **只留** `enabled` / `granted` / `installs`；插件自己的数据搬去 `<coreDir>/plugins/<id>/` |
| 新文件 | `<id>/kv.json`、`<id>/data.db`、`<id>/settings.json`、`<id>/plugin.log` |

---

## 3. 逐文件改动清单

### 3.1 共享层

| 文件 | 改动 |
|---|---|
| `src/shared/permissions.ts` | 新增 `ui.mount`(granted) / `storage.write`(granted) / `rpc.serve`(granted) / `network.fetch`(confirm) |
| `src/shared/types.ts` | 插件 v2 类型：`PluginRuntime` / `PluginStatus` / `PluginSettingDescriptor` / `PluginSurfaceDecl` / `PluginCommandDecl` / `PluginContributes` / `InstalledPlugin` 扩展 / `PluginLogEntry` / `PluginSignal`；`EnvApi` 补 `pluginRpc` / `pluginLogs` / `pluginConfig` / `pluginReload` / `onPluginSignal` |

### 3.2 主进程

| 文件 | 改动 |
|---|---|
| `plugins/manifest.ts` | v2 校验（`runtime` 白名单、`engines.warren` 范围、路径安全、contributes 深度校验）；v1 清单仍可安装（自动补默认值） |
| `plugins/storage.ts`（新） | `kv`（单键 ≤64KB、整库 ≤2MB）+ `db()`（`node:sqlite` `DatabaseSync`，WAL）+ `migrate()`（下标即版本，只追加） |
| `plugins/settings.ts`（新） | 描述符校验 + 取值/设值；`secret` 存 Vault（provider `plugin:<id>`），前端只见 `configured` |
| `plugins/runtime.ts`（新） | `createSandboxRuntime()` / `createHostRuntime()`；统一 `start/invoke/dispose`；host 运行时用 `utilityProcess.fork` + 内联 bootstrap + sha256 摘要校验 |
| `plugins/api.ts`（新） | 从 host.ts 抽出的 host API：`environment` / `browser` / `vault` / `storage` / `settings` / `events` / `ui` / `rpc` / `signal`；写操作**惰性取 lease**（读操作不再抢控制权） |
| `plugins/host.ts` | 重写为编排层：install/enable/disable/uninstall/reload/status/logs/rpc/run；持有每插件的 storage+settings+runtime |
| `rpc.ts` | 新增 `plugin.reload` / `plugin.logs` / `plugin.config.get` / `plugin.config.set` / `plugin.rpc` |
| `main.ts` | `protocol.registerSchemesAsPrivileged(['warren-plugin'])` + `protocol.handle` 供前端 bundle；新增 IPC；插件事件 → 渲染层广播 `plugin:signal` 与 `state:changed` |

### 3.3 渲染层

| 文件 | 改动 |
|---|---|
| `renderer/index.html` | CSP `script-src` 加 `warren-plugin:`（**唯一的安全放松点**） |
| `renderer/lib/plugin-runtime.ts`（新） | 注入 `window.__WARREN__`（React/hooks/rpc/信号）→ `import()` 插件 bundle → 收集面 |
| `renderer/app/plugin-surfaces.tsx`（新） | 面注册表 + `PluginBoundary`（ErrorBoundary 隔离，一个坏插件不白屏） |
| `renderer/app/App.tsx` | 插件 rail 目的地 + 插件整页（DOM）；插件页激活时隐藏原生视图 |
| `renderer/features/settings/settings-dialog.tsx` | 分节动态化：内置两节 + 插件 `settingsSection` |
| `renderer/features/plugins/plugins-panel.tsx` | 展示 runtime/状态/描述符表单/日志入口 |
| `renderer/features/environments/environment-sidebar.tsx` | 环境菜单追加插件的 `envAction` |
| `renderer/features/environments/environment-inspector.tsx` | 追加插件 `inspectorTab` |

### 3.4 CLI / 示例 / 测试

| 文件 | 改动 |
|---|---|
| `bin/warren.mjs` | `plugin status/reload/logs/config`；`plugin run <id> --help` 从清单生成；插件命令输出走各自的 `formatXxxLine` |
| `plugins/example-login/` | 升到 v2：settings 描述符 + commands 摘要 + `envAction` 面 + rpc |
| `plugins/example-notes/`（新） | 演示全量能力：kv + db + rpc + signal + railPage + settingsSection + inspectorTab |
| `tests/plugin-*.test.ts` | 清单 v2、storage（kv 上限 / migrate）、settings（secret 不回前端）、runtime（sandbox 调用） |

---

## 4. 分期与验收（一次做完，按此顺序验证）

### P0 声明 + 数据

```bash
npx tsc --noEmit && npm test
node bin/warren.mjs plugin list --json
node bin/warren.mjs plugin run example-login --help
node bin/warren.mjs plugin status example-notes
node bin/warren.mjs plugin logs example-notes -n 20
ls "$HOME/Library/Application Support/warren/core/plugins/example-notes/"   # kv.json / data.db / plugin.log
# 只读命令不再抢控制权：人持 lease 时 status 成功且 lease 不变
```

### P1 挂载页面

```bash
# rail 出现插件目的地、插件页渲染、设置里出现插件分节、环境菜单出现插件动作
node bin/warren.mjs call debug.rendererEval '{"script":"[...document.querySelectorAll(\"[data-slot=app-rail] button\")].map(b=>b.getAttribute(\"aria-label\"))"}'
# 坏插件不白屏：故意让插件页抛异常，应用其余部分照常
```

### P2 host runtime

```bash
node bin/warren.mjs plugin list --json | grep -o '"runtime":"host"'   # example-notes 的 host 侧能力
node bin/warren.mjs plugin run example-hosty probe --json             # 子进程里 fs/child_process 真的可用
```

---

## 5. 风险与边界

- CSP 多了 `warren-plugin:` 一个 scheme —— 范围只到 scheme，不加 `unsafe-*`。
- 插件前端是**半可信**代码（能碰 DOM 与 `envApi`）。安装对话框必须说清，不许谎称沙箱。
- 插件 bundle 必须用宿主 React（`window.__WARREN__.React`），自带一份 React 会直接崩 hooks。
- `sandbox` 运行时里插件的**异步**代码不受 vm 超时约束（既有边界，写在插件 README 里）。
- `runtime: "host"` 的插件拿到的是真实 Node 能力，摘要校验只在安装/加载时做一次。

---

## 6. 实测结果（2026-10-15，P0–P2 全部落地后）

全部能力都在实机上跑过（`npm start` + `bin/warren.mjs` + `debug.rendererEval`）：

| 能力 | 证据 |
|---|---|
| P0 清单 v2 | `plugin list` 显示 `runtime` / `status` / 界面清单；v1 清单仍可安装（命令字符串数组自动升级） |
| P0 存储 | `<coreDir>/plugins/com.example.notes/` 下 `kv.json` / `data.db` / `settings.json` / `plugin.log`；`migrate` 建表、rpc 写读、`plugin logs` 可读 |
| P0 设置 | `plugin config … set title 我的笔记` → 插件 rpc `stats.title` 立刻变；`set apiKey …` → 前端只看到 `configured=true`，`value=null` |
| P0 生命周期 | 开机自动激活已启用插件；`plugin status/logs/reload`；`plugin run <id> --help` 由清单生成 |
| P0 只读不抢控制权 | 人持 lease 时插件只读命令成功，`env list` 里 owner 仍是 `human` |
| P1 rail 页 | rail 出现「笔记」→ 点击后 `[data-slot=notes-page]` 挂载，显示标题（设置）/ 条数（SQLite） |
| P1 设置分节 | 设置弹窗分节 `['插件','凭据','Notes 使用说明']`，插件组件能取 rpc 数据 |
| P1 检查器页 | 标签 `['事件','快照','控制台','网络','笔记']`，插件页显示当前环境标题/URL |
| P1 环境动作 | 环境右键菜单出现两个插件动作；点「存成笔记」→ `stats.count` 2 → 3 |
| P1 崩溃隔离 | 故意抛异常的插件只坏自己那块（`[data-slot=plugin-surface-error]`），rail 与其它功能照常 |
| P2 host 运行时 | `runtime: "host"` 插件在 `utilityProcess.fork` 子进程里返回真实 `pid / node 24.21.0 / readdirSync / git rev-parse` |

### 6.1 落地时踩到的坑（都写进了代码注释）

1. **`protocol.handle` 必须在第一个渲染进程创建之前注册。** 先 `createWindow()` 再注册，渲染层的请求**根本到不了处理器**（主进程一条日志都没有），症状是 `Failed to fetch dynamically imported module`。现在处理器注册在 `createWindow()` 之前。
2. **自定义 scheme 要 `corsEnabled: true` + 响应带 `access-control-allow-origin`。** 渲染层在 `http://localhost:5173`（开发）/ `file://`（打包），到 `warren-plugin://` 是跨源。
3. **`ctx.host` 必须由运行时注入。** 插件回调拿到的 ctx 是运行时构造的（`{ host, pluginId, ...extra }`），命令与 rpc 两条路径都要带上；漏了就是 `Cannot read properties of undefined (reading 'storage')`。
4. **跨 realm 的返回值不能比原型。** sandbox 里造出来的对象来自另一个 realm，`Object.getPrototypeOf(x) === Object.prototype` 恒为 false，于是所有 rpc 返回值都被判成「类实例」。改成按 `constructor.name === 'Object'` 判断。
5. **`run()` 的 lease 要惰性取。** 现在只有写操作（click / fill / press / vault.fill）才 `acquire`，读操作和导航不碰控制权。
6. **升级新增权限不再拒绝安装。** 之前是 `PLUGIN_PERMISSION_ESCALATION` 直接失败，结果是插件永远升不了级、也没有「重新确认」的入口。现在 `granted` 层自动授予、`confirm` 层留在待批准。
7. **CLI 改的插件状态也要通知渲染层。** `PluginHost` 加了 `onChange`，否则 `warren plugin enable` 之后 rail 与设置分节停在旧清单（实测：新插件启用了但界面上没有入口）。

### 6.2 没做 / 明确的边界

- `warren plugin build` 这类构建工具链**没做**：插件前端就是一个手写的 ESM 文件（示例用 `app.h`，即 `React.createElement`）。要做 JSX/TS 得另外加构建流程。
- 插件前端**不能 import 裸包**（`react` / 自家组件库），只能用 `app.React` / `app.h` + 宿主已加载的 Tailwind 类。
- 分发只支持本地目录（`path`），没有 git/npm/市场，也没有签名校验（只有目录摘要校验）。
- 没有 agent 工具注册表（warren 的工具面就是 CLI），没有 provider / 主题 / 内容脚本注入。
