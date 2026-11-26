# 外壳布局、交互重整与 AI 操作蒙层 — 实机验收截图归档（2026-11-26）

对应改造计划：[SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md](../../SHELL-LAYOUT-INTERACTION-PLAN-2026-11-26.md)（分支 `feat/shell-layout-interaction`）。

所有截图均由 `screencapture -x -o -l <CGWindowID>` 直接捕获 Warren 主窗口（逻辑尺寸 `1440×920`，物理分辨率 `2880×1840 @2x`），并经 4 轮视觉与交互审计复核至 **0 P0 / 0 P1**。

## 截图索引（共 16 张）

| 序号 | 文件 | 验收状态 | 覆盖页面与关键状态 |
| :--- | :--- | :--- | :--- |
| 01 | [01-main-dark-person.png](./01-main-dark-person.png) | PASS | 暗色主界面：2 层 `40px + 40px` 顶栏、侧栏头 `40px` 底线对齐、我的空间零接管噪音、实机网页渲染 |
| 02 | [02-stopped-env-cta.png](./02-stopped-env-cta.png) | PASS | 未启动环境中央主启动 CTA、`编辑配置`、`Enter` 快捷键引导、可编辑地址栏与干净顶栏 |
| 03 | [03-workbench-inspector.png](./03-workbench-inspector.png) | PASS | 右侧工作台抽屉（`360px`）展开，9 个 Tab（内置 6 项 + 记忆/账号/代理）左对齐无裁切与事件流 |
| 04 | [04-workbench-whistle-tab.png](./04-workbench-whistle-tab.png) | PASS | 工作台抽屉切换至 Whistle「代理」伴随 Tab，自动滚入视口与结构化空态指引卡片 |
| 05 | [05-workbench-accounts-tab.png](./05-workbench-accounts-tab.png) | PASS | 工作台抽屉切换至「账号」伴随 Tab，常驻明文存储安全警告、当前站点识别与空态引导卡 |
| 06a | [06a-devtools-right-exclusive.png](./06a-devtools-right-exclusive.png) | PASS | DevTools 右侧停靠自动互斥收起工作台抽屉，并在 `top-right` 顶栏安全区展示互斥提示 Toast |
| 06b | [06b-devtools-bottom-coexist.png](./06b-devtools-bottom-coexist.png) | PASS | DevTools 底部停靠与 `360px` 右侧工作台抽屉三栏并存（自动清除过期互斥提示） |
| 07 | [07-agent-idle-readonly.png](./07-agent-idle-readonly.png) | PASS | Agent 空间空闲只读态：`1.5px` 静态冷灰护盾边、顶栏同心圆角控制胶囊、底部零黑药丸 |
| 08 | [08-agent-active-ai-shield.png](./08-agent-active-ai-shield.png) | PASS | 暗色模式 Agent 活跃操控态：青蓝呼吸光晕、顶部 `2.5px` 扫光、AI 光标/目标锚框/动作标签、中心 100% 透明 |
| 09 | [09-sidebar-collapsed.png](./09-sidebar-collapsed.png) | PASS | 左侧栏收起至 `0px` 全宽舞台、顶栏环境胶囊清晰指示当前环境、同心圆角外框 |
| 10 | [10-global-settings-dark.png](./10-global-settings-dark.png) | PASS | 暗色全局设置页：三栏 `0px` 绝对居中全局顶栏、单返回按钮、左侧搜索+3 分组、底层工作区保活 |
| 11 | [11-global-accounts-page.png](./11-global-accounts-page.png) | PASS | 全局账号管理全页视图：`1040px` 对称居中版心、常驻明文安全提醒与全局导航栏 |
| 12 | [12-global-whistle-page.png](./12-global-whistle-page.png) | PASS | 全局 Whistle 代理全页视图：精简「内置 Whistle」副标题与清晰空态引导 |
| 13 | [13-command-palette.png](./13-command-palette.png) | PASS | `⌘K` 全局命令面板：全窗模糊压暗遮罩覆盖原生网页无穿透、像素级居中、含环境与全局页入口 |
| 14 | [14-light-mode-main.png](./14-light-mode-main.png) | PASS | 浅色模式主界面：`#eff1f4` 浅灰顶栏/侧栏清晰托起 `#ffffff` 画布与 `360px` 右侧工作台 |
| 15 | [15-light-mode-agent-shield.png](./15-light-mode-agent-shield.png) | PASS | 浅色模式 Agent 活跃护盾：白底高辨识度清透青蓝内晕、顶边扫光、AI 光标与锚框标签 |
