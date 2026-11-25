# 执行计划（2026-10-17）

> 状态：**施工图，未实施**。
> `OPTIMIZATION-PLAN-2026-10-17.md` 是**决策记录**（为什么这么排）；本文是**施工图**
> （每一步怎么做、落在哪、怎么验）。两份别混着读。
> 每步给：现状 → 方案 → 落点 → 验收 → 风险。**批次按依赖排序，做完一批验完再开下一批。**

---

## 批次总览

| 批次 | 内容 | 依赖 | 估时 | 状态 |
|---|---|---|---|---|
| **0** | **CLI 两处 P0**（命令清单单一来源 + 未知组报错退出 1） | 无 | 半天 | 未开始 |
|  | ↑ 见 `CLI-REVIEW-2026-10-17.md` §3.1；只动 `bin/warren.mjs` 一个文件 |  |  |  |
| **1** | 补测三条（后台环境 · 部分遮挡 · `document.hasFocus()`） | 无 | 半天 | **已完成，见下** |
|  | ↑ 1.1 读代码后**大概率是已解决**（`ensureOperable` 就是干这个的），实际只剩 1.2 / 1.3 |  |  |  |
| **2** | 去焦点守卫 + 回归进 CI | 批次 1 | 1–2 天 | **已完成，见下** |
| **3** | 扩展加载（DevTools 扩展） | 无（可与 1/2 并行） | 半天 | **已完成，见下（有一处否定结论）** |
| **4** | 拆 `net.*` + 注入点 + 单测 | 批次 2（要回归兜底） | 1 天 | **已完成，见下** |
| **5** | 请求/响应 body 可见 | 批次 4（复用拆出来的模块） | 1 天 | **已完成，见下** |
| **6** | 鼠标路径 → 视觉通道 | 无 | 各 1 天 | **已完成，见下** |

---

## 批次 0：CLI 两处 P0

**为什么排在最前**：只动 `bin/warren.mjs` 一个文件、不依赖任何其他批次，
而且是**唯一一个「改完立刻让所有 agent 受益」**的改动 —— agent 现在找不到
`plugin logs` / `plugin config` / `call`（`help` 漏了这五个），是每天都发生的损失。
完整梳理见 `docs/CLI-REVIEW-2026-10-17.md`。

### 0.1 命令清单单一来源

**现状（实测）**：同一份清单写在三个地方，三份都不一样 ——

| 地方 | plugin 组 | 差 |
|---|---|---|
| `warren help` | 7 行 / 9 个命令 | 漏 `reload` `status` `logs` `config` |
| `plugin` 的 `default:` 报错 | 11 个 | 漏 `create` `commands` |
| 实际 `switch` | **13 个** | 基准 |

`env` 组同样：`env` 的报错漏了 `update`；`call` 完全不在 `help` 里。

**方案**：抽一个 `COMMANDS` 常量，`help` 文本与各组 `default:` 报错都从它生成。

**落点**：`bin/warren.mjs`。

**验收**：`warren help` 的行数 ≥ 现在；`for c in call "plugin reload" "plugin status" "plugin logs" "plugin config"; do node bin/warren.mjs help | grep -q "$c"; done` 全过。

**风险**：**别顺手重排 help 的排版** —— agent 的 prompt 里可能已固化某些行。
保持现有格式，只补漏掉的行。

### 0.2 未知组报错退出 1

**现状（实测）**：
```
warren            -> help，exit 0        ← 对
warren nope       -> 70 行 help 到 stdout，exit 0   ← 错
warren env nope   -> 用法提示到 stderr，exit 1      ← 对
```

组内未知子命令会报错，**未知组会静默成功** —— agent 打错组名会以为命令成功了。
这是 `AGENTS.md` 已知问题第 1 条那个家族（静默失败）的同一种病。

**方案**：`else` 分支区分两种情况 —— 无参数 → help + exit 0；有参数 → stderr + exit 1。

**落点**：`bin/warren.mjs` 的最终 `else`。

**验收**：
```bash
node bin/warren.mjs nope >/dev/null 2>&1; echo $?     # 必须是 1
node bin/warren.mjs >/dev/null 2>&1; echo $?          # 必须是 0
node bin/warren.mjs nope 2>/dev/null | wc -l          # stdout 应为 0
```
外加一条回归进 `scripts/regress/core.sh`。

**风险**：无。唯一的"破坏"是 `warren <打错的组>` 不再返回 0 —— 那正是要修的。

---

## 批次 1：补测三条 —— **已完成（2026-10-17）**

**结论（`node scripts/verify/batch1-focus.mjs` → BATCH1 PASS）**：

