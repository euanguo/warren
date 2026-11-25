# Whistle 代理插件：施工图

> 状态：**已实现**（W1–W4 全部完成，验收记录见 §8）
> 日期：2026-10-18
> 前置阅读：`docs/WHISTLE-PROXY-FEASIBILITY.md`（whistle 可行性调研，结论「必须核心托管」）、
> `docs/NET-INTERCEPT-PLAN.md`（内置拦截器，与本插件的关系见 §3.5）、
> `docs/PLUGIN-CAPABILITY-DESIGN.md`（插件机制与 host 运行时）
>
> **这份文档推翻了 `WHISTLE-PROXY-FEASIBILITY.md` §6 的一个结论**：那份文档写「主体必须在核心，
> 插件只能当薄壳」，前提是「插件起不了进程、发不了 HTTP」。**host 运行时（`utilityProcess.fork`）
> 落地后这个前提不成立了** —— 插件现在有 `child_process` 和 `fetch`。所以实例托管搬进插件，
> 核心只补两个它做不了的口子（§4）。那份文档的 §4/§6.1/§7（whistle 能力与 CA 验签写法）**仍然有效**。

---

## 1. 需求（用户的真实场景）

一个人同时在多个 worktree 上开发，**每个 worktree 起在不同端口**。他访问的是**同一个线上地址**
（例如 `app.example.com`），希望把静态资源/接口**导向当前 worktree 的本地端口**，从而在真实线上页面里
调试自己正在写的那份代码。多个 worktree = 多份规则 = 需要多个互不干扰的代理实例。

拆成三条可验收的需求：

1. **快速 fork 新实例** —— 不用手敲 `w2 start -S x -p 8801`。
2. **把规则搬进我们自己的面板** —— 看规则列表、开关、编辑，不用切到 whistle 的 Web UI。
3. **快速访问当前环境绑定的实例** —— 环境右键菜单一键打开它，或定位到面板里那一行。

## 2. whistle 侧调研结论（本轮实测，2.9.99 本机版）

全部在 `WHISTLE_PATH=/tmp/wh-data HOME=/tmp/wh-home` 下起真实例跑过，实例已清理。

| 项 | 实测 |
|---|---|
| 启动 / 隔离 | `w2 start -S <storage> -p <port>`；**守护进程化**（父进程退出后实例照跑，实测 pid 96895 存活）；数据按 `-S` 隔离到 `<WHISTLE_PATH>/.whistle/custom_dirs/<storage>/{rules,values,properties}` |
| 实例注册表 | `<HOME>/.startingAppData/#<storage>#`，JSON `{pid, options:{storage,port}}`。`w2 status --all` 靠 `ps` 判存活，**不可靠**（本机沙箱里查不到活着的实例） |
| 健康探测 | `GET /cgi-bin/status` → `{"storage":"probe","name":"whistle","version":"2.9.99"}` ← `storage` 就是实例身份 |
| 读规则 | `GET /cgi-bin/rules/list` → `{"ec":0,"list":[{index,name,data,selected}]}`；`/cgi-bin/rules/list2` → `{name: data}` |
| 写规则 | `POST /cgi-bin/rules/project`（`name`/`rules`/`groupName`）→ `{"ec":0}` |
| 开关规则 | `POST /cgi-bin/rules/select`、`/unselect`（`name`）→ `{ec:0, list:[选中项]}` |
| 删规则 | `POST /cgi-bin/rules/remove` |
| HTTPS 解密 | **默认不解密**；`POST /cgi-bin/intercept-https-connects` `interceptHttpsConnects=1` → `{"ec":0}` |
| 多规则组 | **默认单选**；`POST /cgi-bin/rules/allow-multiple-choice` `allowMultipleChoice=1` → 回读 `rules/list` 的 `allowMultipleChoice:true` |
| 根证书 | `GET /cgi-bin/rootca?type=pem` → PEM 全文；磁盘上 `<WHISTLE_PATH>/.whistle/certs/root.crt` |
| Web UI | **直接访问端口就有**：`GET http://127.0.0.1:8802/` → 200 `text/html`，`<title>Whistle Web Debugging Proxy</title>`（不必走 `local.whistlejs.com`） |
| 鉴权 | 以上全部本地 curl 直通，无 token |

**规则语义（用户场景的核心，实测）**：

```
$ curl -s -x http://127.0.0.1:8801 http://prod.example.com/static/app.js
（拿到的是本机 5173 上 Vite 的响应）
$ curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8801 http://prod.example.com/other/x.js
502                       ← 未命中规则 = 走真实网络
```

