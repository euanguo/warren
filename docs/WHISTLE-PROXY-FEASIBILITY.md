# 每个 Environment 绑一个 whistle 实例：可行性与方案

> 状态：**已实现** —— 落点是 `plugins/whistle/`（runtime=host），施工图与验收在
> **`docs/WHISTLE-PLUGIN-PLAN.md`**（2026-10-18）。
> ⚠️ 本文 §6「必须核心托管，插件只能当薄壳」**已被推翻**：那个结论的前提是「插件起不了进程、
> 发不了 HTTP」，而 host 运行时（`utilityProcess.fork`）落地后前提不成立了，实例托管搬进了插件。
> §4（whistle 能力实测）、§6.1（CA 验签写法）、§7（Electron × whistle 全链路）**仍然有效**。
> 下面保留原始调研记录，不重写历史。
>
> 原始状态：**调研完成，未实现**（本文只有结论和实测，没有代码改动）
> 日期：2026-10-14 初版 / **2026-10-15 按最新代码复核**
> 结论：**可行性高**。当插件单独做不可行（两个硬卡点，见 §5）；由核心托管实例、插件只写规则，可行。
> 上次唯一没验的环节 —— **Electron Session 走 whistle 代理 + 信任 whistle CA 的 HTTPS 全链路** —— 本轮已实测跑通（§4.3、§6.1、§7）。
> 前置阅读：`docs/TECH-STACK-RESEARCH.md`（Environment 模型）、`docs/HANDOFF.md`（插件权限分层）

---

## 1. 需求

每个 Environment 绑定一个**独立的** whistle 实例：各自 fork 一个进程，规则、抓包记录、Web UI 全部互不干扰。

要解决的是：同一个 agent 工作台里同时跑多个环境时，每个环境需要各自改包 / mock / 抓包，而 whistle 默认是单实例全局的。

---

## 2. 结论速览

| 问题 | 结论 |
|---|---|
| 能不能做 | **能**，且比上次评估时更确定：唯一没有实测支撑的环节（Electron 的 HTTPS 解密链路）已经跑通 |
| 谁来托管实例 | **必须是核心（主进程）**。插件起不了进程、发不了 HTTP（§5） |
| 最难的一步 | 不是 whistle，是**证书信任钩子**：不装钩子页面直接 `ERR_CERT_AUTHORITY_INVALID`（实测），装了又等于给该环境开了中间人。§6.1 给了实测可用的写法 |
| 必须先补的前置 | ①删环境要真删目录（现有缺陷，§3.2）②核心必须打开 whistle 的 HTTPS 捕获开关（否则「绑上了却抓不到」，§4.3） |
| 最大成本 | 内存。每实例一个 node 进程树（§4.5） |
| 建议分期 | P0 核心托管（人用 Web UI 写规则）→ P1 CLI/RPC（agent 写规则）→ P2 插件（把常用规则打包成动作） |

---

## 3. 这个需求和 warren 的架构天然合得上

> 下列行号按 2026-10-15 的 `main`（`8166da1`）核对过。

| 已有的东西 | 位置 |
|---|---|
| 每个环境一个独立 Session | `src/main/environments.ts:288` `#sessionFor()` → `session.fromPath(storagePath)` |
| 每个环境一个独立 proxy 字段，启动时生效 | `src/main/environments.ts:296` `start()` → `:304` `ses.setProxy({ proxyRules: config.proxy })` |
| 代理认证已有通道（凭据从 Vault 取，取不到就**拒绝**认证，不静默放行） | `src/main/main.ts:46` `resolveProxyCredential()`、`:219` `app.on('login')` |
| 环境有自己的磁盘目录 | `EnvironmentConfig.storagePath`（`src/shared/types.ts:69`）= `<userData>/core/sessions/<id>`（`src/main/store.ts:116`） |

「环境绑一个代理」**已经是核心概念**，不需要新造模型：绑定 whistle 就是让 `env.proxy` 指向 `http://127.0.0.1:<port>`。

### 3.1 现在的运行形态（比初版文档时的结构更清楚了）

