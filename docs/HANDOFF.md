# Warren — 会话交接

> 这份文档承接的是「Electron 内核替换与指纹浏览器架构方案」那条长会话。
> PRD 讲**要做什么**，技术选型讲**为什么这么选**，这份讲**对话里定了什么、现在做到哪、哪里踩过坑**。
> 新开线程接手时先读这份，再按需读另外三份。

---

## 1. 这是什么

面向 AI Agent 的**本地隔离浏览器工作台**。

- 一个 **Environment** = 独立浏览器存储（Cookie / localStorage / 登录态）+ 独立代理出口 + 独立页面实例
- AI 通过 `warren` CLI 操作指定环境，形态参考 `ego-browser`：一次调用可以跑一整段脚本
- 人在桌面端看**同一个环境的同一个页面**，看到 agent 看到的东西，需要时接管
- 同一时刻只有一个主体能写：Agent 持 lease 时，人的输入被原生遮罩挡住

**原点**：用户有多个 worktree，每个要走不同代理、不同身份，想快速看它们在干什么。

---

## 2. 名字

**Warren** = 兔子的地下洞网络：一整片地道，**每个洞有自己的出入口**。
每个环境一个独立身份、一个独立出口，整片洞属于同一个系统。

前身叫 `worktree-profiles` —— **那是错的**。用户在对话里明确纠正过：

> Worktree 不用，不是我们这个应用应该理解的概念，我们理解的概念应该是**隔离的环境以及隔离的代理功能**。

所以代码里**不应该**出现 worktree 概念（早期的 Chrome 看板原型已从仓库移除）。

---

## 3. 已定的决策（重新讨论成本最高，别推翻重来）

### 3.1 不换内核

用户问过：能不能把 Electron 内置的 Chromium 换成 fingerprint-chromium 之类的 patched 内核，然后照常写 Electron 代码？

**不能。** Electron 的 Chromium 是**编译期耦合 + Node 绑定**，第三方 patched 内核无法「直接替换」——要换只能从源码自编译整个 Electron。所以**不换内核**，用 Electron 自带内核 + CDP。

### 3.2 页面用 WebContentsView 渲染，不另起浏览器

右侧页面是**真实的 Electron `WebContentsView`**，agent 通过 `webContents.debugger` 的 CDP 控制**同一个实例**。不是「Electron 里嵌一个 Playwright 浏览器」——那会变成双浏览器栈，内存和复杂度都翻倍。

### 3.3 不做 MCP，做 CLI

用户明确问过「就不能不用 MCP，而是用 CLI 呢？类似 ego-browser」，采纳。

### 3.4 Agent 是「寻址」不是「切换」

每次 CLI 调用都带 `env` 身份（`warren exec <env>`），**没有隐式的「当前环境」**。
左侧列表选中 ≠ 有写权限。原因：隐藏状态在并行调用和上下文压缩时会崩掉。

### 3.5 观察主通道是 a11y 树，不是截图

`browser.snapshot` 返回可访问性树（结构化、文本、便宜）。截图只做次通道。

### 3.6 输入遮罩必须是原生 View

页面本身是 `WebContentsView`，**不参与渲染层的 DOM 层叠**——渲染层里放什么 z-index 都盖不住它。
所以遮罩是一个独立的原生 `WebContentsView`，只拦人。Agent 走 CDP 直发输入事件，不经过遮罩。

### 3.7 遥测用 Electron 原生事件，不碰 CDP

Console 用 `console-message`，Network 用 `webRequest.onCompleted`。
**不碰 CDP 的 `Runtime.enable` / `Network.enable`** —— 省检测面，也不用为了看日志把页面置于调试状态。

### 3.8 被否决的现成方案

竞品形状都不对，别回头再找一遍：

| 项目 | 为什么不要 |
|---|---|
| CloakHQ/CloakBrowser-Manager (982★) | 数据模型是「指纹身份」，我们明确不做指纹 |
| TechQaiser/persona-studio (81★) | 同上 |
| polyackiy/camoufox-profile-manager (69★) | 同上 |
| chentaymane/ManyFaces (19★) | 同上，且无 license |
| Selenoid + Selenoid UI | 已归档（2024-12-17） |
| browserless | SSPL-1.0，且 live viewer 在 Enterprise 版 |
| m1k1o/neko (22.5k★) | 整虚拟桌面流，重 10 倍 |

**结论**：反检测浏览器管理器全是「指纹身份」模型，我们是「隔离环境 + 代理出口」模型，形状不重合。

---

## 4. 硬约束（不是「暂时没做」，是设计边界）

写在 `docs/PRD.md` 里，实现时必须继续遵守：

1. **插件不是安全沙箱**。`node:vm` 挡住的是误用和越权 API 调用，**不是恶意代码，不是安全边界**。UI 上不能含糊，不能谎称沙箱。
   需要全权的插件走 `runtime: "host"`（独立 Node 进程，安装时明示），仍然拿不到 Vault 明文。
1b. **渲染层 CSP 为插件开了一个 scheme**：`script-src 'self' warren-plugin:`（`src/renderer/index.html`）。
   只到 scheme 这一层，**不许加 `unsafe-inline` / `unsafe-eval`**；插件 bundle 只从 `warren-plugin://<id>/` 供给。
2. **Vault 没有 reveal 通道**。对外只有 `vault.list`（返回 `ref` + 打码用户名）和 `vault.fill`（把值填进页面字段），**没有**读明文的通道。
3. **CLI 的 `vault add` 从 stdin 读秘密，不走 argv** —— 否则会出现在 `ps` 和 shell history 里。
4. **代理认证找不到凭据就拒绝认证，不静默放行**。
5. **Cookie 的宽形状权限仍在 `denied` 层**：`storage.cookie.read` / `storage.cookie.write`（拿原始
   sessionData 那种）声明了也不给。**只搬运不返回**的受控通道已经设计并落地（`storage.cookie.port`，
  见 `docs/PLUGIN-CAPABILITY-DESIGN.md` §9）：值只在主进程内部流动，插件只拿得到名字 / 域 /
  过期 / 标志和计数。**新的 cookie 能力加在那条通道上，不要回头开 read / write。**
6. **证书放宽只有一个口子**：`EnvironmentConfig.trustedCa`（PEM 路径）。装了它之后，**只有那个环境**
   的 Session 走 `setCertificateVerifyProc`，而且**只放行由这张 CA 签发的叶子证书**
   （`X509Certificate.verify`，不是比较 issuer、更不是无脑 `callback(0)`）。
   CA 读不出来时**不装钩子**并记一条 `environment.trustedCaUnreadable` 事件，不静默放行。
   每个 tab 的 webContents 还挂同一张 CA 的 `certificate-error` 兜底：Chromium 会把证书失败
   按域名缓存到网络服务里，环境先失败、后 bind 时只 stop/start 不一定能清掉；两层都做同一张
    CA 的验签，不是扩大放行范围。
   见 `docs/WHISTLE-PLUGIN-PLAN.md` §3.3。**不要**把这条放宽挪到别的层（比如系统钥匙串）。
7. **审批策略只能人改**：控制权策略（`app_settings.controlPolicy`）与环境级 `EnvironmentConfig.approval`
   **只有界面那条 IPC 能写**。RPC / CLI 只有 `settings.get`（读），`env.update` 也**故意不读**
   `params.approval` —— agent 能给自己放行的话这道门就等于不存在。加字段时别顺手加进 RPC 白名单。
   见 `docs/APPROVAL-EMBED-MEMORY-PLAN.md` §3.4。
8. **数据根只有一个**：`WARREN_HOME`（默认 `~/.warren`）。应用、插件、whistle 产生的一切都在它下面；
   路径由 `src/main/paths.ts` 的 `warrenHome()` 决定，`bin/warren.mjs` 里那 3 行是它的副本
   （改一处必须改两处，不一致的症状是「应用在跑却报没在跑」）。见 §6「数据统一到一个根」。
9. 凭据测试值一律 `[REDACTED]`，不落明文。

---

## 5. 代码地图

```
src/shared/
  permissions.ts         权限分层单一来源（granted / confirm / denied，共 19 项）
  plugin-host-api.ts     插件前端只读白名单
  popover-sizing.ts      独立浮窗尺寸规格单一来源
  types.ts               纯 export * 导出（只用于模块聚合，新代码可直引分域模块）
  types/                 分域共享类型（common / browser / environment / plugin / rpc / settings / ui）

src/main/
  main.ts                应用入口与窗口创建（IPC 路由与自定义协议已独立拆出）
  ipc-routes.ts          Electron IPC 全部通道注册（与 shared/types/rpc.ts 的 EnvApi 对齐）
  plugin-protocol.ts     warren-plugin:// 协议供给与目录缓存
  system-doctor.ts       系统自检 collectSystemDiagnostics（读取运行态与脱敏健康检查）
  environments.ts        薄协调 Facade：委托 env/ 下四个协作者管理生命周期/Session/Lease/视图
  env/
    session-factory.ts   Session 创建/同步、代理/CA、PermissionRequestHandler、netOps/Telemetry
    lifecycle.ts         Environment 启停/休眠/恢复（带启动并发去重与代次校验）
    lease-coordinator.ts Agent/Human 租约状态、审批判定与 withInputContext()
    view-coordinator.ts  视图切换、窗口显隐、DevTools 停靠/分割与页面交互
  ui/
    layer-order.ts       纯 5 层 Z-Order 模型（below → page → devtools → shield → overlay）
    layer-manager.ts     BaseWindow contentView 层序与 8px 圆角统一控制器
    overlay-host.ts      透明无边框预热顶层窗口（⌘K 命令栏与弹窗，不藏底层网页）
    popover-host.ts      双池弹出宿主（omni-suggest / find-in-page / plugin-popover）
    devtools-host.ts     setDevToolsWebContents 停靠式原生 Chrome DevTools（right / bottom / detach）
    native-menu.ts       网页与插件右键原生 Menu 封装
    window-visibility.ts 多屏坐标归位（仅跨出全部物理屏时回最近屏）与后台焦点仿真判定
  tabs.ts + domain/tabs.ts  标签集合、新窗口分流与 WindowLayerManager 视图挂载
  browser/
    controller.ts        页面门面；其余委托 locator / actions / waits / snapshot / screenshot
    locator.ts           隔离世界 CSS/XPath 与 OOPIF / Closed Shadow 查找
    ctx.ts / errors.ts / roles.ts / dom-scripts.ts / timeout.ts / redact.ts
    page-helpers.ts      CDP 节点与 { backendNodeId, sessionId } 解析、dialog 守卫、坐标换算
    snapshot.ts + screenshot.ts  AX 树（120ms 缓存）+ OOPIF/iframe 脱敏 + 截图与标注
    actions.ts + pointer-actions.ts + form-actions.ts  元素动作、点击点与 SPA 表单引擎
    waits.ts / escape.ts / keymouse.ts / mouse-state.ts（WeakMap 隔离）/ downloads.ts / session.ts
    target.ts / refs.ts / input.ts / matcher.ts / policy.ts / input-synthesis.ts / fill-secret.ts
    ops/                 snapshot-compact / reader / diff(+png-codec) / inspector / batch / flow / remedy / emulation / webmcp / diagnostics
  net/                   ops.ts + rules.ts + interceptor.ts + har.ts
  input-shield.ts        Agent 持 lease 时的透明原生输入遮罩与光标轨迹
  telemetry.ts           Console / Network 持久化采集（warren.db，停/休眠保留历史、remove 才清理）
  rpc.ts                 本地 Unix socket RPC + 串行读队列 + 随机 token；RUNTIME_DIR = ~/.warren/runtime
  rpc/                   按域拆分的单一 RPC_REGISTRY（registry / env / browser / net / storage / plugin / system / types）
  skills/composer.ts + agent-integration.ts  builtin SKILL + 插件 SKILL 自动合成（单插件 32KB 上限，<!-- warren:enabled-plugins:begin/end -->）
  db.ts + store/         唯一 SQLite 连接 + store/{common,environments,memory}.ts + tx()
  paths.ts               数据根（WARREN_HOME，默认 ~/.warren）+ {app,core,runtime,whistle,logs,crashDumps}
  domain/                纯领域逻辑（approval / environment / group / tabs / trusted-ca / user-agent）
  vault/                 safeStorage 凭据库（无 reveal + 原型字段护栏）
  plugins/               host / package / source / installer / lifecycle / invoker / call-context / registry / storage / settings / event-bus / host-read / api/* / runtime-{base,host,sandbox} / worker-process

src/renderer/
  state/                 4 域轻量外置状态库（useSyncExternalStore：navigation / environment / plugin / telemetry）
  lib/theme.ts + plugin-runtime.ts + plugin-ui.ts + plugin-sdk-types.ts + plugin-badges.ts + address-input.ts
  app/                   App.tsx / app-titlebar.tsx / overlay-{root,command-bar,dialogs}.tsx / popover-root.tsx / plugin-surfaces.tsx / error-boundary.tsx
  features/environments/ environment-{sidebar,stage,tabstrip,address-bar,inspector,space-switcher}.tsx + sidebar-* / stage-overlays / address-bar-controls / inspector-panels
  features/plugins/      plugins-panel.tsx / plugin-card.tsx / vault-panel.tsx
  features/settings/     6 内置+插件可检索设置中心（general / browser / agent / approval / vault / plugins / diagnostics）
  components/            ui/ + ui-reference/（只读）+ icons.tsx + identity-glyphs.tsx + action-tooltip.tsx
  theme/                 theme-tokens.css（4 seed，浅色 #ffffff / 深色 #181b21）+ surface.ts

bin/                     warren.mjs (<40L) → cli.mjs + commands.mjs + commands/*.mjs + exec-runtime.mjs + output-guard.mjs + caller.mjs + paths.mjs
plugins/                 account-manager（server.js + ui/*.js）/ whistle（host.mjs + lib/*.mjs + ui/*.js）/ example-*
packages/plugin-sdk/     @warren/plugin-sdk 类型契约（已纳入 tsconfig.check.json）
scripts/                 serve-fixture / serve-shots / ui-promote / test-changed / regress/{lib.sh,*.sh}
tests/                   node:test 单元测试 + Vitest tests/ui/ 无头 UI 套件 + tests/helpers/{plugin-host,fake-cdp}.ts
```

---

## 6. 当前状态（实测过的，不是"应该能跑"）

### 原生 tooltip 层（2026-11-28）

- **问题**：主窗 DOM 永远在原生网页视图之下，侧栏/地址栏的 tooltip 越界到网页区域就被盖住（实测 40px 的轨道图标，tooltip 只露出 14px）。
- **为什么不用 overlay 的 WebContentsView**：Electron 的 `View` / `WebContents` **没有** `setIgnoreMouseEvents`（只有 BaseWindow / BrowserWindow 有），一个盖满内容区的 `View` 会把网页点击全部吃掉。
- **做法**：`src/main/ui/tooltip-host.ts` 起一个独立透明子窗口（`transparent`、`focusable: false`、`setIgnoreMouseEvents(true)`、`showInactive()`），bounds = 主窗 `getContentBounds()`，与主窗内容区同原点，因此主窗的 `getBoundingClientRect()` 可直接当内部 CSS 坐标。首次悬停懒创建（不预热，遵守内存策略），并接入 `MemoryMonitor.reclaimIdle`。
- **渲染**：`?surface=tooltip` → `src/renderer/app/tooltip-root.tsx`（`tooltipPlacement` 纯函数 + `NativeTooltip`）。`ActionTooltip` 仍用 base-ui `Tooltip` 的悬停/焦点状态机与 `sr-only` 内容（保 `aria-describedby`），只在 `onOpenChange` 时把锚点矩形交给主进程。
- **新增 IPC**：`tooltip:show` / `tooltip:hide`（主窗）、`tooltip:current`（三个 surface 都可读），请求由 `src/shared/tooltip-schema.ts` 的 `normalizeTooltipRequest` 在主进程边界校验。
- **坑 1**：透明窗口里的 `body` 会吃到 `bg-frame`，必须给 `html[data-surface='tooltip']` 也关掉背景，否则整块网页区域被画成纯黑。
- **坑 2（只在装机版出现）**：tooltip 窗口的 webContents 不在 shell sender 白名单里，`tooltip:current` 直接报 `unauthorized sender`，浮层永远空白。`isAuthorizedShellSender` 已加 `tooltipHost` 参数。
- **坑 3（贴右边缘）**：绝对定位元素的 shrink-to-fit 只按「left 到容器右边缘」的剩余宽度算，抽屉右角的「关闭工作台面板」tooltip 会被挤成竖排单字。修法是 `w-max` + `tooltip-root.tsx` 的 `clampShift`（`useLayoutEffect` 量完 rect 后用 `el.style.translate` 推回可视区）。
- 打开 `overlay` / `popover` 前会先 `tooltipHost.hide()`：tooltip 是独立子窗口，会画在新开浮层之上。
- 测试：`tests/tooltip-schema.test.ts`、`tests/ui/tooltip-layer.test.tsx`（含 `clampShift` 贴边用例）。

### 插件声明式表单 `shell.openForm`（2026-11-28）

- **契约变更**：`OverlayRequest` 新增 `kind: 'form'`（`src/shared/types/ui.ts`），由 `src/shared/form-schema.ts` 的 `normalizeFormRequest` 在 `overlay:open` 主进程边界上校验/裁剪（字段 12、选项 24、key 唯一、number min/max、select initial 必须在 options 内）；渲染层由 `src/renderer/app/overlay-form.tsx` 的 `FormCard` 画成宿主原生浮层，能盖住原生网页视图。
- **插件 API**：`app.shell.openForm(request) → Promise<values | null>`（`packages/plugin-sdk/index.d.ts` + `src/renderer/lib/plugin-sdk-types.ts`），复用 `ui.mount` 权限，不加新权限；popover 窗口调用直接拒绝（独立 BrowserWindow 在整窗之上）。
- **删除的旧 kind**：`create-group` / `rename` 改走表单（`environment-sidebar.tsx` / `sidebar-menus.ts`）；Whistle 主窗面（inspectorTab、代理工作台）新建实例改走表单，popover 保留自家弹窗。
- 文档：`plugins/README.md` 前端 API 一节；测试 `tests/form-schema.test.ts`、`tests/ui/overlay-form.test.tsx`。

### Agent-first：账号域名绑定与凭据填充不再设 UI 门槛（2026-11-27）


- `plugins/account-manager/server.js` 移除 `update` 的 `ACCOUNT_DOMAIN_BINDING_UI_ONLY` 检查（Agent 可用 CLI/RPC 维护 `url` / `urls` / `allowedHosts`）；`buildFillOptions` 不再对 Agent 强制 `requireDomains=true`；`src/main/plugins/api/browser.ts` 的 `fillSecret` 不再按 `caller` 强制 `requireDomains`。
- **保留的边界**：`reveal` / `totpCode` / `export` 仍仅 UI（AGENTS.md 硬约束：Agent 通道永不返回明文）；`space: "person"` 仍禁；`allowCrossOrigin` 仍仅插件界面可显式跨站；账号配了非空域名白名单时仍按 `hostAllowed` 校验并拒绝名单外站点（原有跨站断言保持成立）。
- **行为变化**：未配置任何域名的账号现在可由 Agent 直接填充（原报 `PATH_DENIED`）；Agent 可自助完成「补域名 → 登录」全流程，不再需要人先去账号管理界面。
- 同步更新：插件 `SKILL.md` / `README.md` / `references/commands.md`、`skills/warren/SKILL.md`、`plugins/README.md`、`src/main/browser/fill-secret.ts` 注释，以及 `tests/account-manager.test.ts` 与 `tests/plugin-dual-space-caller.test.ts` 的 Agent-first 用例。

### 原生 `win.hide()` 后台隐藏 + 多屏位置保持改造（2026-11-27）

彻底移除早期 `-10000, -10000` 离屏停放 + `setOpacity(0)` + `showInactive()` 方案及冗余接口：

- **原生窗口隐藏与多屏保持**：`EnvViewCoordinator.hideWindow()` 统一执行 `win.hide()` + `app.dock?.hide()`（不再挪动窗口坐标、不改 opacity/skipTaskbar/missionControl）；删掉 `backgroundWindow()`、`#backgroundBounds` 及 `debug.backgroundWindow` RPC；`main.ts` 的 `close` 与 `WARREN_BACKGROUND=1` 全部切到 `hideWindow()`。`src/main/ui/window-visibility.ts` 新增 `placeWindowOnItsDisplay()`（只要落在任一物理屏工作区就原位不动，仅在所有屏幕脱离如外接屏拔掉时贴回最近屏，解决外接屏点 Dock 被拖回主屏的问题）与 `shouldEmulateRenderFocus()`。
- **隐藏态保活与全链路截图/动作**：`BrowserController` 新增 `clearEmulatedFocus()` 并在 `did-navigate` 上保持隐藏态焦点仿真；`hideWindow()` / `win.on('hide')` / 隐藏态切环境或切标签自动补 `Emulation.setFocusEmulationEnabled(true)`（窗口回归前台聚焦后关闭仿真以恢复真实失焦感知）；`EnvViewCoordinator.ensureRenderFocus()` + `browser.screenshot` 补齐隐藏态及后台截图的帧率唤醒与临时视口。
- **验证**：`npm run check` 全绿，并以隔离 `WARREN_HOME` 启动开发态真机完成外接屏坐标隐藏→隐藏态点击/输入/双路截图→非抢焦点恢复同位实测。

### 全仓库零 Shim 代码质量与架构质量改造（Waves 0 → 4，2026-11-27）

施工图见 `docs/CODE-ARCHITECTURE-QUALITY-PLAN-2026-11-27.md`，全面实施「零 Shim 层、破除 SCC 循环依赖、拆解巨石模块、收敛单源契约、对齐测试与脚本」5 波次改造并全量通过 `npm run check` & `npx tsc -p tsconfig.check.json`：

- **Wave 0 — P0 安全边界、竞态止血与 CI/打包**：
  - 修复 CI macOS 回归 socket 探测路径（`$HOME/.warren/runtime/envd.sock`）、`forge.config.cjs` `extraResource` 补入 `./assets` 与 `main.ts#assetPath()`；
  - `plugins/whistle` 移除未脱敏 `requestBodyRaw`/`responseBodyRaw`、增强 `toCurl` query/body 脱敏、UI Replay 改传 `reqId` 在服务端合并原载荷、补充规则/预设 SQL 事务与存活校验；
  - `plugins/account-manager` 禁止 UI `PATH_DENIED` 自动跨站重试、`displayAliases` 不混入允许域名、Agent 列表查询禁止 `username LIKE ?` Oracle、`browser/fill-secret.ts` 强制 Agent 通道拒绝空域名账号；
  - `vault/store.ts` 增加 `ALLOWED_SECRET_FIELDS` 与入参清洗；`browser/ops/diff.ts` 增加 `guardScreenshotPath` 与 `inflateSync` 64MB 上限；`ops/flow.ts` 复用 `redact.ts`（含 `authorization`）并拒绝 `..`；`ops/webmcp.ts` 接入脱敏与超时；`browser/read --links/--data` 统一经 `bin/output-guard.mjs`；
  - `env/session-factory.ts` 统一 `syncSessionNetwork` 覆盖启动/唤醒/运行期更新并补充 `setPermissionRequestHandler`；`env/lifecycle.ts` 加 `#starting` 与 `#epoch` 并发防重；全链路保留 `{ backendNodeId, sessionId }` 修复 OOPIF 错位；`mouse-state.ts` 改 `WeakMap<WebContents, InputState>` 消除跨环境污染；`fillPrepareScript` 消除明文插值，`session.ts` 监听 `debugger.on('detach')`。
