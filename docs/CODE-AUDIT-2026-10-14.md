# Warren 代码质量审查（2026-10-14）

方法论：`ponytail-audit`（正确 > 安全 > 负载下能扛 > 有测试 > 快 > 精简）。
只读审查，未改任何代码。

## 负载假设

单机单用户的本地 Electron 桌面工具：一个人（或一个人加一个 agent）用；
agent 通过 `warren` CLI 走 Unix socket RPC 驱动，一次 `exec` 跑一整段脚本；
一个 Environment = 一个 Chromium session + 若干标签；人和 agent 看同一个页面。
按这个规模判断，不按互联网服务。真实会碰到的压力：同时开很多环境、
一次 `exec` 跑很久、RPC 60s 超时与 lease 60s TTL 打架。

---

## Must fix

### 1. snapshot 的 ref 表被内部调用重置，`@N` 会静默指到别的元素

- **What this is:** `@1..@N` 是 snapshot 给每个可访问性节点的编号，agent 用它来点元素。
  `RefTable.register`（`src/main/browser/refs.ts:21`）每次调用都 `#map.clear()`，
  编号从 `@1` 重新开始，**只有整页导航才会让老 ref 报 `TARGET_STALE`**（`bump()` 才动 gen）。
- **Problem:** `snapshot()` 不只有 agent 显式调用，内部还调了 4 处：
  `waitFor` 的文本/role 判定（`controller.ts:530,533`，每 150ms 一次）、
  `#backendIdForAria`（`controller.ts:870`，每次用 `text=`/`role=`/`label=` 定位都走）、
  `env.egress`（`rpc.ts:231`）、渲染层检查器的快照按钮（`main.ts:170`）。
  所以「先 snapshot 拿 `@3`，再用 `text=` 点一个按钮，再点 `@3`」这个正常顺序里，
  `@3` 已经指向另一个元素，而且**不报错**。
- **Fix:** 分开「ref 表」与「本次快照的编号」：内部解析用独立一次性的表，
  或 `register` 改成只追加、不 clear；gen 只由 `navigate/reload` 推。
  最小改法：`#backendIdForAria` 不调 `snapshot()`，改成只读 AX 树（不注册 ref）。
- **If we skip it:** agent 点错元素，且没有任何错误码提示——静默点错是这类工具最难查的失败。

### 2. 环境重启后下载彻底失效（监听器挂在旧队列上）

- **What this is:** 下载走 session 的 `will-download` 事件，把条目记进「环境级 pending 队列」
  （`#wireDownloads`，`src/main/environments.ts:305`）。
- **Problem:** `#downloadSessions` 这个 Set **只在 start 时加、从不在 stop 时删**
  （`environments.ts:305-307`），而 Session 对象在 `#sessions` 里跨重启复用
  （`#sessionFor`，`environments.ts:290`）。于是第二次 start 时 `#wireDownloads` 直接 return，
  监听器仍闭包着**上一次 start 的 pending**。新 pending 永远收不到下载：
  `page.downloadSaveAs` 报 `DOWNLOAD_FAILED: 未知下载`，`waitForEvent('download')` 超时。
  stop 时 `#telemetry.detachSession(ses)` 做了对称清理，下载这条漏了。
- **Fix:** `stop()` 里 `this.#downloadSessions.delete(ses)`（一行）；
  或把监听器注册一次、用 `this.#pending.get(id)` 动态取队列。
- **If we skip it:** 每个环境只有第一次启动能下载；下载是 agent 的常见动作，重启是常规操作。

### 3. lease 只有 60s TTL，一次长脚本会在中途被拒

- **What this is:** 写操作要持 lease，`LEASE_TTL_MS = 60_000`（`environments.ts:24`）；
  CLI `exec` 自动取一个 lease，脚本跑完才还（`bin/warren.mjs:472-487`）。
- **Problem:** TTL 到期就失效，而 `env.acquire` 在已有 lease 时直接 `ENV_BUSY`（`environments.ts:573`），
  **没有任何续租通道**。所以任何超过 60 秒的 `exec` 脚本，从第 60 秒起每个写操作
  都报 `ENV_NOT_LEASED`，脚本会失败；同一环境的下一次 acquire 还要等旧 lease 到期（最多 60s）。
  「agent 一次 exec 跑很长脚本」正是本项目声明的真实负载。
