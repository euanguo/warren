# 全量回归（2026-10-15，基线 `0513c16`）

> 目的：把「所有功能」跑一遍，**发现真问题就修**（RED → GREEN → 重跑），并留下一套可复跑的回归套件。
> 结论：**117 PASS / 1 FAIL**，唯一 FAIL 是文档里早就记过的跨源 iframe（OOPIF）已知缺口，不是回归。
> 本轮修掉 6 个真问题（其中 2 个是「挂死」级别），都带修复前/后的实测输出。

---

## 1. 怎么跑

```bash
# 1) 清理 + 起应用（在能常驻的终端里，否则进程会随命令结束被杀）
pkill -f "electron-forge start"; pkill -f "node_modules/electron/dist"; sleep 3
lsof -ti :5173 | xargs kill -9
node -e "const fs=require('fs'),os=require('os'),p=require('path');for(const f of ['envd.sock','runtime.json'])fs.rmSync(p.join(os.homedir(),'.warren',f),{force:true})"
npm start

# 2) 另一个终端：fixture
node scripts/serve-fixture.mjs 8899

# 3) 建验收环境（只需一次）
node bin/warren.mjs env create cap --start-url=http://localhost:8899/cap/form.html

# 4) 跑全量回归（G0 + 9 个域，约 1 分钟）
bash scripts/regress/run-all.sh          # 结果同时写 /tmp/warren-regress.txt
```

**跑之前先 `curl -s -o /dev/null -w "%{http_code}" http://localhost:8899/cap/form.html`**：
fixture 服务器挂掉会造成「全线回归失败」的假象（本轮就踩到了，见 §3-F2）。

套件落点：`scripts/regress/`（`capability.sh` V1–V15 / `net-n1..n5.sh` V16–V25 /
`core.sh` 环境·租约·遮罩·标签·分组·遥测·CLI / `vault.sh` / `plugin.sh` / `browser.sh` /
`ui.cjs` 界面 DOM 探针）。

---

## 2. 结果总表

| 域 | 覆盖 | 结果 |
|---|---|---|
| G0 静态门 | `tsc` / `npm test`（128）/ 渲染层 build | **PASS**（tsc 0 错、128 pass、build ✓） |
| 浏览器能力 V1–V15 | 重试 / actionability / 跨 frame / fill 分流 / 键鼠状态机 / snapshot 状态 / 隔离世界 / 导航收据 / fileChooser / dialog / 重试历史 | 14 PASS / **1 FAIL（V5b 已知缺口）** |
| 网络拦截 V16–V25 | mock / method 过滤 / 改请求头 / 改响应头（CORS）/ 阻断 / 延迟 / 5MB+SSE / HAR 录放 / 规则面板 / `ENV_BUSY` / 脱敏 | **全 PASS**（含全部反例门） |
| 核心域 | 环境生命周期 12 项、标签 5 项、分组 5 项、遥测 2 项、CLI 错误码 3 项 | **全 PASS** |
| Vault | 明文不外泄 / 域名名单拒绝与放行 / 填进页面并**真的登录成功** / 旧凭据标记 / 事件流无明文 | **全 PASS** |
| 插件 | 命令写库 / rpc / 日志 / 设置 / reload / host 运行时 / 只读命令不抢控制权 / 启停 | **全 PASS** |
| 浏览器能力补充 | 截图三态 / evaluate 脱敏 / fetch 凭据默认 / cdp 白名单 / clearData / 七种等待 / 上传 / 下载 saveAs / 拖拽 / shadow / dialog / 坐标键鼠 / 标签共享登录态 / 后台标签 / egress | **全 PASS** |
| UI | 侧栏 7 行 + 分组段头 / rail 三目的地 / 标题栏 / 检查器五页逐个打开 / 侧栏右键菜单不碰页面 / 设置弹窗三节 + Esc / 插件 rail 页 / 坏插件隔离 | **全 PASS** |

---

## 3. 本轮修掉的问题（都带实测）

### F1 · 视图被界面让开时，agent 的输入操作**挂死 60s**（最严重）

渲染层为了给浮层 / 插件页让位会调 `setViewVisible(false)`（原生视图让开）。这时 Chromium
把 CDP 输入事件丢掉——而**不是报错**。

```
# 修复前
$ warren call debug.rendererEval '{"script":"window.envApi.setViewVisible(false)"}'
$ warren exec cap  → page.click('#name')
报错 TIMEOUT 60007ms: RPC 超时 60000ms: browser.click        ← 60 秒挂死，原因完全看不出来

# 修复后
ENV_NOT_VISIBLE 4ms: environment cap 的页面视图此刻被界面让开（浮层或插件页挡着），
                     输入会被丢弃；先关掉浮层 / 切回环境页再操作
```

修法：`EnvironmentManager.assertInputOnScreen()`（只挂在 `inputCall` 上，**不挂** dialog 那条
自救通道），`ENV_NOT_VISIBLE` 多一种触发条件。

### F2 · fixture 服务器被一个 404 打死（「全线回归失败」的假象）

`scripts/serve-fixture.mjs` 的 `/cap/*.html` 分支先 `writeHead(200)` 再 `readFile`，
文件不存在时 catch 里二次 `writeHead(404)` → 抛 `ERR_HTTP_HEADERS_SENT` →
**整个 fixture 进程退出**（之后每个探针都失败，看着像产品全线崩）。

