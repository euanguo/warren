# Warren 全仓库代码质量与架构质量改造计划（2026-11-27）

> **状态**：已定稿，待分波次实施  
> **基线**：`main` @ `33fa187`（只读全仓审查产出）  
> **协同前置**：待 `@thread:thr_bfyh6g5v22`（界面交互与视觉缺陷修复 / Vitest 无头 UI 测试迁移）完整收尾后，按本计划自 Wave 0 至 Wave 4 顺序推进，避免与该线程活跃改动的文件发生写冲突。  
> **审查依据**：`code-review-and-quality`、`review-agent`、`interrogate`、`blast-radius`、`tech-debt`、`clean-architecture`、`software-design-philosophy`、`domain-driven-design`、`clean-code`、`typescript-best-practices`、`technical-writing`、`unslop` 及去 Shim 工程原则。

---

## 0. 改造约束与原则

1. **不做功能增强**：专注代码质量、架构边界、类型安全、性能可靠性与文档同步。
2. **改动克制、分波次可验收**：每个 Wave 保持局部可控、不破坏对外产品契约（`apiVersion: "4"`、双 Space 隔离模型、Vault 无 reveal、账号插件本地明文例外、`WindowLayerManager` 5 层 Z-Order、Node ESM 单测无 Electron 运行时约束）。
3. **零 SHIM 层原则**：所有废弃出口、历史路径兼容导出、无用双分支与死代码，**一律在同波次内迁移全部调用方与测试断言后直接删除**，绝不保留向后兼容转发壳或双重实现。

---

## 1. 全仓量化基线

| 维度 | 实测基线 | 主要问题点 |
|---|---|---|
| 源码规模 | 230 文件 / 67,239 LOC | `src/main` 29,492、`src/renderer` 15,619、`plugins/whistle` 9,856、`plugins/account-manager` 6,095、`bin` 3,361 |
| 巨石单文件（>800 行） | 13 个文件 | `plugins/whistle/app.js` (4,935)、`plugins/account-manager/app.js` (4,008)、`plugins/whistle/host.mjs` (2,845)、`bin/warren.mjs` (2,703)、`plugins/account-manager/server.js` (2,087)、`rpc-dispatch.ts` (1,375)、`controller.ts` (1,273)、`actions.ts` (1,272)、`store.ts` (1,027)、`view-coordinator.ts` (963)、`plugins/runtime.ts` (950)、`browser/snapshot.ts` (950)、`overlay-root.tsx` (940) |
| 循环依赖圈（SCC） | 3 个环 | `src/shared/types/{environment,settings,ui}.ts`；`src/main/browser/{click-point,page-helpers,snapshot}.ts`；`src/main/plugins/api/{browser,environment,events,index,net,storage,vault}.ts` |
| 类型绕过 | `as never` 65 处 + `as unknown as` 1 处 | `plugins/api/browser.ts`（18 处）、`rpc-dispatch.ts`（25+ 处）、`page-helpers.ts`/`waits.ts` |
| RPC 契约漂移 | 164 个顶层 case vs 95 个已登记 | `src/main/rpc-methods.ts` 漏掉 **59 个业务 RPC** 与 **10 个 `debug.*`** |
| 死文件（0 inbound） | 14 个渲染文件 + `ops/budget.ts` + `plugins/api.ts` | 4 个旧弹窗文件（444 行）仍留仓库、`ops/budget.ts` 仅被单测引用而生产 0 引用 |

---

## 2. 关键问题汇总（P0 → P3）

### 2.1 P0 阻断级（安全边界 / 跨进程错位 / CI 与打包断链 / 幽灵测试）

