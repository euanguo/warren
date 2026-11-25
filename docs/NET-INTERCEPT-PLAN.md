# 网络拦截通用能力（对标 Playwright route / mock / HAR）

> 定位：把「拦截并改写页面发出的请求」做成 Warren 的**通用内置能力**，不依赖 whistle 之类的第三方进程，
> 也不走 CDP Fetch 域。对标 Playwright 的 `page.route` / `routeFromHAR`，但入口不同（见 §2）。
> 前置实测见 §1，全部在 Electron 44.7.0 / Chromium 152 上跑过。
> 时间：2026-10-15，基线提交 `a743839`。

---

## 1. 前置实测（已跑，原始输出）

探针 `/tmp/proto-test.js`（独立 Electron 脚本，不动仓库代码），本地起 http 源站 + 每 session 注册 handler：

```
PROBE R8_register    {"ok":true}
PROBE R10_passthrough {"status":200,"real":true,"hits":1}
PROBE mock           {"status":200,"mocked":true}
PROBE R9_big         {"status":200,"bytes":5242880,"ok":true}
PROBE R9_stream      {"firstChunkMs":54,"firstChunk":"data: 0\n\n"}
PROBE R8_https       {"status":200,"len":577,"hasTitle":true}
```

| # | 问题 | 结论 |
|---|---|---|
| R8 | `ses.protocol.handle('http'/'https', handler)` 可用？ | ✅ 可用，且**是 per-session 的**（`Session.protocol`，`electron.d.ts:13728`），天然按 Environment 隔离 |
| R9 | 全量接管会不会破坏流式/大文件？ | ✅ 5MB 完整、SSE 首块 54ms，没有退化 |
| R10 | handler 里转发会不会递归拦自己？ | ✅ `net.fetch(req, { bypassCustomProtocolHandlers: true })` 只过一次 handler（`hits:1`）。**这个开关必须带** |
| R11 | 与既有遥测（`webRequest`）是否冲突？ | 未单独验；两者是同一网络栈的不同阶段，预计不冲突，接线后按 §5-V22 验 |

**结论：Electron 自己这一层就够做完整的 mock / 改写 / 阻断 / HAR，不需要 whistle，也不需要 CDP Fetch。**

---

## 2. 为什么不用那两条路

| 方案 | 为什么不选 |
|---|---|
| **CDP `Fetch` 域**（Playwright route 的做法） | 我们的 `browser.cdp` 白名单**故意禁掉 Network/Fetch**（遥测走原生事件、省检测面，见 `policy.ts`）。而且 CDP 拦截**人看不见**——规则只服务 agent，违反人机同视 |
| **依赖 whistle** | 把通用能力外包给外部进程：用户要装、要维护、要处理端口和生命周期。`docs/WHISTLE-PROXY-FEASIBILITY.md` 那条线**降级为兜底**（若将来发现协议层有硬伤） |
| **`ses.webRequest` 单独用** | 只能改 URL / 改头 / 阻断，**改不了响应体**——mock 做不了 |

**选：`ses.protocol.handle` 做唯一入口**，未命中规则直接 `net.fetch` 透传。规则模型只有一套，人也能在界面里看见和改。

---

## 3. 架构

```
页面请求 ──▶ ses.protocol.handle('http'/'https')   ← 每 Environment 一个 session
                    │
                    ├─ 规则引擎（纯函数，可单测）
                    │    命中 → 按 action 产出 Response（mock/改头/阻断/延迟/重定向）
                    │    未命中 → net.fetch(req, { bypassCustomProtocolHandlers: true }) 透传
                    │
                    └─ 命中记录 → telemetry（复用 network 环形缓冲）+ 脱敏
```

**落点**

