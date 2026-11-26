# Warren 插件生态 2.0：业务插件深度重构与插件 Skill 自动注入计划

> 状态：**方案 A 已拍板执行（Phase 1A/2A/3A 零冲突先行，Phase 1B/2B/3B/4 待外壳合入后衔接）**  
> 日期：2026-11-26  
> 工作分支：`feat/plugin-ecosystem-2`（worktree：`/Users/euanguo/Documents/projects/work/warren-worktrees/plugin-ecosystem-2`）  
> 关联文档：`AGENTS.md`、`docs/HANDOFF.md`、`docs/WARREN-2.0-ARCHITECTURE-PLAN.md`、`docs/SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md`、`docs/PLUGIN-CAPABILITY-DESIGN.md`、`plugins/README.md`

---

## 0. 背景、目标与并行协同边界

### 0.1 核心目标

将仓库内两个业务插件（`com.warren.accounts` 账号管理、`com.warren.whistle` Whistle 代理）从「后台能力具备但人机交互与 AI 工具面偏 Demo」升级为专业级完整能力，并补齐插件生态最核心的一环——**插件自带 Skill + 主软件 Skill 感知并自动注入启用插件的 Skill**：

1. **宿主能力底座升级**：打通子进程 `caller: 'ui' | 'agent'` 全链路透传、双 Space 安全填充（人可在 `Person Space` 免 lease 一键填密，Agent 严锁 `Agent Space` + lease + 域名白名单）、隔离世界跨 Shadow DOM / 跨源 OOPIF 智能登录框探测，以及地址栏 `PopoverHost` 原生子窗插件承载。
2. **插件 Skill 自动注入体系**：扩展 `package.json#warren.skill` 契约，统一主进程与 CLI 的 `SkillComposer` 合成引擎，以「主 `SKILL.md` 紧凑索引 + `plugins/<id>/SKILL.md` 按需披露」的分层结构实现启停/更新自动同步与运行时实时拉取，并加上安装预览与按插件暴露开关的信任防护。
3. **账号管理插件彻底重构（`com.warren.accounts`）**：补齐人类在页面上的一键填充闭环（地址栏钥匙角标 + 原生 Popover + `⇧⌘L` / `⌘K` + 右侧工作台随行面板），激活闲置的 6 个扩展 schema 列，新增智能表单探测、TOTP/2FA、密码生成、扩展字段、域名白名单、环境偏好、导入导出与软删除回收站，修复 `agent` 通道 `username` 明文外泄边界。
4. **Whistle 插件升级与重构（`com.warren.whistle`）**：升级内置 `whistle` 至 `2.10.15`，修复 `agent()` 无点方法路由 Bug，切至官方 `network.getSessions` 服务端过滤，补齐 Values 一等 CRUD、规则命中测试（`ruleTest`）、清 DNS 缓存、高层调试意图原语（`quickMock` / `injectFault` / `mapLocal`）、按 `reqId` 改参重放与响应 diff、cURL 导出、以及基于 `api.createUrl` 的抓包排障直达链接；UI 重做为主从分栏工作台 + 地址栏场景快捷切换 Popover + Inspector 实时抓包抽屉。

### 0.2 与 `SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md` 的协同与零冲突拆分

`feat/shell-layout-interaction` 正在同期重构渲染层顶栏与布局外壳（移除 `AppRail`、改两层顶栏、接通地址栏 `registry.popovers` 槽、改写 `App.tsx` / `environment-address-bar.tsx` / `environment-stage.tsx` / `environment-inspector.tsx` 并初步触碰两个插件的 `app.js`）。为杜绝 3-way 冲突与旧外壳 UI 返工，本计划按**零冲突先行（A 阶段）+ 新外壳合流（B 阶段）**两波执行：

- **A 阶段（立即在 `feat/plugin-ecosystem-2` 完整落地并提交，与外壳重构零冲突）**：
  - **Phase 1A**：主进程插件底座（`caller` 透传、双 Space 安全 `fillSecret`、隔离世界登录框探测、`hostRead` / `eventBus` 扩展）+ 插件 Skill 契约与统一自动注入引擎（`src/main/skills/`、`agent-integration.ts`、`bin/warren.mjs`、`skills/warren/SKILL.md`、`agent-panel.tsx`、`plugins-panel.tsx`）。
  - **Phase 2A**：`com.warren.accounts` 完整后端能力升级、安全边界修复、`SKILL.md` 与单测（暂不修改 `app.js` 与 `surfaces`）。
  - **Phase 3A**：`com.warren.whistle` 升级 `2.10.15`、全部后端/AI 新能力、`SKILL.md` 与单测（暂不修改 `app.js` 与 `surfaces`）。
