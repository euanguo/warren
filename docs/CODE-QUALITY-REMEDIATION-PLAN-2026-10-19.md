# Warren 全仓代码质量改造计划（2026-10-19）

> 来源：独立审查线程 `@thread:thr_d7z3zvyyec` 的全仓只读 review。
> 报告全文：`<$BB_THREAD_STORAGE>/warren-code-quality-review.md`
> 基线：`main` @ `fe18abd`。行号基于该提交；实施后行号会漂移。
> 状态：**计划，未实施**。本文只列改造项、证据、改法、验收和顺序，不改代码。

---

## 0. 结论

本轮 review 找到 **2 个必须修**、**6 个应该修**、**8 个可以优化**；实机验证又抓到
**1 个必须修（F1b）**，另有类型决策、删除/合并、不建议改和未验证项。
全部 16 条审查 findings + 1 条实机新发现都已收进本文。

**最优先的一件事**：环境 id 校验 + 所有用 id 拼路径的 sink 收口 + 删除环境时真正回收
session 目录。三者都在 `Store` / `EnvironmentManager` / 下载临时区这一个 seam 上，
但挡的是「数据写到数据根之外」「删到数据根之外」和「删掉的环境带着旧登录态复活」。

**推荐执行顺序**：

```
A 数据边界（F1、F2）
  → B 插件面一致性（F4、F5、F13、F14、F15）
  → C 类型与 RPC 边界（F7、F11）
  → D CI 机制（F6）
  → F 性能与清理（F3、F9、F10、F12、F16）
  → E 文档同步（F8，最后做，数字才不会再次过期）
```

`F8` 放最后，因为 `npm test` 计数、RPC case 数、文件行数会被前面几批改动影响；先改代码再改文档。

---

## 1. 执行原则

- **一个批次一个根因**；不要在一个 commit 里同时做数据边界、插件面、类型边界和文档同步。
- **P0/P1 先写失败测试再改代码**：F1、F2、F4、F14、F15 都能在纯 `node:test` 里覆盖。
- **每批完成定义**：目标代码改完 + 新测试通过 + 五道静态门 + 相关回归（见 §8）。
- **不改镜像上游路径**：`src/renderer/components/ui-reference/**`、`theme/**`、`icons.tsx`、
  `lib/utils.ts`、`lib/disclosure-motion.ts` 的「零引用导出」是同步策略的代价，不是缺陷。
- **不引 zod**：RPC 边界用现有 `str/num/bool` + 显式类型守卫，保持零运行时依赖。
- **不重写 `rpc-dispatch.ts` 的 111 条 case 派发结构**；只收紧类型和参数形状。
- **当前工作区已有未确认改动**：`docs/HANDOFF.md`、`scripts/electron-name.mjs`。执行前先确认归属，
  不要把本计划的改动和它们混进同一个 commit。

---

## 2. 当前实测证据（2026-10-19 复核）

| 检查 | 命令 | 结果 |
|---|---|---|
| lint | `npm run lint` | 退出 0，oxlint 无输出 |
| format | `npm run format:check` | 退出 0，`All matched files use Prettier code style!` |
| 类型 | `npx tsc --noEmit` | 退出 0，无输出 |
| 单测 | `npm test` | **234 / 234 通过**，34 个 `.test.ts` 文件 |
| 渲染层构建 | `node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs` | 成功；600 modules；JS **696.58 kB**（gzip 217.28 kB）/ CSS 147.42 kB；**>500 kB chunk 警告** |

**规模**：`src/main/environments.ts` **1317 行**；`src/main/rpc-dispatch.ts` **111 条 case**；
`package.json` 有 **15 个 `latest`**（不是报告写的 14 个）。

### 对审查报告的修正

详细复核后，有几处报告结论需要修正，本文按修正后的版本执行：

| 报告说法 | 实测修正 |
|---|---|
| `tests` 35 个测试文件 | **34 个** `.test.ts`；234 个用例数正确 |
| `HANDOFF` §7 有两个 11、两个 12、两个 16、没有第二个 17 | 实测：**重复的是 16（17 之后又出现一个 16）**；原 36 是划掉的历史条，编号存在。为避免破坏大量「坑 36」引用，最终把重复项改成 **16b**，后续编号不动 |
| `SUPPORTED_API_VERSION` 零引用 | 正确。当前 `SUPPORTED_API_VERSIONS = ['2', '3']`，`SUPPORTED_API_VERSION = '3'`；只有复数被 `validateManifest` 使用 |
| F4 把 envAction 循环挪到 `if (!plugin.enabled \|\| !plugin.app) continue` 之后 | **不行**：声明式 envAction 不需要前端 bundle；正确改法是只按 `plugin.enabled` 门控，不能要求 `plugin.app` |
| F10 删 `rpc-dispatch.ts:88` 的 `steps` | **不能直接删**：`clickOptions.steps` 被 `click`/`drag` 的路径合成使用。只该删 `mouseMove` 自己的 `steps`，并让 `browser.mouseMove` 只传 `label` |
| F11 把 `(...args: any[])` 改成 `unknown[]` | **不够**：`unknown[]` 会让每个窄参数回调报错；要用泛型 `handle<A extends unknown[]>`（见 F11） |
| F12 只把 `closeDatabases()` 提前 | 是最小改法；若要保证 `rpc.close()` 也跑完，需要 `event.preventDefault()` + 一次性 quit 标志（见 F12） |
| `package.json` 14 个 `latest` | **15 个** |

### 实机行为验证（2026-10-19，应用已启动 + fixture 8899）

| 探针 | 命令 / 动作 | 实测结果 | 结论 |
|---|---|---|---|
| F1 穿越创建 | `warren env create '../../../../../../tmp/warren-id-probe'` | 成功；返回 `storagePath: /tmp/warren-id-probe` | **F1 确认**：id 没有校验，能落到数据根外 |
| F1b 删除穿越 | `printf probe > "$(node -e 'process.stdout.write(require("os").tmpdir())')/warren-delete-probe"`，再 `env create '../warren-delete-probe'` → `env start` → `env remove` | 探针文件被删除 | **F1b 确认（新发现）**：`stop()` 的临时下载区清理用裸 id 拼路径，能删到 `os.tmpdir()` 任意文件 |
| F2 正常 id 删除 | `env create warren-remove-probe` → `env start` → `env remove` | `~/.warren/core/sessions/warren-remove-probe` 仍存在 | **F2 确认**：正常 id 删除环境不删 session 目录 |
| F4 停用插件菜单 | 右键环境菜单 → `plugin disable com.example.notes` → 再右键 | 停用后菜单仍有「记一条」 | **F4 确认**：disabled 插件的 envAction 仍渲染 |

**计划调整**：新增 F1b，批次 A 从 F1+F2 变成 F1+F1b+F2；F1 的修复必须覆盖所有
「用环境 id 拼路径」的 sink，不能只在 `Store.create` 加正则。

---

## 3. 批次总览