1. **Whistle `traffic` 无条件泄露未脱敏请求/响应体**（`plugins/whistle/host.mjs:581-584`）：`normalizeTrafficEntry` 无论是否传 `includeSensitive: true` 均返回 `requestBodyRaw` / `responseBodyRaw`。
2. **Whistle UI Replay 回传 `[REDACTED]`**（`plugins/whistle/app.js:3669-3695` + `host.mjs:2297-2313`）：`TrafficTab` 将脱敏后请求头/体作为重放载荷覆盖原抓包发出。
3. **Account-Manager 跨站静默重试 & 空域名白名单裸奔**（`plugins/account-manager/app.js:3445-3460`、`server.js:822, 1357-1363`、`src/main/browser/fill-secret.ts:35-37`）：
   - `handleFillCurrent` 捕获 `PATH_DENIED` 后未经确认直接以 `allowCrossOrigin: true` 重试；
   - 未配 `url`/`urls`/`allowedHosts` 时 `allowedDomains` 为空，`assertSecretDomain` 直接 `return` 放行，Agent 可向任意站点填密；`deriveAllowedDomains` 还将人类 `displayAliases` 混作域名解析。
4. **Account-Manager Agent 侧 SQL `LIKE` Oracle 探测明文用户名**（`plugins/account-manager/server.js:963-969`）：`listAccounts` 未按 `ctx.caller === 'ui'` 剔除 `username LIKE ?`。
5. **`vault.fill` 原型属性注入 & `vault.add` 入参未清洗**（`src/main/rpc-dispatch.ts:614-640`、`src/main/plugins/api/vault.ts:23`）：`field` 仅静态断言为 `'username' | 'password' | 'token'`，传 `"toString"` 会取出原型方法作密码填充；RPC `vault.add` 缺少字符串清洗与 `vault.added` 事件审计。
6. **休眠唤醒与运行期 `update` 导致 Session 代理与 `trustedCa` 验签分裂 + 独立 Session 缺权限拦截**（`src/main/env/session-factory.ts:75-147`、`src/main/env/lifecycle.ts:299-304`）：`prepareWakeSession` 未重调 `ses.setProxy` 与 `applyTrustedCa`，运行期 `update` 不同步已缓存 Session；`sessionFor` 未设 `setPermissionRequestHandler`。
7. **OOPIF `sessionId` 丢失导致跨渲染进程错位命中**（`src/main/browser/controller.ts:737-751, 786-812, 910-947`、`src/main/browser/page-helpers.ts:45`）：合并 OOPIF 节点时丢失来源 `sessionId`，靠 AX 树反查遇新建/撞号节点时静默操作主文档错误元素。
8. **浏览器内核四处安全边界缺口**：
   - `src/main/browser/ops/diff.ts:499-503`：`diffScreenshots` 写 `outputPath` 绕过 `guardSavePath`，且 `inflateSync` 无 `maxOutputLength`；
   - `src/main/browser/snapshot.ts:520-524, 704-706`：密码脱敏与 DOM 补盲漏同源 `iframe` 与 OOPIF；
   - `src/main/browser/actions.ts:471-473` + `fill-secret.ts:68`：`fillPrepareScript` 将密码明文插值拼进 JS 源码，`fillSecretInto` 未传 `isSecret` 标志导致非 `type="password"` 凭据走 `ACTIVE_READBACK_JS` 回读；
   - `src/main/browser/ops/flow.ts:13-65, 92-106` + `redact.ts:9`：`sanitizeFlowSpec` 漏拦 query 凭据（如 `?token=`）且 `encodeURIComponent('..') === '..'` 留路径穿越；`redact.ts` 漏 `authorization`。
9. **`env.start()` 并发竞态 & 4 份视图状态双源真相**（`src/main/env/lifecycle.ts:317-339`、`src/main/environments.ts:59-170`、`tabs.ts`、`env/view-coordinator.ts`、`ui/devtools-host.ts`）：`start` 3 个 `await` 间无锁/无代次检验；同一视口与可见性同时缓存于 4 个类，靠 40 个闭包互连。
10. **CI macOS 回归 Socket 路径错误 + 打包资产缺失**：
    - `.github/workflows/ci.yml:57` 仍检查 `$HOME/.warren/envd.sock`（实际 `$HOME/.warren/runtime/envd.sock`）；
    - `forge.config.cjs:35` `extraResource` 漏了 `./assets`，导致打包后 `main.ts:198,649` 找不到窗体/托盘图标。
11. **幽灵单测与离线护栏旁路**：
    - `tests/remedy-output-budget.test.ts:9-10` 测试 0 引用的 `ops/budget.ts`，而线上 `bin/output-guard.mjs` 裸奔；
    - `bin/warren.mjs:2386`：`warren browser read --links / --data` 直接 `print()` 绕过 `emitUntrustedText` 净化、长度裁剪与 `--content-boundaries`。