- **Wave 1 — 零 Shim 清除死代码**：删除 `plugins/api.ts`、`plugins/package.ts` 权限再导出、`browser/cookies.ts` 类型转出、`browser/ops/budget.ts`、4 个已弃用弹窗文件、`app.navigation` / `DeclarativeSurfaceView` / `window.__WARREN__`、`layout:pageSnapshot` / `net:ruleRemove`、`layers` 历史 else 分支、`tabs.openDevTools`、`--rail-*` 死 token、`parseFlags`、遗留 `state:changed` 广播与 `SidebarProvider` 冗余快捷键。
- **Wave 2 — 3 个 SCC 解环与单源契约**：
  - 解开 `src/shared/types/common.ts`、`src/main/browser/{errors,roles,locator}.ts`、`src/main/plugins/api/types.ts` 三个循环依赖圈；
  - 收敛单一 `RPC_REGISTRY`（`src/main/rpc/{registry,env,browser,net,storage,plugin,system}.ts`），补齐此前漏登的 59 项业务 RPC 与 `debug.*` 方法；`LeaseCoordinator.withInputContext()` 统一三处后台输入准备；
  - `src/preload/preload.ts` 严格绑定 `@shared/types` 的 `EnvApi`；`PopoverOpenOptions` / `PopoverActionEvent` 改为可判别联合类型；补全 `packages/plugin-sdk/index.d.ts` 并纳入 `tsconfig.check.json` 类型检查；抽取共享 `dom-scripts.ts`、`browser/timeout.ts` 与 `bin/paths.mjs`。
- **Wave 3 — 适度拆解巨石与理顺渲染层**：
  - CLI 拆为 `<40` 行 `bin/warren.mjs` + `bin/{cli,paths,rpc-client,commands,formatters}.mjs` + `bin/commands/*.mjs`；修正 `SUBS.env` 与 `BOOLEAN_FLAGS`，命令帮助由注册表自动合成；
  - 主进程拆出 `ipc-routes.ts`、`plugin-protocol.ts`（带目录缓存）、`store/{common,environments,memory}.ts`（带 `tx()`）、`LeaseCoordinator` 复用 `domain/environment.ts`、`WindowLayerManager` 单归视图 `bounds`、`telemetry.clear(id)` 仅在 `remove` 时清空；
  - `controller.ts` / `actions.ts`（`pointer-actions` + `form-actions`）/ `snapshot.ts`（+ `screenshot.ts`）/ `diff.ts`（+ `png-codec.ts`）/ `plugins/runtime-{base,host,sandbox}.ts`（共享 child-process IPC 与 `30_000ms` 超时强杀，修复 `plugins/whistle/lib/w2-client.mjs` 与 `lib/instances.mjs` 导入）；
  - 双内置插件拆分为 `plugins/whistle/{host.mjs,lib/*.mjs,ui/*.js}` 与 `plugins/account-manager/{server.js,ui/*.js}`；
  - 渲染层拆出 `lib/{plugin-ui,plugin-sdk-types}.ts`、以 `navigation-store` 替代 `CustomEvent + rAF`、消除 `PopoverHost` 第二套主题同步、抽取 `<EnvIdentityAvatar>` / `<PluginBrandGlyph>` 并拆解 `overlay-root` / `environment-stage` / `address-bar` / `inspector` / `plugin-card`。
- **Wave 4 — 测试与脚本对齐**：新增 `tests/helpers/{plugin-host,fake-cdp}.ts`、`plugins-lifecycle-installer.test.ts`、`bin-cli-commands.test.ts`、`browser-actions-and-waits.test.ts`，改写行为级 `whistle-agent-api.test.ts` 与 `remedy-output-budget.test.ts`，修复 `scripts/regress/{run-all,plugin}.sh` 并抽出 `scripts/regress/lib.sh`。

### 外壳微立体质感、身份微彩与交互减负改造（2026-11-26 / 27，分支 `feat/shell-layout-interaction`）

施工图见 `docs/SHELL-VISUAL-INTERACTION-REFINEMENT-PLAN-2026-11-26.md`（同步最新 `main` 后分 5 个阶段完整落地并经 3 轮 16 态真机盲评自循环清零）：

- **Phase 1 — 交互减负与死胡同修复（Module A）**：
  - `src/renderer/lib/plugin-runtime.ts` 与插件生态 2.0 `app.shell` 合流，统一提供受控 `openPage` / `openSettings(section)` / `openInspectorTab` / `openPopover` / `openTab` / `highlight` / `notify`（兼容主窗与独立 `PopoverHost` 子窗，`app.navigation` 保持向后兼容别名）；
  - 移除遮挡右上按钮的 DevTools 互斥 Toast，改用舞台上方 32px 内联 `<output data-slot="panel-exclusivity-bar">`（内置一键「改用底部停靠并行查看」与频次衰减逻辑）；全局 `<Toaster>` 保持在 `top-center` 顶栏安全区（避免被原生 `WebContentsView` 遮挡）并随 `useResolvedTheme()` 动态同步深/浅主题；
  - 瘦身地址栏：砍掉易与 AI 撞车的 `✨` 图标，URL 拆层高亮 + 静息可见内嵌 `copy-url-button`（1.5s 绿勾就地反馈），低频项折叠进 `⋯` 菜单，右侧保留精简的插件快捷微标槽 + `⋯` / `</>` / `◫`；顶栏命令栏触发器升级为 `[🔍 ⌘K]`，环境胶囊补齐 `ChevronDown` 与焦点环，全量图标按钮补齐 `aria-label` 与 `ActionTooltip`；
  - 工作台抽屉标签栏新增悬浮渐隐溢出步进器 + 内置/插件竖向分隔线 + 分组「全部工作台面板」下拉菜单；事件流新增角色/关键词筛选条、点击展开原文与全中文化人类可读摘要；侧栏环境行统一 2 行高信噪比布局、常驻实心圆角方块 `Stop` 图标与运行状态对齐。
- **Phase 2 — 精密微立体纵深与深/浅 AA 对比度重校准（Module B）**：
  - 重建 `theme-tokens.css` 4 层微冷深炭阶梯（`#111317` under → `#15181e` drawer → `#181b21` surface → `#20242d` elevated，`#0e1015` recessed）与 3 层冷银白浅色阶梯（`#e9edf3` / `#f4f6fa` / `#ffffff`），拆分 `hover` 与 `selected`（另设不透明 `--surface-selected-solid` 消除状态点镂空环二次透明叠加），统一品牌靛蓝主色（`#5b8cff` / `#3b5bdb`），补齐真实多层阴影与顶沿高光；18/18 组深浅 WCAG 2.1 对比度校验全通过；
  - 区分 `Button` `outline` 与 `secondary` 变体，修复 `Tabs`/`Switch` `border-0` 导致的键盘焦点隐形缺陷，消除全部 `text-[10px]`，并同步更新 `docs/ui-design-language.md`。
- **Phase 3 — 身份与插件微彩系统（Module C）**：
  - 新增 `src/renderer/lib/env-identity.ts`（FNV-1a + Murmur3 雪崩哈希映射 12 组预调谐色相）与 `src/renderer/lib/plugin-brand.ts`（Whistle 青 `192` / 账号琥珀 `36` 统一 `User` 图标以与 `Key` 加密 Vault 解耦 / 记忆紫 `274`），落地于侧栏行、环境胶囊、命令面板、全局导航、工作台标签与插件设置项；修正 `example-login` 错写图标名 `KeyRound` → `Key`，统一 `actorClass.human` 为语义绿；为停机舞台 `WarrenMark` 增加无硬边柔和光晕磨砂底座与完整默认页摘要胶囊。
- **Phase 4 — 微交互手感与高辨识 AI 护盾（Module D）**：
  - 取消按钮 `active:translate-y-0`、补全列表行 140ms 过渡与 `prefers-reduced-motion`；为 `SpaceSwitcher` 与 `global-nav` 实现基于 `useLayoutEffect` + `ResizeObserver` 的 200ms GPU 滑动指示器；
  - 升级 `src/main/input-shield.ts` 至 `8px` 圆角、深/浅双色高对比靛蓝/青蓝光学环与顶部扫光、去重后的纯实时遥测右上角磨砂芯片（仅活跃态展示，自动左避让）、外扩防撞色目标锚框及避字右下角 AI 光标，并同步全原生 `WebContentsView` `8px` 圆角。
- **Phase 5 — 栅栏背面清理与诚实真机闭环（Module E）**：
  - 清除 Cookie 面板内部文档 `§9` 泄露，升级 `NetRulesPanel` 可复制 CLI 空态；设置页正文居中 `max-w-3xl`、升级全宽 `ThemePreviewThumb` 迷你窗预览并修正 `WARREN_HOME` 信息层级；命令面板 `⌘K` 重构为带分组头、环境色标芯片、唯一行高亮、`<Kbd>` 快捷键与底部图例栏；
  - 3 轮 16 态窗口级真机像素 ROI 校验 **16/16 PASS**，盲评 `9.3–9.7 / 10`（0 P0 / 0 P1），后续真实网站全量实机截图统一归档于 `docs/screenshots/`。

### 插件生态 2.0：双业务插件全栈重构 + 人类一键填充 + 自动插件 Skill 注入（2026-11-27，合入自 `feat/plugin-ecosystem-2`）

完整方案与分期架构见 `docs/PLUGIN-ECOSYSTEM-2.0-PLAN.md`：

- **Phase 1A & 1B — 宿主底座、自动插件 Skill 注入与多面前端扩展**：
  - **双空间与 `caller` 透传**：`PluginHost` / `api.ts` / `rpc-dispatch.ts` 完整贯通 `caller: 'ui' | 'agent'` 与 `space: 'person' | 'agent'`；Person Space 下人类点击一键填充直达页面无需抢占 Agent 租约，Agent 通道仍走租约与审批护栏；
  - **隔离世界表单探测**：`src/main/browser/page-helpers.ts` & `controller.ts` 新增隔离世界 `detectLoginFields`（零页面污染，识别账号/密码/TOTP/提交按钮与多步登录/验证码状态，支持 `warren browser detect-login` 与宿主插件 API）；同步改用品牌蓝框高亮 `HIGHLIGHT` 避开表单报错红框误判；
  - **插件 Skill 自动感知与注入**：`package.json#warren.skill` 契约 + `src/main/skills/composer.ts` + `agent-integration.ts` 实现启停/授权/安装/卸载插件时自动拼接 `<!-- warren:enabled-plugins:begin/end -->` 区块并刷新外部 Agent Skill 文件（单插件 10KB / 总量 32KB 预算截断，零明文凭据边界）；新增 `warren --skill` 动态合入、`warren plugin skill [id]`、`plugins.skill` / `plugins.setSkillExposed` RPC 与设置页开关/预览弹窗；
  - **多面协同宿主与 Tailwind 扫描**：`popover-root.tsx` 新增 `plugin-popover` 独立 OS 浮窗路由（零双边框、安全焦点管理），地址栏 Row 2 挂载与微立体顶栏一致的插件快捷微标槽（`popover` + `statusBadge`，超过 3 项自动折叠入 `⋯`），`⌘K` 命令栏自动聚合插件 `commandBarAction` / 浮窗 / 工作台 / 全屏页，`globals.css` 新增 `@source '../../plugins/**/*.js'` 编译插件内全部 Tailwind v4 工具类（全局 `<Toaster>` 维持在 `top-center` 顶栏安全带防止被原生视图遮挡）。
- **Phase 2A & 2B — `com.warren.accounts`（账号管理插件重构）**：
  - **后端升级（`server.js` + `SKILL.md`）**：幂等 SQLite 迁移（激活 6 个已有扩展列并追加 10 个新列含 `totp_secret`/`urls`/`extra_fields`/`selectors`/`allowed_hosts`/`env_ids`/`pinned`/`use_count`/`last_used_at`/`deleted_at`）；纯 JS RFC 6238 TOTP 动态码计算；站点/域名/别名/环境绑定加权智能匹配 `match`；跨源防钓鱼校验；严格 `ctx.caller` 安全边界（`agent` 永不返回明文密码/TOTP/用户名，`reveal`/`totpCode` 仅限 `'ui'`）；新增 `autoFill`、`detectFields`、`generatePassword`、`togglePin`、`restore`/`purge`、v2 JSON/CSV 导入导出及 6.1KB 中文 `SKILL.md`；
  - **4 面协同 UI（`app.js` + `package.json`）**：地址栏匹配数微标（`match-badge`）+ `⇧⌘L` 一键填充快捷浮窗（搜索/键盘导航/一键填充/填充并登录/跨站二次确认/TOTP 实时倒计时/内联快建）+ 右侧随行工作台（匹配填充 + 登录框探测 + 蓝色高亮定位 + 存为选择器模板）+ 全屏 3 区主从分栏管理台（视图与标签筛选、自适应多行账号卡片、完整详情与编辑器、内置强密码生成器，保留 `data-slot="account-manager-page"` 与带「前往加密 Vault」直达入口的 `data-slot="account-plaintext-warning"` 明文警示，统一琥珀 `User` 品牌图标与加密 Vault `Key` 解耦）。
- **Phase 3A & 3B — `com.warren.whistle`（升级 `whistle@2.10.15` 全栈重构）**：
  - **后端升级（`host.mjs` / `agent-api.mjs` / `intents.mjs` / `SKILL.md`）**：内置 Whistle 升级至 `2.10.15`；修复官方 Agent API 平铺无点方法路由（`isEnabledHTTPS`/`setEnableHTTPS`/`getRootCA`/`createFile`/`getFile`/`createUrl`）；新增 Values 完整 CRUD、受控意图原语（`quickMock`/`injectFault` 含 `disable://encoding`/`mapLocal`/`clearIntents`，写入隔离受控组 `warren-mock`/`warren-fault`/`warren-local`）、`ruleTest` 规则命中诊断、`traffic` 服务端过滤与 timings/matchedRules、`replay` 改参重放与结构化 `diffResponses`、`toCurl` 脱敏命令、`clearDnsCache`、`captureLink`（`#network?dataUrl=...`）及 6.8KB 中文 `SKILL.md`；
  - **多面协同 UI（`app.js` + `package.json`）**：地址栏运行态微标（`proxy-badge`）+ 快捷代理控制浮窗（启停/绑定/HTTPS 与全局开关/一键清空临时调试/快捷 Mock 与故障注入）+ 右侧随行抓包与规则命中诊断工作台（支持实时抓包、重放 Diff、脱敏 cURL、规则命中测试）+ 全屏 5 Tab 专业工作台（规则组编辑与 Diff、Values 编辑器、抓包流与改参重放、预设模板、受控意图三卡与 Doctor 4 列健康体检）。

### 外壳布局、交互重整与 AI 操作蒙层（2026-11-26，分支 `feat/shell-layout-interaction`）

施工图见 `docs/SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md`（不改 `components/ui/` 组件与色板 Token，专注调准外壳结构、交互流转与 AI 蒙层动画）：

- **Phase 1 — 两层浏览器壳与全局视图保活**：移除常驻 `AppRail`，将原 3 层顶栏压为 2 层（`--shell-top-row-height: 40px` + `--shell-address-row-height: 40px`）；Row 1 环境模式集成侧栏切换（`⌘B`）、当前环境胶囊（支持点击/右键原生环境菜单）、`我的 | Agent` Space 切换器、标签条、**仅在 `Agent` 空间出现的上下文控制权胶囊**、`⌘K` / 扩展全局页菜单 / 设置；进入全局设置或插件全屏页时 Row 1 切换为纯全局导航条（`← 返回环境` + `设置` / 各插件 `railPage`），底层侧栏与舞台常驻不卸载（`inert` 覆层隔离），切回零重建。
- **Phase 2 — 地址栏分工、未启动 CTA 与紧凑侧栏**：合并侧栏搜索框与 `+` 新建按钮到单行；停机环境选中后舞台中央直接提供 `启动「<env>」`（支持 `Enter` 快捷键与双击环境行启动），地址栏支持停机态输入 URL 回车自动先启动后打开；地址栏右侧接入 `registry.popovers` 与随页工作台入口。
- **Phase 3 — 右侧智能互斥与插件随行面板**：新增 `src/renderer/state/workbench-layout.ts`（`shouldExcludeRightPanels`），当 DevTools 为右侧停靠且舞台较窄（`< 1120px` 或网页剩余宽 `< 520px`）时与 Warren 工作台抽屉自动互斥，`bottom` / `detach` 模式自由并存；Whistle 与账号管理插件新增随页 `inspectorTab`（保留全屏 `railPage` 与明文安全警示 `data-slot="account-plaintext-warning"`）。
- **Phase 4 — AI 透明蒙层与实时动作轨迹**：升级 `src/main/input-shield.ts` 与 `LeaseCoordinator`，区分 `owner === 'agent'`（四边呼吸光晕、顶部轻流光、中心 100% 通透）与 `owner === 'none'`（静默灰边无动画）；取消底部常驻黑药丸遮挡页面按钮，改为误点时于指针旁弹出 1.8s 轻提示；经 `PageContext.onVisualAction` 把 `actions.ts` / `keymouse.ts` 缩放换算后的视口坐标/控件框推给 `'shield'` 绘制阻尼虚拟光标、目标锚框与点击波纹（严禁携带输入明文）。
- **Phase 5 — 回归探针与单测补齐**：更新 `scripts/regress/ui.cjs`、`scripts/regress/net-n4.sh` 与 `scripts/regress/run-all.sh` 探针，新增 `tests/shell-layout-interaction.test.ts` 与 `LeaseCoordinator` 遮罩模式/轨迹播报单测。
- **实机自循环验收与细节优化（4 轮 16 截图闭环，现已统一由 `docs/screenshots/` 承载真实网站截图）**：
  - 静态门禁 `npm run check` 全绿（`oxlint` 0 警告 / `prettier` 0 差异 / `tsc --noEmit` 0 错误 / 全量单测 PASS / Vite 渲染层构建通过）；
  - 全量实机回归 `scripts/regress/run-all.sh` **154 PASS / 0 FAIL**（4 个预期 SKIP，UI 21/21 全绿）；专项 14 项外壳交互验收 **14/14 PASS**；
  - 4 轮实机 1440×920 @2x 截图逐帧审计修复并复验清零：修复打包/本地冷启动 `main.ts` 漏发 `broadcastPluginChanged()` 导致的插件面丢失竞态；为 `InputShield` / `DevToolsHost` / `OverlayHost` 补全 `backgroundThrottling: false`、`setBorderRadius(6)` 与 `invalidate()` 刷新，并打通暗色/浅色双主题 AI 护盾；修正 `react-resizable-panels` 首帧回调污染工作台宽度至 `maxSize` 及 `TabsList` 居中左溢出裁切问题（锁定默认 `360px`、`justify-start` + `scrollIntoView`）；补全 `--color-surface-under` 与 `--sidebar` 浅灰层次映射、macOS 红绿灯垂直同轴（`y=14`）、侧栏头 `40px` 与地址栏 `0px` 对齐、全局顶栏导航 `0px` 绝对居中、持锁态侧栏保护环境名、青蓝色系全链路统一、`top-right` 顶栏安全区 Toast、以及 Whistle/账号伴随空态卡片与账号页 `1040px` 居中版心。最终全部 16 张页面/状态截图 0 P0 / 0 P1 验收通过。

### Agent CLI & Browser Ops v3 全面增强（P0 → P2，2026-11-26）

完整调研与施工计划见 `docs/AGENT-CLI-AND-BROWSER-OPS-DEEP-RESEARCH.md` 与 `docs/CLI-AND-BROWSER-OPS-V3-PLAN.md`，涵盖 34 项缺口修复与全量 P0–P2 增强：

- **P0-A 输入内核与几何点击点**：
  - `src/main/browser/input.ts`：完整 US 键盘 `VK_OEM_*` 映射（修掉 `.` 错映 `VK_DELETE(46)`）、命名键 VK/`text`（`Enter`/`Tab`/`Space`/`Escape`/`Backspace`/`Delete`/`Arrow*` 等）、别名（`Esc`/`Return`/`Up`/`Ctrl`/`Cmd`）、左右修饰键 `location`，组合快捷键（`Alt|Control|Meta`）禁发 `text`；
  - `src/main/browser/click-point.ts`：新增 `DOM.getContentQuads` 最大面积多边形内部整点计算 + CDP `DOM.getNodeForLocation` 命中测试 + `<label>`/Shadow DOM 归属校验；
  - `actions.ts` / `mouse-state.ts` / `controller.ts`：真实两连击 `dblclick` 状态机、`PendingRelease` 弹窗断键自动补发 `mouseReleased`、`click --new-tab` / `--humanize`（默认直达防后台多步停顿）、`drag --placement=before|after|center` + HTML5 DnD 降级、`drop` 本地文件拖放。
- **P0-B 可用性与遮挡诊断**：
  - `scrollIntoView` 四态轮转绕开 Sticky Header/Footer；Portal 浮层菜单项（Radix/Base UI/MUI）视口内免滚动直点；`checkVisibility` + `display:contents` + `inert` + `<fieldset disabled>` + DOM Clobbering 防护 + 顶层模态 5 点探测 + `Accessibility.getPartialAXTree` 语义遮挡描述。
- **P0-C 现代 SPA 表单引擎**：
  - `fill` 先滚动并自动解包 `<label>`/包装器、原生 `HTMLInputElement.prototype` setter 兼容 React 受控 `date/time/color/range`、CDP `rawKeyDown` `selectAll`、Shadow-piercing 焦点转移检查、`insertText + 末字符真实按键` 混合输入、`--submit` 与分级回读确认（密码跳过绝不回显、maxlength/格式化返回 `warning`）；
  - `selectOption` 同时支持原生 `<select>`（检查 `option.disabled`、失败返回 `availableOptions`）与 ARIA `combobox`/`listbox`；新增幂等 `check`/`uncheck`（radio 拒绝 `uncheck`、隐藏 checkbox 走 label/DOM click）。
- **P0-D 语义缩进快照树、稳定自愈 Ref 与 OOPIF/Closed Shadow**：
  - `snapshot.ts` & `ops/snapshot-compact.ts`：按 `childIds` 还原真实 2 空格缩进 `depth`（修复 `-d` 误比 heading `level`）、合并相邻 `StaticText`、剪除同名子文本、折叠 `MenuListPopup` 选项摘要；隔离世界 DOM 补盲（密码定宽 `"••••••••"` 脱敏、幽灵节点剔除、`cursor:pointer`/`onclick`/`tabindex>=0`/隐藏 `input[type=file]` 救回、`-u` 链接 URL）、3 态 `unchecked`、同名 `nth=N` 消歧、`--filter` 保留祖先链与分层 Token 预算 80/20 首尾截断；
  - `refs.ts`：新增 `registerStable` 跨快照复用 `@N` + per-frame `loaderId` 精准失效 + `tryHeal` 唯一重绘自愈；
  - `controller.ts`：CSS/XPath 覆盖全部 OOPIF 子会话 + Closed Shadow Root `DOM.getDocument({ depth: -1, pierce: true })` 兜底 + `browser.frame` 作用域切换。
