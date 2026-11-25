# 插件前端 API 重构计划（app.host / app.settings / envBadge）

> 状态：**已实施**（2026-10-19：W0–W3 落地；证据见 §10）
> 日期：2026-10-18
> 依据：`docs/PLUGIN-ARCH-REVIEW.md` 的复核结论 + 对当前源码的逐文件核对
> 前置：插件与应用**同仓同发版**；当前**没有外部用户**，允许破坏性改动；`plugins/*` 一起迁移
> 目标：把「插件前端能用什么、怎么用、什么时候失效」变成可测试的契约；**不做同 realm 的假安全**

---

## 0. 决策摘要

| 主题 | 决定 |
|---|---|
| 组件库 | 继续暴露 `app.ui`，不 vendor shadcn。这条不变 |
| `app.host` | **不做通用 Proxy**。改成显式、只读、带窄 DTO 的 host 门面 |
| 宿主能力读取 | 只放白名单里的读路径；写操作、`settings.get`、`vault.*`、`storage.*`、`browser.snapshot`、`browser.waitFor*` 都不进 |
| 环境绑定 | 每次调用显式带 `environmentId`，或 `app.host.forEnvironment(envId)`；禁止靠共享可变上下文猜环境 |
| 调用级上下文 | 先修 `PluginHost.#envContext`：改成调用级上下文；sandbox 用 `AsyncLocalStorage`，host 运行时把 invocation id 传回主进程 |
| `app.settings` | 不新增 `plugin:settings` IPC。把当前插件自己的 `PluginSettingValue[]` 作为 `app.settings` 暴露；需要刷新就用现有 `window.envApi.plugins()` |
| `envBadge` | 升级成正式 surface：清单声明 `kind: "envBadge"`，前端注册后拿到 setter；不能靠一个隐式 `app.setEnvBadge` |
| badge 状态 | renderer-only 的小 store；按 `pluginId + digest` 保 generation；disable/uninstall 清理；不跨 IPC，不放 `shared/types.ts` |
| 同 realm 信任边界 | 如实写清：插件前端能调用整个 `window.envApi`，也能借 `pluginRpc` 调别的插件；**这不是安全边界**。真正的插件间隔离要另开 iframe 架构，不在本计划 |
| API 版本 | 破坏性改动直接升到 `apiVersion: "3"`；bundled plugins 一起改。旧 v1/v2 兼容是否保留见 §4.3 |
| 生命周期 | 顺手修 `reload`：候选先启动成功再替换旧实例；旧实例失败不消失 |
| 文档 | 本计划落地后，把决策并进 `docs/PLUGIN-CAPABILITY-DESIGN.md` 与 `docs/HANDOFF.md`；不把 transient review 塞进 `AGENTS.md` |

---

## 1. 现状复核（2026-10-18）

这一节只列与本计划直接相关的证据。行号会随改动漂移，改动时以文件内容为准。

### 1.1 插件前端 API 现状

- `src/renderer/lib/plugin-runtime.ts:237` 的 `PluginAppApi` 目前只有：
  `pluginId` / `React` / `h` / `ui` / `rpc.call` / `useSignal` / `log` / `surfaces`。
- `createApi()`（`src/renderer/lib/plugin-runtime.ts:277`）按 `plugin.contributes.surfaces` 做 fail-closed 校验；
  `railPage` / `settingsSection` / `inspectorTab` 都走 `accept(kind, id)`。
- `loadPluginApps()`（`src/renderer/lib/plugin-runtime.ts:364`）在每次 `stateTick` 时重跑；
  `bundleCache` 只缓存 import，`register(app)` 会重新执行，registry 整体替换。
- `window.__WARREN__` 目前只有 `React` / `h` / `ui`（`src/renderer/lib/plugin-runtime.ts:404`），
  没有 `rpc` / `host` / `settings` / badge。

### 1.2 宿主 host API 现状

- `src/main/plugins/api.ts:59` 的 `BROWSER_CAPABILITIES` 是**浏览器能力的单一来源表**，
  每条带 `permission` 和可选 `write`。
- 表外还有大量手写 handler：`environment.list/get/update/start/stop`、
  `browser.openTab/console/network`、`vault.listRefs/fill`、
  `storage.kv.*` / `storage.sql.*`、`settings.get`。
- `settings.get`（`src/main/plugins/api.ts:386`）返回 `deps.settings.get(...)`；
  `PluginSettings.get()`（`src/main/plugins/settings.ts:147`）对 `secret` 类型会 `vault.reveal(...)`，
  也就是**明文**。