| 批次 | 根因 | 项 | 退出标准 |
|---|---|---|---|
| **A · 数据边界** | 环境 id 是唯一没设防的信任边界；id 被拿去拼临时路径；删环境不删数据 | F1、F1b、F2 | 拒绝穿越 id；临时路径不再用裸 id；`env remove` 后目录不存在；新单测 + 回归 |
| **B · 插件面一致性** | 四条面走 bundle 门控，envAction 漏了；后端 DTO 与前端两套宽度 | F4、F5、F13、F14、F15 | 停用插件菜单项消失；插件拿不到 `leaseId`；失败事件 id 归一；NaN 不再静默；日志 level 归一 |
| **C · 类型与 RPC 边界** | RPC 边界没有 parser，`as never` 是症状 | F7、F11 | options helper 有返回类型和守卫；IPC handler 调用点被检查；tsc 仍 0 |
| **D · CI 机制** | 浏览器行为只有人工回归 | F6 | `gui-regression` 绿过一次并设为 required；删 `continue-on-error` |
| **F · 性能与清理** | 低风险收益项，可随时插队 | F3、F9、F10、F12、F16 | AX 轮询不再每 150ms 拉全树；死导出/死参数删除；WAL 注释与实现一致；chunk 决策落地 |
| **E · 文档同步** | 文档是手写的，没有机械检查 | F8 | 文档数字/路径与最终代码一致；HANDOFF §7 重复项改成 16b |

---

## 4. 详细改造项

### F1 · 环境 id 无校验，`storagePath` 能逃出数据根

**位置**：`src/main/store.ts:361`、`src/main/store.ts:382`、`src/main/rpc-dispatch.ts:162`、
`src/main/main.ts:256`、`bin/warren.mjs:579`、
`src/renderer/features/environments/create-environment-dialog.tsx:72`

**现状/证据**：

- `storagePathFor(id)` 直接 `path.join(this.#dir, 'sessions', id)`。
- `Store.create()` 只检查 `ENV_EXISTS` 和 `GROUP_NOT_FOUND`，不检查 id 形状。
- `path.join(..., '../../../../tmp/warren-escape')` 会落到数据根外；`'..'` 会落到
  `<root>/core` 本身。
- `env start` 会 `mkdir(config.storagePath, { recursive: true })` 并 `session.fromPath(storagePath)`，
  Chromium profile 会写到数据根之外。
- 同一代码库对下载落盘有 `guardSavePath`，环境 id 是唯一没走这条保护的入口。

**根因**：id 是信任边界（CLI 参数、IPC、UI 三条路都到 `Store.create`），但只有「非空字符串」这一层。

**改法**：

1. 在 `src/main/domain/environment.ts` 增加 `assertEnvironmentId(id: string): void`：
   - 正则：`/^[a-z0-9][a-z0-9._-]*$/`
   - 显式拒绝 `.`、`..`
   - 拒绝空串、绝对路径、`/`、`\`、盘符
   - 抛 `BAD_REQUEST`（和插件 id 校验同款语义）
2. 在 `Store.create()` 的 `ENV_EXISTS` 检查之前调用它。RPC / IPC / UI 三条路都经过这里。
3. `storagePathFor()` 里加第二道断言（防御性，不替代 `Store.create` 的校验）。
4. 不改 `EnvironmentManager.create()` 的签名；不在 CLI/UI 各抄一份正则。

**测试**：`tests/store.test.ts` 新增：

- 拒绝 `..`、`.`、`a/b`、`/abs`、`a\b`、空串；
- 接受 `alpha`、`a1`、`my.env`、`my-env`；
- 断言错误码 `BAD_REQUEST`。

**验收**：`npm test` 全绿；`npx tsc --noEmit` 0；启动应用后
`warren env create 'x/../y'` 报 `BAD_REQUEST`，正常 id 不受影响。

**行为/风险**：改变行为（以前能建怪 id）；正常 id 不受影响。工作量 **S**，置信度 **confirmed**。

---

### F1b · 环境 id 被拿去拼临时路径，`stop()` 能删到 `os.tmpdir()` 之外

**位置**：`src/main/environments.ts:790`、`src/main/browser/downloads.ts:32`

**现状/证据（实机确认）**：

- `stop()` 末尾：`rmSync(path.join(os.tmpdir(), 'warren-downloads', id), { recursive: true, force: true })`。
- 下载落盘：`path.join(os.tmpdir(), 'warren-downloads', environmentId)`。
- 实测：在 `os.tmpdir()` 下放一个无害探针文件，创建并启动 id 为 `../warren-delete-probe`
  的环境，再 `env remove`，探针文件被删除。
- 影响：这是比 F1 更直接的破坏性路径——不需要 `env start` 写 profile，只要 stop/remove
  就会删到临时目录之外的任意路径（`..` 足够多可到 `/`）。

**根因**：F1 的同一个根因，但报告只看了 `storagePath`，漏了两个「临时路径」sink。

**改法**：

1. F1 的 `assertEnvironmentId` 仍然要做，覆盖 CLI / IPC / UI 的创建入口。
2. **不要再用裸 id 拼临时路径**：加一个 `safeEnvKey(id)`（建议 `sha256(id).hex` 或
   先验证 id 合法再使用；两者取其一并写注释）。下载临时目录和 `stop()` 清理都必须用它。
3. `downloads.ts` 的 `environmentId` 参数在入口处做一次校验/归一；
   `stop()` 的清理路径改为 `path.join(os.tmpdir(), 'warren-downloads', safeEnvKey(id))`。
4. 加载旧库时如果遇到非法 id：不要静默继续用裸 id 拼路径；至少让路径 sink 走安全 key，
   并在启动时记录一条警告/事件，给出清理建议。

**测试**：

- 在 `os.tmpdir()/warren-downloads` 外放探针文件，用 `../` id 走 `stop`/`remove`，断言探针仍在；
- 正常 id 的下载仍落在 `os.tmpdir()/warren-downloads/<safe-key>/`；
- 非法 id 创建被 `Store.create` 拒绝（F1 测试）。

**验收**：`npm test`；`bash scripts/regress/run-all.sh`；手工重复上面的删除探针，文件必须保留。

**行为/风险**：改变行为（不再信任裸 id 做路径）；正常 id 的临时目录名可能变化，
但临时目录只活到环境停止，无持久兼容问题。工作量 **S**，置信度 **confirmed**。

---

### F2 · `env remove` 不删 session 目录，同名环境带回旧登录态

**位置**：`src/main/environments.ts:413`、`src/main/store.ts:434`、
`src/main/environments.ts:549`（`#sessionFor`）、`src/main/environments.ts:760`（`stop`）

**现状/证据**：

- `EnvironmentManager.remove()` 只做 `stop`、清选中态、`#netOps.drop`、`#tabSnapshot.delete`、
  `store.remove`；`store.remove` 只删 `environments` / `running_state` / `env_tabs` 三张表。
- 全文件唯一的 `rmSync` 是临时下载区（`environments.ts:790`）。
- `stop()` 不删 `#sessions`，所以删环境后 `#sessions` 仍可能持有旧 Session 对象；
  同名重建时 `#sessionFor` 先命中缓存，再谈 `session.fromPath`。
