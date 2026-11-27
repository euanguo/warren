# Warren AI 浏览器能力评估与公开基准体系

> 本文档记录三件事：
> 1. **我们如何科学评估 Warren 的真实浏览器操作能力**（业界 4 级公开基准地图、可复现自动化套件、下次大规模改造的回归手册）。
> 2. **基于公开基准真机压测暴露的 6 项核心引擎/感知缺陷改造计划与闭环记录**（2026-11-27）。
> 3. **42 项公开基准 + 5 项效率微基准实测基线成绩**，以及可直接引用到根 `README.md` 的摘要片段。

---

## 1. 业界 AI 浏览器操作测试基准地图（4 级能力金字塔）

在 AI 浏览器自动化领域，业界通常按任务复杂度与环境确定性将公开基准分为 4 级：

| 层级 | 代表公开基准 | 评估重点 | 确定性 / 复现成本 | 适用时机 |
|---|---|---|---|---|
| **Tier 1：原子交互与现代 DOM 陷阱** | **Farama MiniWoB++**（核心交互）<br>**UI Testing Playground (UITP)**<br>**The Internet (Herokuapp)** | Shadow DOM 穿透、元素遮挡检测、拖拽、异步等待、动态 ID、hover/iframe/弹窗/上传、隐藏元素判别 | 极高（本地静态 HTTP / 公开稳定靶场，2 分钟跑完） | **每次引擎 / CLI / 感知层改动必跑**（核心准入门禁） |
| **Tier 2：复杂多步控件与 SPA 工作流** | **MiniWoB++ Hard / Multi-Step**（`book-flight-nodelay` / `email-inbox-star-reply` / `navigate-tree` / `search-engine` / `click-tab-2-hard` / `multi-layouts` / `click-collapsible-2` / `use-spinner` / `click-checkboxes-large`）<br>**UITP & Herokuapp Hard**（`nested_frames` / `dynamictable` / `visibility` / `mouseover` / `dynamic_controls` / `tables` / `hovers` / `upload`） | 双 Autocomplete + Readonly 日历翻月 + 比价下单、Webmail 多步状态机、递归文件树、分页搜索、多层嵌套 Frame、DOM 悬浮替换自愈、复杂表格提取与校验 | 高（脚本自动化评测，2–3 分钟全量出分） | **每次大版本升级或浏览器引擎重构必跑** |
| **Tier 3：自托管真实全栈应用** | **WebArena** / **VisualWebArena**（GitLab / 电商 / Reddit / 地图 / CMS）<br>**WebChoreArena**（长周期记忆与批量任务）<br>**WorkArena**（ServiceNow 企业表单） | 长链路规划、跨站状态保持、批处理效率、凭据/登录态持久化 | 中（需 Docker 托管 4–6 套全栈应用，首次搭建重） | **季度里程碑 / 对外发布横向对比** |
| **Tier 4：开放公网与深度研究** | **Online-Mind2Web** / **WebBench** / **Browser Use Bench** / **Mind2Web 2** / **BrowseComp** | 真实公网抗脆弱性、反爬隐身、并发读池吞吐、深度信息综合 | 低（受公网改版与网络波动影响，常需 LLM-as-a-Judge） | **专项能力验证（并发读池 / 隐身 / Flow 复用）** |

> **关键方法论区分**：
> - **Engine & CLI Harness 评测（本仓库持续回归的核心）**：用确定性驱动脚本通过 `warren` CLI 操作真实公开基准，剥离 LLM 推理随机性，精确度量 Warren 的**感知完整度（`snapshot -i`）、动作成功率（Actionability / Shadow DOM / Frame / Drag / Upload）、上下文压缩（Action Delta / 折叠）与执行速度**。
> - **End-to-End Agent 评测**：在相同 LLM 模型下对比不同浏览器工具（如 Playwright MCP vs Chrome DevTools MCP vs Warren v4），重点衡量**任务通过率、总回合数（Turns）、输入 Token 消耗、端到端耗时**。

---

## 2. 公开基准暴露的问题与闭环改造记录（2026-11-27）

在两轮真机压测（首轮 25 项基准 **84.0%** → 扩充至 42 项含高难多步 SPA 后初测 **81.0%**）中，公开基准一共精准暴露出 **6 个真实引擎/感知缺陷 + 1 个 Electron 平台边界**，现已全部完成根因定位、代码改造与单测加固：