初版之后主进程补了完整的浏览器能力层，和本方案相关的变化有三处：

1. **一个环境 = 一个 Session + 多个标签**。标签由 `src/main/tabs.ts` 的 `TabManager` 管，页面是 `WebContentsView`（不再是一环境一 `BrowserWindow`）。Session / 代理 / 登录态仍然是**按环境**的，所以「一环境一 whistle」的落点没变。
2. **主进程已经能在页面里发请求**：`src/main/browser/escape.ts:72` `fetchPage()`（RPC `browser.fetch`，CLI `warren browser ...`）。它在页面上下文里 `fetch`，因此**天然走该环境的 Session → 走 whistle**。这是 agent 侧现成的「经 whistle 取数」通道。
3. **`session.webRequest` 已被遥测占了一个事件**：`src/main/telemetry.ts:69` `attachSession()` 注册了 `webRequest.onCompleted`（`:74`）。Electron 的 `webRequest` 是**每个事件只能有一个监听器**（后注册的覆盖先注册的），所以将来想再加 `onBeforeRequest` 做拦截要记住这条：`onCompleted` 已被占，`onBeforeRequest` 还空着，但两者不能互相覆盖。

### 3.2 两个要先知道的前提（复核后仍然成立）

1. **改 proxy 不会重启已运行的会话。** `src/main/environments.ts:222` 的注释写得很明确：「只改配置，不重启已运行的会话」。所以绑定 / 解绑 whistle 必须显式停启环境，不能只改字段。
2. **删环境目前仍然不删 `storagePath`。** UI 的删除确认写着「该环境的独立浏览器存储（Cookie、登录态）会一并删除，无法撤销」（`src/renderer/features/environments/environment-sidebar.tsx:590`），但代码里没人删：`Store.remove()`（`src/main/store.ts:178`）只把配置从 JSON 里摘掉，`EnvironmentManager.remove()`（`src/main/environments.ts:215`）也只调 `stop()` + 它。

   这条直接影响本方案：如果 whistle 的数据要跟着环境走（放在 `<storagePath>/whistle`），**得先把「删环境真删目录」补上**，否则每删一个环境就漏一份 whistle 数据。

---

## 4. whistle 侧实测能力

### 4.0 本机现状（本轮新增）

这台机器上**已经装了 whistle**，而且不是 npm 上那份，是用户自己的 fork：

```
~/.local/bin/w2 -> ~/.n/lib/node_modules/whistle/bin/whistle.js -> ~/code_source/front_end/owner_project/whistle
版本：2.9.99   origin: https://github.com/verger-guo/whistle.git（有本地改动：docs/api、pkg/recorder(Go)、CLI 覆盖报告等）
```

这一点对 §9.4「自带还是自装」的取舍有直接影响：**这台机器上「自装」已经是既成事实**，而且是 fork，功能比 npm 版多（fork 里暴露了 `createInstance / start / stop / addRules / getRunningInstances` 这套 Node API，见 `lib/cli-functions.js`）。

初版文档测的是 npm 上的 **2.10.11**；本轮的进程 / CA / 规则 / HTTPS 实测跑在 **2.9.99 fork** 上。下面凡是版本相关的结论都标了版本。

### 4.1 多实例是官方支持的

```bash
w2 start -S <storage> -p <port>
```

`-S` 是 storage 名（出处是 whistle 自己的提示串：`bin/use.js` 的 `'w2 start' + (storage ? ' -S ' + storage : '')`、`bin/status.js` 的 `'w2 stop -S ' + options.storage`）。

本轮实测（2.9.99 fork）：`w2 start -S probe -p 8801` 起在 `127.0.0.1:8801`，`curl -x http://127.0.0.1:8801` 走 HTTP 和 HTTPS 都通。

### 4.2 每个实例的数据是隔离的

storage 名会变成数据目录名：

```
<WHISTLE_PATH>/.whistle/custom_dirs/<storage>/rules/…      （规则，含 files/ + properties 索引）
                                          /values/…         （值）
                                          /properties/…     （实例开关）
```

