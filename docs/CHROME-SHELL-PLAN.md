# Chrome 套壳：调研结论与规划

> 状态：**调研完成，方案未实施**。本文只记录事实与规划，不含实施步骤。
> 日期：2026-10-17
> 起因：用户依次问了「二开 Chrome 来开发当前项目可行吗」→「参考 ego lite 或别的二开产品魔改呢」
> →「编译浏览器能放 GitHub 吗 / 我一个月只有 100G 流量够吗」→「把右边换成真 Chrome 的界面，
> 类似在 Chrome 外套一层管理壳」。
>
> 本文取代口头讨论。**所有标「实测」的数字都是本机跑出来的**，标「官方原文」的是文档引用，
> 其余是推算并已注明。不要凭印象引用本文。

---

## 预期目标（用户 2026-10-17 明确要求，别走偏）

**最终形态**：左边是 Warren 的管理壳（环境列表 / 接管 / 检查器 / 事件时间线），
**右边是货真价实的 Chrome 界面** —— Chrome 自己的地址栏、标签条、菜单，不是 Warren 自绘一个
「长得像」的。整体观感 = **在 Chrome 外面套了一层管理壳**。

**三条硬性预期**：

1. 右边必须是**真 Chrome**（不是 Electron 自绘 UI，也不是自建 Chromium 壳）——
   否则网页侧可能被检测（用户原话：「不然可能会被检测」）。
2. 软件其余功能逻辑**和现在一致**（Environment / lease / 人机同视 / CLI / 插件 / vault / 网络拦截）。
3. 用户看的那个 Chrome 窗口 = agent 操作的那一个（**人机同视不能丢**）。

**这条目标决定后面所有取舍**：

- 任何「更省事但右边不是真 Chrome」的方案都不算达成目标（§4 里那些「不做」的都因此被排除）。
- 反过来，任何与「右边是不是真 Chrome」**无关**的改动都不算偏离 ——
  典型就是 §5 阶段 1 的检测面加固：它在两条路上都有收益，先做不吃亏。

---

## 0. 一句话结论

**「右边要是真实浏览器」这个需求成立，但它不等于「换内核」。**

- 换内核（自编译 Chromium / Electron / CEF / 补丁栈）：**不可行或不划算**，理由见 §2.1。
  本节复核了 `TECH-STACK-RESEARCH.md` §13 与 `HANDOFF.md` §3.1 的结论，**仍然成立**。
- Warren 当前的检测面问题（§2.7 实测）**大部分是配置和用法问题，不是引擎问题**，
  换内核一层都解决不了。
- 用户最新要的「右边是 Chrome 界面」= **窗口级套壳**（§3），这是唯一能拿到**真 Chrome UI**
  的路子。它不换内核、能复用现有 CDP 层，但有一个单点体验风险（窗口跟随），见 §3.2 / §6。

---

## 1. 本轮问过的问题（原文记录，别再问一遍）

| # | 问题（用户原话） | 结论落点 | 状态 |
|---|---|---|---|
| Q1 | 二开 Chrome 开发当前项目可行吗 / 有价值吗 / 难度呢 | §2.1、§4 | 已答：不可行 / 不值 |
| Q2 | 参考 ego lite，或基于它魔改呢？别的二开产品呢？ | §2.5、§2.6 | 已答：内核闭源，不可魔改；JS 侧可白抄 |
| Q3 | 编译浏览器可以放到 GitHub 吗？ | §2.3 | 已答：代码能放、分发放得下，**编不了** |
| Q4 | 二开 Chrome 流量花费多吗？我一个月只有 100G | §2.4 | 已答：够，但首次吃掉 30–40 GB |
| Q5 | 为啥要 30G，构建出来不才几百 M 吗？ | §2.1 | 已答：源码/历史/依赖/中间产物 vs 链接后的成品 |
| Q6 | 我们本机配置够吗？ | §2.2 | 已答：够，且舒适（实测） |
| Q7 | 不拉历史可以吗？最小化可开发仓库是啥？ | §2.5 | 已答：`--no-history` 官方支持且可逆；最小仓库 = 补丁栈 ~20 MB |
| Q8 | 推荐基于官方开发还是基于什么开发？ | §4 | 已答：官方 Chromium + 补丁栈（ungoogled 模板） |
| Q9 | **右边换成真 Chrome 界面，像在 Chrome 外套管理壳** | §3、§5 | **当前方向**，待原型验证（阶段 0） |
| Q10 | 在 Chrome UI 上套我们壳，不可行吗？ | §3.4 | 已答：overlay 可行且少一个风险；但产品形状会变 |
| Q11 | 那别的二开 chrome 浏览器是怎么做的？ | §3.5 前一段、下表 | 已答：**它们不套壳，它们直接改浏览器** |
| Q12 | 评估第一类（fork）的可行性 + 工作量 | §3.5 | 已答：技术可行，**单人维护不成立** |
| Q13 | 不换内核、继续用 Electron，怎么让 AI 联调更接近真实浏览器行为 | 见 `docs/ELECTRON-REALISM-PLAN.md` | **待办（当前问题）** |

**Q11 的答案（分类表，证据见 §3.5 上方的调研）**：