| # | 优先级 | 触发用例 | 根因定位 | 落地方案与修改文件 |
|---|---|---|---|---|
| 1 | **P0** | `uitp:shadowdom` | CDP `DOM.getNodeForLocation` 命中 Open Shadow DOM 按钮内部 FontAwesome 图标的 `::before` 伪元素；`DOM.resolveNode` 无 `objectId` 或返回非标准 DOM 对象导致 `RELATION_CHECK_JS` 返回 `false`，误报 `TARGET_OCCLUDED: 目标被 <未知元素> 遮挡` | `src/main/browser/click-point.ts` 新增三态 `evaluateHitAcceptance()`（`'accepted' \| 'blocked' \| 'unresolvable'`），对无法 resolve 或 `DOM.describeNode` 含 `pseudoType` 的节点返回 `'unresolvable'`；`src/main/browser/actionability.ts` 将 `'unresolvable'` 交回已穿透 Open Shadow DOM 的 `snapshot.hit` 裁决（内部图标放行，外部伪元素遮罩仍拦）；`describeDomNode` 退回输出 `::before` |
| 2 | **P0** | `internet:iframe`<br>`internet:nested_frames` | `browser frame select` 设置了 `#activeFrameId`，但 `evaluate()` 始终向主文档发 `Runtime.evaluate`，且同源子帧的 `locator.isolatedContext()` 仍取主帧 `frameTree.frame.id`，导致切入子帧/多层嵌套 `<frameset>` 后求值与 CSS 定位失效 | `src/main/browser/escape.ts` 的 `evaluate()` 支持 `ctx.activeFrameId?.()`（跨源 OOPIF 路由到对应 child `sessionId`；同源/嵌套子帧按 `frameId` 创建隔离世界执行，零 `Runtime.enable` 隐身开销）；`src/main/browser/locator.ts` 的 `isolatedContext()` 同样按 `(sessionId, activeFrameId)` 隔离缓存 |
| 3 | **P1** | `uitp:overlapped` | 输入框位于局部滚动容器内且中心点正被同级绝对定位遮挡条覆盖，`DOM.scrollIntoViewIfNeeded` 认为元素已在视口内未滚动，页面 `input` 监听用 `elementFromPoint` 检测到遮挡并清空输入，触发 `FILL_UNCONFIRMED` | `src/main/browser/form-actions.ts` 在 `fill()` 聚焦前检测元素中心命中；若被外部元素遮挡，主动轮转 `scrollIntoView`（`center` → `start`）将输入框滚出遮挡区再执行输入（无遮挡零开销，透明包装层不误拒） |
| 4 | **P1** | `miniwob:drag-box` | 无文本、无 `cursor: pointer`、无 ARIA role 的 `.ui-draggable` / `[draggable="true"]` / `.ui-droppable` 元素在 `snapshot -i` 中完全不可见 | `src/main/browser/roles.ts` 将 `draggable`、`droppable` 加入可交互角色白名单；`src/main/browser/snapshot.ts` 显式检测 `getAttribute('draggable') === 'true'`（避免误伤默认 `<img>`/`<a>`）、`.ui-draggable`、`ondrop`/`.ui-droppable` 并回退 `#id` 命名，`drag-box` 现可 100% 凭 `@N` 完成 |
| 5 | **P1** | `uitp:mouseover`<br>`miniwob-hard:email-inbox-star-reply` | (a) 无 `href` 的 `<a>` 在 AXTree 归为 `generic`，又被 DOM 补盲 `isNative` 跳过，且未识别 `onmouseenter`/`onmouseover`；(b) 无文本纯图标 `cursor: pointer` 控件（如 Webmail 的 `#send-reply` / `.star` / `.trash`）被 `if (text \|\| explicitInteractive)` 过滤 | `src/main/browser/snapshot.ts` 将 `isNative` 收窄为带 `href` 的 `<a>`，加入 `onmouseenter`/`onmouseover` 判定，并对含图标媒介（CSS `content:url(...)`/`backgroundImage`/`svg`/`img`/`i`）的小尺寸 `cursor: pointer` 控件补盲（回退 `#id` 或语义类名），实现纯 `@N` 点击 |
| 6 | **P1** | `miniwob:use-autocomplete-nodelay`<br>`miniwob-hard:book-flight-nodelay` | `isVisibleFloatingFlyout` 仅识别原生 ARIA `menuitem`/`option`，对 jQuery UI `.ui-autocomplete`/`.ui-menu-item` 等浮层仍触发 `scrollIntoView` 存在失焦收起风险 | `src/main/browser/actionability.ts` 扩展 `isVisibleFloatingFlyout`，对已在视口内且位于 `fixed`/`absolute` 菜单/自动补全浮层内的项跳过 `scrollIntoView` |
| 7 | **边界** | `internet:javascript_alerts` (`JS Prompt`) | Electron 原生支持 `alert()` 与 `confirm()`（均正常触发 CDP `Page.javascriptDialogOpening`），但刻意不实现 `window.prompt()`（静默返回 `null`） | 坚守隐身与安全硬约束（`src/preload/page-preload.ts`），绝不注入可被反爬检测且有死锁风险的 `ipcRenderer.sendSync` 猴子补丁；已在 `skills/warren/SKILL.md` 与本文档透明声明 |