`WHISTLE_PATH` 是**环境变量**（`lib/util/common.js` `getWhistlePath()` 先读 `process.env.WHISTLE_PATH`，默认 `~/.WhistleAppData`）。所以可以让每个环境的数据落在**该环境自己的目录里**。

**但要注意有一份状态不在 `WHISTLE_PATH` 里**：`w2` 靠 `starting` 这个包做守护，它的锁文件写在 `~/.startingAppData/`（本轮在沙箱里起实例时就撞到 `EPERM: ~/.startingAppData`）。也就是说「whistle 的一切都落在 env.storagePath 里」是不成立的，绑定/解绑/清理时要认这两处。

### 4.3 HTTPS 默认**不解密**（本轮新增，关键）

whistle 是「按需解密」：只有当规则需要看/改请求响应时才 MITM，否则只做 CONNECT 隧道。而决定要不要解密的开关是实例属性 `interceptHttpsConnects`（whistle UI 里的 **Enable HTTPS (Capture Tunnel Traffic)**），默认 **关**。

实测（2.9.99，`WHISTLE_PATH=/tmp/whistle-probe`）：

| 状态 | 通过代理请求 `https://example.com/` 时客户端拿到的证书 |
|---|---|
| 默认（未开捕获） | `issuer=C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3` ← **真证书，没解密** |
| 开了捕获后 | `issuer=CN=whistle.1791996724215145, C=CN, ST=ZJ, L=HZ, O=…wproxy.org` ← whistle 自签，已解密 |

打开方式（实测可用）：

```bash
# 实例开关（UI 的 Enable HTTPS 勾选走的就是这个接口）
curl -X POST http://127.0.0.1:8801/cgi-bin/intercept-https-connects \
     -d 'interceptHttpsConnects=1'      # → {"ec":0,"em":"success"}
```

或者按规则开：`enable://capture`（whistle UI 在 multiEnv 模式下就是提示「Use 'pattern enable://capture' in rules to enable HTTPS」——multiEnv 下这个全局勾选框是禁用的）。

**这条直接影响方案**：核心如果不主动打开捕获，用户会看到「环境绑上了 whistle、CA 也信任了，但什么都抓不到、规则也不生效」。必须由核心在起实例时打开。

### 4.4 规则可以用 HTTP API 写（本轮新增）

whistle 的 Web UI 就是通过 `/cgi-bin/*` 操作实例的，纯 HTTP，本地无需鉴权（实测）。写规则的正确姿势是 **`/cgi-bin/rules/project`**（出处 `bin/use.js:81`）：

```bash
curl -X POST http://127.0.0.1:8801/cgi-bin/rules/project \
     --data-urlencode 'name=probe' \
     --data-urlencode 'rules=example.com resBody://{probe.txt}' \
     --data-urlencode 'groupName='        # → {"ec":0}
```

实测效果：规则文件 `custom_dirs/probe/rules/files/0.probe` 被写入、`rules/properties` 变成 `{"filesOrder":["probe"],"selectedList":["probe"]}`、`curl -x` 访问 `https://example.com/` 直接返回 mock 内容。

**坑**：`POST /cgi-bin/rules/add` 只认 `name`（建一个空规则文件），传 `rules=` 进去会返回 `{"ec":0}` 但什么都不建 —— 不报错的假成功。核心写规则时别用错接口。

值文件同理走 `/cgi-bin/values/add`（`name` + `value`）。

### 4.5 开销

每个实例是 **2 个 node 进程**（1 守护 + 1 子；`--cluster` 才是多 worker，默认不开）。

| 版本 | 实测 RSS |
|---|---|
| 2.10.11（npm，初版测的） | 合计 **133–140 MB**（79.2 + 53.5 / 83.3 + 56.9） |
| 2.9.99（本机 fork，本轮测的） | 合计 **≈ 55 MB**（主 39.0 MB + 子 16.5 MB） |

**这是本方案最贵的部分**：环境数 × 每实例内存线性增长。缓解办法见 §9.1。

