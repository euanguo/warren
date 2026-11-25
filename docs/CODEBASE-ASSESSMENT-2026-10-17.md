# Warren 代码与能力评估（2026-10-17）

> 状态：一次性评估报告，**不改代码**。
> 方法：全部数字来自本机实测（`wc -l` / `npm test` / `scripts/regress/run-all.sh` / 读代码）。
> 前一份同类文档：`CODE-AUDIT-2026-10-14.md`（那轮 15 条发现已全部修掉）。

---

## 0. 结论摘要

**一句话：这是一个「小体量、高完成度、文档密度异常高」的单人项目。主要风险不在功能缺失，
在三个结构性点上 —— 一个过大的主进程文件、回归套件依赖窗口焦点、以及真实性缺口（见
`ELECTRON-REALISM-PLAN.md`）。**

| 维度 | 评价 | 依据 |
|---|---|---|
| 功能完成度 | **高** | 浏览器能力 / 网络拦截 / 插件 / 凭据 / 标签 / 分组 / 遥测全有实测记录 |
| 可测性设计 | **好** | 34 个单测文件跑在纯 `node:test` 上，不需要 Electron —— 靠的是把纯逻辑外提 |
| 回归保护 | **好** | 146 条 GUI 回归全绿；CI 已有 `gui-regression`，2026-10-19 起不再 `continue-on-error` |
| 代码组织 | **中上** | 分层清楚、纯函数外提系统；`environments.ts` 1359 行是唯一的 God object |
| 文档 | **异常高** | 22 份 docs、8000+ 行；好处是决策可追溯，风险是同步靠纪律 |
| 真实性（联调） | **有明确缺口** | 见 `ELECTRON-REALISM-PLAN.md` §1 |

---

## 1. 代码梳理

### 1.1 规模与分布（实测）

```
src/main          12361 行 / 49 文件     ← 主进程
  browser/         4219 行 / 19 文件     ← CDP 控制层
  plugins/         2326 行 /  7 文件
  net/              640 行 /  3 文件
  domain/           390 行 /  4 文件     ← 纯逻辑（可单测）
  vault/            306 行 /  3 文件
src/renderer      12354 行 /104 文件     ← 渲染层
  components/ui/   4378 行 / 42 文件     ← 产品组件库
  features/        2536 行 / 11 文件
  app/              817 行 /  5 文件
src/shared          700 行 /  2 文件     ← 跨进程类型 + 权限
src/preload         141 行 /  2 文件
bin               1146 行 /  1 文件     ← Agent CLI
scripts           1372 行 / 14 文件     ← 含回归套件
tests             3953 行 / 34 文件     ← 240 个用例
```