两个要点：

1. **路径原样保留** —— `prod.example.com/static/ 127.0.0.1:5199` 打到本地仍然是 `/static/app.js`；
   要去掉前缀得再加 `urlReplace://static=`。
2. **HTTPS 必须解密** —— 不解密时 whistle 只看到 `CONNECT prod.example.com:443`，**看不到路径**，
   规则无从匹配。所以 CA 信任是这条链路的前置条件，不是可选项。

规则模板（写进实例的 `dev` 规则文件）：

```txt
app.example.com/static/ 127.0.0.1:5199      # 静态资源 → 这个 worktree 的 dev server
app.example.com/assets/ 127.0.0.1:5199
app.example.com/api/    127.0.0.1:3001      # 接口也导本地（可选）
app.example.com/        127.0.0.1:5199 excludeFilter:///api/   # 整站导本地但排除接口
```

## 3. 架构决定

### 3.1 实例由**插件**托管（`runtime: "host"`）

理由：whistle 自己守护化，**插件禁用/卸载后实例照跑**；核心不必知道 whistle 存在。
这也是 `PLUGIN-CAPABILITY-DESIGN.md` §6 P2 里写的第一个真实用例。

插件侧用 `child_process.spawn('w2', ['start','-S',storage,'-p',port])`，跟用户手敲一条命令等价，
出问题时好排查。**不 require whistle 当库**：`index.js` 会全局打补丁 `net.Socket.prototype.connect`
和 `tls.checkServerIdentity`（见可行性文档 §4.8），那会污染整个 Electron 主进程。

### 3.2 环境绑定 = `env.proxy` 指向实例端口

`EnvironmentConfig.proxy` 已经存在，`start()` 里已经 `ses.setProxy({proxyRules})`。
但**插件写不了环境配置**（host API 只有 `environment.list/get`）→ 核心加一个 host API（§4.1）。

`env.proxy` 只在 `start()` 时生效，所以**绑定后必须重启环境**才生效 —— 插件在 `bind` 里顺手做。

### 3.3 CA 信任由**核心按环境**装，不用系统钥匙串

两条路：

| 路 | 做法 | 评价 |
|---|---|---|
| A | `w2 ca` 把根证书装进 macOS 钥匙串 | whistle 的标准做法、零核心改动，但**整机放行**：用户的日常 Chrome 也会一起被中间人 |
| B | 核心对绑定的那个 Session 装 `setCertificateVerifyProc` | 只影响那一个环境，符合「每个洞一个独立出入口」的产品定位 |

**选 B。** 核心只认「一个 PEM 路径」（`EnvironmentConfig.trustedCa`），
**不需要知道 whistle 是什么**；插件负责把该实例的 `GET /cgi-bin/rootca?type=pem` 落到环境目录。

验签写法必须是 `X509Certificate.verify(ca.publicKey)`，**不能比较 issuer**：
`request.certificate.issuerCert.data` 在 Electron 里是空的（实测，见可行性文档 §6.1）。

### 3.4 面板形态：规则自己渲染，抓包跳系统浏览器

- **规则列表自己渲染**（可开关、可编辑）—— 走我们的组件库，符合设计契约。
- **whistle 的 Web UI / 抓包界面不嵌 iframe**：要放宽 CSP `frame-src`（现在是 `default-src 'self'`），
  而且它自带另一套视觉，混进自家面板会破 token/recipe 的一致性。
  改成「打开」按钮 `window.open('http://127.0.0.1:<port>')` —— 主进程的 `setWindowOpenHandler`
  已经把 http/https 交给 `shell.openExternal`（`main.ts:129`），**零核心改动**。

### 3.5 与内置网络拦截器（`net`）的关系

两条线都能拦请求，但机制不同：`net` 走 `ses.protocol.handle`（Chromium 协议层，**抢在代理之前**），
whistle 走 Session 代理。**同一个环境不要同时开 `net` 规则和 whistle 绑定** —— 谁先接管没实测过，
是已知风险（§7）。默认用 whistle 时不要给该环境加 `net` 规则。

