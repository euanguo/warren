---
name: warren
description: Operate Warren's isolated Person and Agent browser spaces to inspect accessibility snapshots, interact with SPAs, capture telemetry, or debug sites with per-environment proxies and credentials. Use when a task needs a persistent browser session, logged-in state, real rendering, or background UI automation; skip for stateless HTTP requests better served by curl or API unit tests.
---

# Warren

Warren 是本地隔离浏览器工作台。每个 **Environment** 拥有独立存储（Cookie、localStorage、登录态）、代理出口与两个共享身份但独立 Tab 集合的 **Space**：

- **Person Space**：人的工作区，永久由人控制，无需 lease。
- **Agent Space**：Agent 的工作区，写操作使用独立 lease。两者共用浏览会话且互不阻塞。

## 核心规则与边界

1. **显式寻址**：始终传 `<env>`。界面选中环境不等于拥有写权限（部分 `browser`/`notes` 命令可用 `WARREN_ENV` 缺省指定，多环境并发时仍显式传参）。
2. **仅操作 Agent Space**：只在 Agent Space 建 Tab 与读写页面。`--space=person` 与 `env takeover` 属于人工诊断入口，非用户明确要求不得调用。
3. **写操作持锁与托管收尾**：所有页面改动要求 Agent Space 有效 lease（单条 CLI 命令省略 `--lease` 时自动获取并在命令结束后进入思考托管态，蒙层常驻不闪烁；长任务用 `warren env renew` 续期）。**整项浏览器任务全部完成后，调用 `warren env finish <env>` 结束 Agent 空间托管态并撤除蒙层**。当人从界面接管并触发 `CONTROL_REVOKED` 或 `ENV_BUSY` 时，停止写入，向用户确认或使用 `--wait=5000` 等待交还，禁止强抢。
4. **后台静默运行**：Warren 可关闭到托盘并在后台执行点击、键入与可见视口截图（CDP 拿不到 surface 时自动回退 `capturePage()`）。禁止调用 `open -a Warren`、`debug.focusWindow`、`app.focus` 或要求人切前台；仅 `fullPage`/`clip` 截图受后台 surface 可用性限制，失败时如实上报。
5. **CLI 环境即权威字典**：用 `warren help` 查全部命令与参数，用 `warren exec --capabilities` 查脚本 API，用 `warren methods` 查全部 RPC。不要凭记忆臆测未记录子命令或方法名。

## 起步与高效观察

```bash
warren env list
warren env create dev --start-url=http://localhost:3000
warren env start <env>
warren env acquire <env>
warren tab list <env>
warren tab close <env> --agent-only
warren browser open <env> https://example.com --read
warren browser snapshot <env> -i -u --viewport
warren browser read <env> --outline --links --data --content-boundaries
warren env finish <env>
```

- **结构优先 + 默认动作变化回执**：`browser click/fill/select/...` 默认返回紧凑 **Action Delta**（URL/Title 变更、带新 `@N` 的增删改节点、过滤静态资源后的 API 摘要、新弹窗 `text:` 与未处理副作用；需要纯回执时加 `--no-changes`）。`browser snapshot <env> -i` 默认全页并附带视口滚动进度、长列表/连续禁用折叠与每会话首次 `# site-notes`/`# saved-flows` 注入；大页面加 `--viewport` 开启真视口过滤与屏外计数，加 `--no-fold` 展开全部项。`page.snapshot()` 返回结构对象 `{ url, title, nodes }`（截断须先 `JSON.stringify()`）。
- **不可信输出安全**：`snapshot`、`read` 与原子写动作 Delta 默认做终端转义净化并按 `--max-output=12000` 裁剪溢出至 `~/.warren/tmp/`；读取第三方网页正文时保留 `--content-boundaries` 随机 nonce 边界。`@N` ref 跨同容器重绘自动自愈，失败才重拍。
- **并发读取与短横线传值**：`browser read <env> <url1> <url2> --concurrency=4` 或 `--links=<pattern>` 默认在环境隔离离屏读池并发抓取（不扰动当前 Tab，加 `--list` 仅列链接）；`--data` 支持 `--block`/`--fields`/`--where`/`--limit` 切片。值以 `-` 开头时用 POSIX `--` 隔开（如 `warren browser fill <env> @2 -- "--dashed-value"`）。仅在确实需要排版或视觉验证时调用 `warren browser screenshot <env> --annotate`。

## 多步批处理与复用流

- **常规多步连招**用 `warren batch <env> --bail` 一次下发并在稳定后直接返回统一 Action Delta 回执；**复杂条件逻辑或循环探索**用 `warren exec <env>`（自带跨调用持久化 `state`、原子 `checkpoint` 与内置 `help()`）：

```bash
warren batch <env> --bail <<'EOF'
goto http://localhost:3000
fill "#user" "alice"
click "button:has-text(\"登录\")"
snapshot -i
EOF

warren exec <env> --lease=<id> <<'JS'
await page.goto('http://localhost:3000');
const snap = await page.snapshot();
emitResult({ url: snap.url, count: snap.nodes.length });
JS
warren exec --capabilities --detailed
```