| 项 | 实测结果 |
|---|---|
| 1.1 后台环境 | **`ensureOperable` 有效** —— 对后台环境发点击，页面 `#result` 由「未提交」变提交值。**不用改代码** |
| 1.2 失焦后坐标映射 | **不变** —— `getBoundingClientRect()` 与 `viewport` 失焦前后完全一致 |
| 1.3 失焦时 `document.hasFocus()` | **`false`** —— 页面自己也认为没焦点（Web 规范行为） |
| 1.4 **失焦再拉回来** | **发现真 bug：`document.hasFocus()` 不恢复**（前台 true → 失焦 false → 拉回**仍是 false**） |

**1.4 是本次挖出来的真缺陷，已修**：

- **症状**：用户 alt-tab 一次之后，真实站点里常见的 `if (!document.hasFocus()) return`
  守卫（编辑器 / 拖拽库 / canvas 应用）会**永久**拦掉 agent 的点击 —— 点了没反应、也不报错。
- **根因**：**窗口拿到 OS 焦点 ≠ 页面拿到 document 焦点**。Electron 的窗口焦点落在 shell 的
  渲染层上，环境页（`WebContentsView`）的 document 一直是 false。
- **修法**：`environments.ts` 新增 `focusDisplayedPage(id?)`（`wc.focus()`），在 `inputCall`
  发输入之前调用；`focusWindow()` 也调一次。传了 id 且不是当前显示的环境就**不动** ——
  后台环境不能抢焦点，那是「并行操作后台环境」的前提。
- **实测**：`focusWindow 后 hasFocus=false` → **一次输入后 `hasFocus=true`**。

**测试脚本自己踩过的两个坑**（记下来免得再犯）：
1. 用「导航 + 读」两段脚本做对照 —— 第二段一 `goto` 就把页面状态重置了，结论全错。
   现在读操作一律不导航（`evalOnly`）。
2. 起第二个环境时 `start` 会把它**选中**（`headed` 默认 true），后面测的其实是「后台环境」
   而不是「窗口失焦」。现在测前显式 `env select` + 断言 `layout().showing`。

**仍未测**：部分遮挡（1.2 只测了「失焦后坐标不变」，没测「被别的窗口压住一半」）。
按 1.2 的结果推断风险很低，但**没实测**。

---


`OPTIMIZATION-PLAN` §1.1 只测了「窗口失焦 + 鼠标/键盘」。三条没测的，**先补完再动守卫**。

### 1.1 后台环境（视图没挂到窗口上）

**现状（读代码后修正）**：这条**已经有解了**。`rpc-dispatch.ts:114` 的 `inputCall` 里，
`ensureOperable(id)` 会把后台环境的视图**临时挂到窗口最底层**，用完在 `finally` 里摘掉 ——
注释原文：「这样 agent 能并行操作非当前显示的环境，而人看到的还是上面那个视图」。

**所以 1.1 不是「要不要去守卫」，而是「确认它真的有效」**：起两个环境，`env select A`，
对 B 发输入，看 B 的页面有没有变。

**落点**：只改测试脚本，不改代码。

**验收**：
```bash
node bin/warren.mjs env create probe --start-url=http://localhost:8899/cap/form.html
node bin/warren.mjs env start probe && node bin/warren.mjs env start cap
node bin/warren.mjs env select cap          # cap 在前台，probe 在后台
# 对 probe 发输入（走正常 inputCall，不绕过任何守卫）
```
**判据**：probe 的 `#result` 变了 → `ensureOperable` 有效，1.1 结案，不用动代码；
没变 → `ensureOperable` 有洞，要单独查。

**风险**：低。这条大概率是「已经好了，只是没人复测过」。

### 1.2 部分遮挡时坐标是否还准

**现状**：未测。失焦时点击坐标实测与前台一致（`x:29.33, y:456.28`），但那是**完全**失焦，
不是「窗口被压住一半」。

**方案**：用 `osascript` 把 Finder 窗口摆到盖住 Warren 右半 → 点右半的元素 → 看是否点中。

**落点**：只改测试脚本。

**验收**：点击坐标 + 页面结果两处对照（和未遮挡时比）。

**风险**：如果坐标会偏，那「去守卫」就不能无条件做，得在 `layout()` 里暴露遮挡状态。

### 1.3 `document.hasFocus()`

**现状**：`HANDOFF.md` 坑 36 记的是「`debug.focusWindow` 之后 `document.hasFocus()` 仍是 false」。
那是**页面自己的焦点**，和「窗口在不在前台」不是一回事。本次没测。

**方案**：新建 fixture `fixtures/capability/focus-guard.html`，里面放一个
`if (!document.hasFocus()) return;` 的按钮（模拟真实站点里常见的守卫）。
失焦状态下点它，看是否被拦。

**落点**：新增 `fixtures/capability/focus-guard.html`；回归套件加一条。