### 4.6 根证书是所有实例共用的，而且是全局一份

```
<WHISTLE_PATH>/.whistle/certs/root.crt
subject=CN=whistle.1791996724215145, C=CN, ST=ZJ, L=HZ, O=1791996724215145.wproxy.org, OU=wproxy.org
notAfter=Oct 14 16:52:04 2036 GMT
```

它不在 storage 目录下（`lib/https/ca.js` 用的是 dataDir 而不是 storage 的 baseDir）。**结论：不管起多少个实例，只需要信任一张 CA**（前提是这些实例共用同一个 `WHISTLE_PATH`；如果每个环境给一个 `WHISTLE_PATH`，就会各有一张 CA）。

### 4.7 默认端口是 8899

默认端口是 8899（本机 fork 里在 `bin/use.js:17`：`DEFAULT_OPTIONS = { host: '127.0.0.1', port: 8899 }`；2.10.11 里同一个常量在 `bin/util.js`）。**和项目 `scripts/serve-fixture.mjs` 的默认端口撞了**（`scripts/serve-fixture.mjs:7` 的 `process.argv[2] ?? 8899`），集成时每个实例都必须显式指定端口。

### 4.8 可以当库用，但不能 require 进主进程

`require('whistle')(options, callback)` 是存在的（fork 里还多了 `lib/cli-functions.js` 那套 `createInstance/start/addRules`）。但 `index.js` 会**全局打补丁**：

- `net.Socket.prototype.connect`（`index.js:23`）
- `tls.checkServerIdentity`（`index.js:34`）
- 并且用 `cluster` / `pfork` 自己起子进程

这些补丁会作用于**整个进程**，包括 Electron 自己的网络栈。所以：**绝对不能 require 进 Electron 主进程**；要用也只能放进 `utilityProcess.fork()` 或独立子进程。fork 版本也保留了这些补丁（本轮读过 `index.js`），结论不变。

---

## 5. 卡点：为什么不能只写一个插件

### 5.1 插件起不了进程

`src/shared/permissions.ts:43`：

```ts
'process.spawn': 'denied',
```

`denied` 层的定义（同文件注释）是「一律不开放，即使插件声明了也不会生效——『声明了就给』等于把 manifest 当成提权手段」。`PluginHost.grant()`（`src/main/plugins/host.ts:198`）也会把 `denied` 里的权限过滤掉。

→ **插件没法 fork whistle。**

### 5.2 插件连 HTTP 请求都发不了

插件跑在 `vm.createContext` 里，注入的全局只有 5 个（`src/main/plugins/host.ts:333`）：

```ts
{ module, host, console: scopedConsole, setTimeout, clearTimeout }
```

初版实测这个 context 里 `fetch / process / require / Buffer / WebSocket` 全是 `undefined`；本轮复核沙箱注入清单，**没有任何变化**。

→ 就算核心把 whistle 起好了，插件也**没法调它的 HTTP API 去写规则**。

### 5.3 插件能用的全部能力

`#buildHost()`（`src/main/plugins/host.ts:223`）暴露的只有：`environment` / `browser` / `vault` / `storage` / `events` / `ui`。没有网络、没有进程、没有代理。

**所以这个功能的主体必须在核心，插件只能当薄壳。**

---

## 6. 推荐架构

```
核心（主进程）
├─ Environment 加 whistle 绑定：{ storage: <env.id>, port: <分配的端口>, enabled }
├─ 生命周期：起 / 停 / 守护一个 whistle 子进程
│            环境变量 WHISTLE_PATH = <env.storagePath>/whistle  → 数据跟着环境走
│            起完立刻打开 HTTPS 捕获（§4.3），否则规则不生效
├─ 端口：每环境分配一个空闲端口并持久化（避开 8899）
├─ env.proxy 指向 http://127.0.0.1:<port>（复用现有机制，但需要停启才生效）
├─ CA 信任：只给绑了 whistle 的那个 Session 装 session.setCertificateVerifyProc，
│           校验「叶子证书确实由这张 root.crt 签发」才放行（§6.1）
└─ 新 host API（给插件）：host.proxy.rules.read / write —— 核心代插件去调 whistle API

插件（可选，薄）
└─ 声明 commands：按环境写规则 / 开关规则 / 看命中记录
```

