# 剩余工作施工计划（2026-10-16）

> 承接 `docs/HANDOFF.md` §6「未做 / 受阻」那 6 条。每条给：**现状（已实测的事实）→ 方案 → 落点 → 验收 → 风险 → 批次**。
> 批次按「价值 / 风险」排序，一批做完验完再开下一批。**不要**跨批次并行改同一批文件。

---

## 批次总览

| 批次 | 内容 | 风险 | 状态 |
|---|---|---|---|
| A | 标签手感（阶段 2 的 6 项）+ 2.8/2.9 实测 | 低 | **已落地并实测，见 §A** |
| B | 网络拦截补完：`net passthrough`（CORS 偏差那半步见 §B 结论） | 中 | **`net passthrough` 已落地并实测** |
| C | 稳定性：LRU 回收 / 退出清理 / crash recovery / **SQLite 全量迁移** | 中 | **已落地并实测** |
| D | sandbox 插件异步时限 + Cookie 受控通道（先设计） | 中高（安全边界） | **已落地并实测（设计先落 §9，再实现）** |
| E | 跨源 iframe（OOPIF） | 高（已知卡点） | **已落地并实测：V5b 转 PASS，全量回归 119/0** |
| F | 弹窗拦截 | 需产品决策 | 默认不做 |

---

## A. 标签手感（`docs/TAB-MODULE-PLAN.md` §11 阶段 2）

### 现状

阶段 2 九项里只落地了 2.2（中键关，`components/ui/surface-tab.tsx` 的 `handleAuxClick`）和 2.4（地址栏）。
其余七项在代码里**确实不存在**，不是「做了没接线」：

```bash
rg -n "ContextMenu|reorder|setAudioMuted|muted" src/renderer/features/environments/environment-tabstrip.tsx   # 无输出
rg -n "'tab\.(reorder|mute)'" src/main/rpc.ts                                                                # 无输出
```

`TabState.audible` 已经采集（`tabs.ts` 的 `media-started-playing` / `media-paused`），但没有静音通道；
`TabList.reorder()` 在审查轮里当死代码删掉了（`HANDOFF.md`「审查修复」②），要重加。

### 逐项方案

| # | 事项 | 方案 | 落点 |
|---|---|---|---|
| 2.1 | 标签右键菜单 | 重新加载（复用 `humanNavigate({kind:'reload'})`，人持权才可用）/ 复制链接 / 关闭 / 关闭其他 / 关闭右侧 | `environment-tabstrip.tsx`（`ContextMenu`，`collisionBoundary` 收在内容卡片内）、`rpc.ts` 新增 `tab.closeOthers` `tab.closeRight`、`domain/tabs.ts` 新增纯函数 `closeSet()` |
| 2.3 | 快捷键 | `browser-shortcuts.ts` 从「只认 ⌥⌘I/J」扩成联合类型：⌘T 新标签 / ⌘W 关标签 / ⌘1..9 选标签 / ⌘R 重载 / ⌘L 聚焦地址栏。**shell 窗口和每个标签的 webContents 都要拦**（页面持焦点时事件只到页面），都走已有的 `browser:shortcut` 通道，由 `App.tsx` 落到已有的 IPC 上 | `browser-shortcuts.ts`、`main.ts`、`tabs.ts`（已有 `before-input-event`）、`shared/types.ts`、`App.tsx`、`environment-stage.tsx` |
| 2.5 | 有声图标 + 静音 | `TabState` 加 `muted`；`Tab.setMuted()`；图标位按 静音 → 有声 → favicon 优先级显示，点一下切换 | `tabs.ts`、`rpc.ts` `tab.mute`、`types.ts`、`tabstrip`、`components/icons.tsx`（加 `Volume` / `VolumeOff`） |
| 2.6 | 拖拽排序 | `TabList.reorder(from,to)`（纯逻辑 + 单测）；`TabManager.reorder()` 只改顺序、**不动激活与挂载**；UI 在标签外套一层 `draggable` 包装节点（不往 `SurfaceTab` 里塞拖拽 props，那个文件镜像上游） | `domain/tabs.ts`、`tabs.ts`、`rpc.ts` `tab.reorder`、`tabstrip` |
| 2.7 | 新标签页 | 内置静态起始页，走新的 `warren://` scheme（和 `warren-plugin://` 同一处 `registerSchemesAsPrivileged`）。`+` 与 CLI 的默认 url 都指向它 | `main.ts`、`tabs.ts`/`environments.ts` 的默认 url |
| 2.8 | `beforeunload` 关闭确认 | **实测后决定不做**，见下 | 不实施 |
| 2.9 | HTML5 全屏 | **只实测**，见下 | 已测 |

#### 2.8 实测结论：Electron 默认不拦，**不做**关闭确认