- **B 阶段（待 `feat/shell-layout-interaction` 合入 `main` 后 rebase 衔接）**：
  - **Phase 1B**：在新外壳的 Row 2 地址栏槽位与 `popover-root.tsx` 落地通用原生 `plugin-popover` 子窗宿主、`statusBadge`、快捷键与 `PLUGIN_UI` 增量导出（`ResizablePanelGroup` 等）。
  - **Phase 2B & 3B**：基于新外壳的「地址栏 Popover + 右侧工作台 `inspectorTab` + 顶栏全局入口全屏 `railPage`」三分工，重构 `plugins/account-manager/app.js` 与 `plugins/whistle/app.js` 并更新 `surfaces`。
  - **Phase 4**：全量端到端实机验证、关键状态截图与视觉交互自循环打磨。

### 0.3 不可妥协的硬约束

1. **安全与隔离红线不变**：
   - `Vault` 与 `com.warren.accounts`（本地明文产品例外）严格区分；`data-slot="account-plaintext-warning"` 保持不变。
   - 账号插件 `agent` 通道**永远不返回明文**（不含密码、不含 TOTP secret/动态码、不含明文 `username`，只给 `usernameHint`、`hasPassword`、`hasTotp`）；登录走宿主内部 `fill`；`reveal` / `totpCode` 仅限 `caller === 'ui'`；`export` 需 `{"confirm":"plaintext"}`。
   - `caller === 'ui'` 由主进程在调用表权威维护，子进程不可伪造；`caller === 'agent'` 永远禁止写入 `Person Space`。
2. **反爬零侵入红线不变**：
   - 表单探测只在 `Page.createIsolatedWorld` 中运行，不向被控页面写任何全局变量或 `data-*` 属性；
   - 人类一键填充入口依托原生 `PopoverHost` 悬浮于地址栏下方，不向网页 DOM 注入浮动图标。
3. **Node ESM 单测纪律不变**：
   - 进入 `tests/` 加载链的模块不 `import electron`（仅 `import type`）、不用 TS 参数属性、内部运行时导入保留 `.ts` 扩展名。

---

## 1. Phase 1：宿主 2.0 底座与插件 Skill 自动注入引擎

### 1.1 Phase 1A（零冲突先行）

#### A. `caller` 全链路权威透传与双 Space 安全操作

- `src/main/plugins/runtime.ts`：
  - `PluginInvocationContext` 增补 `caller?: PluginRpcCaller`。
  - 主进程 `RuntimeBase` 按 invocation `id` 登记 `{ pluginId, environmentId, leaseId, caller }`，子进程发起 `host-call` 时仅传 `parent` id，主进程从可信表查回 `caller`，杜绝子进程伪造 `'ui'`。
- `src/main/plugins/lifecycle.ts`：`onHostCall` 将 `context.caller` 注入 `runWithPluginContext`。
- `src/main/plugins/api/index.ts`：
  - `CapabilityContext` 增加 `caller: () => PluginRpcCaller`。
  - `CapabilitySpec.needsLease` 返回类型扩展为 `boolean | ((ctx, args) => string | false)`，返回 `false` 时跳过 Agent lease（仅在主进程显式验证 `caller === 'ui'` 且 `space === 'person'` 时使用）。
- `src/main/plugins/api/browser.ts`：
  - `browser.fillSecret(environmentId, target, value, options?)`：支持 `{ space?: 'person' | 'agent'; allowedDomains?: string[] }`。
    - `caller === 'agent'`：若 `space === 'person'` 抛 `SPACE_FORBIDDEN`；锁定 `'agent'` 并强制校验 Agent lease；若提供 `allowedDomains` 经 `assertSecretDomain` 强检。
    - `caller === 'ui'`：允许 `space === 'person'`（免 Agent lease）或 `'agent'`（需已接管或 lease）。
  - 新增 `browser.detectLoginFields(environmentId?, options?)`（`permission: 'browser.dom.read'`，支持 `space`，`agent` 锁定 `'agent'`）。
  - 增强 `browser.click` / `browser.openTab` / `browser.info`：支持可选 `space` 选项，保持 `agent` 锁定 `'agent'`、`ui` 可操作 `'person'`。

