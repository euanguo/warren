# Space 与后台常驻改造

> 状态：执行中
> 日期：2026-10-20
> 目标：引入 Environment > Space > Tab；Person Space 始终可操作；Agent Space 独立控制；应用可隐藏到托盘继续工作。

## 1. 模型

```text
Environment = 身份 / Session / Cookie / 代理 / 存储边界
  ├─ Person Space（固定，owner=human）
  └─ Agent Space（固定，owner=agent | human | none）
```

不变量：

- Space 是**控制隔离**，不是 Cookie / localStorage 隔离。两个 Space 共享 Environment Session。
- Person Space 永远不需要 lease；人始终可以新建、关闭、切换、导航自己的 Tab。
- Agent Space 默认属于 Agent。Agent 的写操作只落在 Agent Space。
- 人接管 Agent Space 后，Agent 的下一次写操作报 `CONTROL_REVOKED`。
- 人交还 Agent Space 后，Agent 才能重新 acquire。
- 人查看 Agent Space 不等于接管；未接管时只能看，不能切 Tab / 关闭 Tab / 导航 / 输入。
- Agent 在后台操作 Agent Space 时，Person Space 仍然可见、可操作。

## 2. 数据模型

新增：

```ts
type SpaceId = 'person' | 'agent';

interface EnvironmentSpace {
  id: SpaceId;
  label: string;
  owner: ControlOwner;
  tabs: TabState[];
  activeTabId?: string;
}

interface TabState {
  space: SpaceId;
  // 原字段不变
}
```

`Environment` 增加：

- `spaces: EnvironmentSpace[]`
- `activeSpaceId: SpaceId`
- 保留 `tabs` / `activeTabId` 作为「当前 Space 的视图」，避免 UI 和插件 API 复制查询逻辑。

持久化：

- `env_tabs` 增加 `space TEXT NOT NULL DEFAULT 'person'`。
- 旧数据自动归到 Person Space。
- 每个 Space 各自保存自己的 active tab。

## 3. 控制权

- `LeaseHandle.space = 'agent'`。
- `acquire` / `takeover` 默认 Agent Space。
- `assertWritable(id, leaseId, space='agent')` 校验 lease 的 space。
- Person Space 的 `humanNavigate` 不要求 lease。
- Agent Space 只有在 `owner=human` 时允许人工导航 / 改 Tab。
- `takeover(id, 'agent')` 自动把 UI 切到 Agent Space。
- 人工 `release` 后自动回到 Person Space。

## 4. 运行时

`EnvironmentManager` 从「一个 Environment 一个 TabManager」改为「一个 Environment 两个 TabManager」：

```ts
{
  person: TabManager,
  agent: TabManager,
  active: SpaceId
}
```

- Agent 命令默认 `space=agent`。
- UI 命令显式传当前 `space`。
- `controllerFor` / `newTab` / `selectTab` / `closeTab` / `navState` / `humanNavigate` 都带 space。
- Agent 在后台操作 Agent Space 时，沿用 `attachBelow`：视图挂到窗口底层，人看到的仍是 Person Space。
- `focusDisplayedPage` 只把 document 焦点交给当前显示的 Space。
- Shield 只在「当前显示 Agent Space 且 Agent 持权」时出现。

## 5. UI

### Space 切换器

位置：标签行最左侧，和标签条同一行，不额外增加高度。

```text
[我的 3] [Agent 2 · AI 操作中]   标签1 标签2 + | 地址行
```

- `我的`：始终可用。
- `Agent`：可切换到查看；Agent 持权时标签条只读，页面盖 Shield。
- Agent owner 状态：
  - `agent`：蓝点 +「AI 操作中」
  - `human`：绿点 +「你接管中」
  - `none`：灰点 +「空闲」

### Tab 行为

- Person Space：新建 / 关闭 / 选择 / 拖拽 / 右键菜单 / 导航全部可用。
- Agent Space：
  - `owner=agent`：只能看当前 active tab，Shield 阻止输入；不能切/关/拖 Tab。
  - `owner=human`：全部可用。
  - `owner=none`：先接管再操作。