用 `fixtures/capability/beforeunload.html`（有 `beforeunload` + `preventDefault`）实测两轮，
判据是新加的 `debug.layout.webContents`（活着的 webContents 数）：

| 场景 | 关标签前 | 关标签后 |
|---|---|---|
| 没给过用户手势 | 4 | **3** |
| 先 CDP 点过页面（`navigator.userActivation.hasBeenActive = true`） | 4 | **3** |

结论：`WebContentsView.close()` **不会被页面的 `beforeunload` 挡住**，也没有孤儿 webContents。
要 Chrome 那种「有未保存的改动就拦一下」得我们自己加 `will-prevent-unload` 监听 + 一个**同步**原生对话框，
而且标签表的摘除顺序要改成「先关、`destroyed` 到了才摘」（否则页面拒绝卸载时表里已经没这个标签了）。
代价是：agent 的 `tab close` 会卡在一个等人点的人机对话框后面。
**agent 优先的产品里这个交换不划算，所以不做**；默认行为（直接关）已实测，不是「坏了」。

#### 2.9 实测结论：全屏落在**页面视图内**，不是整个屏幕

`fixtures/capability/fullscreen.html` 实测：CDP 点「全屏」后 `document.fullscreenElement.id = "box"`，
盒子宽度 240 → **1358**，而 `debug.layout` 的 `viewport` / `viewBounds` 全程是 `{x:360,y:121,width:1358,height:954}`
（没变）。也就是说全屏被限制在页面视图里，侧栏 / 标题栏 / 遮罩都还在——**这是刻意的**：
真 Chrome 会占满整个屏幕，而我们的页面是嵌在窗口里的一个视图，占满屏幕会把遮罩和「谁在控制」的可见性一起吃掉。

### 验收

```bash
npx tsc --noEmit && npm test && node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
# 界面（应用 + fixture 都要起着，见 HANDOFF §6 运行时）
node bin/warren.mjs call debug.rendererEval '{"script":"document.querySelectorAll(\"[data-slot=surface-tab]\").length"}'
```

逐项要用 `debug.rendererEval` 读 DOM 证实（右键菜单只认 `data-open` 的 popup；拖拽用 `DataTransfer` 合成事件），
不靠肉眼。菜单项**每一项**都要有实测输出。

### 落地记录（2026-10-16，全部实测）

代码：`domain/tabs.ts`（`reorder` / `closeSet`）、`tabs.ts`（`setMuted` / `reorder` / `closeMany` / `NEW_TAB_URL`）、
`browser-shortcuts.ts`（联合类型 + `BROWSER_MENU_SHORTCUTS`）、`main.ts`（应用菜单 + IPC）、
`newtab.ts`（内置起始页）、`environment-tabstrip.tsx`、`environment-stage.tsx`、`App.tsx`、`icons.tsx`。

| 项 | 实测输出 |
|---|---|
| 静态门 | `npm test` **134/134**（新增 6 条：`closeSet` / `reorder` / `browserShortcut`）；`tsc` 干净；渲染层构建通过 |
| 全量回归 | `bash scripts/regress/run-all.sh` → **116 PASS / 1 FAIL**，唯一 FAIL 仍是 V5b（OOPIF 已知缺口）。基线是 117/1，差的那一条是**依赖手工环境数据**的检查：套件的 7.1 要求侧栏 ≥7 个环境、9.1 要求第一个环境是停止态（补上环境后 UI 套件 16/16 全过）。这两条依赖已写进 `run-all.sh` 的文件头 |
| 2.1 右键菜单 | 三项测试：菜单项 `["重新加载","复制链接","关闭","关闭其他","关闭右侧"]`；3 个标签点「关闭右侧」→ 1 个；点「关闭其他」→ 1 个；人没持权时文案变 `重新加载（需要先接管）` 且 `data-disabled=""` |
| 2.1 浮层让位 | 菜单打开 `viewVisible false` → 关掉 `true`（页面没被卸载，`showing` 一直是 `["blank"]`） |
| 2.3 快捷键 | `debug.shortcut` 逐条实测：`newTab` 1→2 个标签、`{selectTab:1}` 切回 1、`closeTab` 关掉、`reload` 记 `human reload on blank` + `标签 1 → …`、`focusAddress` 后 `activeElement` 的 `aria-label="地址栏"` 且全文选中 |
| 2.5 静音 | `tabMute(blank,1,true)` → 图标 `Globe → VolumeOff`，主进程状态 `muted=true`；取消 → 回到 `Globe`。点喇叭本身实测：标签数 5 → 5（不误关）、`muted` 翻转、`button button` = 0 |
| 2.6 拖拽排序 | 第 3 个拖到第 1 个：DOM 顺序 `[c,a,b]`，`warren tab list --json` 的 id 顺序一致；拖拽中源标签 `opacity-40`、落点标签 `shadow-[inset_2px_0_0_0_var(--theme-accent)]`，`dragend` 后都清掉 |
| 2.7 新标签页 | `+` 与 `env start`（没配 start-url）都落在 `warren://newtab/?env=<id>`；`snapshot` 读回标题 `新标签页`、AX 里有 `<h1>` = 环境名 |