- **P1 原子 CLI、遥测在途请求、事件收敛与安全输出治理**：
  - `telemetry.ts`：挂 `onBeforeRequest` / `onCompleted` / `onErrorOccurred`（零 CDP `Network.enable`）提供真实 `inFlightCount`、主文档失败错因 `lastNavigationError` 及 SQLite 自增 `id` 游标（彻底修复满 300 条后 `batch` 网络增量恒空 bug）；
  - `waits.ts` & `ops/batch.ts`：真实 `networkidle` + 事件驱动 `smartSettle`（过滤 `oldValue===newValue` 与 >200ms 动画循环）；`batch` 末尾改用 `snapshotWithRefs` 使 Delta 自带 `@N` 并支持全量新动词与 `--no-changes`；
  - `ops/reader.ts` & `ops/diff.ts`：实时 Shadow DOM 正文提取（`--outline`/`--filter`/`--match`/`--llms`/`.csv`）；去 ref 行级统一 Diff + 零依赖纯 JS PNG 逐像素 RGBA 差分与差异图输出；
  - `ops/remedy.ts` / `ops/output-guard.ts` / `ops/budget.ts` & `bin/{commands,output-guard,warren,exec-runtime}.mjs`：补齐全部原子 `warren browser` 命令（`click/dblclick/fill/type/press/hover/focus/check/uncheck/select/drag/drop/scroll/scrollintoview/upload/download/wait/dialog/eval/frame/pdf/set/webmcp/vitals/a11y/react`）、POSIX `--` 终止符、动态 RPC 超时预算、终端转义净化、IDPI `--content-boundaries`、`--max-output` 溢出落盘及结构化 `details.remedy` 自愈建议。
- **P2 标注截图、设备仿真、WebMCP、只读 Saved Flows 与诊断工具箱**：
  - `browser screenshot --annotate` 临时隔离世界编号框标注；`browser set` 全套设备/视口/地理/离线/请求头/媒体/时区/语言仿真；`browser webmcp list|call`（untrusted 约束）；`db.ts`/`store.ts`/`ops/flow.ts` 增量 `saved_flows` 表（严格仅允许只读 GET、剥离认证头/凭据、参数渲染与 `schemaDrift` 检测）；`browser pdf/vitals/a11y/react` 与 `--auto-dialog` 策略。

### Warren 2.0 架构重构与实机验收（2026-11-26）

完整设计蓝图见 `docs/WARREN-2.0-ARCHITECTURE-PLAN.md`，Wave 0–4 与 Phase 5 实机闭环已全部落地并通过 `npm run check`（`367/367 PASS`，`oxlint` / `prettier` / `tsc --noEmit` / `vite build` 全绿）及 8 张真机截图双轮视觉验收：

- **Wave 0 — 基线依赖与质量门禁**：升级到 Electron `45.5.0`、React `19.3.1`、Vite `8.4.0`、TypeScript `7.0.2`、oxlint `1.95.0`；建立 `npm run check` 一键门禁与 `docs/DEPENDENCY-POLICY.md` 升级规范。
- **Wave 1 — 原生多视图窗口栈与 Chrome 级页面能力**：
  - `WindowLayerManager` 固定 `below → page → devtools → shield → overlay` 五层 Z-Order 并统一应用 8px 圆角；
  - `OverlayHost`（预热透明置顶窗承载 `⌘K` 命令栏、创建与确认弹窗）与双池 `PopoverHost`（`omni-suggest` / `find-in-page`）不再藏页，实测 Popover 与 `⌘K` 打开时页面 `viewVisible === true` 且 `document.hidden === false`；
  - `DevToolsHost` 通过 `setDevToolsWebContents` 实现原生 Chrome DevTools `right` / `bottom` / `detach` 三态停靠（`right`/`bottom` 复用 `dockView` 并留 6px 分栏缝隙，绕开 Electron 45 自定义宿主 `isDevToolsOpened()` 恒 `false` 的行为并在切换 `docked <-> detach` 时等待 `devtools-closed`），同步落地页内查找、按域缩放（`domain_prefs` 表）、视口预设、下载追踪、打印与另存为；
  - **视口单源与零抢焦点守卫**：`TabManager` 始终从 `ViewCoordinator.pageBounds()` 读取单一视口真相并在渲染层上报真实视口前隐藏默认 `800×600` 视图，`setViewport()` 同步全部运行中环境的双 Space 与 `'below'` 槽位，`WindowLayerManager.restack()` 对 `'below'` 走 index 0 快路径不摘挂 `'page'`；`PopoverHost` / `OverlayHost` / `DevToolsHost` 仅在主窗口本就聚焦时聚焦/激活，`createWindow()` 支持 `WARREN_START_INACTIVE=1` / `WARREN_BACKGROUND=1` 静默启动不抢前台。
- **Wave 2 — 核心域拆解与插件机制 2.0**：
  - `src/shared/types/*` 按域拆分为 6 个模块（`types.ts` 保持纯 re-export），`environments.ts` 拆为薄 Facade + `env/{session-factory,lifecycle,lease-coordinator,view-coordinator}.ts`；
  - **可强杀子进程边界**：`worker-process.ts` 统一封装 `utilityProcess.fork` / `child_process.fork`（`buildForkEnv` 清理 `undefined` 环境键避免 Electron 报错），`sandbox`（受限 `node:vm` 子进程）与 `host`（完整 Node 子进程）均具备独立崩溃/超时强杀边界，同时保持「非 OS 安全沙箱」定位不变；
  - 新增只读脱敏 `PluginEventBus` 与 `'events.subscribe'`（`confirm` 层）及 `SurfaceRegistry` 多挂载点。
- **Wave 3 — 渲染层 4 域状态架构、⌘K 命令栏与 7 分区设置中心**：
  - 主界面状态迁移为 `useSyncExternalStore` 四域 store（`navigation` / `environment` / `plugin` / `telemetry`），移除后台 1.5s 无条件遥测轮询（仅在检查器展开后按需轮询）；
  - 全量 `theme-tokens` + `theme.ts` 驱动深色/浅色/跟随系统极性同步（主窗/Overlay/Popover 三宿主同步）；
  - 可搜索 7 分区设置中心（通用与外观、浏览器与 DevTools、Agent 集成、审批策略、凭据保管、插件与权限、系统诊断 `systemDoctor` + 插件贡献分节），UI 新增 Vault 凭据面板、`⌘K` 命令栏与 6px 凹槽+1px 描边网页舞台；侧栏修齐自适应宽度（`w-full min-w-0`）与 `ResizablePanelGroup` 返回重挂宽度恢复（实测 260px 无溢出）。
- **Wave 4 — Agent 浏览器能力 2.0、站点笔记、Delta Receipt 与 CLI v2**：
  - 统一 `browser/ops/{snapshot-compact,reader,diff,inspector,batch}.ts`，`browser snapshot -i` 支持紧凑高信息密度树及 `# site-notes` 自动注入（`site_notes` 表带密钥外泄拦截，RPC/CLI `notes.*`）；
  - 新增 `browser read` / `find` / `get` / `is` / `diff` / `batch --bail`（支持内置 Delta Receipt 反馈页面标题/URL/网络/可交互元素增量变化）、`events.since` / `events --follow`、`rpc.methods` / `warren methods` 自省、触发方自动溯源 `bin/caller.mjs`（`Environment.leaseLabel`）以及 `--skill` / `skills`（`.warren-skill` SHA-256 指纹更新检查）。
- **硬约束保持不变**：`storage.cookie.read`/`write`、`browser.evaluate`、`process.spawn`、`filesystem.read` 仍属 `denied`；Vault 无明文 reveal 通道；`app_settings` 仅允许 UI IPC 写入。

### E2E 工具链对接：账号插件脱敏 + exec 能力面单源化（2026-11-05）

来源：早期内部 E2E 改造方案 WP1 / WP2（文档未随仓库公开）。

- **账号插件不再回显明文**（`plugins/account-manager/server.js`）：
  - `list` / `get` / 命令 `list` 走 `toPublicAccount`：**没有 `password`**，改为 `hasPassword` +
    `usernameHint`（打码规则来自宿主的 `vault.maskHint`，与 Vault 列表同一份，首字符 + 域名）。
    `create` / `update` / `remove` 返回的也是这个形状。
  - 新增 rpc `fill` / 命令 `fill`：`{ id, environmentId, fields: { username?: target, password?: target } }`
    → `{ filled: ['username','password'], id }`，**不回传值**。值走宿主 `browser.fillSecret` 进页面。
  - 新增 rpc `reveal`：`{ id, field }`，**只对插件自己的界面开放**（`caller='ui'`）；
    agent 通道报 `ACCOUNT_REVEAL_UI_ONLY`。
  - `export`（命令与 rpc）必须 `--input='{"confirm":"plaintext"}'`，否则 `ACCOUNT_EXPORT_CONFIRM_REQUIRED`。
    仍然是明文导出，仅供人手工备份。
  - manifest `permissions` 增加 `vault.fill`（confirm 层）；`contributes.commands` 增加 `fill`；
    `contributes.rpc` 增加 `fill` / `reveal`。
- **新的调用方上下文 `caller: 'ui' | 'agent'`**：类型在 `src/shared/types.ts`，
  经 `plugins/call-context.ts` 传下去。`main.ts` 的 `plugin:rpc` IPC 标 `ui`，
  RPC 派发表的 `plugin.rpc` 标 `agent`。`PluginHost.rpc()` 的第 4 个参数改成
  `{ leaseId?, environmentId?, caller? }`（**调用形状变了**，只有两个调用点）。
- **插件 host API 新增两条**（`src/main/plugins/api.ts`）：
  - `browser.fillSecret(environmentId, target, value)` → `{ filled: true }`，权限 `vault.fill`；
    和 RPC 的 `vault.fill` 共用 `src/main/browser/fill-secret.ts`（域名名单 + 后台输入准备 + finally 摘除）。
  - `vault.maskHint(username)` → 打码字符串，不需要权限（只变换调用方自己给的字符串）。
- **`warren exec` 的能力面单源化**（`bin/exec-runtime.mjs`）：`EXEC_GLOBALS` =
  `page` / `console` / `setTimeout` / `clearTimeout` / `emitResult`，由 `createExecSandbox` 按它装配。
  **没有 fs / require / process**（方案 A，不给 agent 一条绕开 lease 的落盘通道）。
  `emitResult(payload)` 往 stdout 打 `__CONSOLE_E2E_RESULT__<json>`，与外部 E2E 宿主
  约定同一个前缀。
- **新增 CLI：`warren exec --capabilities`** —— 打印 `globals` / `page` / `locator` / `mouse` /
  `keyboard` 的方法名，由 `createPageApi()` 实例**反射**生成（不手写清单）。它不需要环境、
  不需要 lease、不发 RPC。
- **文档**：`skills/warren/SKILL.md` 删掉「VM 注入 fs」的旧说法，改为实际清单 + `--capabilities`
  + `snapshot()` 返回结构；`plugins/README.md` 补 `ctx.caller` / `fillSecret` / `maskHint`。
  `tests/exec-capabilities.test.ts` 盯着「SKILL.md 点名的名字都必须真存在」。

### Whistle 插件：命令表补齐 + fork 自检 + 静态资源分流层（2026-11-05）

来源：早期内部 E2E 审计 P0-4 / 改造计划 WP6（审计文档未随仓库公开）。

- **命令表**：`contributes.commands` 新增 `start / rules / ruleSet / ruleToggle / ruleRemove / unbind`
  （以前只在 `contributes.rpc` 里），`rpc` 增加 `start`。现在 `rpc ⊆ commands ∪ 豁免表`，
  `tests/plugin-package-contract.test.ts` 对**所有插件清单**断言这条规则，豁免表在测试文件里
  逐条写理由（账号插件 `get/reveal`、示例插件 `stats`）。
- **新命令 `start`**：把 `list` 里 `alive:false` 的已登记实例按**原端口原 storage** 拉起。
  `open` 的 summary 明确「只开 UI，不启动服务」。`fork` 遇到端口已登记会提示用 `start`；
  自动选端口时如果撞到「另一个地址族占着」的端口会顺延（实测 8900 的 IPv6 绑定能骗过 `canBind`）。
- **`list` 去重**：同端口多条登记只留「真正在跑的那条」（都不在跑就留最新登记），其余进
  `stale: [{storage, port, reason: 'duplicate-port', liveStorage}]`。`pid` 现在跟着
  `whistlePath` 读 `.startingAppData`（以前固定读 `WARREN_HOME/whistle`，改过设置就永远是 null）。
- **`fork` / `start` 前置自检**（`plugins/whistle/preflight.mjs`）：w2 存在可执行、node 壳脚本能解析到
  node、根证书能被 `X509Certificate` 解析；错误码 `WHISTLE_W2_NOT_FOUND` /
  `WHISTLE_W2_NOT_EXECUTABLE` / `WHISTLE_NODE_NOT_FOUND` / `WHISTLE_ROOT_CA_INVALID`，
  `/tmp` 下的 `w2Path` 只告警 `WHISTLE_W2_PATH_VOLATILE`（启动返回体里带 `warnings`）。
  注意 `package.json#files` 必须包含 `preflight.mjs`，漏了会在安装后 `Cannot find module`。
- **预设层 `local-static-only`**：`presets.mjs` 的 `localStaticOnlyLayer` /
  `appendStaticOnlyLayer` / `staticAssetMatcher`，只把 js/css/字体/图片映到本地端口，
  document 与 POST 不命中；默认关闭，`presetPreview`/`presetApply` 传
  `staticOnly: {localPort, host}` 才加进去。
- **实测**：`npm test` 295/295；三组规则同时 `selected:true`；`ruleToggle` 关/开正文 hash 一致；
  `stop → start` 同端口复活；`traffic --since` 不返回更早条目。完整回显见
  `docs/WHISTLE-PLUGIN-PLAN.md` §8「W5」。
- **未验收**：装机版（`/Applications/Warren.app` + `~/.warren` 插件目录）本轮不动，
  所以装机版 `--help` 仍是旧清单；行为证据来自实现级集成测试（见 §8「W5」）。

### 选择器错误归类 + lease 原因（2026-11-05，审计 WP7 / WP8）

来源：早期内部 E2E 审计 P1-5 / P1-6（审计文档未随仓库公开）。

- **`BAD_SELECTOR` 不再吞掉真实错误**：`controller.ts` 的 `#runSelectorWalk` 只把
  `document.querySelector` 抛的 **SyntaxError** 报 `BAD_SELECTOR`；`shadowRoot` /
  `contentDocument` 取不到就跳过该子树；其余异常报 **`SELECTOR_EVAL_FAILED`** 并带原始信息。
  顺带修掉两个真 bug：`out.push(...nodeList)` 在匹配数上十万时 `RangeError`（改逐个 push）；
  页面自己导航（meta refresh / SSO 重定向）后隔离世界 contextId 失效，
  现在 `did-start-navigation` 里清 `#worldCtx`，并在 `SELECTOR_EVAL_FAILED` 前重试一次。
  实测：`[data-testid="login-type-pwd"]` 在「1 秒后自己跳走」的 fixture 上，修前
  `BAD_SELECTOR: CSS 非法`，修后点击成功；`>>>` 这类真语法错仍是 `BAD_SELECTOR`。
- **`page`（`warren exec`）的契约**（`bin/page-contract.mjs`）：`snapshot()` 结果挂**不可枚举**
  `toString()`（输出与 `browser snapshot` 同一份 JSON 文本），`String(await page.snapshot()).slice()`
  可用；访问不存在的 `page.<x>` / `page.locator(...).<x>` 报
  **`UNSUPPORTED_PAGE_API`** 并指向 `warren exec --capabilities`。`screenshot()` 不传 `path`
  时默认落 `$WARREN_HOME/artifacts/<env>/screenshot-<ts>.png` 并只回
  `{path,bytes,sha256,format,width,height,source}`（实测 stdout 235 字节）。
- **lease 错误带原因**：`domain/environment.ts` 新增 `diagnoseLease` / `revokedReason` /
  `leaseDenialError`，`reason` ∈ `never_leased` / `expired` / `superseded` / `user_takeover` /
  `wrong_space`，**错误码不变**（`ENV_NOT_LEASED` / `CONTROL_REVOKED`），`expired` 额外带
  `expiredAt`。RPC 响应 `error` 增加这两个字段（`src/shared/types.ts` 的 `RpcResponse`），
  CLI 打印成 `CODE: 消息 [reason=… expiredAt=…]`，消息里直接给下一步命令。
  `startLeaseRenewer` 续租失败不再静默，stderr 打一次原因。
  实测（`WARREN_LEASE_TTL_MS=30000`）：`never_leased` / `expired`（带过期时刻）/
  `superseded` / `user_takeover` 四种都在真实 CLI 输出里复现；`wrong_space` 无 CLI 路径，
  只有单测覆盖。

### Space、静默后台、跨环境地址历史（2026-10-21）

施工图与逐项边界：`docs/SPACE-BACKGROUND-PLAN-2026-10-20.md`。

- **Space 模型**：`Environment > Space > Tab`。Person Space 永远 `owner=human`、不需要 lease；
  Agent Space 独立 lease。两层共用 Environment 的 Session / Cookie / 代理，只隔离控制权和 Tab 集合。
- **持久化**：`env_tabs` 增加 `space`，两个 Space 各自保存 active tab；旧数据全部归入 Person Space。
- **Agent 输入**：后台先懒建 Agent Tab，再 `attachBelow()`；renderer 视口为 0 时临时套
  `Emulation.setDeviceMetricsOverride`。`document.hasFocus()` 用 `Emulation.setFocusEmulationEnabled`
  补齐，**不再调用 `wc.focus()`**，所以脚本不会把 Warren 抢到用户前台。
- **后台窗口**：2026-11-27 起已淘汰早期 `-10000` 离屏透明 `showInactive()` 方案，改为原生 `win.hide()` +
  `Emulation.setFocusEmulationEnabled` 保持后台合成器/rAF 与截图可用；不销毁、不改外接屏坐标；有运行环境或 Agent lease 时持
  powerSaveBlocker。`debug.showWindow` 只恢复可见，不激活；托盘点击才真正 focus。
- **Person Space CLI**：`tab ... --space=person` 不取 Agent lease；只有 Agent Space 走写门控。
- **地址历史**：`url_history` 为跨环境全局表；所有实际 http/https 导航累计次数，地址栏支持
  `↑/↓ + Enter`、Esc 和点击选择，空输入给最近访问。
- **截图边界**：`browser.screenshot` 不再按窗口焦点预拒绝；可见视口先走 CDP，
  surface 不可用时回退 `webContents.capturePage()`。`fullPage` / `clip` 仍只走 CDP，
  失败必须保留真实错误。后台截图不会激活 Warren。
- **验证**：`npm test` 269/269；`lint` / `format:check` / `tsc` / renderer build 全过；
  `scripts/regress/run-all.sh` 的后台截图用例改为前台/后台都必须 PASS。

### 插件全量迁移：独立 npm 包 + 账号管理（2026-10-20）

施工图与验收清单：`docs/PLUGIN-PACKAGE-MIGRATION-PLAN-2026-10-20.md`。

- **包契约**：`package.json#warren` 取代 `manifest.json`；`apiVersion` 只接受 `"4"`；
  sandbox 入口是 `warren.server`，host 入口是 `warren.host`，前端是 `warren.app`。
- **安装来源**：`path:` / `npm:` / `git:` 统一走 `npm pack` → 解包 → 校验 →
  `npm install --omit=dev --ignore-scripts` → 原子替换；新增 `plugin update <id>`。
- **安装记录**：`plugins` 表新增 `package_name` / `source` / `resolved`；不再读取旧
  `state.json` / `kv.json` / `settings.json`。
- **现有插件**：`example-cookies`、`example-login`、`example-notes`、`example-host`、
  `whistle` 全部迁移为独立包；fixture 的 `broken` / `hangs` 同步迁移。
- **Whistle**：包依赖固定 `whistle@2.10.12`，默认通过
  `ELECTRON_RUN_AS_NODE=1 <插件>/node_modules/whistle/bin/whistle.js` 启动；
  `w2Path` 仅作为外部 fork 覆盖项。
- **账号管理**：新增 `plugins/account-manager/`（`com.warren.accounts`），sandbox + 插件 SQLite，
  按产品要求**明文**保存账号、密码、备注、标签；界面固定显示明文警告，不接 Vault。
- **测试**：新增 `plugin-source` / `plugin-install` / `account-manager`；
  plugin manifest / registry / fixture 测试同步改为 v4 包契约。
- **实测**：`npm test` 266/266；`scripts/regress/run-all.sh` **152 PASS / 0 FAIL**
  （vault 5.7 按设计 SKIP）。账号管理页与明文警告在 UI 回归中实测挂载。

### 插件能用宿主的组件库（2026-10-18 晚）

**机制**：`plugin-runtime.ts` 导出 `PLUGIN_UI`（70 个键），通过 `register(app).ui` 注入 ——
基础控件 / 表单 / 浮层（Dialog、AlertDialog、Select、DropdownMenu、Tooltip）/ 容器（ScrollArea、Tabs、
Empty、ListRow）/ 工具（`Icon`、`cn`、`toast`、`cardSurfaceClass`、`controlFieldClass`）。
`window.__WARREN__.ui` 是同一份。

**为什么必须有**：插件 bundle 是独立 ESM，走 `warren-plugin://` 供给，**import 不到宿主的模块图**
（`@/components/ui/*` 对它不可见）。没有这层，插件只能手写 `<div className="rounded-md border">`，
等于每个插件自己抄一遍设计契约。`docs/PLUGIN-CAPABILITY-DESIGN.md` §5.3 本来就写了要注入
`window.__WARREN__ = { React, …, ui }`，这次把它兑现了。

**规矩**（写在 `plugins/README.md`，插件作者的入口）：能用组件就用组件；几何/颜色从组件与 recipe 来；
`data-slot` 别覆盖组件自己的（验收选择器靠它，要挂钩子就套一层 div）。

**两个插件按它重构了**：`whistle` 的「新建实例」从行内表单改成 **Dialog**（四个字段、低频 → 弹窗）；
`notes` 的「新增」保持**行内 composer**（两三个字段、高频 → 不弹窗）。行/列表都换成了
`ListRow` / `Badge` / `Checkbox` / `Select` / `Empty`。

**顺带补掉套件的一个隐含前置**：`run-all.sh` 现在会先 `debug.rendererEval` 把界面切回「环境」页。
rail 上点进插件页或设置页时 `sidebarVisible = !stageReplaced` 会把侧栏整个卸掉，于是 UI / n4 的用例
全变成 `NO_TAB`、`0 行`——实测踩过：手工点过插件页再跑，11 个假 FAIL。现在脚本自己处理。

### 插件前端 API：调用级上下文 / 只读 host / envBadge（2026-10-19）

施工图与逐项计划：**`docs/PLUGIN-FRONTEND-API-PLAN.md`**。本轮已落地的核心：

- **调用级环境上下文**：删掉 `PluginHost.#envContext`，改成 `AsyncLocalStorage`
  （`src/main/plugins/call-context.ts`）。sandbox 直接继承；host 运行时的 host-call
  带 invocation id，主进程按上下文执行。并发调两个环境不再互相覆盖。
- **`app.host` 只读门面**：不做通用 Proxy。白名单只有
  `environment.list` / `environment.get` / `browser.info`（`src/shared/plugin-host-api.ts`），
  返回 `HostEnvironmentSummary` 窄 DTO，不带 `leaseId` / `storagePath` / `tabs`。
  IPC 是 `plugin:hostRead`，不经过 `contributes.rpc`。
- **`app.settings`**：当前插件自己的 `PluginSettingValue[]`；secret 只有 `configured`。
  不新增 `plugin:settings` IPC。