- **高频排查与自动 Flow**：环境异常跑 `warren env doctor <env>`；页面报错看 `warren browser console <env>` 与 `warren browser network <env>`；常规操作期间会自动关联录制只读 GET 接口，可用 `warren flow steps <env>` 查看 `s3r1` 引用并用 `warren flow save <name> --env=<env> --output=s3r1 --param=q=shoes` 零模板固化复跑，跨回合站点坑用 `notes` 沉淀。

## exec 里有什么

VM 里的全局就这几个：`page`、`console`、`setTimeout`、`clearTimeout`、`emitResult`、`state`、`checkpoint`、`help`、`sleep`。**没有 `fs`、`require`、`process` 或网络模块**。

- `page` 与 `locator`、`mouse`、`keyboard` 提供 Playwright 子集操控与并发读取 `readAll`，实时能力清单以 `warren exec --capabilities --detailed` 或脚本内 `help()` 为准。
- `state` 为按环境隔离的持久内存对象（跨 `warren exec` 调用与超时/报错自动保留，环境停止或删除后自动清空，可用 `--reset-state` 手动重置）；大结果或跨会话进度用 `checkpoint` 原子落盘。
- `snapshot` 返回 `{ url, title, nodes }` 结构对象而非字符串（截断须先 `JSON.stringify`）；结构化输出用 `emitResult` 传回宿主，或用 `--out=result.json|jsonl|csv` 直接落盘。

没有 `context()`、`expect()`、`route()` 或 `setViewportSize()`。

## 凭据与隐私红线

```bash
warren browser detect-login <env>
```

- 账号凭据统一收拢在「账号管理」插件（`com.warren.accounts`，本地明文存储、受控直填页面）；`storage.cookie.read` / `write` 永久禁用（仅受控 `storage.cookie.port` 允许元数据搬运）。
- 按下方已启用插件索引按需读取 `com.warren.accounts` Skill 后使用 `autoFill` / `fill` 受控填充；**Agent 通道绝不读取或导出密码/TOTP 明文**；账号若配了域名白名单，名单外站点会报 `PATH_DENIED`，未配域名的账号可由 Agent 用 `update` 补齐 `allowedHosts` 后填充（Agent-first）。

## 会改变行为分支的错误码

仅列非自明或改变决策路径的错误；其余目标/超时错误见命令自带 `提示/建议` 与 `warren help`：

| 错误码 | 原因 | 正确处理 |
|---|---|---|
| `TARGET_STALE` | 导航或重绘导致 `@N` 失效 | 重新 `browser snapshot <env> -i` 取新 `@N` |
| `TARGET_AMBIGUOUS` / `TARGET_OCCLUDED` | 命中多元素，或被页面遮罩挡住 | 加 `>> nth=N` / 换具体 `@N`，或先关闭遮挡浮层 |
| `TARGET_NOT_FILLABLE` | 目标不是可输入或可选控件 | 用 `detect-login` 或 `snapshot -i` 重新定位真实控件 |
| `CONTROL_REVOKED` / `ENV_BUSY` | 人接管了环境或他人持锁 | 停止写入询问人，或 `acquire --wait` |
| `SPACE_FORBIDDEN` | Agent 请求或越权操作 `Person Space` | 去掉 `space: "person"`，仅操作 Agent Space |
| `PATH_DENIED` | 路径越界（系统/数据目录），或凭据域名不在已配置的白名单 | 传安全绝对路径；核对站点域，或用账号插件 `update` 补齐允许域名 |
| `ENV_NOT_VISIBLE` | 主窗切到设置/插件全屏页或开着浮层让出了视图 | 关闭浮层或切回环境页（非后台运行问题） |
| `TAB_GONE` | 固定或显式指定的标签已关闭（禁止静默切页） | 运行 `warren tab list <env>` 选择新标签或取消 `--tab` |
| `DIALOG_OPEN` | 页面存在未处理的原生弹窗 | 先 `browser dialog <env> accept` 或 `dismiss` |
| `FLOW_AUTH_EXPIRED` / `FLOW_UNKNOWN_FIELD` | Flow 鉴权过期或过滤字段不存在 | 重新登录目标站点，或按报错列出的可用字段修正 `--where` |
| `CDP_BLOCKED` / `UNSUPPORTED_PAGE_API` | 超出干净 CDP 白名单或调用了不支持的 `page` 方法 | 改用 `page.evaluate`、脚本内 `help()` 或 `warren exec --capabilities --detailed` |

## 插件与自动注入索引

```bash
warren plugin list
warren plugin run <id> <command> --env=<env> --input='{"k":1}'
warren plugin rpc <id> <method> --input='{"k":1}'
warren skills plugin <id>
warren skills refresh
warren help
warren methods
warren --skill --full
```

插件通过 `package.json#warren`（`apiVersion: "4"`）接入。仅在用户需要对应插件能力时安装或变更权限；启用插件的触发场景与手册路径会自动维护在下方围栏内：

<!-- warren:enabled-plugins:begin -->
当前为静态基线模板；运行 `warren --skill` 或同步本地 Skill（`warren skills refresh`）后，本区会自动列出全部已启用插件的触发场景与完整手册路径。
<!-- warren:enabled-plugins:end -->