- `environment.list`（`src/main/plugins/api.ts:212`）返回 `manager.list()` 的完整 `Environment`；
  `EnvironmentManager.#decorate()`（`src/main/environments.ts:373`）会带上
  `leaseId` / `leaseExpiresAt`（`:383`）、`storagePath`、`tabs`、favicon 等。
- `environment.update/start/stop`（`src/main/plugins/api.ts:228` 起）只要求 `environment.write`，
  **故意不挂 lease**；browser 写操作才走 `withLease`（`src/main/plugins/api.ts:173`）。

### 1.3 环境上下文现状

- `PluginHost.#envContext` 是 **per-plugin** 的可变对象：`src/main/plugins/host.ts:106`。
- `rpc()` 每次调用前写同一个对象：`src/main/plugins/host.ts:633`；
  `run()` 同样写它：`src/main/plugins/host.ts:578`。
- `api.ts` 的 `env()` 从 `deps.environment.id` 读：`src/main/plugins/api.ts:163`。
- 结论：同一插件的两个并发调用会互相覆盖环境；一个调用可能在另一个环境上执行。
  这不是 `app.host` 带来的新问题，但 `app.host` 会把它放大。

### 1.4 插件身份与 IPC 现状

- `src/preload/preload.ts:66` 把 `pluginRpc(id, method, input)` 直接暴露给渲染层。
- `src/main/main.ts:381` 原样透传；`src/main/plugins/host.ts:613` 只校验：
  目标插件 enabled、方法在**目标插件**的 `contributes.rpc` 里、目标插件 active。
- 没有调用方身份校验。插件 B 可以直接 `window.envApi.pluginRpc("插件A", ...)`。
- `RPC_METHOD_RE`（`src/main/plugins/manifest.ts:54`）允许点号，所以 `host.foo` 这种名字
  本来就是合法 rpc 方法名；如果用 `host.` 前缀做宿主转发，还会和插件自己的方法撞名。

### 1.5 设置现状

- `PluginHost.#decorate()`（`src/main/plugins/host.ts:225`）已经给每个插件生成
  `settings: PluginSettingValue[]`。
- `PluginSettingValue`（`src/shared/types.ts:418`）的 `secret` 只有 `configured`，没有 `value`。
- `window.envApi.plugins()` 已经能拿到这份数组（`src/shared/types.ts:680`）。
- 所以文档里「设置只能走自己的 rpc 转发」是**不准确**的；现状是「有一条没文档化的现成通道」。

### 1.6 环境行现状

- 行内容在 `src/renderer/features/environments/environment-sidebar.tsx:319`：
  状态块 + 名字（`flex-1 min-w-0`）+ 归属图标 + 审批图标 + 出口（`max-w-[40%]`）+ 动作按钮。
- 再加一个固定宽度徽章一定会挤名字；「名字仍然完整」不是可达验收。

### 1.7 生命周期现状

- `PluginHost.reload()`（`src/main/plugins/host.ts:386`）是 `#deactivate()` → `#readManifest()` → `#activate()`。
- 新实例激活失败时，旧实例已经被停掉；这和 BB「先验证候选再切换」不一致。
- `#activate()` 内部 catch 错误并写 status，不会向 `reload()` 抛出；调用方只能从 status 看失败。

### 1.8 清单与版本现状

- `SUPPORTED_API_VERSIONS = ['1', '2']`（`src/main/plugins/manifest.ts:1`）。
- `SURFACE_KINDS` 只有 4 种（`src/main/plugins/manifest.ts:49`），
  `PluginSurfaceKind` 同样（`src/shared/types.ts:429`）。
- `plugins/README.md` 说的是「加是加法，改 / 删要走 `apiVersion`」；
  `docs/PLUGIN-ARCH-REVIEW.md` §4 写的是「增删改 = 改 `apiVersion`」。两处口径冲突。

### 1.9 现有消费者

- `example-notes`：
  - `stats` 从后端读 `settings.get()` 并把 `title` / `filter` / `hasApiKey` 塞回前端
    （`plugins/example-notes/index.js:386`）。
  - `pageInfo` 一次返回 `url` + `title` + 计数（`plugins/example-notes/index.js:407`）。
  - 前端已经有 `InspectorTab`（`plugins/example-notes/app.js:376`）和 rail page。
- `whistle`：
  - 它自己的 `list` 已经返回 `environments`（`plugins/whistle/host.mjs:262`；
    `plugins/whistle/app.js:45`）。
  - 所以「whistle 的环境列表改 `app.host.environment.list()`」这个前提是错的。

---

## 2. 目标设计

### 2.1 信任模型：先说清楚不是什么

Warren 的插件前端跑在**应用窗口同一个 realm**里。它天然可以：