| 做法 | 谁在用 | 拿到真 Chrome UI |
|---|---|---|
| fork Chromium 改 `chrome/browser/ui/` | Brave / Vivaldi / Edge / Opera / Arc / Dia / Comet / Atlas / BrowserOS / ego lite | ✓（就是浏览器本身） |
| Chrome 扩展 + side panel | `void5tar/Curio`、`imshaikot/browsentic`、Google 的 Gemini in Chrome | ✓（借 Chrome 的侧边栏） |
| 独立窗口 + 旁路管理壳 | AdsPower / Multilogin / GoLogin / Dolphin / Octo 等 profile 管理器 | ✓（浏览器窗口是真的，但不嵌入） |
| CDP screencast 流进自己 UI | browserless / Browserbase / Selenoid live view | ✗（只有画面） |
| Electron `WebContentsView` | **Warren 现在** | ✗ |
| 窗口级套壳（把 Chrome 窗口摆进自己窗口） | **未找到主流先例** | ✓ |

---

## 2. 已确认的事实

### 2.1 二开 Chromium 的真实成本

| 项 | 数字 | 来源 |
|---|---|---|
| Chromium 源码 git cache | **~30 GB** | 官方原文（mac build instructions）：「It mirrors every repo it fetches (~30 GB for Chromium)」 |
| 抓树耗时 | 快网络 **30 分钟**，慢网络数小时 | 同上 |
| 磁盘需求 | **至少 100 GB**；构建目录另需 **~50-80 GB** | 官方原文（linux build instructions） |
| 内存需求 | 8 GB 起，**16 GB 以上强烈推荐** | 同上 |
| 单次构建耗时 | **1-3 小时** | BrowserOS `CONTRIBUTING.md` |
| 构建要求 | 100 GB 磁盘 + 16 GB+ RAM | 同上 |
| 版本节奏 | 跟 Chrome 每 4 周一个大版本 → 每次 rebase 补丁 + 重建 + 重签名 | 业界节奏，**未实测** |

**Q5 的答案（为什么 30 GB 而成品只有几百 MB）**：

- 30 GB = **git 历史**（主仓库 ~130 万提交）+ **DEPS 拉来的 ~200 个独立仓库**（V8 / Skia / WebRTC /
  ANGLE / ffmpeg / pdfium / BoringSSL / ICU / abseil…），每个都带自己的历史。
- 100 GB = git cache + 工作树 + **`out/Default`（几万个 `.o`、静态库、调试符号）**。
- 成品 200 MB = 链接器做 dead code elimination（丢掉 90%+ 目标文件）+ `strip` 调试符号 + 签名 + 压缩。
- **本仓库自己就是同一个现象**（实测）：`node_modules` 733 M + `out/` 856 M（`Warren.app` 288 M）
  → 最终 `out/make/dmg` **121 M**。Chromium 只是把这个比例放大 100 倍。

### 2.2 本机配置（实测）

```
MacBook Pro Mac16,7 · Apple M4 Pro · 14 核（10 性能 + 4 能效）· 48 GB 统一内存
macOS 26.6 · Xcode 17 / Apple clang 17 · python 3.12.15 · uv 已装
磁盘：926 GiB 总，533 GiB 可用
```

| 项 | 官方要求 | 本机 | 判定 |
|---|---|---|---|
| 内存 | 8 GB 起，16 GB+ 推荐 | **48 GB** | 3 倍，舒适 |
| 磁盘 | >=100 GB（构建另需 50-80 GB） | **533 GB 可用** | 5 倍 |
| CPU | 8 核以上 | M4 Pro 14 核 | 远超 |
| Python | 3.9+ | 3.12.15 | OK |
| Xcode / SDK | 最新 SDK 通常可用 | Xcode 17 | OK（不在官方 bot 版本表上，见 §6 风险） |

**结论：配置不是瓶颈，够且舒适。** 真瓶颈是时间（每次 1-3 小时）和流量（§2.4）。

### 2.3 GitHub 能放什么（官方原文）

| 放什么 | 限制 | 结论 |
|---|---|---|
| 仓库内文件 | **>100 MiB 被拒**，>50 MiB 警告 | 内核源码**放不进仓库** |
| 仓库体积 | 建议 <1 GB，强烈建议 <5 GB | 同上 |
| Releases 资产 | **「We don't limit the total size of the binary files in the release or the bandwidth used to deliver them」**；单文件 <= 计划上限（Free 2 GB） | **分发放得下，且下载流量由 GitHub 出** |
| GitHub Actions runner | **14 GB SSD** | **编不了 Chromium**（要 100 GB） |

**实测别人怎么发**：

- BrowserOS 一次发 7 个包共 ~1.1 GB（dmg 156/170/287 MB、deb 174 MB、AppImage 209 MB、exe 131 MB）
- Cromite 一次 APK 230-310 MB + symbols 98 MB + mapping 150 MB
- BrowserOS 的 Chromium 构建跑在 **WarpBuild** runner + R2 缓存上（`.github/workflows/build-browseros.yml`
  写着「Reusable WarpBuild job for one Chromium browser build」，还有一步 "Report disk usage"）

→ **代码和分发放 GitHub，编译必须自建 runner 或买大磁盘 runner。**

### 2.4 流量账（预算 100 GB/月）