```
# 修复前
node:_http_server:408  throw new ERR_HTTP_HEADERS_SENT('write');
    at Server.<anonymous> (serve-fixture.mjs:118:13)
$ curl -o /dev/null -w '%{http_code}' http://localhost:8899/cap/form.html → 000

# 修复后
/cap/does-not-exist.html → 404，随后 /cap/form.html → 200（服务器活着）
```

修法：**先读文件再写头**；再把整个请求处理包进 `try/catch`（抛错只回 500，绝不冒泡成
unhandled rejection 带走进程）。诊断层永远不能弄坏它观察的东西。

### F3 · `page.waitForEvent()` 的经典写法会让 CLI 抛裸栈

`const p = page.waitForEvent(...); await page.click(...); await p;`（HANDOFF 里 fileChooser
的例子就是这个形状）——事件若在 click 期间超时，`p` 在「还没人 await」时被拒绝，Node 默认
把进程连同一串 `file://` 栈打死，agent 看到的是堆栈而不是错误码。

```
# 修复前
Error: waitForEvent(download) timed out
    at file:///…/bin/warren.mjs:63:33     ← 裸栈，没有 code

# 修复后
TIMEOUT: waitForEvent(dialog) timed out
```

修法：`bin/warren.mjs` 加 `unhandledRejection` 兜底，统一成 `CODE: message`。

### F4 · 0 尺寸的视图报告会把页面变成 0×0（输入全废）

渲染层在 `ResizeObserver` 里量占位区再报给主进程，布局过渡那一帧能量到 `0×0`；真设下去，
原生视图就是 0×0，之后输入全丢。实测抓到过 `viewport=0×0` 而 DOM 里占位区其实是 1124×790
（渲染层之后再没报过，因为尺寸没再变）。

```
# 修复前：`setViewport({0,0,0,0})` 之后
viewport={"x":0,"y":0,"width":0,"height":0}   → 之后所有输入类命令挂到 RPC 超时

# 修复后：同样的上报被忽略
viewport={"x":306,"y":121,"width":1124,"height":790}
输入仍然可用: 零尺寸后仍可输入
```

修法：`setViewport()` 忽略 `width/height <= 0` 的报告（窗口 `minWidth: 1024`，内容区不可能
合法地为 0，「留着上一次的好值」永远比「设成 0」对）。

### F5 · 解不开的旧凭据被当成正常凭据列出来

Vault 里有一条应用改名之前写的记录（Keychain 密钥变了，永远解不开），`list` 照常列出来，
人和 agent 会一直拿它去填。

```
# 修复前
$ warren vault fill vault://a6e2c979-… --env=cap --domains=localhost --field=password
VAULT_DECRYPT_FAILED: cannot decrypt vault://a6e2c979-…

# 修复后
$ warren vault list --json → fixture available=false / test available=true / …
VAULT_DECRYPT_FAILED: cannot decrypt vault://a6e2c979-…：这条凭据是用旧密钥加密的
（应用改名 / 重装 / 换机器后 Keychain 密钥会变），已经解不开了。删掉它重新添加：
warren vault remove vault://a6e2c979-…
```

修法：`CredentialSummary.available`（只判能不能解开，不返回明文）+ 界面「不可用」徽章 +
报错带下一步；单测钉住「解不开也要列出来」和「报错带 vault remove」。

### F6 · 删掉「当前选中的环境」后选中态指向幽灵

```
# 修复前
start 后 selected=regrtmp → remove 后 selected=regrtmp（环境表里已经没有它了）
# 修复后
remove 后 selected=undefined
```

修法：`remove()` 里若删的正是选中项，清掉选中态。（`stop()` 保留选中态是刻意的，别改。）

---

## 4. 唯一 FAIL：V5b 跨源 iframe（OOPIF）——已知缺口，不是回归

```
FAIL V5b | #13 TARGET_NOT_FOUND: target not found: {"kind":"text","text":"内层按钮"}
```

跨源 iframe 的 frame 不在主会话的 `Page.getFrameTree` 里，所以 AX / CSS / 点击都够不到它
（同源 iframe 正常，V5c PASS）。上一轮已经探到卡点与正路：

1. `Target.setAutoAttach` 在 Electron 44 不崩、能拿到本页的 iframe target（R7 已实测）；
2. **卡在坐标换算**：跨源节点在自己会话里的坐标 + owner iframe 偏移算出来的点落在 iframe
   框外面，点错位置比点不到更危险，所以那一版回退了。

细节与两个必须记住的坑（`resetOopifSessions` 要在导航前清；`targetInfo.targetId ≠ frameId`）
在 `docs/BROWSER-CAPABILITY-PORT-PLAN.md` §5-R6。**本轮没动 `src/main/browser/`**：那是另一条
线的成果，且这条路要先单独验证坐标换算再合并。

---

## 5. 没覆盖 / 已知边界

- **代理环境**：所有验收都在直连环境跑；`--proxy` 与网络规则的叠加没测。
- **`net passthrough --for`**：计划里有、没做（见 `docs/NET-INTERCEPT-PLAN.md` §8）。
- **挂上 `protocol.handle` 会跳过整个 session 的 CORS 检查**：已收窄到「规则开着的时候」，
  详见 `docs/NET-INTERCEPT-PLAN.md` §7-N2 与 HANDOFF「未做/受阻」第 0 条。
- **HAR 回放同一 (method,url) 只回放第一条**录到的响应（`har.ts` 里有 `shortcut:` 注释）。
- **测试脚本自身的两个坑**（已修，写下来免得下次又踩）：① 事件等待要用
  `Promise.all([waitForEvent, click])`；② 别对 `--json` 的漂亮输出用 `tail -1` 取字段。