- 影响：① profile 几十~几百 MB 永久留在 `<root>/core/sessions/<id>/`；② 同名重建会带回
  旧 Cookie / Local Storage / 登录态。

**根因**：删除只删了数据库行，没有删环境拥有的文件；同时漏了 `#sessions` 缓存。

**改法**：

1. `EnvironmentManager.remove()`：
   - 先取 `const config = this.#store.configFor(id)`（删除前拿 `storagePath`）。
   - `this.stop(id)` 后 `this.#sessions.delete(id)`。
   - `await this.#store.remove(id)`。
   - `await rm(config.storagePath, { recursive: true, force: true })`（`node:fs/promises` 的 `rm`）。
2. 删除顺序要保证「先摘 Session，再删目录」；如果实测 Electron 仍持有文件句柄，
   在删目录前调用 `ses.flushStorageData()` / `ses.clearStorageData()` 作为候选方案，
   以实测结果决定，不要凭猜加。
3. 更新 `README.md` / `docs/HANDOFF.md`：**删环境 = 删数据**，不是只解绑。
4. 如果 `store.remove` 之后目录删除失败：记录 `environment.removeFailed` 事件并抛错，
   不要静默留下孤儿目录（是否允许 `force` 忽略 `ENOENT` 要写清）。

**测试**：

- `tests/store.test.ts` 或 `tests/environment.test.ts`：`remove` 后 `existsSync(storagePath) === false`。
- 同名重建：先写一个假的 profile 文件，remove 后重建，断言旧文件不存在。
- 如果测 Electron 文件句柄，需要 GUI 回归：`env remove` → `env create` → `env start`，
  检查登录态不复活。

**验收**：`npm test` 全绿；`bash scripts/regress/run-all.sh` 全绿；
手工 `warren env create tmp-remove && warren env remove tmp-remove` 后目录不存在。

**行为/风险**：会真的删目录；用户文档必须同步。工作量 **S**，置信度 **confirmed**
（读码确认；Electron 文件句柄行为需实机验证）。

---

### F3 · `waitFor({text|role})` 每次轮询拉整棵 AX 树

**位置**：`src/main/browser/waits.ts:45-73`、`src/main/browser/snapshot.ts:12`、
`src/main/browser/controller.ts:617`

**现状/证据**：

- `waitFor` 每 150ms 调一次 `readAxNodes(ctx, 2000)`。
- `AX_CACHE_TTL_MS = 120` < 150ms，所以缓存几乎每次过期。
- `#backendIdForAria` 为解析一个 `text=` 定位也拉 limit 2000 的全量树。
- iframe 多时，一次 15s 空等 ≈ 100 轮全量取树。

**根因**：AX 缓存为「单次动作内复用」设计，没考虑 150ms 轮询；等待逻辑用全量树做文本/role 判定。

**改法（二选一，不要同时做）**：

- **短期最小**：把 `AX_CACHE_TTL_MS` 提到 200–300ms，实测等待延迟可接受即可；
  不要超过 500ms，否则等待明显变迟钝。
- **中期正确**：`waitFor` 不再走 `readAxNodes`；文本用页面内 `Runtime.evaluate` 轮询，
  role 用 `Accessibility.queryAXTree({ accessibleName, role })` 做定向查询，只在超时时取一次树。

**测试**：`tests/browser-pure.test.ts` 或 GUI 回归：

- iframe 页面 `waitFor({ text })` 命中时间不退化；
- 页面在等待期间变化时仍能命中；
- `AX_CACHE_TTL_MS` 改动不能破坏 ref 稳定性（`@N` 仍由 `snapshotWithRefs` 唯一分配）。

**验收**：`npm test`；`bash scripts/regress/browser.sh` 的等待类用例全绿；
记录一次 iframe 页面 `waitFor(text)` 的实测耗时对比。

**行为/风险**：轻微改变时序（最多晚 TTL 观察到变化）。工作量 **S**（提 TTL）/ **M**（换轮询体），
置信度 **confirmed**（TTL 与轮询间隔是硬算术；耗时数字待实机复测）。

---

### F4 · 停用插件的 envAction 仍出现在环境右键菜单

**位置**：`src/renderer/lib/plugin-runtime.ts:441-453`、
`src/renderer/features/environments/environment-sidebar.tsx:536-548`、
`src/main/plugins/host.ts:595`

**现状/证据**：

- envAction 收集发生在 `if (!plugin.enabled || !plugin.app) continue;` 之前，disabled 插件照样进
  `registry.envActions`。
- 右键菜单无条件渲染 `pluginActions`。
- `host.run()` 第一步就报 `PLUGIN_DISABLED`。

**根因**：声明式面（envAction）没有跟 `plugin.enabled` 对齐；四条面跟 bundle 走，第五条漏了。

**改法（修正报告）**：

- 不要挪到 `if (!plugin.enabled || !plugin.app) continue;` 之后——那会误删「启用但无前端 bundle」的
  声明式 envAction。
- 正确改法：在收集 envAction 前只判 `if (!plugin.enabled) continue;`，或把收集包进
  `if (plugin.enabled) { ... }`；`plugin.app` 只用于决定是否加载 bundle。
- `plugins/README.md` 保持「声明式的面不需要前端 bundle」的说明不变。

**测试**：`tests/plugin-registry.test.ts` 或 GUI 回归：

- disabled 插件不进 `registry.envActions`；
- enabled 但无 `app` 的插件仍进 `registry.envActions`。

**验收**：`npm test`；`bash scripts/regress/plugin.sh` 全绿；
`warren plugin disable com.example.notes` 后右键菜单项消失（`debug.rendererEval` 查
`[data-slot=context-menu-item]`）。

**行为/风险**：改变行为（停用插件菜单项消失）；对启用插件无影响。工作量 **S**，置信度 **confirmed**。

---

### F5 · 插件后端 `environment.list/get` 返回全量 `Environment`

**位置**：`src/main/plugins/api.ts:213-220`、`src/main/plugins/host-read.ts:36-48`、
`src/shared/types.ts:117-133`、`plugins/whistle/host.mjs:397`

**现状/证据**：

- 插件后端 `environment.list/get` 直接 `deps.manager.list()/get()`，含 `leaseId`、
  `leaseExpiresAt`、`storagePath`、`tabs`。
- 前端只读通道 `HostEnvironmentSummary` 刻意剥掉 `leaseId` / `leaseExpiresAt` /
  `storagePath` / `tabs`。
- `plugins/whistle/host.mjs:397` 真的用 `environment.storagePath` 放 trusted-ca.pem；
  `leaseId` / `leaseExpiresAt` / `tabs` 全树零消费者。

**根因**：插件后端和插件前端是两条边界，后端那条没有做 DTO 投影。

**改法**：

1. 在 `plugins/api.ts` 的 `environment.list/get` 做投影：
   - 剥离 `leaseId`、`leaseExpiresAt`（能力令牌形状，不该出边界）；
   - 保留 `storagePath`（whistle 需要）；
   - `tabs` 先保留还是剥离，按「零消费者 + 未来是否需要」决策；建议先保留并在
     `plugins/README.md` 写明它是主进程内部状态，插件不应依赖。