| 项 | 一次性 | 每月 | 说明 |
|---|---|---|---|
| 首次 `fetch` + `gclient sync` | **30-40 GB** | — | 官方 30 GB cache + 依赖 |
| 跟一个大版本 sync | — | 2-8 GB | 跟 Chrome 4 周节奏 |
| 工具链 | 5-10 GB | 小 | Xcode CLT / SDK / ninja |
| 上传构建产物 | — | ~0.5 GB 上行 | GitHub Releases |
| **用户下载** | — | **0** | GitHub 出带宽（官方原文） |

**结论：100 GB 够，但抓源码那个月会吃掉 30-40 GB，只剩 60-70 GB。**
危险动作：每次全量重抓、`rm -rf` 重来、在 CI 里每次重新同步。
省钱手段：保留 git cache（`--cache-dir` / `fetch --git-cache`，一次下载多 checkout 共享）。

### 2.5 最小可开发仓库 = 补丁栈（Q7 / Q8 的答案）

**先分清两个东西**：

- **你的仓库**（push 到 GitHub）→ **~20 MB**，只放补丁 + 构建脚本
- **本机 Chromium checkout**（30 GB）→ **构建缓存，不是你的代码，不进仓库**

**实测：三个真实项目全部是补丁栈模式**

| 项目 | 许可证 | 星 | 仓库体积 | 里面是什么 |
|---|---|---|---|---|
| ungoogled-chromium | BSD-3 | 28.0k | **18 MB** | `patches/`、`chromium_version.txt`、`revision.txt`、`flags.gn`、`devutils/` |
| adryfish/fingerprint-chromium | BSD-3 | 3.1k | **16.9 MB** | 同上 |
| browseros-ai/BrowserOS | **AGPL-3.0** | 14.0k | 205 MB | 内核部分只有 `chromium_patches/`（base/chrome/content/ui 分目录）+ `chromium_files/` + `BASE_COMMIT`；205 MB 大头是 agent 平台 |
| brave/brave-core | MPL-2.0 | 3.7k | 4.7 GB | **另一种模式**：整树 fork |

**`--no-history`（Q7）**：官方原文支持 ——
「If you don't need the full repo history, you can save time by using `fetch --no-history chromium`.
You can call `git fetch --unshallow` to retrieve the full history later.」
补丁栈模式本来就不依赖 git 历史（补丁是文件，更新内核时重新 apply）。
**但官方现在更推荐 `fetch --git-cache chromium`**：保留全历史、多 checkout 共享、per-checkout 的 `.git` 很小。

### 2.6 ego lite 解剖（实测，Q2 的答案）

**公开仓库 `citrolabs/ego-lite`：MIT、17.5k 星、7.4 MB、JavaScript —— 只有 JS 侧**
（`skills/`、`docs/`、`package/ego-browser`、`spec/`）。它自己在 `docs/native-bindings-api.md` 写明：
「These bindings are provided by Ego Lite, not implemented by this repository.」

**内核本体闭源**：本机 `/Applications/ego lite.app` 806 MB，签名 + 公证（CITRO LABS PTE. LIMITED）。

| 项 | 实测值 |
|---|---|
| 框架 | `ego Framework.framework`，主二进制 **260 MB** |
| 内核版本 | **`Chrome/152.0.7977.54`** |
| 内嵌运行时 | `ego Helper (Node).app`，CLI 报 node v24.18.1 |
| 更新器 | `EgoUpdater.app` + `active_version_dir`（本机同时存在 0.5.1.13 / 0.6.0.12） |
| 平台 | 仅 macOS（DMG） |

**关键对照（实测）**：

```
ego lite 内核                   Chrome/152.0.7977.54
Warren 的 Electron 44.7.0 内核  Chrome/152.0.7977.130   <- 同一条线
```

**也就是说：ego lite 的「自研 Chromium 引擎」和 Warren 现在跑的内核是同一个大版本，
网络层（BoringSSL / net 栈 / JA3）基本一致。** 换内核买不到这一层（见 §2.8）。

**ego lite 公开文档里最有价值的东西**（可以白抄，不需要内核）：

- `docs/native-snapshot-ref-requirement.md` —— snapshot 压缩规则（去空文本节点、无名单子节点 container 上提）、
  跨 renderer 全局唯一 `refId`、iframe/OOPIF 里可操作节点的 ref、stable locator 唯一性校验。
  **第一节那套压缩规则纯 JS 就能实现。**
- `docs/native-bindings-api.md` —— `globalThis.ego` 方法表、错误码、handoff 后哪些 API 被锁。
- `docs/native-sdk-lifecycle-requirement.md` —— `disposeEgoSdk()` 生命周期纪律。

**魔改 ego lite：不可行**（内核闭源、只有签名二进制；`--sdk-path` 只能替换 JS 运行时）。

### 2.7 Warren 当前检测面（实测，本机 Electron 44.7.0 探针）

探针脚本：`/tmp/probe.cjs`（隐藏 `BrowserWindow` + `executeJavaScript`，自己退出）。
复跑：`npx electron /tmp/probe.cjs`。

```
ua:          Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)
             Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36
webdriver:   false
chromeKeys:  []                       <- Object.keys(window.chrome) 是空数组
h264:        "probably"               <- 专有编解码器可用
plugins:     ["PDF Viewer","Chrome PDF Viewer","Chromium PDF Viewer","Microsoft Edge PDF Viewer","WebKit built-in PDF"]
languages:   ["zh-CN","zh-Hans-CN","en",...]（34 项）
hw:          14
webglVendor: ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)
```

