# electron-browser-shell 调研：许可证 + 浏览器行为一致性

> 调研对象：<https://github.com/samuelmaddock/electron-browser-shell>
> 调研日期：2026-10-19 · 实测环境：Electron 44.7.0 / macOS
> 结论先行：**标签/新窗口"该怎么开"可以做到和真实浏览器一致**（决策数据来自 Chromium 自己）；**弹窗拦截 Electron 没有，必须自己实现**；有 3 条实现约束不遵守会死锁。

---

## 1. 仓库是什么

739 ★，仍在维护（最后提交 2026-09-01），无 tag，默认分支 `master`。四个 workspace 包：

| 包 | 作用 | 代码量 |
|---|---|---|
| `packages/shell` | 最小标签页浏览器（扩展能力的测试床）：无框标题栏、`WebContentsView` 标签、右键菜单 | `browser/main.js` 379 行 + `browser/tabs.js` 153 行 |
| `packages/electron-chrome-extensions` | 给 Electron 补 `chrome.*` API：`tabs`/`windows`/`browserAction`/`contextMenus`/`webNavigation`/`notifications`/`cookies`/`permissions`/`runtime`…，外加扩展 popup 窗口 | `src/browser/` 约 1400 行 |
| `packages/electron-chrome-context-menu` | Chrome 风格右键菜单（含"在新标签页打开链接"） | 单文件 |
| `packages/electron-chrome-web-store` | 从 Chrome 应用商店装/更新扩展（CRX3 解析） | 约 10 文件 |

### 与"标签行为"直接相关的实现

- **标签 = `WebContentsView` + 自建事件层**。`Tabs`/`Tab` 是自己写的（`browser/tabs.js`），不是 Electron 的 API；因为 `BrowserView.setAutoResize` 没有对应物，它自己监听 `resize` 重算 bounds（`invalidateLayout`），并调用 `setBorderRadius`。
- **新窗口唯一入口**：`app.on('web-contents-created')` → 给每个 webContents 装 `setWindowOpenHandler`（`browser/main.js:334`）：

```js
switch (details.disposition) {
  case 'foreground-tab':
  case 'background-tab':
  case 'new-window': {
    return {
      action: 'allow',
      outlivesOpener: true,
      createWindow: ({ webContents: guest, webPreferences }) => {
        const win = this.getWindowFromWebContents(webContents)
        const tab = win.tabs.create({ webContents: guest, webPreferences })
        tab.loadURL(details.url)
        return tab.webContents
      },
    }
  }
  default:
    return { action: 'allow' }   // ← 交回 Electron 默认：会开一个原生 BrowserWindow
}
```

- **它自己踩过 background-tab 的坑**（`browser/tabs.js:12`）：

```js
// Delete undefined properties which cause WebContentsView constructor to throw.
if (wcvOpts.hasOwnProperty('webContents') && !wcvOpts.webContents) delete wcvOpts.webContents
if (wcvOpts.hasOwnProperty('webPreferences') && !wcvOpts.webPreferences) delete wcvOpts.webPreferences
```

  这正是 Electron 官方文档里"background-tab 时 `options.webContents` 是 undefined"的兜底。

- **扩展 popup**（browserAction 弹层）用独立的无边框 `BrowserWindow` + `enablePreferredSizeMode` + `preferred-size-changed` 自适应尺寸，不是标签（`electron-chrome-extensions/src/browser/popup.ts`）。
- 其他：UA 里删掉 `Electron/x.y.z` 和 App 名以贴近 Chrome；`session.registerPreloadScript` 注入扩展 API preload；MV3 需手动 `serviceWorkers.startWorkerForScope`。

### README 自认的未完成项（别期待它更多）

- `chrome.*` API 只覆盖一部分；"Respect extension manifest permissions" 未做
- "Robust extension popup support" 未做
- 扩展的启用/禁用/卸载管理未做
- 明确不做 Chrome Platform App API

---

## 2. 许可证

**根目录 `LICENSE` 是 GPL-3.0，但各包以自己的 `package.json` 为准。**