### 6.1 CA 必须由核心处理，而且**不能**用「比较 issuer」这种写法

whistle 对 HTTPS 是自签 CA 中间人，Electron 的 Session 默认不认，页面直接报证书错误（实测 `ERR_CERT_AUTHORITY_INVALID`）。

Electron 44 有 `session.setCertificateVerifyProc(proc)`（`node_modules/electron/electron.d.ts:13529`），它是**按 Session** 的 —— 正好可以只对绑了 whistle 的那个环境放宽校验，其它环境不受影响。

**实测踩到的坑**：在 verify proc 里拿 `request.certificate.issuerCert.data` 去和 `root.crt` 比 PEM 是**行不通的** —— Electron 这个字段是空的（实测 `issuerCertPemLen = 0`），比较结果恒为 false，页面永远加载失败。而 `cert.issuerName` 只给到 CN（`whistle.1791996724215145`），拿 CN 当身份校验太弱。

**实测可用的写法**（用 Node 自带 `crypto.X509Certificate` 验签）：

```ts
import { X509Certificate } from 'node:crypto';

const ca = new X509Certificate(fs.readFileSync(rootCaPath, 'utf8'));
ses.setCertificateVerifyProc((request, callback) => {
  let ok = false;
  try {
    ok = new X509Certificate(request.certificate.data).verify(ca.publicKey);
  } catch {
    ok = false;
  }
  callback(ok ? 0 : -3); // 0 = 放行，非 0 = 用 Chromium 的默认错误码
});
```

实测：`leafSignedByCa = true` → `callback(0)` → 页面正常加载（200 + 规则生效）；不装钩子或验签失败 → `ERR_CERT_AUTHORITY_INVALID (-202)`。

这条是本方案**唯一的安全放松点**，必须：

- 只在该环境绑定了 whistle 时才装（`setCertificateVerifyProc(null)` 可还原）
- 只放行验签通过的证书（不是无脑 `callback(0)`）
- 在事件流里留痕（`store.record`），UI 上能看到
- 注意 Electron 文档提示：**校验结果会被网络服务缓存**，装钩子要早于第一次导航

### 6.2 为什么实例要放子进程

whistle 的全局补丁（§4.8）决定了它不能和别的代码共处一个进程。**建议直接 `child_process.spawn` 跑 `w2`**（或本机已有的 fork 的 `w2`），跟用户手敲一条命令等价，出问题时好排查。`utilityProcess.fork()` 也可以，但要在里面 `require('whistle')`，收益不大、还多一层 Electron 生命周期管理。

---

## 7. Electron × whistle 全链路实测（本轮新增，替换初版的「没验」）

环境：macOS，Electron 44.7.0（项目依赖），whistle 2.9.99（本机 fork），`WHISTLE_PATH=/tmp/whistle-probe`，实例 `-S probe -p 8801`。

探针做的事：`session.fromPath()` → `setProxy({ proxyRules: 'http://127.0.0.1:8801' })` → 装/不装 verify proc → 隐藏窗口 `loadURL('https://example.com/')`。

| 场景 | 结果 |
|---|---|
| 未开 HTTPS 捕获（whistle 只做隧道） | Electron 拿到的是**真证书**（`issuer = Cloudflare TLS Issuing ECC CA 3`），`chromiumResult = net::OK`，页面正常 —— 说明代理确实生效、且未解密时不影响任何东西 |
| 开了捕获，但**不装** verify proc | `loadURL FAILED: ERR_CERT_AUTHORITY_INVALID (-202)` ← 页面直接挂 |
| 开了捕获，装 verify proc 且用**比较 issuer PEM** 判定 | 同样 `-202`（`issuerCert.data` 为空 → 判定恒为 false） |
| 开了捕获，装 verify proc 且用 **`X509Certificate.verify(ca.publicKey)`** 判定 | `leafSignedByCa = true` → `loadURL ok`，`net GET 200`，页面标题 `Example Domain` |
| 同上 + 规则 `example.com resBody://{probe.txt}` | 页面正文变成 **`MOCK FROM WHISTLE`**（`document.body.innerText`）← 规则在 Electron 页面里真的生效 |