**验收**：`warren exec` 里 `await page.evaluate(() => document.hasFocus())` 的读数 +
按钮有没有生效。

**风险**：**这是最可能保留守卫的理由**。如果真实站点普遍写 `hasFocus()` 守卫，
那"去守卫"只是把静默失败换成另一种静默失败 —— 那种情况下应该改成
**「警告 + 继续」而不是「报错拦下」**。

---

## 批次 2：去焦点守卫 + 回归进 CI —— **已完成（2026-10-17）**

**结果（`node scripts/verify/batch2-guard-ci.mjs` → BATCH2 PASS）**：

- **删掉 `assertInputFocus()`**（连同调用点、测试断言、假 manager 实现），
  以及 `layout().windowFocused` 文档里那句「输入类检查全靠它」。
- **验收**：把焦点切走（`windowFocused=false`）→ 点
  `fixtures/capability/focus-guard.html` 里带 `if (!document.hasFocus()) return` 守卫的按钮
  → **`guarded=已点`**，且页面 `document.hasFocus()=true`（`focusDisplayedPage` 补的）。
- **回归**：`capability.sh` 加 V16 锁住这条行为。
- **`run-all.sh` 的前置**从「不在前台就 exit 1」改成只打印 `windowFocused`。

**CI（`.github/workflows/ci.yml` 的 `gui-regression`）**：

- **本地已验证**：`nohup npm start < /dev/null`（非 TTY、无终端）**4 秒起来**，
  `debug.layout` 正常返回 —— 这是原本最大的未知，解除了。
- **仍未验证**：macOS runner 有没有可用的窗口会话、`safeStorage` 能不能用（影响 vault 那几条）。
- 所以 job 先挂 `continue-on-error: true`；**第一次绿了之后必须去掉**。

---


### 2.1 改法（取决于批次 1 的结果）

| 批次 1 结果 | 做法 |
|---|---|
| 三条全通过 | 删 `assertInputFocus()` 的 throw；`layout().windowFocused` 保留作观测 |
| 只有 `hasFocus` 有问题 | throw 改成**写一条事件 + 继续**（`browser.action` 级别），不拦 |
| 部分遮挡会点偏 | 不能无条件删；要在 `layout()` 里暴露遮挡状态，或改成警告 |

**输入这条链上现在有三道守卫**（`rpc-dispatch.ts:114` 的 `inputCall`，按执行顺序）：

```
assertWritable      -> lease
ensureOperable      -> 后台环境：临时挂到窗口最底层（1.1 大概率已确认有解）
assertInputOnScreen -> 视图被界面让开 / 尺寸为 0（这是真会丢输入，别动）
assertActiveTab     -> 非激活标签（CDP 输入只作用于激活 webContents，别动）
assertNoDialog      -> 有 dialog 卡着（顺序在焦点之前，别动）
assertInputFocus    -> <-- 本次要动的只有这一道
```

**落点**：`src/main/environments.ts:1169` 的 `assertInputFocus()` 本体；
**唯一调用点是 `rpc-dispatch.ts:127`**（`inputCall` 里）。
`tests/rpc-gating.test.ts` 用源码断言盯着写门控 —— 改完要看它会不会红。

**⚠️ 别忘了 `vault.fill`**：坑 36 说它**不走这个守卫**，表现是挂到 60s RPC 超时。
它在 `rpc-dispatch.ts` 里走的是 `writeCall`（只查 `assertWritable`），**不经过 `inputCall`** ——
所以去掉焦点守卫**不会**顺带修好它，要单独查它挂在哪一步。

### 2.2 CI job

**已核实的约束**：

- `debug.*` 方法要求 `isPackaged === false`（`rpc-dispatch.ts:316`）→ **必须跑 dev 模式**，
  不能跑打包产物。
- 公开仓库的标准 runner **免费且不限时长**（GitHub 官方原文），**包括 macOS**。
- macOS runner 规格：4 核 / 14 GB / 14 GB SSD，标签 `macos-latest` / `macos-15` / `macos-26`。
- `safeStorage` 在 CI 上可能不可用（`vault/electron-encryptor.ts:13` 有 `isEncryptionAvailable()`
  兜底）→ **vault 那几条会 SKIP 或 FAIL，要先确认**。

**方案草案**（`macos-latest`，因为 Warren 只在 macOS 验证过）：

```yaml
gui-regression:
  runs-on: macos-latest
  steps:
    - uses: actions/checkout@v5
    - uses: actions/setup-node@v5
      with: { node-version: '24', cache: npm }
    - run: npm ci
    - run: node scripts/serve-fixture.mjs 8899 &      # fixture 常驻
    - run: npm start &                                 # 应用常驻（非 TTY）
    - run: |
        for i in $(seq 60); do
          [ -S ~/.warren/envd.sock ] && break
          sleep 2
        done
    - run: bash scripts/regress/run-all.sh
```

