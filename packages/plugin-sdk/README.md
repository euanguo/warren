# @warren/plugin-sdk

Warren 插件的包契约与类型声明（[index.d.ts](index.d.ts)），版本与 `package.json#warren.apiVersion`（`"4"`）对齐，已纳入项目根 `tsconfig.check.json` 类型检查。

插件包必须包含 `package.json` 的 `warren` 字段；不再使用独立的 `manifest.json`。

## 最小包清单

```json
{
  "name": "warren-plugin-example",
  "version": "0.1.0",
  "warren": {
    "id": "com.example.plugin",
    "name": "Example",
    "apiVersion": "4",
    "runtime": "sandbox",
    "server": "server.js",
    "app": "app.js",
    "permissions": ["environment.read", "ui.mount"],
    "contributes": {
      "commands": [{ "name": "hello", "summary": "示例命令" }],
      "settings": [],
      "surfaces": [{ "kind": "inspectorTab", "id": "main", "title": "示例", "icon": "Plug" }],
      "rpc": ["ping"]
    }
  }
}
```

## 核心类型索引

| 分类 | 类型 | 说明 |
|---|---|---|
| 包清单 | `WarrenPluginPackageJson` / `WarrenPackageMetadata` / `WarrenSkillMetadata` | `package.json#warren` 校验契约与 Agent Skill 元数据 |
| 权限与挂载面 | `PluginPermission` / `PluginSurfaceKind` / `PluginSurfaceDecl` | 14 项可授权限与 8 种 UI 挂载点（未声明的面 fail-closed 拒绝） |
| 后端运行时 | `PluginServerModule` / `PluginContext` / `PluginHost` | 覆盖 `environment` / `browser`（含 `fillSecret` & `detectLoginFields`）/ `vault` / `cookie` / `storage` / `events` / `signal` |
| 前端运行时 | `PluginRegisterFn` / `PluginAppApi` / `PluginUi` / `PluginShellApi` / `PluginHostApi` | 注入宿主 React、`app.ui` 组件库、`app.shell`（不含历史 `navigation`）、`app.host` 与 `surfaces.envBadge` setter |
