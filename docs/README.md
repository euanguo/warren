# docs 阅读顺序

本目录的文档，**不要按文件名读**。按目的挑：

## 接手 / 想知道「现在到哪了」

1. **`HANDOFF.md`** —— 会话交接：决策、当前状态、踩过的坑、接手起点。**先读这份。**
2. `REMAINING-PLAN-2026-10-16.md` —— 剩余工作施工计划 + 逐项实测记录（批次 A–G，都已落地）。
3. `FULL-REGRESSION-2026-10-15.md` —— 全量回归跑什么、怎么复跑。
   （当前数字：**152 PASS / 0 FAIL**，套件已自足，跑之前只要应用 + fixture 起着。）

## 要改东西

| 你要动 | 先读 |
|---|---|
| 页面操作 / 元素定位 / 等待 / 动作 | `BROWSER-CAPABILITY-PLAN.md`（能力面）、`BROWSER-CAPABILITY-DEEP-DIVE.md`（实现级对标 Playwright）、`BROWSER-CAPABILITY-PORT-PLAN.md`（移植计划 + 自循环验证协议） |
| 标签 / 标签条 | `TAB-MODULE-PLAN.md` |
| 网络拦截 / HAR / mock | `NET-INTERCEPT-PLAN.md` |
| 插件（打包 / 安装 / 权限 / 面 / 运行时 / 存储） | `PLUGIN-PACKAGE-MIGRATION-PLAN-2026-10-20.md`（当前 v4 包契约）、`PLUGIN-CAPABILITY-DESIGN.md`（能力设计，含 Cookie 受控通道 §9）、`PLUGIN-MODERNIZATION-PLAN.md`（历史施工图 + 实测） |
| 界面 / 组件 / 皮肤 | `ui-design-language.md`、`UI-KIT-MIGRATION.md`、`DESKTOP-SHELL-MIGRATION.md` |
| 打包 / 签名 / 公证 / 更新 | `RELEASE.md` |
| 代理（Whistle 插件） | `WHISTLE-PLUGIN-PLAN.md`（当前实现）、`WHISTLE-PROXY-FEASIBILITY.md`（早期调研） |
| **内核 / 右边要不要换成真 Chrome / 套壳方案** | `CHROME-SHELL-PLAN.md`（本轮调研结论 + 分阶段规划；**换内核的实测数字在这里**） |
| **不换内核时怎么更接近真实浏览器（联调场景）** | `ELECTRON-REALISM-PLAN.md`（四维盘点 + P0/P1/P2 清单；`CHROME-SHELL-PLAN.md` 的对照面） |
| **优化路线图（God object / CI / 四个缺口）** | `OPTIMIZATION-PLAN-2026-10-17.md`（决策记录；含一次实验：`WINDOW_NOT_FOCUSED` 是过度防御，实测三轮） |
| **全仓代码质量改造计划** | `CODE-QUALITY-REMEDIATION-PLAN-2026-10-19.md`（16 条 findings + 类型决策表 + 删除/合并清单 + 批次验收；来源是独立全仓 review） |
| **六步执行的施工图** | `EXECUTION-PLAN-2026-10-17.md`（每步：现状 / 方案 / 落点 / 验收 / 风险；含调研发现会改变做法的 5 条） |
| **CLI 结构梳理** | `CLI-REVIEW-2026-10-17.md`（命令树 + 问题清单 + 建议；实测发现命令清单三处漂移、未知组静默成功） |
| **产品架构（插件 / 叠层 / 安装入口）** | `PRODUCT-ARCHITECTURE-2026-10-17.md`（含「前端组件为什么盖不住页面」；§6 是已实施部分） |
| **外壳路由 + 插件 CLI + 一键安装** | `SHELL-PLUGIN-PLAN-2026-10-17.md`（rail 当路由、环境列表只属于环境页、`plugin commands` / `plugin create`、发布链路缺口） |
| **Warren 优化 + Whistle 预设模板** | `WARREN-OPTIMIZATION-WHISTLE-PRESETS-PLAN-2026-10-19.md`（Lease / 截图 / 网络记录 / 浏览器动作 + Whistle 测试、预发布、本地、CDN、Mock 预设施工图） |

## 历史 / 只作参考

- `PRD.md` —— 要做什么（§8 的 CLI 已按实现校准过）。
- `CODEBASE-ASSESSMENT-2026-10-17.md` —— 代码梳理 + 能力评价 + 一次全功能验证记录（**不改代码**）。
- `TECH-STACK-RESEARCH.md` —— 技术选型与被拒方案及理由（**换内核那条的结论在这里**）。
- `CODE-AUDIT-2026-10-14.md` —— 一轮全仓质量审查（15 条发现已全部修掉）。
- `ELECTRON-BROWSER-SHELL-RESEARCH.md` —— 早期桌面壳调研。

## 规矩

- **代码地图、运行时路径、踩过的坑**：都在 `HANDOFF.md`，不在别处另起一份。
- **改了 RPC / CLI / 数据模型 / 硬约束 / 运行方式** → 必须同步 `HANDOFF.md` 的「当前状态」
  （见 `AGENTS.md` 的「项目变更记录」）。
- 文档里出现的命令**必须真的存在**：`warren help` 是权威，写完命令顺手对一遍
  （`docs/PRD.md` §8 就是这么校准的）。