2. 不要把前端 `HostEnvironmentSummary` 直接复用——会改坏 whistle。
3. 加一个插件后端环境视图的窄类型（或 `Omit<Environment, 'leaseId' | 'leaseExpiresAt'>`），
   并写测试断言投影结果。

**测试**：`tests/plugin-v2.test.ts` 或新增插件 API 测试：

- `environment.list/get` 结果没有 `leaseId` / `leaseExpiresAt`；
- `storagePath` 仍在；
- whistle 的 `trusted-ca.pem` 路径仍然能拿到。

**验收**：`npm test`；`bash scripts/regress/plugin.sh` 全绿（覆盖 whistle）。

**行为/风险**：插件拿到更少字段；对 bundled 插件无影响。工作量 **S**，置信度 **confirmed**。

---

### F6 · GUI 回归在 CI 里仍是 `continue-on-error`

**位置**：`.github/workflows/ci.yml:29-35`、`scripts/regress/run-all.sh`

**现状/证据**：

- `gui-regression` job 有 `continue-on-error: true`；CI 注释自己写着「绿过一次之后删掉」。
- `src/main/browser/**`、`tabs.ts`、`net/**`、`plugins/{host,runtime}` 没有单测，
  行为判据全押在回归上。
- 回归不阻塞合并时，浏览器层改坏 CI 仍绿。

**根因**：CI job 第一次落地时的不阻塞策略没有回收。

**改法**：

1. 先让 `gui-regression` 在 GitHub 上绿一次（本地 `bash scripts/regress/run-all.sh` 也要绿）。
2. 删掉 `.github/workflows/ci.yml` 的 `continue-on-error: true`。
3. 在 GitHub branch protection 把 `gui-regression` 设为 required check。
   - 如果仓库用 `gh`，先 `gh api` 读当前 protection，再合并 required checks，
     **不要覆盖其它规则**。
4. 不为让它绿而给回归加 skip。

**验收**：GitHub Actions 一次 PR run 里 `gui-regression` 是绿色 required check；
失败时 job 里能看到 `tail /tmp/warren.log /tmp/fixture.log`。

**行为/风险**：不改产品行为；改变合并门禁。工作量 **S**，置信度 **confirmed**。

---

### F7 · RPC 边界零校验，111 条方法靠 `as never`

**位置**：`src/main/rpc-dispatch.ts:76-108`、`src/shared/types.ts:301`、`:327`、`:383`

**现状/证据**：

- `navOptions` / `clickOptions` / `fetchOptions` 用 `as never` 把入参喂给强类型方法；
  全文件 28 处 `as never`，1 处 `as unknown as`。
- controller 方法名、参数顺序、`ClickOptions` 字段改名，编译器不会报错。
- `tests/rpc-gating.test.ts` 只覆盖门控，不覆盖参数形状。

**根因**：RPC 参数是 `Record<string, unknown>`，动态派发把类型信息擦掉了。

**改法（不重写派发表）**：

1. 给三个 helper 加显式返回类型：
   - `navOptions(p): NavigateOptions`
   - `clickOptions(p): ClickOptions`
   - `fetchOptions(p): FetchOptions`
2. 把每个 `as never` 换成字段级守卫：
   - `button`：`'left' | 'middle' | 'right'`
   - `position`：`{ x: number; y: number }`
   - `waitUntil`：`WaitUntil`
   - `credentials`：`'omit' | 'include'`
   - 非法值要么 `undefined`，要么 `BAD_REQUEST`；同一字段只选一种口径并写测试。
3. `invoke` 的强类型化作为第二步（M）：先保留动态派发结构，但要有一张
   「RPC case 里出现的 controller 方法名 ⊆ BrowserController 方法名」的源码断言测试；
   直接手写 111 条静态映射不做。

**测试**：

- 新增/扩展 `tests/rpc-dispatch.test.ts`：非法 `button` / `waitUntil` / `credentials` 的行为；
- 合法值原样传给 controller（用 fake controller 断言参数形状）。

**验收**：`npx tsc --noEmit` 仍 0；`npm test` 234+ 全绿；
`rg -n 'as never' src/main/rpc-dispatch.ts` 数量显著下降（目标 0，若动态派发必须保留则只剩
`invoke` 一处并写明理由）。

**行为/风险**：不改行为；非法参数从静默传递变成拒绝（如果有）。工作量 **M**，置信度 **confirmed**。

---

### F8 · 文档与代码漂移

**位置**：`AGENTS.md:310`、`docs/CODEBASE-ASSESSMENT-2026-10-17.md`、
`README.md:192`、`README.md:228`、`docs/HANDOFF.md:187`、`:203`、`:206`、`§7`、
`src/main/tabs.ts:354`

**现状/证据（实测）**：

- `AGENTS.md:310`「当前 173 个」→ 实测 **234**。
- `docs/CODEBASE-ASSESSMENT-2026-10-17.md`：23 个单测文件 / 176 用例 → 实测 **34 / 234**；
  RPC 101 → **111**；`environments.ts` 1301 → **1317**；
  「回归跑不了 CI」→ CI 已有 `gui-regression`，只是 `continue-on-error`。
- `README.md:192` 图标写 `lucide-react` → 实际 Hugeicons。
- `README.md:228` 未完成 M5（LRU 回收 / 崩溃恢复 / SQLite 迁移）→ 三样都已落地。
- `docs/HANDOFF.md:187` `settings-dialog.tsx` → `settings-page.tsx`。
- `docs/HANDOFF.md:203`、`:206` `plugins/example-notes/` 列了两次。
- `docs/HANDOFF.md` §7 编号：**17 之后又出现一个 16**。不整体重排——文档里有大量「坑 36」
  之类引用；把重复项改成 **16b**，后续编号不动。
- `src/main/tabs.ts:354` 注释写 `EnvironmentManager.#refocusSelected`，实际是
  `focusDisplayedPage`（`environments.ts:262`）。

**改法**：逐条改成实测值；HANDOFF §7 重复项改成 16b；不新建文档。
**必须在 A/B/C/D/F 全部完成后执行**，否则数字会再次过期。

**测试/验收**：

```bash
rg -n "173|101 个|23 个单测|176|1301" AGENTS.md docs/CODEBASE-ASSESSMENT-2026-10-17.md
rg -n "lucide-react" README.md
rg -n "settings-dialog|example-notes.*example-notes" docs/HANDOFF.md
```

以上应无命中（或只剩刻意保留的历史语境）。

**行为/风险**：不改行为。工作量 **S**，置信度 **confirmed**。
注意 `docs/HANDOFF.md` 当前有未确认改动，先确认归属再改。

---

### F9 · 死导出（全树含测试 0 引用）

**位置/证据**：