**踩到的坑（新增两条）**

1. **`protocol.handle('warren', …)` 挂在默认 session 上没用**：页面跑在环境自己的 session 里，症状是
   `loadURL` 报 `ERR_FAILED (-2)`、标签一片空白（和 warren-plugin 那次不同，那条是渲染层在默认 session）。
   正解：在 `#sessionFor()` 里对**每个环境 session** 各挂一次。
2. **⌘R / ⌘W 不能靠 `before-input-event`**：macOS 上应用菜单的加速键先拿到按键（默认菜单的 `reload` /
   `close` 就是这两个键），拦不住就会重载整个应用界面 / 关掉整个窗口。所以这两个键连同 ⌘T / ⌘L 一起
   由「浏览器」菜单承载，⌘1..9（不在菜单里）仍走页面的 `before-input-event`。
3. **喇叭不能塞进 `SurfaceTab` 的 `icon` 槽**：标签可关闭时 `icon` 整个被包进关闭按钮里，
   再放一个 `<button>` 就是 button 套 button（实测 `querySelectorAll("button button").length === 1`）。
   虽然点它不会误关标签（内层 `stopPropagation` 生效），但结构无效、无障碍语义也乱。
   → `SurfaceTab` 加 `iconAction` 槽（和关闭键平级），喇叭放那里；改完实测 `button button` = 0。

**没做**

- CLI 没加 `tab mute` / `tab reorder` / `tab close --others`（RPC 有，界面用；这三条是人的手感，agent 用不到）。
- ⌘⇧T（重新打开刚关掉的标签）没做：要主进程维护「最近关闭」栈，另外单独排。

### 风险

- base-ui 的菜单三条坑（`Item` 用 `onClick`、`Label` 必须在 `Group` 里、`Trigger` 用 `render`）——踩了会白屏。
- 快捷键和 Electron 默认菜单加速键打架：必须 `before-input-event` 里 `preventDefault()`，且**两处**都要拦。
- 拖拽排序不能碰 `#showActive()`，否则每拖一次都重新挂视图（会闪）。

---

## B. 网络拦截补完（`docs/NET-INTERCEPT-PLAN.md` §4.3、§8）

### 现状（实测过的事实）

1. **挂了 `protocol.handle` 就跳过整个 session 的 CORS 检查**：未命中的跨源请求没带 ACAO 也读得到 body。
   现在靠「没有启用规则（也不在录 HAR）就不挂 handler」把偏差收窄到「规则开着的时候」。
2. `net passthrough <env> <url> [--for=30s]` 没做。

### 方案

| 项 | 方案 | 落点 |
|---|---|---|
| 临时放行 | 规则模型加 `expiresAt`（毫秒时间戳，纯函数 `pickRule` 跳过过期规则 + 一条定时器在过期时 `#sync()`）。CLI `warren net passthrough <env> <url> [--for=30s]` = 加一条 `mock?` 不——是**放行规则**：`action: {type:'passthrough'}` | `net/rules.ts`、`net/interceptor.ts`、`rpc.ts`、`bin/warren.mjs` |
| CORS 偏差 | 「只改头」改用 `webRequest.onBeforeSendHeaders` / `onHeadersReceived`（走正常网络栈，CORS 检查照旧），协议层只留 mock / block / redirect / delay。**收益是偏差归零，代价是改头规则不能再改 method/body**（webRequest 做不到） | `net/interceptor.ts` 拆成两个 handler |

**分两步**：先做「临时放行」（小、无行为回归），再评估 CORS 那步要不要做——它会改掉一条已经在 V16–V25 里验过的路径。

### 验收

```bash
bash scripts/regress/net-n1.sh ... net-n5.sh   # V16–V25 必须全绿
# 新增：passthrough 到期自动恢复拦截
node bin/warren.mjs net passthrough cap 'http://127.0.0.1:8899/cap/api/user' --for=5s
node bin/warren.mjs call browser.fetch '{"env":"cap","url":"http://127.0.0.1:8899/cap/api/user"}'  # 5s 内真数据
# 等 6s 再跑一次 → 回到 mock
```

### 风险

`#sync()` 的挂/摘条件要一起改（过期规则不算「有启用的规则」），否则过期之后 handler 还挂着，CORS 偏差就漏出去了。

### 落地记录（2026-10-16，`net passthrough` 部分）