**四个必须先实测的未知**（按风险排序）：

1. **`electron-forge start` 在非 TTY 下能不能起来** —— 它带一个 TUI（`←/→ 1-9 tabs · q quit`），
   CI 里没有 TTY。**这是最大的未知。**
   退路：`npx electron .` 直接跑（`package.json` 的 `main` 已指向 `.vite/build/main.cjs`），
   但要先确认构建产物里的 dev-server URL 被替换成了什么 —— 实测 `main.cjs` 里
   **已经找不到 `MAIN_WINDOW_VITE_DEV_SERVER_URL` 字面量**（说明插件在构建期替换了），
   需要确认它替成了什么、`npx electron .` 会不会去连一个不存在的 dev server。
2. **macOS runner 有没有可用的窗口会话** —— 有 GUI 会话才能拿到焦点。无 → 走批次 1 的结论
   （如果守卫去了，可能就不需要焦点了）。
3. **`safeStorage` 在 runner 上可用吗** —— 影响 vault 那 5 条。
4. **首次启动会不会弹权限框**（辅助功能 / 网络）—— 会的话 job 会卡住。

**落点**：`.github/workflows/ci.yml` 加一个 job；`AGENTS.md` 的「修改后校验」和
`HANDOFF.md` 的 CI 那条要同步改（现在写着「GUI 回归套件不在 CI 里」）。

**验收**：CI 上跑出 **137 PASS / 0 FAIL**（允许 vault 的 5.7 SKIP）。

**风险**：CI 里的 `run-all.sh` 会自己建环境、装插件、写探针文件 —— 都是写 `~/.warren`
和 `app.getPath('userData')`，runner 是干净 VM，**没问题**。但如果哪天加了依赖宿主状态的检查，
就会在 CI 上假 FAIL。

---

## 批次 3：扩展加载 —— **已完成（2026-10-17）**

**做了什么**：`src/main/extensions.ts`（纯逻辑 + 显式路径，可单测）+ `environments.ts`
的 `#loadExtensions()` / `extensionsOf()` / `extensionAdd()` / `extensionRemove()` +
RPC `extension.list|add|remove` + CLI 组 `extension`。

**状态就是文件系统**：扩展放在 `<环境 storagePath>/extensions/<name>/`，不另存一张表 ——
环境目录本来就是「这个环境的全部状态」。`start()` 里在**第一个页面加载之前**挂上
（晚挂的话内容脚本注入不到首个页面）。

**实测结论（`node scripts/verify/batch3-extension.mjs` → BATCH3 PASS）**：

| 能力 | 结果 |
|---|---|
| 装 / 列 / 卸 | ✅ 都通；同名覆盖；`.crx`、缺 manifest、坏 JSON、路径穿越的目录名都被挡 |
| **内容脚本注入** | ✅ `fixtures/extension/hello` 给 `<html>` 打的 `data-warren-ext="hello"` 实测可见 |
| **React DevTools 的 hook** | ✅ 装上后页面里 `typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ === 'object'`，且有 `rendererInterfaces` |
| **DevTools 面板（`chrome.devtools.panels.create`）** | ❌ **没出现** |

**那个否定结论值得单独说清楚**（截图在 `shots/devtools-window2.png` / `devtools-panel-mv2.png`）：

DevTools 的面板列表实测是 `Elements / Console / Sources / Network / Performance /
Memory / Application / Security` —— **没有 React 标签页，也没有我们自己那个最小扩展的标签页**。
为此专门造了一个最小 DevTools 扩展（`fixtures/extension/devtools-panel`，形状照抄
Electron 自己 `spec/fixtures/extensions/devtools-extension` 的夹具：MV2 + `devtools_page` +
`chrome.devtools.panels.create`），**它也不出现**。所以不是 React DevTools 不兼容，
是**本机这个形态下 Electron 不渲染 DevTools 扩展面板**（Electron 官方文档把
`chrome.devtools.panels` 列为「All features are supported」，实际不符，原因未查）。

**所以「扩展是联调刚需」这条的价值要下调**：能装扩展、内容脚本能用，但**装不上 React DevTools
的面板**。不过 hook 在，agent 仍然可以 `page.evaluate` 读 `__REACT_DEVTOOLS_GLOBAL_HOOK__`
去拿组件树 —— 比面板粗糙，但比没有强。

**未查**：为什么面板不出现（可能要装进 default session、或 DevTools 前端需要 reload）。

---


**现状**：Warren **完全不支持扩展**（实测 `rg loadExtension src/main` 为空）。
Electron 原生支持（`electron.d.ts:8565`）。

**已核实的硬约束**（读 `electron.d.ts` 得到，不是猜的）：