配套单测已全部固化在 [tests/benchmark-fixes.test.ts](../../tests/benchmark-fixes.test.ts)（9 项单测覆盖伪元素双分支、真实遮挡拦截、同源/跨源 `activeFrameId` 求值、拖拽角色白名单）。

---

## 3. 实测成绩总览（2026-11-27 改造后终测）

### 3.1 公开真机基准（`scripts/bench/public-eval.mjs --suite=all`）

在隔离态真机实例（`WARREN_HOME=/tmp/warren-bench-live`）上一次连续跑完全部 4 个分层 Suite、共 **42 项公开任务**，全部通过 CLI 真实交互完成：

| Suite | 改造前（首轮 / 扩充初测） | 改造后终测 | 平均步数 | 总耗时 | 关键考察项实测证据 |
|---|---:|---:|---:|---:|---|
| **`miniwob-core`**（Farama MiniWoB++ 核心 15 项） | 14/15 (93.3%) | **15/15 (100.0%)** | 4.0 | 23.5s | `drag-box` 纯 `@3 -> @4` 过关；`use-autocomplete-nodelay` 纯 `@N` 过关；`click-scroll-list` 多选过关 |
| **`miniwob-hard`**（MiniWoB++ 复杂多步 SPA 9 项） | 8/9 (88.9%) | **9/9 (100.0%)** | 8.9 | 26.3s | `book-flight-nodelay`（双 Autocomplete + Readonly 日历翻月 + 比价/比时长下单，14–16 步 ~4.5s）；`email-inbox-star-reply`（`star` `@26` 与 `reply` `#send-reply` `@34` 双分支纯 ref 通关）；`navigate-tree` / `search-engine` / `multi-layouts` / `use-spinner` 全通 |
| **`online-dom`**（UITP 6 项 + Herokuapp 4 项） | 7/10 (70.0%) | **10/10 (100.0%)** | 3.1 | 47.9s | `uitp:shadowdom` 2 步 `click @5` 生成 UUID；`uitp:hiddenlayers` 精确拦截 `TARGET_OCCLUDED`；`uitp:overlapped` 1 步滚出并输入；`internet:iframe` 切入 `mce_0_ifr` 读取成功；`alert`/`confirm` 全通（注：`window.prompt` 为 Electron 已知边界） |
| **`online-hard`**（UITP 3 项 + Herokuapp 5 项） | 5/8 (62.5%) | **8/8 (100.0%)** | 4.4 | 28.6s | `internet:nested_frames`（6 帧嵌套全读 `[LEFT/MIDDLE/RIGHT/BOTTOM]`）；`uitp:visibility`（6/6 状态 + overlapped 遮挡拦截）；`uitp:mouseover`（`@9 -> @11` 悬浮替换 DOM 连点 2 次）；`dynamic_controls` / `tables` / `hovers` / `upload` 全通 |
| **合计（TOTAL）** | **34/42 (81.0%)** | **42/42 (100.0%)** | **5.0** | **126.4s** | **0 失败、0 跳过、全部真机端到端实测** |

### 3.2 无头 Agent 效率微基准（`scripts/verify/agent-efficiency-bench.mjs`）

| 效率场景 | 改造前（传统逐条命令 + 原始 JSON） | Warren v4 实测 | 收益 |
|---|---:|---:|---:|
| 1. 表单提交弹窗 Action Delta | 3 回合 / 119 tokens | **1 回合 / 41 tokens** | **回合 -67%，Token -66%** |
| 2. 100 项列表折叠 + 禁用折叠 + 会话笔记去重 | 914 tokens | **131 tokens** | **Token -86%** |
| 3. 离屏 4 并发读池（8 URLs） | 288 ms（串行） | **72 ms（并行）** | **4.00x 加速** |
| 4. Exec v2 持久化 `state` 故障续跑 | 重复抓取 2 页 | **0 页重复抓取** | **100% 消除断点返工** |
| 5. Auto-Flow v2 零模板录制复用 | 6 回合 | **1 回合**（自动推断 `data.items`） | **回合 -83%** |

