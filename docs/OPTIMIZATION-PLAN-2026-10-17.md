# 优化路线图（2026-10-17）

> 状态：**规划 + 一次实验，未实施**。只记录结论与方案。
> 起因：`CODEBASE-ASSESSMENT-2026-10-17.md` §3.2 列的三条结构性风险 +
> `ELECTRON-REALISM-PLAN.md` §2 的四个真实性缺口。
> 本文回答三件事：**God object 怎么拆**、**回归怎么进 CI**、**四个缺口先做哪个**。

---

## 0. 一个把前两件事串起来的发现

`environments.ts` 1301 行**没有单测，根本原因不是它大，是它直接 `new` Electron 对象**
（`session.fromPath` / `WebContentsView` / `InputShield` / `NetInterceptor`），**没有注入点**。
所以「拆文件」只搬代码，不产生测试覆盖。

而"改了没生效"的**根治**是回归能进 CI。**这两件事是同一个问题**：
编排层最现实的保护网不是单测，是**跑得起来的回归**。

**所以顺序是：先修网（CI），再拆文件。** 反过来做，等于在没有安全网的情况下动最危险的文件。

---

## 1. 回归套件进 CI（**先做这个**）

### 1.1 本次实验：`WINDOW_NOT_FOCUSED` 是过度防御（实测，3 轮）

现状：`environments.ts:1169` 的 `assertInputFocus()` 在**发输入之前**就拦掉了：

```ts
if (process.platform === 'darwin' && !this.#window.isFocused()) throw ... 'WINDOW_NOT_FOCUSED'
```

历史记录（`HANDOFF.md` 坑 36 附近）写的是「窗口不在前台时输入会被丢掉（实测）」。
**本次实验推翻了这个前提**：

| # | 条件 | 结果 |
|---|---|---|
| 1 | 带 `--disable-backgrounding-occluded-windows` + `--disable-renderer-backgrounding`，绕过守卫，失焦 | **点击落地**（`#result` 由 `"未提交"` 变 `"||bj|"`） |
| 2 | **去掉那两个开关**，绕过守卫，失焦 | **照样落地**（同样对照） |
| 3 | 无开关，绕过守卫，失焦 | **键盘也落地**：`fill('#name','hello')` → `value="hello"`；`press('Tab')` → `activeElement.id="bio"` |

三轮的 `debug.layout` 都确认 `windowFocused=false`。

**结论**：
- **那两个 Chromium 开关不是必需的**（已撤掉，不要加）。
- **窗口失焦本身不会丢输入** —— 鼠标、键盘都实测送达，坐标也一致
  （两次运行点击坐标都是 `x:29.33, y:456.28`）。
- 所以 `WINDOW_NOT_FOCUSED` 是**我们自己拦的**，不是 Chromium 拦的。

**2026-10-17 复核（批次 1 实测，`scripts/verify/batch1-focus.mjs`）**：
- 后台环境：**`ensureOperable` 有效**（对后台环境发点击，页面状态确实变了）。
- 失焦后坐标映射：**不变**（rect 与 viewport 失焦前后完全一致）。
- **`document.hasFocus()`：失焦时 false，而且失焦再拉回前台**仍然 false** —— 这是真 bug，
  已修（`environments.ts` 的 `focusDisplayedPage()`，在发输入前把 document 焦点交给页面）。**

**还没测、不能想当然的**：
- **后台环境**（视图没挂到窗口上）—— 那是另一道守卫 `assertVisible`（报 `ENV_NOT_VISIBLE`），
  历史记录说这种会被丢，**本次没测**。两道守卫是独立的，别一起删。
- 部分遮挡（窗口被别的窗口压住一半）时坐标映射是否还准。
- ~~`document.hasFocus()`~~ —— **已测并已修**（见上）。失焦时页面确实认为没焦点，
  但**发输入前会先把 document 焦点交给页面**，所以守卫不会拦。

### 1.2 三条可选的 CI 路

