# 外壳与插件：梳理 + 计划（2026-10-17 晚）

> 状态：**第 1–3 节已实施并实测**；第 4 节是调研；第 5 节是下一步。
> 起因：用户指出三件事 —— 设置页左边的分节每项占了全高；设置页 / 插件页旁边不该常驻环境列表；
> 插件应该能注册 CLI 命令、而且 agent 要能**发现**有哪些插件和哪些命令。

---

## 0. 这一轮改了什么（全部实测）

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | 设置页左边每个分节都占满整列高（870px 列表，每项 853px） | 组件基础变体给了 `h-[calc(100%-1px)]` + `flex-1` —— 那是给**横向** tab 用的 | 条目类改成 `h-auto! flex-none justify-start`，抽成 `SECTION_TRIGGER_CLASS` 一处 |
| 2 | 设置页 / 插件页旁边还常驻环境列表 | 环境列表是**无条件**渲染的 | 加 `sidebarVisible = !stageReplaced`，只在这个路由渲染面板 + 分隔条 |
| 3 | ☰ 在插件页 / 设置页没有意义 | 同上 | `AppRail` 加 `showSidebarToggle`，只在环境页显示 |
| 4 | agent 没法一眼看到"有哪些插件、各有什么命令" | `plugin run <id> --help` 只能问**单个**插件 | 新增 `warren plugin commands`（跨插件摊平） |
| 5 | 写插件要从读 8000 行文档开始 | 没有脚手架 | 新增 `warren plugin create <id> [--dir] [--name]` |

**实测数字**：

```
设置分节条目      h-[calc(100%-1px)] 时 853px → h-auto! 后 32px
stage 宽度        环境页 1125px → 设置页 / 插件页 1386px（满宽）
☰ 的存在          环境页 ["收起侧栏","环境","笔记","设置"]；设置页 ["环境","笔记","设置"]
全量回归          bash scripts/regress/run-all.sh → 137 PASS / 0 FAIL
静态门            lint / format / tsc / npm test 181/181 / 渲染层构建 全过
```

---

## 1. 布局决策：rail 是**路由**，环境列表只属于「环境」

用户的原话是「左边应该是一个类似于切路由的一个动作，或者说其他动作，都有可能嘛，你应该灵活一点」。
落成一条规则：

```
标题行                 = ☰ 侧栏开合（**只在环境页**）+ 环境身份 + 接管/交还
rail（图标列，常驻）   = 路由切换器：环境 · 各插件页 · ⚙ 设置
环境列表（侧栏面板）   = 只属于「环境」这一个路由；切走就卸载，切回来重挂
stage（右侧）          = 当前路由的内容：环境页 / 插件页 / 设置页
```

**☰ 为什么放标题行而不是 rail**：rail 的语义是「切到哪个路由」，而侧栏开合是「这一列显不显示」——
两件事。放 rail 里会让 rail 变成"路由 + 一个开关"的混合体。
槽位宽度固定（`w-[var(--rail-control-size)]`）：切到插件页 / 设置页时按钮消失，
不留位的话环境名会往左跳 28px。

**为什么环境列表不做常驻**：插件页和设置页都不需要它（它们不操作某个具体环境），
留着只是白占 260px。而且它常驻会让"当前在哪个路由"这件事变模糊 ——
侧栏在那儿，看起来永远在环境页。

**代价（要认）**：切路由会卸载侧栏，收起态和宽度**不持久化**（重新挂载回默认宽度）。
现在宽度本来就没持久化（见 `App.tsx` 里那段注释），所以行为一致，不是新增问题。

**两个 effect 的依赖必须跟着改**（这是最容易漏的地方）：
`sidebarCollapsed` 的 ResizeObserver 和"冷启动按像素重设宽度"那两段，原本是 `[]` /
`[sidebarPanelRef]`。侧栏现在会被卸载重挂，不改依赖就会**盯着已经脱离文档的旧节点**，
之后尺寸怎么变都不再上报。

---

## 2. 插件 CLI：现状 / 补了什么 / 还差什么

### 2.1 现状（核对 CLI）

| 能力 | 命令 | 状态 |
|---|---|---|
| 列插件 | `warren plugin list` | 有（显示 runtime / 状态 / 界面面） |
| 列**单个**插件的命令 | `warren plugin run <id> --help` | 有（从 `contributes.commands` 生成） |
| 跑命令 | `warren plugin run <id> <cmd> --env=<env> [--input=…]` | 有 |
| 列**所有**插件的命令 | —— | **本轮补上**：`warren plugin commands` |
| 插件命令变成**顶层** CLI 命令（`warren notes list`） | —— | **没做**，见 §2.3 |

### 2.2 本轮补的