- 访问整个 `window.envApi`；
- 调 `window.envApi.pluginRpc(其他插件 id, ...)`；
- 读/写应用界面的 DOM；
- 监听 `state:changed` / `plugin:signal`。

因此：

1. **插件权限模型不是安全边界**。它防的是合作型插件的误用和越权调用，不是恶意代码。
2. **跨插件身份不可验证**。同 realm 里没有可靠办法证明「这次 `pluginRpc` 是插件 A 发的」。
   用 token 也只是把门槛抬高，不是安全隔离——因为发 token 的入口同样在同一个 realm。
3. 如果将来要真正的插件间隔离，必须把插件前端放进**独立 origin 的 iframe / 独立 renderer**，
   用 `postMessage` + 最小桥接 API。代价是失去直接注入 `app.ui` 的便利，
   要么给 iframe 再做一套组件注入，要么插件自己 bundle UI。**不在本计划**。

本计划的所有「门控」都按这个前提写：它们是**契约和误用防护**，不是安全承诺。

### 2.2 `app.host`：显式、只读、窄 DTO

**不做** `app.host` 通用 Proxy。改成显式对象 + 白名单。

#### 2.2.1 公开形状

```ts
// 渲染层给插件前端的类型（放在 renderer 侧类型里；不是 RPC 边界）
export interface PluginHostApi {
  environment: {
    list(): Promise<HostEnvironmentSummary[]>;
    get(id: string): Promise<HostEnvironmentSummary | null>;
  };
  browser: {
    info(environmentId: string): Promise<{ url: string; title: string }>;
  };
}
```

`HostEnvironmentSummary` 是跨 IPC 的窄类型，放 `src/shared/types.ts`：

```ts
export interface HostEnvironmentSummary {
  id: string;
  name: string;
  status: EnvironmentStatus;
  proxy?: string;
  owner: ControlOwner;
  groupId?: string;
  currentUrl?: string;
  title?: string;
  error?: string;
}
```

**明确不返回**：`leaseId`、`leaseExpiresAt`、`storagePath`、`trustedCa`、`tabs`、favicon。

#### 2.2.2 白名单

第一版只放这几条：

| 方法 | 权限 | 说明 |
|---|---|---|
| `environment.list` | `environment.read` | 返回窄 DTO 数组 |
| `environment.get` | `environment.read` | 返回窄 DTO 或 `null` |
| `browser.info` | `browser.dom.read` | 返回 `{ url, title }`，必须显式传 `environmentId` |

**明确不放**：

- 所有写：`environment.update/start/stop`、`browser.navigate/click/fill/...`、`browser.openTab`、
  `cookie.*`、`vault.fill`；
- 秘密：`settings.get`、`vault.listRefs`（要凭据列表就自己后端 rpc，或者以后单独设计窄通道）；
- 插件自己的数据：`storage.kv.*`、`storage.sql.*`；
- 重 / 副作用：`browser.snapshot`、`browser.screenshot`、`browser.highlight`、`browser.waitFor*`；
- 日志 / 事件：`log.*`、`events.emit`、`ui.notify`、`signal.publish`。

白名单是**单一来源常量**，例如新建 `src/shared/plugin-host-api.ts`：

```ts
export const PLUGIN_HOST_READ_METHODS = ['environment.list', 'environment.get', 'browser.info'] as const;
export type PluginHostReadMethod = (typeof PLUGIN_HOST_READ_METHODS)[number];
```

main 和 renderer 都从这里取。新增方法要同时改这张表和测试，避免「renderer 有、main 没有」。

#### 2.2.3 IPC 与主进程分发

不要用 `host.` 前缀塞进 `plugin:rpc`。新增一个明确的内部通道：

```
plugin:hostRead { pluginId, method, environmentId?, args? }
  -> { ok: true, result } | { ok: false, code, message }
```

- main 侧只接受 `PLUGIN_HOST_READ_METHODS` 里的 `method`；
- 每条落到一个**专用的只读 handler 表**，不经过 `createHandlers()` 的全量表；
- 每条自己做 `require(permission)`；
- `browser.info` 缺 `environmentId` → `PLUGIN_NO_ENVIRONMENT`；
- 未知环境 → `ENV_NOT_FOUND`；环境没跑 → `ENV_NOT_RUNNING`；
- 未知方法 → `PLUGIN_HOST_METHOD_UNKNOWN`；白名单外的已知方法 → `PLUGIN_HOST_METHOD_FORBIDDEN`。

> 同 realm 的插件当然可以绕过 `app.host` 直接调这个 IPC。这不是漏洞，是 §2.1 的边界。
> 白名单的意义是：合作型插件拿不到危险路径；文档和测试能钉住「我们只承诺这些」。

