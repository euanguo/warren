# @warren/plugin-sdk

Warren 插件的包契约与作者类型。版本与 `package.json#warren.apiVersion` 对齐。

插件包必须包含 `package.json` 的 `warren` 字段；不再使用独立的 `manifest.json`。

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
    "permissions": ["environment.read"],
    "contributes": {}
  }
}
```