### 2.2 P1 高优先级（契约漂移 / 上下文丢失 / 稳定性 / 泄漏）

1. **三组契约漂移**：
   - `src/preload/preload.ts:18-198` 未绑定 `@shared/types` 的 `EnvApi`，返回值全为 `Promise<any>`，`takeover`/`release` 签名与 `rpc.ts` / `main.ts` 错位，`PopoverOpenOptions`/`PopoverActionEvent` 全是 `Record<string, unknown>`；
   - `src/main/rpc-methods.ts` 遗漏 59 个业务 RPC 及多个参数更新；
   - `packages/plugin-sdk/index.d.ts` 未进 `tsc`，缺失 `shortcut`、`openSettings`、`storage.cookie.*`、`vault.*`、20+ `browser.*`/`net.*` 与全套前端插件类型。
2. **主进程插件调用上下文断裂**：`src/main/plugins/invoker.ts:135` 的 `rpc` 分支漏传 `environmentId`；`src/main/plugins/runtime.ts:792-796` 将 `'activate'` / `undefined` 经 `Number(...)` 转成 `NaN`，丢失上下文。
3. **多窗口同步风暴与 `PopoverHost` 主题/插件双跑**：
   - `src/main/main.ts:376-378, 772-787` 广播过粗触发三窗口连环 `settings()`；
   - `src/renderer/app/popover-root.tsx:361` 内 `PluginPopoverView` 再调 `usePluginState()`，挂起第二套主题同步互相覆盖 `dataset.theme` 并把所有无关插件在 Popover 窗口内执行；
   - `App.tsx:242` `SidebarProvider` 与主窗口 `⌘B` 碰撞并写 cookie；`environment-stage.tsx:213-260, 888` 存在 4-IPC 双发与「存储」Tab 双读 cookies；`overlay-root.tsx` 缺 `<Toaster />` 且 `CommandBarCard` 无错误捕获。
4. **浏览器动作/等待/会话泄漏**：
   - `actions.ts:143, 259` `click`/`hover` 退回外接矩形中心使 `click-point.ts` 失效；`mouse-state.ts` 为进程级全局变量跨环境污染；`fill` 对 `<label>` 跳过 `checkActionable`；`waits.ts` 丢弃 `idleMs` 且与 `actionability.ts` 可见性口径分裂；`session.ts` 缺 `debugger.on('detach')`；`#sendInput` 超时静默成功；`downloadSaveAs` 不处理 `'interrupted'`；`inputCall`/`batch.ts`/`fillSecretInto` 三处重复「后台输入准备」并已漂移。
5. **存储、事件与资源泄漏**：
   - `store.ts`（1,027 行）8 域混杂且多处写操作缺 `tx()`；`domain/environment.ts:193-226` `acquireLease`/`releaseLease` 生产 0 调用；`telemetry.clear(id)` 在 `stop` 时清空持久化表；`db.ts` 遥测表缺 `(tab_id, id)` 索引；
   - `net/interceptor.ts:62-85` `detach()` 仍挂 timer；`rpc.ts:54-64` socket `data` 无串行队列；`popover-host.ts:47,139` `destroy()` 不解绑主窗监听；`downloads.ts`/`ops/diff.ts`/`tabs.ts#favicons` 只增不删。
6. **CLI 与测试/脚本债**：
   - `bin/warren.mjs`（2,703 行）顶层直接执行不可导入单测；`bin/commands.mjs` `SUBS.env` 漏 `hibernate`/`wake`，`BOOLEAN_FLAGS` 漏 `wait`/`headed`/`clear`/`links`/`h` 会吞位置参数；离线 Skill 副本与 `skills/composer.ts` 不一致；`exec` `vm` 超时不限制异步 Promise；
   - `scripts/regress/run-all.sh:104, 123` `sed` 改写 `BATCH FAIL` 为 `PASS` 且末尾 `grep "^FAIL"` 0 失败返 exit 1；`actions.ts`/`controller.ts`/`view-coordinator.ts`/`whistle/host.mjs`/`plugin-runtime.ts` 等高复杂模块缺单测。