**结论：从「Session → 代理 → MITM → 规则 → 页面」这条链路，实测打通，没有未知风险。** 初版列为「P0 第一步该做的实验」的那条，已经做完了。

复现命令（探针脚本是临时的，没进仓库；关键代码就是 §6.1 那 8 行）：

```bash
mkdir -p /tmp/whistle-probe
HOME=/tmp/whistle-probe-home WHISTLE_PATH=/tmp/whistle-probe w2 start -S probe -p 8801
curl -X POST http://127.0.0.1:8801/cgi-bin/intercept-https-connects -d 'interceptHttpsConnects=1'
curl -X POST http://127.0.0.1:8801/cgi-bin/rules/project \
     --data-urlencode 'name=probe' --data-urlencode 'rules=example.com resBody://{probe.txt}' --data-urlencode 'groupName='
node_modules/.bin/electron <探针脚本>          # 见上表
```

（清理：kill 掉 8801 上的两个 node 进程，删 `/tmp/whistle-probe*`。`w2 stop -S probe` 在这台机器上找不到实例，因为 `starting` 的锁文件没落在同一个 HOME 下 —— 见 §4.2。）

---

## 8. 改动清单

| 位置 | 改动 | 说明 |
|---|---|---|
| `src/shared/types.ts:69` | `EnvironmentConfig` 加 `whistle?: { storage: string; port: number }` | 跨进程数据模型 → 要同步 `docs/HANDOFF.md` |
| `src/main/whistle.ts`（新） | 起 / 停 / 健康检查 / 端口分配 / **打开 HTTPS 捕获** / 写规则 | `spawn(w2, ['start','-S',id,'-p',port], { env: { WHISTLE_PATH } })`；规则走 `/cgi-bin/rules/project`（§4.4） |
| `src/main/environments.ts:296` `start()` | 若绑定则起实例并把 proxy 指向它；`:215` `remove()` 停实例 + 删数据 | 依赖 §3.2 第 2 条先修 |
| `src/main/environments.ts:288` `#sessionFor()` | 给该 Session 装 `setCertificateVerifyProc`（§6.1 的写法） | 只在绑定时装 |
| `src/main/store.ts:178` `remove()` | 补删 `storagePath` | 现有缺陷，见 §3.2 |
| `src/shared/permissions.ts` | 新增 `proxy.rules.read` / `proxy.rules.write`（**confirm** 层） | **不要动 `process.spawn` 的层级** |
| `src/main/plugins/host.ts:223` | `#buildHost()` 加 `proxy` 命名空间 | 插件唯一的入口 |
| `src/main/rpc.ts` + `bin/warren.mjs` | `warren whistle start/stop/rules …` | 挂在现有的 `browser` / `tab` 同级（`bin/warren.mjs:579` 那种分组写法） |
| `package.json` | whistle 作为依赖（+121 包），或者要求用户自装 `w2` | 见 §9.4 |

---

## 9. 风险与取舍

### 9.1 内存

每环境一份进程树（2.9.99 实测 ≈ 55 MB，2.10.11 实测 133–140 MB）。6 个环境 ≈ 330 MB–800 MB，几十个环境就不可接受。

**缓解**：只给「运行中且绑定了 whistle」的环境起实例，环境停就停；再加闲置回收。

**替代方案**：共享一个 whistle 实例、用规则里的环境标识分流。内存降到 1 份，代价是各环境不再有独立的 Web UI、规则会复杂一些。**环境数可能到几十个的话，应该选这条。**