- **`envBadge` surface**：清单声明 `kind: "envBadge"`，前端 `app.surfaces.envBadge(...)`
  拿 setter；renderer-only store 按 `pluginId + digest` 管 generation，停用 / 卸载清掉。
  环境行一个槽，多插件按 pluginId 稳定排序，其余进 tooltip。
- **`reload` 两阶段**：候选实例先启动成功，再替换旧实例；失败保留旧实例并写 status detail。
- **`apiVersion`**：当前只用 `4`；旧 `1` / `2` / `3` 已删除，不再兼容。

新增单测：`tests/plugin-context.test.ts` / `tests/plugin-host-api.test.ts` / `tests/plugin-badge.test.ts`。

### Whistle 预设模板 / 规则安全 / 诊断与证据（2026-10-19）

施工图：`docs/WARREN-OPTIMIZATION-WHISTLE-PRESETS-PLAN-2026-10-19.md`。

- **Whistle 预设**：`plugins/whistle/presets.mjs` 只保留 schema、变量、分层合成、
  冲突检测与导入逻辑；真实测试后端、预发布 CDN、本地站点预设由用户从本地导入，
  不随仓库分发。支持 `online / test / local / preview` 四种显式场景、层开关、
  预览 hash、warning/error、导入 draft。运行时事实来源仍是 Whistle 的 `rules/list`。
- **规则安全**：`ruleToggle` 不再裸调 `select/unselect`。启用走 `project&enable=1`，
  停用带当前 `data`，操作后比较正文 SHA-256；`ruleSet` 支持 `expectedHash` 并在读回不一致时回滚。
- **Profile**：插件 `data.db` 记录 preset/revision/variables/layers/applied hash 和 history；
  迁移时兼容旧 `whistle_presets` 表，不再假设 `definition_json` 在 presets 本表。
- **组合与导入**：应用对话框可同时叠加多个用户预设，变量/层统一配置并预览；「导入规则」
  会把 draft 保存成当前用户的预设 revision，不只是停在内存里。回执保留行数、hash 与 profile。
- **CLI**：新增 `plugin run --help`（不带 id 列插件）、`plugin rpc`、`env renew`、
  `env doctor --ports=`、`evidence capture`；`browser screenshot` 默认落盘。
- **截图与产物**：截图默认写 `~/.warren/artifacts/<env>/` 并返回
  `{path, bytes, sha256, format}`；`net record stop` 返回文件字节数与 SHA-256。
- **浏览器**：click 支持 `noWaitAfter` / `navigationTimeoutMs`；补 `goBack/goForward`；
  非交互 AX 节点不分配动作 ref；snapshot 支持 `interactiveOnly` / `roles` / `selector`。
- **证据包**：`warren evidence capture <env>` 生成截图、snapshot、console、network、
  net-hits 和带逐文件 SHA-256 的 manifest。
- **验证**：`lint` / `format:check` / `tsc` / 250 条单测 / renderer build 全过；
  `scripts/regress/browser.sh` 23 项全 PASS。全量回归 142 PASS，跨源 iframe 4 项受本机
  Whistle 占用 `::1:8899` 影响，fixture 双 origin 编排仍需单独收口。

### 「编辑环境」+ 清代理不生效的 bug（2026-10-18 晚）

**新增「编辑环境」弹窗**（`features/environments/edit-environment-dialog.tsx`）：右键菜单里的
「重命名…」换成「**编辑…**」，字段是 显示名 / 代理 / 启动 URL / 启动后自动切换。
`RenameDialog` 留着只服务分组。

为什么必须有它：**代理 / 启动 URL / 自动切换以前只有创建那一刻能填**，之后只能敲
`warren env update`；而侧栏那一行明明显示着出口（`直连` / `127.0.0.1:8900`），人却改不了它。
环境 id 不可改（session 目录名 + CLI 寻址 + 主键），所以放在弹窗描述里只读展示。
**审批策略不在这里** —— 它跨环境，统一在「设置 → 审批」一页，两处都能改同一个字段只会让人
不确定哪个生效。

**顺带修掉一个真 bug：清掉代理不生效。** `start()` 里原来是 `if (config.proxy) await ses.setProxy(...)`
—— Session 是缓存的（`#sessions`），所以解绑之后**这个 session 继续用上一次的代理**：配置里写着
「直连」，流量还在走旧代理。改成无条件设一次：`setProxy(config.proxy ? { proxyRules } : { mode: 'direct' })`。

RED → GREEN（探针用 whistle 实例，因为 Chromium 隐式绕过 loopback，直接拿 `localhost` 测不出代理）：

```
# 环境代理指向 whistle（规则把 probe.example.test 指到 fixture）
$ env start proxybug → title = 网络拦截 fixture          # 走代理，加载成功
# 清掉代理 + 重启
旧写法：proxy = None | error = None | title = 网络拦截 fixture   ← 配置直连，流量还在走旧代理
新写法：proxy = None | error = ERR_EMPTY_RESPONSE | title = probe.example.test/cap/net.html
# 对照：真直连时这个域名根本解析不了（curl 直连 → 000）
```

### 侧栏行主次 + 应用名（2026-10-18 晚）

**环境行只放三样东西，按主次排**：名字（`flex-1`，吃掉剩余宽度）→ 状态块 → 出口（右侧，`max-w-[40%]`）。
**页面标题从行里拿掉了** —— 它属于页面不属于环境，选中那个环境的标签条已经显示了，行 tooltip
（`rowTitle`）里也带上了。以前是「名字 + 页面标题 + 归属 + 审批 + 出口（`max-w-[65%] shrink-0`）」
五样抢宽度，名字只剩几个字符（实测：`uisetup1` 这种短名字也被截成 `u…`）。
现在实测每个名字拿满 144px、不截断。

**应用名**：Dock 悬浮名 / Dock 里的名字取的是 **bundle 的目录名**，既不是 `app.name`，
也不是 Info.plist 里的 `CFBundleName` —— 实测 `app.setName('Warren')` 之后 `app.name`
已是 Warren，Dock 照样写 Electron；把 plist 的 `CFBundleName` / `CFBundleDisplayName`
改成 Warren 之后重启应用 + 重启 Dock，Dock **依旧**写 Electron；而同一个 bundle 只换个
目录名（`ElectronDockTest.app` / `WarrenNameTest.app` 两组对照），Dock 立刻跟着变。
所以三件事一起做：

1. `main.ts` 顶部 `app.setName('Warren')`（关于面板 / 通知 / `app.name` 用它），
   放在 `app.setPath('userData')` **之前**（userData 默认按 app name 拼）。
2. `installMenu()` **手写 app 菜单**（不用 `role: 'appMenu'`，它的 label 取 bundle 名），
   顺带把「编辑 / 显示」两栏的顶层改成中文（里面仍是 role 的英文项，Electron 不给改）。
3. `scripts/electron-name.mjs` + `postinstall`：给 `node_modules/electron/dist/Electron.app`
   挂一个 `Warren.app` **软链**（不复制 250MB），并把 electron 包的 `path.txt` 指到软链里的
   可执行文件；plist 的 `CFBundleName` / `CFBundleDisplayName` 顺手补成 Warren。
   实测：`npm start` 后 Dock 悬浮名 = **Warren**，RPC 探针 `debug.layout` 正常。
   **不影响打包**：`@electron/packager` 把下载的 electron zip 解到临时目录再自己改名，
   从不读 dist 目录；打包产物用 `productName: "Warren"`，本来就没这个问题。
   **plist 改动的安全性**：npm 分发的那份是 ad-hoc、linker-signed，`codesign -dv` 写着
   `Info.plist=not bound`，plist 不在签名覆盖范围里，改完照常启动（实测）。

### 审批策略 · 内嵌代理面板 · 记忆插件 · 数据统一到一个根（2026-10-18）

施工图与逐项实测：**`docs/APPROVAL-EMBED-MEMORY-PLAN.md`**（四块：A 审批策略 §3 / B 内嵌面板 §4 /
C 记忆插件 §5 / D 数据根 §6，验收记录在 §9）。要点：

- **审批策略可配置**（新表 `app_settings` + `environments.created_by` / `approval` 两列）：
  全局 `controlPolicy` = `ask`（默认）/ `agent-created` / `auto`，环境级 `approval` 可覆盖；
  插件确认 `pluginPolicy` = `ask` / `auto`（**不落库**，切回来立刻恢复拦截）。
  判定是纯函数 `domain/approval.ts`；`acquire()` 是唯一的接管点。
  设置页多了「审批」一节（全局 + 每环境例外），侧栏只在偏离全局时标记。
- **代理面板开在环境标签里**：新 host API `browser.openTab`；whistle 插件不再 spawn 系统浏览器。
- **记忆插件**：`items` 表（todo / fact × env / global），核心命令 `context` 给 agent 一份可塞进
  上下文的摘要；老的 `addNote` / `list` / `stats` 保留。
- **数据统一到一个根**：`WARREN_HOME`（默认 `~/.warren`）下有 `app/ core/ runtime/ whistle/ logs/ crashDumps/`；
  `main.ts` 在建窗口前 `app.setPath(...)`，whistle 子进程带 `WHISTLE_PATH` + `STARTING_DATA_DIR`。
  搬家是**手动做的一次**，代码里没有迁移分支（§6.5）。

### Whistle 代理插件（2026-10-18）

施工图、调研数据与逐项实测：**`docs/WHISTLE-PLUGIN-PLAN.md`**。
这份文档**推翻了 `docs/WHISTLE-PROXY-FEASIBILITY.md` §6 的结论**——那份写「主体必须在核心、
插件只能当薄壳」，前提是「插件起不了进程、发不了 HTTP」；**host 运行时落地后这个前提没了**，
所以实例托管搬进了插件（`plugins/whistle/`，`runtime: host`），核心只补两个它做不了的口子。

**核心的三处改动（都很小，但都是新的公共面）**

| 改动 | 位置 |
|---|---|
| 新权限 `environment.write`（**confirm** 层）+ 三个 host API `environment.update` / `start` / `stop` | `src/shared/permissions.ts`、`src/main/plugins/api.ts` |
| `EnvironmentConfig.trustedCa`（PEM 路径）—— 表加列，**带一条 `ALTER TABLE ADD COLUMN` 迁移** | `src/shared/types.ts`、`src/main/db.ts`、`src/main/store.ts`、`src/main/domain/environment.ts` |
| 按环境装 `setCertificateVerifyProc`（唯一证书放宽点，见硬约束 6） | `src/main/domain/trusted-ca.ts`（纯函数，可单测）、`src/main/environments.ts` |

**两个语义变化，别退回去**

1. `EnvironmentPatch` 里 **`proxy` / `trustedCa` 收 `null` = 清掉这个字段**，`undefined` = 不改。
   没有这个区分，解绑代理没法表达（`{...config, ...patch}` 会把旧值留下）。
   CLI 侧对应 `--proxy=none` / `--trusted-ca=none`。
2. **`warren plugin run` 的 `--env` 变成可选**（RPC 层的 `str('env')` 改成了可选读取）。
   「列实例」「起实例」这类命令和环境无关，逼调用方编一个环境 id 是假的；
   真需要环境的能力仍然报 `PLUGIN_NO_ENVIRONMENT`，错在真正用到它的那一刻。

**顺带修掉的两个真 bug**

- **host 运行时的命令收不到 `ctx.input` / `ctx.environmentId`**（`plugins/runtime.ts` 的 `#invoke`
  把 ctx 覆盖成 `{pluginId, input: payload.input}`，而命令那条路上 payload 里没有 input）。
  症状是**静默丢参数**：`fork --input='{...}'` 不报错，按默认值跑出一个空规则的实例。
  sandbox 那条路一直是对的，所以之前没暴露。
- **证书校验结果被 Chromium 按域名缓存**（实测，同一个 session 里没访问过的域名立刻就好，
  访问过并失败过的要等应用重启）。已写进 `WHISTLE-PLUGIN-PLAN.md` §7 风险 6；
  现在每个 tab 的 webContents 上增加 `certificate-error` 验签兜底，新标签能绕过该缓存，
  `bind` 后只重启环境即可恢复，不再要求重启整个应用。

**实测**：`npm test` 213/213（新增 5）；全量回归 **146 PASS / 0 FAIL**（唯一非 PASS 是 vault 5.7 的
SKIP）。插件已经进套件：7.3 的 rail 目的地多一个「代理」，10.1 的设置分节多一个「Whistle 使用说明」。

### 外壳路由化 + 插件 CLI 发现（2026-10-17 晚，第二批）

**rail 是路由，环境列表只属于「环境」**（`docs/SHELL-PLUGIN-PLAN-2026-10-17.md` §1）：

- `sidebarVisible = !stageReplaced` —— 插件页 / 设置页占满整张卡，侧栏不渲染。
- ⚠️ **两个 effect 的依赖跟着改了**（`[sidebarVisible]`）：侧栏会被卸载重挂，
  不改就会盯着脱离文档的旧节点，尺寸变化不再上报。以后动侧栏渲染条件，这两处一起看。
- **☰ 挪到标题行**（`app-titlebar.tsx`），不在 rail 里：rail 只做路由切换，
  侧栏开合是"这一列显不显示"，两件事。`showSidebarToggle` 控制它在不在，
  槽位宽度固定所以环境名不会跳。

**插件 CLI**：新增 `warren plugin commands`（跨插件摊平命令）和
`warren plugin create <id>`（脚手架；现行生成 package.json + server.js）。
**插件命令不做成顶层命令**，理由在 §2.3（撞名 + 装/卸会让 help 不稳定）。

### 设置页 / Agent 一节 / 插件能力表（2026-10-17 晚）

**设置不再是弹窗，它替换 stage**（和插件页抢同一块地方）：

- `features/settings/settings-dialog.tsx` → **`settings-page.tsx`**（旧文件已删）。
- `App.tsx` 里 `stageReplaced = pluginPageOpen || settingsOpen` —— 它决定要不要让原生页面视图让位
  （`setViewVisible(!stageReplaced)`），**viewport 上报 effect 的依赖也是它**，
  漏了就会盯着已脱离文档的旧节点（见那个 effect 上的注释）。
- rail 底部的 ⚙ 现在是**开关**，带 `aria-current="page"` 选中态；点「环境」/插件页会把它关掉。
- 分隔线要 `h-auto!`（带 `!`）：组件基础变体里有 `group-data-vertical/tabs:h-fit` 在抢。

**设置里新增「Agent」一节** —— 把自带 Skill 装进各 agent 的 skills 目录。
落点：`src/main/agent-integration.ts`（纯逻辑，带单测）+ `agent-panel.tsx` + `agent:skills` /
`agent:installSkill` 两个 IPC。Skill 源文件是 `skills/warren/SKILL.md`，
打包靠 `forge.config.cjs` 的 `extraResource`（主进程按 `app.isPackaged` 解析路径）。

**插件能力改成表驱动**：`plugins/api.ts` 的 `BROWSER_CAPABILITIES`（7 条 → 24 条）。
**加浏览器能力只改那张表**，权限检查 / lease / `assertWritable` 由 `createHandlers` 统一生成。
`browser.console` / `browser.network` 不在表里（数据来自 Telemetry，不是 controller 方法）。

### Chrome 扩展（2026-10-17）

**每环境可装解包扩展**，状态就是文件系统：`<环境 storagePath>/extensions/<name>/`。
`start()` 在第一个页面加载之前挂上（晚挂的话内容脚本注入不到首个页面）。

- 落点：`src/main/extensions.ts`（纯逻辑 + `tests/extensions.test.ts`）、
  `environments.ts` 的 `#loadExtensions` / `extensionsOf` / `extensionAdd` / `extensionRemove`、
  RPC `extension.*`、CLI 组 `extension`（`bin/commands.mjs` 的 SUBS 里也加了）。
- **只吃解包目录**：Electron 不支持 `.crx`；`.crx` / 缺 manifest / 坏 JSON / 路径穿越的目录名
  都会被挡（各有错误码）。
- ⚠️ **DevTools 面板装不上**（实测：连照抄 Electron 自己测试夹具形状的最小 MV2 扩展也不出现）。
  内容脚本和 `__REACT_DEVTOOLS_GLOBAL_HOOK__` 都正常。细节见
  `docs/EXECUTION-PLAN-2026-10-17.md` 批次 3。

### 环境页检测面加固（2026-10-17）

**页面看到的东西变了**，改之前先知道这件事：环境页（`WebContentsView`）现在带一个 preload
（`src/preload/page-preload.ts`），UA 也被改写。为的是把 Electron 的现成检测特征抹掉
（完整调研 + 实测对照见 `docs/CHROME-SHELL-PLAN.md` §2.7）。

| 项 | 改前（实测） | 改后（实测） |
|---|---|---|
| UA | `... Warren/0.1.0 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36` | `... Chrome/152.0.0.0 Safari/537.36` |
| `Object.keys(window.chrome)` | `[]` | `["loadTimes","csi","app"]` |

落点：`src/main/domain/user-agent.ts`（纯函数 + `tests/user-agent.test.ts`）、
`environments.ts` 的 `#sessionFor()` 调 `setUserAgent()`、`tabs.ts` 的 `VIEW_PREFERENCES.preload`、
`forge.config.cjs` 第三个 build entry。**`navigator.userAgentData.brands` 仍是 `Chromium`，
是有意不改**（Electron 没有公开 API；改 JS 反而更显眼）—— 理由写在
`docs/CHROME-SHELL-PLAN.md` §2.7.1，**不要**再"顺手"去覆盖 `Navigator.prototype`。

### 页面操作能力（2026-10-15，提交 `217e2c7`）

对标 Playwright 的动作可用性改造已落地并逐项实测（RED→GREEN 记录在
`docs/BROWSER-CAPABILITY-PORT-PLAN.md` §4.6）。验收脚本 `/tmp/warren-all.sh`，
15 项里 14 项 PASS。

**新增/变更的行为（agent 可见）**

| 变化 | 说明 |
|---|---|
| 动作会等 + 重试 | 元素晚出现不再立即 `TARGET_NOT_FOUND`；重试会**重新解析**目标。默认超时 3s→**5s**（受 `exec` 的 60s RPC 上限约束，别照抄 Playwright 的 30s） |
| 新增错误码 | `NOT_ACTIONABLE`（不可见/正在移动/disabled/不可编辑）、`TARGET_OCCLUDED`（被遮挡，消息带挡路元素）、`NODE_DETACHED`、`TARGET_NOT_FILLABLE` |
| 超时错误带历史 | `TIMEOUT click #x 超时 1200ms（8 次尝试）` + 每次的原因 |
| `AxNode` 新增字段 | `checked/expanded/selected/pressed/level/readonly/required/focused/valuetext`；**`disabled` 修好了**（之前读顶层字段，恒为 undefined——状态其实在 `properties[]` 里） |
| `click` 收据 | 新增 `navigation: 'none' \| 'navigated'`（事件驱动，不再轮询 URL） |
| fileChooser | 走 `Page.fileChooserOpened`，事件带 `frameId/mode/backendNodeId`。**拦截只在 `waitForEvent('fileChooser')` 期间开启**，常开会让人点文件框时没有反应 |
| `DIALOG_OPEN` | 错误消息直接给出下一步命令；判定优先于 `WINDOW_NOT_FOCUSED`（alert 会让 macOS 窗口失去 key 焦点，顺序反了会掩盖真因） |
| 隔离世界 | 选择器/xpath 解析跑在 `Page.createIsolatedWorld`，不再往被控页面写 `window.__warrenMatches` 或打 `data-*` 属性 |

**已知缺口**

- ~~跨源 iframe（OOPIF）不可见~~ —— **2026-10-16 已打通**（读 / 坐标 / 写动作 / dialog 全过，
  见 §6「跨源 iframe」）。剩下的边界是**继承来的、不是这次的缺口**：
  `page.evaluate` / `fetch` / `cdp` 仍然只在主会话（跨源内容本来就取不到，同源策略如此）、
  `waitForFunction` 只看主 frame、CSS/XPath 选择器够不到跨源 iframe 内部
  （`text=` / `role=` / `@N` 可以）。
- 元素高亮（`Overlay` 域）白名单里有但未接。

### 全量回归（2026-10-15）

**2026-10-16 复跑**（标签手感 / net passthrough / LRU + 崩溃恢复 / store 迁 SQLite 之后）：
`bash scripts/regress/run-all.sh` → **116 PASS / 1 FAIL**，唯一 FAIL 仍是 V5b（OOPIF 已知缺口），
没有新增缺口。跑之前要满足套件的数据依赖（侧栏 ≥7 个环境、第一个是停止态），
否则 UI 的 7.1 / 9.1 会假 FAIL——`run-all.sh` 的文件头写了这三条前置条件。
另外：**输入类检查要求 Warren 窗口是前台应用**，拿不到焦点时会是一大片 `WINDOW_NOT_FOCUSED`（见坑 36）。

**2026-10-16 复跑（OOPIF 打通之后）**：同一套回归 → **119 PASS / 0 FAIL**，
**全绿**。比上一次多的两条是新增的 V5d（跨源读 + 点）与 V5e（跨源 dialog），V5b 由 FAIL 转 PASS。

**2026-10-16 收尾（套件自足化）**：把「手工前置」全部搬进套件，**133 PASS / 0 FAIL**：

- `run-all.sh` 前置检查：fixture 可达 / 应用在跑 / **窗口在前台**（不满足就退出并说明原因，
  否则会是一大片 `WINDOW_NOT_FOCUSED` 假 FAIL）/ cap 环境不够就建 / 三个示例插件缺了就装、
  该跑的确保在跑（**装了就不重装**——重装会把 enabled 清掉）。
- `browser.sh` 自己造 `/tmp/warren-upload-probe.txt`；`ui.cjs` 自己补到 ≥7 个环境、跑完删掉，
  9.1 改成挑一个**已停止**的行（不再假设「第一行必须是停止态」）。
- 验证方式：先把 cap、插件、探针文件全删掉再跑 → 132 PASS / 1 FAIL（9.1，已修）→ 现在 133/0，
  跑完只剩 `cap`（自己清干净了）。跑之前不用再手工建任何东西。

一套可复跑的回归套件 + 一轮实测：`bash scripts/regress/run-all.sh`（约 1 分钟，结果写
`/tmp/warren-regress.txt`）。**117 PASS / 1 FAIL**，唯一 FAIL 是跨源 iframe（OOPIF）已知缺口。
逐项输出、6 个修复的 RED→GREEN 证据、没覆盖的边界都在 **`docs/FULL-REGRESSION-2026-10-15.md`**。

本轮修掉的真问题（都在上面那份文档里有实测输出）：

| # | 问题 | 表现 |
|---|---|---|
| F1 | 视图被界面让开（浮层 / 插件页）时输入会被 Chromium 丢掉 | **挂死 60s**（`TIMEOUT: RPC 超时 browser.click`）→ 现在毫秒级 `ENV_NOT_VISIBLE` |
| F2 | fixture 服务器 `/cap/*.html` 不存在时二次 `writeHead` | 抛 `ERR_HTTP_HEADERS_SENT` **打死整个 fixture 进程**，看着像产品全线崩 |
| F3 | `page.waitForEvent()` 先拒绝后 await | CLI 抛裸 Node 栈 → 现在统一成 `CODE: message` |
| F4 | 渲染层上报 `0×0` 的视图矩形 | 原生视图变 0×0 → 输入全废 → 现在忽略 0 报告 |
| F5 | Vault 里解不开的旧凭据 | 照常列出来、报错看不出所以然 → 现在 `available:false` + 报错带 `vault remove` |
| F6 | 删掉「当前选中的环境」 | 选中态指向已删除的环境 → 现在清空 |