| 文件 | 职责 |
|---|---|
| `src/main/net/rules.ts` | 纯函数：规则模型、URL 匹配、优先级挑选、action 决策（可单测） |
| `src/main/net/interceptor.ts` | 接线：注册 handler、透传、按规则产出 Response、记命中 |
| `src/main/environments.ts` | Environment 启动时建规则表 + 注册 handler；停止时 unhandle |
| `src/main/rpc.ts` | `net.*` 方法（写操作要 lease） |
| `bin/warren.mjs` | `warren net ...` 子命令 |
| `src/shared/types.ts` | `NetRule` / `NetAction` / `NetHit`（RPC 边界类型） |
| `src/renderer/features/...` | 「网络规则」面板 + 命中列表（人可见可改） |

**注册时机**：`ses.protocol.handle` 是 per-session 的，在 **Environment 的 session 建好之后、页面加载之前**注册即可（不像全局 `protocol.handle` 那样必须在建窗口前——那个坑见 AGENTS 已知问题 §10）。

---

## 4. 能力与约束

### 4.1 RPC / CLI

```
net rules <env>                                   # 列规则 + 命中数
net rule add <env> --match='*/api/user*' --mock='{"id":1}' [--status=200] [--method=GET]
net rule add <env> --match='*/track*' --block
net rule add <env> --match='*/old' --redirect=/new
net rule add <env> --match='*.js' --response-header='access-control-allow-origin=*'
net rule add <env> --match='*/slow' --delay=2000
net rule enable|disable|remove <env> <ruleId>
net hits <env> [--limit=50]                       # 命中记录
net record start|stop <env> [--output=a.har]      # 录 HAR
net replay <env> <a.har> [--offline]              # HAR 当规则源
net passthrough <env> <url> [--for=30s]           # 临时放行
```

### 4.2 规则模型

```ts
type NetAction =
  | { type: 'mock'; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { type: 'block' }
  | { type: 'redirect'; to: string }
  | { type: 'setRequestHeaders'; headers: Record<string, string> }
  | { type: 'setResponseHeaders'; headers: Record<string, string> }
  | { type: 'delay'; ms: number };

interface NetRule {
  id: string;
  enabled: boolean;
  priority?: number;                     // 大的先命中
  match: { url: string; isRegex?: boolean; method?: string };
  action: NetAction;
}
```

### 4.3 约束（不能破的线）

1. **改规则 = 写操作 → 要 lease**（它改变页面行为）。看规则 / 看命中是读。
2. **命中记录必须脱敏**：复用 `escape.ts` 的 `redactSecrets`，请求/响应体里的 token/cookie 一律 `[REDACTED]`。
3. **转发必须走 `net.fetch`（同 session）**，不能自己起 Node 请求——否则绕过代理和认证（硬约束 §4）。
4. **规则随 Environment 存亡**，不跨环境泄漏；环境删除即清。
5. **mock 不许自动填 vault 秘密**：要填必须显式走受控通道（形如 `vault.fill`）。
6. **人可见**：界面展示规则 + 命中数，人可改可关。这是相对 CDP Fetch 的核心优势。
7. **没有启用规则时不许挂 handler**：挂上 `protocol.handle` 会让**整个 session** 跳过 CORS 检查
   （不只是命中的请求，实测见 §7 N2）。规则全关 = 不挂 = 真浏览器。

---

## 5. 批次与验收（自循环：RED → GREEN → G0 → G1 → REGRESS）

### N1 · 规则引擎 + mock（不含 body 改写）

纯函数 + 单测先行（`tests/net-rules.test.ts`），再接 `webRequest` 起步（风险最低）。

- **V16** mock 一个 JSON 接口 → 页面拿到 mock 数据
- **V16-反例** 规则**关闭后必须走真实网络**（不能有残留）
- **V17** `--method` 过滤生效（GET 命中、POST 不命中）

### N2 · 切 `protocol.handle` 统一入口 + 响应体改写

依赖 §1 的 R8/R9（已验）。

- **V18** 改响应头加 CORS → 跨源请求成功
- **V18-反例** 未命中规则的请求头**原样**
- **V19** 阻断某资源 → 图片失败但页面仍可用（不能打断导航）
- **V20** 延迟规则 → 耗时 ≥ N
- **V21** 流式 / 下载 / 视频不退化（把 §1 的 R9 固化成验收）