#### B. 隔离世界智能登录表单探测（`src/main/browser/login-fields.ts`）

- 抽离纯逻辑评分函数 + 隔离世界 DOM 探测脚本 + OOPIF 聚合：
  - 遍历 `document`、open `shadowRoot`、同源 `iframe` 及 `ctx.childSessions()` 跨源 OOPIF；
  - 对页面可见表单控件做语义打分，识别 `username`、`password`、`totp`、`submit` 四类目标；
  - 区分登录步骤：`single`（账号+密码同页）、`username-only`（两步登录第一步）、`password-only`（两步登录第二步）、`totp-only`（MFA 验证码页）、`none`；
  - 为每个命中返回 `{ selector, kind, confidence, label, autocomplete, frameId, inCrossOriginFrame, rect }`（附带稳定的 CSS/属性定位器，必要时回退 role/label 定位器）；
  - 暴露给 `BrowserController.detectLoginFields()`、RPC `browser.detectLoginFields` 与插件 `host.browser.detectLoginFields`。

#### C. 宿主只读能力与事件总线补强

- `src/shared/plugin-host-api.ts` & `src/main/plugins/host-read.ts`：
  - 新增 `environment.activeContext`（返回当前选中环境 ID、活跃 `space`、活跃 Tab 的 `url` / `title`）；
  - `browser.info` 支持可选 `space` 参数。
- `src/main/plugins/event-bus.ts` & `src/shared/types/plugin.ts` & `packages/plugin-sdk/index.d.ts`：
  - `PluginBusEventType` 新增 `'tab.activated'` 与 `'space.switched'`，在标签切换与空间切换时向已订阅插件推送脱敏元数据（`environmentId`, `space`, `tabId`, `url`, `title`）。

#### D. 插件 Skill 契约与统一自动注入引擎（`src/main/skills/`）

1. **包契约（`src/main/plugins/package.ts`、`src/shared/types/plugin.ts`、`packages/plugin-sdk/index.d.ts`）**：
   - `package.json#warren` 新增可选字段 `skill`：
     - 简写：`"skill": "SKILL.md"`；
     - 完整：`{ "entry": "SKILL.md", "summary": "一句话能力说明", "triggers": ["关键词"], "references": ["references/foo.md"] }`。
   - 校验规则：`entry` 与 `references[]` 必须满足 `isSafeRelativePath`、`references` 最多 8 个、`summary <= 240` 字符、`triggers` 最多 16 项。
2. **统一合成引擎（`src/main/skills/composer.ts` + `src/main/agent-integration.ts`）**：
   - 消除 `agent-integration.ts` 与 `bin/warren.mjs` 之间的重复实现。
   - 约定主 Skill 注入围栏：
     ```markdown
     <!-- warren:enabled-plugins:begin -->
     ...自动生成的已启用插件 Skill 目录...
     <!-- warren:enabled-plugins:end -->
     ```
   - 支持分层目录同步到 `~/.agents/skills/warren/`（及 `.claude` / `.codex`）：
     - `SKILL.md`：基础 Warren Skill + 已启用且允许暴露的插件紧凑索引（插件名、ID、触发词、摘要、相对路径 `plugins/<id>/SKILL.md` 与动态命令 `warren skills plugin <id>`）+ 明确信任边界声明；
     - `plugins/<id>/SKILL.md`（及 `references/*`）：各启用插件完整 Skill（限制单文件 ≤ 32KB；若插件未提供 `SKILL.md` 则自动基于 `commands` / `rpc` 合成精简兜底手册）；
     - 停用、卸载或关闭暴露的插件会从索引移除并自动清理对应 `plugins/<id>/` 子目录；
     - `.warren-skill` 记录 `{ baseSha, composedSha, updatedAt, enabledPlugins: [{ id, version, digest, skillSha }] }`。