### 2.3 P2 / P3（巨石单体、重复、静默 catch、设计系统漂移）

- `whistle`（`app.js` 4,935L / `host.mjs` 2,845L）与 `account-manager`（`app.js` 4,008L / `server.js` 2,087L）后端 `command`/`rpc` 各自包装已漂移、`account-manager` 含 430 行手写加密、`PRAGMA` 绕过 `sql.migrate`、幽灵字段 `frameAwareFill`/`loginProfile`/`expectedUin`；两插件前端 50+ 处 `text-[11px]`/`h-4`/`h-7`/原生控件绕过 `app.ui`。
- 重复模式：DOM 脚本（`safeTag`/`isVisible`/`parentOf`/`describe`/`label`）在 `browser/` 重复 3–7 处；`warrenHome()` 拷贝 4 份；`SECRET_*` 脱敏词表 3 份；`EnvIdentityAvatar` / `PluginBrandGlyph` / 设置元数据 / Popover 锚点采样在渲染层重复 3–8 处。
- 静默 `catch {}` 散落在 `store.ts`、`overlay-host.ts`、`popover-host.ts`、`waits.ts`、`ops/diagnostics.ts`、`whistle/host.mjs`。

---

## 3. 全仓 SHIM / 兼容层 / 死代码彻底清除总表

| 项 | 精确位置 | 处理方式（无 Shim） |
|---|---|---|
| 路径转发壳 | `src/main/plugins/api.ts:1-4` | 4 个测试改引 `./api/index.ts`，整文件删除 |
| 权限二次转出 | `src/main/plugins/package.ts:4-8` | 主进程与测试直引 `src/shared/permissions.ts`，删转出 |
| 类型转发壳 | `src/main/browser/cookies.ts:15-16` | `environments.ts:3` 改引 `shared/types.ts`，删转出 |
| 死领域再导出 | `src/main/environments.ts:5, 579` | 由 `LeaseCoordinator` 直接调用 `domain/environment.ts` 后删再导出 |
| 死类型/死方法 | `controller.ts:125-126, 1273`, `tabs.ts:487-504` | 删 `Target` 别名、悬空注释与 `TabManager.openDevTools` |
| 无 `layers` 分支 | `tabs.ts:423-765`, `input-shield.ts:486-531` | 强制构造传入 `layers`，删所有 `else` 绕层分支 |
| 幽灵输出预算 | `src/main/browser/ops/budget.ts`, `ops/output-guard.ts` 死导出 | 合并为单一共享纯模块供 `bin/output-guard.mjs` 与 `webmcp.ts` 共用，删 `budget.ts` |
| 4 个旧弹窗文件 | `src/renderer/features/environments/{create-environment,edit-environment,create-group,rename}-dialog.tsx` | 0 引用，整组删除 |
| 插件前端死通路 | `plugin-runtime.ts:343-361,436-440,605-638,794-800`, `plugin-surfaces.tsx:62-106` | 删 `app.navigation`、`DeclarativeViewNode`/`DeclarativeSurfaceView`、`window.__WARREN__`、`subPath` |
| 死 IPC 与死 Token | `layout:pageSnapshot`, `net:ruleRemove`; `--rail-*`, `--shell-chrome-row-height` | 从 `main.ts` / `preload.ts` / `rpc.ts` / `theme-tokens.css` 删除 |
| CLI 透传与离线副本 | `bin/warren.mjs:196-198, 57-123, 33-36` | 删 `parseFlags`；统一 `bin/paths.mjs`；离线只做基线校验不写旧格式 stamp |
| 旧 DTO 与幽灵列 | `example-notes/server.js` `toLegacyNote`、`account-manager` `totpConfigured` 及 3 幽灵列 | 删除并同步更新对应单测断言 |
| 过时路径与 1 行壳 | `browser/policy.ts:59-62`（`userData/core`）、`page-helpers.ts:30,99,121`、`doctor.ts` `_store`、`policy.ts` `_kind` | 直接移除并更新调用处 |

---

## 4. 分阶段无 Shim 改造施工路线

### Wave 0 · P0 安全边界、CI/打包与核心竞态止血