- 地址栏可用条件：`activeSpace=person || agentSpace.owner=human`。
- 快捷键跟随当前 Space；Agent Space 锁定时 `⌘T` / `⌘W` / `⌘1..9` / `⌘R` / `⌘L` 不生效。

### 标题栏

- 仍然显示环境、代理、状态。
- 控制按钮改成针对 Agent Space：
  - 空闲 / AI 操作中：「接管 Agent」
  - 人持权：「交还 Agent」

## 6. 后台常驻

第一阶段实现「离屏常驻到托盘，不退出」：

- 关闭窗口 = 移到屏幕外、透明、忽略鼠标并 `showInactive()`，不销毁 BrowserWindow。
- macOS Dock 在隐藏时收起；显示窗口时恢复。
- 菜单栏 Tray：显示 Warren / 退出 Warren。
- 自动回归恢复窗口时只 `showWindow(false)`，不激活应用；只有托盘点击 / 用户主动打开才聚焦。
- `before-quit` 才真正销毁环境、关闭 RPC、关库。
- `window-all-closed` 不再自动退出。
- 页面 `WebContentsView` 设置 `backgroundThrottling: false`。
- 有运行中的 Environment 或 Agent lease 时持有 `powerSaveBlocker('prevent-app-suspension')`。
- 输入前用 `Emulation.setFocusEmulationEnabled` 让页面 `document.hasFocus()=true`，不调用会抢前台的 `wc.focus()`。
- 后台视图首次懒建时先创建 Tab，再 `attachBelow()`；renderer 视口仍为 0 时临时套 `Emulation.setDeviceMetricsOverride`。
- 新增调试方法隐藏/显示窗口，用于实测后台点击、键盘和 `visibilityState`。

截图边界：CDP `Page.captureScreenshot` 在部分后台窗口上仍可能拿不到 surface。
`browser.screenshot` 现在对可见视口回退 Electron `capturePage()`；`fullPage` / `clip`
仍只走 CDP 并如实报错。整个截图路径都不激活 Warren。

不做：

- 本次不拆 Core daemon 与 UI 客户端。
- 不承诺合盖休眠后继续运行。
- 不实现纯 headless；当前页面仍是 `WebContentsView`，必须保留一个宿主窗口。

## 7. 迁移

- 旧 Tab 全部归 Person Space。
- Agent 第一次操作时如果没有 Agent Space Tab，自动在 Agent Space 新建一个 `warren://newtab`。
- 环境启动时 Person Space 至少保留一个 Tab；Agent Space 按上次快照恢复。
- 停止环境时两组 Tab 都写回快照。

## 8. 验收

1. Agent 持权时，Person Space 可导航、可新建/关闭 Tab。
2. Agent 在后台 Agent Space 点击时，Person Space 不丢焦点。
3. 切到 Agent Space 未接管：Tab 不可切、页面有 Shield、导航禁用。
4. 接管 Agent Space：Shield 撤掉、Tab 可操作、Agent 写操作报 `CONTROL_REVOKED`。
5. 交还 Agent Space：UI 回 Person Space，Agent 可重新 acquire。
6. 两个 Space 的 Tab 分别持久化；重启后恢复。
7. 关闭窗口后托盘仍在，RPC 可用；隐藏状态下点击/键盘实测，截图按焦点边界快速拒绝。
8. 五道静态门 + 全量回归全绿。

## 9. 跨环境地址历史

- SQLite 表 `url_history(url PRIMARY KEY, visit_count, last_visited_at)`，所有 Environment / Space 共用。
- 只在主框架实际导航（`did-navigate` / `did-navigate-in-page`）记录 http/https，忽略 `warren://`。
- 地址栏聚焦时空 query 返回最近访问；输入时按命中位置优先、最近访问次序返回，最多 8 条。
- `↑/↓` 移动候选，`Enter` 选中，`Esc` 关闭，鼠标按下直接选择。
- 同一 URL 原地累计访问次数，表最多保留 5000 条。
