# 外壳布局、交互重整与精密微立体改造 — 实机验收截图归档（2026-11-26 / 27）

对应改造计划：
- 外壳基础架构：[SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md](../../SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md)
- 精密微立体 + 身份微彩 + 交互减负改造：[SHELL-VISUAL-INTERACTION-REFINEMENT-PLAN-2026-11-26.md](../../SHELL-VISUAL-INTERACTION-REFINEMENT-PLAN-2026-11-26.md)（分支 `feat/shell-layout-interaction`）

## 实机采集与像素 ROI 门禁

所有 16 张截图均在真实运行中的 Warren 桌面端 + 本地 fixture（`http://127.0.0.1:8899/cap/form.html`）下，通过锁定当前工作树主窗口 `CGWindowID` 执行 `screencapture -x -o -l <CGWindowID>` 捕获（逻辑尺寸 `1440×920`，物理分辨率 `2880×1840 @2x`），并经独立自动化像素 ROI 脚本校验 **16/16 PASS**：

- 所有网页运行态（`01`/`03`–`09`/`14`/`15`）：真实 `WebContentsView` 表单页像素标准差 `stage_std ∈ [12.0, 104.2]`（彻底消除旧版空灰块假象）；
- DevTools 互斥与并存（`06a`/`06b`）：`06a` 内联互斥横幅 `panel-exclusivity-bar` 实测可见、右侧原生 DevTools `right_devtools_std = 45.5`；`06b` 点击一键底部停靠按钮后底部 DevTools `bot_devtools_std = 32.4` 与右侧工作台 `right_insp_std = 10.9` 同屏并存；
- 深/浅双主题 AI 活跃护盾（`08`/`15`）：边缘靛蓝/青蓝光学环像素数分别达 `33,992 px`（深色）与 `33,989 px`（浅色），右上角磨砂实时遥测芯片、外扩目标锚框与右下角 AI 光标均清晰无遮挡；
- 全局命令面板（`13`）：居中浮层 `modal_std = 38.1`、相对暗化模糊遮罩亮度差 `58.2`；
- 浅色三层冷银白材质（`14`/`15`）：侧栏均值 `light_sb = 234.5`，18/18 组深/浅 WCAG 2.1 对比度全过；
- 经 3 轮独立视觉盲评子代理全量复验，最终达成 **0 P0 / 0 P1**，综合视觉与 UX 评分提升至 **9.3–9.7 / 10**。

## 截图索引（共 16 张）

| 序号 | 文件 | 验收状态 | 覆盖页面与关键状态 |
| :--- | :--- | :--- | :--- |
| 01 | [01-main-dark-person.png](./01-main-dark-person.png) | PASS | 暗色主界面：4 层微冷灰炭纵深、12 色环境身份微标 + 统一 2 行布局 + 实心方块停止键、精简 3 枚右侧地址栏图标 + 内嵌复制 URL、`[🔍 ⌘K]`、真实网页渲染 |
| 02 | [02-stopped-env-cta.png](./02-stopped-env-cta.png) | PASS | 未启动环境：无硬边平滑光晕 `WarrenMark` 磨砂底座、网络出口与完整默认页摘要胶囊、`启动` + `编辑配置` + `Enter` 快捷键引导、停机态置灰工具栏 |
| 03 | [03-workbench-inspector.png](./03-workbench-inspector.png) | PASS | 右侧工作台抽屉（`360px`）：内置 6 项 + 分隔线 + 插件双色微标（`👤` 账号 / `🌐` 代理）、无假溢出裁切与分组快捷切换器、全中文化事件流 + 角色/关键词筛选条 |
| 04 | [04-workbench-whistle-tab.png](./04-workbench-whistle-tab.png) | PASS | 工作台抽屉 Whistle「代理」Tab：结构化空态卡片 + 直达全局代理页 CTA（消除死胡同），零内部文档泄露 |
| 05 | [05-workbench-accounts-tab.png](./05-workbench-accounts-tab.png) | PASS | 工作台抽屉「账号」Tab：琥珀底色/描边常驻明文警示 + 「高敏凭据改用加密 Vault →」直达链接、当前站点识别、空态新增测试账号 CTA |
| 06a | [06a-devtools-right-exclusive.png](./06a-devtools-right-exclusive.png) | PASS | DevTools 右侧停靠自动互斥收起工作台，于地址栏下方展示 32px 内联 Infobar（含「改用底部停靠并行查看」一键按钮），右上角工具栏零 Toast 遮挡 |
| 06b | [06b-devtools-bottom-coexist.png](./06b-devtools-bottom-coexist.png) | PASS | 点击内联 Infobar 一键切换后：底部原生 DevTools + 网页 + 右侧 `360px` 工作台三区同屏并存，`</>` 与 `◫` 双激活高亮 |
| 07 | [07-agent-idle-readonly.png](./07-agent-idle-readonly.png) | PASS | Agent 空间空闲只读态：顶栏单一 `[● Agent 空闲（只读）｜ ✋ 接管编辑]` 控制胶囊、四边冷灰虚线只读边框、零视口冗余浮标 |
| 08 | [08-agent-active-ai-shield.png](./08-agent-active-ai-shield.png) | PASS | 暗色模式 Agent 活跃操控态：靛蓝/青蓝光学边框与顶部扫光、顶栏身份控制胶囊 + 视口右上精简实时遥测芯片（`● fill #name`）、外扩目标锚框与避字 AI 光标 |
| 09 | [09-sidebar-collapsed.png](./09-sidebar-collapsed.png) | PASS | 左侧栏收起至 `0px` 全宽舞台、顶栏环境身份胶囊清晰指示当前环境、macOS 红绿灯自然避让 |
| 10 | [10-global-settings-dark.png](./10-global-settings-dark.png) | PASS | 暗色全局设置页：居中可读版心（`max-w-3xl`）、全宽迷你窗口 `ThemePreviewThumb` 预览卡、主次分明的 `WARREN_HOME` 路径卡、插件双色品牌图标 |
| 11 | [11-global-accounts-page.png](./11-global-accounts-page.png) | PASS | 全局账号管理页：`1040px` 居中版心、统一琥珀 `👤` 品牌体系（与 `🔑` 加密 Vault 解耦）、真琥珀底色明文警示带 + 「前往加密 Vault」CTA、平衡描边空态卡 |
| 12 | [12-global-whistle-page.png](./12-global-whistle-page.png) | PASS | 全局 Whistle 代理页：与账号页同宽 `1040px` 居中版心、青色地球品牌徽章、平衡描边空态卡与次级线框 CTA |
| 13 | [13-command-palette.png](./13-command-palette.png) | PASS | `⌘K` 全局命令面板：全窗模糊暗化遮罩、分组标题（`环境`/`当前环境操作`）、环境色标徽章 + 状态点、唯一选中行内缩高亮、`<Kbd>` 键帽与底部快捷图例 |
| 14 | [14-light-mode-main.png](./14-light-mode-main.png) | PASS | 浅色模式主界面：3 层冷银白材质（`#e9edf3` / `#f4f6fa` / `#ffffff`）、高辨识度 4 色环境微标、AA 对比度达标、工作台全标签无裁切与琥珀明文警示 |
| 15 | [15-light-mode-agent-shield.png](./15-light-mode-agent-shield.png) | PASS | 浅色模式 Agent 活跃护盾：白底高对比深靛蓝光学环 + 浅色磨砂遥测芯片（`● fill #name`）+ 外扩目标锚框与避字 AI 光标 |