#### 2.2.4 环境绑定

`app.host.browser.info(environmentId)` 显式传环境。`register(app)` 是插件级 API，
它不知道当前 surface / 当前选中环境，所以**不能**提供无参 `app.host.browser.url()`。

如果以后要少写参数，可以加：

```ts
app.host.forEnvironment(environmentId).browser.info()
```

但这只是语法糖；底层仍然是显式环境。

### 2.3 调用级环境上下文（先修根问题）

目标：删掉 `PluginHost.#envContext`，让「这次调用属于哪个插件、哪个环境」跟调用走，而不是跟插件走。

#### 2.3.1 主进程侧

在 `PluginHost` 里用 `AsyncLocalStorage`：

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

interface PluginCallContext {
  pluginId: string;
  environmentId?: string;
}

#callContext = new AsyncLocalStorage<PluginCallContext>();
```

- `run()` / `rpc()` 把 `adapter.command()` / `adapter.rpc()` 包进 `this.#callContext.run({...}, ...)`。
- `createHandlers()` 的 `HostApiDeps` 不再拿一个可变的 `environment` 对象，
  改成 `currentEnvironmentId: () => string | undefined`；
  `api.ts` 的 `env()` 读这个 getter。
- sandbox 运行时天然继承 ALS 上下文。

#### 2.3.2 host 运行时侧

host 运行时的 host API 调用是子进程 → 主进程的 JSON-RPC，必须把调用上下文一起带回来。

方案：

1. `HOST_BOOTSTRAP` 里也建一个 `AsyncLocalStorage`；
2. `invoke` 处理时 `als.run({ invocationId: message.id }, () => handler(...))`；
3. `callHost()` 发消息时带上 `parent: als.getStore()?.invocationId`；
4. 主进程 `HostRuntime` 维护 `invocationId -> PluginCallContext`；
5. 收到 `host-call` 时，用 `parent` 找回上下文，在 `#callContext.run(context, ...)` 里执行
   `onHostCall`。

这样 `host.browser.url()` 在 host 运行时里也能拿到「这次调用绑定的环境」。

#### 2.3.3 测试

新增 `tests/plugin-context.test.ts`：

- 用假 manager + 假 adapter，并发调两个不同环境；
- 在 handler 里记录 `currentEnvironmentId()`；
- 断言两次调用各拿到自己的环境，不串。

如果不想一次改 host-call 协议，可以先用**per-plugin 串行队列**过渡，
但要写清楚：它会让一个 30s 的 `browser.waitFor` 阻塞同插件其它调用，不作为终态。

### 2.4 `app.settings`：用现成数据，不新增 IPC

#### 2.4.1 公开形状

```ts
export interface PluginAppApi {
  // ...
  settings: PluginSettingValue[];
  useSettings(): {
    values: PluginSettingValue[];
    isLoading: boolean;
    refresh(): Promise<void>;
  };
}
```

- `settings` 是**当前插件自己的** `PluginSettingValue[]`，由 `createApi(plugin, ...)` 直接放进 app。
- `secret` 仍然只有 `configured`，没有 `value`。
- `useSettings()` 是便利 hook：默认返回 `app.settings`；
  `refresh()` 用现有 `window.envApi.plugins()` 找到自己的 id 并更新一份 renderer 内快照。
  不新增 `plugin:settings` IPC，也不返回别的插件的设置。

#### 2.4.2 为什么不做新 IPC

- `plugin:list` 已经返回 settings；
- 设置变更本来就会触发插件 `reload()` + `state:changed`；
- 多一条 IPC 就多一份真相源和一份 secret 过滤逻辑，收益为零。

#### 2.4.3 notes 迁移

- `stats` 只留计数；
- `title` / `filter` / `hasApiKey` 前端从 `app.settings` / `useSettings()` 读；
- `pageInfo` 保留（一次返回 url + title + count），或改成单个 `browser.info()` + 自己的 count，
  **不要**前端分别调 url 和 title。

### 2.5 `envBadge`：正式 surface

#### 2.5.1 清单声明

`PluginSurfaceKind` 增加 `envBadge`：

```ts
export type PluginSurfaceKind =
  | 'railPage'
  | 'settingsSection'
  | 'envAction'
  | 'inspectorTab'
  | 'envBadge';
```

manifest 例子：

```json
{
  "kind": "envBadge",
  "id": "todos",
  "title": "待办数",
  "icon": "List"
}
```

校验要求：

- 声明了 `envBadge` 必须声明 `ui.mount`（和其它 surface 一致）；
- `id` / `title` 必填；`icon` 可选但必须是宿主 `Icon` 注册表里的名字；
- 前端注册时必须 `accept('envBadge', id)`，清单没声明就拒绝加载。