### 网络拦截（2026-10-15，N1 起）

把「拦截并改写页面发出的请求」做成内置能力（不依赖 whistle、不走 CDP Fetch 域）。
施工图 + 逐项实测：`docs/NET-INTERCEPT-PLAN.md`（§1 前置实测 R8–R11，§7 验收记录）。

**机制**：每环境一个 `NetInterceptor`，挂在自己 session 的 `protocol.handle('http'/'https')` 上
（per-session，天然按环境隔离）；未命中规则一律 `net.fetch(request, { bypassCustomProtocolHandlers: true })`
透传——**不带 bypass 会递归拦自己**（R10 实测）。规则只在内存里，随 Environment 存亡：
停环境时 `unhandle`，删环境时连规则一起清（不跨环境泄漏）。

**新增对外接口（agent 可见）**

| 接口 | 说明 |
|---|---|
| `warren net rules <env>` | 规则表 + 命中数 + 录制/回放状态（读，不需要 lease） |
| `warren net rule add <env> --match=… --mock=… \| --block \| --redirect=… \| --delay=…` | 加规则（**写操作，要 lease**） |
| `warren net rule add … --request-header=k=v`（可重复）/ `--response-header=k=v` | 改请求头 / 改响应头（同样要 lease） |
| `warren net rule enable\|disable\|remove <env> <ruleId>` | 开关 / 删除（写操作） |
| `warren net hits <env> [--limit]` | 命中记录（请求/响应头已脱敏，读） |
| `warren net record start\|stop <env> [--output=…]` | 录 HAR（stop 时落盘，路径须绝对） |
| `warren net replay start <env> <file.har> [--offline]` / `replay stop <env>` | 回放 / 停止回放（恢复直连） |
| RPC | `net.rules` / `net.hits` / `net.rule.add` / `net.rule.set` / `net.rule.remove` / `net.record` / `net.replay` |
| 界面 | 检查器多一页「规则」：开关 + 匹配串 + 动作 + 该规则的命中数，下面是命中记录。**人可关**，agent 下一次请求立刻不生效 |
| 跨源 iframe（OOPIF） | V5b 从 FAIL 转 PASS：`snapshot` 里能看到「内层按钮」（AX 两个 frame）；`click text=内层按钮` 落在 `@127,149` 且内层收到点击；`debug.point` 的 delta = 0（我们算的点 vs 页面自己算的点）；跨源 iframe 里弹的 alert 能被 `events()` 捕获、`acceptDialog()` 收掉，内层状态变「已弹出」（V5d / V5e 两条新检查） |
| `⌘⇧T` 重新打开标签 | 开两个标签 → 关掉 net.html → `tab reopen` → 标签回到 2 个且**地址是刚才那个**（core.sh 2.4b/2.4c）。最近关闭栈深度 10，环境停掉不入栈 |
| `net passthrough` 去重 | 同一条匹配串连调两次 → 规则表里 passthrough **只剩一条**（新的那条）；过期自动摘掉（net-n1.sh V26-1/2/3） |
| 元素高亮 | `browser.highlight <env> '#btn'` → `{highlighted, rect}`；**A/B/A 画面比对**：高亮后画面变、清除后**逐字节回到原样**、DOM 节点数不变（`webContents.capturePage()` 三连拍稳定且含高亮）。capability.sh V15 |
| 后台环境可被操作 | `showing=['cap']` 时对 `bg` 执行 `page.click` / `fill` / `press` **全部生效**（改前报 `ENV_NOT_VISIBLE`）；操作完 `attachedBelow=[]`、`focusedEnv=cap`（焦点还在人看的那个页面上）；浮层压着页面区域时**拒绝**后台操作并说明原因。browser.sh 22.3a/b/c |
| 插件信任说明 | 面板文案：「插件是半可信代码，不是沙箱」+ 两种运行时的能力说明；徽章只剩「同进程」/「独立进程」，**UI 里再也搜不到「沙箱」**（`querySelectorAll` 实测） |

**临时放行（2026-10-16 新增）**：`warren net passthrough <env> <匹配串> [--for=30s] [--regex] [--method=GET]`（写操作，要 lease）。
加一条 `action: {type:'passthrough'}` + `expiresAt` 的规则，优先级 `PASSTHROUGH_PRIORITY`（1000000，压过任何手工规则），
**到点由 `NetInterceptor.#scheduleExpiry()` 真的摘掉**。RPC `net.passthrough`。时长 1 秒 ~ 1 小时（超范围报 `BAD_REQUEST`）。
实测：mock 命中时放行 → 返回真数据；6 秒后规则消失、请求回到 mock、事件 `net.rule.expired`、命中记录里是 `passthrough`。
**到期必须真摘**，不能只是「不再命中」——否则 `#sync()` 认为还有启用规则，handler 一直挂着，
**整个 session 的响应继续跳过 CORS 检查**（实测：放行期间跨源无 ACAO 请求 `OK:200 acao=null`，
过期后回到 `CORS_ERR:Failed to fetch`）。

**实现上的两条硬要求**（别退回去）

1. 透传分支整体 try/catch 兜底 + 记事件：session 一旦被规则全量接管，handler 抛异常的表现是
   **页面白屏**而不是报错。实测：`fetch('http://127.0.0.1:9/x')` → `502 warren: 透传失败 net::ERR_UNSAFE_PORT`
   + 事件 `net.passthroughFailed` + 一条带 note 的命中记录。
2. 命中记录里的头必须脱敏：复用 `browser/escape.ts` 的 `redactSecrets`，**再补一道 `authorization`**
   （它不在那个词表里；`browser/` 是另一条线的成果，不在那里改）。
3. **没有启用的规则就不挂 handler**：`protocol.handle` 一挂上，**整个 session 的响应都跳过 CORS 检查**
   （实测：未命中的跨源请求 `OK:200 acao=null`；不挂时 `CORS_ERR:Failed to fetch`）。
   所以 `#sync()` 只按「有没有启用的规则」挂/摘——不开规则的环境必须和真浏览器一致。
   规则开着时这条偏差仍在，要彻底消掉得把「只改头」改用 `webRequest`（走正常网络栈）。
4. **录制也要挂 handler**（`#sync` 的条件是 `#recording || 有启用规则`）：录制时通常一条规则都没有，
   只看规则的话 handler 是摘着的，什么都录不到（实测第一轮 `entries=0`）。
5. **HAR 不写头**：`cookie` / `authorization` 落盘就是新的泄漏面，回放只需要响应体。

**新增 fixture 端点**（`scripts/serve-fixture.mjs`）：`/cap/api/user`（真 JSON）、
`/cap/api/headers`（回显请求头）、`/cap/api/cors`（**故意不带 ACAO**）、`/cap/api/cookie`
（带 `set-cookie`）、`/cap/api/big`（5MB）、`/cap/api/sse`（流式）、`/cap/pixel.png`；
页面 `fixtures/capability/net.html`。

### 已验证

### 标签手感（2026-10-16，`TAB-MODULE-PLAN` 阶段 2 的 6 项）

施工计划与逐项实测输出在 **`docs/REMAINING-PLAN-2026-10-16.md` §A**。要点：

- **新增 RPC**：`tab.closeOthers` / `tab.closeRight` / `tab.reorder` / `tab.mute`（都要 lease）；
  对应 IPC `tab:closeOthers` / `tab:closeRight` / `tab:reorder` / `tab:mute`（界面走这条，不受 lease 限制，
  和已有的 `tab:close` / `tab:select` 一致）。**CLI 没加**这三个命令——它们是人的手感，agent 用不到。
- **新增 `TabState.muted`**：`audible` 是「页面在响」，`muted` 是「人把它静音了」。
- **`SurfaceTab` 加 `iconAction` 槽**：标签可关闭时 `icon` 会被整个包进关闭按钮里，
  所以喇叭这类第二个控件必须走 `iconAction`（和关闭键平级的兄弟节点），塞进 `icon` 就是
  button 套 button（实测 `button button` 命中 1，结构无效）。
- **新标签页**：`warren://newtab/?env=<id>`，主进程供给一张静态页（显示环境名 / 出口 / 登录态边界）。
  `+` 和「没配 start-url 的 `env start`」都落在它上面，不再是 `about:blank`。
  **必须挂在每环境自己的 session 上**（`#sessionFor()` 里挂），挂默认 session 会 `ERR_FAILED (-2)`。
- **快捷键**：`⌘T` 新标签 / `⌘W` 关标签 / `⌘R` 重载当前页面 / `⌘L` 聚焦地址栏 —— 这四条是**应用菜单**
  的加速键（「浏览器」菜单），默认菜单里的 `reload` / `close` role 已撤掉（它们就是 ⌘R / ⌘W，
  macOS 上菜单先于页面拿到按键，留着会重载整个应用界面 / 关掉整个窗口）。`⌥⌘I` / `⌥⌘J` / `⌘1..9`
  不在菜单里，仍走页面 `before-input-event` → 同一条 `browser:shortcut` IPC → 渲染层执行。
- **诊断**：新增 `debug.shortcut`（dev-only）——本机没开「辅助功能」权限时脚本发不出真按键
  （osascript 报「不允许发送按键」），只能这样验证「快捷键 → 界面动作」这半段。
  `debug.layout` 新增 `webContents`（活着的 webContents 数），关标签后它必须跟着减。
- **没做**：`⌘⇧T`（要主进程维护「最近关闭」栈）；`beforeunload` 关闭确认（实测 Electron 默认不拦、
  也没孤儿 webContents，加确认会让 agent 的 `tab close` 卡在人机对话框后面，见计划 §A-2.8）。
- 实测：全量回归 **116 PASS / 1 FAIL**（唯一 FAIL 仍是 V5b），`npm test` 134/134。

| 能力 | 证据 |
|---|---|
| 多环境隔离 | 两个 Environment 各自的 `sessions/<id>/Cookies` 独立 |
| 每环境独立代理 | `--proxy-server` 参数确认传入 Session |
| CDP 控制 | snapshot 29 个 AX 节点；点击跳转 `iana.org/help/example-domains` 成功 |
| 控制权互斥 | `ENV_BUSY: environment beta is controlled by human` |
| 遮罩联动 | 无 lease → `shield=False`；agent 取 lease → `shield=True`；人接管 → `False` |
| 插件权限门控 | 未授权 `PLUGIN_PERMISSION_DENIED`；grant 后 login `{ok:true, title:"已登录"}` |
| 插件升级新增权限 | 不再拒绝安装：`granted` 层的新能力照常授予，`confirm` 层的新能力留在 `needsConfirmation` 等用户批准，并记一条 `plugin.permissions.added` 事件（实测：v1→v2 升级后 `needsConfirmation` = `browser.navigate, browser.input, vault.fill`） |
| 插件挂载页面（P1） | `warren-plugin://<id>/app.js` 由主进程按目录供给，渲染层 `import()` 后调 `register(app)`。实测 rail 目的地 `['', '环境', '坏插件', '笔记', '设置']`、点「笔记」后 `[data-slot=notes-page]` 挂载并显示真实数据（标题来自设置、条数来自 SQLite） |
| 插件设置分节 | 设置弹窗分节变成 `['插件', '凭据', 'Notes 使用说明']`，插件分节渲染自己的组件且能拿到 rpc 数据 |
| 插件检查器页 | 检查器标签变成 `['事件','快照','控制台','网络','笔记']`，插件页显示当前环境的标题 / URL / 笔记数（`environmentId` 由面传进 rpc） |
| 插件环境菜单动作 | 环境右键菜单出现两个插件的动作（「用插件登录」「存成笔记」）；点「存成笔记」后 `stats.count` 2 → 3，`lastText` = 当时页面的 `title — url` |
| 插件崩溃隔离 | 故意渲染期抛异常的插件（`fixtures/plugins/broken`）只坏自己那块：`[data-slot=plugin-surface-error]` 出现，rail 仍有 5 个目的地，切回环境页照常（改前整棵树会被卸载成白屏） |
| 插件存储 | `<coreDir>/plugins/<id>/` 下 `kv.json` / `data.db`（node:sqlite，WAL）/ `settings.json` / `plugin.log`；实测 migrate 建表、rpc 写读、日志可 `warren plugin logs` |
| 插件 secret 设置 | `warren plugin config com.example.notes set apiKey sk-test-123` → `plugin list` 里该设置 `value=None, configured=true`（明文只在 Vault 与插件后端之间流动） |
| host 运行时（P2） | `runtime: "host"` 的插件跑在 `utilityProcess.fork` 的子进程里：实测 `probe` 返回 `pid 75376 / node 24.21.0 / cwd / readdirSync 结果 / git rev-parse 9734a51`，host API 仍经主进程门控 |
| 插件只读命令不抢控制权 | 人持 lease 时 `plugin run com.example.notes addNote --env t1` 成功且 `env list` 里 `t1 owner` 仍是 `human`（改前每次 run 都无条件 acquire，会顶掉人并抬起输入遮罩） |
| 插件生命周期 | 开机重新激活已启用插件（状态不再停在「已启用但没跑」）；`plugin status/logs/reload/config`、`plugin run <id> --help`（从清单生成）实测可用 |
| Vault | `vault.json` 411 bytes mode 600，无明文；事件流里没有密码 |
| 遥测 | Console `info/warn/error` 三级；Network `200 / 200 / 404` 全对 |
| 标签页 | 网页里 `target=_blank` / ⌘点击 / 中键 / `window.open` / 带 features 的 `window.open` **全部落成同一 Environment 的新标签**；关掉当前标签选右边邻居；关掉最后一个 → 环境 `stopped` |
| 标签共享登录态 | 标签 1 登录后，标签 2 访问同站点返回「有登录态」（同一个 session / 代理） |
| Agent 寻址标签 | `warren tab list/new/select/close`；`warren exec <env> --tab=N`；`page.tabs()/newTab()/selectTab()/closeTab()` |
| 标签标题与图标 | 标题跟 `document.title`；图标由**主进程用环境自己的 session** 取好、转成 data URL 给渲染层（渲染层 CSP 只允许 `img-src 'self' data:`，直接给远程 URL 会被静默拦掉 → 全变地球）。无图标页退回占位图标；导航时旧图标会清掉。见 `docs/TAB-MODULE-PLAN.md` §15 |
| 遮罩只盖当前环境 | 持 t1 的 lease 时切到 t2：暗像素 13894 → 0；切回 t1 → 13894（遮罩仍在最上层） |
| 窗口里只有一个环境的页面 | `debug.layout` 的 `showing`：后台环境自己开标签后仍是 `['t1']` |
| 测试 | `npm test` 62/62；`npx tsc --noEmit` 干净 |
| 渲染层构建 | CSS 119 kB / JS 408 kB（含 UI 组件库 + Geist） |
| UI 皮肤迁移 | 侧栏从旧皮肤 RGB(13) → 新皮肤 RGB(26)，对应 `--theme-surface: #181818` |
| 桌面壳（对齐 bb） | 实测：标题行 40 / rail 44 / 侧栏卡片 260（圆角 `15px 0 0 15px`）/ 接缝 1px / 内容卡片（圆角 `0 15px 15px 0`）；三列顶行同为 36px；页面占位 `y=121` |
| 收起侧栏 | 面板 `collapse()` → 宽度 0，rail 常驻；内容卡片补上左圆角 |
| 检查器折叠 | 页面占位高度 582 → 745，`debug.layout` 的 `viewBounds` 同步跟上 |
| 地址栏导航 | 输入 `127.0.0.1:8899` + 回车 → `http://127.0.0.1:8899/`，事件流出现 `human goto … on delta` |
| 地址栏裸词 | 输入「怎么修 electron 的坑」→ 不导航、弹「这不是一个可访问的地址」（刻意不搜索，见下） |
| ⌘L | 焦点落到地址栏且全文选中（`selection 0..22`） |
| 图标库 | Tabler → Hugeicons；`<Icon name>` 语义名注册表，38 个图标；图标负载 15 kB（bundle 648 990 → 633 692 B） |
| 切环境 | `env select <未启动的环境>` → `showing` 变空、界面说「环境未启动」；切回运行中的环境页面跟着回来 |
| 停环境 | 停掉选中的环境后**选中态保留**，界面显示「环境未启动」而不是「未选择环境」 |
| 切环境后开新页 | alpha 上右键「启动」→ 接管 → `+` 新标签 → 地址栏输入 `example.com` → 跳到 `https://example.com/`，标签标题变 `Example Domain` |
| 侧栏操作 | 新建 / 重命名 / 删除（带确认对话框）/ 分组折叠展开 / 搜索过滤 / 环境与分组右键菜单，逐项实测通过 |
| 检查器 | 四个 tab 都有内容；Network 在 fixture 起着的状态下抓到 `GET http://127.0.0.1:8899/ 200 mainFrame` |
| 网络拦截 V16–V25 | **全部 PASS**（逐项实测输出在 `docs/NET-INTERCEPT-PLAN.md` §7/§8）：mock / method 过滤 / 改请求头 / 改响应头（CORS）/ 阻断 / 延迟 / 5MB+SSE 不退化 / HAR 录放 / 界面「规则」页 / `ENV_BUSY` / 命中记录脱敏；另外透传兜底（`net.fetch` 抛异常 → 502 + 事件，不是白屏）和 offline 回放也实测过 |
| 禁用态文案 | 三个导航按钮在不可用时各保留自己的名字 + 理由（`后退（环境未启动）`），不再三合一 |
| 浮层不被页面盖住 | 右键菜单压到页面区域时 `debug.layout` 的 `viewVisible` 走 `true → false → true`，`showing` 始终是 `['delta']`（视图只是不画，没被卸载） |
| 侧栏列表（平铺，不是树） | **不用 `SidebarMenuSub` 了**：环境行改成整宽平铺，没有缩进、没有左侧引导线。参考 bb nest 的顶层——它的项目行就是整宽的（左字母牌、右 count + `+` + 收起箭头），只有再往下一层才画连接线。分组只当段头（`SidebarGroup` / `SidebarGroupLabel` 还在，它们是分节容器不是树原语）。实测行 244×29（改前 195×28）、内容占满整行、行距 31 |
| 侧栏环境行（单行） | 行用产品组件库的 `ListRow`：**状态块 + 归属图标 + 环境名（14px）+ 右对齐的出口（11px）+ 行内动作**，全在一行。名字先让位、出口后让位（`shrink-0` + `max-w-[65%]`）：超长名字 + 超长代理时实测出口拿 114px、名字 46px，且不压到动作按钮 |
| 侧栏行尾只放一个动作 | 行尾**每行固定一个按钮**（跑着「停止」、停着「启动」）。这是几何决定的：动作那一簇是右对齐的，宽度一变，它左边的出口要么跟着挪、要么得留一块空位等它——实测两个按钮的行会把出口顶左 24px（261 → 237），一个按钮的行则会在出口和 ▶ 之间空出 36px。控制权（接管 / 交还）因此不在行上，它本来就在标题栏（选中那个环境）和右键菜单里。实测 6 行出口右边缘全是 261、出口到按钮的间距全是 12px |
| 侧栏行内动作的语义色 | `ListRowActionButton` 加了 `tone`：启动 `success`（绿）、停止 `destructive`（红）。底色和状态块同一套做法（`bg-current/12`，悬停 24%），颜色只有一个来源。改的是组件不是调用方：`.actionButton` 原本 `background: transparent !important` 把底色锁死了，`color` 又被未分层的模块规则压住，调用方挂 utility 改不动。规则必须写在 `.actionButton:hover` **之后**——两条特异性都是 (0,2,0)，靠源码顺序取胜。按钮是 20px + `--control-radius-icon`(10) 的正圆，状态块是 16px 圆角方块，形状本身就把「状态」和「动作」分开了 |
| 侧栏垂直节奏 | 一套尺度：**行↔行 2 / 段头↔第一行 2 / 组↔组 4**（= 分组上下各 `py-0.5`）。段头高度 `h-[var(--size-row)]`，和环境行**都是 29px**。改之前是 2 / **0** / 8——段头和第一行的盒子是贴着的，比行间距还小，顺序反了（hover 段头的底色和下面那行挨在一起）。段头那 2px 用 `mt-0.5` 而不是 `pt-0.5`：分组收起时内容被 0fr 剪掉，**padding 会留一个 2px 的底**（盒子再小也不会小于自己的 padding），margin 不会。实测：段头/行高 29/29、段头→第一行 2、行距 31、组间 4。段头还补了圆角与 hover（它本来就是个能点的控件，之前只有它没有 hover 反馈） |
| 新建 / 改名都走弹窗 | 三个弹窗：`create-environment-dialog.tsx`（环境名 / 代理 / 启动 URL）、`create-group-dialog.tsx`（分组名）、`rename-dialog.tsx`（环境与分组共用，只差标题和字段名）。原来「新建」是在列表顶上插一段原地表单（把列表整个推下去，而且和环境行长得像），「改名」是在行里插输入框——环境那个嵌在 `<button>` 里，是无效结构，名字一变长整行都在抖。现在行只剩展示。侧栏里的 `Input` 引用、`renameInput`、`commitRename` 全删了；App 那边 `draft` / `emptyDraft` / `creating` / `onDraftChange` / `onToggleCreate` 五个东西一起删掉，`create` 改成收一个填好的 `NewEnvironment` |
| 弹窗的两个坑 | ①**清空挂在 `open` 的 effect 上，不能挂 `onOpenChange`**：父组件直接改 `open` 不会回调它，只有 Esc / 遮罩 / 关闭按钮才走那条路（第一版就踩了这个，重新打开还留着上次的半截输入）。②**焦点要自己送**：base-ui 的 `initialFocus` 在这个组合下不生效（焦点会留在触发按钮上，打开后没法直接打字），`autoFocus` 更会被它的焦点管理盖掉；改成打开时 `requestAnimationFrame` 里 `ref.focus()`。实测三个弹窗打开后 `activeElement` 分别是 `#new-env-id` / `#new-group-name` / `#rename-value`（改名那个还预填了当前名字） |
| 侧栏行的状态与归属 | 状态用 `StatusMark`（`status-dot.tsx`）：16px 圆角方块，**底色随状态变**（`bg-current/15` 叠语义色），中间一颗 6px 实心点——一行里跑着的和停着的混在一起时，一块颜色比一个 6px 的点好认。行里**不写状态词**（「已停止」这类）也不写归属词，全放 `title`（`delta · 运行中 · 人工接管中 · 直连`）。归属（谁持控制权）是行内图标（`Robot` / `User`），位置在**名字之后**：放名字前面的话，AI 一接管它就把名字往右顶一截，整列名字跟着跳；放后面只顶右边那串出口，而出口本来就靠右对齐。实测接管前后 delta 名字的 x 都是 83..115，纹丝不动 |
| 侧栏「未分组」 | 以前它是 Folder 图标、点不动（没有 Group 记录）。现在和真分组一样：同一个 `ChevronRight` + `rotate-90`、同样能收起（实测 91 → 53.9 → 18.8 → 1.9 → 0px）。收起态存 `localStorage` 的 `warren.sidebar.ungroupedCollapsed`（纯界面状态，和检查器宽度同一个套路）；真分组仍以主进程的 `group.collapsed` 为准——那是持久化数据，CLI 也能改。整页 reload 后仍是收起的，实测过 |
| 侧栏行焦点环 | 行自己的 `:focus-visible` 环画在**整行**上（`.row:has(:focus-visible)`），不是画在 `.main` 上——`.main` 到动作按钮左边就结束，只画它会缺右边一块。用 `:has(:focus-visible)` 而不是 `:focus-within`（后者鼠标点一下也亮）。`.row` 是 `overflow:hidden`，所以用负 `outline-offset` 画在内侧 |
| 侧栏行内动作 | 高频动词直接放行上，不用先右键：跑着给「停止」、停着给「启动」；跑着且不是人持权才多一个「接管」，已人工接管则换成「交还」——不给用不上的按钮占位（停止的环境只有一个 ▶）。动作按钮是 `ListRowMain` 的**兄弟**节点（button 里套 button 是无效结构），实测点它不会连带选中该行（selected 不变），右键落在按钮上仍能弹菜单 |
| 插件面板间距 | 横向 gutter 从 0 改成 16（原来内容贴着面板边），纵向节奏统一 16；卡片走新的 `cardSurfaceClass`（`--radius-lg` + `border` + `p-3`），不再各处手写 `rounded-lg`/`p-2.5` |
| 设置弹窗 | rail 底部 ⚙（`[8,852,28,28]`，rail 到 912）打开；左右结构用 `Tabs orientation="vertical"`，导航列 `w-40` + 右侧分隔线，两个分节 插件 / 凭据 都实测有内容，`aria-selected` 跟着切 |
| 检查器 | 默认收起（页面区实测 1124×790 满宽）；地址行右端右栏图标（`PanelRight`）唤起，展开后 360 宽（min 260 / max 720），页面自动缩到 764，`viewBounds` 同步跟上；四个分节 事件 / 快照 / 控制台 / 网络 都有内容 |
| DevTools | 地址行 `< >` 按钮（`Code`），仅人持控制权时可用（`disabled` + 提示「需要先接管控制权」）；点了开独立窗口，`debug.layout` 的 `devToolsOpen` 走 `False → True` |
| 按钮尺寸 | 实测全部按钮：rail 28×28、环境行 28 高、导航 28×28、新建标签 28×28、收起检查器 28×28、复制 URL 28×28。**只剩标签的关闭键是 20×20**（它在 28px 的标签胶囊里，stock 就是这么定的） |
| 外部打开白名单 | `isOpenableExternalUrl` 只放行 `http/https`（页面视图的 `window.open` 全落成标签，唯一入口是侧栏菜单） |
| 配置原子写 | `save()` 写 `environments.json.tmp` 再 `rename`；`load()` 优先读 tmp，崩在 rename 之前也能恢复 |
| 组件库只剩 base-ui | `sheet.tsx` 从 `radix-ui` 改写成 `@base-ui/react/dialog`；`radix-ui` 依赖已删（14 → 12）。实测移动端抽屉开/合：⌘B 打开（backdrop + popup `data-open`，侧栏在内），关闭按钮与 `Esc` 都能收起且 portal 完全卸载 |
| 切环境不变量 | `nextViewTransition` 纯函数 + 单测：任意时刻最多一个页面视图，且属于 selected 的环境 |
| 环境名截断 | 52 字名字 → 39 字 + `…`（`ENVIRONMENT_NAME_MAX = 40`；CLI 批量建环境时截断而不报错） |
| `debug.*` 只在开发态 | `app.isPackaged` 时抛 `UNAUTHORIZED`；dev 下 `debug.layout / focusWindow / rendererEval` 照常可用 |
| 图标错名 | `Settings` / `Code` / `PanelRight` 三个名字当初不在 `ICON_MAP` 里，`Icon` 静默退成 fallback → rail 底部和地址行右端**三个按钮全是闪电**。补进注册表后实测 `data-icon` = `["Settings","Code","PanelRight"]`，全应用再无 `Zap`。`tests/icon-names.test.ts` 把「`<Icon name="…">` 必须在注册表里」钉死：故意写错一个名字，测试点名报 `name="Package2"` |
| 侧栏右键菜单不碰页面 | 菜单是 portal，默认会飘到右边的页面区域上，而页面是原生视图、压上去就被盖住，只能整页让开。现在侧栏三个右键菜单（环境行 / 移动分组子菜单 / 分组行）都传 `collisionBoundary` = 侧栏节点 + `collisionPadding=4`，菜单一开始就待在侧栏里。实测在环境行最右缘右键：菜单 `[49,273]` 全在侧栏 `[45,305]` 内、`overlapsStage=false`、`viewVisible` **保持 true**（页面照常活着）；子菜单 `[53,229]` 同样在内。全应用只有侧栏用 ContextMenu，所以右键这条路径再也不会让页面让开 |
| 对话框让位不再变黑 | 居中的对话框必然压到页面，仍然要让开；让开**之前**先 `layout:pageSnapshot` 取一帧（JPEG data URL）铺在占位区，否则露出来的是应用底色、整块页面突然变黑。实测删除确认框（`[528,912]`，压到页面区）：`viewVisible=False` + 占位区 `background-image` 41 986 字符，截图里页面在背板后面保持原样；关掉后 `background-image` 清空、`viewVisible=True`。顺带修掉「只看第一个浮层」——改成遍历所有 `data-open` 浮层，任一重叠就让位 |
| 侧栏展开收起动效 | 分组开合改走 `disclosureShellClassName` 的 `grid-template-rows 0fr↔1fr`（220ms ease-out），内容不卸载但挂 `inert`；实测收起过程 `64px → 27.2 → 4.96 → 0.46 → 0`，`inert` 跟随，再展开回到 `64px`（回收的高度实测 64px）。箭头改成单个 `ChevronRight` + `rotate-90`（`transform 0.22s`），不再是两个图标互换；环境行加 `transition-colors 0.15s` |
| 收起分组的状态点 | 收起且组内有运行环境时，计数前显示 `StatusDot`（实测 生产 收起后 `status-dot` 存在、`text-[var(--success)]`），回答「下面在跑吗」 |
| 浏览器能力全量落地 | 对标 Ego/Playwright 的能力全部落地并实测：`snapshot{scope/root/limit/actionMarks/locator}`、`screenshot{fullPage/clip/format}`、`info`、`events`、七种等待、`click/dblclick/hover/drag/fill/selectOption/focus/press/setInputFiles`、dialog accept/dismiss、popup、download+saveAs、`evaluate/fetch/cdp/clearDataForOrigin`、坐标鼠标 + 键盘（含 paste）、后台标签可读可算。详见 `docs/BROWSER-CAPABILITY-PLAN.md` |
| 能力验收实测输出 | 一次 `exec` 跑完：`snapshot 27` / `full_page 27` / `screenshot fullPage`+`clip` 非空 / `fill` 回读 `爱丽丝` / 多选 `["a","c"]` / 表单结果 `爱丽丝\|多行文本\|sh\|a,c` / `type+paste = abc粘贴` / `scrollY 200` / 七种等待全过 / `evaluate((x)=>x*3,14)=42` / 脱敏 `{ok:1,token:"[REDACTED]"}` / `cdp 允许 Runtime.evaluate` 与 `CDP_BLOCKED` / `fetch` 同站带 cookie、跨站默认 omit（`cookie:null`）/ shadow 点击 `shadow clicked` / iframe 子树 6 节点且内层按钮点击 `inner clicked` / 上传 `up.txt` / 下载落盘可读 / 拖拽 `140` / `TARGET_AMBIGUOUS` / `TARGET_STALE` |
| 写动作收据 | `click` 返回值带 `popups`（实测点一个 `window.open` 按钮：`popups:[{tabId,index:2,url}]`），保留原有 `{x,y,url}` |
| 权限/状态错误码 | 实测：后台标签输入 `TAB_NOT_VISIBLE`、后台环境输入 `ENV_NOT_VISIBLE`、窗口不在前台 `WINDOW_NOT_FOCUSED`、有未处理 dialog 时导航/求值 `DIALOG_OPEN`（不再是挂到 RPC 超时）、导航超时 `TIMEOUT` 且带 `committed/url/readyState` |
| Vault 域名名单 | `vault fill --domains=example.com` 未命中报 `PATH_DENIED` 并记事件；命中 `127.0.0.1` 放行，字段实测填入 |
| 单元测试 | `npm test` 95/95（`target`/`browser-pure` 之外新增 `refs.test.ts`、`pending.test.ts`：ref 表覆盖语义、popup/download 队列与收据；`environment.test.ts` 补 `renewLease`） |
| 代码审查 | `docs/CODE-AUDIT-2026-10-14.md`（15 条发现，Must 3 / Should 4 / Nice 8；本轮已全部修掉，见下「审查修复」） |
| 审查修复（2026-10-15） | ① **ref 表只由 agent 的快照写**：`#backendIdForAria` 与 `waitFor(text/role)` 改走 `readAxNodes()`（只读不注册），只有 agent 的 `snapshotWithRefs()` 分配 `@N`（`snapshot()` 永不碰 RefTable）。**第一版只改了内部解析、漏了 `snapshot()` 自己那次注册**，于是渲染层检查器 / 插件 API / `env.egress` 取一次快照仍会把 `@N` 重编号（实测：`@3` 从「姓名」变成「表单」，再点报 `INTERNAL: Element is not focusable` 而不是 `TARGET_STALE`），第二版改成结构性隔离——以前「snapshot 拿 `@3` → 用 `text=` 点按钮 → 再点 `@3`」会静默点到别的元素 ② **下载在环境重启后可用**：`will-download` 每 session 只挂一次、队列改成事件发生时现取（`browser/downloads.ts`），以前第二次 start 后 `downloadSaveAs` 报「未知下载」 ③ **lease 可续租**：`env.acquire` 遇到同一 owner 的未过期 lease 改为续期（leaseId 不变），CLI `exec`/`withLease`/`vault fill` 在 TTL 过半时自动续租——以前超过 60s 的脚本中途报 `ENV_NOT_LEASED` ④ 下载记录/句柄上限 50 条；`waitForFunction` 不再把 `DIALOG_OPEN` 吞成 `TIMEOUT`；收据 popup 比较改 `>=`；删死代码（`markFileChooserSeen`、`PendingSink` 空字段、`TabList.reorder`、重复 `isSameOrigin`、`browser-control.ts` 转出文件）；`shadcn` 移出运行时依赖；`--wait` 裸写默认等 30s；`exec` 的 vm 超时对齐 `WARREN_TIMEOUT_MS` |