- **Fix:** 续租而不是加长 TTL：CLI 在 lease 剩不到一半时再调一次 `env.acquire`
  （主进程侧：已有 lease 且 owner 是 agent 时直接续期并返回同一个 leaseId）。
- **If we skip it:** 长脚本必然失败，还留下一个没人持有的 lease，用户只能干等。

---

## Should fix

### 4. 下载记录与句柄只增不减

- **What this is:** 每次下载往 `EnvPending.#downloads` 和 `#byId` 各存一条
  （`src/main/browser/pending.ts:43`），里面还握着 Electron 的 `DownloadItem`。
- **Problem:** 只有 `clear()`（环境 stop）会清。一个环境跑一整天、反复下载，
  两个结构一直涨；被消费的 popup 会 `shift()` 掉，download 不会。
- **Fix:** `consumeDownload` 之外再留一个上限（比如只保留最近 50 条），
  或在 `item.on('done')` 后把条目挪到一个已完成的小表。
- **If we skip it:** 长驻环境的内存慢慢涨；数量级不大，但没有任何上限。

### 5. 每次快照都逐帧取整棵 AX 树，`waitFor(text)` 每秒做 6 次

- **What this is:** `#axFrames` 对每个 frame 调一次 `Accessibility.getFullAXTree`
  （`src/main/browser/controller.ts:400-425`）。
- **Problem:** `waitFor({text})` / `waitFor({role})` 每 150ms 就 `snapshot({limit: 2000})`
  一次（`controller.ts:526-552`），每次都是「一帧一次 CDP + 遍历全部节点」。
  iframe 多的页面就是每 150ms 十几条 CDP 命令，空等到 15s 超时。
  另一个浪费：`#backendIdForAria` 为解析一个 `text=` 选择器做一次 limit 2000 的全量快照
  （`controller.ts:870`）。
- **Fix:** `waitFor` 用 `waitForFunction`（页面内轮询）代替主进程反复取 AX 树；
  文本匹配只在需要时取一次。
- **If we skip it:** 等待类调用把主进程和页面都拖慢，脚本整体变慢。

### 6. controller.ts 把 8 类职责放在一个文件里

- **What this is:** `src/main/browser/controller.ts` 1614 行，同时负责导航、七种等待、
  AX 快照、选择器解析与目标归一、八种动作、弹窗/下载、逃生舱（evaluate/fetch/cdp）、键鼠。
- **Problem:** 按职责拆才对，不是按行数。现在的耦合是有代价的：第 1 条 bug 的根因就是
  「快照」和「目标解析」共享同一个 ref 表；第 5 条是同一处耦合的另一面。
  想单测等待逻辑就得把整个 Electron 门面拖进来。
- **Fix:** 按 job 拆出 snapshot / waits / actions / escape-hatch / keyboard，
  ref 表的归属跟着 snapshot 走。计划 §12 记录过「8 文件比 9 文件好」的取舍，
  但那份记录只算了重复注入 ctx 的成本，没算 ref 表被内部调用破坏这条。
- **If we skip it:** 每加一种等待或动作，都要在一个 1600 行的文件里确认它有没有顺手重置 ref 表。

### 7. 最危险的两块逻辑没有测试

- **What this is:** 84 个单测（全部通过）覆盖了选择器解析、chord、RefTable 的导航失效、
  CDP 白名单、路径护栏、store 迁移、TabList 规则等纯逻辑。
- **Problem:** 两块高风险的没有：① `RefTable.register` 的**覆盖**语义——现有测试只测了
  `bump()` 之后的 stale（`tests/browser-pure.test.ts:48`），所以第 1 条 bug 不会被任何测试拦住；
  ② `EnvPending`（`src/main/browser/pending.ts`）**一条测试都没有**——popup/download 队列、
  消费语义、收据全部没验证，第 2、4、13 条都在这里。