---

## 4. 持续评估操作手册（下次大规模改造标准回归流程）

仓库已将全部评测脚本固化为**零污染、一键可复现**流程，每次做引擎/感知/CLI 大规模改造后，按以下 4 步复跑并对比历史 JSON 报告：

```bash
# Step 1：跑无头静态门禁 + 全量单测/UI 测试 + 效率微基准
npm run check
node scripts/verify/agent-efficiency-bench.mjs

# Step 2：准备本地 MiniWoB++ 静态靶场（首次约 3 秒）
git clone --depth 1 https://github.com/Farama-Foundation/miniwob-plusplus.git /tmp/miniwob-plusplus
python3 -m http.server 8910 --bind 127.0.0.1 --directory /tmp/miniwob-plusplus/miniwob/html &

# Step 3：启动隔离态 Warren 实例（绝不碰宿主 ~/.warren 或用户桌面 Warren.app）
lsof -ti :5173 | xargs kill -9 2>/dev/null || true
rm -rf /tmp/warren-bench-live
WARREN_HOME=/tmp/warren-bench-live npm start &
# 待 /tmp/warren-bench-live/runtime/envd.sock 就绪后运行 42 项公开基准：
WARREN_HOME=/tmp/warren-bench-live node scripts/bench/public-eval.mjs \
  --suite=all \
  --miniwob-url=http://127.0.0.1:8910/miniwob \
  --out=/tmp/warren-bench-report.json

# 常用按需子集命令：
#   仅跑离线确定性套件（24 项，无外网依赖，~50s）：--suite=miniwob-core,miniwob-hard
#   单点调试某项任务：--suite=all --task=shadowdom

# Step 4：清理临时进程与沙箱目录
kill $(lsof -ti :8910) 2>/dev/null || true
pkill -f "electron-forge start" 2>/dev/null || true
rm -rf /tmp/warren-bench-live /tmp/miniwob-plusplus
```

### 后续演进建议（冲击 Tier 3 / Tier 4）
- **Tier 3（WebArena / WorkArena）**：待准备 Docker 托管环境后，可基于 `scripts/bench/public-eval.mjs` 同构架构接入 WebArena 的 Shopping/GitLab/Forum 子集，并在相同 LLM 模型下对标 Playwright MCP / Chrome DevTools MCP，量化 Warren v4 的**端到端任务通过率 + 总 Token / 回合节省曲线**。

---

## 5. 可直接写入根 `README.md` 的评测章节模板

> 以下片段已按最新实测数据校准，后续更新 `README.md` 时可直接引用：

```markdown
## Benchmarks & Evaluation

Warren is continuously evaluated across both **public browser benchmarks** (real Electron runtime, isolated `WARREN_HOME`) and **agent context-efficiency micro-benchmarks**:

- **Public Browser Suite (`scripts/bench/public-eval.mjs`) — 42/42 (100%)**:
  - **Farama MiniWoB++ Core (15/15)**: forms, dialogs, tabs, scroll multi-select, autocomplete flyouts, and pure `@N` drag-and-drop (`drag-box`).
  - **Farama MiniWoB++ Hard / Multi-Step SPAs (9/9)**: recursive file trees (`navigate-tree`), paginated search (`search-engine`), 5-layout adaptive forms (`multi-layouts`), webmail workflows (`email-inbox-star-reply`), and end-to-end flight booking with dual autocomplete + datepicker (`book-flight-nodelay`).
  - **UI Testing Playground & The Internet (18/18)**: Shadow DOM icon click (`shadowdom`), occlusion detection (`hiddenlayers`), overlapped scroll-into-view typing (`overlapped`), nested `<frameset>` / `<iframe>` evaluation (`nested_frames`, `iframe`), 7-mode visibility verification (`visibility`), hover-replaced DOM links (`mouseover`), dynamic async controls, sorting tables, hover reveal, file upload, and native `alert`/`confirm` dialogs *(note: `window.prompt()` is not natively implemented in Electron)*.
- **Agent Efficiency Micro-Bench (`scripts/verify/agent-efficiency-bench.mjs`)**:
  - **-66% to -86% token usage** via default Action Delta receipts, long-list/disabled folding, and per-session context deduplication.
  - **4.00× faster** multi-URL reading via the offscreen concurrent read pool; **6→1 turns** via zero-template Auto-Flow reuse.

See [`docs/BENCHMARK-EVALUATION.md`](docs/BENCHMARK-EVALUATION.md) for the full 4-tier evaluation pyramid and reproducible commands.
```