- **CI 与打包**：修复 `.github/workflows/ci.yml:57` socket 路径为 `$HOME/.warren/runtime/envd.sock`；`forge.config.cjs:35` `extraResource` 补 `./assets` 并在 `src/main/main.ts` 增加 `assetPath()` 统一开发与打包读取。
- **插件安全边界**：
  - `plugins/whistle/host.mjs` 删除 `requestBodyRaw`/`responseBodyRaw`；合并脱敏规则到 `intents.mjs` 并为 `buildCurlCommand` URL query / `--data-raw` 脱敏；UI Replay 改为传 `reqId` + 修改差量在服务端合并原文；`exportData` 加路径 containment 校验、`bindEnvironment` 校 `storage`、`savePreset`/`deletePreset` 加 SQL 事务、`toggleRule` 补存活校验；
  - `plugins/account-manager` 删除 `app.js:3445-3460` 静默跨站重试，`server.js` 限制 `allowCrossOrigin` 仅 `'ui'`、从 `deriveAllowedDomains` 移除 `displayAliases`、`listAccounts` 非 `'ui'` 剔除 `username LIKE ?`、写接口返回列表禁止透传写入 `input`、`importAccounts` 包事务；`src/main/browser/fill-secret.ts:37` 在 Agent 渠道拒绝空 `allowedDomains` 放行。
- **Vault / Flow / 浏览器安全**：
  - `vault/store.ts` 增加 `ALLOWED_SECRET_FIELDS` 与 `sanitizeCredentialSecret`，统一堵死 `rpc-dispatch.ts` / `api/vault.ts` 原型注入与 `vault.add` 未清洗入参并补 `vault.added` 事件；
  - `ops/diff.ts:499` 加 `guardScreenshotPath` 与 `inflateSync` 64MB 上限；`ops/flow.ts` 复用 `redact.ts`（补 `authorization`）并禁 `..` 路径段；`ops/webmcp.ts` 接入 `redactSecrets` 与超时；`bin/warren.mjs:2386` 让 `--links`/`--data` 过输出护栏。
- **核心竞态与跨进程修复**：
  - `env/session-factory.ts` 抽出 `syncSessionNetwork` 覆盖 `prepareSession` / `prepareWakeSession` / `lifecycle.update`，并为独立 Session 装 `setPermissionRequestHandler`；`env/lifecycle.ts` 给 `start()` 加 `#starting` 去重与 `#epoch` 校验；
  - `plugins/invoker.ts:135` 补 `environmentId`；`plugins/runtime.ts:792` 修复 `activate`/事件上下文 `NaN` 丢失；
  - `net/interceptor.ts:62` `detach()` 停 timer；`rpc.ts:54` socket 读循环加串行队列；
  - `browser/controller.ts` + `page-helpers.ts` + `refs.ts` 全链路保留 `{ backendNodeId, sessionId }`，修复 OOPIF 错位与 `snapshot.ts` 同源/OOPIF 密码脱敏；`actions.ts` 修复 `click`/`hover` 落点、`<label>` 校验、`fillPrepareScript` 移除密码插值、`fillSecretInto` 传 `isSecret`；`mouse-state.ts` 改为 `WeakMap<WebContents, InputState>`；`session.ts` 监听 `debugger.on('detach')`；`#sendInput` 超时改抛 `TIMEOUT`；`downloadSaveAs` 处理 `'interrupted'`。

### Wave 1 · 零 Shim 彻底清除死代码与兼容通道

- 执行第 3 节全部清理清单：删除 `plugins/api.ts`、`ops/budget.ts`、4 个旧弹窗、`app.navigation` / `DeclarativeSurfaceView` / `window.__WARREN__`、`layout:pageSnapshot` / `net:ruleRemove`、`layers` 历史分支、`tabs.openDevTools`、`--rail-*` token、`parseFlags`、旧 DTO 字段与 1 行壳，一次性迁移所有引用方并确保 `npm run check` 全绿。

### Wave 2 · 破除 3 个循环依赖圈 & 建立单源契约