代码：`net/rules.ts`（`isExpired` / `isActive` / `nextExpiry` / `PASSTHROUGH_PRIORITY` / `normalizeRule` 收 `expiresAt`）、
`net/interceptor.ts`（`#sync` 只看**还在生效**的规则 + `#scheduleExpiry` / `#dropExpired` + `passthrough` 动作）、
`environments.ts`（`netPassthrough`，时长在这里卡）、`rpc.ts`（`net.passthrough`）、
`bin/warren.mjs`（`net passthrough` + `parseDuration`）、`environment-inspector.tsx`（动作名 + 剩余秒数）。

用法：

```bash
warren net passthrough <env> <匹配串> [--for=30s] [--regex] [--method=GET]   # 写操作，要 lease
```

| 项 | 实测输出 |
|---|---|
| 压过别的规则 | 先 `--match='*/cap/api/user' --mock=…` → 命中 `{"source":"mock"}`；`net passthrough cap '*/cap/api/user' --for=5s` 之后同一请求返回 `{"source":"real"}`（优先级 1000000） |
| 到期自动摘掉 | 6 秒后 `net rules` 只剩 mock 那条；同一请求回到 `{"source":"mock"}`；事件 `临时放行到期，自动摘掉 9216d49c…（*/cap/api/user）` |
| 命中记录 | `net hits` 里能看到 `200 GET passthrough [9216d49c]`（这条口子被用过是看得见的） |
| **过期后 handler 真的摘了** | 无规则时跨源无 ACAO 请求 `CORS_ERR:Failed to fetch`；放行期间 `OK:200 acao=null`（偏差只在规则活着时存在）；**放行过期后又是 `CORS_ERR:Failed to fetch`** |
| 参数校验 | `--for=abc` / `--for=2h` → CLI 直接报错退出；`--for=0s` → `BAD_REQUEST: forMs 必须在 1000..3600000`；不带匹配串 → 打用法退出 |
| 单测 | `npm test` **138/138**（新增 4 条：过期规则不命中、只剩过期规则时不挂 handler、`nextExpiry`、`normalizeRule` 收/拒 `expiresAt`） |
| 回归 | `core.sh` **29/29**、`net-n1..n5` 除 V19 全 PASS（V19 要窗口在前台，见下）。**V19 与全量套件没能复跑**：这次实测期间 Warren 窗口拿不回焦点（`debug.focusWindow` 之后 `document.hasFocus()` 仍为 false），所有输入类检查都报 `WINDOW_NOT_FOCUSED`——那是既有的守卫在正确工作，不是本轮改动。同一天早些时候（批次 A 之后）跑过两次全量，V19 是 PASS |

### 结论：CORS 偏差那半步**先不做**

计划里写的方案是把「只改头」搬到 `webRequest`（走正常网络栈、CORS 检查照旧）。实测下来这条的收益/风险不划算：

- 现在的偏差已经被收窄到「**有规则活着的时候**」——上表的实测证明了过期即恢复。没有规则的环境和真浏览器一致（V18-RED 常年在跑）。
- 搬过去要拆掉一条已经在 V16–V25 验过的路径（`protocol.handle` 那一层），而且改头规则从此**不能改 method/body**，能力反而变窄。
- 真要彻底消掉，得先回答「mock / 阻断走协议层、改头走 webRequest」的分工——那是一次重构，不是补一条命令。

所以先留着偏差，把它写进 `net rules` 的可见面（规则表 + 剩余秒数）而不是藏起来。

---

## C. 稳定性（PRD M5）

### 现状

PRD §14 的 M5 五条里，**打包**已经能跑（`out/Warren-darwin-arm64`），其余四条没做：
环境数量无上限无 LRU、`manager.shutdown()` 只销毁 `WebContentsView`（不 kill Electron 辅助进程）、
没有 crash recovery、store 仍是 JSON（`store.ts`，SQLite 只在插件存储里用了）。

### 方案

| 项 | 方案 | 落点 |
|---|---|---|
| LRU 回收 | 加 `maxRunning`（默认 8，环境变量 `WARREN_MAX_RUNNING` 可覆盖）。`start()` 时若已满，按 `lastActiveAt` 升序停掉最久没用过的**非选中、非 agent 持权**环境，记一条 `env.evicted` 事件。UI 上被回收的环境回到「已停止」 | `environments.ts`、`domain/environment.ts`（挑受害者的纯函数 + 单测）、`types.ts` |
| 退出清理 | `before-quit` 里补 `app.quit()` 之后仍存活的辅助进程处理；`shutdown()` 逐个 `stop()` 而不是只销毁视图 | `environments.ts`、`main.ts` |
| crash recovery | 主进程写一个 `running.json`（运行中的环境 id + 上次选中）；下次 `whenReady` 时按它把环境重新拉起来（**不恢复 URL**——POST 过的页面恢复不了，且会和「启动 URL」打架） | `store.ts`、`main.ts`、`environments.ts` |
| SQLite | ~~先不做~~ → **2026-10-16 按用户要求做了全量迁移**：`store.ts` 换成 `warren.db`（environments / groups / events / running_state），老 JSON 一次性导入 + `.migrated` 留档。记录见 HANDOFF §6「稳定性」 | `store.ts` |