| 导出 | 位置 | 实测 |
|---|---|---|
| `attachedCount` | `src/main/browser/session.ts:242` | 只剩定义 |
| `onDialog` | `src/main/browser/session.ts:246` | 只剩定义 |
| `currentPluginCall` | `src/main/plugins/call-context.ts:21` | 只剩定义 |
| `SUPPORTED_API_VERSION` | `src/main/plugins/manifest.ts:2` | 只剩定义；复数 `SUPPORTED_API_VERSIONS` 才被用 |
| `VaultError` | `src/main/vault/store.ts:43` | 全树零引用 |

**改法**：

- 前四个直接删。
- `SUPPORTED_API_VERSION` 二选一：删除，或改成 `SUPPORTED_API_VERSIONS.at(-1)` 并由测试断言它等于
  `validateManifest` 的当前默认版本；不要留一个没人用的导出。

**验证**：删除前逐个 `rg` 确认；删除后 `npx tsc --noEmit`、`npm run lint`、`npm test` 全绿。

**行为/风险**：不改行为。工作量 **S**，置信度 **confirmed**。

---

### F10 · 参数/变量写了不用

**位置/证据**：

- `src/main/browser/page-helpers.ts:126-159`：`waitForNavigation` 的 `started` 只写不读，
  末尾 `void started` 是 lint 兜底。
- `src/main/browser/keymouse.ts:68-81`：`mouseMove` 的 `opts.steps` 是 no-op，`void opts.steps`。
- `src/main/browser/input.ts:145-162`：`keyEvents` 的 `opts.delay` 是 no-op，`void opts.delay`；
  真正等待延迟的是 `keymouse.ts` 的 `keyboardPress/Type`。
- `src/main/rpc-dispatch.ts:88` 的 `steps` 被 `click`/`drag` 使用，**不能删**；
  只该让 `browser.mouseMove` 不再走 `clickOptions`。

**改法**：

- `waitForNavigation`：删 `let started` 和 `void started`，保留 `onStart` 里的 `clearTimeout` +
  重新 `setTimeout` 行为。
- `mouseMove`：从 `controller.ts:768` 和 `keymouse.ts:68` 的 options 里删 `steps`；
  `rpc-dispatch.ts` 的 `browser.mouseMove` 改为只传 `{ label }`。
- `keyEvents`：从 `input.ts` 签名删 `delay`，`keymouse.ts:172` 的调用去掉 `delay` 参数；
  `keyboardPress/Type` 自己的 `delay` 等待保留。

**测试**：`npm test` + `npm run lint`（`noUnusedParameters` 会挡住漏删的）。

**行为/风险**：不改行为（原本就是 no-op）。工作量 **S**，置信度 **confirmed**。

---

### F11 · IPC 层唯一的 `any`，擦掉 20+ 通道参数类型

**位置**：`src/main/main.ts:248`

**现状/证据**：

```ts
const handle = (channel: string, fn: (...args: any[]) => unknown) => { ... }
```

所有 `handle('x', (id: string) => ...)` 的调用点因此不被检查。

**改法（修正报告）**：

```ts
const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown) => {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window?.webContents) throw new Error('unauthorized sender');
    return fn(...(args as A));
  });
};
```

说明：`unknown[]` 单独用不够——窄参数回调会全部类型报错；泛型 `A` 让每个 `handle` 调用点
自己声明参数形状，运行时那一层保留一次显式断言（边界不可避免）。

**验收**：`npx tsc --noEmit` 0；`npm test` 全绿；`rg -n ': any\[\]' src/main/main.ts` 无命中。

**行为/风险**：不改行为。工作量 **S**，置信度 **confirmed**。

---

### F12 · `before-quit` 是 async，Electron 不等它

**位置**：`src/main/main.ts:519-524`

**现状/证据**：

```ts
app.on('before-quit', async () => {
  manager?.shutdown();
  await rpc?.close();
  // 关库顺带 checkpoint WAL
  closeDatabases();
});
```

`closeDatabases()` 在 `await` 之后，进程可能已退出；注释与实现不一致。

**改法**：

- **最小**：把同步的 `closeDatabases()` 提到 `await rpc?.close()` 之前。
- **保证异步清理**：`event.preventDefault()` + 一次性 `quitting` 标志：

```ts
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  manager?.shutdown();
  void rpc?.close().finally(() => {
    closeDatabases();
    app.quit();
  });
});
```

**测试/验收**：启动应用、退出，检查 `<root>/core/warren.db-wal` 是否存在；
如果走 preventDefault 方案，确认不会出现退出循环。

**行为/风险**：低影响；注释与实现必须一致。工作量 **S**，置信度 **judgement**。

---

### F13 · 插件失败事件的 `environmentId` 没归一

**位置**：`src/main/plugins/host.ts:620-634`

**现状/证据**：成功事件用归一后的 `environmentId`，失败事件仍用 `options.environmentId`
（可能是空串）。

**改法**：失败事件的 `environmentId` 改成 `environmentId`（归一后的变量）。

**测试**：`tests/plugin-v2.test.ts` 增加「不带环境的命令失败时事件里没有空串」。

**行为/风险**：不改行为（只改审计事件字段）。工作量 **S**，置信度 **confirmed**。

---

### F14 · 插件 `browser.waitForTimeout()` 缺参时静默变成 0 等待

**位置**：`src/main/plugins/api.ts:97`、`src/main/browser/waits.ts:221`

**现状/证据**：`Number(undefined)` → `NaN` → `Math.max(0, NaN)` = `NaN` →
`setTimeout(NaN)` 立即返回，调用方以为在等。

**改法**：在插件 API 边界校验：

- `Number.isFinite(ms)` 为真才调用；否则抛 `PLUGIN_BAD_REQUEST`（推荐）。
- 不推荐静默改成 0；静默失败正是这条 finding 要消灭的东西。

**测试**：`tests/plugin-v2.test.ts`：`waitForTimeout()` 缺参 / `NaN` / 负数报错；
合法值仍等待。

**行为/风险**：改变行为（从静默变成报错）。工作量 **S**，置信度 **confirmed**。

---

### F15 · `logs()` 把库里的任意 level 断言成联合类型

**位置**：`src/main/plugins/host.ts:182`、`src/main/plugins/registry.ts:136-156`

**现状/证据**：`readPluginLogs(...) as PluginLogEntry[]`，而 DB 的 `level` 是任意 TEXT。

**改法**：

- 在 `registry.readPluginLogs` 里加 `normalizeLogLevel(value: string): LogLevel`；
- 非法值退到 `'info'`（或 `'error'`，需在测试里固定口径）；
- `host.logs()` 不再用 `as PluginLogEntry[]` 掩盖。

**测试**：`tests/plugin-registry.test.ts`：直接往 DB 插一个非法 level，读回来被归一。

**行为/风险**：不改行为（只改读回来的类型）。工作量 **S**，置信度 **confirmed**。

---

### F16 · 渲染层单 chunk 696 kB

**位置**：`vite build` 输出；入口 `src/renderer/app/App.tsx`、`src/renderer/lib/plugin-runtime.ts`

**现状/证据**：`index-*.js` 696.58 kB（gzip 217.28 kB），Vite 报 >500 kB 警告。

**改法**：先判断是否值得做。本地 Electron 首屏解析影响有限。