- **3 个 SCC 解环**：
  - `src/shared/types/*`：抽出 `src/shared/types/common.ts`；
  - `src/main/browser/*`：抽出 `errors.ts`、`roles.ts`、`locator.ts`，消除 `page-helpers ↔ snapshot ↔ click-point` 环及对 `ops/` 反向引用；
  - `src/main/plugins/api/*`：抽出 `src/main/plugins/api/types.ts` 叶子文件供各域单向引用。
- **契约单源化**：
  - 合并 `rpc-methods.ts` + `rpc-dispatch.ts` 为按域拆分的单一 `RPC_REGISTRY`（`src/main/rpc/{registry,env,browser,net,storage,plugin,system}.ts`），消除 59+10 方法漂移与 25+ `as never`；抽取 `LeaseCoordinator.withInputContext()` 统一 `inputCall`、`batch` 与 `fillSecretInto`；
  - `src/preload/preload.ts` 导入并绑定 `EnvApi` 类型，抽取 `subscribe()` 包装；`PopoverOpenOptions` / `PopoverActionEvent` 改为可判别联合类型；
  - 补全 `packages/plugin-sdk/index.d.ts` 前后端全部类型，并新增 `tsconfig.check.json` 覆盖 `src/`、`tests/` 与 `packages/plugin-sdk/`；
  - 抽取 `src/main/browser/dom-scripts.ts`（统一 5 个重复 DOM 片段与 `isVisible` 口径）、统一 `redact.ts` 与 `browser/timeout.ts`、对齐 `paths.ts` 与 `bin/paths.mjs`。

### Wave 3 · 适度拆解巨石模块与状态流理顺

- **CLI 拆解**：`bin/warren.mjs`（2,703L）拆为 `<40` 行入口 + `bin/{paths,rpc-client,commands,formatters}.mjs` + `bin/commands/*.mjs`；修复 `SUBS.env` 补 `hibernate`/`wake`、`BOOLEAN_FLAGS` 补齐防吞参数、统一 `withLease`/`parseJsonArg`/`--json` 错误输出，基于命令表自动生成 `help`。
- **主进程与 Store**：`main.ts` 拆出 `ipc-routes.ts` + `plugin-protocol.ts`（带插件目录缓存）；`db.ts` 遥测表补 `(tab_id, id)` 索引；`store.ts` 补齐 `tx()`、移除伪 `async`、改静默 `catch` 为告警日志并按子域拆出仓储；`LeaseCoordinator` 真正消费 `domain/environment.ts` 状态机；`telemetry.clear(id)` 仅在 `remove(id)` 执行，停/休眠保留历史；窗口视图 bounds 单归 `WindowLayerManager`，消除 `environments.ts` 40 回调网格；`popover-host.ts` 清理窗口事件，`downloads.ts` / `ops/diff.ts` / `tabs.ts#favicons` 增加清理与上限。
- **浏览器内核拆分**：`controller.ts`（1,273→~350L）移出 `locator.ts` 并消除 `ops/*` pass-through；`actions.ts` 拆为 `pointer-actions.ts`、`form-actions.ts` 与 `runTargetAction`；`snapshot.ts` 拆出 `screenshot.ts`；`ops/diff.ts` 拆出 `png-codec.ts`；对齐 `batch.ts` 与 `waits.ts` 语义。
- **插件体系与内置插件拆分**：`plugins/runtime.ts`（950L）拆为 `runtime-base.ts` + `runtime-{host,sandbox}.ts`，消除双份 IPC 协议与 JSON 清洗副本；`plugins/whistle`（`host.mjs` / `app.js`）与 `plugins/account-manager`（`server.js` / `app.js`）拆分为零构建多文件 ESM + `lib/`，统一单表同时注册 `commands` 与 `rpc`、改用 `sql.migrate`、替换原生控件与非标尺寸为 `app.ui` + tokens。
- **渲染层理顺（合入 `thr_bfyh6g5v22` 后实施）**：收敛主进程广播原因、消除 `PopoverHost` 第二套 `plugin-store` / 主题覆盖、删除 `SidebarProvider` 冲突、用 `navigation-store` 代替 `CustomEvent + rAF`、按结构拆出 `environment-stage` / `address-bar` / `inspector` / `overlay-root` / `popover-root` / `plugins-panel` 及 `plugin-runtime.ts` 子模块。

