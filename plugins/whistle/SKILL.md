# Whistle 代理插件（`com.warren.whistle`）操作指南

本插件为每个 Warren 浏览器环境托管隔离的 `whistle@2.10.15` 实例（独立 `storage`、独立端口、共用受信任根证书），**禁止猜测或回落到全局 `127.0.0.1:8899`**。

---

## 1. AI 代理排障黄金路径

1. **查实例与环境绑定**：`warren plugin run com.warren.whistle list`
   - 若无实例：用 `fork` 新建（`{"storage":"feat-a"}`）；若 `alive:false`：用 `start` 按原端口拉起。
   - 若未绑定当前环境：用 `bind --env=<envId> --input='{"storage":"feat-a"}'`（自动注入根证书并重启运行中环境）。
2. **先体检再抓包**：`doctor --input='{"storage":"feat-a"}'`
   - 确认 `alive: true`、`httpsCapture: true`、`allowMultipleChoice: true`、`rootCa: true`。
3. **规则生效诊断**：改规则前或怀疑规则未命中时，先跑 `ruleTest --input='{"storage":"feat-a","url":"https://api.example.com/v1/user","method":"POST"}'`；若修改过 hosts / 映射怀疑缓存，执行 `clearDnsCache`。
4. **精准抓包（服务端过滤优先）**：用 `traffic` 配合 `type` / `subUrl` / `statusCode` / `latest` 拉取，避免拉全量包撑爆上下文。
5. **定位与验证闭环**：拿到目标 `entryId` 后，用 `replay`（带 `diff: true`）改参重放对比，用 `toCurl` 导出脱敏命令，或用 `captureLink` 生成 `#network?dataUrl=...` 快照链接供人直达查看。
6. **用完清理**：临时 Mock / 故障 / 本地映射结束后，执行 `clearIntents` 停用并清空受控调试组，不污染用户主规则。

---

## 2. 高层调试意图原语（安全不误伤主规则）

所有意图原语**只写入受控规则组**，绝不覆盖用户的 `Default` 或自定义业务组；默认 `append: true`，同一 `pattern` 幂等替换，不同 `pattern` 共存：

| 意图 | 受控组 | 典型入参 | 示例 |
|---|---|---|---|
| `quickMock` | `warren-mock` | `storage, pattern, body, contentType?, statusCode?, delayMs?, cors?, headers?, name?, append?` | `warren plugin run com.warren.whistle quickMock --input='{"storage":"a","pattern":"https://api.example.com/v1/user","body":{"ok":true,"role":"admin"},"statusCode":200,"cors":true}'` |
| `injectFault` | `warren-fault` | `storage, pattern, delayMs?, reqDelayMs?, speedKbps?, statusCode?, disableCache?, disableEncoding?, append?` | `warren plugin run com.warren.whistle injectFault --input='{"storage":"a","pattern":"example.com/api/","delayMs":1500,"speedKbps":32,"disableCache":true,"disableEncoding":true}'` |
| `mapLocal` | `warren-local` | `storage, pattern, targetPort?, targetHost?, targetUrl?, localDir?, protocol?, append?` | `warren plugin run com.warren.whistle mapLocal --input='{"storage":"a","pattern":"app.example.com/static/","targetPort":5173}'` |
| `clearIntents` | 按 `groups` 指定 | `storage, groups?:["mock","fault","local"], removeValues?` | `warren plugin run com.warren.whistle clearIntents --input='{"storage":"a","groups":["mock","fault"],"removeValues":true}'` |

> `quickMock` 会自动把对象 `body` 格式化写入 Values（前缀 `warren-mock-`），并在 `warren-mock` 中生成 `resBody://{...}`。若 `headers` 含空格，会自动拆入独立 `.headers.json` Value，防止 Whistle 空格分词出错。

---

## 3. 服务端过滤抓包（`traffic`）

当实例支持 Whistle Agent API（2.10.7+）时，优先走服务端 `/cgi-bin/sessions` 过滤，**仅返回匹配条目**：