3. **生命周期自动联动与信任控制**：
   - 在 `plugins` 状态中持久化按插件 `skillExposed`（默认 `true`），新增 `plugin.setSkillExposed` / `plugin.readSkill`；
   - `PluginHost` 在 `load` / `install` / `update` / `uninstall` / `enable` / `disable` / `setSkillExposed` 后防抖触发 `syncInstalledSkills()`，仅刷新用户已安装的目标目录；
   - CLI（`bin/warren.mjs`、`bin/commands.mjs`）升级：
     - `warren --skill [--base-only|--full|--plugin=<id>]`：守护进程在线时实时输出合成版，离线回退静态基线；
     - `warren skills status|install|refresh|plugin <id>`；
     - `warren plugin skill <id>` / `warren plugin skill-exposure <id> on|off`。
   - 设置 UI（`src/renderer/features/settings/agent-panel.tsx`、`src/renderer/features/plugins/plugins-panel.tsx`）：
     - `AgentPanel` 展示当前参与注入的启用插件 Skill 列表与同步状态；
     - `PluginsPanel` 展示插件是否携带 Skill、提供「查看 Skill」预览弹窗及「向 Agent 暴露 Skill」开关。
   - `skills/warren/SKILL.md`：移除硬编码的 `com.warren.accounts` 与 `com.warren.whistle` 专章，置入自动注入围栏并说明 `warren skills plugin <id>` 按需读取协议。

### 1.2 Phase 1B（外壳合入后衔接）

- 在 `src/renderer/app/popover-root.tsx` 实现通用 `plugin-popover` 路由，允许在独立 OS 子窗中加载并渲染任意插件 `popover` 组件（带 `PluginBoundary` 与 `app.ui.closePopover()`）。
- 将插件 `statusBadge` / `popover` 接入新外壳 Row 2 地址栏快捷槽，支持动态角标计数与快捷键唤起（如 `⇧⌘L`）。
- 升级 `overlay-root.tsx` 的 `⌘K` 命令栏，支持无当前环境时的全局插件动作与打开插件 `popover` / `railPage`。
- 在 `PLUGIN_UI` 增补 `ResizablePanelGroup` / `ResizablePanel` / `ResizableHandle`、`app.context` 与 `app.ui.openTab`。

---

## 2. Phase 2：账号管理插件彻底重构（`com.warren.accounts`）

### 2.1 Phase 2A（零冲突先行：后端全量升级 + 安全修复 + `SKILL.md`）

- **数据模型追加迁移（`plugins/account-manager/server.js`）**：
  - 激活既有 6 个扩展列（`display_aliases`、`expected_uin`、`app_hints`、`login_profile`、`manual_verification_hint`、`frame_aware_fill`）；
  - 追加列：`totp_secret`、`urls`（JSON 匹配列表）、`extra_fields`（JSON 键值对）、`selectors`（JSON 选择器覆盖模板）、`allowed_hosts`（JSON 域名白名单）、`env_ids`（JSON 绑定偏好环境）、`pinned`、`use_count`、`last_used_at`、`deleted_at`（软删除回收站）。
- **严格安全边界修复**：
  - 按 `ctx.caller` 区分返回形状：`caller === 'agent'` 时列表/详情/匹配**不返回明文 `username`**（只给 `usernameHint`、`hasPassword`、`hasTotp`）；`caller === 'ui'` 时返回 `username` 供界面展示与复制；
  - `reveal` 与新增 `totpCode` 严格限定 `caller === 'ui'`，agent 通道返回 `ACCOUNT_REVEAL_UI_ONLY` / `ACCOUNT_TOTP_UI_ONLY`。
- **智能匹配与零手写 Selector 填充**：
  - 新增 `match`：按 `url` / `host` / `environmentId` 综合打分排序（精确 origin > 同主域 > `urls`/`displayAliases` 命中 > 偏好环境 > 置顶/最近使用）；
  - 新增 `detectFields`：转发并整理宿主 `browser.detectLoginFields` 结果；
  - 升级 `fill` / 新增 `autoFill`：
    - 支持不传 `fields` 时自动按「账号已存 `selectors` 模板 → 宿主 `detectLoginFields` 探测」解析 `username`、`password`、`totp` 与可选 `submit`；
    - 零依赖内置 RFC 6238 TOTP 生成器（SHA-1 / SHA-256 / SHA-512，支持 `otpauth://` URI 解析），支持直接将 6 位动态码经 `host.browser.fillSecret` 填入页面；
    - 强制推导并传入 `allowedDomains`（`agent` 强制防跨站钓鱼，`ui` 跨站填充可由调用方传 `allowCrossOrigin: true` 二次确认）；
    - 支持 `space` 参数（`ui` 默认填当前空间，支持 `'person'`；`agent` 死锁 `'agent'`）；
    - 成功后更新 `use_count` 与 `last_used_at` 并广播 `changed` 信号。