**待测（本次取不到，别当结论）**：`navigator.userAgentData` —— `about:blank` 不是安全上下文，
必须在真实 https 页面上再测一次，确认有没有 `Electron` brand。

**两个确定的破绽**：

```
Warren:     ... Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36
真 Chrome:  ... Chrome/152.0.0.0 Safari/537.36
```

1. UA 里有 `Electron/44.7.0` 字样。
2. **Chrome 版本号没冻结** —— Chrome 从 101 起把 UA 里的版本压成 `<major>.0.0.0`，
   Electron 报了完整的 `152.0.7977.130`。一条正则就能抓。
3. `window.chrome` 是空对象（真 Chrome 有 `csi` / `loadTimes` / `app` 等）。

**已经干净的（重要，别重复劳动）**：

- `navigator.webdriver === false`
- **不开任何调试端口** —— 实测 `rg remote-debugging src/main` 为空；`session.ts` 走
  `wc.debugger.attach('1.3')`，是**进程内**附加，不监听端口。
- **不启 `Runtime.enable`** —— 用的是 `Runtime.evaluate`（`controller.ts` / `waits.ts` /
  `page-helpers.ts`）。这正是 patchright 那类工具的核心修法。
- H.264 可用；WebGL / 硬件并发 / 语言集与同机真 Chrome 一致（同机同内核，本就该一致）。

### 2.7.1 已修（2026-10-17，阶段 1 第 1、2 项）

改了两处：`src/main/environments.ts` 的 `#sessionFor()` 里 `setUserAgent()`；
新增 `src/preload/page-preload.ts`（环境页 preload）+ `forge.config.cjs` 的第三个 build entry
+ `src/main/tabs.ts` 的 `VIEW_PREFERENCES.preload`。

**实测对照（`warren exec` 读环境页，真 Chrome 155 是 headless 对照）**：

| 字段 | 修复前 | 修复后 | 真 Chrome | 判定 |
|---|---|---|---|---|
| UA | `... Warren/0.1.0 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36` | `... Chrome/152.0.0.0 Safari/537.36` | `... Chrome/155.0.0.0 Safari/537.36` | **形状一致**（major 差 = 内核版本差，不是伪装差） |
| `Object.keys(window.chrome)` | `[]` | `["loadTimes","csi","app"]` | `["loadTimes","csi","app"]` | **一致** |
| `navigator.webdriver` | `false` | `false` | `false` | 一致 |
| `navigator.userAgentData.brands` | `[Not?A_Brand/24, Chromium/152]` | 同左 | `[Google Chrome/155, Chromium/155, Not(A:Brand/24]` | **仍是 Chromium，决定不改（见下）** |

**踩到的坑（值得记）**：第一版只用正则删 `Electron/x.y.z`，实测发现 UA 里**冒出了
`Warren/0.1.0`** —— Electron 会把 **`productName`** 插进产品段，不是固定写 `Electron/`。
所以现在改成「只保留平台段、产品段整个重建」（`src/main/domain/user-agent.ts`，带单测）。
**教训**：UA 这种拼接串不要逐个删 token，要按形状重建。

**为什么 `brands` 不改**：Electron 没有公开 API 设置 `userAgentMetadata`。
唯一能改的两条路都比不改更糟 ——

1. 只改 `Sec-CH-UA` 请求头 → 头和 JS 里的 `navigator.userAgentData` **互相矛盾**，比现在更显眼；
2. preload 覆盖 `Navigator.prototype.userAgentData` 的原生 getter → 返回伪造的 `NavigatorUAData`，
   这是**最典型的检测点**（`Object.getOwnPropertyDescriptor` 一看就是改过的）。

现在的值（`Chromium` + 无 `Google Chrome`）**是真实 Chromium 会有的值**，和 UA 里的
`Chrome/152` 自洽（Chromium 的 UA 也写 `Chrome/xxx`）。所以这一层的结论是：
**能把 Warren 伪装成一个干净的 Chromium，装不成 Chrome —— 要 Chrome 只能上真 Chrome 二进制**
（即本方案 §5 阶段 2 的套壳）。

### 2.8 五层检测面：哪一层换内核能解决

| 层 | 查什么 | Warren 现状 | 换内核能解决吗 |
|---|---|---|---|
| 1 网络指纹 | TLS JA3/JA4、HTTP2 SETTINGS | Electron 44.7 = Chromium **152**，与真 Chrome 152 同栈 | **不能**（本来就是 Chromium） |
| 2 UA / Client Hints | 字符串 + brands | §2.7 两个破绽 | 不能，**几行代码能修** |
| 3 CDP 痕迹 | `Runtime.enable`、调试端口 | 已干净（§2.7） | 不能，是用法问题 |
| 4 API 表面 / 专有组件 | `window.chrome`、Widevine、Chrome 扩展 | `window.chrome` 空；H.264 OK | **只有真 Chrome 二进制能解决**（官方 Chromium 也没有） |
| 5 行为信号 | 鼠标轨迹、时间模式 | `Input.dispatchMouseEvent` 直发，无移动轨迹 | 不能，与内核无关 |

**推论：自建 Chromium 壳 / CEF / 补丁栈，拿到的是官方 Chromium —— 第 4 层一样没有，
第 1/2/3 层不会更好，还要背上 §2.1 的全部成本。这是最亏的一条。**

