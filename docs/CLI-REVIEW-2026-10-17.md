# CLI 梳理（2026-10-17）

> 状态：**梳理 + 建议，未实施**。
> 起因：用户要求「看看 CLI 有没有命令结构不清晰的地方，做一次整体梳理」。
> 方法：**全部实测** —— 读 `bin/warren.mjs` 的分派表 + 跑 `warren help` / 故意打错命令看行为。
> 所有数字（命令数、漏了哪个、exit code）都是本机跑出来的。

---

## 0. 结论摘要

**CLI 的骨架是清晰的**：`warren <组> <子命令> <位置参数>` + `--json` 统一开关，
`exec <env>` 作为主力入口。**问题不在骨架，在四处**：

| 严重度 | 问题 | 一句话 |
|---|---|---|
| **P0** | 命令清单在**三个地方各写一份**，已经漂移 | `help` 漏 5 个命令；`plugin` 的报错漏 2 个；`env` 的报错漏 1 个 |
| **P0** | **未知组静默成功** | `warren nope` → 吐 70 行 help，**exit 0**，不报错 |
| **P1** | 命名撞车与不达意 | `browser events` vs `events`；`env select` vs `env acquire`；`env egress` |
| **P2** | 参数形状不统一 | `vault fill --env=` 是唯一把 env 放 flag 的；`--expand` vs `--headed=false` |

**建议：只做 P0（纯机械、零风险、不破坏 agent 用法）。P1/P2 列清单、等一次专门的
"breaking 窗口"一起改** —— 理由见 §4。

---

## 1. 现状：完整命令树（实测提取）

```
warren env      list create start stop remove update select acquire release takeover
                egress move reorder                                    (13)
warren group    list create rename remove collapse                      (5)
warren tab      list new select close reopen                            (5)
warren browser  open snapshot info events console network screenshot highlight (8)
warren net      rules rule{add,enable,disable,remove} hits passthrough
                record{start,stop} replay{start,stop}                   (6 个二级)
warren vault    list add remove fill                                    (4)
warren plugin   list install create enable disable uninstall grant reload
                status logs commands config run                          (13)
warren events   [env]                                                   (无子命令)
warren exec     <env>                                                   (无子命令)
warren call     <method> [json]                                         (无子命令)
```

**统一的部分（做得好，别动）**：

- 所有环境相关命令都用**位置参数** `<env>`（除了 `vault fill`，见 §2.3）
- `--json` 一个开关贯穿（`print(value, asJson, format)`）
- 各组的 `switch` 都有 `default:` 兜底报错（实测 `env` / `group` / `vault` / `plugin` / `net` /
  `tab` / `browser` 七组全部 `exit 1`）
- 长命令都有用法示例（`net rule add` 那六行是范例）

---

## 2. 问题清单（按严重度）

### 2.1 【P0】命令清单三处各写一份，已经漂移

同一份清单存在**三个地方**，实测三份都不一样：

| 地方 | plugin 组列了 | 差 |
|---|---|---|
| `warren help`（顶层） | 7 行、展开成 **9 个**命令 | **漏 `reload` `status` `logs` `config`** |
| `plugin` 的 `default:` 报错 | **11 个** | **漏 `create` `commands`** |
| 实际 `switch` | **13** | 基准 |

`env` 组同样：`help` 列了 13 个，但 `env` 的 `default:` 报错里
`[list|create|start|stop|remove|select|acquire|release|takeover|egress|move|reorder]`
**漏了 `update`**。

`call` 则**完全不在 help 里**（`grep -c "call" warren help` → 0）。

**为什么这是 P0**：`skills/warren/SKILL.md` 明确写「`warren help` 是命令的权威」。
权威本身不准，agent 就发现不了 `plugin logs` / `plugin config` / `call` 这些能力。
**这是"文档与代码漂移"的教科书案例，而且踩在本项目最强调的那条上。**

**修法**：清单抽成**单一来源**（一个 `COMMANDS` 常量），`help` 文本和每组 `default:` 报错
都从它生成。加命令时只改一处。

### 2.2 【P0】未知组静默成功

```
$ warren nope          -> 打印 70 行 help 到 stdout，exit 0
$ warren env nope      -> '用法: warren env [...]'，exit 1   ← 对
$ warren browser nope  -> '用法: warren browser [...]'，exit 1 ← 对
```

**组内的未知子命令会报错退出 1，但未知组会静默吐 help 并退出 0。**

**为什么这是 P0**：agent 打错一个组名（`warren even list`），拿到的是 **exit 0 + 一屏
help 文本** —— 它会以为命令成功了。这正是 `AGENTS.md` 已知问题第 1 条那个家族
（「看着有内容其实全是 undefined」）的同一种病：**静默失败**。

**修法**：区分两种情况 ——
- `warren`（无参数）→ 打印 help，**exit 0**（这是对的，用户就是要看 help）
- `warren <未知组>` → 打到 **stderr**，**exit 1**，并说明「未知命令组 `xxx`」

### 2.3 【P1】命名问题