### Wave 4 · 测试工程对齐与脚本治理

- 删除 `ops/budget.ts` 后改写 `tests/remedy-output-budget.test.ts` 直接测试共享输出护栏，将 `rpc-gating.test.ts` 与 `whistle-agent-api.test.ts` 从脆弱正则升级为注册表/Mock 行为测试。
- 抽出 `tests/helpers/{plugin-host,fake-cdp}.ts`，补全 `browser/{actions,controller,snapshot,waits}`、`plugins/{installer,lifecycle}`、`whistle/host`、`bin/commands/*` 与 `plugin-runtime` 的高价值单测。
- 修复 `scripts/regress/run-all.sh:104, 123` 退出码反转与吞失败问题，提取 `scripts/regress/lib.sh` 并确保 `plugin.sh` 收尾清理。

---

## 5. README 与配套 Skill 逐文件更新清单

> 所有文档修改须基于最终落地代码逐条核验，保证命令在 `warren help` / `bin/commands.mjs` 与 `warren methods` 中 100% 存在。

| 目标文件 | 核心偏差与更新要点 |
|---|---|
| [README.md](file:///Users/euanguo/Documents/projects/work/warren/README.md) | 全面升级至最新架构：2 层壳 + 5 层原生栈 + 双 Space；右侧 6+N 检查器 & 6+N 设置中心；透明 AI 护盾；CLI v3（`batch`/`read`/`find`/`diff`/`vitals`/`a11y`/`webmcp`/`notes`/`flow`/`methods`/`skills`）；修正 `exec` 全局含 `emitResult`、Whistle 示例删无效 `--env`、Vault 路径 `~/.warren/core/warren.db`、完整 19 项权限表、可强杀子进程 + 30s 超时、CDP 真正边界（禁长驻 `enable`）、最新目录结构与 `npm run check` + 无头分段校验命令 |
| [skills/warren/SKILL.md](file:///Users/euanguo/Documents/projects/work/warren/skills/warren/SKILL.md) & `~/.agents/skills/warren/SKILL.md` | 错误码表补齐 `TARGET_STALE`、`TARGET_NOT_FILLABLE`、`ENV_NOT_RUNNING`、`ENV_NOT_LEASED`、`SPACE_FORBIDDEN`、`PATH_DENIED`、`UNSUPPORTED_PAGE_API`；插件章节补齐 **`warren plugin run`** / **`warren plugin rpc`**、`plugin skill`、`skill-exposure`、`--base-only`/`--plugin`、`skills install\|refresh`；补 `browser open --read`、`env hibernate\|wake\|doctor\|renew`、`flow`/`notes`/`net`、`--` 与 `WARREN_ENV`；精简 UI 地址栏历史；最后运行 `warren skills refresh` 同步全部 agent 目录 |
| [plugins/README.md](file:///Users/euanguo/Documents/projects/work/warren/plugins/README.md) | 补全 `warren.skill` 契约与 32KB 自动注入、8 种 `surfaces` 与清单权限约束、`app.shell`（不含死 `navigation`）、`app.host.environment.activeContext`、`useSettings/useSignal`、`PluginSurfaceProps` 新字段、可强杀子进程与 30s 超时、完整 `host.*`（含 `fillSecret` 4 参签名与 `{ filled, space }`、UI 免 lease、Cookie 受控通道、`events.subscribe`）、多文件 ESM 目录指引及零手写选择器验收示例 |
| [packages/plugin-sdk/README.md](file:///Users/euanguo/Documents/projects/work/warren/packages/plugin-sdk/README.md) & [index.d.ts](file:///Users/euanguo/Documents/projects/work/warren/packages/plugin-sdk/index.d.ts) | 补齐全部前后端 SDK 类型（`shortcut`、`openSettings`、`storage.cookie`、`vault`、`environment`、`browser`/`net`、`PluginAppApi`/`PluginUi`/`PluginRegisterFn`）与作者指引 |
| [plugins/account-manager/SKILL.md](file:///Users/euanguo/Documents/projects/work/warren/plugins/account-manager/SKILL.md) & [README.md](file:///Users/euanguo/Documents/projects/work/warren/plugins/account-manager/README.md) | 修正 `:82` 伪命令 `warren page snapshot` → `warren browser snapshot <env>`；删除虚构错误码 `LEASE_REQUIRED`；补全 `export`、注明 `get` 仅在 `rpc` 暴露、补全命令参数与「空域名账号不允许 Agent 填充」约束；`README.md` 补全 4+1 协同挂载面 |
| [plugins/whistle/SKILL.md](file:///Users/euanguo/Documents/projects/work/warren/plugins/whistle/SKILL.md) & [README.md](file:///Users/euanguo/Documents/projects/work/warren/plugins/whistle/README.md) | 补充 YAML frontmatter；修正 `:16` `entryId` → `reqId`；统一命令前缀；补全 39 个命令紧凑速查表与脱敏范围；`README.md` 补全 7 个挂载面与受控意图组 |
| [docs/README.md](file:///Users/euanguo/Documents/projects/work/warren/docs/README.md) & [docs/HANDOFF.md](file:///Users/euanguo/Documents/projects/work/warren/docs/HANDOFF.md) & [AGENTS.md](file:///Users/euanguo/Documents/projects/work/warren/AGENTS.md) | 更新已落地计划状态并索引本文；修正 `HANDOFF.md` Skill 预算（单文件 32KB）、Toast 位置（`top-center`）、设置中心分节数（6 内置+插件）、`~/.warren/runtime/` 路径、清空失效 §9；同步 `AGENTS.md` 清理命令路径 `~/.warren/runtime/`、目录地图、插件子进程说明、环境变量与 `#181b21`；同步修复 `agent-panel.tsx:14` `warren doctor` → `warren env doctor` |

---

## 6. 全阶段改造完成后的端到端实测验证协议

全部 Wave 与文档同步完成后，按 `AGENTS.md` 清理旧进程与 `~/.warren/runtime/*` 并启动全新编译的 Warren 桌面端，针对真实复杂站点执行一次全能力端到端验证（不留脏测试数据）：

1. **静态与无头全量门禁**：`npm run check`（`oxlint` + `prettier --check` + `tsc --noEmit` + `tsc -p tsconfig.check.json` + 全量 `node --test` + `vitest` + `vite build` 渲染层与 preload 构建）。
2. **环境、代理与 Whistle 2.10.15 联动**：创建/启动隔离环境，经 Whistle 创建/绑定独立实例、开启 HTTPS 根证书验签、用 `quickMock`/`injectFault`/`ruleTest` 验证规则命中与 `traffic` 服务端过滤，确认 `requestBodyRaw` 不泄露且 `replay` / `toCurl` 脱敏与重放正常。
3. **复杂真实站点浏览与操控（双 Space 并发）**：访问真实复杂网站（含动态 SPA、Shadow DOM、iframe 嵌套、跳转/表单交互与媒体），同时在 `Person Space` 与 `Agent Space` 并行验证：
   - `snapshot -i -u` 与稳定 `@N` ref 自愈；
   - `browser read --outline --links --data --content-boundaries`；
   - `browser click` / `fill` / `select` / `check` / `batch --bail` Delta Receipt；
   - `browser diff snapshot`、`vitals`、`a11y`、`react`、`set viewport/device`、`screenshot --annotate`；
   - `telemetry`（console/network 查询，停用重启后历史按预期保留、remove 后彻底清库）；
   - `notes` 站点记忆注入与 `flow steps/save/run` 只读接口重跑（确认 `..` 与敏感参数被拦截）。
4. **凭据与账号管理安全验证**：`vault add`（stdin）与 `vault fill` 确认原型字段（如 `toString`）被拒、域名越界拒填；`account-manager` 验证 `detectFields`/`autoFill`/`fill`、Agent 搜索不泄露明文用户名、空域名账号拒绝 Agent 自动填充。
5. **桌面外壳、原生栈与 Skill 终检**：验证 `debug.layout` 非默认矩形、`OverlayHost` (`⌘K`) / `PopoverHost` / 原生 `DevToolsHost` (`right`/`bottom`/`detach`) / AI 护盾正常渲染无重叠；执行 `warren --skill`、`warren skills status` 与 `warren methods`，确认全部命令与文档、Skill 100% 对齐。