### 验收

```bash
# LRU：把上限设成 2，起三个环境，看第三个起来时第一个被回收
WARREN_MAX_RUNNING=2 npm start
node bin/warren.mjs env create a b c ...
node bin/warren.mjs env list          # a 应为 stopped，且 events 里有 env.evicted
# crash recovery：kill -9 主进程后重启，运行过的环境应自己回来
```

### 风险

LRU 回收正在被 agent 用的环境会直接打断 agent 的回合——所以「agent 持权」和「当前选中」必须是硬排除项。
crash recovery 自动拉起环境会真的加载页面（发网络请求），要么默认关、要么只在「上次是运行中」时恢复。

### 落地记录（2026-10-16）

代码：`domain/environment.ts`（`pickEvictions` 纯函数）、`environments.ts`（`#lastActive` / `#touch` / `#evictFor` /
`#rememberRunning` / `restoreRunning` / `debug.layout` 加 `running` + `maxRunning`）、
`store.ts`（`running.json` + **同步**写）、`main.ts`（启动末尾 `restoreRunningEnvironments()`）、`rpc.ts`（`debug.quit`）。

**LRU 回收**（`WARREN_MAX_RUNNING`，默认 8，`0` = 不限）：起新环境前按「最后一次被用到」回收。
“被用到”＝选中 / 取租约 / 任何 agent 操作（都经过 `controllerFor`）。

| 场景 | 实测输出 |
|---|---|
| 上限生效 | `WARREN_MAX_RUNNING=2` 启动 → `debug.layout` 的 `maxRunning: 2` |
| 超了回收最久没用的 | 跑着 a1、a2（a2 选中）→ 起 a3 → **a1 变 stopped**，`running` 仍是 2，事件 `a1 被 LRU 回收（同时运行上限 2）` |
| 选中的不动 | 跑着 a2、a3（a3 选中）→ 起 a4 → 回收的是 **a2**（a3 是选中的） |
| 持租约的不动 | 跑着 a1（选中）、a4（**agent 持租约**）→ 起 a2 → `running: 3 > maxRunning: 2`，两个都没被回收（宁可超限，也不动正在用的） |
| 单测 | `pickEvictions` 4 条：没超不回收 / 超了挑最久没用 / 选中的与持租约的排除 / `limit 0` = 不限 |

**崩溃恢复**（`WARREN_RESTORE=0` 关闭）：`running.json` 记「现在哪些在跑 + 上次选中」。
**正常退出会把它写成空的**（`shutdown()` 逐个 `stop()`），所以只有被杀死 / 崩掉才会恢复。

| 场景 | 实测输出 |
|---|---|
| 崩溃后恢复 | 跑着 a4、a1、a2（选中 a2）→ `pkill -9` 杀掉 → 重启 → 三个环境自己回来（`a3`、`cap` 仍是停止），事件 `崩溃恢复：拉起 a4、a1、a2` |
| 正常退出不恢复 | `debug.quit` 之后 `running.json` 变成 `{"running":[],"selected":"a2"}` → 再启动：**一个环境都没被拉起** |

**退出清理：实测本来就没问题，不改代码**

原来的「退出不 kill 辅助进程」这条**已经不成立了**——现在的 `shutdown()` 是逐个 `stop()`（连带销毁各标签的 webContents）。
实测（3 个环境运行时）：退出前这个应用有 **11 个进程**，`debug.quit` 之后 **0 个**，`electron-forge start` 也自己退了。
为了能测这条，新增 dev-only 的 **`debug.quit`**（没有别的办法从脚本触发 `before-quit`——⌘Q 要真按键）。

**SQLite 迁移：2026-10-16 按用户要求做了全量迁移**（原先的判断是「JSON + 原子写够用」，被用户推翻）。
细节见 HANDOFF §6「稳定性」：四张表 + 老 JSON 一次性导入 + `.migrated` 留档 + 事件落盘。

---

## D. sandbox 异步时限 + Cookie 受控通道

### 现状

- `node:vm` 的 `timeout` 只覆盖模块求值（`runtime.ts:184` 的 `runInContext`），**不覆盖插件异步执行**。
  `runtime: "host"` 的插件已经有独立进程兜底，sandbox 这条边界仍在。
- Cookie 管理插件做不了：`storage.cookie.*` 在 `denied` 层，前置条件是先设计「只搬运不返回」的受控通道。

### 方案