#### 2.5.2 前端 API

```ts
app.surfaces.envBadge({
  id: 'todos',
  title: '待办数',
  icon: 'List',
}).set(envId, { label: '3', tone: 'info' });
// 或
set(envId, null); // 清掉这个环境的徽章
```

类型：

```ts
// renderer-only，放在 plugin-runtime / plugin-badges 模块，不放 shared
export interface PluginEnvBadge {
  icon?: string;
  label: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}
```

校验放在 setter：

- `label` 长度 ≤ 3（按文档定死；超过就截断或报错，不要让它把行撑开）；
- `icon` 不存在就 fallback 到默认图标，或者直接报错；二选一，测试钉住；
- `envId` 不存在就忽略并记一条 debug 日志；
- 相同值重复 set 直接 no-op，避免无意义的 React 更新。

#### 2.5.3 badge store

新建 renderer-only 模块，例如 `src/renderer/lib/plugin-badges.ts`：

```ts
interface PluginBadgeState {
  generation: number;
  envs: Map<string, PluginEnvBadge>;
}

const state = new Map<string, PluginBadgeState>(); // key = pluginId
```

规则：

- 每次 `loadPluginApps()` 为每个插件算一个 load key：`pluginId@digest`；
- **同一个 digest 重新 register 不清 badge**；digest 变了 / disable / uninstall 才清；
- setter 闭包捕获 generation，stale setter 的调用被忽略；
- `loadPluginApps()` 结束时 prune 掉不再 enabled 的插件；
- App 用 `useSyncExternalStore` 订阅，行组件通过 hook 读；
- 不把 badge 状态放 `shared/types.ts`：它不跨 IPC，放 shared 违反项目的类型放置规则。

#### 2.5.4 渲染规则

- 一个环境一个槽；多插件都设了时，按 **pluginId 字典序**取第一个（稳定、可预测），
  其余进行 title / tooltip；
- 同一个插件声明了多个 `envBadge` surface 时，按 surface 声明顺序取第一个；
- 槽位放在现有右侧簇里：状态点 → 名字 → 归属 → 审批 → **badge** → 出口 → 动作；
- badge 出现时，出口 `max-w` 从 40% 降到 28%；名字保持 `flex-1 min-w-0`；
- 侧栏宽度 < 240px 时只渲染 badge 的 icon / dot，完整 label 进 title；
- 行高、动作按钮位置不变。

验收改成可测量的：

- 行高不变；
- 动作按钮 x 不变；
- 名字宽度不小于 60px；
- 出口列不因为 badge 出现而跳位；
- `plugin disable` 后 badge 立刻消失。

### 2.6 `reload`：候选先起，成功再换

`PluginHost.reload()` 改成两阶段：

1. 读新 manifest，构造候选 adapter / storage / settings；
2. 启动候选并等 `activate` 成功；
3. 成功：替换 `#active`，dispose 旧实例；
4. 失败：保留旧实例，写 `plugin.reload.failed` 事件 / status detail，旧界面继续可用。

这不是前端 API 的直接依赖，但它影响「插件升级失败会不会把用户界面弄没」，建议一起做。

### 2.7 `apiVersion` 与清单

建议直接升到 `apiVersion: "3"`：

- `PluginAppApi` 增加 `host` / `settings` / `surfaces.envBadge`，是公共面变化；
- `PluginSurfaceKind` 增加 `envBadge`，是清单 schema 变化；
- 当前没有外部用户，bundled plugins 一起改最省事；
- 是否保留 v1/v2 见 §4.3。

同时把版本纪律写成：

- **加法**：不 bump；插件可以继续用旧字段；
- **删除 / 改语义**：bump，并在 README 写迁移说明；
- `app.apiVersion` 暴露当前前端 API 版本，方便插件做特性检测。

---

## 3. 分期实施

### W0：底层正确性（先做，不碰 UI）

目标：让后面的 `app.host` 不踩雷。

- [ ] 把 `PluginHost.#envContext` 换成 `AsyncLocalStorage` 调用级上下文；
- [ ] host 运行时 host-call 带 `parent` invocation id，主进程按上下文执行；
- [ ] `HostApiDeps` 的 `environment` 改成 `currentEnvironmentId()`；
- [ ] 新增 `tests/plugin-context.test.ts`：并发两环境不串；
- [ ] 在 `plugins/README.md` 写清同 realm 信任边界：`window.envApi`、跨插件 `pluginRpc`、
      以及「权限不是安全边界」；
- [ ] `docs/PLUGIN-ARCH-REVIEW.md` 的「不是提权」表述改掉。