---

## 3. 需求：把右边换成真 Chrome 界面（Q9）

### 3.1 三种读法，取哪一种

| 读法 | 是什么 | 判定 |
|---|---|---|
| A 自绘 Chrome 风格 UI | 继续用 `WebContentsView`，把 tabstrip / omnibox 画得像 Chrome | 就是现在 `TAB-MODULE-PLAN.md` 的方向。**永远是「像」，不是「是」** |
| B 真 Chrome 嵌进 Warren 窗口 | 把 Chrome 的渲染嵌到 Electron 窗口里 | **技术上不存在**。Chromium 不提供可嵌入的 browser-UI 层；Electron 只给 content 层，`chrome/browser/ui/` 那部分完全没有 |
| **C 窗口级套壳** | Warren 主窗口留一个洞，**真 Chrome 进程的窗口被摆到那个洞里** | **唯一能拿到真 Chrome UI 的路** <- 用户要的是这个 |

**为什么 B 不存在**：Electron = Chromium 的 **content 层**（网页渲染）+ Node。
Chrome 的地址栏 / 标签条 / 菜单属于 **`chrome/browser/ui/`**，Electron 根本不编这部分 ——
这就是所有 Electron 应用都不像 Chrome 的原因。

### 3.2 C 的关键技术事实

```
+-----------------------------------------------+
| Warren 主窗口（Electron）                      |
| +------------+------------------------------+ |
| | 环境列表    |  [洞 -- 真 Chrome 窗口摆在这] | |
| | 检查器      |  <- 带 Chrome 自己的地址栏/标签| |
| +------------+------------------------------+ |
+-----------------------------------------------+
```

**能复用的（这是 C 最大的优势）**

- `src/main/browser/*.ts` 那 19 个文件是**纯 CDP 逻辑**（controller / snapshot / waits / actions /
  policy / matcher / refs…）。现在通过 `wc.debugger.sendCommand` 发；换成 WebSocket 发到外部 Chrome，
  **上层几乎不用改**。这就是 `TECH-STACK-RESEARCH.md` §3.2 预留的 `BrowserBackend` 接口的价值。
- `domain/*`、`store`、`vault`、`plugins`、`rpc`、`bin/warren.mjs` **完全不动**。

**要新写的**

| 模块 | 做什么 |
|---|---|
| Chrome 进程管理 | 每环境一个 `chrome --user-data-dir=<env> --remote-debugging-port=<动态> --proxy-server=...` |
| CDP transport 抽象 | `session.ts` 的 `sendCommand` 抽成接口，加 WebSocket 实现 |
| 窗口管理 | 把 Chrome 窗口摆到右侧区域并跟随 Warren 窗口 |
| 遮罩改造 | `input-shield.ts` 现在是 Electron `WebContentsView`，**盖不住独立进程的 Chrome 窗口** → 改成独立原生窗口遮罩 |

**两个已确认的约束**

1. **Chrome 136+ 禁止用 CDP 调试默认 profile**（官方原文）：
   「These switches must now be accompanied by the `--user-data-dir`」
   → 对多环境正好合适（每环境本来就要独立 profile），但**意味着不能直接驱动用户真实登录态的默认 Chrome**。
2. **开了 `--remote-debugging-port` 就多了一个检测面**：页面可以
   `fetch('http://127.0.0.1:<port>/json/version')` 反查到调试端口。
   **这比现在（进程内 debugger、不监听端口）更差。** 走 C 必须用随机端口 + 只监听回环，
   并接受这一层的退化。

**单点风险：窗口跟随。**
Electron 不暴露 `NSWindow.addChildWindow`，而且**跨进程也没法把别人的窗口设成 child window**。
能用的只有 macOS Accessibility API（`AXUIElementSetAttributeValue` 设 `AXPosition`/`AXSize`），
需要用户授权「辅助功能」。拖动 Warren 窗口时 Chrome 会滞后 / 抖动；Chrome 全屏会跑掉；
z-order 也要处理。**这是 C 方案能不能成立的关键，必须先做原型验证（见 §5 阶段 0）。**

### 3.3 C 的另一种形态（备选，成本更低）

**不把 Chrome 塞进 Warren，而是把 Warren 的面板贴在 Chrome 旁边**：Chrome 当主窗口，
Warren 变成它左侧一条常驻面板（第二个窗口，`alwaysOnTop`）。

优点：避开「跟随」问题的一半；更贴近「在 Chrome 外套一层管理壳」的字面意思。
缺点：Warren 的环境列表 / 检查器空间被压缩；切换环境要操作 Chrome 窗口。

**建议两条都做原型，用同一套后端（Chrome 进程管理 + CDP transport 是共用的），
最后按手感选 UI 形态。**

### 3.4 「在 Chrome UI 上套壳」（Chrome 当宿主）—— 2026-10-17 追问

§3.2 是「Warren 当宿主，把 Chrome 摆进来」。反过来问「Chrome 当宿主，我们的壳叠上去」
**可行，而且少一个风险**。三种读法：