| 项 | 方案 |
|---|---|
| sandbox 异步时限 | 给 `command` / `rpc` 调用套 `Promise.race` + 可配置上限（默认 30s），超时报 `PLUGIN_TIMEOUT` 并记日志。**不是**强隔离（vm 里 `while(true)` 之外的 `await` 链仍占着主进程的事件循环），所以文档里继续写明「sandbox 不是安全边界」 |
| Cookie 受控通道 | 先写设计，再实现。形状参照 `vault.fill`：**只搬运不返回**——`cookie.import(env, {name,value,domain})`（写进环境 session）与 `cookie.exportNames(env, url)`（只回名字 + 域 + 过期，不回值）。明文只在主进程内部流动，插件侧永远拿不到值。设计文档落 `docs/PLUGIN-CAPABILITY-DESIGN.md` 新一节 |

### 验收

```bash
# 超时：装一个 await 60s 的插件命令，30s 后必须返回 PLUGIN_TIMEOUT 而不是挂死
# Cookie：设计先过一遍「有没有可能把值捞出来」——包括错误消息、日志、事件、RPC 返回值
```

### 风险

这是**安全边界**的改动（硬约束 5）。设计没写完不许写实现；`denied` 层的表在 `src/shared/permissions.ts`，**只有一处**。

### 落地记录（2026-10-16）

**设计先落**：`docs/PLUGIN-CAPABILITY-DESIGN.md` §9（威胁模型 / 四条通道 / 三条不能破的线 / 明确不做）。
实现完全照着那一节走——**通道形状和设计里写的一字不差**。

代码：`browser/cookies.ts`（`summarize` 显式字段白名单 + copy / import / clear）、
`environments.ts`（四个方法，Session 不外泄）、`plugins/api.ts`（`cookie.*` 四条，`storage.cookie.port` 门控）、
`shared/permissions.ts`（新权限 confirm 层；read / write 仍 denied）、`plugins/example-cookies/`（样例插件）、
`runtime.ts`（`Promise.race` 上限，sandbox + host 两处）、`bin/warren.mjs`（`plugin run --input`）。

| 项 | 实测输出 |
|---|---|
| sandbox 异步时限 | `WARREN_PLUGIN_TIMEOUT_MS=2000` 下 `plugin run com.example.hangs forever` → **2.04s** 报 `PLUGIN_TIMEOUT`（改前挂到 RPC 60s 超时）；`quick` 正常；插件日志有那条 ERROR |
| host 运行时 | `#invoke` 同一条上限，超时顺手摘掉 pending（不留下永远不 settle 的等待） |
| Cookie 元数据 | cap 里种 `warren_session` → `report` 回名字 / 域 / 路径 / secure / httpOnly / session，**没有 value** |
| Cookie 搬运 | `copyFrom --input='{"from":"cap"}'` → `{copied:1, names:["warren_session"]}`；目标环境的 `report` 里也有它 |
| 值有没有漏 | 整条流程（names / copy / report）`grep super-secret-value` = **0** |
| 清 | `clear` → `{removed:1}`，之后元数据为空 |
| 权限姿态 | 单测钉住：`storage.cookie.read` / `write` = denied，`storage.cookie.port` = confirm |
| 套件 | plugin.sh 加 16.1–16.5（Cookie 通道）与 17.1–17.2（异步时限，需要 `WARREN_PLUGIN_TIMEOUT_MS`，否则 SKIP） |

---

## E. 跨源 iframe（OOPIF）

### 现状（已实测，别重踩）

- 跨源 iframe 的 frame **不在主会话 `Page.getFrameTree` 里**，所以 AX 树、CSS、点击都够不到（同源 iframe 正常）。
- `Target.setAutoAttach` 在 Electron 44 **不崩**，能拿到本页 iframe 的 target，AX 也能因此看到跨源内容；
  **卡在坐标换算**（本地坐标 + owner 偏移算出来的点落在 iframe 外）。
- `Target.getTargets` 扫全浏览器是**错且危险**的路：`backendNodeId` 只在同一个 renderer 内唯一，
  拿去别的会话查会静默命中无关元素（实测点到 x=1445 的假坐标）。

### 方案（分三步，每步都要能独立验收）

1. **只读打通**：`Target.setAutoAttach({flatten:true, autoAttach:true})` + `Target.attachedToTarget` 建 per-OOPIF 会话，
   `snapshot` 把跨源 iframe 的 AX 子树**标出来**（带 `frameId` + 会话 id），先让 agent「看得见」。
2. **坐标换算**：用 `DOM.getBoxModel` 拿 iframe owner 元素在主会话里的矩形，加上 `Runtime.evaluate` 在子会话里
   拿元素矩形，两者相加。**必须用真页面实测点对位置**（点错位置比点不到更危险，见 HANDOFF 已知问题 9）。
3. **写动作**：`click` / `fill` 落到子会话。`ref` 表要能跨会话解析（`refs.ts` 的 key 加上会话维度）。