- **完备凭据工具集**：
  - `generatePassword`（可配长度、大小写/数字/符号/排除易混字符）；
  - `importAccounts`（支持 Warren JSON、通用 CSV、Chrome 导出 CSV，支持 `skip | overwrite | duplicate` 去重策略）；
  - 回收站闭环：`trash`（软删除）、`restore`、`purge`（清空/彻底删除）、`list` 支持 `includeDeleted` 与 `pinnedFirst` 排序；
  - `togglePin` / `saveSelectors`（保存探测成功的页面选择器模板）。
- **编写 `plugins/account-manager/SKILL.md`**：清晰描述 Agent 登录标准流（`match` → `autoFill` → 两步登录 / 人工验证码提示 `manualVerificationHint` → 错误码处理）及明文安全红线。

### 2.2 Phase 2B（外壳合入后衔接：前端全套交互重做）

- **地址栏钥匙徽标 + 原生填充 Popover（`statusBadge` + `popover` + `⇧⌘L` + `⌘K`）**：自动显示当前站点匹配账号数，浮窗内一键填充 / 填充并登录 / 复制账号密码与实时 TOTP 倒计时 / 从当前页新建账号。
- **右侧工作台随行 `inspectorTab`**：展示当前页匹配账号 + 调用 `detectFields` 列出并高亮（`browser.highlight`）页面登录框 + 一键存为该账号 `selectors` 模板。
- **全屏主从分栏管理页（`railPage`）**：左标签与回收站筛选 + 中账号列表（支持置顶/搜索/排序）+ 右详情与编辑工作台（暴露全部扩展字段、TOTP 二维码/URI 导入与动态倒计时、密码生成器、导入导出向导、「在当前环境打开并登录」），持续保留 `data-slot="account-plaintext-warning"`。

---

## 3. Phase 3：Whistle 升级 `2.10.15` 与全量能力重构（`com.warren.whistle`）

### 3.1 Phase 3A（零冲突先行：内核升级 + 后端/AI 能力重构 + `SKILL.md`）

- **升级内置 `whistle`：`2.10.12` → `2.10.15`**（更新 `plugins/whistle/package.json` 及 `plugins/whistle/node_modules` 与 `README.md`）。
- **修复官方 Agent API 适配层（`plugins/whistle/agent-api.mjs`、`host.mjs`）**：
  - 修复 `agent()` 调用无点方法（`isEnabledHTTPS`、`setEnableHTTPS`、`getRootCA`、`createFile`、`getFile`、`createUrl`）报 `WHISTLE_AGENT_METHOD_UNKNOWN` 的 Bug，同时兼容 `https.*` / `files.*` 命名空间写法；
  - 接入 Whistle `2.10.14` 新增的 `createUrl`（为抓包快照生成 `#network?dataUrl=...` 排障直达链接）。
- **全面升级抓包与分析（`traffic`）**：
  - 默认支持官方 `network.getSessions` 服务端过滤参数（`type`: `JSON|HTML|CSS|JS|WS|SSE|Mock|Rules|Error|captureError`、`subUrl`、`method`、`statusCode`、`reqHeader`、`resHeader`、`startId`、`startTime`、`latest`、`count`），兼顾原有本地兼容参数；
  - 输出统一精简脱敏结构，附带分阶段耗时 `timings`（dns / connect / ttfb / download / total）与命中的规则列表。
- **Values 数据区一等 CRUD**：
  - 新增 `valueList`、`valueGet`、`valueSet`、`valueRemove`、`valueRename`，让 AI 与 UI 能直接管理 `{mock.json}` 等内嵌值。
- **规则命中诊断与 DNS 缓存清理**：
  - 新增 `ruleTest`：给定 `storage` + `url`（及可选 `method` / `headers`），解析当前实例生效规则并结合 Whistle 匹配语义返回命中的规则行与最终改写目标；
  - 新增 `clearDnsCache`：一键清理实例 DNS 缓存（`/cgi-bin/rules/clear-dns-cache`）与本地地址缓存（`/cgi-bin/reset-local-address`）。