### 运行时路径

- 运行时：`~/.warren/`（`envd.sock`、`runtime.json`，0600 + 随机 token）
- 数据：`~/Library/Application Support/Warren/core/`
  - `warren.db`（**SQLite，应用的全部结构化状态**；WAL，会带 `-wal` / `-shm`）：
    `environments` / `groups` / `events` / `running_state` / `vault`（只存密文）/
    `plugins`（注册表）/ `plugin_values`（插件 kv + 设置）/ `plugin_logs` / `console_entries` / `network_entries`
  - `plugins/<id>/data.db`（插件**自己的** SQLite：插件 API 给的是裸 SQL，分开放才能「卸载 = 删目录」+ 插件之间互不可见）
  - `*.migrated`（老 JSON 的留档：`environments.json` / `running.json` / `vault.json` / `plugins/state.json` /
    `<id>/kv.json` / `<id>/settings.json`，都可以删）
  - `plugins/<id>/plugin.log`（**不再写**，也不导入；老文件留着不管）
  - `~/.warren/runtime.json`（RPC 会合文件：socket 路径 + token，不是应用数据，CLI 靠它发现核心）
- 环境变量：
  - `WARREN_TIMEOUT_MS`（CLI RPC 超时，默认 60s）
  - `WARREN_MAX_RUNNING`（同时运行的环境上限，默认 **8**，`0` = 不限；超了按 LRU 回收最久没用过的，
    见 §6「稳定性」）
  - `WARREN_IDLE_MS`（环境闲置多久进休眠，默认 **600000** = 10 分钟，`0` = 关掉自动休眠；
    扫描间隔 30s，见 §6「休眠与激活」）
  - `WARREN_RESTORE=0`（关掉崩溃恢复；回归套件要确定性时用它）

### 稳定性（2026-10-16，PRD M5）

### Cookie 受控通道 + sandbox 异步时限（2026-10-16，批次 D）

**Cookie：只搬运不返回**（设计：`docs/PLUGIN-CAPABILITY-DESIGN.md` §9）。
新权限 `storage.cookie.port`（**confirm** 层），四条 API：

| API | 方向 | 回什么 |
|---|---|---|
| `host.cookie.names({ url? })` | 读元数据 | 名字 / 域 / 路径 / secure / httpOnly / session / 过期 —— **没有值** |
| `host.cookie.copy({ from, to, domain?, name? })` | 环境 → 环境，值不离开主进程 | `{ copied, names }` |
| `host.cookie.import({ cookies: [...] })` | 插件 → 环境（值是插件给的） | `{ written, names }` |
| `host.cookie.clear({ domain?, name? })` | 删 | `{ removed }` |

写操作惰性取 lease。`storage.cookie.read` / `write` **仍然 denied**（有单测钉住这个姿态）。
实现：`browser/cookies.ts`（`summarize` 是**显式字段白名单**，不是 `delete value`）、
`environments.ts` 的四个方法（Session 对象不外泄）、`plugins/api.ts` 的门控。
样例插件 `plugins/example-cookies/`。

实测：cap 里种 `warren_session`（fixture 的 `/cap/api/cookie`）→ `report` 只回元数据 →
`copyFrom` 到 ck2 回 `{copied:1,names:["warren_session"]}` → ck2 的 `report` 里也有它 →
`clear` 回 `{removed:1}`；**整条流程的输出里 `grep super-secret-value` = 0**。
套件里是 16.1–16.5 五条检查。

**sandbox 插件的异步时限**：`node:vm` 的 timeout 只覆盖模块求值，插件的 `await` 链不受它管
——一个 `await new Promise(() => {})` 就能让 core 一直等。现在每次调用（命令 / rpc / activate /
dispose）都套 `Promise.race` 上限，默认 **30s**，`WARREN_PLUGIN_TIMEOUT_MS` 可调，超时报
`PLUGIN_TIMEOUT` 并记一条插件日志。host 运行时的 `#invoke` 也带同一条上限（超时顺手摘掉 pending，
免得多记一条永远不 settle 的等待）。
**这不是强隔离**：超时只把控制权还给调用方，插件那个 Promise 还在跑（vm 里没法取消）——
要能真杀掉用 `runtime: "host"`。
实测（`WARREN_PLUGIN_TIMEOUT_MS=2000`）：`plugin run com.example.hangs forever` **2.04s**
报 `PLUGIN_TIMEOUT`（改前是挂到 RPC 60s 超时），普通命令不受影响，日志里有那条错误。
fixture：`fixtures/plugins/hangs/`。

**顺带**：`warren plugin run <id> <command> --env=<env> [--input='{"k":1}']` —— 命令终于能收参数了
（以前 `ctx.input` 恒为 undefined，插件命令没法带参数）。

### 遥测写库的开销：量过了，**不用改**（2026-10-16）

遥测是**每条请求/每条日志一把同步 INSERT**（WAL），这是主进程里的真实开销，而「诊断把被观察的
东西拖慢」正是这个仓库最讨厌的那类问题，所以量了一遍：

```bash
# fixtures/capability/burst.html?n=500 —— 并发打 500 个请求
node bin/warren.mjs exec cap   # → burst 500 in 58ms
node bin/warren.mjs call debug.layout --json | …telemetryWrite…
# → writes 504 / ms 37.23 → **每条 0.074ms**
```

结论：500 个请求总共吃掉主进程 **37ms**（页面自己 58ms 跑完，说明主进程不是瓶颈），
一个正常页面（几十个请求）是毫秒级——**不值得为它改成批量写**（那会引入「崩了就丢一批」的新问题）。
`debug.layout` 里留了 `telemetryWrite {writes, ms}`，以后变慢了能立刻看出来。
顺带守住了另一条：洪流不会把表撑爆（每标签留最近 300 条，browser.sh 23.2/23.3）。

### 跨源 iframe（OOPIF，2026-10-16）

**做完了**：跨源 iframe 里的元素现在**看得见、点得中、能填、弹窗也能处理**。
`scripts/regress/capability.sh` 的 V5b（原来唯一那条 FAIL）转绿，另加 V5d / V5e 两条。

机制（对标 Playwright 的 per-frame session）：

1. `session.ts` 在 attach 时对页面会话发 `Target.setAutoAttach {autoAttach, waitForDebuggerOnStart:false, flatten:true}`，
   从 `Target.attachedToTarget` 收子会话（`ChildSession`），并**在子会话里**问出它自己的根 frame id。
2. `readAxFrames` 除了主会话的 frame 树，还把每个子会话的 `Accessibility.getFullAXTree` 合并进来
   （跨源 frame **不在**主会话的 `Page.getFrameTree` 里），每帧带上 `sessionId`。
3. 目标解析（`resolveTarget`）把「backendNodeId + 它属于哪个会话」一起解析出来，
   之后 `nodeIdFor` / `evalOnNode` / `scrollIntoView` / `boxCenter` / `checkActionable` /
   `DOM.focus` / `setFileInputFiles` 全部带着会话走。
4. **坐标**：子会话的盒模型是**子 frame 自己视口**里的，要加 owner iframe 元素的内容盒左上角
   （`frameOffsetFor`）。实测 delta = 0（见 `debug.point`）。
5. 主 frame 一开始导航就 `clearChildSessions()`——子 frame 是**导航过程中** attach 上来的，
   导航结束后再清会把刚拿到的会话丢掉（上一版就死在这）。

新增 dev-only 诊断 **`debug.point {id, target}`**：把「我们算的点击点」和「页面自己算的点」
并排返回。跨源坐标算错是**不报错**的（点偏了页面没反应），而输入类命令又要求窗口在前台——
这条诊断让坐标换算不用真点击就能验。

**新踩的坑**（都写进 §7）：空 session id、AX 缓存里的死会话、跨源 dialog 走主会话。

**持久化全部收进 SQLite（2026-10-16）**：`<coreDir>/warren.db` 是**应用唯一的结构化存储**，
一个进程一条连接（`db.ts` 的 `openDatabase` 按路径复用；`journal_mode=WAL` + `busy_timeout=5000`）。
十张表：

| 表 | 以前是什么 |
|---|---|
| `environments` / `groups` | `environments.json`（整份读写） |
| `events` | 主进程内存里的 500 条环形缓冲（重启即清空） |
| `running_state` | `running.json` |
| `vault` | `vault.json`（**只存 safeStorage 密文**，明文从不落盘） |
| `plugins` | `plugins/state.json`（注册表：enabled / granted / installs） |
| `plugin_values` | 每插件的 `kv.json`（scope=kv）与 `settings.json`（scope=setting） |
| `plugin_logs` | 每插件的 `plugin.log`（要自己按 512KB 截尾；现在按插件留最近 500 条） |
| `console_entries` / `network_entries` | 主进程内存里的两个 300 条环形缓冲（重启即清空） |

**故意没搬的两处**（都不是「JSON vs SQLite」问题）：
`plugins/<id>/data.db`（插件拥有的 schema，隔离 + 「卸载 = 删目录」）和
`~/.warren/runtime.json`（RPC 会合文件，CLI 靠它发现核心，挪进库反而更难找）。

- **一次性导入**：每处都是「表里空着才读老文件」，导完把老文件改名成 `*.migrated`
  **留档而不是删除**（迁错了还能人工捞回来）；表里非空时绝不回头吃老文件，
  否则删掉的凭据 / 卸载掉的插件会在下次启动时复活（`tests/store.test.ts` 钉住了这条）。
  导入复用老的 `migrate()`：补齐 `order`、重算悬空的 `storagePath`、把指向不存在分组的环境捞回未分组。
- 事件保留最近 5000 条（清理按批做，实际最多到 5099）；console / network 每标签留最近 300 条，
  **环境停止时清空**（面板是「这一轮页面干了什么」，不是永久档案）。
- 卸载插件会连带删掉它的 `plugin_values` / `plugin_logs` 行（重装不会带着上一份状态复活）。
- 顺带修掉安装路径上的一个真问题：`cp` 会把源目录里的 `data.db` 一起拷进安装目录、
  覆盖掉已装插件的数据（原来的「回头再删」循环第一句就 `continue` 掉了运行时文件，等于没删）→
  改成 `cp` 带 `filter` 只拷代码。
- 实测（一轮）：旧库被识别 → 事件 `已从 environments.json 迁移 1 个环境 / 0 个分组到 SQLite` →
  `environments.json.migrated` + `running.json.migrated` + `warren.db` 同时存在；
  `kill -9` 后重启，环境自己回来**且上一轮的事件还在**。
- 实测（二轮，全量收口）：`plugins/state.json`（3 个插件 + granted + installs）→ `plugins` 表，
  `plugin list` 状态不变（hosty / notes running、broken disabled）；
  `kv.json` / `settings.json` → `plugin_values`（`lastText` / `title=架构统一标题` / `filter=all`），
  老的三个文件都变成 `*.migrated`；`plugin logs` 改读表仍能读到「已就绪 / activated」；
  `vault add` 之后 `vault` 表里只有 92 字节密文（`select count(*) ... like '%明文%'` = 0），`vault.json.migrated` 出现；
  console / network 摘要落进两张表（`browser console/network` 读得到），`warren.db` 里 10 张表齐全。
  卸载 `com.example.broken` → `plugins` / `plugin_logs` 行同时归零，重装后回到「已装 + disabled」。
- 迁移相关的单测：老 JSON 只导入一次（库里非空时绝不回头吃老文件）、事件跨实例可读、事件表封顶、
  导入时 tmp 优先（崩溃恢复）、`.migrated` 留档。

**LRU 回收**：起新环境之前，如果同时运行的环境数会超 `WARREN_MAX_RUNNING`，按「最后一次被用到」回收最久没用过的。
“被用到”＝选中 / 取租约 / 任何 agent 操作（都会经过 `controllerFor`）。
**两条硬排除：当前选中的、还持着未过期租约的**——回收正在被 agent 操作的环境会直接打断它那一轮，
比内存吃紧严重得多；可回收的挑不够就**宁可超限**。被回收的环境就是 `stopped`，记一条 `env.evicted`。
纯函数 `pickEvictions` 在 `domain/environment.ts`（有单测）。
实测：`WARREN_MAX_RUNNING=2` 下跑 a1/a2 → 起 a3 时 a1 被回收、`running` 保持 2；
持租约的 a4 + 选中的 a1 都在时起 a2 → `running: 3`（两个都没动）。

**休眠与激活（2026-11-03）**：环境多一个 `dormant` 状态。`WARREN_IDLE_MS` 到点后主进程每 30s 扫一次，
把**非选中 / 非持租约 / 非 busy（加载中、有声音、录 HAR、回放）**的环境放进休眠：销毁全部
`WebContentsView`（renderer 进程随之回收），但保留 `#sessions`（登录态 / 代理 / CA）、`env_tabs`
标签快照与配置。`dormant` 列表落在 `warren.db` 的 `dormant_state` 表，**崩溃恢复不会把它当 running 拉起**。

激活是透明的：`rpc-dispatch.ts` 对 `browser.* / tab.* / net.* / extension.* / evidence.* / vault.fill`
和 `env.start / env.select / env.acquire / …` 在调用前先 `wake()`（同步按快照重建视图），
`env.list / env.get / events.list / debug.*` 等纯读命令不唤醒。也有显式
`warren env hibernate|wake <name>`。纯函数 `pickDormant` 在 `domain/environment.ts`（有单测）。