**卡在哪一步就停在哪一步**，不许把半截的坐标换算合进去。

### 验收

`scripts/regress/capability.sh` 的 V5b 从 FAIL 变 PASS；另外补一条「跨源 iframe 里点按钮，页面上出现预期结果」的实测。

### 风险

最高。改动落在 `browser/controller.ts` / `session.ts` / `snapshot.ts` / `refs.ts` / `actionability.ts`——
这几处是 agent 每天用的主路径，回归面最大。**单独一个批次，前后都跑全量回归。**

### 落地记录（2026-10-16，三步一次做完）

代码：`session.ts`（`ChildSession` + `Target.setAutoAttach` + `sendOn` + `clearChildSessions`）、
`ctx.ts`（`sendOn` / `childSessions` / `frameOf`）、`snapshot.ts`（`readAxFrames` 合并子会话 + `frameOfBackendId`）、
`page-helpers.ts`（`resolveTarget` / `frameOffsetFor` / `ownerIframeOf` / 会话化的 `nodeIdFor`·`evalOnNode`·`boxCenter`·`scrollIntoView` + `probePoint`）、
`actionability.ts`·`actions.ts`·`waits.ts`（全部带上会话）、`controller.ts`（导航开始清子会话）、
`rpc.ts`（dev-only `debug.point`）。

三步的验收：

1. **只读**：`snapshot({scope:'full_page'})` 里出现「内层按钮」，frame 数从 1 变 2（主 + OOPIF）。
2. **坐标**：`debug.point` 把「我们算的点」和「页面自己算的点」并排返回 → **delta = 0**
   （`{x:127.31, y:148.63}`）。这条诊断是必需的：坐标算错**不报错**，而输入类命令又要求窗口在前台，
   没它就没法在无焦点时验证。
3. **写动作**：`click text=内层按钮` 落在 `@127,149`，内层页面出现 `inner clicked`；
   `fill` / `focus` / `press` / `selectOption` / `setInputFiles` / `drag` 都走同一条会话解析。

**顺带补上的边界**：跨源 iframe 里弹的 alert（V5e）——`events()` 能看到、`acceptDialog()` 收得掉。
这条不做的话是一个**挂死**：dialog 开着时后续命令全排在它后面，agent 只会看到 RPC 超时。

**新增两条回归检查**：V5d（跨源读 + 点）、V5e（跨源 dialog）。capability.sh 从 15 项变 17 项。

**剩下的边界**（继承来的，不是这次的缺口）：`page.evaluate` / `fetch` / `cdp` 只在主会话；
`waitForFunction` 只看主 frame；CSS/XPath 选择器够不到跨源 iframe 内部（`text=` / `role=` / `@N` 可以）。

---

## F. 弹窗拦截（默认不做）

### 现状

无用户手势的 `window.open` 在真 Chrome 里会被拦，我们照样开标签。这是记录在案的偏离。
Electron 没有 popup blocker（源码 `ShouldDisablePopups()` 是全拦、不是 Chrome 语义）。

### 方案（要做的话）

只能自己包页面里的 `window.open`（改页面环境，检测面 +1），或者接受偏离。
`docs/TAB-MODULE-PLAN.md` §4 决策 2 已经定过：**默认关，排阶段 3**。

### 结论

**不做**。除非有人真的被它咬到。

---

## 执行纪律（每一批都适用）

## 收尾：全量回归（2026-10-16）

### 批次 G：按「价值 / 成本」挑的三件（2026-10-16）

### 批次 H：发布链路 / 遥测开销 / 文档校准 / 标签持久化（2026-10-16）

| 项 | 结果 |
|---|---|
| 发布链路 | **做了能做的**：`makers` 配齐（zip + dmg），实测 `npm run make` 出 `Warren-darwin-arm64-0.1.0.zip` 与 `Warren-0.1.0-arm64.dmg`（各 121MB，adhoc 未签名）；签名 + 公证**由环境变量门控**（三个齐了才启用，缺一个当没凭据）；补了 `appBundleId`（不给就是 Electron 默认 `com.github.Electron`）。**自动更新先不做**（没有发布源没法验），配方与验证步骤写在 `docs/RELEASE.md` |
| 遥测写库开销 | **量了，不用改**：500 个并发请求 → 504 次 INSERT 共 **37.23ms（0.074ms/条）**，页面自己 58ms 跑完——主进程不是瓶颈。`debug.layout` 留了 `telemetryWrite`；顺带守住「洪流不撑爆表」（browser.sh 23.2/23.3） |
| 文档校准 | **做了**：PRD §8 的 CLI 从「计划稿」改成**实现现状**（原来的 `env delete`/`env purge`/`env status`/`browser tabs`/`browser close-tab`/`browser cookies`/`plugin permissions` 全是**没实现**的）；顺带把缺的 `warren env update`（改名/换代理/换启动 URL）补上——RPC 早就有，只有 CLI 没暴露。新增 `docs/README.md` 当阅读入口。另：`npm install` 暴露出 `shadcn` 这个**没写进 package.json 的构建依赖**（干净 clone 构建本来就坏），补进 devDependencies |
| 标签持久化 | **做了**：`warren.db` 新增 `env_tabs`（位置 / URL / 激活位），标签一变就写（去重过）；`env start` 先把上次那组开回来，`env stop` 不清、`env remove` 连带删。实测：停再起 3 个标签连激活位一起回来；`kill -9` 后崩溃恢复也把标签带回来。core.sh 2.6/2.7 |