顺带一提：whistle 自己有一个 `multiEnv` 模式（`-M multiEnv`，规则按请求头 `x-whistle-rule-name` 选，`lib/rules/index.js:549`）。理论上「一个实例多套规则」它原生就支持 —— 但那个头得由客户端每条请求都带上，而浏览器页面本身发不出这个头（要改就得靠扩展或 CDP 注入），所以**它并不能直接替代「一环境一实例」**，只能作为「共享实例 + 显式分流」那条路的备选。另外 multiEnv 下 HTTPS 捕获的全局开关被禁用，必须用 `enable://capture` 规则。

### 9.2 端口

要分配、持久化、回收，还要处理「端口被占」。whistle 自己的默认 8899 必须避开（和 `scripts/serve-fixture.mjs` 撞）。

### 9.3 CA 放松

见 §6.1。这是「故意让中间人进来」，范围必须严格限定在绑定 whistle 的那个环境，且要留痕。这条要在 PRD 层面写清楚，不能只当成实现细节。

### 9.4 依赖与版本

- whistle 迭代快，`-S` / `-p` 是 **CLI 契约**（出处是它自己的提示串，不是官方文档），升级可能变。
- 自带 whistle = 121 个包进 `package.json`；要求用户自装 = 应用保持轻，但多一步安装，还要处理「用户装的是哪个版本」。
- **本轮新增的事实**：这台开发机上 `w2` 已经在 PATH 上（`~/.local/bin/w2`），而且指向用户自己的 fork（2.9.99）。所以第一阶段**建议「用本机已有的 `w2`，路径可配置」**：省掉 121 个包的依赖和版本漂移，也正好对上用户正在改的 fork。自带打包留到后面再说。

### 9.5 合规 / 用途

MITM 能力要在 UI 上说清用途（调试自己的站点），不能让它看起来像「随便抓别人的包」。

---

## 10. 分期

### P0（核心，不做插件）

Environment 绑定 whistle 实例 + 自动改 proxy + 打开 HTTPS 捕获 + CA 信任钩子 + 生命周期。做完就能用：每个环境一个独立 whistle，人在它的 Web UI 里写规则。

前置两件事：① `Store.remove()` 补删 `storagePath`（§3.2）② 起实例时打开捕获（§4.3）。

### P1（CLI / RPC）

`warren whistle rules set/list/…`，让 agent 也能写规则（走 `/cgi-bin/rules/project`，§4.4）。

### P2（插件）

只有 P1 的 host API 就位后，插件才有意义。它的价值是「把某类规则打包成可复用的动作」（例如「把所有请求指向本地 mock」），**不是管进程**。

---

## 11. 附录 A：实测原始记录

### A.1 2026-10-14（whistle 2.10.11，npm 版）

环境：macOS。全程 `WHISTLE_PATH=/tmp/whistle-home`，**没有写用户主目录**。

```bash
mkdir -p /tmp/whistle-test && cd /tmp/whistle-test
npm i whistle --cache /tmp/npm-cache --no-audit --no-fund
WHISTLE_PATH=/tmp/whistle-home ./node_modules/.bin/w2 start -S env-alpha -p 8801
WHISTLE_PATH=/tmp/whistle-home ./node_modules/.bin/w2 start -S env-beta  -p 8802
```

| 验的东西 | 结果 |
|---|---|
| 两个实例同时监听 | `TCP *:8801` + `TCP *:8802` ✅ |
| 数据目录隔离 | `custom_dirs/env-alpha/` 与 `env-beta/` 各有 `rules` / `values` / `properties` ✅ |
| 根证书共用 | 只有一份 `<WHISTLE_PATH>/.whistle/certs/root.crt`（有效期到 2036-10-11）✅ |
| 当代理用 | `curl -x http://127.0.0.1:8801 http://127.0.0.1:8899/` → 200；`curl -x …8802 https://example.com/` → 200 ✅ |
| 各自 UI/API | 两个端口的 `/cgi-bin/get-data` 都 200 ✅ |
| 进程与内存 | 每实例 2 个 node 进程，RSS 合计 133–140MB |
| 插件沙箱能力 | `vm.runInContext` 里 `fetch` / `process` / `require` / `Buffer` / `WebSocket` 全 `undefined` ✅ |
| 删环境是否删存储 | 建 → 启动 → 删，目录**仍然存在** ❌ 现有缺陷 |