- 若做：把设置页 / 插件面 / 检查器面板改成动态 `import()`，让主 chunk 回落到 500 kB 以下。
- 若不做：在 `vite.renderer.config.mjs` 调高 `chunkSizeWarningLimit` 并在注释写明「本地 Electron，
  已测量，接受」，**不要只把警告关掉不留理由**。

**验收**：`node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs`
要么无警告，要么有明确接受理由。

**行为/风险**：不改行为。工作量 **M**（做拆分）/ **S**（接受并写理由），置信度 **confirmed**。

---

## 5. 类型决策表

本项目的结论：**0 处需要 TypeScript enum**。现有 `as const` + 索引类型已经覆盖；
enum 会引入运行时对象，且跨 IPC 的 JSON 值用 union 更自然。

| 闭集 | 现在的写法 | 结论 | 理由 / 动作 |
|---|---|---|---|
| `PERMISSIONS` | `as const` + `(typeof PERMISSIONS)[number]` | keep union | 跨进程、UI 展示、`includes` 收窄；`isPermission` 是收窄器 |
| `PermissionTier` | 字符串字面量联合 + `TIERS: Record<Permission, PermissionTier>` | keep union | `Record<Permission, …>` 让「加权限忘分层」编译报错 |
| `EnvironmentStatus` / `ControlOwner` / `Creator` / `PluginRuntime` / `PluginStatus` / `PluginSettingType` / `PluginSurfaceKind` | `type X = 'a' \| 'b'` | keep union | 跨 IPC/RPC 的 JSON 值；可序列化、可穷尽 switch |
| `ApprovalMode` / `ControlPolicy` / `PluginPolicy` | union + `isXxx()` 守卫 | keep union + schema at boundary | 值来自 DB TEXT，`toAppSettings` 已经是 parser |
| `NetAction` | 可辨识联合 | keep union | 六种动作字段不同；`interceptor.ts` switch 穷尽，`rules.ts` 边界有 `normalizeAction` |
| `NavigationAction` | 可辨识联合 | keep union | 类型上排除「goto 但没 URL」 |
| `TargetInput` | 对象形式 + `string` 联合 | keep union | `normalizeTarget` 归一到 `NormalizedTarget`；RPC 边界的 `as never` 是 F7 的事 |
| `TabRef = number \| string` | 别名 | **branded type 不必要** | 1-based 序号与 tabId 共用通道是刻意设计；`TabList.resolve` 是唯一解析点 |
| `EnvApi` | 手写 interface + preload 实现 | **schema required（轻量）** | 两份真相；在 preload 末尾加 `const _check: EnvApi = api;`，成本 1 行 |
| `RpcRequest.params` | `Record<string, unknown>` + `str/num/bool` | **schema required** | 111 条方法、每条 1~6 个参数；F7 的字段守卫就是 parser；不引 zod |
| `PluginManifest` / `InstalledPlugin` | 手写 interface + `validateManifest` 逐字段归一 | **已正确** | 插件目录是不可信输入；逐字段校验 + `downgraded` 上报是范本 |
| `CredentialSecret` / `CookieSummary` / `HostEnvironmentSummary` | 手写窄 interface | keep | 「只出不进」的窄视图；加字段等于改边界 |
| `PluginEnvBadgeTone` | union，renderer-only | keep union | 不跨 IPC，放本地是对的 |
| 错误码（61 个 `code: 'XXX'` 字面量） | 各模块自己 `Object.assign(new Error(m), { code })` | use const map（可选） | 只出不进，CLI 只打印；除非要做 CLI 错误码文档，否则不值得抽表 |
| 什么时候该 enum | — | **本项目 0 处需要** | 没有反向映射 / 运行时常量需求；`as const` + 索引类型已覆盖 |

---

## 6. 删除 / 合并清单

| 目标 | 位置 | 删除前验证 | 动作 |
|---|---|---|---|
| `attachedCount`、`onDialog` | `src/main/browser/session.ts:242,246` | `rg -n '\b(attachedCount\|onDialog)\b' src tests bin scripts plugins` 只剩定义行 | 删除 |
| `currentPluginCall` | `src/main/plugins/call-context.ts:21` | 同上（`currentEnvironmentId` 才是被用的） | 删除 |
| `SUPPORTED_API_VERSION` | `src/main/plugins/manifest.ts:2` | `rg -n '\bSUPPORTED_API_VERSION\b' src tests bin scripts plugins` | 删除，或改成 `SUPPORTED_API_VERSIONS.at(-1)` 并有测试断言 |
| `VaultError` | `src/main/vault/store.ts:43` | 全树零引用 | 删除 |
| `waitForNavigation` 的 `started` | `src/main/browser/page-helpers.ts:133/158` | `rg -n '\bstarted\b' src/main/browser/page-helpers.ts` | 删除变量与 `void started`，保留定时器行为 |
| `mouseMove` 的 `steps` | `src/main/browser/keymouse.ts:68/81`、`controller.ts:768` | `rg -n '\bsteps\b' src/main/browser src/main/rpc-dispatch.ts` | 只删 `mouseMove` 的 `steps`；`click`/`drag` 的 `steps` 保留 |
| `keyEvents` 的 `delay` | `src/main/browser/input.ts:145/162`、`keymouse.ts:172` | 同上 | 删 `keyEvents` 签名里的 `delay`；`keyboardPress/Type` 的等待保留 |
| `main.ts` 的 `(...args: any[])` | `src/main/main.ts:248` | 改泛型 `handle<A extends unknown[]>` 后 tsc 0 | 改类型，不改行为 |
| `rpc-dispatch.ts` 的 28 处 `as never` | 全文件 | 逐个换成字段守卫；tsc 0；`rpc-dispatch` 测试全绿 | 改类型 + 参数校验 |
| **不要删**：`theme/surface.ts` 9 个零引用导出、`lib/disclosure-motion.ts` 2 个、`ui/list-row.tsx` 3 个、`ui/shimmer.tsx`、`ui/shortcut-hint.tsx`、`icons.tsx ICON_NAMES` | 镜像上游 `web-next` | AGENTS 明令 | 保留；删了等于每次同步多一份冲突 |
| 依赖 | — | `shadcn` 已在 devDependencies；无重复能力依赖 | 不删 |

---

## 7. 不建议改（看起来奇怪，但约束证明合理）

- **`ui-reference/` 不进 typecheck**：它永不 import、永不构建；`import { cn } from "cn"` 必然报错。
  不要为它把 `cn` 加回依赖。
- **`rpc-dispatch.ts` 的 `invoke()` 动态派发本身**：111 条 case 手写成静态映射的收益不抵成本；
  要改的是返回类型注解和参数守卫（F7），不是结构。
- **`plugins/api.ts` 的 `environment.update` / `start` / `stop` 不挂 lease**：它们改的是环境配置
  （代理 / trustedCa / 启停），不是「谁在控制这个页面」；权限在 `confirm` 层由人一次性批准。
- **`browser/` 里到处 `as never`（CDP payload）**：CDP 是动态协议，`Record<string, unknown>`
  是正确形状；问题只在 `rpc-dispatch.ts` 那一侧。