| 方案 | 做法 | 代价 | 判断 |
|---|---|---|---|
| **A. 去掉焦点守卫** | 删 `assertInputFocus` 的 throw（或在 CI 下跳过） | 要先把 §1.1 的「还没测」补完 | **收益最大**：回归不再要求窗口前台 → 直接进 CI；顺带让 agent 能在后台跑（用户不用把 Warren 一直摆前台） |
| **B. 把套件分层** | `run-all.sh` 拆成 `headless`（DOM 结构 / CLI / RPC / 网络 / 遥测 / 快照）与 `interactive`（真实输入）；前者进 CI | 要给 137 条分类 | 稳，但"输入类"恰恰是最容易坏的，拆出去等于漏掉 |
| **C. 换到 Linux + xvfb** | ubuntu runner + `xvfb-run` | **Warren 从没在 Linux 上验证过**（`input-shield` 原生遮罩、`safeStorage` 都依赖平台） | 不确定性最高 |

**推荐 A**，B 作为 A 不成立时的退路。

### 1.3 别人类似软件怎么做（调研）

| 项目 | 做法 |
|---|---|
| **Playwright** | 从不用 OS 级输入，全部走 CDP `Input.*`；headless 根本没有窗口 |
| **Electron 官方测试** | Linux 上用 `xvfb`；文档明确说「窗口焦点 / 剪贴板 / 屏幕这类测试需要独占机器」，并提供了 `virtualDisplay` 原生扩展做多显示器测试 |
| **Playwright 的 Electron 支持**（`_electron.launch()`，实验性） | 直接启动 Electron app，拿 window、`click('text=…')`、`screenshot()` —— **可以覆盖 Warren 的渲染层 UI**（现在那 20 条 UI 检查是手写 `debug.rendererEval`） |

**对我们的启发**：Playwright 之所以没有这个问题，是因为它**从来不依赖 OS 焦点**。
我们走的是 CDP 直发，本来也是同一个路子 —— 是那道守卫把路堵了。

---

## 2. `environments.ts` 拆分（CI 之后做）

### 2.1 接缝在哪（按耦合度实测）

| 候选 | 行数 | 耦合 | 判断 |
|---|---|---|---|
| **`net.*`（8 个公开方法 + `#netFor`）** | ~155 | **低** —— 只在 `start()` / `stop()` / `remove()` 里各碰一次（`attach` / `detach` / `delete`） | **最适合先拆** |
| `cookie*`（4 个方法 + `#sessionOf`） | ~25 | 低 | 可顺手拆 |
| `group*`（8 个方法） | ~60 | 极低，但**基本是 store 转发** | 拆了不产生测试，价值低 |
| `tab*`（11 个方法） | ~110 | **高** —— `#tabs` 被 `setViewport` / `capturePage` / `setViewVisible` / `openDevTools` / `layout()` / `select()` / `#detachSelected` / `start()` / `stop()` 全用到 | **不是接缝，别拆** |
| lease（3 个方法 + `#syncShield`） | ~70 | 中；纯逻辑**已经在 `domain/environment.ts` 且有单测** | 拆的是编排，收益小 |

### 2.2 拆法：**带注入点地拆，否则白拆**

拆 `net.*` 时不要只是搬代码，要顺手给一个注入点：

```ts
// 目标形状（示意，不是最终代码）
export class EnvironmentNetOps {
  constructor(private readonly deps: {
    store: Store;
    netFor: (id: string) => NetInterceptor;   // ← 注入，测试时给假对象
    onChange: () => void;
  }) {}
  // netRules / netHits / netAddRule / netPassthrough / netSetRuleEnabled
  // netRemoveRule / netRecord / netReplay
}
```

**这样拆出来的块才可测**：`netAddRule` 的校验与事件记录、`netPassthrough` 的过期逻辑，
都能在假 `netFor` 上跑，不需要 Electron。

### 2.3 顺序（每步都跑全量门 + 回归）

1. 拆 `net.*` + 注入点 + 单测（`tests/net-ops.test.ts`）
2. 拆 `cookie*`
3. 停下来重新评估：剩下的 900 行里还有没有同样的接缝；**没有就别硬拆**

**不要**为了"行数好看"去动 `tab*` 和生命周期 —— 那两块就是编排，拆了只会把调用链拉长。

---

## 3. 四个真实性缺口：优先级与做法