### A.2 2026-10-15（whistle 2.9.99，本机 fork；Electron 44.7.0）

```bash
mkdir -p /tmp/whistle-probe
HOME=/tmp/whistle-probe-home WHISTLE_PATH=/tmp/whistle-probe ~/.local/bin/w2 start -S probe -p 8801
```

| 验的东西 | 结果 |
|---|---|
| 实例起得来 | `w2 start -S probe -p 8801` → 监听 `127.0.0.1:8801`；`w2 status` 查不到它（`starting` 锁文件在 `~/.startingAppData`，见 §4.2） |
| 数据隔离 | `/tmp/whistle-probe/.whistle/custom_dirs/probe/{rules,values,properties}` ✅ |
| 根证书 | `/tmp/whistle-probe/.whistle/certs/root.crt`，`CN=whistle.1791996724215145`，到期 2036-10-14 ✅ |
| 代理可用 | HTTP 200 / HTTPS（隧道）200 ✅ |
| **默认不解密 HTTPS** | 客户端拿到 Cloudflare 真证书；开捕获后变成 whistle 自签 ✅（§4.3） |
| 打开捕获 | `POST /cgi-bin/intercept-https-connects` → `{"ec":0,"em":"success"}` ✅ |
| 写规则 | `POST /cgi-bin/rules/project`（name/rules/groupName）→ 文件写入 + 选中 + 生效 ✅；`/cgi-bin/rules/add` 传 `rules=` 是**假成功** ❌ |
| 规则生效 | `example.com resBody://{probe.txt}` → `curl -x` 返回 `MOCK FROM WHISTLE` ✅ |
| 内存 | 主进程 39.0 MB + 子进程 16.5 MB ≈ 55 MB（`ps -eo rss`） |
| Electron 代理生效 | 隧道模式：`issuer=Cloudflare…`、`chromiumResult=net::OK`、页面正常 ✅ |
| Electron + MITM 不装钩子 | `ERR_CERT_AUTHORITY_INVALID (-202)`，页面挂 ❌ |
| Electron + MITM 装钩子（比较 issuer PEM） | 仍 `-202`（`issuerCert.data` 为空，判定恒 false）❌ |
| Electron + MITM 装钩子（`X509Certificate.verify(ca.publicKey)`） | `leafSignedByCa=true` → 200、标题 `Example Domain` ✅ |
| Electron 页面里规则生效 | 正文变成 `MOCK FROM WHISTLE` ✅ |
| 沙箱内起 whistle | `EPERM: ~/.startingAppData`（要能写 HOME） |

清理：kill 掉 8801 上的两个 node 进程（`w2 stop -S probe` 在这台机器上找不到实例），`rm -rf /tmp/whistle-probe /tmp/whistle-probe-home`。

---

## 12. 附录 B：没验的 / 待定

**没验**：

1. whistle 的 WebSocket / HTTP2 路径在 Electron Session 下的表现（HTTPS 主链路已验）。
2. whistle 长时间运行后的内存曲线（上面的数字是冷启动 + 少量请求后立刻测的）。
3. 与 mitmproxy 之类的对比（whistle 的优势是自带 Web UI 和规则语法，劣势是依赖重、CLI 契约不稳；mitmproxy 是 Python 生态，嵌入 Electron 需要额外打包 Python 运行时，但进程模型更简单）。
4. 一台机器上同时跑 N 个实例时，CPU / 文件句柄的表现。

**待定**：

1. whistle 由应用自带，还是用本机已有的 `w2`（§9.4 现在倾向于后者，至少 P0）。
2. 每环境一个实例，还是共享一个实例 + 规则分流（§9.1）。
3. 绑定/解绑时是否需要强制停启环境（§3.2 第 1 条）——还是接受「下次启动才生效」。
4. CA 信任的粒度：共用一张 root.crt（简单）还是每环境一张（隔离更强，但用户要装多次）。