验收：

```bash
node --test tests/plugin-context.test.ts
npm test
npx tsc --noEmit
```

### W1：`app.host` 只读门面 + `app.settings`

目标：把 notes / whistle 真正需要的东西补上，但不做通用 Proxy。

- [ ] `src/shared/plugin-host-api.ts`：白名单常量 + `PluginHostReadMethod`；
- [ ] `src/shared/types.ts`：`HostEnvironmentSummary`；
- [ ] `src/main/plugins/host-read.ts`（新）：专用只读 handler 表；
- [ ] `src/main/main.ts`：`plugin:hostRead` IPC；
- [ ] `src/preload/preload.ts` + `EnvApi`：内部 `pluginHostRead`；
- [ ] `src/renderer/lib/plugin-runtime.ts`：`PluginAppApi.host` 显式对象 + `settings` / `useSettings`；
- [ ] `plugins/example-notes/index.js`：`stats` 只留计数；
- [ ] `plugins/example-notes/app.js`：settings 从前端读；
- [ ] `plugins/whistle/*`：**不改**（它自己的 list 已经返回 environments）；
- [ ] `plugins/README.md`：写 `app.host` 白名单、环境绑定、只读边界。

验收：

```bash
node --test tests/plugin-host-api.test.ts
npx tsc --noEmit
node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
```

### W2：`envBadge` surface

目标：把行状态芯片做成正式 surface，并让 notes 真正用起来。

- [ ] `src/shared/types.ts`：`PluginSurfaceKind` 加 `envBadge`；
- [ ] `src/main/plugins/manifest.ts`：`SURFACE_KINDS` 加 `envBadge`，校验 icon / title；
- [ ] `src/renderer/lib/plugin-runtime.ts`：`surfaces.envBadge` + `accept`；
- [ ] `src/renderer/lib/plugin-badges.ts`（新）：badge store + generation + prune；
- [ ] `src/renderer/app/App.tsx`：接 store；
- [ ] `src/renderer/features/environments/environment-sidebar.tsx`：单槽渲染、窄侧栏降级；
- [ ] `plugins/example-notes/*`：`envBadge` 显示未完成待办数；
- [ ] `tests/plugin-badge.test.ts`：generation / 排序 / 清理 / label 截断。

验收：

```bash
node --test tests/plugin-badge.test.ts
npm run lint
npm run format:check
npx tsc --noEmit
npm test
node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
```

实机（应用 + fixture 起着）：

```bash
node bin/warren.mjs call debug.rendererEval '{"script":"..."}'
```

要测：

- notes 打开时环境行出现「待办 N」；
- `plugin disable com.example.notes` 后徽章立刻消失；
- 两个插件都设 badge 时，赢家稳定；
- 侧栏收窄时 badge 降级为 dot / icon；
- 行高、动作按钮位置不变。

### W3：收尾与可靠性

- [ ] `PluginHost.reload()` 改两阶段；
- [ ] 如果决定升 v3：更新所有 `plugins/*/manifest.json` 的 `apiVersion`，
      更新 `tests/plugin-v2.test.ts`（或改名 `plugin-manifest.test.ts`）；
- [ ] 更新 `docs/PLUGIN-CAPABILITY-DESIGN.md`、`docs/HANDOFF.md`；
- [ ] 跑全量回归：

```bash
bash scripts/regress/run-all.sh
```

- [ ] 检查 `plugins/README.md` 里「安装对话框」措辞与实际 UI（`PluginsPanel` 顶部 Alert）一致。

---

## 4. 破坏性改动与迁移

### 4.1 前端公共面

| 变化 | 旧 | 新 |
|---|---|---|
| `app.host` | 无 | 显式只读对象，白名单方法 |
| `app.settings` | 无（但可走 `envApi.plugins()`） | 当前插件自己的 `PluginSettingValue[]` |
| `app.useSettings()` | 无 | 基于 `app.settings` 的便利 hook |
| `app.surfaces.envBadge()` | 无 | 声明式 surface + setter |
| `app.apiVersion` | 无 | `"3"` |

### 4.2 清单

- `PluginSurfaceKind` 加 `envBadge`；
- `normalizeSurfaces()` 对 `envBadge` 校验 `title` / `icon`；
- `contributes.rpc` 保留，但明确不允许 `host.` / `app.` 前缀（避免和未来命名空间撞）；
- `apiVersion` 升 3（如果按推荐执行）。

### 4.3 v1 / v2 兼容

两个选项：

1. **推荐**：只支持 v3。删除 v1/v2 兼容分支和对应测试；
   bundled plugins 全部改成 v3。理由：没有外部用户，保留兼容只会留两套语义。