### N3 · HAR 录制 / 回放

- **V22** 录 HAR → 回放 → 不发真实网络
- **V22-反例** 回放结束后必须恢复直连

### N4 · 界面「网络规则」面板 + 命中列表

- **V23** 面板能列出规则与命中数；人关掉一条规则后 agent 侧立即不生效

### N5 · 安全门

- **V24** 人持 lease 时 agent 改规则报 `ENV_BUSY`
- **V25** 命中记录里出现 `authorization` / `set-cookie` 时，遥测里是 `[REDACTED]`

**停止条件**：全部 V 通过 + 所有反例门通过 + G0 全绿（`tsc` / `npm test` 只增不减 / renderer build）+ 文档同步 HANDOFF。

---

## 6. 与 whistle 那条线的关系

**降级为兜底**：若将来发现协议层在某个真实场景有硬伤（比如某个站点的 TLS 指纹校验、或 Electron 升级后行为变化），whistle 是唯一现成的替代。
**默认不依赖它**——`docs/WHISTLE-PROXY-FEASIBILITY.md` 的定位要从「正路」改成「备选方案」。

---

## 7. 验收记录（自循环实测）

记录格式照 `docs/BROWSER-CAPABILITY-PORT-PLAN.md` §4：**RED（改之前，实测输出）→ GREEN → G0**。
没看到红的验收不算验收。

### N1 · 规则引擎 + mock / block / redirect / delay（2026-10-15）

**与计划的一处偏离**：计划里 N1 写「再接 `webRequest` 起步（风险最低）」，但 §1 的 R8/R9
已经把 `ses.protocol.handle` 实测通过了，所以**直接用它做唯一入口**，没写 webRequest 那一版
（少写一遍接线、少一次切换，也不会有「两套拦截器并存」的中间态）。

脚本：`bash /tmp/warren-net-n1.sh`（每项先 `debug.focusWindow`，再 `warren exec cap`）。
fixture 新增端点：`/cap/api/user`（真 JSON）、`/cap/api/headers`（回显请求头）、`/cap/pixel.png`。

**RED（改之前：旧实例，没有 `net.*` RPC）**

```
$ node bin/warren.mjs net rules cap
METHOD_NOT_FOUND: unknown method: net.rules
$ node bin/warren.mjs net rule add cap --match='*/cap/api/user' --mock='{"source":"mock"}'
METHOD_NOT_FOUND: unknown method: net.rule.add
```

**GREEN（实测输出）**

```
== V16-RED 前基线：没有规则时走真实网络 ==
PASS V16-baseline-real | real {"method":"GET","name":"真实用户","source":"real"}
== 加 mock 规则 ==
● 443a2d7c-9ce3-446a-a95e-885d6ca429f7 prio=0    *      */cap/api/user  → mock 200 application/json 31B
== V16 mock 命中 ==
PASS V16 | V16 ok {"name":"MOCK","source":"mock"}
== V16-反例：关闭规则后必须走真实网络 ==
PASS V16-反例 | V16-反例 ok 走真实网络 {"method":"GET","name":"真实用户","source":"real"}
== V17 method 过滤：GET 命中 / POST 不命中 ==
PASS V17 | V17 ok GET={"source":"mock-get"} POST={"method":"POST","name":"真实用户","source":"real"}
== 命中记录 ==
02:05:02  200  GET    mock               [5ea09bfa] http://localhost:8899/cap/api/user
02:05:02  200  GET    mock               [443a2d7c] http://localhost:8899/cap/api/user
```

**透传兜底（这次实现的核心要求，单独实测）**：`net.fetch` 抛异常时不能把异常抛回 Chromium
（session 已被全量接管，表现是页面白屏）。用「连接被拒」制造失败：