**边界**：唤醒会重新加载页面，JS 状态 / 未提交表单 / POST 结果不保留（与 `stop → start` 一致）；
`hibernate` 绝不碰 `clearStorageData`；持租约判据用 `#hasLiveLease`（TTL 60s，长脚本靠 renew）。

**崩溃恢复**：`running.json` 记「现在哪些在跑 + 上次选中」。**正常退出会把它写成空的**
（`before-quit` → `shutdown()` → 逐个 `stop()`），所以只有被 `kill -9` / 崩掉才会恢复。
恢复 `env_tabs`（见下）里那一组标签。
`WARREN_RESTORE=0` 关掉。实测：`pkill -9` 后重启，a4/a1/a2 自己回来 + 事件 `崩溃恢复：拉起 …`；
`debug.quit` 之后重启则一个都不拉起。注意 `running.json` 是**同步写**的：退出路径上发异步写根本来不及落盘。

**标签持久化（2026-10-16）**：每个环境的标签组落在 `warren.db` 的 `env_tabs`（位置 / URL / 激活位），
标签一变就写（**去重过**：标题 / 图标 / 加载态变化不写库，标签表只记 URL 与激活位）。
`env start` 时**先把上次那一组开回来**，没有记录才退回 `startUrl` / 新标签页。
`env stop` 不清（停再起要把标签带回来），`env remove` 连带删（否则 id 复用时会把别人的标签开回来）。

| 场景 | 实测输出 |
|---|---|
| 停再起 | 开 3 个标签、切到第 2 个 → `env stop` → 库里 3 行（`active` 只有第 2 行是 1）→ `env start` → 3 个标签回来且**第 2 个还是激活的**（core.sh 2.6/2.7） |
| 崩溃恢复 | 同样 3 个标签时 `kill -9` → 重启 → `崩溃恢复：拉起 tabsdemo` + **3 个标签和激活位一起回来** |

**只记 URL，不记标题 / 图标 / 滚动位置**：那些跟着页面重新加载。
**POST 过的页面恢复不了**（浏览器本来就这样）——恢复出来的是那个地址的干净页面。

**退出清理**：原来「退出不 kill 辅助进程」这条**已经不成立**（`shutdown()` 现在逐个 `stop()`）。
实测 3 个环境运行时，退出前 11 个进程 → `debug.quit` 之后 0 个。新增 dev-only 的 `debug.quit` 专门用来测这条。

### 静态门与 CI（2026-10-16）

原来「改完必须手跑三条命令」全靠人记。现在补齐：

| 项 | 结果 |
|---|---|
| lint | 用 **oxlint**（`npm run lint`，`--deny-warnings`）。**不是 eslint**：`typescript-eslint` 硬拒绝本项目的 TypeScript 7.0.2（原生预览版），装上直接报 `typescript-eslint does not support TS 7.0`。配置在 `.oxlintrc.json`，**版本钉死 1.88.0**（新版本会加新规则，让 CI 无故变红）。默认只开 correctness 一类；`react` / `jsx-a11y` 插件**还没开**（会报出一批 React 19 纯度与 a11y 问题，要单独一轮重构）。顺手修掉它报的 5 处真问题：`policy.ts` 多余转义、`pending.ts` 的 `this` 别名、两个没人用的 import、`alert-dialog.tsx` 没用上的 `size` 参数 |
| CI | `.github/workflows/ci.yml`：push / PR 上跑 `lint → typecheck → test → 渲染层构建`。**GUI 回归套件不在 CI 里**——它要求应用在跑、窗口拿到前台焦点，CI runner 没有窗口会话（见坑 36） |
| 新增单测 | `npm test` **151 → 164**。新增 `tests/plugin-registry.test.ts`（注册表 / 日志 / 老 `state.json` 只导一次 + `.migrated` 留档）、`tests/rpc-gating.test.ts`、`browser-pure` 补 `redactSecrets`（脱敏不误伤、不改原对象） |
| 写门控守卫 | `tests/rpc-gating.test.ts` 读 `rpc.ts` 源码，断言 `browser.*` / `net.*` / `tab.*` 里**没挂 `writeCall`/`inputCall`/`dialogCall`/`assertWritable` 的命令必须在只读白名单里**。`rpc.ts` 顶部 import 了 electron，运行时单测加载不了，所以用源码断言（同 `icon-names.test.ts` 的路数）。RED 实测：把 `browser.click` 的 `inputCall` 换成 `invoke` → 该用例红；还原 → 绿 |

**格式化**：prettier（`npm run format` / `format:check`，`printWidth: 120` + 单引号），已全仓跑过一次。
`.prettierignore` 排掉镜像上游 `web-next` 的路径、`fixtures/`、`docs/` 与 `*.md`——理由见 AGENTS.md。

**react / jsx-a11y 插件已开**（`--deny-warnings` 下全绿）。两轮：

1. 修掉 ref 在渲染期赋值（`environment-stage` 的 `inspectorWidthRef`、`plugin-runtime` 的
   `usePluginSignal`）、`Date.now()` 在渲染期读时钟（倒计时，留了行内说明）、`exhaustive-deps`
   （`App.tsx` 的侧栏宽度 effect）、`surface-tab` 的 `role="tab"` 改成无条件。
2. **`react/set-state-in-effect` 的 11 处全部重构**（这条规则现在开着，别再退回 effect + setState）：
   - **能派生的就派生**：插件面失效（删掉 `activePage` state，改由 `requestedPage` + 查找派生）、
     快照归属（`snapshotOf = {envId, data}`）、遥测归属（5 个 state 打成一个带 `envId` 的
     `telemetry`）、地址栏草稿（那个 effect 本来就是**死代码**——输入框一直是 `value={editing ? draft : url}`）
   - **打开时重置**：三个弹窗改成渲染期重置（React 官方的「prop 变了就重置 state」写法），
     比 effect 版少一轮「先渲染上次的半截输入再纠正」
   - **拉数据**：`async` 函数定义在 effect **里面**（外面定义的会被这条规则判成同步 setState）；
     `use-mobile` 换成 `useSyncExternalStore`（matchMedia 本来就是外部数据源，顺带去掉首帧的 false 闪烁）
   - **顺带删掉一个多余的机制**：`EnvironmentManager` 每个变更方法都会 `#onChange()` →
     `state:changed`，所以 `App.tsx` 里「操作完手动 `await refresh()`」是冗余的，`refresh` 已删，
     统一走 `stateTick` 重取
   - `prefer-tag-over-role` 改成**行内豁免**（5 处，各带理由），规则本身开着——以后真该换语义标签
     的地方仍会被提醒

**RPC 写门控现在有两层测试**（2026-10-16）：派发表从 `rpc.ts` 拆到 `rpc-dispatch.ts`——它只依赖类型
和两个无 electron 的纯模块，`isPackaged` / `quit` 改成值注入，于是 `tests/rpc-dispatch.test.ts`
能喂一个假 manager 把门控真跑一遍：没租约 / 租约过期 / leaseId 不对三种都拒、被拒时**不碰 controller
也不读凭据**、`vault.fill` 域名名单外记事件且不填、打包后 `debug.*` 报 `UNAUTHORIZED`。
RED 实测：把 `inputCall` 里的 `assertWritable` 摘掉 → 3 条红；还原 → 绿。
`tests/rpc-gating.test.ts` 是同一件事的静态版本（盯着派发表里每个 case 有没有挂门控），
两个一起看：静态守卫管「新加的方法忘了挂门控」，运行时管「挂上去真的拦得住」。

### 体验走查后的修复（2026-10-17）

真机走查（重启到干净状态 → 按 PRD 用户流程逐段操作 → 截图 + `debug.rendererEval` 读 DOM）后修的一批：

| 问题 | 根因 / 改法 |
|---|---|
| **切到插件页再切回，原生页面视图永久不再跟随尺寸** | `App.tsx` 把 `<EnvironmentStage>` 放在三元表达式里 → 切插件页时 `stage-placeholder` 卸载重挂载，而 viewport effect `deps: []` 只跑一次，ResizeObserver 盯着**脱离文档的旧节点**。实测：收起侧栏后 DOM 占位区 1384px、主进程 viewport 还停在 1124px（页面左边露 260px 空白）；展开检查器时页面视图把检查器那 360px **整个盖住**。改法：effect 依赖 `pluginPageOpen` |
| **页面加载失败 = 界面显示「运行中」** | `TabState` 加 `error`：`tabs.ts` 的 `did-fail-load`（**只认主框架**）写进去、`did-start-loading` 清掉；`Environment.error` 从**激活标签**派生。实测 `env create deadenv --start-url=http://127.0.0.1:9/nope` → `env list` 是 `! deadenv … 页面加载失败: ERR_UNSAFE_PORT (-312)`，标题栏说「页面加载失败」、侧栏状态块变红。**status 故意不动**——改成 error 会让界面把停止按钮换成启动、遥测停止轮询 |
| 侧栏收起时空态提示指向不存在的按钮 | `EnvironmentStage` 多收一个 `sidebarCollapsed`，收起时改说「点左上角 ☰ 展开侧栏，再点环境行上的 ▶」 |
| 侧栏行看不到「当前页面标题」 | 行里加 `env.title`（PRD 7.2）；**必须带 `shrink-[100]`**——它是这一行优先级最低的信息，默认的 `flex-shrink: 1` 会把环境名挤成 `c...`（实测踩过） |
| 「停止」按钮红色过重 | 去掉 `tone="destructive"`（常规操作不该配危险色） |
| 接管状态视觉权重不足 | 标题栏归属文字：有主时 `font-medium text-foreground`，空闲仍是 muted |
| 弹窗打开时页面快照糊 | `capturePage` 的 JPEG 80 → 92 |
| 回归跑完留下 5 个同名标签 | 标签是**持久化**的（`env_tabs`），不清会被带进下次 `env start`。`run-all.sh` 末尾收成一个 |
| 同名标签的关闭按钮读屏分不清 | `closeLabel` 带序号（`关闭第 3 个标签：…`） |

**两个新增能力**：

- **检查器多一页「存储」**（PRD 7.4）：cookie 的**名字 / 域 / 过期 / secure / httpOnly**，**没有值**（复用 `CookieSummary` 那条窄通道）。按需读——切到那一页才查一次，不跟遥测轮询。RPC/IPC 是 `browser:cookies`。`CookieSummary` 从 `browser/cookies.ts` 搬到 `shared/types.ts`（跨进程类型单一来源），老路径转出。
- **`headed` 终于有语义**：= 「启动后自动把界面切到这个环境」。以前是只存不用的死字段（数据模型 / preload / RPC 都有，UI 和 CLI 都没入口）。现在 `start()` 里 `if (config.headed) this.select(id)`；CLI 是 `--headed=false`（`env create` / `env update` 都收），新建弹窗里是个 Switch。默认 true = 行为不变。

**没做**：PRD 6.1 的「存储模式（持久化 / 临时）」。它是新功能不是修 bug，而且「临时」= **停环境时删 session 目录**，牵扯数据删除和 Electron session 生命周期（`#sessions` 缓存要不要一起清、用不用 `clearStorageData`），语义（停就删 vs 删环境才删）得先定。要做单开一轮。

### 未做 / 受阻

0. **网络拦截的两条已知偏差 / 未做**（细节见 `docs/NET-INTERCEPT-PLAN.md` §4.3、§7 N2）：
   - **挂了 `protocol.handle` 就跳过 CORS 检查**（整个 session，不只是命中的请求）。实测：
     一条启用规则都没有时不挂 handler → 跨源无 ACAO 请求报 `CORS_ERR:Failed to fetch`；
     挂着 handler 时同样的请求 `OK:200 acao=null`（页面读得到 body）。现在靠「没有启用规则
     （也不在录 HAR）就不挂 handler」把偏差收窄到「规则开着的时候」。要彻底消掉得把「只改头」
     改用 `webRequest`（走正常网络栈），那时协议层只负责 mock / 阻断。
   - **`net passthrough <env> <url> [--for=30s]` 没做**（计划 §4.1 里的临时放行）：
     要引入「带过期的规则」，V16–V25 都不需要它。

1. ~~Cookie 管理插件做不了~~ —— **2026-10-16 做了**：`storage.cookie.port`（只搬运不返回，confirm 层）
   + `plugins/example-cookies/` 样例。宽形状的 read / write 仍然 denied，见 §6「Cookie 受控通道」。
2. ~~sandbox 插件的异步执行仍无时限~~ —— **2026-10-16 做了**：每次调用套 `Promise.race` 上限
   （默认 30s，`WARREN_PLUGIN_TIMEOUT_MS` 可调），超时报 `PLUGIN_TIMEOUT`。
   **仍然不是强隔离**（超时不会杀掉插件那个 Promise），真要隔离用 `runtime: "host"`。
3. ~~环境数量无上限、无 LRU 休眠~~ —— **已做**（`WARREN_MAX_RUNNING`，默认 8，见 §6「稳定性」）。
4. ~~退出不 kill Electron 辅助进程~~ —— **实测已不成立**（`shutdown()` 逐个 `stop()`；退出前后 11 → 0 个进程，见 §6「稳定性」）。
5. ~~遥测缓冲在主进程内存~~ —— **已落盘**（`console_entries` / `network_entries`，每标签留最近 300 条；
   环境停止时清空）。仍然只在内存里的是「每标签最后一次网络活动」（`networkidle` 的空闲窗口判据，
   那是活的信号，不是要持久化的状态）。
6. **点击依赖 `DOM.scrollIntoViewIfNeeded`** —— 视口外元素会先滚进来。
7. ~~CDP 输入只对「正在显示」的环境生效~~ —— **2026-10-16 解决**：输入类操作会**临时把目标环境的
   视图附到窗口最底层**（页面因此自报 `visible`，CDP 输入落得进去），用完摘掉 + 把焦点还给显示中的那个。
   实测：后台环境 `page.click` / `fill` / `press` 全部生效，而 `showing` 始终是显示中的那个环境、
   操作完 `attachedBelow` 为空、`focusedEnv` 仍是显示中的环境。**唯一的例外**：界面上有浮层
   压着页面区域（`viewVisible=false`）时**拒绝**后台操作（否则挂在底层的页面会从浮层下面露出来）——
   这时报的还是 `ENV_NOT_VISIBLE`，消息说明原因。
    - 补充（浏览器能力全量落地时实测）：**窗口不在前台时输入同样会被丢掉**（macOS）。现在输入类操作会显式报 `WINDOW_NOT_FOCUSED`，而不是静默点空。`acceptDialog/dismissDialog` 不受这条限制——它们是浏览器侧命令，否则 dialog 卡住时连自救都做不到。
8. **弹窗拦截没做** —— 无用户手势的 `window.open` 在真 Chrome 里会被拦，我们照样开标签。这是记录在案的偏离。
9. **`new-window`（Shift+点击 / 带 features 的 `window.open`）收敛成了标签**，不是新窗口。这也是记录在案的偏离：真 Chrome 是新窗口，但多开 OS 窗口会跳出右侧区域、遮罩盖不住。
10. **桌面壳迁移（对齐 bb 形态）已落地** —— 设计与偏差记录见 `docs/DESKTOP-SHELL-MIGRATION.md`。两处对外接口已经改了，接手时注意：
    - `NavigationAction` 从字符串联合改成**可辨识联合**（`{kind:'goto'; url}` 等），`humanNavigate(id, action)` 的签名随之变化；渲染层、preload、`main.ts` 的 IPC 都跟着改了。
    - 图标库换成 Hugeicons：`components/icons.tsx` 不再导出 `XxxIcon` 组件，改成 `<Icon name="PanelLeft" />`。**加图标只改这一个文件的 `ICON_MAP`。**
    - 地址栏**不做搜索引擎兜底**：解析不出地址就报错，不把裸词发给默认引擎。这是刻意的偏离（隔离身份浏览器不该拿这个环境的出口去泄露身份），不要"顺手修好"。
11. **`window.prompt()` 在 Electron 里不可用** —— `typeof prompt === 'function'` 但调用即抛（实测），所以 prompt 型 dialog 永远捕获不到。`acceptDialog(promptText)` 的代码路径保留（真 Chrome / 未来 Electron 版本可用），但**验收时别拿 prompt 当用例**。alert / confirm 正常。
12. **`keyboard.paste` 不是真粘贴** —— Chromium 的粘贴是**浏览器侧**行为，CDP 合成的 ⌘V 在 Electron 里不会触发它（实测：按键发出、命令成功、页面毫无变化）。所以 `paste` 直接插内容（文本走 `Input.insertText`，富文本走页面内 `execCommand('insertHTML')`），**不触发页面的 `paste` 事件**，也不碰用户系统剪贴板。要真粘贴得走原生菜单加速器，另说。
13. **`waitForFileChooser` 是轮询 `input[type=file]`** —— Electron 没有原生 fileChooser 事件，实现=等该元素 attached。动态插入的 input 可用（实测）；但「点按钮后浏览器自己弹出选择框」这种场景探不到，用 `setInputFiles` 更稳。
14. **`page.cdp` 的返回是原始 CDP 结构** —— `Runtime.evaluate` 在 `returnByValue: true` 下遇到函数只回 `{type:'function', value:{}}`、**不带 objectId**（实测）。要拿引用得再发一次不带 returnByValue 的调用（`controller.evaluate` 已经这么做了，直接用 `page.evaluate` 即可）。
11. ~~`⌘⇧T` 重新打开刚关掉的标签~~ —— **2026-10-16 做了**（`TabManager` 维护最近关闭栈，深度 10；
    环境整体停掉不入栈）。标签那一摊至此收口。
    **两个明确不做的**（不是「还没做」）：
    - **右侧 secondary panel**：`DESKTOP-SHELL-MIGRATION.md` §8 定的非目标，也别加点了没反应的占位按钮。
    - **rail 60px 档位**：那是**触屏**档（36+24=60），本应用没有触屏场景；窄窗断点也够不到（`minWidth: 1024`）。
12. **移动端抽屉（`Sheet`）在本应用里不可达** —— `EnvironmentSidebar` 传 `collapsible="none"`，而 `Sidebar` 里 `collapsible === "none"` 的分支排在 `isMobile` 判断**之前**就 return 了，所以窄窗下侧栏仍是固定 260 面板，不会变抽屉。窗口 `minWidth: 1024` 也够不到 768 断点，所以没改。（`sheet.tsx` 本身已实测可用，见上表。）
13. **2026-11-27 外壳交互细修 + 无头测试体系落地**：
    - 浅色模式 Tooltip 修复黑底黑字（`tooltip.tsx` 改用 `text-tooltip-foreground`，`theme-tokens.css` 补齐 `prefers-reduced-transparency` 配对与 `sideOffset=8`）。
    - 彻底解决多标签 + Agent 控制胶囊横向溢出导致整页左偏与红绿灯重叠（`App.tsx` 改 `overflow-clip` + `min-w-0`，`app-titlebar.tsx` / `environment-tabstrip.tsx` 补齐溢出约束与激活标签自动 `scrollIntoView`）。
    - 壳层背景色统一为 `bg-surface-under`（Row 1 / Row 2 地址栏 / 侧栏 / WebView 四周统一），简化冗余分割线与双边缝；新增 `--chrome-field-fill` 与 `--shadow-chip`（全库标签/切换滑块/outline 按钮四边边框均匀，消除双层顶边）；`SurfaceTab` 修正带图标可关闭标签误加 `pr-1` 导致的左右不对称。
    - 地址栏历史联想浮层支持动态最小/最大高度（`src/shared/popover-sizing.ts` + `ResizeObserver` + `handleShell('popover:update')`，无底部空白死区、超 320px 滚动），并修复 macOS 非聚焦子窗鼠标悬停高亮（`PopoverHost` 32ms 光标桥接 + `openPopover`/`updatePopover` 分离）及 `⌘L` (`focusAddress`) 切回主窗渲染层焦点。
    - 侧栏环境行重构为 28×28 身份徽章 + `1px` 紧凑双行距（`list-row.module.css` 支持 `--list-row-body-gap` / `--list-row-gap`），修正浅色选中行状态点 `ring-surface-selected-solid`。
    - **测试分层与无头化**：默认禁用 `scripts/regress/run-all.sh`（需显式 `--allow-full` 或 `WARREN_ALLOW_FULL_REGRESS=1`），CI `gui-regression` 改为 `workflow_dispatch` 手动触发；新增 Vitest + happy-dom 无头 React UI 测试套件（`vitest.config.ts`、`tests/ui/*.test.tsx`）与改动定向运行器 `scripts/test-changed.mjs`（`npm run test:changed` / `npm run test:ui` / `npm run check:changed`）。

---

## 7. 踩过的坑（含确切报错，别重复踩）

1. **Forge/Vite 入口 basename 撞车** —— `src/main/index.ts` 与 `src/preload/index.ts` 都产出 `.vite/build/index.cjs`，一个静默覆盖另一个，app 启动无 main script。→ 重命名 `main.ts` / `preload.ts`。

2. **CDP DOM 域报 `Document needs to be requested first`** —— `DOM.pushNodesByBackendIdsToFrontend` 失败。→ 每次 DOM 操作前先 `DOM.getDocument`。

3. **点击落在视图外且不报错** —— 静默失败最难查。→ 点击前 `scrollIntoViewIfNeeded`。

4. **lease 泄漏** —— `process.on('exit')` 里发不出异步请求，`alpha` 一直显示 `[agent]`。→ 改为 `try/finally` 里 `await call('env.release', ...)`。

5. **TypeScript 7 拒绝 `baseUrl`** → 从 tsconfig 移除，`paths` 改为 tsconfig 相对。

6. **`webRequest` 过滤器 `'*'` 抛 `Invalid url pattern *: Missing scheme separator`** —— 这是 URL 模式不是 glob。它从 `Telemetry.attach` 抛出，打断 `manager.start()`，导致视图建了但没初始化完，**之后所有 CDP 调用不是报错而是永久挂住**。→ 改 `<all_urls>`，并把遥测整体包进 try/catch。**诊断层永远不能弄坏它观察的东西。**

7. **CLI RPC 无超时** —— 上述挂起把 agent 回合挂死 300 秒。→ 加默认 60s 超时 + 独立 `TIMEOUT` 错误码。

8. **重启未生效假象** —— `pkill` 后新实例因 Vite 端口 5173 被占直接退出，日志里没第一时间看到，症状是「改了代码没反应」。→ 固定清理步骤：`pkill` + 杀 5173 占用 + 删 socket + **确认进程数 0** 再启动。

9. **shadcn CLI 产物问题（官方 registry 也有）** —— 每个文件 `import { cn } from "cn"`（裸 specifier）→ 改 `@/lib/utils`；`sonner.tsx` 引未安装的 `next-themes` 且带 `"use client"`；CLI 把 `cn` / `next-themes` 塞进 `dependencies`。

10. **`setWindowOpenHandler` 的 `createWindow` 有三条硬约束**（都实测过，违反会卡死主进程）：① handler 必须**同步**返回；② `createWindow` 必须**复用** Electron 给的 `opts.webContents` —— 自己 `new WebContentsView()` 再返回，页面的 `window.open()` 会把主进程卡死（连兜底定时器都不跑）；③ `background-tab` / `new-window` 时 `opts.webContents` **可能是 undefined**，要自己建 view 并手动 `loadURL(details.url)`。另外：Electron 返回的 guest **不会自动导航**（实测 URL 为空）。