2. 保守：保留 v1/v2 读取，但 v3 才给新前端 API。
   代价是 `manifest.ts` 继续维护旧分支，测试继续覆盖三套。

本计划按选项 1 写；如果实际执行时发现成本高于预期，可以退回选项 2，但要在文档里写清。

### 4.4 bundled plugins

- `plugins/example-login`：manifest 升 3；不需要新 API。
- `plugins/example-host`：manifest 升 3；不需要新 API。
- `plugins/example-cookies`：manifest 升 3；不需要新 API。
- `plugins/example-notes`：
  - manifest 升 3；
  - 加 `envBadge` surface；
  - `stats` 只留计数；
  - 前端用 `app.settings` / `useSettings()`；
  - badge setter 显示未完成待办数。
- `plugins/whistle`：manifest 升 3；**不改逻辑**。

---

## 5. 逐文件改动清单

| 文件 | 改动 |
|---|---|
| `src/shared/plugin-host-api.ts`（新） | 只读白名单常量 + 方法类型 |
| `src/shared/types.ts` | `HostEnvironmentSummary`；`PluginSurfaceKind` 加 `envBadge`；`EnvApi` 加内部 `pluginHostRead` |
| `src/main/plugins/host-read.ts`（新） | 专用只读 handler 表；窄 DTO 投影；权限检查 |
| `src/main/plugins/api.ts` | `HostApiDeps.environment` → `currentEnvironmentId()`；`env()` 改读 getter |
| `src/main/plugins/host.ts` | 删 `#envContext`；加 `AsyncLocalStorage`；`run()` / `rpc()` 包上下文；两阶段 `reload()` |
| `src/main/plugins/runtime.ts` | `HOST_BOOTSTRAP` 的 `callHost` 带 `parent`；`HostRuntime` 维护 invocation context |
| `src/main/plugins/manifest.ts` | `envBadge` surface 校验；v3 版本策略；保留 `host.` / `app.` 前缀校验 |
| `src/main/main.ts` | `plugin:hostRead` IPC；保持 `plugin:rpc` 为插件自己的方法 |
| `src/preload/preload.ts` | 暴露内部 `pluginHostRead`；更新 `EnvApi` |
| `src/renderer/lib/plugin-runtime.ts` | `PluginAppApi.host` / `settings` / `useSettings` / `surfaces.envBadge`；`accept` |
| `src/renderer/lib/plugin-badges.ts`（新） | badge store、generation、prune、排序、订阅 |
| `src/renderer/app/App.tsx` | 订阅 badge store；把 badge 传给 sidebar |
| `src/renderer/features/environments/environment-sidebar.tsx` | 单槽 badge 渲染；窄侧栏降级；行 title 汇总 |
| `plugins/example-notes/index.js` | `stats` 只留计数；保留 / 调整 `pageInfo` |
| `plugins/example-notes/app.js` | 用 `app.settings` / `useSettings()`；注册 `envBadge` |
| `plugins/example-notes/manifest.json` | `apiVersion: "3"`；加 `envBadge` surface |
| `plugins/whistle/manifest.json` | `apiVersion: "3"`；逻辑不动 |
| `plugins/*/manifest.json` | 其余 bundled plugins 升 v3 |
| `plugins/README.md` | `app.host` 白名单、`app.settings`、`envBadge`、同 realm 边界、安装前信任说明 |
| `tests/plugin-context.test.ts`（新） | 并发环境不串 |
| `tests/plugin-host-api.test.ts`（新） | 白名单、权限、窄 DTO、禁止 `settings.get` |
| `tests/plugin-badge.test.ts`（新） | generation、排序、清理、label 截断 |
| `tests/plugin-v2.test.ts` | 改成 v3 / `plugin-manifest.test.ts`（按 §4.3 决定） |
| `docs/PLUGIN-CAPABILITY-DESIGN.md` | 把本计划的最终设计并进去 |
| `docs/HANDOFF.md` | 当前状态 / 踩坑 / 接手点更新 |

---

## 6. 验收

### 6.1 静态门（强制）

```bash
npm run lint
npm run format:check
npx tsc --noEmit
npm test
node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
```

### 6.2 新增单测

```bash
node --test tests/plugin-context.test.ts
node --test tests/plugin-host-api.test.ts
node --test tests/plugin-badge.test.ts
```

必须钉住：