**最大的 6 个文件**（值得盯）：

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/main/environments.ts` | **1359** | 唯一明显偏大：session / lease / 遮罩 / tabs / telemetry / net / plugin 接线都在这里 |
| `src/main/browser/controller.ts` | 809 | 页面门面，其余委托给同目录模块 |
| `src/main/rpc-dispatch.ts` | 723 | RPC 派发表 |
| `src/main/plugins/host.ts` | 686 | PluginHost |
| `src/main/tabs.ts` | 637 | Tab / TabManager |
| `src/main/store.ts` | 543 | 持久化 |

### 1.2 分层与依赖方向（读代码得出）

```
renderer ──IPC──> preload ──> main
                                │
                    ┌───────────┼────────────┐
                    │           │            │
              environments   rpc-dispatch  plugins/host
                    │           │            │
              browser/*      domain/*     plugins/api
                    │                        │
                shared/types, shared/permissions
```

**关键设计（值得保持）**：

1. **`rpc-dispatch.ts` 不 import electron** —— 所以写门控（lease 校验）能被单测直接喂假 manager 跑。
   这是本项目可测性的地基。
2. **纯逻辑外提成体系**：`domain/environment.ts`（状态机 / lease）、`browser/target.ts`（选择器解析）、
   `matcher.ts`、`refs.ts`、`input.ts`（chord 解析）、`policy.ts`（CDP 白名单）、`net/rules.ts`、
   `user-agent.ts`。**34 个单测文件全部跑在 `node:test` 上，不需要 Electron。**
3. **硬约束单一来源**：`shared/permissions.ts` 是权限表的唯一来源（`AGENTS.md` 硬约束 6，
   历史上抄过两份，已修）。
4. **动作层有必经之路**：`actionability.ts` 的 `runAction` / `checkActionable`，`AGENTS.md` 明令不许绕过。

### 1.3 测试覆盖盘点

| 层 | 怎么覆盖 | 现状 |
|---|---|---|
| 纯逻辑 | **单测**（34 文件 / 240 用例） | 状态机、lease、选择器、chord、ref 表、net 规则、HAR、插件 manifest/registry/v2、vault、store、tabs、rpc 门控、user-agent |
| IO / 集成 | **GUI 回归**（`scripts/regress/run-all.sh`） | 146 条，11 个域 |
| 静态 | CI（`.github/workflows/ci.yml`） | lint → typecheck → test → 渲染层构建 |

**没有独立单测、靠回归覆盖的模块**：`controller.ts` / `actions.ts` / `waits.ts` / `page-helpers.ts` /
`snapshot.ts` / `session.ts` / `keymouse.ts` / `escape.ts` / `actionability.ts` / `telemetry.ts` /
`net/interceptor.ts` / `plugins/{host,runtime,api,settings,storage}.ts` / `main.ts`。
—— **这是合理取舍**（这些模块的本质是 CDP 与 Electron 交互，单测价值低），
但意味着**它们的行为主要靠回归保护**；CI 已有 `gui-regression`（2026-10-19 起不再
`continue-on-error`），仍需在 GitHub 上把它设为 required check（见 §3.2）。

---

## 2. 能力盘点（对外能做什么）

| 面 | 现状 | 数字 |
|---|---|---|
| RPC 方法 | `rpc-dispatch.ts` | **101** 个 |
| CLI 命令组 | `env / tab / group / browser / net / plugin / vault / events / exec / call` | **11** 组 |
| 浏览器能力 | 导航 / 等待（7 种）/ 元素动作 / 键鼠坐标 / 截图 / AX 快照 / dialog / 上传下载 / 拖拽 / shadow / 跨源 iframe（OOPIF）/ 逃生舱（evaluate / fetch / cdp） | 19 个模块 |
| 网络拦截 | mock / block / redirect / delay / 改请求响应头 / HAR 录制回放 / 命中记录 / 临时放行 | 3 个模块 |
| 插件 | manifest v2 三层权限 / sandbox（`node:vm`）+ host（`utilityProcess`）两种运行时 / kv / 独立 SQLite / 信号 / 面板 | 7 个模块 |
| 凭据 | safeStorage 加密，**无 reveal 通道**，`vault.fill` 只填不返 | 3 个模块 |
| 协作 | lease（60s TTL）/ 原生输入遮罩 / 人机同视 | — |
| 环境 | 独立 session / 独立代理 / 分组 / LRU 回收 / 崩溃恢复 | — |
| 界面 | 环境侧栏 + 标签条 + 地址栏 + 检查器（事件/快照/控制台/网络/规则）+ 设置 | 42 个组件 |

---

## 3. 评价

### 3.1 做得好的（有证据）

1. **可测性不是事后补的**：纯逻辑外提 + `rpc-dispatch` 不依赖 electron，让 240 个单测能跑在
   最轻的运行时上。这是本项目最值钱的结构决策。
2. **安全边界写成了硬约束并落到代码**：权限单一来源、CDP 白名单、路径护栏、脱敏、
   `vault` 无 reveal、cookie 受控通道 —— 而且 `AGENTS.md` 里逐条写清了"为什么不能退"。
3. **踩过的坑变成了文档里的判据**：`HANDOFF.md` 的 11 条已知问题都带确切报错和症状
   （例如"遥测 hook 抛异常会让目标半初始化，之后 CDP 全部挂住"）。
4. **回归套件自足**：`run-all.sh` 自己补环境、补插件、补探针文件，跑完自己清。
5. **文档密度**：22 份、8000+ 行，决策与被拒方案都有记录。**换内核那条线能一路追溯到
   `TECH-STACK-RESEARCH.md` §13，不用重新论证。**

### 3.2 结构性风险（按严重度）

1. **`environments.ts` 1359 行的 God object** —— 它同时管 session 生命周期、lease、遮罩联动、
   tabs 挂载、telemetry、net 接线、插件触发。改任何一条线都要动这个文件，
   而它**没有单测**（只有回归覆盖）。这是最可能出"看起来改了没生效"的地方。
2. **回归套件在 CI 里还不阻塞合并** —— 2026-10-19 已删 `continue-on-error`，但还需在
   GitHub branch protection 里把 `gui-regression` 设为 required check。否则 CI 仍只保护
   静态 + 单测，浏览器层的改动要靠人记得手动跑。
   `run-all.sh`。`AGENTS.md` 靠纪律兜着，但纪律不是机制。
3. **文档与代码的同步靠纪律** —— `AGENTS.md` 要求"改 RPC / 数据模型 / 硬约束 / 运行方式
   必须同步 `HANDOFF.md`"，但没有机械检查。22 份文档的维护成本是真实的。
4. **真实性缺口**（见 `ELECTRON-REALISM-PLAN.md`）：联调场景下最要命的几条是
   **扩展不支持（DevTools 扩展用不了）**、**请求/响应 body 不可见**、**AX 树为主通道看不到视觉问题**。
5. **单点人员风险** —— 所有决策和踩坑知识集中在一份 `HANDOFF.md` 里，这是**优点也是风险**。

### 3.3 缺口清单（指向别的文档，不在这里重复）

- 换内核 / 套壳那条线：`CHROME-SHELL-PLAN.md`（结论：不做，除非先验证窗口↔Profile）
- 联调真实性：`ELECTRON-REALISM-PLAN.md`（P0 五项）
- 未做完的能力：`HANDOFF.md` §6「未做 / 受阻」

---

## 4. 本次全功能验证（2026-10-17 实测）

```
npm run lint                                  → 通过
npm run format:check                          → 通过
npx tsc --noEmit                              → 通过
npm test                                      → 240/240
vite build --config vite.renderer.config.mjs  → 通过
bash scripts/regress/run-all.sh               → 146 PASS / 0 FAIL（1 条预期 SKIP）
```

回归覆盖的 11 个域（`/tmp/warren-regress.txt`）：
`G0 静态门` / `浏览器能力 V1–V15` / `网络拦截 n1–n5` / `核心域（环境·租约·遮罩·标签·分组·遥测·CLI）` /
`Vault 端到端` / `插件` / `浏览器能力补充（截图·逃生舱·等待·上传下载·拖拽·shadow·dialog·键鼠·标签）` / `UI`。

唯一非 PASS：`SKIP 5.7 这个 vault 里没有解不开的凭据`（预期）。

**跑之前必须做的两件事**（否则是一大片假 FAIL）：
1. 按 `AGENTS.md` 已知问题第 4 条清理后 `npm start`；
2. `node scripts/regress/run-all.sh` 前**先让 Warren 窗口到前台**
   （`node bin/warren.mjs call debug.focusWindow`，或手动点一下窗口）。