## 4. 核心改动（3 处，都很小）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/shared/permissions.ts`、`src/main/plugins/api.ts` | 新增权限 `environment.write`（**confirm** 层）+ 三个 host API：`environment.update` / `environment.start` / `environment.stop` |
| 2 | `src/shared/types.ts`、`src/main/db.ts`、`src/main/store.ts`、`src/main/domain/environment.ts` | `EnvironmentConfig.trustedCa?: string`（PEM 路径）。`environments` 表加列，**要一条 `ALTER TABLE ADD COLUMN` 迁移** |
| 3 | `src/main/domain/trusted-ca.ts`（新）、`src/main/environments.ts` | 纯函数 `leafSignedByCa(leafPem, caPem)` + `start()` 里装 `setCertificateVerifyProc` |

顺带两处小的：

- `src/main/plugins/host.ts`：`run()` 不再**强制**要求 `environmentId` —— `fork` / `list` 这类命令
  本来就和环境无关，逼调用方编一个环境是假的。真需要环境的能力仍然会报 `PLUGIN_NO_ENVIRONMENT`。
- `bin/warren.mjs`：`env update` 加 `--trusted-ca=<path|none>`，否则 CLI 看不见这个新字段。

`trustedCa` 缺失 / 文件读不出来时：**不装钩子 + 记一条事件**，不静默放行。

## 5. 插件设计

```
plugins/whistle/
  package.json       npm 包 + package.json#warren，runtime: host，host: host.mjs，app: app.js
  host.mjs           实例生命周期 + whistle HTTP API + 环境绑定（跑在独立 Node 进程）
  app.js             前端：实例表 + 规则编辑（宿主注入 React）
```

| 项 | 值 |
|---|---|
| id | `com.warren.whistle` |
| 权限 | `environment.read`、`environment.write`、`ui.mount`、`storage.write`、`rpc.serve` |
| 命令 | `list` / `fork` / `stop` / `remove` / `bind` / `open`（agent 走 `warren plugin run <id> <cmd> [--env=…]`，`--env` 可选） |
| rpc | `list` / `fork` / `stop` / `remove` / `rules` / `ruleSet` / `ruleToggle` / `ruleRemove` / `bind` / `unbind` |
| 面 | `railPage`「代理」、`envAction`「打开代理面板」、`settingsSection`「Whistle」 |
| 设置 | `w2Path`（可执行文件路径）、`portBase`（端口起始，默认 8900）、`whistlePath`（`WHISTLE_PATH`，空 = 用 whistle 默认） |
| 存储 | kv `instances` = `[{storage, port, hostPattern, targetPort, createdAt}]` |

**每个实例启动时自动打开 `allowMultipleChoice`**：一个环境常常要同时选中测试后端、本地资源和预设等多个规则组；
Whistle 默认单选，后选的组会把先选的顶掉。`fork` 启动后、`bind` / `ruleSet` / `ruleToggle` 前都会确保该开关为
`true` 并回读 `rules/list` 验证。插件重新激活时也会补开已存活实例的开关。

**实例身份不读 whistle 的私有注册表**：存活一律靠探 `GET /cgi-bin/status` 并比对 `storage`。
停实例走 `w2 stop -S <storage>`（whistle 自己的 CLI），再轮询确认端口真的没了。
Local Agent API 调用同样先按该 live `status.storage` 校验实例，再把已验证的 pid 传给隔离
adapter；`.startingAppData` 只作为 pid 元数据来源，不能反过来充当存活或实例身份判据。

**`w2` 路径解析**：默认使用插件依赖里的 `node_modules/whistle/bin/whistle.js`，
通过 `process.execPath + ELECTRON_RUN_AS_NODE=1` 启动；设置里的 `w2Path` 非空时才改用外部 fork。
外部路径同样支持 `PATH` 与常见位置。

**端口分配**：从 `portBase` 起，逐个 `net.createServer().listen()` 试，拿第一个能绑上的（避开 8899，
它和 `scripts/serve-fixture.mjs` 的默认端口撞）。

## 6. 分期

### W1 核心（本计划 §4）

- 验收：`leafSignedByCa` 的单测（真签发的叶子证书通过 / 自签的另一张不通过 / 坏 PEM 不抛）；
  新 host API 在 `tests/plugin-runtime.test.ts` 里覆盖「没权限就拒」；`npm test` 只增不减。

### W2 插件骨架

- `package.json#warren` + `host.mjs` 的实例生命周期（fork / stop / list / 健康探测）+ rail 页实例表。
- 验收：面板能新建实例 → 表格出现且「运行中」；`w2 status`/`/cgi-bin/status` 能对上；停掉后变「已停止」。

### W3 规则与环境绑定