| 项 | 结果 |
|---|---|
| 插件安装的信任说明（硬约束 1 的合规缺口） | **做了**：插件面板顶部加了「插件是半可信代码，不是沙箱」+ 两种运行时的能力说明；徽章从「沙箱」改成「同进程」/「独立进程」。实测文案在、**UI 里再也搜不到「沙箱」** |
| 后台环境可被 agent 操作（spike → 实现） | **做得成**：CDP 和原生注入在后台环境**都被丢**（原生注入三次全失败），但把视图 `addChildView(view, 0)` 附到最底层之后页面自报 visible、**CDP 输入就能用**。输入类操作现在临时挂上、用完摘掉，并把焦点还给显示中的那个。实测：后台环境 click/fill/press 全生效，`showing` 不变、`attachedBelow` 用完为空、`focusedEnv` 仍是显示中的环境；浮层压着页面区域时**拒绝**（否则底层页面会从浮层下露出来）。browser.sh 22.3a/b/c |
| 回归套件自足化 | **做了**：`run-all.sh` 加前置检查（fixture / 应用 / **窗口焦点** / cap / 示例插件），套件自己造上传探针文件与 UI 要的环境；9.1 不再假设「第一行是停止态」。验证方式：把 cap、插件、探针文件**全删掉**再跑 → 133 PASS / 0 FAIL，跑完只剩 cap |

### 散装小项（2026-10-16）

| 项 | 结果 |
|---|---|
| `⌘⇧T` 重新打开关掉的标签 | **做了**：`TabManager` 维护最近关闭栈（深度 10），菜单加速键 `CmdOrCtrl+Shift+T`，RPC/IPC `tab.reopen`，CLI `tab reopen` + `page.reopenTab()`。core.sh 2.4b/2.4c 盯地址回得来 |
| `net passthrough` 去重 | **做了**：同一条匹配串只留最新那条（否则连点两次会堆两条同模式的口子，谁先到期看不懂）。net-n1.sh V26-1/2/3 |
| 元素高亮 | **做了**：`browser.highlight <env> [选择器]`（不传就清除）+ `page.highlight()`，`Overlay` 域终于接上；跨源元素走 `highlightRect`（子会话画不进主 frame 的 overlay）。V15 用 A/B/A 逐字节比对，DOM 节点数不变 |
| 右侧 secondary panel | **不做**：`DESKTOP-SHELL-MIGRATION.md` §8 已经定为非目标 |
| rail 窄窗 / 触屏 60px 档 | **不做**：那是触屏档（36+24=60），本应用没有触屏场景；窄窗断点也够不到（`minWidth: 1024`） |

**第一轮**（四批：标签 / 网络 / 稳定性 / store 迁 SQLite）——完整回归（Warren 窗口在前台、套件数据依赖满足）：

```
PASS 总数: 116
FAIL 总数: 1
FAIL V5b | #13 TARGET_NOT_FOUND: target not found: {"kind":"text","text":"内层按钮",...}
```

**第二轮**（架构统一 SQLite：vault / 插件注册表 / 插件 kv 与设置 / 插件日志 / 遥测全部收进 `warren.db`）
——同一套回归，同样 **116 PASS / 1 FAIL**（唯一 FAIL 仍是 V5b）。

唯一 FAIL 是 V5b（跨源 iframe / OOPIF）——文档里记录的已知缺口，这两轮都没碰 `src/main/browser/`。
G0 静态门：`tsc` 0 错、`npm test` **146 pass**、渲染层构建 ✓。

1. 改之前先 `rg` 一遍调用方；改完 `npx tsc --noEmit && npm test && vite build` 三条全过才算完。
2. 涉及主进程 / 运行时的改动必须**重启 + 实测**（HANDOFF 已知问题第 4 条的固定清理步骤，别省）。
3. 界面「对不对」用 `debug.rendererEval` 读 DOM，不靠像素猜。
4. 新逻辑（分支 / 循环 / 解析 / 权限）配一个单测；纯展示不配。
5. 完成一批就更新 `docs/HANDOFF.md` 的「当前状态」一节（项目变更记录要求的那些项）。
