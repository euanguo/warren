# 继续用 Electron：让 AI 联调更接近真实浏览器

> 状态：**调研 + 清单，未实施**。只记录事实与规划。
> 日期：2026-10-17
> 定位：`CHROME-SHELL-PLAN.md` 回答「**要不要换内核**」；本文回答「**不换内核**，补什么能让
> Warren 里的页面行为更接近真实浏览器」。两份并列，别混着读。
> 场景：用户拿 Warren 当 AI 联调工具，调的是**自己正在开发的网站**（dev server）。
>
> 本文标「实测」/「代码取证」的都是本机跑出来或读代码得到的，其余是推断并已注明。

---

## 0. 「真实」有两个不同的意思，先分开

| | 面向谁 | 不真实的代价 | 状态 |
|---|---|---|---|
| **反检测真实** | 外部网站的反爬 / 风控 | 被封、被降级 | 已做一轮，见 `CHROME-SHELL-PLAN.md` §2.7 / §2.7.1 |
| **联调真实** ← 本文 | **开发者自己** | **调出假 bug** —— 在自己 Chrome 里复现不出来 | 本文 |

联调场景下，「不真实」不是安全问题，是**结论错误**问题：AI 说「这里坏了」，开发者在自己的
Chrome 里却好好的；或者反过来，AI 说「没问题」，而用户打开一看是坏的。

---

## 1. 四个维度盘点（现状全部来自代码取证 / 实测）

### 1.1 渲染与布局

| 项 | 现状 | 偏差 | 影响联调 |
|---|---|---|---|
| 视口尺寸 | `WebContentsView` 的 rect（窗口里的一块） | 通常比全屏 Chrome 小 → 响应式断点落在不同档 | **高** |
| devicePixelRatio / 字体 | 继承系统 | 一致 | — |
| 全屏 | 限制在视图内（实测，见 `REMAINING-PLAN-2026-10-16.md` §2.9） | 真 Chrome 占满整个屏幕 | 中 |
| 缩放 | 未暴露 | — | 中 |

**为什么「视口尺寸」影响最大**：开发者调的是响应式页面。他的 Chrome 可能是 1440 宽，
Warren 的页面区域可能是 1124 宽 —— **同一份 CSS 会命中不同的媒体查询分支**，
AI 看到的布局和开发者看到的不一样，联调结论直接失真。

### 1.2 输入（**最大缺口**）

先纠正一个常见误解：**Warren 不是「没有鼠标移动」**。`keymouse.ts:32` 的 `mouseClick` 是
`mouseMoved → mousePressed → mouseReleased` 三步，所以基础 hover 是能触发的。缺的是**路径与时序**：

| 项 | 现状（代码位置） | 真人是 | 影响 |
|---|---|---|---|
| 鼠标路径 | **一步跳到目标坐标**（`keymouse.ts:32`） | 几十个中间坐标 | **高**：`mousemove` 节流 / 去抖、canvas 绘制、拖拽路径、地图 / 3D / 富文本 |
| 元素动作的滚动 | `DOM.scrollIntoViewIfNeeded`（`actions.ts:91` / `:160` / `:194`） | wheel 事件序列 | 中：只听 `wheel` 的页面（地图、缩放控件）不响应 |
| 坐标滚动 | 有 `mouseWheel`（`keymouse.ts:130`） | — | 元素动作没用它 |
| 键盘 | `keyboardDown/Up/Press/Type/Insert/Paste` 齐全，`delay` 可选 | 逐键有间隔 | 中：**中文输入法（composition）完全没测** |
| 剪贴板粘贴 | CDP 合成 ⌘V 不触发原生粘贴（已知差异） | 可以 | 中 |
| 窗口不在前台 | 输入被系统丢掉，显式报 `WINDOW_NOT_FOCUSED`（已知，见坑 36） | 真人不会遇到 | **高**：agent 在后台跑就废了 |

### 1.3 页面环境

| 项 | 现状 | 偏差 | 影响 |
|---|---|---|---|
| UA / `window.chrome` | **已对齐真 Chrome**（2026-10-17 修的） | client hints 仍是 Chromium | 低 |
| **Chrome 扩展** | **完全不支持**（实测 `rg loadExtension src/main` 为空） | 真 Chrome 能装 | **高**：React DevTools / Vue DevTools 是联调刚需 |
| DevTools | 有（`browser:openDevTools`，⌥⌘I） | 但装不了 DevTools 扩展 | 高 |
| `window.prompt()` | 调用即抛（已知 Electron 差异） | 真 Chrome 弹框 | 中 |
| Service Worker | 未验证 | — | 中 |

**关键发现**：Electron **本身支持**加载扩展 —— `session.loadExtension(path, options)`
（`electron.d.ts:8565`）和 `getAllExtensions()`（`:8534`）。
**扩展支持是现成能力，Warren 只是没用。** 这是本文里性价比最高的一条。

### 1.4 网络

| 项 | 现状 | 偏差 | 影响 |
|---|---|---|---|
| 拦截器挂载 | 只在**有启用规则时**才挂 `protocol.handle`（`net/interceptor.ts:47`，好设计） | 挂上时可能改变缓存 / CORS 语义 | 中 |
| **请求 / 响应 body** | **只有摘要**（实测 `telemetry.ts` 里没有 body） | DevTools 有完整 body | **高**：联调必看接口返回 |
| HMR websocket | **未验证** | dev server 的 HMR 靠它 | **高**（联调核心前提） |
| HAR | 有录制 / 回放 | — | 好 |
| 控制台 | 300 条环形缓冲，无去重、无 source map | DevTools 有 | 中 |