- **Fix:** 加两个纯单测文件即可（都不需要 Electron）：
  `refs` 覆盖语义 + `pending` 的 push/consume/receipt。
- **If we skip it:** 这两个模块的每次改动都只能靠跑 Electron 手工验。

---

## Nice to have

### 8. `PendingSink` 有一半成员是死代码

- **What this is:** `PendingSink`（`src/main/browser/controller.ts:42-51`）的
  `popups`、`downloads` 两个数组字段声明了、初始化了，**全树没有任何读取点**；
  `peekPopupsSince` 也没有调用点（`pending.ts:70`、`controller.ts:1557`）；
  `markFileChooserSeen`（`controller.ts:502`）没有调用点——所以 `#fileChooserAt` 永远是 0，
  `events()`/`waitForEvent` 里读它的两条分支是死的。
- **Problem:** 读代码的人会以为 popup 队列会在这两个字段里攒着。
- **Fix:** 删掉这 4 处（约 15 行）。`fileChooser` 只剩轮询 `input[type=file]` 那条路径，
  它本来就能用（HANDOFF 记录过这个实现）。
- **If we skip it:** 后来人按字段名理解代码，理解错。

### 9. `receiptSince` / `peekPopupsSince` 的毫秒比较可能漏报

- **What this is:** 收据用 `Date.parse(p.at) > since` 判断「这条 popup 是本次动作之后产生的」
  （`src/main/browser/pending.ts:70,83-85`），两边精度都是毫秒。
- **Problem:** 当 popup 与动作落在同一毫秒时（`createWindow` 在点击同步路径里触发），
  `>` 判定为假，这条 popup 不进收据。`docs/HANDOFF.md` 记录过 popup 收据的实测输出，
  所以我**没能证明**它在真机上稳定复现，只报告这个边界。
- **Fix:** 比较改成 `>=`，或者给 popup 记一个自增序号而不是时间戳。
- **If we skip it:** 极端情况下收据里少一条 popup，agent 以为没开新标签。

### 10. `waitForFunction` 把「页面弹了 dialog」吞成超时

- **What this is:** `waitForFunction` 的轮询体是 `try { evaluate } catch {}`
  （`controller.ts:645-651`），而 `evaluate` 开头有 `#assertNoDialog()`（`controller.ts:1294`）。
- **Problem:** 页面在等待过程中弹出 alert 时，抛出的 `DIALOG_OPEN` 被循环里的空 catch 吃掉，
  调用方最后收到的是 `TIMEOUT`——而这个仓库的既定做法是「有 dialog 就明确报 `DIALOG_OPEN`」。
- **Fix:** catch 里放行 `DIALOG_OPEN`（`if (code === 'DIALOG_OPEN') throw e;`）。
- **If we skip it:** agent 排查方向错，去找「为什么元素没出现」而不是「有个弹窗没处理」。

### 11. 两处小冗余

- **What this is:** ① `TabList.reorder`（`src/main/domain/tabs.ts:75`）在生产代码里没有调用方——
  `store.reorderEnvironments` 走的是 `domain/group.ts` 的 `reorderBy`，只有 `tests/tabs.test.ts:98` 用它。
  ② `isSameOrigin` 在 `src/main/browser/policy.ts:81` 和 `src/main/browser/controller.ts:1608` 各写了一份。
- **Problem:** 两份必须一起改的副本，和一个只被测试用的方法。
- **Fix:** 删 `TabList.reorder`（连带那条测试）；controller 里改成 import `policy.ts` 的那个。
- **If we skip it:** 两份实现迟早分叉（比如以后要给 `isSameOrigin` 加端口或子域规则）。

### 12. `browser-control.ts` 转出文件已无存在必要

- **What this is:** `src/main/browser-control.ts` 现在只有一行 `export {...} from './browser/controller.ts'`。
- **Problem:** 项目内部的引用方只剩 `environments.ts:6` 和 `tabs.ts:4` 两处导入，
  都在同一个进程里；AGENTS 已知问题 §2 里保留转出的理由是「老路径引用不断」，
  而这里没有外部消费者。