11. **`session.webRequest` 每个 session 只有一个监听器** —— 后注册的覆盖先注册的，传 `null` 整体解绑。多标签共用一个 session，所以遥测改成「每个 session 只注册一次 + 回调里按 `webContentsId` 反查标签」。

12. **页面 `window.close()` 会真的销毁 webContents** —— 之后 `view.webContents` 变成 `undefined`（`preventDefault()` 拦不住），再访问就抛 TypeError。→ 把它当成「标签被关闭」走统一的移除路径，之后绝不再碰 `view.webContents`。

13. **后台环境开标签会把视图盖到当前页面上** —— `addChildView` 是后加的在上面，后台环境的 `#showActive()` 一跑就把它的视图加到窗口最后。→ `TabManager` 用 `#visible` 门控：没显示就绝不往窗口里加视图。`debug.layout` 的 `showing` 字段就是这条不变量的断言。

14. ~~**输入事件需要「窗口真的在前台」**~~ **（2026-10-21 已推翻，2026-11-27 切为原生 `win.hide()`）** —— 失焦/隐藏窗口里 CDP 输入仍能落地。现在不再调 `debug.focusWindow`，也不调会激活窗口的 `wc.focus()`；`ensureOperable()` 把后台视图临时挂到最底层，输入与后台截图路径统一用 `Emulation.setFocusEmulationEnabled` 补 `document.hasFocus()` 并唤醒 Blink 合成器（2026-11-27 已彻底清除 `-10000` 离屏停放和 `debug.backgroundWindow`）。回归脚本不得抢用户前台。**2026-11-03 起默认连窗口位置/可见性都不碰**：`WARREN_REGRESS_WINDOW=0`（默认）跳过 `background.sh` 与 `batch1-focus/batch2-guard-ci` 里所有 `debug.hideWindow` / `debug.showWindow` 调用（它们会隐藏/恢复窗口及 Dock 图标），只打 SKIP；要专门验隐藏/托盘恢复才显式 `WARREN_REGRESS_WINDOW=1`。CI 不设这个变量，走默认静默路径。

    **三道防线（2026-11-03 补）**：① 主进程 `debug.focusWindow / hideWindow / showWindow` 默认全部返回 `WINDOW_COMMANDS_DISABLED`，只有 `WARREN_ALLOW_WINDOW_COMMANDS=1` 起应用才放行；`focusWindow()` 里的 `app.focus({steal:true})` 已删，只返回 bounds。② `run-all.sh` 默认 `WARREN_REGRESS_WINDOW=0`，跳过三个窗口态套件。③ `scripts/regress/front-guard.sh` 每 2s 只读采样前台应用 + `debug.layout`：**Warren 窗口态一变立刻 TERM 整棵回归进程树**；系统前台连续变化 3 次（阈值 `WARREN_REGRESS_GUARD_MAX`）也停，用户自己 alt-tab 一次不误杀（`WARREN_REGRESS_GUARD=0` 关，本地无人用电脑 / CI 可关）。采样实测：Warren 窗口 `144,35 / opacity=1 / focused=false` 全程不动，但系统前台在 `Whistle ↔ bb Nightly` 间反复切——守卫负责在这种情况下提前收手，不让整轮跑满一分钟。

15. **原生视图永远画在渲染层 DOM 之上** —— 页面是 `WebContentsView`，是操作系统层级的子视图。所以任何 DOM 浮层（右键菜单、下拉、对话框）只要压到页面区域，就会被页面盖住，**连点都点不到**（不是 z-index 能解决的）。→ `lib/native-view-overlay-guard.ts` 用 MutationObserver 盯 `[data-open][role=menu|dialog|alertdialog|listbox|combobox]`，量出它和 `[data-slot="stage-placeholder"]` 真重叠了才调 `envApi.setViewVisible(false)`，关掉再放回去。两个刻意的取舍：**不认 tooltip**（跟着鼠标走，为它藏页面会一直闪）；**只在真重叠时才藏**（菜单完全落在侧栏里时藏掉整页比被盖住更难受）。诊断看 `debug.layout` 的 `viewVisible`。

16. **DevTools 只能 `detach`，停靠不了** —— `openDevTools({ mode: 'right' | 'bottom' })` 要求宿主是 BrowserWindow；我们的页面是挂在 BaseWindow 上的 WebContentsView，停不进去。bb 也是 `mode: 'detach'`（`apps/desktop/src/desktop-window-factory.ts:357`）。另外 DevTools 的 Elements/Console 能直接改页面，属于写操作，所以和导航一样要人持控制权（PRD 5.3）。

17. **`expand()` 回到 `defaultSize`，前提是那个值被校准过** —— 面板 `collapse()` 收起后再 `expand()`，回的是 `defaultSize`；而 v4 把 px 换算成 % 用的是**首次布局那一刻**的宽度，冷启动会算歪（实测 360 被算成 260，正好等于 minSize，展开时一眼看出「窄了」）。所以首帧要 `resize(默认宽)` 再 `collapse()`。侧栏和检查器都踩过这条。

16b. **`size="icon-xs"` 是 20px 的密级档，别在工具栏上用** —— 控件梯子是 2xs=20 / xs=24 / sm=26 / icon=28(DEFAULT) / md=29 / lg=32。随手写 `icon-xs` 会让一个按钮比同一行其他按钮小一圈（实测过：新建标签、复制 URL、收起检查器都栽在这）。**业务侧默认省略 `size`**；只有真在密级容器里（比如 28px 的标签胶囊里的关闭键）才降档。

18. **`Runtime.callFunctionOn` 不传参数** —— 节点只挂在 `this` 上。`functionDeclaration: '(el) => …'` 这种写法里 `el` 是 `undefined`，函数静默抛错（`fill` 的生效确认、`selectOption`、`visible/disabled` 判定全踩过，症状是「命令成功但页面没变」）。→ 必须包一层 `function () { return (FN)(this); }`。

19. **`exceptionDetails` 不检查 = 静默失败** —— CDP 在页面里抛错时 `result.value` 是 `undefined`，不报错。上面那条坑就是这么被藏了一整轮。`Runtime.evaluate` / `Runtime.callFunctionOn` 的返回值一律先看 `exceptionDetails`，且真正的错误文本在 `exception.details.description`（`text` 常常只有 `"Uncaught"`）。

20. **CDP 的 `nodeId` 是字符串，`AXNode.childIds` 也是字符串** —— 按 `typeof === 'number'` 过滤会一个都匹配不上。`snapshot({scope:'subtree'})` 因此恒为空。→ 统一 `String()` 索引。

21. **`DOM.requestNode` 不先取文档会稳定返回 `nodeId: 0`** —— DOM 域需要文档缓存。→ 每次 `DOM.requestNode` 之前先 `DOM.getDocument({depth: 0})`（`#nodeIdFor` 里已有这条，`#nodeIdsByCss` 单独走的时候漏了）。

22. **`Accessibility.getFullAXTree` 不返回子 frame 的内容** —— Iframe 节点的 `childIds` 是空的。→ 按 `Page.getFrameTree` 逐帧调 `getFullAXTree({frameId})` 再合并；`subtree` 落在 iframe 上时改成取子 frame 整棵。

23. **`DOM.querySelectorAll` 不穿透 open shadow root** —— 现代站点大量用 web component。→ 改为页面内递归收集（document + 每层 `shadowRoot` + 同源 `contentDocument`），再用 `DOM.requestNode` 换成 nodeId。

24. **`Input.dispatchMouseEvent` 的 `mouseWheel` 必须带 x/y** —— 不给直接报 `INTERNAL: Invalid parameters`（不是静默失败，但报错文案看不出缺哪个参数）。→ 沿用上次鼠标位置。

25. **未处理的 dialog 会把后续命令挂死** —— `Page.navigate` 排在 dialog 后面，一直等到 RPC 60s 超时；`Runtime.evaluate` 同理。→ `navigate/reload/evaluate` 开头先 `#assertNoDialog()` 报 `DIALOG_OPEN`。注意「当前 dialog」和「事件队列」必须分开记：`events()`/`waitForEvent` 读走的是副本，浏览器侧的 dialog 还开着（`session.ts` 的 `dialogQueued` 就是为这个）。

26. **`fetch` 的 base64 要按 `'base64'` 解码** —— 写成 `Buffer.from(b64, 'binary')` 得到的是 base64 字符串本身，`saveAs` 落盘也是错的（实测：返回体看起来是乱码 base64）。

27. **Electron 36 的 `clipboard` 是 Promise API** —— 没有 `readHTML` / 同步 `writeText`，`readText()` 返回 Promise；`write()` 收 `ClipboardItem[]`。`import('electron')` 动态导入在这个工程里拿到的对象不完整（`clipboard.readHTML is not a function`），用静态导入。

28. **视图被界面让开时输入不是报错，是挂死 60s** —— 渲染层给浮层 / 插件页让位会调
    `setViewVisible(false)`，这时 Chromium 把 CDP 输入丢掉，命令**挂到 RPC 超时**（实测
    `TIMEOUT 60007ms: RPC 超时 browser.click`）。→ `assertInputOnScreen()` 显式报
    `ENV_NOT_VISIBLE`（毫秒级）。注意它**只挂在输入类命令上**，`acceptDialog/dismissDialog`
    那条自救通道不挂（否则 dialog 卡住时连关都关不掉）。

29. **渲染层会报 `0×0` 的视图矩形** —— 布局过渡那一帧量到 0 就报过来，主进程照设下去原生视图
    就是 0×0，之后输入全丢（症状同上）。实测抓到 `viewport=0×0` 而 DOM 里占位区是 1124×790。
    → `setViewport()` 忽略 `width/height <= 0`（窗口 `minWidth: 1024`，内容区不可能合法地为 0）。

30. **`waitForEvent` 先拒绝、后 await 会抛裸栈** ——
    `const p = page.waitForEvent(...); await page.click(...); await p;` 里事件若在 click 期间
    超时，`p` 在没人 await 时被拒绝，Node 默认把进程连同一串 `file://` 栈打死，agent 看到
    堆栈而不是错误码。→ CLI 加 `unhandledRejection` 兜底统一成 `CODE: message`；
    脚本里想稳就用 `const [ev] = await Promise.all([page.waitForEvent(...), page.click(...)])`。

31. **fixture 服务器一个 404 就能被打死** —— `serve-fixture.mjs` 的 `/cap/*.html` 分支先
    `writeHead(200)` 再 `readFile`，文件不存在时 catch 里二次 `writeHead(404)` → 抛
    `ERR_HTTP_HEADERS_SENT` 直接退出进程。**症状是「全线回归失败」**，最容易误判成产品问题。
    → 先读文件再写头 + 整个 handler 包 try/catch 只回 500。

32. **Vault 里的旧凭据解不开** —— 应用改名 / 重装 / 换机器后 Keychain 密钥变了，早先写的
    `cipher` 永远解不开（实测 2026-10-13 那条 `example/fixture` 报 `VAULT_DECRYPT_FAILED`）。
    现在 `vault list` 带 `available:false`、界面显示「不可用」、报错直接给
    `warren vault remove <ref>`。**新增凭据的加解密是好的**（实测 fill 后能真的登录成功）。

33. **`protocol.handle` 挂在默认 session 上，页面读不到** —— 页面跑在**环境自己的 session** 里，
    `electron.protocol.handle('warren', …)` 只作用于默认 session。症状：`loadURL` 报
    `ERR_FAILED (-2) loading 'warren://newtab/?env=blank'`、标签一片空白、主进程一条日志都没有
    （`loadURL` 的 catch 把错误吞了，现在会 `console.error` 留痕）。
    → 内置页面在 `EnvironmentManager.#sessionFor()` 里对每个 session 各挂一次。
    `warren-plugin://` 没踩到这条是因为渲染层在默认 session 里。

34. **macOS 上应用菜单的加速键先于页面拿到按键** —— 把 ⌘R / ⌘W 放进 `before-input-event`
    是拦不住的：默认菜单的 `reload` / `close` role 就是这两个键，会被菜单先吃掉，
    症状是「按 ⌘R 整个应用界面重载 / 按 ⌘W 关掉整个窗口」。→ 从菜单模板里撤掉那两个 role，
    把 ⌘T / ⌘W / ⌘R / ⌘L 做成「浏览器」菜单的加速键（`BROWSER_MENU_SHORTCUTS`），
    只有不在菜单里的键（⌥⌘I / ⌥⌘J / ⌘1..9）才走 `before-input-event`。

35. **过期的规则必须从规则表里摘掉，不能只是「不再命中」** —— `#sync()` 的挂/摘判据是
    「有没有启用规则」，一条到期的放行规则留在表里会让 handler 一直挂着，于是**整个 session
    的响应继续跳过 CORS 检查**（偏差就是这么漏出去的）。→ 加 `#scheduleExpiry()`，
    到点 `#dropExpired()` 真删 + 记 `net.rule.expired` 事件。
    验收判据：无规则时跨源无 ACAO 请求 `CORS_ERR:Failed to fetch`，放行期间 `OK:200 acao=null`，
    放行过期后**又回到** `CORS_ERR`。

36. ~~**窗口焦点是这个环境里最脆的一环**~~ **（2026-10-17 已解，保留此条作为历史）** —— 输入类验收（V1–V14、V19、20.x–22.x、`vault.fill`）
    都要 `BrowserWindow.isFocused()` 为真，否则报 `WINDOW_NOT_FOCUSED`（`vault.fill` 那条更糟：
    它不走这个守卫，表现是**挂到 60s RPC 超时**）。而 `app.focus({ steal: true })` 在
    屏幕锁定 / 用户在用别的 App 时**拿不回焦点**（实测：`debug.focusWindow` 之后
    `document.hasFocus()` 仍是 false）。跑全量回归前先确认窗口是前台应用，
    否则会看到一大片 WINDOW_NOT_FOCUSED 的假 FAIL。

    ⚠️ **2026-10-17 复核：这条的「失焦就丢输入」前提被推翻了** —— 绕过
    `assertInputFocus()` 之后，失焦状态下鼠标点击与键盘（`fill` / `press`）**都实测送达**，
    坐标也一致（三轮，见 `docs/OPTIMIZATION-PLAN-2026-10-17.md` §1.1）。
    也就是说 `WINDOW_NOT_FOCUSED` 是**我们自己拦的**，不是 Chromium 拦的。
    **但别急着删守卫**：后台环境、部分遮挡、以及 `document.hasFocus()` 这三条还没测。

    **2026-10-17 批次 1 已补测**（`scripts/verify/batch1-focus.mjs`）：
    - 后台环境 **`ensureOperable` 有效**；失焦后**坐标映射不变**。
    - **`document.hasFocus()` 失焦再拉回前台仍是 false** —— 这是真 bug，**已修**：
      `environments.ts` 新增 `focusDisplayedPage()`，在 `inputCall` 发输入前调 `wc.focus()`，
      把 **document 焦点**交给页面（窗口有焦点 ≠ 页面有焦点）。实测「一次输入后 hasFocus=true」。
      → 以后**别再把 `windowFocused` 和页面的 `document.hasFocus()` 当成一回事**。
    - 部分遮挡仍未测（按坐标不变的结论推断风险低，但没有实测）。
    - **批次 2 已删掉 `assertInputFocus()` 守卫**，并加了 V16 回归（失焦时点
      `fixtures/capability/focus-guard.html` 里带 `hasFocus` 守卫的按钮 → 必须生效）。
      `run-all.sh` 的前置也从「不在前台就退出」改成只打印状态。
      **CI 现在跑 GUI 回归**（`.github/workflows/ci.yml` 的 `gui-regression`，macOS runner）。
    - **2026-10-21 最终口径**：`focusDisplayedPage()` / 输入路径按窗口状态分流；窗口不在前台时只用
      CDP 焦点仿真，绝不 `wc.focus()`。后台视图懒建时必须先建 Tab 再 `attachBelow()`；
      renderer 视口为 0 时临时 `Emulation.setDeviceMetricsOverride`。`batch1` / `batch2`
      现在同时断言输入生效且 `windowFocused=false`。

37. **`debugger.sendCommand(…, '')` 会被直接拒** —— Electron 对**空字符串** session id 报
    `Empty session id is not allowed`，而主会话事件里给的 `sessionId` 正是空串（不是 `undefined`）。
    症状：`acceptDialog` 报 `INTERNAL: Empty session id is not allowed`，dialog 关不掉、后续输入全挂。
    → `sendOn()` 里把空串归一成 `undefined`。

38. **AX 缓存里可能留着已经死掉的子会话 id** —— OOPIF 的进程会被换掉（detach → 重新 attach，
    sessionId 跟着变），而 AX 缓存有 120ms TTL。拿死 sessionId 发命令**不报错**，而是在旧会话里
    按同名 id 命中**另一个节点**（`backendNodeId` 只在同一个 renderer 内唯一）。
    实测症状：页面里抛 `el.getBoundingClientRect is not a function`（解析到了一个文本节点）。
    → 缓存要校验 `sessionsAlive()`；`frameOfBackendId` 遇到死会话报可重试的 `NODE_DETACHED`，
    **绝不退回主会话**（退回就是静默点到别的元素）。

39. **跨源 iframe 里弹的 alert 走的是主会话** —— `Page.javascriptDialogOpening` 的 url 是内层页面的，
    但 sessionId 是空的（主会话）。子会话那条路先留着（`DialogInfo.sessionId`），
    处理命令按 dialog 的会话发；目前实测都落在主会话。

40. **子会话的盒模型坐标是「子 frame 自己视口」里的** —— 直接当主 frame 坐标用会点到 iframe 外面
    （上一版实测算出 x=562，而 iframe 只有 x∈[82.6, 506.6]）。
    正解 = 子会话盒模型中心 + **owner iframe 元素内容盒左上角**（边框/内边距已扣）。
    认 owner 要用 `DOM.describeNode` 回来的 `frameId`，**不能**拿 `Target.attachedToTarget`
    的 `targetId` 比（两个 id 不是一回事）。

41. **拍「Overlay 高亮」要用 `webContents.capturePage()`，不是 `Page.captureScreenshot`** ——
    实测三种通道：`Page.captureScreenshot` 默认 `fromSurface:true` **稳定但不含高亮**（前后逐字节相同）；
    `fromSurface:false` **含高亮但同一画面连拍两次字节就不一样**（没法用来比对）；
    `webContents.capturePage()`（渲染层的 `envApi.pageSnapshot`）**稳定且含高亮**——
    V15 的 A/B/A 判据就是靠它（高亮后变、清除后逐字节回到原样）。验证视觉能力时先挑对通道。

42. **后台环境的输入：CDP 和原生注入都被丢，但「附到窗口最底层」能救** —— 视图没挂到窗口上时
    页面自报 `visibility: hidden`，`Input.dispatchMouseEvent` 和 Electron 的 `sendInputEvent`
    **都落不进去**（原生注入实测三次全失败）。把视图 `addChildView(view, 0)`（附在最底层，
    不抢显示）之后页面自报 `visible`，**CDP 输入就能用**（不用换输入栈）。
    **两个必须记住的代价**：① 附上去会**抢走 webContents 焦点**（实测），所以挂完要立刻
    `wc.focus()` 把焦点还给显示中的那个，否则人打字会打进看不见的页面；
    ② 上面那个视图**被让开**（浮层 / 插件页，`viewVisible=false`）时**不许挂**——它一藏，
    底层的后台页面就露出来了。所以浮层开着时后台操作照旧报 `ENV_NOT_VISIBLE`。

---

## 8. 怎么跑、怎么验

```bash
npm install
npm start                        # 桌面端（同时起 Core 和本地 RPC）
node scripts/serve-fixture.mjs 8899   # 本地测试站点

# 无头测试（日常默认，不启动 Electron 窗口）
npm run check:changed                 # lint + format + typecheck + 改动定向无头测试
npm run test:changed                  # 仅跑与 git diff 相关的无头 unit + UI 用例
npm run test:ui                       # 仅跑无头 React UI 套件（Vitest + happy-dom）
npm run check                         # 重大改造前跑全量无头门禁（含全部单测 + UI + 构建）

# 全量真机 GUI 回归（默认已禁用，仅重大架构改造/发版前显式开启）
bash scripts/regress/run-all.sh --allow-full

# 另一个终端
node bin/warren.mjs env list
node bin/warren.mjs env start alpha
node bin/warren.mjs env select alpha
node bin/warren.mjs exec alpha <<'JS'
await page.goto('http://127.0.0.1:8899/login.html');
JS
node bin/warren.mjs browser snapshot alpha
node bin/warren.mjs call debug.layout        # 渲染层是否挂载

# 标签
node bin/warren.mjs tab list alpha            # ● 是当前激活的标签
node bin/warren.mjs tab new alpha https://example.com
node bin/warren.mjs tab select alpha 2
node bin/warren.mjs tab close alpha 2         # 关掉最后一个 = 停环境
node bin/warren.mjs exec alpha --tab=2 <<'JS'
return (await page.tabs()).map((t) => t.url)  # 显式寻址第 2 个标签
JS
```

**渲染层挂载探针**：`debug.layout` 返回 `{x:288,y:37,w:1152,h:674}` 说明挂上了；返回默认 `0,0,800,600` 说明没挂。

**重启清理**（别省）：
```bash
pkill -f "electron-forge start"; pkill -f "node_modules/electron/dist"; sleep 3
lsof -ti :5173 | xargs kill -9; rm -f ~/.warren/runtime/envd.sock ~/.warren/runtime/runtime.json
pgrep -f 'electron-forge start' | wc -l   # 必须是 0
```

**截图**（给远程看）：
```bash
# 不需要激活 Warren；后台也能截可见视口。
node bin/warren.mjs browser screenshot <env> --output=/tmp/warren-shot.png
```

---

## 9. 已结清原先挂起事项与后续方向

早期交接清单中下列事项**均已落地**（不再属于未完成）：

- **Cookie 受控搬运通道**：`storage.cookie.port` + `host.cookie.{names,copy,import,clear}` 已完成（只搬运不返回 Cookie 值，`storage.cookie.read`/`write` 保持永久 `denied`）；
- **插件子进程与执行超时**：`runtime: "sandbox"` 与 `"host"` 均运行于可强杀子进程（`runtime-base.ts` + `worker-process.ts`），默认 `30_000ms` 超时（`WARREN_PLUGIN_TIMEOUT_MS`）；
- **环境并发上限与空闲休眠**：已落地 `hibernate`/`wake` 及设置项控制；
- **遥测持久化**：Console / Network 已统一落入 `warren.db`（每标签保留 300 条，停用/休眠保留，仅 `env.remove` 时清空）。

后续演进仅聚焦日常打包发布、按需依赖月度升级（见 `docs/DEPENDENCY-POLICY.md`）与新插件扩展。

---

## 10. 工作方式上的约定

- **用户偏好**：中文沟通；直接给结果和链接，不要废话和手动步骤；结构化数据存文件不要只给文字列表。
- **验证习惯**：说「做完了」必须带实测输出。这个项目里已经出现过多次「看起来改了但没生效」（见坑 8），所以改完必须重启 + 实测。
- **视觉模型当前不可用**（API key 401）—— 需要判断「界面长什么样」时，用像素统计代替：区域平均 RGB、唯一颜色数、特定条带的暗像素占比。这个项目里已经用过（验证遮罩是否渲染、验证皮肤是否切换）。
- **仓库**：`origin` = `git@github.com:saywhy-dev/warren.git`。**HTTPS 那条没有凭据**（`git push` 直接跑会报
  `could not read Username`），走 SSH。`gh` 的 token 已失效，所以 `gh run list` 读不到 CI 结果。