| 约束 | 影响 |
|---|---|
| **不支持 `.crx`**（必须解包目录） | 用户得自己解包，或者我们提供一个"从 crx 解包"的小工具 |
| **不能在 `app.ready` 之前调用** | 要在环境 session 建好之后调 |
| **不支持 in-memory（非持久）session** | Warren 用 `session.fromPath` **持久 session** ✓ 不受影响 |
| `allowFileAccess` | **DevTools 扩展在 `file://` 上需要它** —— 我们的页面是 http/https，可不开 |

**方案**：`warren extension add <env> <解包目录>` + 设置页一个入口；
调 `ses.loadExtension(dir, { allowFileAccess: false })`；`getAllExtensions()` 列已加载的。

**落点**：`environments.ts` 的 `#sessionFor()`（session 建好之后挂）+ `rpc-dispatch.ts`
+ `bin/warren.mjs` + 设置页。

**验收**（**先做这一步，能/不能都要有结论**）：

1. 最小验证：造一个 hello-world 扩展（manifest v3），`loadExtension` 之后
   `getAllExtensions()` 里能列到、`chrome.runtime` 在页面里存在。
2. **关键验证**：React DevTools 能不能真的出现在 DevTools 面板里 ——
   在 `contextIsolation: true` + `sandbox: true` 的 `WebContentsView` 下。
   **这条不确定，是这一步的真正风险。**
3. 判据：打开 DevTools → 面板里能看到 React 标签页。

**风险**：Electron 的扩展支持是**不完整**的（社区共识）。可能的结果是"普通扩展能装，
DevTools 扩展不显示" —— 那样这一步的价值要重新评估。

---

## 批次 4：拆 `net.*` + 注入点 + 单测 —— **已完成（2026-10-17）**

**结果**：`environments.ts` 的 8 个 `net.*` 方法 + `#netFor` + `#net` 表搬到
`src/main/net/ops.ts` 的 `EnvironmentNetOps`。`environments.ts` 只留 8 个**一行转发**
（RPC 派发表和它的假 manager 都按 `manager.netXxx(...)` 调，保持这层薄门面比改一圈调用点划算）。

**注入点是关键，而且第一版是错的**：第一版只注入了 `record` / `onChange`，`for(id)` 里还是
`new NetInterceptor(...)` —— 而 `interceptor.ts` **运行时 import electron**，`node:test`
根本加载不了 `ops.ts`。**那就等于白拆**（正是本文 §批次 4 开头警告的那件事）。
最终形态：

```ts
export type NetInterceptable = Pick<NetInterceptor, 'summary' | 'hits' | 'rules' | ... | 'attach' | 'detach'>;
export interface NetOpsDeps {
  record: (type, message, actor, envId) => void;
  onChange: () => void;
  createInterceptor: (id, record) => NetInterceptable;   // ← 真货由 environments.ts 传进来
}
```

- `import type` + `Pick`：类型跟着真货走（真货改方法这里编译报错），运行时**完全不碰 electron**。
- `environments.ts` 传 `createInterceptor: (_id, record) => new NetInterceptor(record)`。

**踩到的两个坑**（已写进 `AGENTS.md` 的 ESM 陷阱那节）：

1. **TS 参数属性不能用** —— `constructor(private readonly deps: Deps)` 在 `node --test` 的
   strip-only 模式下抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。必须写成显式字段。
2. **被测试加载的文件链上不许 `import electron`** —— 要测的模块只能 type-only import，
   或者把真货用工厂注入。

**测试**：`tests/net-ops.test.ts` 9 条（假拦截器 + 假 store）：
惰性建 / 同环境同实例 / `addRule` 记事件与倒计时 / `passthrough` 卡时长（<1s、>1h、NaN）
且**校验在碰拦截器之前**（连拦截器都不该建）/ 同模式只留最新一条 / `setRuleEnabled` 与
`removeRule`（没删到不记事件）/ `record` 的 start-stop 与未知动作 / `replay` 缺文件与坏 HAR /
相对路径过 `guardPath` 护栏。

**验收**：`npm test` 197/197（+9）；`run-all.sh` **144 PASS / 0 FAIL**（网络拦截 n1–n5 全绿，
那是这一步的保护网）。

**顺带发现（回归套件的一处脆弱）**：手工测试留在 `cap` 上的 3 个扩展
（`hello` / `react-devtools` / `warren-panel`）会让后续 47 条检查级联失败
（React DevTools 的内容脚本在**主世界**跑，干扰了 fixture 页面）。
扩展是**磁盘状态**，不会随重启消失 —— **跑回归前先 `warren extension list cap` 确认是空的**。
另外一次抖动：V16 的失焦前置被别的进程抢回焦点 → 已给它加 3 次重试，并删掉与批次 2
验收脚本重复的那份。