| 读法 | 可行性 | 谁当宿主 | 主要代价 |
|---|---|---|---|
| 1 我们的窗口浮在 Chrome 之上（overlay） | **可行**，Electron 有现成 API | Chrome | 遮挡；N 个环境 = N 个 Chrome 窗口 |
| 2 往 Chrome 界面里加我们的 UI | **可行但形状不对**：唯一官方路径是 Chrome 扩展 | Chrome | 扩展活在**一个 profile 内**，管不了多环境 |
| 3 重绘 Chrome 的 UI | **不可能**（同 §3.1 读法 B） | — | — |

**读法 1 的 API（已核对 Electron 44 类型定义）**：

- `win.setAlwaysOnTop(true, 'screen-saver')`
- `win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
  —— 注释原文「Sets whether the window should be visible above fullscreen windows」，`@platform darwin`

**它最大的好处：完全不需要移动 Chrome 的窗口** —— §3.2 那个单点风险（把 Chrome 窗口摆到指定
rect 并跟随）直接消失，反过来是我们的窗口贴着 Chrome。Chrome 的全部正常行为（标签、书签、
扩展、设置、自动更新）我们一点不碰。

**但它把产品形状改了**，这是必须先回答的：

1. **空间**：Chrome 占满窗口，浮层上去就是遮挡。要么浮层是自动隐藏的细条（像 Dock 那样贴边），
   要么改 Chrome 窗口尺寸 —— 后者又回到「动 Chrome 窗口」。
2. **多环境**：一个环境一个 Chrome（独立 profile + 独立代理），所以 N 个环境 = N 个 Chrome
   窗口 + 1 个浮层。而 Warren 现在的核心交互是「左侧环境列表点一下，右边换」——
   这个交互在 overlay 形态下**没有自然落点**。

**读法 2 的边界**：`chrome.sidePanel`（Chrome 114+）是唯一官方支持的「在 Chrome UI 里放自己界面」
的方式，配 **Native Messaging** 就能让扩展连到本地进程（正规架构）。但扩展**拿不到**代理配置、
独立 session、CDP 控制、输入遮罩、vault、文件系统，而且**只能看到自己那个 profile**。
结论：扩展能当「当前环境的面板」，当不了 Warren 的环境列表。

**判断**：读法 1 值得和 §3.2 一起做原型（**它要验的比 §3.2 少**：不需要移动 Chrome 窗口，
只需要自己的窗口置顶，半天内能出结论）。但先回答一句：
**「左侧环境列表点一下切环境」这个交互，在 Chrome 当宿主的形态下放哪？**
答不上来的话，读法 1 会把 Warren 从「一个窗口里的工作台」降级成「Chrome 的附属浮层」。

### 3.5 「第一类：fork Chromium，自己当浏览器」评估（2026-10-17）

**先说结论：技术可行、本机够，但「单人维护一个浏览器」这件事不成立。**

**它不是「套壳」，是「你就是浏览器」**：fork 之后「左侧环境列表」是浏览器 UI 的一部分，
和 Chromium 自己的标签条 / 地址栏平级。所以 §3.2 / §3.4 的窗口跟随、z-order、浮层遮挡
**全部消失** —— 这是它唯一值得付代价的地方。

**可行性**

| 维度 | 判定 |
|---|---|
| 本机硬件 | **够**（§2.2：是官方要求的 3–5 倍） |
| 首次构建 | 可行，1–3 小时/次 |
| 起步模板 | **Thorium**（BSD-3、可闭源、构建系统现成）或 ungoogled-chromium（BSD-3、18 MB 补丁集） |
| 持续门槛 | Chrome 每 4 周一个大版本 → 每次 rebase 补丁 + 回归 |

**工作量的大头不是「改 Chromium」，是「你的代码要搬家」**

| 资产 | fork 之后去哪 | 下场 |
|---|---|---|
| 渲染层 12.3k React | **Chromium WebUI**（`chrome://warren/`） | **可能大部分保留** —— WebUI 就是 web 技术。证据：BrowserOS 的补丁目录里有 `chromium_patches/ui/webui`（实测） |
| 主进程 11.8k TS | **独立 Node sidecar 进程** | **大部分保留**（store / vault / plugins / 策略 / CLI RPC）；`rpc-dispatch.ts` 本来就纯派发、不 import electron，这个设计**正好为这一天准备的** |
| 插件体系 | **没有 Node** | **真损失**。除非像 ego lite 那样把 Node 编进 Chromium（实测它有 `ego Helper (Node).app` + node v24.18.1）—— 那是独立的大工程 |
| 新写 | Profile 管理 / 侧栏挂载 / CDP 端点 / 签名公证更新器 | — |

**一个必须先验证的深改动**：Chromium 的 `Browser` 对象**在构造时就绑定了一个 Profile**，
没有「在同一个窗口里换 Profile」的接口（Chrome 切 Profile = 开新窗口）。Warren 的核心交互是
「一个窗口，左边列 N 个环境，右边切」—— **要保住它就得改这层绑定**。
**这条没在 Chromium 源码里核实过（本机没有 checkout），列为待验证，且可能决定整个方案成不成立。**

**分阶段工时（单人，乐观估计）**