```
$ warren exec cap → fetch('http://127.0.0.1:9/x')
status:502 body:warren: 透传失败 net::ERR_UNSAFE_PORT
$ node bin/warren.mjs events cap | tail -3
02:05:42  system cap            GET http://127.0.0.1:9/x 透传失败：net::ERR_UNSAFE_PORT
$ node bin/warren.mjs net hits cap --limit=3
02:05:42  502  GET    passthrough        http://127.0.0.1:9/x  (透传失败：net::ERR_UNSAFE_PORT)
```

> 注意：`http://nonexistent.invalid/x` **不是**有效的失败探针——这台机器上 Clash 是系统代理，
> 它替上游返回 502，`net.fetch` 正常 resolve（实测 `status:502`，无事件）。要造失败得用连接被拒。

**G0**：`npx tsc --noEmit` 0 错；`npm test` **123 pass / 0 fail**（新增 4 条：头合并 / normalizeRule 信任边界 / 精确 URL 转义）；渲染层 build ✓。

### N2 · 改请求头 / 响应头 + 流式回归（2026-10-15）

脚本：`bash /tmp/warren-net-n2.sh`。新增动作 `setRequestHeaders` / `setResponseHeaders`，
CLI 加 `--request-header=k=v`（可重复）/ `--response-header=k=v`。

**RED（改之前）**

```
$ node bin/warren.mjs net rule add cap --match='*/cap/api/cors' --response-header='access-control-allow-origin=*'
BAD_REQUEST: 要给一个动作：--mock='{"id":1}' | --block | --redirect=/new | --delay=2000
$ warren exec cap → fetch('http://127.0.0.1:8899/cap/api/cors')   # 跨源，且规则加不上
CORS_ERR:Failed to fetch
```

**GREEN（实测输出）**

```
== V18 RED：一条规则都没有（handler 不挂）→ 跨源请求被 CORS 拦 ==
PASS V18-RED | CORS_ERR:Failed to fetch
== V18 ==
PASS V18 | V18 ok OK:200 acao=* body={"source":"real","co
== V18-反例：未命中规则的请求头 / 响应头必须原样 ==
PASS V18-反例 | 命中={"w":"1","p":"keep-me"} 未命中={"w":null,"p":"keep-me"}
== V19 block：图片失败但页面仍可用 ==
PASS V19 | 图片失败 {"complete":true,"w":0} 页面仍可用: alive clicked
== V20 delay：耗时 ≥ 800ms ==
PASS V20 | V20 ok 耗时 807ms
== V21 流式 / 大响应不退化（在 response-header 规则下，响应被重新包了一层）==
PASS V21 | 大响应 {"bytes":5242880,"ct":"application/octet-stream","header":"1"} 流式 {"chunks":6,"header":"1","ms":105}
```

> V21 是刻意在**规则命中**的情况下跑的：`setResponseHeaders` 会把上游响应包一层新 Response，
> 5MB 完整（5242880 字节）且 SSE 6 块 / 首块 105ms —— 说明包一层没有破坏流式。

**顺带修掉的 CLI 坑**：`parseFlags` 原来按 `split('=')` 取 `[key, inline]`，值里带 `=` 会被**截断**
（`--response-header='a=b'` 只拿到 `a`，实测报 `头要写成 k=v`）。改成只按第一个 `=` 切。

**⚠️ 保真度偏差（实测，必须记住）**：`protocol.handle` 一挂上，**整个 session 的响应都跳过 CORS 检查**
——不只是命中的那些请求。

```
# 挂 handler（任意一条启用规则）后，未命中的跨源请求：
未命中请求（handler 已挂）: OK:200 acao=null      # 页面读得到 body
# 没挂 handler：
CORS_ERR:Failed to fetch
```

应对：**没有启用规则时不挂 handler**（`#sync` 只由「有没有启用的规则」决定），
所以「不开规则的环境 = 真浏览器」。规则开着的时候这条偏差仍然存在，记录在此，
将来要消掉它得把「只改头」的动作用 `webRequest` 做（走正常网络栈），而不是协议层。