| # | 问题 | 实测/证据 | 建议 |
|---|---|---|---|
| a | **两个 `events`** | 顶层 `warren events [env]` = 环境审计事件；`warren browser events <env>` = 页面 dialog/popup/download/fileChooser | `browser events` → `browser popups`（它的 RPC 就叫 `browser.events`，但内容确实是弹窗/下载队列） |
| b | **`env select` vs `env acquire`** | skill 里专门写了一条规矩解释区别（select = 切界面，acquire = 取写权限）—— **需要写文档解释的命名就是坏命名** | `select` → `env focus`；`acquire` 保持（lease 是标准词） |
| c | **`env egress` 不达意** | help 注释自己写着「当前出口**与页面状态**」—— 名字只说了一半 | `env egress` → `env status`（`PRD.md` §5.3 当初写的就是 `env status`） |
| d | **`net rules` vs `net rule`** | 查用复数 `rules`，改用单数 `rule add` | 统一成 `net rule list` / `net rule add` |
| e | **`vault fill --env=<env>`** | **唯一**把 env 放 flag 的命令；其他全是位置参数 | `vault fill <env> <ref> ...`（但这会改参数顺序，属于 breaking） |
| f | **`browser open` vs `tab new`** | 都能开 URL，功能重叠 | 二选一：`browser open` 删掉（`tab new` 更贴近"标签"这个真实概念），或反过来 |

### 2.4 【P2】参数形状

| # | 问题 | 证据 |
|---|---|---|
| a | **`browser highlight [选择器]`** | 不传 = 清除。**同一个命令两种语义**。建议拆 `highlight` / `unhighlight` 或加 `--clear` |
| b | **`tab close <序号\|tabId>`** | 混用序号和 id 两种寻址；而 `browser *` 用 `--tab` 第三种 |
| c | **`plugin install <dir>` vs `plugin create <id>`** | 一个收路径、一个收 id，命名上不统一 |
| d | **布尔标志两种风格** | `env create --headed=false`（带值）vs `group collapse --expand`（不带值取反） |
| e | **缺 `env status <name>`** | 查单个环境状态只能 `env list` 再挑，或 `env egress`（名字还不达意） |
| f | **`tab` 组缺 `mute` / `reorder` / `closeOthers`** | RPC 有（`tab.mute` / `tab.reorder` / `tab.closeOthers`），CLI 没有。**这是有意省略**（`REMAINING-PLAN-2026-10-16.md`：「这三条是人的手感，agent 用不到」）—— 记在这里是因为**RPC 与 CLI 的能力面不对齐**，将来别当成 bug 修 |

---

## 3. 建议

### 3.1 立刻做（P0，机械、零风险、不改 agent 用法）

1. **清单单一来源**：加一个 `COMMANDS` 常量，`help` 与各组 `default:` 都从它生成。
   加命令时只改一处。**这一步不会改变任何现有命令的行为。**
2. **未知组报错退出 1**：`else` 分支改成「打 stderr + exit 1」，无参数时仍打 help + exit 0。
3. 顺手补一条回归：`warren nope` 必须 `exit 1`（放进 `scripts/regress/core.sh`）。

### 3.2 攒一次 breaking 窗口再做（P1/P2）

**理由**：CLI 是 agent 的唯一入口，`skills/warren/SKILL.md` 是它的文档。
零散改名会让「历史对话里写的命令」和「agent 学到的命令」对不上，而且 agent 侧没有版本协商。

**建议把 §2.3 / §2.4 一次性做完**，并且：
- 改名前先在 skill 里加一段"旧名仍然可用"的过渡期（别名），一个版本后再删
- 优先做 a/b/c（认知负担最大的三个），d/e/f 可以缓

### 3.3 不做

- **不把 `browser *` 并进 `exec`**：两者面向不同场景（`exec` 是主力，`browser *` 是单发查询），
  合并会让"一次调用跑一段脚本"这个核心卖点变模糊。
- **不给插件命令开顶层入口**：`SHELL-PLUGIN-PLAN-2026-10-17.md` §2.3 已经论证过
  （撞名 + 装/卸会让 help 不稳定），本文同意，**不重复论证**。

---

## 4. 与 `EXECUTION-PLAN-2026-10-17.md` 的关系

**核对结果：那份计划的代码引用全部仍然有效**（逐条验过 `environments.ts:1169`、
`rpc-dispatch.ts:114/127/316`、`interceptor.ts:47`、`keymouse.ts:32`、`snapshot.ts:310`、
`electron.d.ts:8565`）。

中间落地的两个提交（`a0aaf71` 设置页 / `cbf1c4a` 外壳路由 + 插件 CLI 发现）**没有触及
计划里任何一条的落点**。唯一相关的是它们加了 `plugin commands` / `plugin create` ——
这恰好是 §2.1 那个"清单漂移"问题**变严重的直接原因**（新命令只加进了 switch 和 help，
没加进 `plugin` 的 `default:` 报错）。

**建议插入位置**：新增 **批次 0**，在批次 1 之前 —— 理由是 §3.1 只动 `bin/warren.mjs`
一个文件、不依赖任何其他批次，而且它是**唯一一个"改完立刻让所有 agent 受益"的改动**
（agent 找不到 `plugin logs` 是每天都发生的损失）。估时**半天**。

---

## 5. 风险

1. **改名 = 改协议**。`skills/warren/SKILL.md` 和 `warren help` 两份文档都要同步，
   而且 `src/main/agent-integration.ts` 会把 skill 装进各 agent 的目录 ——
   已经装过的副本**不会自动更新**（`installSkill` 要用户再点一次，或加版本比对）。
   这是 §3.2 必须"一次性做完"而不是零散改的真正原因。
2. **`help` 从常量生成后**，格式会和现在手写的不完全一样 —— 别顺手重排，
   保持现有排版（agent 的 prompt 里可能已经固化了某些行）。
3. §2.4f（`tab` 缺三个子命令）**是有意的**，别当 bug 修。