- 规则读写/开关/删除 + `bind`（写 proxy + 落 CA 到 `<env.storagePath>/trusted-ca.pem` + 重启环境）
  + `envAction` 快速访问。
- 验收：绑定后环境重启，`env.get` 里 `proxy` 与 `trustedCa` 都变了；
  在环境里打开线上地址，静态资源真的来自本地端口（页面内容自证）。

### W4 走查与回归

- 五道静态门 + `bash scripts/regress/run-all.sh` + 实机全流程。
- 同步 `docs/HANDOFF.md`（数据模型 / 权限分层 / 新 host API / 目录结构）。

## 7. 风险

1. **内存**：每实例约 55MB（本机 2.9.99 实测两个 node 进程），环境数线性涨。
2. **`net` 与 whistle 同时开**：谁先接管未实测，默认不混用（§3.5）。
3. **MITM 是真实的安全边界变化**：面板文案必须说清用途（调试自己的站点），不能像「随便抓别人的包」。
4. **whistle 的 CLI 契约**（`-S` / `-p`）不是官方文档承诺的，升级可能变。
5. **CA 放宽只对绑定环境生效**，且只放行验签通过的叶子证书 —— 这条不能省。
6. **证书校验结果被 Chromium 的网络服务按域名缓存（实测，见 §8 W4-3）**：
   同一个应用生命周期内，一个域名**先**报过 `ERR_CERT_AUTHORITY_INVALID`，之后即使把
   `trustedCa` 装上、环境重启、标签 reload，那个域名仍然失败；**换个没访问过的域名立刻就好**，
   **重启应用也立刻就好**（缓存在内存里）。
   影响：只有「先访问过、再绑定代理」这条顺序会踩到；正常流程（建环境时就带 proxy + CA）不受影响。
   应对：每个 tab 的 webContents 上再挂一层同一张 CA 的 `certificate-error` 验签兜底。
   实测新 webContents 能绕过该缓存，`bind` 后 stop/start 即可恢复；不需要销毁 Session，
   也不扩大放行范围。

## 8. 验收记录

全部在 macOS / Electron 44.7.0 / whistle 2.9.99 上实机跑过，2026-10-18。

### W1 核心

```
$ npm run lint        → 0 警告（oxlint --deny-warnings）
$ npm run format:check→ All matched files use Prettier code style
$ npx tsc --noEmit    → 0 错
$ npm test            → tests 213 / pass 213 / fail 0   （基线 208，新增 5：trusted-ca 4 条 + host API 1 条）
$ 迁移：sqlite3 warren.db "PRAGMA table_info(environments)"
  ... 10|trusted_ca|TEXT|0||0      ← 老库上补列成功，没有丢环境
```

`leafSignedByCa` 的四条单测跑的是真证书（`tests/fixtures/`：leaf 由 ca 签发、other-ca 是另一张自签）：

```
✔ 由这张 CA 签发的叶子证书通过
✔ 换一张 CA 就不通过（不是「装了钩子就全放行」）
✔ CA 自己签自己不算数：叶子必须是叶子
✔ 坏输入一律 false / undefined，不抛异常
```

### W2 实例托管

```
$ warren plugin run com.warren.whistle list          # 不带 --env，插件命令不再强制要环境
  w2 = <W2_PATH>

$ warren plugin run com.warren.whistle fork --input='{"storage":"dev-a","hostPattern":"app.example.test/static/","targetPort":5199}'
  {'storage': 'dev-a', 'port': 8900, 'hostPattern': 'app.example.test/static/', 'targetPort': 5199,
   'alive': True, 'version': '2.9.99', 'url': 'http://127.0.0.1:8900', 'environmentId': None}
  created: {'storage': 'dev-a', 'port': 8900}

$ curl -s http://127.0.0.1:8900/cgi-bin/rules/list      # 规则真写进实例了
  {"ec":0,"list":[{"index":0,"name":"warren","data":"app.example.test/static/ 127.0.0.1:5199","selected":true}]}
$ curl -s http://127.0.0.1:8900/cgi-bin/get-data | jq .interceptHttpsConnects
  True                                                  # HTTPS 解密已自动打开

$ curl -x http://127.0.0.1:8900 http://app.example.test/static/app.js
  window.__LOCAL_DEV__ = "LOCAL-DEV-BUILD";             # 线上地址 → 本地 5199（自证）
$ curl -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8900 http://app.example.test/other.js
  502                                                   # 未命中 = 走真实网络
```