| 阶段 | 内容 | 估时 |
|---|---|---|
| 1 | 从 Thorium / ungoogled 起步，构建跑通 + 品牌化 + 能开窗口 | 2 周 |
| 2 | Profile 管理 + 每 Profile 独立代理（Chromium 原生大部分有） | 3–4 周 |
| 3 | `chrome://warren` WebUI 侧栏（复用 React） | 3–4 周 |
| 4 | Node sidecar 接线（复用现有 `rpc-dispatch`） | 2–3 周 |
| 5 | 签名 / 公证 / 更新器 | 2 周 |
| — | **到「能跑」** | **约 3–4 个月** |
| 6 | **窗口 ↔ Profile 绑定改造**（保住「一个窗口切 N 环境」） | **不确定，1–2 个月，也可能踩不动** |
| 7 | 插件体系（内嵌 Node 或替代方案） | 1–2 个月 |

**「能用」= 6 个月起，「产品级」= 1 年以上。** 参考：Brave 有专职团队做 rebase；
BrowserOS / ego lite 都是融资团队在做同一件事。

**风险（按严重度）**

1. **安全补丁责任** —— 浏览器是攻击面最大的软件。跟版本慢了，用户就暴露在已知漏洞里。
   这是**责任**，不是工作量问题。单人扛这个，不建议。
2. **窗口 ↔ Profile 绑定** —— 上面那条待验证的深改动。
3. **每 4 周的 rebase 节奏** —— 长期占用固定时间，且不能停。
4. **插件体系归零** —— `node:vm` / `utilityProcess` 在 fork 里没有对应物。

**判断：现在不该做。** 在没验证「窗口 ↔ Profile 绑定能不能改」之前，你不知道这个方案是
6 个月还是根本走不通 —— **验证它比写代码便宜得多**（§5 阶段 0 可以顺带覆盖）。

---

## 4. 方案对比（Q1 / Q8 的答案）

| 方案 | 右边是什么 | 真 Chrome UI | 人机同视 | 成本 | 判定 |
|---|---|---|---|---|---|
| **现状** Electron `WebContentsView` | 自绘页面 | 否 | 天然 | 已有 | 保留为默认后端 |
| **C 窗口套壳** | 真 Chrome 窗口 | **是** | 靠窗口摆放 | 中（§3.2） | **当前方向** |
| C' Chrome 当宿主 + 我们浮层 | 真 Chrome 窗口 | **是** | 天然（Chrome 全窗口） | 中低（§3.4） | 值得一起原型，但产品形状会变 |
| 外部 Chrome 独立窗口 | 真 Chrome 窗口 | 是 | 否（窗口不在一起） | 中 | C 的退化版 |
| 自建 Chromium 壳 / CEF | 官方 Chromium | 否（要自己写 UI） | 要自己写 | **极高** | **不做** |
| 换 Electron 内核 | — | — | — | 等于重开项目 | **不做**（`HANDOFF.md` §3.1） |
| 补丁栈（ungoogled 模板） | 官方 Chromium | 否 | 要自己写 | 高（§2.1） | **不做** |
| 魔改 ego lite | — | — | — | 内核闭源 | **不可能** |

**许可证备忘（要抄别人时先看这列）**：ungoogled BSD-3 可闭源 / Thorium BSD-3 可闭源 /
fingerprint-chromium BSD-3 可闭源 / **BrowserOS AGPL-3.0 抄了必须整体开源** /
Cromite GPL-3.0 copyleft / brave-core MPL-2.0 部分 copyleft。

---

## 5. 规划

**批次顺序：先验证「能不能」，再决定「做不做」。** 每批做完给实测证据再开下一批。

### 阶段 0 -- 原型验证（**先做这个，其他都别动**）

只回答一个问题：**macOS 上能不能把真 Chrome 的窗口稳稳摆进 Warren 的右侧区域。**

1. 起一个 `chrome --user-data-dir=/tmp/wenv1 --remote-debugging-port=0 --no-first-run`。
2. 用 Accessibility API（先 `osascript` 试，不行再上原生模块）把它的窗口设到指定 rect。
3. 拖动 Warren 窗口，观察滞后 / 抖动；试 Chrome 全屏、多显示器、缩放。
4. **判据**：拖动时错位不超过一帧能接受的范围，且全屏 / 缩放不炸。

产出：一段能复跑的脚本 + 实测结论（成 / 不成 / 到什么程度）。**不成的活，C 方案就此打住。**

### 阶段 1 -- 检测面加固（**与阶段 0 并行，独立收益，不依赖任何架构决策**）

不管最后选哪条路，这几项都该做，且都能用现成工具验收：

| # | 事项 | 状态 |
|---|---|---|
| 1 | `session.setUserAgent()` 对齐真 Chrome 格式（去掉应用名 + Electron 段、版本压成 `<major>.0.0.0`） | **已做，已实测**（§2.7.1） |
| 2 | 补 `window.chrome` 形状（`csi` / `loadTimes` / `app`） | **已做，已实测**（§2.7.1） |
| 3 | 实测 `navigator.userAgentData.brands` | **已测，决定不改**（理由见 §2.7.1） |
| 4 | `click` 前发几个 `Input.dispatchMouseEvent(mouseMoved)`，别从 A 直接跳到 B | **未做**（下一轮） |

**落地方式（第 1、2 项）**：`src/main/domain/user-agent.ts`（纯函数 + 单测）、
`src/main/environments.ts` 的 `#sessionFor()`、`src/preload/page-preload.ts`（新）、
`forge.config.cjs` 第三个 build entry、`src/main/tabs.ts` 的 `VIEW_PREFERENCES.preload`。