---


**现状**（实测耦合度）：`net.*` 8 个公开方法 + `#netFor`，共 ~155 行。
`#net` 只在 `start()`（`attach`）、`stop()`（`detach`）、`remove()`（`delete`）各碰一次 —— **低耦合**。

**方案**：抽成 `src/main/net/ops.ts` 的 `EnvironmentNetOps`，依赖注入：

```ts
export class EnvironmentNetOps {
  constructor(private readonly deps: {
    store: Store;
    netFor: (id: string) => NetInterceptor;   // ← 注入点：单测给假对象
    onChange: () => void;
  }) {}
  // netRules / netHits / netAddRule / netPassthrough / netSetRuleEnabled
  // netRemoveRule / netRecord / netReplay
}
```

**关键：没有注入点就只是搬代码，不产生测试覆盖。** 注入点是这一步的全部意义。

**落点**：新增 `src/main/net/ops.ts` + `tests/net-ops.test.ts`；
`environments.ts` 的 8 个方法变成一行转发（或直接删掉、调用方改走 `#netOps`）。

**验收**：
- 单测覆盖：`netAddRule` 的校验与事件记录、`netPassthrough` 的过期逻辑、
  `netRecord`/`netReplay` 的状态机。
- `npx tsc --noEmit` 干净；`npm test` 只增不减。
- `bash scripts/regress/run-all.sh` 全绿（**net n1–n5 那五套是这一步的保护网**）。

**风险**：`netPassthrough` 有定时器（`#expiryTimer`），搬的时候别把清理逻辑落下。

---

## 批次 5：请求 / 响应 body 可见 —— **已完成（2026-10-17）**

**做法按调研结论走：不新建抓取机制，把已经抓到的暴露出来。**

- `interceptor.ts` 加 `capturedBodies()`（`#capture` 本来就在录制期间用 `response.clone().text()`
  抓了 body，只是没人读得到）。
- `net/ops.ts` 加 `body(id, index)`：JSON 按 key 走 `redactSecrets`；**非 JSON 原样返回并把
  `redacted` 标成 `false`**（不做正则猜文本 —— 猜不准还给人「已经安全了」的错觉）。
  URL 的 query 也脱敏（`?token=…` 太常见），用的是同一张敏感词表。
- RPC `net.body` + CLI `net body <env> <序号>`。没抓过时报 `NET_BODY_NEEDS_RECORDING`，
  **消息里直接给下一步命令**（复用 `DIALOG_OPEN` 那种写法）。

**顺带把纯函数挪成叶子模块**：`redactSecrets` 从 `browser/escape.ts` 搬到
`browser/redact.ts`（叶子，不 import 任何东西）。原来 `escape.ts` 的加载链有 4 个模块，
`net/ops.ts` 引它就得拖进整条链 —— 而那条链必须保持不碰 electron 才能被 `node --test` 加载。
搬完两个 import 点（`interceptor.ts` / `tests/browser-pure.test.ts`）跟着改。

**两条行为决定**：

1. **停录之后仍然读得到最近一次抓到的 body** —— `#har` 要留着写 HAR 文件，顺手让「录完再回来读」
   也能用；下一次 `startRecording()` 清空它，内存不会累积。
2. **非 JSON 不假装脱敏** —— 返回值里 `redacted: false`，CLI 的人读格式会打一句
   「**未脱敏**：响应不是 JSON，没法按 key 脱敏，自己看仔细」。

**验收（`node scripts/verify/batch5-body.mjs` → BATCH5 PASS）**：
没抓过 → 可执行的错误；录制中 → 读到 body 且 URL 里 `token=%5BREDACTED%5D`、不敏感的 `id=1`
没被误伤；越界 → `BAD_REQUEST` 带总数；停录 → 仍可读；新起一轮 → 清空。

**已知取舍（写进 CLI help 了）**：抓 body 要靠 `protocol.handle` 挂上整个 session，
而那会让跨源响应**跳过 CORS 检查** —— 所以 **「随时能看 body」和「CORS 语义真实」互斥**，
只能按需开。这正是 `ELECTRON-REALISM-PLAN` 说的「调出假 bug」的风险点。

---


**这一步的调研结论改变了做法** —— 先说清楚：

### 5.1 关键发现：body 与 CORS 真实**互斥**

读 `src/main/net/interceptor.ts` 得到两条事实：

1. **body 已经能抓**：`#capture()` 用 `response.clone().text()` 读副本，只记 text 类、
   有 1 MB 上限，存进 `#har`。**但它只在 `#recording` 为真时工作**（HAR 录制中）。
