# Warren Whistle 预设能力设计

> 状态：已实现。本文只描述通用机制，不包含任何组织内部 IP、域名、账号或本机路径。
> 日期：2026-10-19

## 1. 边界

Warren 仓库负责：

- 预设 schema、校验、变量替换、分层合成、冲突检测；
- 预设的导入、保存、版本、预览、应用和回滚；
- 用户导入后的 SQLite 持久化。

Warren 仓库不负责：

- 分发某个组织的测试环境、预发布环境或内部域名清单；
- 把真实后端 IP、账号、应用 ID 或本机路径写进默认值；
- 自动启用代理、外部文件或匿名规则。

真实预设属于用户本地资产，由用户导入。共用流程可放在个人 skill 或团队私有配置库中。

## 2. 核心概念

| 概念 | 含义 | 生命周期 |
| --- | --- | --- |
| Preset | 可复用的规则模板、变量声明与层定义 | 由用户导入并版本化 |
| Profile | 某实例的预设、变量、层开关与覆盖规则 | 跟随实例 |
| Revision | Preset 的不可变快照 | 可回滚 |
| Instance | 正在运行的 Whistle 进程 | 由插件托管 |

## 3. Schema 示例

下面只使用 RFC 2606 / RFC 5737 的保留值：

```json
{
  "schemaVersion": 1,
  "id": "example.test.console",
  "name": "示例测试环境",
  "category": "example / test",
  "builtin": false,
  "variables": {
    "backendIp": {
      "type": "ip",
      "label": "测试后端",
      "required": true
    },
    "consolePort": {
      "type": "port",
      "label": "本地控制台端口",
      "required": true
    }
  },
  "layers": [
    {
      "id": "backend",
      "kind": "backendMap",
      "enabled": true,
      "target": "{{backendIp}}",
      "hosts": ["console.example.com", "buy.example.com"]
    },
    {
      "id": "local-console",
      "kind": "localAssets",
      "enabled": true,
      "rules": [
        "/\\/static\\/app\\.js/ http://127.0.0.1:{{consolePort}}/app.js"
      ]
    }
  ]
}
```

严格约束：

- `id` 创建后不可变。
- 每次编辑产生新 revision。
- 导入内容默认是 draft，必须预览后才能应用。
- 未解析变量、非法 IP/端口、重复 layer 和未知 layer kind 必须阻止应用。
- 导入的 `file://`、宽泛 `ignore://*`、`proxyHost` 必须产生 warning。

## 4. 变量与安全

变量语法统一为 `{{variable}}`，不要复用 Whistle Values 的 `{name}`。

支持类型：

| 类型 | 校验 |
| --- | --- |
| string | 非空、不能含换行 |
| number | 整数和范围 |
| boolean | true / false |
| enum | 枚举集合 |
| ip | IPv4 或 IPv4:端口 |
| host | 主机名，不带 scheme/path |
| port | 1..65535 |
| url | 仅 http/https |

变量值不能拼接新行。包含换行的变量一律拒绝，防止规则注入。

## 5. 层与合成

支持的层类型：

- `envOperator`
- `bypass`
- `direct`
- `hostRewrite`
- `backendMap`
- `cdnMap`
- `cdnPreview`
- `cdnPin`
- `localAssets`
- `mock`
- `raw`

合成顺序由显式 `order` 或 `kind` 决定，不依赖“越具体越优先”的直觉。

应用前检查：

- 同一 host 是否指向多个 target；
- 两个本地资源层是否使用不同端口；
- 宽泛规则是否吞掉登录、订单或支付路径；
- `proxyHost` 是否在用户未确认时启用；
- `file://` 是否越过允许目录。

`error` 阻止应用；`warning` 需要显式 `allowWarnings`。

## 6. 用户导入流程

推荐流程：

1. 从私有 skill、团队配置库或本地文件选择预设 JSON。
2. 在 Warren 的 Whistle 面板中导入。
3. 检查变量、层、warning 和合成后的文本。
4. 先预览，再应用。
5. 应用后回读规则正文、selected 状态和 hash。

命令行示例：

```bash
warren plugin run com.warren.whistle presetImport \
  --input='{"text":"<规则文本>","id":"example.local","name":"示例本地规则"}'

warren plugin run com.warren.whistle presetPreview \
  --input='{"id":"example.local","variables":{"localPort":19000}}'

warren plugin run com.warren.whistle presetApply \
  --input='{"storage":"<实例>","id":"example.local","variables":{"localPort":19000},"expectedHash":"<preview hash>"}'
```

## 7. 存储

预设和 revision 存插件 SQLite，不存仓库目录：

- `whistle_presets`
- `whistle_preset_revisions`
- `whistle_profiles`
- `whistle_profile_history`

实例列表仍存插件的 kv `instances`。

## 8. 验收

- 仓库内不存在真实组织预设文件。
- 测试只使用保留域名和保留 IP。
- 导入、预览、应用、删除、revision 和 rollback 都有测试。
- 预设目录不应存在自动 seed；用户导入是唯一写入口。
