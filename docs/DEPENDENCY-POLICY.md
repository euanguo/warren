# Warren 依赖管理与定期升级规范

> 状态：生效中  
> 日期：2026-11-26  
> 适用范围：`package.json`、`package-lock.json`、构建链路与静态检查工具

---

## 1. 版本约束红线

1. **禁止使用 `"latest"` 或 `"*"`**：所有 `dependencies` 与 `devDependencies` 必须声明明确版本或受控语义化范围（`^x.y.z`）。
2. **精确钉死高风险基础设施版本**（不加 `^`/`~`）：
   - `electron`：绑定对应 Chromium / Node ABI 与主进程行为，仅在专项验证后升版。
   - `oxlint`：不同 minor 版本会引入新内置规则导致 CI 突然变红，必须精确钉死版本并单开评估。
   - `typescript`：跟随原生预览版兼容进展，精确钉死版本。
3. **`@types/node` 与 Electron 内置 Node 主版本严格对齐**：
   - Electron 44 / 45 内置运行时均为 **Node 24.x**。
   - `@types/node` 必须锁定在 `^24.x`（禁止升入 `25+` / `26+`），防止类型检查放行 Electron 运行时不存在的 Node API。
4. **`@vitejs/plugin-react` 与 `shadcn` 的 Babel 对齐**：`shadcn` 依赖 `@babel/core@^7.28`，`@vitejs/plugin-react` 升级前需确认未通过 `@rolldown/plugin-babel` 强制拉入 `@babel/core@8` 导致 `ERESOLVE`。
4. **禁止引入 Copyleft 生产依赖**：禁止往运行时打包树引入 GPL / AGPL 许可证包（详见 `docs/WARREN-2.0-ARCHITECTURE-PLAN.md` §0.2）。

---

## 2. 定期升级节奏

| 周期 | 升级对象 | 策略与操作方式 |
|---|---|---|
| **每 4 周**（月度，跟随 Chromium 大版本） | `electron` | 先读目标版本 Release Notes 与 Breaking Changes（重点核查 `WebContentsView`、`sandboxed preload`、CDP 域、Fuses 兼容性），再升级精确版本号并同步验证 `scripts/electron-name.mjs` 与打包。 |
| **每 8 周**（双月） | 前端与构建依赖（`react`、`react-dom`、`tailwindcss`、`@base-ui/react`、`vite`、`react-resizable-panels`、`@electron-forge/*`、`@hugeicons/*`） | 小版本补丁随周期批量升级；跨越 5 个以上 minor 的核心布局/构建库（如 `react-resizable-panels`、`vite`）单独建提交验证。 |
| **按需独立提交** | `oxlint`、`prettier`、`typescript` | 仅在独立 PR/提交中升级并处理新增规则或全仓格式化 diff，**禁止**与业务功能重构混在同一个 commit 里。 |
| **每周 CI / 随时响应** | 安全漏洞依赖（`npm audit`） | 出现高危漏洞时立即评估升级路径；忽略仅开发期无暴露面的低风险误报需在 PR 说明理由。 |

---

## 3. 升级前核查清单

每次升级 Electron 或核心运行库前，按序核对：
1. 执行 `npm outdated --long` 与 `npm audit --json` 识别跨大版本包及漏洞状态。
2. 升级 Electron 时，逐条核对：
   - `src/preload/preload.ts` 与 `src/preload/page-preload.ts` 是否触发 sandboxed preload 限制变化；
   - `forge.config.cjs` 的 `FusesPlugin` 选项在新版本下是否仍有效；
   - `src/main/domain/user-agent.ts` 中的测试/文档版本注解是否需要校准（逻辑本身仅做正则/字符串剥离，不写死具体版本号）。
3. 升级 `@electron-forge/*` 或 `vite` 时，验证渲染层打包与 `npm start` 主进程构建无异常。

---

## 4. 升级后强制门禁

任何依赖变更提交前，必须在项目根目录依次通过：

```bash
npm run check
# 等价于：
# npm run lint
# npm run format:check
# npm run typecheck
# npm test
# node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs
```

涉及 `electron`、构建插件或底层运行时升级时，还须重启桌面端验证 `node bin/warren.mjs call debug.layout` 正常挂载并确认关键页面渲染无退化。