2. **能抓的代价**：`attach()` 的注释是**实测结论** ——
   > 挂上 `protocol.handle` 会让整个 session 的响应**跳过 CORS 检查**（实测：跨源请求没有
   > `access-control-allow-origin` 也读得到 body，而没挂 handler 时是 `CORS_ERR:Failed to fetch`）。
   > **没有规则的环境必须是真浏览器，所以默认不挂。**

**所以**：在 Electron 里读 response body **只有两条路**，两条都有代价：

| 路 | 代价 | 性质 |
|---|---|---|
| `protocol.handle`（现成） | **CORS 语义不真实** | 只在开着的时候，可关 |
| CDP `Network.enable` | **自动化检测面**（`HANDOFF.md` §3.7 明确不碰） | 永久性，且要推翻一个已定的决策 |

**结论：body 不能常开。** 这也解释了为什么 `telemetry.ts` 的 `NetworkEntry` 只有摘要 ——
它走 `webRequest.onCompleted`，那条路**根本拿不到 body**。

### 5.2 方案：把已经抓到的暴露出来，而不是新建抓取

最小实现（**推荐**）：

1. `net record` 期间 `#har` 里**已经有 body** → 暴露成
   `warren net body <env> <index>`（读内存里的 `#har`，不落盘）。
2. 不在录制中时明确报错：`NET_BODY_NEEDS_RECORDING`，错误消息给出下一步命令
   （复用 `DIALOG_OPEN` 那种"错误消息直接给出下一步"的写法）。
3. 脱敏：复用 `interceptor.ts` 里已有的 `redactHeaders` 思路，**body 也要过
   `redactSecrets`**（`browser/escape.ts`），否则会把 token 写进日志。

**落点**：`src/main/net/interceptor.ts`（暴露一个只读访问器）+ `rpc-dispatch.ts` +
`bin/warren.mjs`（`formatXxxLine` 别忘了，见 `AGENTS.md` 已知问题 1）。

**验收**：
```bash
node bin/warren.mjs net record start cap --output=/tmp/a.har
node bin/warren.mjs exec cap --lease=<id> <<'JS'
await page.goto('http://localhost:8899/cap/form.html');
await page.evaluate(() => fetch('/cap/api/user?id=1').then(r => r.json()));
JS
node bin/warren.mjs net body cap 0        # 期望拿到 JSON 文本，且 token 已脱敏
node bin/warren.mjs net body cap 0 --json | grep -c '\[REDACTED\]'   # 有敏感字段时 >=1
```

**风险**：
- 录制期间 CORS 不真实 → **必须在 `net record start` 的输出里显式提示**，
  否则用户会拿"录制中的行为"当真实行为（这正是 `ELECTRON-REALISM-PLAN` 说的"调出假 bug"）。
- body 进日志 = 凭据落盘风险。脱敏是硬要求，不是可选项。

---

## 批次 6：鼠标路径 → 视觉通道 —— **已完成（2026-10-17）**

### 6.1 鼠标路径

**现状**：`mouseClick` 是 `mouseMoved → pressed → released`，一步跳到目标。

**做法**：新增 `src/main/browser/input-synthesis.ts`（**纯函数，可单测**）——
二次贝塞尔路径，点数按距离 3~16 个，垂直外凸幅度取距离 6%、上限 24px（别飘到别的元素上）。
`actions.ts` 加 `moveAlongPath()`，**click 与 hover** 都改走它。

- **只合成移动，不碰按下那一下** —— 按下/抬起仍由各动作自己发，
  **不绕过 `actionability.ts` 的 `runAction` / `checkActionable`**（`AGENTS.md` 已知问题 8）。
- 逃生：`WARREN_INPUT_PATH=0` 关掉（和 `WARREN_TIMEOUT_MS` 一样走环境变量，不加 CLI 参数）。
- **实测**：页面里数的 `mousemove` 次数 **1 → 8**。
- **开销**：`steps × 8ms`，最坏 16 步 ≈ 128ms/次点击；回归整体从 ~1:00 涨到 **1:32**
  （多出来的一半是 6 个批次验收脚本，不全是路径）。

### 6.2 视觉通道

**第一个实验（决定了做法）**：同一页面**连截三次，SHA-256 完全相同**
（`d68770ac0a7c7d99…`）。所以**哈希对比可用**，不用引图像库做逐像素。

**做法**：`warren shot diff <a.png> <b.png>` —— 比 SHA-256，**不同则退出 1**（可以直接当断言用，
`&&` 也能串）。不需要环境，比的是两个文件。缺文件报错退出 1，不抛栈。

**没做**：`warren://diff` 的 canvas 逐像素对比。哈希够回答「改了 CSS 之后页面变了吗」，
逐像素要引图像库或写一个内部页面 —— **等真需要再说**（`shortcut:` 记在 CLI 注释里）。