**G0**：`npx tsc --noEmit` 0 错；`npm test` **122 pass / 0 fail**（删掉 1 条 `mergeHeaders` 用例——
改用平台自带的 `Headers` 做大小写不敏感的覆盖，不再自己写合并）；渲染层 build ✓。

### N3 · HAR 录制 / 回放（2026-10-15）

脚本：`bash /tmp/warren-net-n3.sh`。新增 `src/main/net/har.ts`（纯函数，可单测）+
`warren net record start|stop <env> [--output=…]`、`warren net replay start <env> <file.har> [--offline] | stop`。

**验收设计**：fixture 新增 `/cap/api/counter`，每次请求返回**自增的 n**——它是自证式的：
「n 没涨」= 真的没走真实网络。

**RED（改之前：N2 构建的实例）**

```
$ node bin/warren.mjs net record start cap
METHOD_NOT_FOUND: unknown method: net.record
$ node bin/warren.mjs net replay start cap /tmp/x.har
METHOD_NOT_FOUND: unknown method: net.replay
```

**GREEN（实测输出）**

```
== 1. 录 HAR ==
  录制期间 counter: 9 → 10
  "entries": 3, "path": "/tmp/warren-cap.har"
  HAR entries=3 带响应体=3
  urls=["/cap/net.html","/cap/api/counter","/cap/api/counter"]
== V22 回放：同一请求不再走真实网络（counter 不涨）==
  回放两次拿到: 9 9; 录制时是 9 10
PASS V22 | 回放内容来自 HAR，未走真实网络
== V22-反例：停止回放后必须恢复直连（counter 继续涨）==
  停止回放后 counter=11, 期望=11
PASS V22-反例 | 恢复直连，counter 继续涨
== V22b offline：没录到的请求也不放行 ==
  已录 / 未录: mock:200 / passed:403
PASS V22b | 已录走 mock、未录被拦
```

> 回放两次都拿到 `9`（第一条录到的响应）而不是 `9 / 10`：同一 (method,url) 只回放第一条，
> 这是刻意的（`har.ts` 里有 `shortcut:` 注释）。**关键是真实服务器没被碰到**——
> 若回放漏了，两次会拿到 `10 / 11`（那正是停止回放后拿到的 `11`）。

**两个实现细节（踩到的）**

1. **录制也要挂 handler**：`#sync()` 原来只看「有没有启用的规则」，而录制时通常一条规则都没有
   → handler 摘着 → 录到 0 条（实测第一轮 `entries=0`，回放报「HAR 里没有可回放的响应体」）。
   改成 `#recording || 有启用规则` 才挂。
2. **HAR 不写头**：`cookie` / `authorization` 落盘就是新的泄漏面，而回放只需要响应体。
   `har.ts` 的 request/response `headers` 恒为 `[]`，单测钉死这一点。

**G0**：`npx tsc --noEmit` 0 错；`npm test` **127 pass / 0 fail**（新增 5 条 HAR 用例：
往返 / 无 body 跳过 / offline 兜底 / 坏 HAR / 不写头）；渲染层 build ✓。

### N4 · 界面「规则」页（2026-10-15）

脚本：`bash /tmp/warren-net-n4.sh`。检查器多一个「规则」页（事件 / 快照 / 控制台 / 网络 / 规则）：
规则行 = 开关 + 匹配串 + 动作 + 该规则的命中数，下面是命中记录。

**RED（改之前：N3 构建的实例，preload 里没有这条通道）**

```
$ warren call debug.rendererEval → window.envApi.netRules('cap')
ERR: Error invoking remote method 'net:rules': Error: No handler registered for 'net:rules'
```

> 注：渲染层是 Vite dev server 供的，改完会热更，所以「规则」标签当时已经出现，
> 但**数据通道**（preload + 主进程 IPC）没有 → 页面拿不到任何规则。这也说明红是红在通道上。

**GREEN（实测输出）**