- **Fix:** 两处 import 改成 `./browser/controller.ts`，删掉这个文件。
- **If we skip it:** 多一层间接，新人要确认两处到底是不是同一个类。

### 13. `shadcn` 被声明成运行时依赖

- **What this is:** `package.json` 的 `dependencies` 里有 `"shadcn": "^4.14.1"`。
- **Problem:** 全树 `src/`、`bin/`、`scripts/` 零 import；它只是组件库工作流里的 CLI，
  而且 AGENTS 里写的是 `npx shadcn@latest add`（走 npx，不读这个依赖）。
- **Fix:** 删掉这行（`node_modules/.bin/shadcn` 是它的附带产物，删依赖不影响 `npx` 用法）。
- **If we skip it:** 每次安装都多下载一个与运行时无关的包。

### 14. `warren env acquire --wait`（不带值）静默不等

- **What this is:** `--wait=5000` 是轮询等待，实现见 `bin/warren.mjs:160-172`。
- **Problem:** 判断是 `typeof flags.wait === 'string'`；裸写 `--wait` 时 `parseFlags`
  给的是 `true`，于是 `waitMs = 0`，命令立刻以 `ENV_BUSY` 失败，用户以为它在等。
- **Fix:** `flags.wait === true` 时给一个默认等待时间（比如 30s）。
- **If we skip it:** 一次误用换一个「为什么没等」的疑问。

### 15. `exec` 允许 120s，但 RPC 60s 就断开

- **What this is:** `bin/warren.mjs:483` 的 vm 超时是 120_000，
  `CALL_TIMEOUT_MS` 默认 60_000（`bin/warren.mjs:31`）。
- **Problem:** 两个上限不一致，脚本实际活不到 120s；60s 后 CLI 报 `RPC 超时`，
  而服务端那条命令还在跑（页面侧不保证停下），且 lease 见第 3 条。
- **Fix:** 把 vm 超时对齐到 `CALL_TIMEOUT_MS`（或反之），并在文档里写明实际上限。
- **If we skip it:** 超时数字误导调用方，排查时以为是脚本的问题。

---

## 本次实测（证据）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `npx tsc --noEmit` | 退出码 0 |
| 单测 | `npm test` | 84/84 通过，0 失败 |
| 渲染层构建 | `node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs` | 成功（JS 612 kB / CSS 147 kB） |

## Verdict:

整体健康：安全边界（Vault 无 reveal、CDP 白名单、路径护栏、lease 门控）和 store 的原子写都做对了，
84 个单测全绿、类型与构建干净；但要先修 1（ref 会指错元素，且静默）、2（重启后下载全废）、
3（长脚本必然被 lease 拒），再补 7 的两个单测，否则修完还会再犯。

## Lean:

约 -40 行、-1 个依赖：第 8 条 ~15 行（PendingSink 死成员 + markFileChooserSeen）、
第 11 条 ~12 行（TabList.reorder + 重复的 isSameOrigin）、第 12 条 1 个文件、
第 13 条 1 个依赖。

## Not checked:

- 没有启动 Electron、没有跑 CLI：所有需要真机状态的路径（download/popup/dialog 的实际时序、
  `WINDOW_NOT_FOCUSED`、遮罩、`debug.layout` 探针、第 9 条的毫秒边界）都未实测。
- 没读：`src/renderer/components/ui/` 与 `ui-reference/`（组件库镜像上游，按 AGENTS 不属于审查范围）、
  `src/renderer/theme/`、`legacy/`、`logo-candidates/`、`assets/`、`scripts/`、`docs/` 里除
  HANDOFF / BROWSER-CAPABILITY-PLAN / PRD 摘要之外的部分。
- 渲染层只看了 `app/App.tsx`、`lib/native-view-overlay-guard.ts` 和 `features/` 的调用点，
  没逐行读各 feature 组件。
- 还有 4 条候选被筛掉（不满足「有具体触发场景」的门槛）：popup 收据的毫秒竞态（已并入第 9 条）、
  `mouseMove` 的 `steps` 参数是 no-op、插件异步 `run()` 无时限、退出不清理 Electron 辅助进程
  ——后两条 HANDOFF §6 已记录在案。