| 包 / 依赖 | 许可证 | 能否直接用于闭源产品 |
|---|---|---|
| `packages/shell` | **MIT** | ✅ 可以，保留版权声明 |
| `packages/electron-chrome-context-menu` | **MIT** | ✅ |
| `packages/electron-chrome-web-store` | **MIT** | ✅ |
| `packages/electron-chrome-extensions` | **双许可：GPL-3.0 或 Patron License** | ❌ 默认不行 |
| `electron`（运行期） | MIT（内含 Chromium BSD-3-Clause 等，见 `node_modules/electron/dist/LICENSES.chromium.html`） | ✅ |
| `electron-squirrel-startup`（shell 依赖） | Apache-2.0 | ✅ |
| `debug` / `adm-zip` / `@types/chrome` | MIT | ✅ |
| `pbf`（web-store 依赖） | BSD-3-Clause | ✅ |

### `electron-chrome-extensions` 的许可细节

`packages/electron-chrome-extensions/LICENSE.md` 只有一句话："provides dual licensing. See LICENSE-GPL and LICENSE-PATRON.md"。

- **GPL-3.0**：copyleft。把它打包进 Warren 会让整个分发物受 GPL-3.0 约束（要开源、要给安装信息）。闭源产品不可用。
- **Patron License**：可以"ignore any noncommercial or copyleft rules"，但条件是**持续**通过 GitHub Sponsors 付费到包含 patron license 的档位；停止赞助即失效。另外要求"larger application must have significant additional content or functionality"。
- 上游 README 也写明：proprietary use 需要联系作者或赞助。

**结论**：`packages/shell` 的标签页/新窗口逻辑（MIT）可以直接抄；`electron-chrome-extensions`（GPL/付费）不能抄，除非决定开源或持续赞助。

---

## 3. 行为一致性：能对齐到什么程度

### 3.1 实测数据（Electron 44.7，最小 harness，`WebContentsView` + `setWindowOpenHandler`）

| 网页里的动作 | Electron 给的 `disposition` | Chrome 的行为 | 一致？ |
|---|---|---|---|
| `<a target="_blank">` 左键 | `foreground-tab` | 同窗口新标签、切过去 | ✅ |
| ⌘/Ctrl + 点击 | `background-tab` | 同窗口新标签、不切 | ✅ |
| 中键点击 | `background-tab` | 同窗口新标签、不切 | ✅ |
| Shift + 点击 | `new-window` | 新窗口 | ✅ |
| `window.open(url)` | `foreground-tab` | 同窗口新标签、切过去 | ✅ |
| `window.open(url,'_blank','width=400,height=300')` | `new-window` + `features` 原样给出 | 独立弹出窗口 | ✅ |
| `setTimeout(() => window.open(url))`（**无用户手势**） | `foreground-tab`，**照样开** | **被拦截**，返回 null，地址栏提示"弹出式窗口被阻止" | ❌ |
| `await` 之后 `window.open`（**无用户手势**） | 同上，照样开 | 同上被拦截 | ❌ |
| `window.open()` 返回值 | 真实 WindowProxy（`object`），可同步写入 | 同 | ✅ |
| `window.open(url,'_blank','noopener')` | 返回 `null` | 返回 `null` | ✅ |

关键点：**"开标签还是开窗口"这个判断不需要我们猜，Chromium 已经在 `details.disposition` 里算好了**，而且和 Chrome 的映射一致。所以"标签协议一致"这件事是可做的，只需要按 disposition 分流。

### 3.2 三条必须遵守的约束（不遵守会死锁，实测复现）

1. **`setWindowOpenHandler` 必须同步返回**。它返回的是值不是 Promise；想"问一下再决定"是不行的。要异步决定，就得**先同步开一个占位标签**，再异步决定它去哪（真实浏览器也是这个套路）。这就是"异步不允许开新 tab"的根因，不是 Electron 的缺陷，而是 Chromium 的窗口创建本来就是同步的。
2. **`createWindow` 必须复用 Electron 给的 `opts.webContents`**。自己 `new WebContentsView()` 再返回，会让页面的 `window.open()` 同步调用**卡死整个主进程**——实测：handler 被调用后主进程事件循环完全停住，连 45s 的兜底 `setTimeout` 都不执行，只能强杀。
3. **`background-tab` / `new-window` 时 `opts.webContents` 可能是 `undefined`**（官方文档原文："For `background-tab` disposition … `options.webContents` is undefined because its creation can be deferred. So load the URL manually."）。这时要自己建 `WebContentsView` 并手动 `loadURL(details.url)`。实测：不处理 → 同样死锁；按官方模式处理 → 全部通过。