**验收（实测命令与结果）**：

```bash
npm run lint && npm run format:check && npx tsc --noEmit && npm test \
  && node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
# lint / format / tsc 干净；npm test 176/176（新增 3 条 user-agent 单测）

bash scripts/regress/run-all.sh     # 137 PASS / 0 FAIL

# 环境页实测（应用起着）：
node bin/warren.mjs exec cap --lease=<id> <<'JS'
await page.goto('https://example.com');
console.log(await page.evaluate(() => JSON.stringify({
  ua: navigator.userAgent, chrome: Object.keys(window.chrome || {}),
  webdriver: navigator.webdriver, brands: navigator.userAgentData?.brands })));
JS
# → ua 里无 Electron/Warren、版本是 152.0.0.0；chrome=["loadTimes","csi","app"]
```

### 阶段 2 -- 后端抽象（阶段 0 通过后才做）

1. 把 `src/main/browser/session.ts` 的 `sendCommand` 抽成 transport 接口，
   保留现有 `wc.debugger` 实现，新增 WebSocket 实现。
2. `ChromeProcessManager`：启动 / 停止 / 端口分配 / `--user-data-dir` / `--proxy-server`。
3. `Environment` 增加后端类型（内嵌 / 外部 Chrome），沿用现有 `BrowserBackend` 命名。

验收：`bash scripts/regress/run-all.sh` 在**两种后端**下都跑通（现有 133 PASS / 0 FAIL 基线）。

### 阶段 3 -- UI 与遮罩

1. 右侧改成「洞」；环境切换 = 切换哪个 Chrome 窗口摆进来。
2. `input-shield.ts` 改成独立原生窗口遮罩（盖在 Chrome 窗口上，只拦人）。
3. 决定 §3.2 还是 §3.3 的 UI 形态（建议两个原型都做，按手感选）。

### 阶段 4 -- 打包与分发

决定是**依赖用户已装的 Chrome**，还是**随包发一份**（+150 MB/平台）。
注意 macOS 公证 / 辅助功能授权文案 / 首次运行引导。

---

## 6. 未决问题（下次接手先看这里）

1. **窗口跟随在 macOS 上到底行不行**（阶段 0）—— 整个 C 方案的单点风险，
   **没验证之前不要写阶段 2 的代码**。
2. **目标站点到底查哪一层** —— 是 Cloudflare / DataDome 那类，还是内部系统？
   查 UA / CDP 痕迹 → 阶段 1 就够；查 `window.chrome` / Widevine → 才需要真 Chrome。
   **别先换架构，先抓一次包 / 跑一次探针。**
3. ~~`navigator.userAgentData` 在真实 https 页面的值~~ —— **已测**（2026-10-17）：
   Electron 侧是 `[{Not?A_Brand,24},{Chromium,152}]`，真 Chrome 155 是
   `[{Google Chrome,155},{Chromium,155},{Not(A:Brand,24}]`。**决定不改**，理由见 §2.7.1。
4. 每环境一个 Chrome 进程的内存开销（基线估计 200-400 MB/环境，**未实测**）。
5. 输入遮罩改成独立原生窗口后的可靠性（现在 Electron 版是实测过的）。
6. 随包分发 Chrome 的体积 / 公证 / 更新策略。
7. `--remote-debugging-port` 带来的新检测面（§3.2 第 2 条）能不能接受。

---

## 7. 复现方式

**检测面探针**（本机 Electron 侧基线）：

```bash
cd <repo> && npx electron /tmp/probe.cjs     # 隐藏窗口，自己退出
```

**对比真 Chrome**（在真 Chrome 的 DevTools 控制台里跑同一段）：

```js
JSON.stringify({ ua: navigator.userAgent, brands: navigator.userAgentData?.brands,
  webdriver: navigator.webdriver, chrome: Object.keys(window.chrome || {}) })
```

**在 Warren 的环境页里跑**（应用和 fixture 起着，见 `HANDOFF.md` §8）：

```bash
node bin/warren.mjs call debug.rendererEval \
  '{"script":"JSON.stringify({ua:navigator.userAgent,brands:navigator.userAgentData?.brands,webdriver:navigator.webdriver,chrome:Object.keys(window.chrome||{})})"}'
```

**真 Chrome 侧**（阶段 0 原型用）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/wenv1 --remote-debugging-port=0 --no-first-run about:blank
curl -s http://127.0.0.1:<port>/json/version   # 端口从 stderr 的 DevTools listening 行拿
```

---

## 8. 与既有文档的关系

- `TECH-STACK-RESEARCH.md` §13 / `HANDOFF.md` §3.1：**换内核已否决**，本文 §2.1 / §2.8 复核仍成立，
  但**补了本轮实测的数字**（30 GB / 100 GB / 本机配置 / 检测面）。
- `HANDOFF.md` §3.2：`BrowserBackend` 接口的预留位，**本文阶段 2 就是把它兑现**。
- `TAB-MODULE-PLAN.md`：自绘标签条（读法 A）已经做完并实测 —— 走 C 之后，**标签条要交给 Chrome 自己画**，
  那部分工作会闲置（但 `tab.*` RPC / `domain/tabs.ts` 的纯逻辑在两种后端下都有用）。
- `input-shield.ts`：§5 阶段 3 要改，改之前先读 `HANDOFF.md` §3.6。