### W3 规则面板 + 环境绑定（RED → GREEN）

**RED（有代理、没有 trustedCa）**：环境 `whistle-test`，proxy 指向实例、startUrl 是 `https://app.example.test/static/app.js`：

```
status = running   proxy = http://127.0.0.1:8900   trustedCa = None
error  = ERR_CERT_AUTHORITY_INVALID (-202)
```

**GREEN（bind 之后）**：

```
$ warren plugin run com.warren.whistle bind --env whistle-test --input='{"storage":"dev-a"}'
  proxy     = http://127.0.0.1:8900
  trustedCa = .../core/sessions/whistle-test/trusted-ca.pem
  restarted = True
  note      = 若该域名此前已报过证书错…新标签会走验签兜底；旧标签仍失败请重开

$ warren env start whistle-test2（新建环境，第一次访问就是这个域名）
  status = running   error = None
$ warren exec whistle-test2 → { title: "app.example.test/static/app.js",
                                body: "window.__LOCAL_DEV__ = \"LOCAL-DEV-BUILD\";" }
```

**界面（`debug.rendererEval` 读 DOM，不是看像素）**：

```
rail 目的地         = ["环境", "坏插件", "笔记", "代理", "设置"]
点「代理」→ mounted = true
实例行 data-slot=whistle-instance data-storage=dev-a data-alive=true
  文本              = dev-a | :8900 | 运行中 | → 127.0.0.1:5199 | 绑定 whistle-test | 打开面板 | 规则 | 停止 | 删除
点「规则」→ [data-slot=whistle-rules] 挂载，textarea 里是实例真实的规则文本
改文本 → 点「保存」→ whistle 侧 rules/list 变成改后的内容        ← 人在界面上改，实例真的变了
点「启用」开关 → whistle 侧 selected: true → false               ← 开关也真的落到实例
点「打开面板」→ window.open 返回 null（被主进程 deny 交给系统浏览器），webContents 5 → 5（没开内部窗口）
```

`envAction`「打开代理实例」（agent 侧同一条命令）：

```
$ warren plugin run com.warren.whistle open --env cap
  WHISTLE_NOT_BOUND: 环境 cap 没有绑定代理实例（先绑一个，或用面板里的「绑定」）
$ warren plugin run com.warren.whistle open --env whistle-test
  {"url": "http://127.0.0.1:8900", "opened": true}       # 系统浏览器真的打开了 whistle 的 Web UI
```

### W4-1 全量回归

```
$ bash scripts/regress/run-all.sh
  PASS 总数: 146    FAIL 总数: 0    （唯一非 PASS 是 vault 5.7 的 SKIP，已知）
  插件已经进了套件：7.3 rail 目的地 = 环境 / 坏插件 / 笔记 / 代理 / 设置
                   10.1 设置分节  = 插件 / Agent / 凭据 / Notes 使用说明 / Whistle 使用说明
                   10.2 每个分节都有内容（Whistle 分节文本已读到）
```

### W4-2 顺带修掉的两个真 bug

1. **host 运行时的命令收不到 `ctx.input` / `ctx.environmentId`**
   （`plugins/runtime.ts` 的 `#invoke` 把 ctx 覆盖成 `{pluginId, input: payload.input}`，
   而命令那条路上 `payload.input` 不存在）。症状：`fork --input='{...}'` 静默按默认值跑，
   生成了一个叫 `dev-mvcn2jte` 的实例、hostPattern 是空的 —— **不报错，只是参数没了**。
   sandbox 那条路一直是对的，所以之前没暴露（`example-host` 的命令不看 ctx）。
2. **`plugin.run` 的 RPC 层强制要 `env`**（`str('env')`），和「命令可以不绑环境」冲突，
   改成 `typeof params.env === 'string' ? params.env : ''`。

### W4-3 证书校验缓存（RED → GREEN，用同一个 session 证伪/证实）

同一个 `whistle-test` session、同一个已装好的钩子：

```
$ warren exec whistle-test → page.goto("https://fresh.example.test/static/app.js")
  body = "window.__LOCAL_DEV__ = \"LOCAL-DEV-BUILD\";"    ← 没访问过的域名，钩子生效
$ warren exec whistle-test → page.goto("https://app.example.test/static/app.js")
  body = ""                                               ← 之前 RED 时失败过的域名，仍然失败
```

重启应用后再起同一个环境：

```
status = running   error = None
body   = "window.__LOCAL_DEV__ = \"LOCAL-DEV-BUILD\";"    ← 缓存只在内存里
```