- `PLUGIN_HOST_READ_METHODS` 里没有 `settings.get`、`vault.*`、`storage.*`、任何写路径；
- `environment.list` 的结果没有 `leaseId` / `storagePath` / `tabs`；
- `browser.info` 缺 environmentId 时报 `PLUGIN_NO_ENVIRONMENT`；
- 两个并发调用不同环境时，各自拿到自己的环境；
- badge 同 digest 重注册不清、digest 变化清、disable 清；
- 多插件 badge 顺序稳定；
- label 超过 3 字符按约定截断或报错。

### 6.3 实机 / 回归

```bash
bash scripts/regress/run-all.sh
```

实机 `debug.rendererEval` 至少验证：

- `app.host.environment.list()` 返回的字段只有窄 DTO；
- `app.host.settings.get()` 不存在 / 被拒；
- notes 行 badge 出现 / 消失；
- 多插件 badge 赢家稳定；
- 收窄侧栏时 badge 降级，行高和动作按钮位置不变。

---

## 7. 不做什么

| 不做 | 理由 |
|---|---|
| 通用 `app.host` Proxy | 会把 `settings.get` 等危险路径变成公共 API；无法类型化 / 文档化 |
| `plugin:settings` 新 IPC | `plugin:list` 已经有数据；新增只会多一份真相源 |
| 同 realm 的 per-plugin token | 同 realm 里拿 token 的入口同样可被调用；是假安全 |
| iframe / 独立 renderer 插件前端 | 真正隔离要另开架构；代价是失去直接注入 `app.ui` |
| whistle 环境列表改 `app.host` | 它的 `list` 已经返回 environments |
| 把这份计划塞进 `AGENTS.md` 文档表 | 决策落地后并进 `PLUGIN-CAPABILITY-DESIGN.md` / `HANDOFF.md` 更合适 |
| 给没有消费者的新 slot | 只做 `envBadge`；其它等真实消费者 |

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| host 运行时的 ALS 上下文传播容易写错 | 先写 `tests/plugin-context.test.ts`，再做 host-call `parent`；没有测试不上线 |
| badge generation 在每次 `stateTick` 被误清 | load key 用 `pluginId@digest`；同 digest 不清；测试钉住 |
| badge 挤名字 | 单槽 + 窄侧栏降级 + 出口 max-w 调整 + 可测量验收 |
| v3 破坏旧清单 | 当前无外部用户；bundled plugins 一起改；README 写迁移 |
| `app.host` 被误当安全边界 | README / 安装前信任说明 / 代码注释都写「同 realm，不是安全边界」 |
| reload 两阶段引入竞态 | 先做候选启动 + 旧实例保留；失败写事件；单测覆盖失败路径 |

---

## 9. 参考

- `docs/PLUGIN-ARCH-REVIEW.md`：本计划的来源复核
- `docs/PLUGIN-CAPABILITY-DESIGN.md`：插件系统设计
- `docs/PLUGIN-MODERNIZATION-PLAN.md`：v2 落地记录
- `plugins/README.md`：插件作者入口
- `src/main/plugins/api.ts`、`src/main/plugins/host.ts`、`src/main/plugins/runtime.ts`
- `src/renderer/lib/plugin-runtime.ts`、`src/renderer/features/environments/environment-sidebar.tsx`
- `plugins/example-notes/*`、`plugins/whistle/*`

---

## 10. 实施记录（2026-10-19）

| 项 | 结果 |
|---|---|
| 调用级上下文 | `src/main/plugins/call-context.ts` + `PluginHost` / `HostRuntime` 接线；`tests/plugin-context.test.ts` 并发两环境不串 |
| `app.host` 只读白名单 | `src/shared/plugin-host-api.ts` + `src/main/plugins/host-read.ts` + `plugin:hostRead`；`environment.list` 只回窄 DTO；`settings.get` 被拒（实机 `PLUGIN_HOST_METHOD_UNKNOWN`） |
| `app.settings` | `PluginAppApi.settings` / `useSettings()`；无新 IPC；notes `stats` 只留计数 |
| notes 迁移 | 删掉后端 `pageInfo`；检查器页直接用 `app.host.browser.info(envId)` 读 URL / 标题 |
| `envBadge` | `PluginSurfaceKind` 加 `envBadge`；`app.surfaces.envBadge` + renderer store；notes 环境行实测出现「1」，`plugin disable` 后实测清空 |
| 两阶段 reload | `reload` 候选先启动成功再替换；失败保留旧实例 |
| `apiVersion` | 当前 `3`；`2` 兼容，`1` 拒绝；bundled plugins 全部升 3 |
| 静态门 | `npm run lint` / `npm run format:check` / `npx tsc --noEmit` / `npm test`（234 pass）/ renderer build 全过 |
| 全量回归 | `bash scripts/regress/run-all.sh`：**147 PASS / 0 FAIL**（含重启后的新主进程代码） |