```
== V23-1 面板能列出规则与命中数 ==
  规则行: ["*/cap/api/usermock 2008ad4dfe4 · * · 命中 0"]
PASS V23-1 | 面板列出了规则 / 动作 / 命中数
== V23-2 人在界面上关掉规则（点开关）==
switch true → 已点击
  agent 侧读到 enabled=false
PASS V23-2 | 人关掉后 agent 侧立刻看到 disabled
== V23-3 关掉之后 agent 侧立即不生效（走真实网络）==
  走真实网络 {"method":"GET","name":"真实用户","source":"real"}
PASS V23-3
== V23-4 界面改规则也是写操作：agent 持权时必须被拒 ==
  ERR: ... Error: ENV_BUSY: agent 正在控制该环境，等它交还后再改网络规则
PASS V23-4 | agent 持权时界面改规则被拒
```

命中数是真的（补测一次命中后的面板行）：`["*/cap/api/usermock 200ff84ed7f · * · 命中 1"]`，
与 `warren net hits cap` 的 `[ff84ed7f] 200 GET mock http://localhost:8899/cap/api/user` 对得上。

**写门控怎么分层的**：agent 走 RPC（`assertWritable`，要 lease）；人走 IPC（`humanNetWrite`：
**agent 持权时拒绝**，否则放行——人在自己机器上改自己的规则不需要先「接管」，
但不能和正在跑的 agent 抢）。读（规则 / 命中）两边都不设门。

**G0**：`npx tsc --noEmit` 0 错；`npm test` **127 pass / 0 fail**；渲染层 build ✓。

### N5 · 安全门（2026-10-15）

脚本：`bash /tmp/warren-net-n5.sh`。

**RED（脱敏这一条真的缺）**：共享的 `redactSecrets` 词表里有 `cookie` 但**没有 `authorization`**，
直接用它落命中记录会把 bearer token 原样写进去：

```
$ node -e 'import("./src/main/browser/escape.ts")… redactSecrets({authorization:"Bearer super-secret-token","set-cookie":"warren_session=super-secret-value"})'
共享 redactSecrets 的输出: {"authorization":"Bearer super-secret-token","set-cookie":"[REDACTED]"}
                                                                 ^^^ 原样泄露
```

修法是 `interceptor.ts` 的 `redactHeaders`：先走共享 `redactSecrets`，再补一道
`authorization` / `proxy-authorization`（**不在 `browser/` 里改词表**——那是另一条线的成果）。

**GREEN（实测输出）**

```
== V24 人持 lease 时 agent 改规则必须 ENV_BUSY ==
● cap  …  [human]
  net rule add → ENV_BUSY: environment cap is controlled by human
PASS V24 | 人持权时 agent 改规则被拒
  net record start → ENV_BUSY: environment cap is controlled by human
PASS V24b | 人持权时 agent 录 HAR 也被拒
  裸 RPC net.rule.add（无 lease）→ ENV_NOT_LEASED: environment cap is not leased
PASS V24c | 不带 lease 的裸 RPC 被拒
== V25 命中记录里的 authorization / set-cookie 必须是 [REDACTED] ==
服务器收到 authorization=Bearer super-secret-token      ← 页面确实发出去了
  命中记录: status=200 action=setResponseHeaders
  requestHeaders.authorization = "[REDACTED]"
  responseHeaders[set-cookie]  = "[REDACTED]"
  原始秘密是否出现在输出里: token=false value=false
PASS V25 | authorization/set-cookie 已脱敏，且原始秘密不在输出里
```

**G0**：`npx tsc --noEmit` 0 错；`npm test` **127 pass / 0 fail**；渲染层 build ✓。

---

## 8. 验收总表（V16–V25，全部实测）