另外：`outlivesOpener: true` 要显式给，否则 opener 被销毁（关标签、停环境）时新窗口会被连带销毁，和 Chrome 不一样。

### 3.3 补不齐的部分（需要在产品上明确取舍）

- **弹窗拦截（popup blocker）Electron 完全没有**。上面表格里那两行"无用户手势也照样开"就是它。要补，得自己在 preload 里包一层 `window.open`，把 `navigator.userActivation.isActive` 通过同步 IPC 报给主进程，再由 handler 决定 allow/deny。不补的后果：公网页面（广告、OAuth 兜底流程）会冒出没人要的窗口；对本地开发页影响不大。
- **标签的浏览器 UI 语义全要自己做**：关闭/恢复/会话恢复/标签丢弃/音量图标/缩略图，Electron 一概没有。electron-browser-shell 也只做了最小集。
- **`disposition === 'default'`**：上游 shell 走 `{ action: 'allow' }`，也就是交回 Electron 开一个原生 `BrowserWindow`。这是它唯一没做映射的分支，我们抄的时候要自己决定（我这次没造出这个场景，需要单独验证）。
- **扩展支持**：`chrome.tabs` 之类的 API 只有接了 `electron-chrome-extensions` 才有。如果只要"网页行为一致"，不接就不受影响——也就绕开了 GPL/付费问题。

---

## 4. 对 Warren 的具体结论

### 4.1 现状（实测）

`src/main/environments.ts` 里的 `WebContentsView` **没有装 `setWindowOpenHandler`**。实测默认行为：

- `target="_blank"` 左键点击 → 没有任何日志，Electron 自己开一个**游离的原生窗口**（`handlerCalls=0`）
- 那个窗口**不在 Environment 的 session 管控内**，不受代理、遮罩、lease、事件时间线约束——它甚至可能落在 default session 里

也就是说：**今天只要开发页面里有 `target="_blank"`，就会漏出一个无人管控的窗口**。这是当前最该修的行为不一致。

### 4.2 建议

1. 把 Environment 的页面容器从"单个 `WebContentsView`"升级为"**一个小 Tabs 层**"：一个 Environment = 一个 session + 一组标签（所有标签共用该 Environment 的 session/代理/lease）。
2. 在 Environment 的每个 webContents 上装 `setWindowOpenHandler`，按 `details.disposition` 分流：`foreground-tab` → 新标签并切换；`background-tab` → 新标签不切换；`new-window` → 新窗口（或按产品决定收敛成新标签，但那就和 Chrome 不一致了）。
3. 严守 3.2 的三条约束；`createWindow` 里照抄上游"复用 `opts.webContents`、falsy 时自建 + 手动 `loadURL`"的写法。
4. 标签与现有机制的关系：遮罩仍是"整个右侧区域一个原生 View"，切标签时重新 attach；Agent 的 CDP attach 到当前标签，或把 tabId 纳入寻址（`warren exec <env> --tab N`）。
5. **直接抄 MIT 的部分**：`packages/shell/browser/tabs.js`（153 行）和 `browser/main.js` 的 `onWebContentsCreated`（MIT，保留版权声明）。**不要**引入 `electron-chrome-extensions`——PRD 里插件体系是自己的 `PluginHost`，不是 Chrome 扩展，没必要背上 GPL/付费和 1400 行复杂度。

---

## 5. 复现方式

实验代码在 `/tmp/etest/`（`main.js` + `page.html` + `cases.sh`），逐用例独立进程跑：

```sh
cd /tmp/etest && ./cases.sh allow A A2 A3 B C D E   # HANDLER=allow
cd /tmp/etest && ./cases.sh none A B                # 不装 handler（Warren 现状）
```

每个用例：真实鼠标事件（`sendInputEvent`）点击页面元素 → 打印 `disposition` → 打印页面里 `window.open` 的返回值和调用记录。