- **`EnvPending` / `Telemetry` / `NetInterceptor` 的内存上限是水位不是硬边界**：每 50/100 条
  才 prune 一次，最多到 `LIMIT + 99`，注释写明了，是有意的成本取舍。
- **`AX_CACHE_TTL_MS = 120` 比轮询间隔短**：F3 要改，但它是「缓存为单次动作内复用设计」的历史
  巧合，不是写错；修的时候别把 TTL 提太大（>500ms 会让等待明显变迟钝）。
- **`legacy/` 里的 worktree 概念**：HANDOFF §2 明确它是唯一例外。
- **`ui/list-row.tsx`、`theme/surface.ts` 等的零引用导出**：镜像上游的代价，见删除清单。
- **`package.json` 里 `react` / `electron` / `typescript` / `oxlint` 钉死版本**：这四个正是
  「升级会让 CI 无故变红 / 需要实测」的那四个，组合是刻意的。要处理的是另外 15 个 `latest`。

---

## 8. 执行顺序与验收命令

### 批次 A · 数据边界（F1、F1b、F2）

```bash
npm test
npx tsc --noEmit
npm run lint
# 启动应用 + fixture 后：
node bin/warren.mjs env create 'x/../y'   # 预期 BAD_REQUEST
# 临时路径穿越探针：stop/remove 不能删到 os.tmpdir() 之外
bash scripts/regress/run-all.sh           # 预期全绿
```

### 批次 B · 插件面一致性（F4、F5、F13、F14、F15）

```bash
npm test
npx tsc --noEmit
# 启动应用后：
node bin/warren.mjs plugin disable com.example.notes
node bin/warren.mjs call debug.rendererEval '{"script":"..."}'   # 菜单项消失
bash scripts/regress/plugin.sh
```

### 批次 C · 类型与 RPC 边界（F7、F11）

```bash
npx tsc --noEmit
npm test
rg -n 'as never' src/main/rpc-dispatch.ts   # 目标：显著下降/清零
git diff --stat                               # 只应动 rpc-dispatch.ts + main.ts
```

### 批次 D · CI 机制（F6）

```bash
# GitHub Actions 上让 gui-regression 绿一次
# 然后删 .github/workflows/ci.yml 的 continue-on-error
# 再在 branch protection 把 gui-regression 设为 required
```

### 批次 F · 性能与清理（F3、F9、F10、F12、F16）

```bash
npm run lint
npx tsc --noEmit
npm test
node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
bash scripts/regress/browser.sh   # 如果改了 AX TTL / 等待逻辑
```

### 批次 E · 文档同步（F8）

```bash
rg -n "173|101 个|23 个单测|176|1301" AGENTS.md docs/CODEBASE-ASSESSMENT-2026-10-17.md
rg -n "lucide-react" README.md
rg -n "settings-dialog" docs/HANDOFF.md
```

### 每批结束的强制门

```bash
npm run lint
npm run format:check
npx tsc --noEmit
npm test
node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
```

涉及主进程 / 浏览器 / 插件 / CI 的批次，另加：

```bash
bash scripts/regress/run-all.sh
```

---

## 9. 未验证 / 待实测

- **实机回归未跑**：审查线程没启动 Electron、没跑 `scripts/regress/run-all.sh`。
  F1、F2、F3、F4 的行为结论只有读码和算术证据，实施后必须实机复测。
- **打包链路未验证**：`npm start` / `npm run make` / `npm run package`、签名 / 公证 / fuses /
  `extraResource: ['./skills']` 只读了配置，没验证产物。
- **`before-quit` 的真实行为未证伪**：需要启动应用、退出、检查
  `<root>/core/warren.db-wal` 是否存在；F12 按 judgement 处理。
- **`latest` 依赖升级未实测**：`npm install` 没跑，新版本会怎样未知；15 个 `latest` 的固定版本
  需要在 F8/后续单独做一次依赖审计（一次一个包，读 changelog，测试通过再合）。
- **chunk 拆分未实测**：F16 是否值得做，要先量动态 import 后的首屏收益；
  本地 Electron 下可能接受 696 kB。
- **未读**：`legacy/`、`logo-candidates/`、`.pi/`、`fixtures/` 内容、
  `src/renderer/components/ui/**` 与 `ui-reference/**` 的实现细节、
  `src/renderer/features/**` 的逐行实现、`docs/` 里除点名文件之外的文档、
  `scripts/verify/batch*.mjs` 的逐行内容、`node_modules/`。

---

## 10. 文档与提交边界

- 本文是计划文档；实施前不要把它当成已完成状态写进 `HANDOFF`。
- 每个批次完成后更新 `docs/HANDOFF.md` 的「当前状态」一节；涉及 RPC / 数据模型 / 硬约束 /
  运行方式的改动必须同步。
- `docs/HANDOFF.md` 当前有未确认改动（工作区 `M`）；先确认归属，再把本计划的改动和它分开提交。
- 提交粒度：A / B / C / D / F / E 各自独立；F1+F2 可以一个 commit（同一根因），
  F7+F11 可以一个 commit（同一根因），F9/F10 可以一个 cleanup commit。
- 本计划新增 `docs/CODE-QUALITY-REMEDIATION-PLAN-2026-10-19.md` 后，在 `docs/README.md`
  的「要改东西」表里加一行指向它。

---

## 11. 执行记录

### 批次 A · 数据边界（F1、F1b、F2）

**代码**：

- `src/main/domain/environment.ts`：新增 `isEnvironmentId` / `assertEnvironmentId` / `safeEnvKey`。
- `src/main/store.ts`：`Store.create` 先校验 id；`storagePathFor` 改用 `safeEnvKey`。
- `src/main/browser/downloads.ts`：下载临时目录改用 `safeEnvKey`。
- `src/main/environments.ts`：`stop` 临时下载区清理改用 `safeEnvKey`；`remove` 清 `#sessions`
  并 `rm(storagePath)`；删除失败记 `environment.removeFailed` 并抛 `ENV_REMOVE_FAILED`。
- `tests/environment.test.ts`、`tests/store.test.ts`：新增 3 条测试（id 校验、safe key、storagePath）。

**静态门（2026-10-19）**：

- `npm run lint` → 退出 0。
- `npx tsc --noEmit` → 退出 0。
- `npm test` → **237 / 237 通过**（234 + 3）。

**实机（重启应用后）**：

- `warren env create '../warren-f1-probe'` → `{"ok":false,"error":{"code":"BAD_REQUEST","message":"invalid environment id: \"../warren-f1-probe\""}}`。
- `warren env create 'warren-valid-probe'` → 成功，`storagePath` 在
  `~/.warren/core/sessions/warren-valid-probe`。
- F1b 删除探针：在 `os.tmpdir()` 放 `warren-delete-probe`，`env create '../warren-delete-probe'`
  被 `BAD_REQUEST` 拒绝，探针文件仍在。
- F2：`env start warren-valid-probe` 后目录存在；`env remove warren-valid-probe` 后目录消失
  （`session-dir-deleted`）。