```bash
$ warren plugin commands
com.example.notes        addNote              把当前环境的页面地址存成一条笔记
com.example.notes        list                 列出所有笔记（JSON）
com.example.cookies      report               列当前环境的 cookie 名字与域（没有值）
...
```

一行一条 `插件 id · 命令 · 摘要`，agent 一次就看清全貌，不用先猜插件 id 再逐个 `--help`。

### 2.3 还差的：插件命令要不要变成顶层命令

现在是 `warren plugin run <id> <cmd>`（**命名空间式**）。另一种是 `warren <cmd>`（顶层式）。
**建议保持命名空间式**，理由：

1. 顶层式会和内置命令撞名（`env` / `tab` / `net` / `vault`…），要引入优先级规则和冲突报错；
2. 插件可以随时被卸载，顶层命令会**凭空出现和消失**，`warren help` 的输出不稳定；
3. 命名空间式的代价只是多打几个字，而 agent 是按文档打的，不是按肌肉记忆。

**真要做的话**，最小形状是给 `warren help` 加一段"插件命令"区（动态生成），
而不是把命令提升到顶层。

---

## 3. 插件脚手架（`warren plugin create`）

```bash
warren plugin create com.acme.demo --dir=/tmp/demo --name="Acme Demo"
```

生成两个文件，**只这两个**：

- `manifest.json` —— apiVersion 2、sandbox runtime、`environment.read` 一条权限、一个 `hello` 命令
- `index.js` —— 一个能跑的 `hello` 命令 + `activate`

**为什么不生成更多**：`app`（前端 bundle）和 `host` 运行时都是可选的，
骨架里带上会让人以为必须写。命令名 `hello` 是留给人改的。

**端到端实测（已跑）**：

```
create → install → enable → plugin run com.acme.demo hello --env=cap
  → {"environmentId":"cap","input":null,"environments":7}
plugin commands 里出现 com.acme.demo
```

脚手架是**本地写文件、不走 RPC** —— 目标目录由调用方给，没必要让应用去碰用户的开发目录。

---

## 4. 应用一键安装：调研结论

**现状**（`docs/RELEASE.md` 已经如实记着）：`npm run make` 出 zip + dmg（各 121 MB，实测），
签名 / 公证有门控（给了 Apple 凭据才开）。**没有** CI 发布、**没有** Homebrew cask、
**没有**自动更新。

**要"一键安装"缺三段，按依赖排序**：

| # | 缺什么 | 做法 | 依赖 |
|---|---|---|---|
| 1 | **CI 发布 workflow** | tag 触发 → 跑 `npm run make`（带签名凭据）→ 传 GitHub Release | 要先有签名凭据 |
| 2 | **安装渠道** | Homebrew cask（`brew install --cask warren`）指向 Release 的 dmg | 要 #1 |
| 3 | **自动更新** | `electron-updater` + GitHub provider | 要 #1，且 macOS 要求产物签名 |

**为什么这个顺序不能反**：没有发布源就没法端到端验证自动更新 ——
`RELEASE.md` §3 已经写明"没做这一步就等于没做"。同理，cask 指向一个还不存在的 Release 也没意义。

**注意 GitHub 的容量**（本轮另一次调研的结论，见 `CHROME-SHELL-PLAN.md` §2.3）：
Releases 不限总量和下载带宽，单文件 ≤ 2 GB —— 121 MB 的 dmg 完全放得下，
**下载流量由 GitHub 出**，不占自己的流量。

**最小可做的一步**（不需要签名）：加一个 tag 触发的 workflow，跑 `npm run make`（不带签名）
把**未签名**的 zip/dmg 传到 Release。内测可用，正式分发再补签名。这一步当天能做完。

---

## 5. 未做 + 下一步

| # | 事 | 状态 |
|---|---|---|
| 1 | 插件命令提升为顶层 CLI 命令 | **不做**（理由见 §2.3） |
| 2 | `warren help` 里动态列插件命令 | 未做；比顶层命令便宜，等有人真的找不到再说 |
| 3 | 发布 workflow（未签名也能用） | **未做**，是"一键安装"三段里唯一不需要凭据的，建议下一轮先做这个 |
| 4 | Homebrew cask | 未做，依赖 3 |
| 5 | 自动更新 | 未做，依赖 3 + 签名 |
| 6 | 设置页在插件页有状态时会卸载它 | **已知代价**，见下 |

**§5.6 说明**：设置和插件页现在抢同一个 stage，所以打开设置会卸载当前插件页
（React state 丢失，从 kv/SQLite 重读）。对"状态在库里"的插件（如 Notes）无感；
把状态放内存的插件，切设置再回来会看到它重置。要修的话是"保留挂载但隐藏"，
会引入"隐藏的插件页还在跑"这类新问题 —— 先用着，真踩到再说。
