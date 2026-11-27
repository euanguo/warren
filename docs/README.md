# docs 阅读顺序

本目录的文档，**不要按文件名读**。按目的挑：

## 接手 / 想知道「现在到哪了」

1. **`HANDOFF.md`** —— 会话交接：决策、当前状态、踩过的坑、接手起点。**先读这份。**
2. **`CODE-ARCHITECTURE-QUALITY-PLAN-2026-11-27.md`** —— **全仓库零 Shim 代码质量与架构质量改造记录**（Wave 0–4 已落地验收）：P0 安全边界与竞争态止血、全仓死代码/SHIM 清理、3 个 SCC 解环与单源契约、大模块垂直拆分、`tsc -p tsconfig.check.json` / `npm run check` 与配套文档对齐。
3. **`WARREN-2.0-ARCHITECTURE-PLAN.md`** —— **Warren 2.0 全面重构架构总蓝图**（2026-11-26，已落地）：叠层根治、停靠式 DevTools、核心解耦与插件 2.0、UI/设置中心重构、Agent CLI v2。
4. **`SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md`** / **`SHELL-VISUAL-INTERACTION-REFINEMENT-PLAN-2026-11-26.md`** —— **外壳布局、微立体视觉与 AI 操作蒙层改造计划**（2026-11-26，已落地验收）。
5. **`PLUGIN-ECOSYSTEM-2.0-PLAN.md`** —— **插件生态 2.0：业务插件深度重构与插件 Skill 自动注入计划**（2026-11-26，已落地验收）。
6. `REMAINING-PLAN-2026-10-16.md` —— 剩余工作施工计划 + 逐项实测记录（批次 A–G，都已落地）。
7. `FULL-REGRESSION-2026-10-15.md` —— 全量回归指南；当前日常 UI 回归已迁入无头 `tests/ui/`（Vitest + happy-dom），全量真机回归按 `scripts/regress/run-all.sh --allow-full` 显式触发。

## 要改东西

| 你要动 | 先读 |
|---|---|
| 页面操作 / 元素定位 / 等待 / 动作 | `BROWSER-CAPABILITY-PLAN.md`、`BROWSER-CAPABILITY-DEEP-DIVE.md`、`BROWSER-CAPABILITY-PORT-PLAN.md` |
| 标签 / 标签条 | `TAB-MODULE-PLAN.md` |
| 网络拦截 / HAR / mock | `NET-INTERCEPT-PLAN.md` |
| 插件（打包 / 安装 / 权限 / 面 / 运行时 / 存储） | `PLUGIN-PACKAGE-MIGRATION-PLAN-2026-10-20.md`、`PLUGIN-CAPABILITY-DESIGN.md`、`PLUGIN-MODERNIZATION-PLAN.md` |
| 界面 / 组件 / 皮肤 | `SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md`、`ui-design-language.md`、`UI-KIT-MIGRATION.md`、`DESKTOP-SHELL-MIGRATION.md` |
| 打包 / 签名 / 公证 / 更新 | `RELEASE.md` |
| 依赖管理与定期升级规范 | `DEPENDENCY-POLICY.md`（禁用 `latest`、Electron 月度周期、`@types/node` 锁定） |
| 代理（Whistle 插件） | `WHISTLE-PLUGIN-PLAN.md`（当前实现）、`WHISTLE-PROXY-FEASIBILITY.md`（早期调研） |
| **代码质量、模块边界与零 Shim 改造** | `CODE-ARCHITECTURE-QUALITY-PLAN-2026-11-27.md`（Waves 0–4 执行记录） |
| **内核 / 右边要不要换成真 Chrome / 套壳方案** | `CHROME-SHELL-PLAN.md`（`THE` 内核换型实测数据） |
| **不换内核时怎么更接近真实浏览器** | `ELECTRON-REALISM-PLAN.md` |
| **Agent CLI & Browser Ops v3** | `AGENT-CLI-AND-BROWSER-OPS-DEEP-RESEARCH.md`、`CLI-AND-BROWSER-OPS-V3-PLAN.md` |
| **Agent CLI v4（AI-Native 上下文与输出工程）** | `WARREN-V4-AI-NATIVE-CLI-CONTEXT-PLAN.md`（Wave 1–5 实施蓝图） |

## 历史 / 只作参考

- `PRD.md` —— 要做什么（§8 的 CLI 已按实现校准过）。
- `CODEBASE-ASSESSMENT-2026-10-17.md` —— 早期代码梳理 + 能力评价。
- `TECH-STACK-RESEARCH.md` —— 技术选型与被拒方案及理由。
- `CODE-AUDIT-2026-10-14.md`、`OPTIMIZATION-PLAN-2026-10-17.md`、`CODE-QUALITY-REMEDIATION-PLAN-2026-10-19.md` —— 历次全仓审查与改进记录。
- `ELECTRON-BROWSER-SHELL-RESEARCH.md` —— 早期桌面壳调研。

## 规矩

- **代码地图、运行时路径、踩过的坑**：都在 `HANDOFF.md`，不在别处另起一份。
- **改了 RPC / CLI / 数据模型 / 硬约束 / 运行方式** → 必须同步 `HANDOFF.md` 的「当前状态」
  （见 `AGENTS.md` 的「项目变更记录」）。
- 文档里出现的命令**必须真的存在**：`warren help` / `bin/commands.mjs` 与 `warren methods` 是权威。