- **AI 高层调试意图原语（新建纯模块 `plugins/whistle/intents.mjs`）**：
  - `quickMock`：一条命令配置指定 URL 模式的静态 JSON/文本 Mock（自动写入 Value + 写入并启用受控规则组 `warren-mock`，支持 `statusCode`、`delayMs`、`cors`、`headers`）；
  - `injectFault`：一条命令注入故障（延迟 `resDelay`、限速 `resSpeed`、状态码 `statusCode`、禁止缓存 `disable://cache`、禁止解码 `disable://encoding`），写入受控规则组 `warren-fault`；
  - `mapLocal`：一条命令配置线上域名/路径映射到本机端口或本地目录；
  - `clearIntents`：按分组或全部一键关闭/清空临时调试规则组，绝不误伤用户主规则。
- **请求重放、响应对比与排障快照闭环**：
  - `replay`：按抓包 `reqId` 自动取原请求，允许覆写 `url` / `method` / `headers` / `body` / `rules` / `times`（利用 `2.10.13` Replay body 修复），可选 `diff: true` 自动对比原响应与重放响应（状态码、关键头、JSON 字段 diff）；
  - `toCurl`：按 `reqId` 生成可直接复制运行的脱敏（或显式 `includeSensitive`）cURL 命令；
  - `captureLink`：将过滤后的抓包调用 `saveSessions` + `createUrl` 生成直达 Whistle Web UI 的链接，支持 `open: true` 直接在绑定环境标签页打开。
- **全写操作广播 `changed` 信号** + **编写 `plugins/whistle/SKILL.md`**（涵盖 AI 排障黄金路径、意图原语、规则验证/回滚、抓包过滤与排障链接生成）。

### 3.2 Phase 3B（外壳合入后衔接：专业代理工作台 UI 重做）

- **全屏主从分栏工作台（`railPage`）**：左侧实例列表（补全缺失的停止后「启动」按钮、运行态与绑定环境徽标）+ 右侧多 Tab 详情区（`规则`含新建规则组/实时校验/Diff 预览、`Values` 键值编辑器、`预设与场景`含 `online/test/local/preview` 一键切换与增删改导、`实时抓包与重放`、`Doctor 诊断`），全面接入 `useSignal('changed')` 自动同步。
- **地址栏代理徽标 & 快捷切换 Popover（`statusBadge` + `popover`）**：一键看当前环境绑定实例、切换场景预设、开关 HTTPS 解密 / 总规则 / 临时 Mock，点击直达完整 Whistle UI。
- **右侧工作台随行 `inspectorTab`**：展示当前环境代理状态、最近命中规则请求流、快捷一键 Mock / 清 DNS 缓存 / 重放。

---

## 4. Phase 4：全量验收与实机视觉自循环优化

### 4.1 A 阶段收尾门禁（本轮立刻执行）

1. 每个 Phase 独立提交（Plan doc / Phase 1A / Phase 2A / Phase 3A）。
2. 全量补齐单元测试：
   - `caller` 防伪造透传与双 Space `fillSecret` 边界；
   - `login-fields.ts` 表单评分、Shadow DOM / iframe / 两步登录探测；
   - `SkillComposer` 合成、体积限制、兜底生成、生命周期自动同步与停用清理；
   - `account-manager` 脱敏边界、TOTP、密码生成、智能匹配、autoFill、导入导出、回收站；
   - `whistle` `2.10.15` Agent API 路由、`intents` 纯逻辑、Values CRUD、`ruleTest`、`replay` diff、`toCurl`、`captureLink`。
3. 在本 worktree 执行 `npm run format && npm run check`（`oxlint`、`prettier:check`、`tsc --noEmit`、`npm test`、`vite build`）100% 全绿。

### 4.2 B 阶段实机自循环门禁（待 `feat/shell-layout-interaction` 合入 `main` 后）

1. Rebase 到合并后的 `main`，落地 Phase 1B / 2B / 3B UI 重构；
2. 清理残余进程后启动真机应用 + 本地测试 fixture；
3. 自循环端到端验证全部交互（地址栏钥匙 Popover、Person Space 一键填充、TOTP 倒计时、Whistle 地址栏场景切换、分栏工作台、Inspector 抓包与高亮、插件启停自动刷新 `~/.agents/skills/warren/`）；
4. 对每个页面和关键状态逐一截图并做多轮视觉与交互细节审查修复，直至零明显瑕疵；
5. 同步更新 `docs/HANDOFF.md` 与 `docs/README.md`，`npm run check` 全绿并提交。