### 1.5 观察通道

| 项 | 现状 | 偏差 | 影响 |
|---|---|---|---|
| 主通道 | **AX 树**（`HANDOFF.md` §3.5 的明确决策） | 真人靠眼睛 | **高**：布局错位 / 颜色 / 溢出 / 视觉层级，AX 树**看不见** |
| 截图 | 有（`Page.captureScreenshot`） | 次通道 | — |
| 录屏 / 回放 | **没有** | — | **高**：联调要知道「AI 做了什么导致页面坏了」 |

---

## 2. 优化清单（分三档）

### P0 —— 直接影响联调结论的正确性

1. **鼠标路径合成**：`click` 前发一串 `mouseMoved`（贝塞尔曲线，10–20 点，带时序）。
   落点 `src/main/browser/keymouse.ts`。
2. **元素动作改用 wheel 滚动**：在 `scrollIntoViewIfNeeded` 之外补 wheel 序列（或给开关）。
   落点 `src/main/browser/actions.ts`。
3. **请求 / 响应 body 可读**：`warren net body <env> <id>`。落点 `telemetry.ts` + `net/`。
   **注意脱敏**（`policy.ts` 已有脱敏工具）和上限，别把凭据落盘。
4. **视口可控**：`env update <name> --viewport=1280x800`（`Emulation.setDeviceMetricsOverride`），
   让断点和开发者自己的 Chrome 对齐。
5. **先测 HMR / websocket**：可能本来就正常 —— **RED 优先，别先改**。

### P1 —— 联调效率

6. **加载解包扩展**（`session.loadExtension`）—— 至少让用户能挂 React DevTools。
7. **页面录屏**（`Page.startScreencast` 存帧）→ 联调可回溯。
8. **控制台错误聚合 + source map 还原**。
9. **多环境并排**（A/B、登录 / 未登录对比）。

### P2 —— 可选

10. `window.prompt()` 兼容；11. 剪贴板粘贴；12. 触摸事件；13. 全屏语义对齐。

---

## 3. 架构调整

- **输入合成器（input synthesis）**：把「一个 `click` 命令」展开成真人事件序列。现在
  `actions.ts` 直接算坐标调 `mouseClick`；要在中间插一层。
  ⚠️ **不要绕过 `actionability.ts` 的 `runAction` / `checkActionable`** ——
  见 `AGENTS.md` 已知问题第 8 条（「命令成功、页面没反应」就是这么来的）。
- **观察层加视觉通道**：AX 树仍是主通道，但「看起来对不对」要能进主通道 ——
  截图 + 前后差异对比。
- **遥测层加 body 存储**：独立表 + 上限 + 脱敏。**不要**塞进现有那个 300 条环形缓冲
  （它会按批清理，见 `HANDOFF.md` §6 遥测封顶）。

---

## 4. 功能增加（联调专属）

- **`warren dev <env> --url=http://localhost:3000`**：一键联调模式 —— 建环境、指向 dev server、
  感知 HMR、把 console 错误流回 CLI。
- **热更新感知**：AI 改代码 → dev server 热更新 → AI 需要知道「页面已经变了、我之前的
  snapshot / ref 失效了」。现在**没有这个信号**（`refs.ts` 的 gen 只在导航时失效）。
- **视觉回归**：`warren shot diff <env> --before=a.png --after=b.png`。

---

## 5. 验收方式

每条都要有 fixture 页 + 一条实测命令。现有 fixture 在 `fixtures/capability/`（14 个页面），
新增项按同样方式加。GUI 回归跑：

```bash
bash scripts/regress/run-all.sh     # 当前基线：137 PASS / 0 FAIL
```

---

## 6. 未决 / 待测（下次接手先看这里）

1. **HMR websocket 在 Warren 里到底通不通** —— 未测，是「AI 联调」的**核心前提**，先测这个。
2. `window.prompt()` 能不能救 —— 未验证。
3. 中文输入法（composition 事件）—— 完全没测。
4. 扩展加载在 `contextIsolation: true` + `sandbox: true` 的 `WebContentsView` 下能不能用
   DevTools 扩展 —— 未验证。
5. 多环境并排的 UI 落点 —— 现在一个窗口只显示一个环境的页面（后台环境报 `ENV_NOT_VISIBLE`）。

---

## 7. 与既有文档的关系

- `CHROME-SHELL-PLAN.md` —— 换内核 / 套壳那条线。**本文是它的「不换内核」对照面**。
- `HANDOFF.md` §3.5 —— 「观察主通道是 a11y 树，不是截图」这个决策。本文 §1.5 指出它在
  **联调场景**下的缺口；要改这个决策，先读完 §3.5 的理由。
- `BROWSER-CAPABILITY-PORT-PLAN.md` —— 动作可用性（`actionability.ts`）。本文 §3 的输入合成器
  要挂在它**之上**，不能绕过。
- `AGENTS.md` 已知问题 8 / 11 —— 改动作层和定位层前必读。