- 旧坏 id 环境 `../../../../../../tmp/warren-id-probe` 已用新 `remove` 清掉。

**状态**：批次 A 完成，等待最终全量回归。

### 批次 B · 插件面一致性（F4、F5、F13、F14、F15）

**代码**：

- `src/renderer/lib/plugin-runtime.ts`：envAction 收集改为只在 `plugin.enabled` 时进行，
  不再要求 `plugin.app`（声明式面不依赖前端 bundle）。
- `src/main/plugins/api.ts`：`environment.list/get` 投影掉 `leaseId` / `leaseExpiresAt`，
  保留 `storagePath`；`browser.waitForTimeout` 拒绝缺参 / NaN / 负数。
- `src/main/plugins/host.ts`：失败事件的 `environmentId` 改用归一后的变量；
  `logs()` 去掉 `as PluginLogEntry[]`。
- `src/main/plugins/registry.ts`：`readPluginLogs` 归一 `level`，非法值退 `info`。
- `tests/plugin-v2.test.ts`、`tests/plugin-registry.test.ts`：新增 DTO、timeout、level 三条测试。

**静态门（2026-10-19）**：

- `npm run lint` → 退出 0。
- `npx tsc --noEmit` → 退出 0。
- `npm test` → **239 / 239 通过**（237 + 2）。

**实机（重启应用后）**：

- F4：notes 启用时右键菜单含「记一条」；`plugin disable com.example.notes` 后菜单不再含
  「记一条」；随后已重新 enable。
- F5：`warren plugin run com.warren.whistle list` 正常返回，whistle 的 host 路径没有坏。
- F13：`warren plugin run com.example.cookies report`（不带 env）失败后，
  `events` 里的 `plugin.failed` 没有空字符串 `environmentId`。

**状态**：批次 B 完成，等待最终全量回归。

### 批次 C · 类型与 RPC 边界（F7、F11）

**代码**：

- `src/main/rpc-dispatch.ts`：`navOptions` / `clickOptions` / `fetchOptions` 加显式返回类型；
  新增 `asWaitUntil` / `asButton` / `asPosition` / `asCredentials` / `asHeaders` 守卫；
  这三个 helper 里的 `as never` 已清掉。
- `src/main/main.ts`：IPC `handle` 改成泛型 `handle<A extends unknown[]>`，
  调用点的参数类型重新被检查。
- `src/shared/types.ts`：补上 `ClickOptions.steps`（click/drag 的路径合成实际在用，
  原类型漏了它；`mouseMove` 仍不认这个字段）。
- `tests/rpc-dispatch.test.ts`：新增「非法 button / position / waitUntil 不原样传给 controller」。

**静态门（2026-10-19）**：

- `npm run lint` → 退出 0。
- `npx tsc --noEmit` → 退出 0（第一次跑抓到 `ClickOptions.steps` 缺口，补类型后过）。
- `npm test` → **240 / 240 通过**（239 + 1）。
- `rg -n 'as never' src/main/rpc-dispatch.ts` → **24**（原 28，helper 里 4 处已清）。
- `rg -n ': any\\[\\]' src/main/main.ts` → 无命中。

**实机**：F7 的运行时行为由 `tests/rpc-dispatch.test.ts` 覆盖；F11 是编译期约束，由 tsc 覆盖。
主进程实际重启后的 RPC 探针放在最终全量回归里。

**状态**：批次 C 完成，等待最终全量回归。

### 批次 F · 性能与清理（F3、F9、F10、F12、F16）

**代码**：

- F3：`AX_CACHE_TTL_MS` 120 → **300ms**（≥ 150ms 轮询间隔，避免每轮都过期）。
- F9：删 `attachedCount`、`onDialog`、`currentPluginCall`、`SUPPORTED_API_VERSION`、`VaultError`。
- F10：删 `waitForNavigation` 的 `started`；删 `mouseMove` 的 `steps`；删 `keyEvents` 的 `delay`；
  `browser.mouseMove` 改为只传 `label`。
- F12：`before-quit` 改成同步关库后再 `void rpc.close()`。
- F16：`vite.renderer.config.mjs` 设 `chunkSizeWarningLimit: 750` 并写明本地 Electron 的接受理由。

**静态门（2026-10-19）**：

- `npm run lint` → 退出 0。
- `npx tsc --noEmit` → 退出 0（第一次跑抓到 `actions.ts` 仍在给 `keyEvents` 传 `delay`，已清）。
- `npm test` → **240 / 240 通过**。
- `node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs` → 成功，
  JS 696.60 kB，**无 chunk 警告**（阈值 750 kB）。

**实机**：F3 的 AX 轮询、F12 的退出 WAL、F9/F10 的删除项在最终全量回归里复验。

**状态**：批次 F 完成，等待最终全量回归。

### 最终全量回归（2026-10-19）

`bash scripts/regress/run-all.sh` 最终结果：**146 PASS / 0 FAIL**（唯一非 PASS 是 vault 5.7
的预期 SKIP）。G0 静态门：`npm run lint` 0、`npm run format:check` 0、`npx tsc --noEmit` 0、
`npm test` **240/240**、渲染层构建成功且无 chunk 警告。

首轮回归出现 5 条 FAIL，已逐条定位并修复：

- `V5b`：OOPIF 时序 flake（单独重跑通过）；回归脚本改成先等 AX 树出现内层按钮再点。
- `1.11`：审批策略被前面 UI 用例持久化成 `agent-created`，导致 agent 抢权合法；
  `core.sh` 开头重置为 `ask`，修的是测试隔离，不是产品行为。
- `Vault 5.2/5.3/5.5`：F2 第一版 `#sessions.delete` 导致 `session.fromPath` 二次注册
  `warren` protocol（`Failed to register protocol`）。改成保留 Session 对象、
  删目录前 `clearStorageData()`，再跑 Vault 全绿。

### 批次 D · CI 机制（F6）

- `.github/workflows/ci.yml` 已删除 `continue-on-error: true`，并写明 2026-10-19
  本地全量回归 146 PASS / 0 FAIL。
- **外部阻塞**：`gh auth status` 显示 GitHub token 无效，无法自动把 `gui-regression`
  设为 required check。需要在 GitHub branch protection 里手动设置。

### 批次 E · 文档同步（F8）

- `AGENTS.md` 单测数 173 → **240**。
- `docs/CODEBASE-ASSESSMENT-2026-10-17.md`：单测 34 文件 / 240 用例；RPC 111；
  `environments.ts` 1359 行；回归 146 条；CI `gui-regression` 不再 `continue-on-error`。
- `README.md`：图标改 Hugeicons；M5 已完成 LRU / 崩溃恢复 / SQLite 迁移。
- `docs/README.md`：回归数字 133 → **146**。
- `docs/HANDOFF.md`：`settings-page.tsx`、重复的 `example-notes` 行、§7 重复的 16 改成 16b。
- `src/main/tabs.ts` 注释：`#refocusSelected` → `focusDisplayedPage`。

**状态**：A、B、C、F、E 完成；D 的仓库侧完成，required check 因 GitHub token 失效待人工设置。