结论：**是按域名缓存的证书校验结果，随应用退出清空**。已记进 §7 风险 6。

### W5 现场验收 + fork 前置自检（2026-11-05，对照 audit P0-4）

来源：早期内部 E2E 审计 P0-4 / 改造计划 WP6（审计文档未随仓库公开）。

**命令表**（`warren plugin run com.warren.whistle --help` 由 `contributes.commands` 生成，
本批新增的 6 条如下；清单与 rpc 的一一对应由 `tests/plugin-package-contract.test.ts` 断言）：

```
  start                把 list 里 alive:false 的已登记实例按原端口原 storage 拉起
  unbind               解除环境的代理绑定（清 proxy + trustedCa，环境在跑就重启）
  rules                读取实例的规则组、selected 与多选开关
  ruleSet              写入并选中一组规则（写后回读 hash/selected，失败回滚）
  ruleToggle           启用/停用一组规则，正文 hash 不变
  ruleRemove           删除一组规则
```

**装机版未验收**：本轮按要求不改 `/Applications/Warren.app` 与 `~/.warren` 下的插件目录，
所以装机版 `--help` 仍是旧的 0.3.0 清单（实测 `grep -cE "^  (ruleSet|ruleToggle|ruleRemove) "` 为 0）。
下面所有行为证据来自**实现级**集成测试：直接 import 本仓库 `plugins/whistle/host.mjs`，
接一个独立安装的 whistle 2.10.12（`/tmp/whistle-dep`），路由/多选/规则文本全走真实 live API。

`rules / ruleSet / ruleToggle / ruleRemove / unbind` 以前只在 `contributes.rpc` 里，
agent 只能 `warren call plugin.rpc` 绕一层、`--help` 看不见；现在两侧一一对应。

**规则生命周期**（实现级：直接驱动 `plugins/whistle/host.mjs`，接独立安装的 whistle 2.10.12，端口 8960）：

```
fork → created {storage: b5-a, port: 8960, allowMultipleChoice: true}
ruleSet test-backend / local-console / local-buy → verified=true（三个 hash 各不相同）
rules 回读 → allowMultipleChoice=true
  local-buy      selected=true bytes=44
  local-console  selected=true bytes=52
  test-backend   selected=true bytes=50      ← 三组同时 selected，不再互相顶掉
ruleToggle local-buy enabled:false → hash 89ed805ed389…，selected 只剩两组
ruleToggle local-buy enabled:true  → hash 89ed805ed389…（与关之前完全一致），三组恢复
```

**实例生命周期**：

```
同端口重复登记（注入一条 2020 年的 b5-a-old）→ instances=[b5-a]，stale=[{storage: b5-a-old,
  reason: duplicate-port, liveStorage: b5-a}]
stop → list alive=false → start → started {storage: b5-a, port: 8960, version: '2.10.12'}，alive=true
traffic --since=9999999999999 → entries=0（since 守约，不返回更早的条目）
```

**fork / start 前置自检**（`plugins/whistle/preflight.mjs`，纯函数 + 注入 IO）：

```
w2Path=/tmp/does-not-exist-w2 → WHISTLE_W2_NOT_FOUND
  「设置里的 w2Path 不存在: /tmp/does-not-exist-w2」
  + 提示「在插件设置 w2Path 填一个长期存在的 w2 绝对路径」
（直连 node 壳脚本 + PATH 无 node → WHISTLE_NODE_NOT_FOUND；根证书存在但解析不了 →
  WHISTLE_ROOT_CA_INVALID；/tmp 下的 w2Path → 只告警 WHISTLE_W2_PATH_VOLATILE）
```

自检在**起实例之前**跑完，不再出现「w2 起来了但 node 找不到 / CA 坏了」的 4 分钟试错。
单测：`tests/whistle-preflight.test.ts`（8 条）。

**按资源类型分流的预设层**：`presets.mjs` 增加 `localStaticOnlyLayer` /
`appendStaticOnlyLayer` / `staticAssetMatcher`，只把 `js/css/字体/图片` 映到本地端口，
document（html）与 POST 不命中；默认不启用，只有 `presetPreview`/`presetApply`
显式传 `staticOnly: { localPort, host }` 才加进预设。合成结果（含 query 的
`im-buy.zh.<hash>.js?max_age=...` 命中、`/order/check` 不命中）见
`tests/whistle-presets.test.ts`。