| # | 验收 | 结果 | 证据（§7 各批次） |
|---|---|---|---|
| V16 | mock 一个 JSON 接口 → 页面拿到 mock 数据 | **PASS** | N1：`{"name":"MOCK","source":"mock"}` |
| V16-反例 | 规则关闭后必须走真实网络 | **PASS** | N1：disable 后 `{"source":"real"}`；N4：人点开关后同样走真实网络 |
| V17 | `--method` 过滤（GET 命中 / POST 不命中） | **PASS** | N1：`GET={"source":"mock-get"} POST={"source":"real"}` |
| V18 | 改响应头加 CORS → 跨源请求成功 | **PASS** | N2：无规则 `CORS_ERR:Failed to fetch` → 加规则后 `OK:200 acao=*` |
| V18-反例 | 未命中规则的请求头原样 | **PASS** | N2：命中改头 / 未命中 `x-probe: keep-me` 保留且无 `x-warren` |
| V19 | 阻断某资源 → 图片失败但页面仍可用 | **PASS** | N2：`{complete:true,w:0}` + 按钮点击 `alive clicked` |
| V20 | 延迟规则 → 耗时 ≥ N | **PASS** | N2：`--delay=800` → 实测 807ms |
| V21 | 流式 / 大响应不退化 | **PASS** | N2：5MB（5242880 字节）+ SSE 6 块 / 首块 105ms，**且是在响应头规则命中下跑的** |
| V22 | 录 HAR → 回放 → 不发真实网络 | **PASS** | N3：counter 9→10，回放两次都是 9 |
| V22-反例 | 回放结束后恢复直连 | **PASS** | N3：`replay stop` 后 counter=11 |
| V23 | 面板列出规则与命中数；人关掉后 agent 侧立即不生效 | **PASS** | N4：面板行 + `enabled=false` + 走真实网络 |
| V24 | 人持 lease 时 agent 改规则报 `ENV_BUSY` | **PASS** | N5：`ENV_BUSY` / `ENV_NOT_LEASED` |
| V25 | 命中记录里 `authorization` / `set-cookie` 是 `[REDACTED]` | **PASS** | N5：两条都是 `[REDACTED]`，原始秘密不在输出里 |

**额外实测（计划外，但都属于「不能破的线」）**

| 项 | 结果 |
|---|---|
| 透传兜底（`net.fetch` 抛异常） | **PASS**：`fetch('http://127.0.0.1:9/x')` → `502 warren: 透传失败 net::ERR_UNSAFE_PORT` + 事件 + 命中记录，**不是页面白屏** |
| V22b offline | **PASS**：已录 `mock:200` / 未录 `passed:403` |
| V23-4 界面写门控 | **PASS**：agent 持权时界面改规则被拒（`ENV_BUSY`） |
| 未做 | `net passthrough <env> <url> [--for=30s]`（计划 §4.1 里的临时放行）：要引入带过期的规则，V16–V25 都不需要它，**没做** |

### REGRESS（收尾，2026-10-15 全量重跑）

按协议最后一步：清环境（`pkill` + 杀 5173/8899 + 删 `~/.warren/envd.sock|runtime.json` + 确认进程数 0）
→ 重启 `npm start` 与 `node scripts/serve-fixture.mjs 8899` → 依次重跑五个脚本。

**全部 PASS，无回归**（fixture 的 counter 从 1 重新开始，正好又证了一遍「回放不发真实网络」）：

```
########## n1 ##########   V16-baseline-real / V16 / V16-反例 / V17 → PASS
########## n2 ##########   V18-RED / V18 / V18-反例 / V19 / V20(808ms) / V21(5242880B, SSE 6 块 105ms) → PASS
########## n3 ##########   录制 1→2 / V22(回放拿到 1 1) / V22-反例(counter=3) / V22b → PASS
########## n4 ##########   V23-1 / V23-2 / V23-3 / V23-4 → PASS
########## n5 ##########   V24 / V24b / V24c / V25 → PASS
```

脚本落在 `/tmp/warren-net-n1.sh` … `n5.sh`（和上一轮 `/tmp/warren-all.sh` 同一个约定：不进仓库，
命令本身在本文档里都写全了，可照着重建）。