（背景见 `ELECTRON-REALISM-PLAN.md` §1）

| 序 | 缺口 | 做法 | 成本 | 为什么这个顺序 |
|---|---|---|---|---|
| 1 | **扩展加载**（DevTools 扩展用不了） | `session.loadExtension()` + 一个「加载解包扩展」入口 | **小** | **性价比最高**：Electron 原生支持（`electron.d.ts:8565`），对联调是刚需（React/Vue DevTools）。先验证它在 `contextIsolation + sandbox` 的视图下能不能用 |
| 2 | **请求/响应 body 不可见** | 独立表存 body + `warren net body <env> <id>`；**必须脱敏 + 上限** | 中 | 联调必看接口返回；`policy.ts` 已有脱敏工具可复用 |
| 3 | **鼠标路径** | `click` 前发一串 `mouseMoved`（10–20 点，带时序），插在 `keymouse.ts` 之上 | 中 | 影响面广但要小心：**不能绕过 `actionability.ts` 的 `runAction`**（AGENTS 已知问题 8） |
| 4 | **视觉通道** | 截图进主通道 + `warren shot diff` 前后对比 | 中大 | AX 树看不见布局/颜色/溢出；但这是**改 `HANDOFF` §3.5 的决策**，要先读完那份理由 |

**先做 1**：一天内能出结论（能/不能），而且不成立的话结论本身也有价值。

---

## 4. 建议的执行顺序（合并前三节）

```
第 1 步  补完 §1.1 的「还没测」：后台环境 + 部分遮挡
第 2 步  去掉焦点守卫 → 回归进 CI（.github/workflows 加一个 GUI job）
第 3 步  扩展加载（缺口 1）
第 4 步  拆 net.* + 注入点 + 单测
第 5 步  请求/响应 body（缺口 2）
第 6 步  鼠标路径（缺口 3）→ 视觉通道（缺口 4）
```

**第 1、2 步是地基**：它们同时解决「CI 保护」和「agent 能在后台跑」。
**第 4 步要在第 2 步之后**，因为拆那个文件最需要回归兜底。

---

## 5. 本次实验的复现方式

```bash
# 1. 临时绕过守卫：把 environments.ts 的 assertInputFocus() 里那行 throw 注释掉
# 2. 起应用（不加任何 commandLine 开关）
npm start
# 3. 建环境 / 取 lease / 聚焦窗口 / 打开表单页
node bin/warren.mjs env start cap && node bin/warren.mjs env select cap
L=$(node bin/warren.mjs env acquire cap --json | jq -r .leaseId)
node bin/warren.mjs call debug.focusWindow
node bin/warren.mjs exec cap --lease=$L <<'JS'
await page.goto('http://localhost:8899/cap/form.html');
console.log('BEFORE=' + await page.evaluate(() => document.querySelector('#result').textContent));
JS
# 4. 把焦点切走，确认失焦
osascript -e 'tell application "Finder" to activate'
node bin/warren.mjs call debug.layout --json | jq .windowFocused      # 必须是 false
# 5. 失焦状态下点击 + 键盘
node bin/warren.mjs exec cap --lease=$L <<'JS'
console.log('CLICK=' + JSON.stringify(await page.click('#submit')));
console.log('AFTER=' + await page.evaluate(() => document.querySelector('#result').textContent));
await page.fill('#name', 'hello');
console.log('FILL=' + await page.evaluate(() => document.querySelector('#name').value));
JS
# 判据：CLICK 不报 WINDOW_NOT_FOCUSED；AFTER 由 "未提交" 变成提交值；FILL = "hello"
```

---

## 6. 与既有文档的关系

- `CODEBASE-ASSESSMENT-2026-10-17.md` §3.2 —— 三条结构性风险的出处。
- `ELECTRON-REALISM-PLAN.md` §2 —— 四个缺口的出处与细节。
- `HANDOFF.md` 坑 36 / §6 遥测 —— **本文 §1.1 与坑 36 的记录冲突**，
  处理原则：以本次可复现的三轮实测为准，但**先补完「还没测」再动守卫**。
- `AGENTS.md` 已知问题 8 —— 改动作层（缺口 3）前必读。