**验收（`node scripts/verify/batch6-path-shot.mjs` → BATCH6 PASS）**：
mousemove ≥ 3；同页面连截两次字节相同；`shot diff` 相同 exit 0 / 不同 exit 1 / 缺文件 exit 1。

---


### 6.1 鼠标路径

**现状**：`keymouse.ts:32` 的 `mouseClick` 是 `mouseMoved → mousePressed → mouseReleased`
**一步到位**。缺的是路径（真人几十个坐标）与时序。

**方案**：在 `mouseClick` 之上加一层路径合成（贝塞尔，10–20 点，带 8–16ms 间隔）。
**放在 `actions.ts` 调用 `mouseClick` 之前**，不要改 `mouseClick` 本身
（坐标鼠标 API 是给"我要精确点这个坐标"用的，不该被路径污染）。

**落点**：新增 `src/main/browser/input-synthesis.ts`；`actions.ts` 的点击分支改用它。

**⚠️ 铁律**：**不能绕过 `actionability.ts` 的 `runAction` / `checkActionable`**
（`AGENTS.md` 已知问题 8）。路径合成要插在"已经确认可点"之后、真正发 press 之前。

**验收**：新 fixture `fixtures/capability/mouse-path.html`，页面里数 `mousemove` 次数并
在 canvas 上画路径；判据：`mousemove` 次数 ≥ 10（现在是 1），且终点坐标与目标一致。

**风险**：多出来的 10–20 次 `dispatchMouseEvent` 会让每次点击变慢（默认 8ms × 20 ≈ 160ms）。
**要做成可选**（默认开？）—— 这里要一个产品决定：agent 的每次点击慢 160ms 值不值。
建议**默认开**（联调场景真实性优先），并给 `--fast` 逃生。

### 6.2 视觉通道

**现状**：主通道是 AX 树（`HANDOFF.md` §3.5 的明确决策），截图是次通道。
`Page.captureScreenshot` 有（`snapshot.ts:310`）。**没有图像处理依赖**
（`package.json` 里没有 sharp / pixelmatch / pngjs）。

**方案**：不要为了 diff 加依赖。两步走：

1. **`warren shot <env> --output=a.png` 已经有了**（`browser screenshot`）。
   补一个**哈希对比**：`warren shot diff <env> a.png b.png` → 比 SHA-256，
   判"变没变"。**这一步不加依赖，覆盖 80% 的联调场景**（"我改了 CSS，页面变了吗？"）。
2. 真要**逐像素**：不要引图像库，做一个内部页面 `warren://diff`（复用
   `environments.ts` 的 `warren://newtab` 那套 `protocol.handle`），
   用 **canvas 在页面里比**两张图 —— 纯 web 技术，零依赖。

**落点**：`bin/warren.mjs`（`shot diff`）+ `src/main/newtab.ts` 旁边加 `diff-page.ts`
（如果走第 2 步）。

**验收**：同一页面截两次 → `diff` 报"相同"；改一次 CSS → 报"不同"（并给出差异像素数）。

**风险**：
- 截图有非确定性（动画、光标、字体渲染）→ **哈希对比会假报"不同"**。
  必须先实测"同一页面连截两次是否字节相同"，**这是这一步的第一个实验**。
- 第 2 步动了 `HANDOFF.md` §3.5 的决策（观察主通道），**改之前先读完那份理由**。

---

## 附：本次调研里会改变做法的那几条

1. **`protocol.handle` 破坏 CORS**（`interceptor.ts:47` 的实测注释）——
   直接决定了批次 5 不能"常开抓 body"。
2. **body 其实已经在抓了**（`#capture`），只是藏在录制里 —— 批次 5 的工作量因此**从"新建"
   变成"暴露"**。
3. **`loadExtension` 不支持 `.crx`** —— 批次 3 要给用户一个解包步骤，不能假装"拖个 crx 进来就行"。
4. **`debug.*` 要求非打包**（`rpc-dispatch.ts:316`）—— 批次 2 的 CI 不能跑打包产物，
   必须 dev 模式。这条是最容易在 CI 上踩的。
5. **公开仓库的 runner 免费无限（含 macOS）** —— 批次 2 的成本顾虑不存在。

---

## 与既有文档的关系

- `OPTIMIZATION-PLAN-2026-10-17.md` —— 决策记录（为什么这么排 + 那次推翻旧结论的实验）。
- `ELECTRON-REALISM-PLAN.md` —— 四个缺口的出处。
- `CODEBASE-ASSESSMENT-2026-10-17.md` §3.2 —— 三条结构性风险。
- `AGENTS.md` 已知问题 1 / 8 / 11 —— 批次 5、6 动手前必读。
- `HANDOFF.md` 坑 36 —— 批次 1、2 的核心争议点。