```bash
warren plugin run com.warren.whistle traffic --input='{
  "storage": "a",
  "type": "JSON",
  "subUrl": "/api/v1/",
  "method": ["GET", "POST"],
  "statusCode": [500, 502, 504],
  "latest": true,
  "count": 20
}'
```

- `type` 支持：`JSON`、`HTML`、`CSS`、`JS`、`Font`、`Img`、`Media`、`WS`、`SSE`、`Tunnel`、`Wasm`、`Mock`、`Rules`、`Import`、`Composer`、`Error`、`captureError`。
- 支持请求头/响应头过滤：`reqHeader: {"name":"x-request-id","subValue":"abc"}`、`resHeader: {"name":"content-type","subValue":"json"}`。
- 增量游标：`startId` / `startTime`（或旧游标 `lastRowId` / `dumpCount`）。
- 每条返回附带：`timings: { dns, connect, ttfb, download, total }`（毫秒）与 `matchedRules: [{ protocol, matcher, raw }]`。

---

## 4. Values 一等管理

- `valueList`：`--input='{"storage":"a","query":"mock"}'` —— **默认 `includeValues: false`**（仅返回 `name`、`size` 和 120 字符 `preview`，防止大 JSON 撑爆上下文）；需要正文时用 `valueGet` 或传 `includeValues: true`。
- `valueGet`：`--input='{"storage":"a","name":"mock.json"}'`
- `valueSet`：`--input='{"storage":"a","name":"mock.json","value":{"ok":1}}'`（写后自动回读校验）
- `valueRemove`：`--input='{"storage":"a","name":"mock.json"}'`
- `valueRename`：`--input='{"storage":"a","name":"old.json","newName":"new.json"}'`

---

## 5. 重放对比、cURL 与排障直达链接

- **改参重放与 Diff（`replay`）**：
  ```bash
  warren plugin run com.warren.whistle replay --input='{
    "storage": "a",
    "reqId": "1784905385300-003",
    "headers": {"x-canary": "1"},
    "times": 1,
    "diff": true
  }'
  ```
  自动从原抓包提取 URL/Method/Headers/Body，经 Whistle Composer 重放并返回 `{ original, replayed, diff }`（含 `statusDiff`、`headersDiff`、`jsonDiff`）。
- **导出 cURL（`toCurl`）**：`--input='{"storage":"a","reqId":"..."}'`，默认脱敏敏感请求头。
- **生成排障直达链接（`captureLink`）**：
  ```bash
  warren plugin run com.warren.whistle captureLink --env=<envId> --input='{
    "storage": "a",
    "type": "Error",
    "name": "auth-500-trace",
    "open": true
  }'
  ```
  保存命名快照并通过 Whistle 2.10.14+ `createUrl` 生成 `http://127.0.0.1:<port>/#network?dataUrl=...`，`open: true` 时在环境标签页直接打开。

---

## 6. 规则校验、回滚与安全脱敏规范

1. **安全脱敏红线**：`traffic`、`compose`、`replay`、`toCurl` 默认将 `Authorization`、`Cookie`、`Set-Cookie`、`X-CSRF-Token`、`X-Api-Key`、`password`、`secret`、`token` 等字段脱敏为 `[REDACTED]`；仅在明确排障必需时传 `"includeSensitive": true`，严禁把敏感原值写入对话摘要或笔记。
2. **规则防并发覆盖与回滚**：直接写用户规则组用 `ruleSet` / `presetApply` 时，先读 `hash`，保存时传 `expectedHash`；写入后会强制回读正文 hash 与 `selected: true`，不一致自动回滚到旧内容。
3. **官方 Agent API 直调**：`agent` 同时支持平铺方法名（`isEnabledHTTPS`、`setEnableHTTPS`、`getRootCA`、`createFile`、`getFile`、`createUrl`）与命名空间别名（`https.isEnabled`、`files.create`、`network.createUrl`、`values.remove`、`values.rename` 等）。
