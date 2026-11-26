# Whistle 代理（`com.warren.whistle`）

Warren 官方插件包，基于内置 `whistle@2.10.15`（`runtime: "host"`），为每个环境托管隔离代理实例与规则/抓包调试工作流。

## 架构与模块划分

- **后端（`host.mjs` + `lib/*.mjs`）**：共享单源 `COMMANDS` 表同时注册 46 个 CLI 命令与前端 RPC；域逻辑拆分在 `lib/{instances,rules-presets,traffic,w2-client,shared}.mjs`，纯规则/意图分析位于 `presets.mjs` / `intents.mjs` / `preflight.mjs` / `agent-api.mjs`。
- **前端（`app.js` + `ui/*.js`）**：零构建多文件 ESM（`ui/{shared,popover,inspector,proxy-page,rules-values-presets,traffic-doctor}.js`），复用宿主 `app.ui` 与主题 token。
- **Node 隔离**：内置 CLI 由桌面端自带的 Node 经 `STARTING_EXEC_PATH` 启动守护进程，不依赖宿主机 PATH 中的 Node；`w2Path` 仅作可选外部 fork 覆盖。

## 7 处协同挂载面

| 挂载面 (`kind`) | `id` | 作用 |
|---|---|---|
| `railPage` | `proxy` | 5 Tab 全屏代理工作台（实例管理、规则与预设、Values、抓包与重放 Diff、受控意图与 4 列健康体检） |
| `inspectorTab` | `env-proxy` | 右侧随行工作台「代理」Tab（当前环境实时抓包过滤、重放 Diff、cURL 导出与规则命中测试） |
| `settingsSection` | `about` | 设置页「Whistle 使用说明」说明分节 |
| `envAction` | `open` | 环境右键/扩展菜单快捷动作「打开代理实例」 |
| `popover` | `quick-proxy` | 地址栏右侧快捷代理控制浮窗（启停、绑定、HTTPS/多选开关、一键清意图与快速 Mock/故障） |
| `statusBadge` | `proxy-badge` | 地址栏右侧代理运行状态微标 |
| `commandBarAction` | `open-bound` | `⌘K` 命令面板动作「打开当前环境 Whistle Web UI」 |

## 受控调试意图组

所有高层调试意图（`quickMock`、`injectFault`、`mapLocal`）均写入隔离受控规则组，绝不覆写用户主规则，可用 `clearIntents` 一键停用清理：

- `warren-mock`（`quickMock`）：自动管理 `warren-mock-*` Values 与响应规则；
- `warren-fault`（`injectFault`）：延迟、限速、状态码与 `disable://cache|encoding`；
- `warren-local`（`mapLocal`）：本地端口、目标 URL 与目录映射。
