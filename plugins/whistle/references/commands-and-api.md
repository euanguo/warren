# Whistle 插件详细参考与全量命令（`com.warren.whistle`）

仅在需要查 `traffic` 精细过滤字段、重放/导出链接具体参数、官方 Agent API 别名或全部 46 条命令速查时读取本文件；常规字段查看可运行 `warren plugin run com.warren.whistle <cmd> --help`。

## 全量 46 条命令速查（CLI `plugin run` 与前端 `rpc` 同源）

| 域 | 命令 |
|---|---|
| 实例与环境 | `list`、`fork`、`start`、`stop`、`remove`、`bind`、`unbind`、`open` |
| 规则与诊断 | `rules`、`ruleGet`、`ruleSet`、`ruleToggle`、`ruleRemove`、`ruleValidate`、`ruleDiff`、`ruleTest`、`clearDnsCache`、`doctor` |
| 预设与 Profile | `presetList`、`presetGet`、`presetPreview`、`presetApply`、`presetSave`、`presetDelete`、`presetImport`、`presetExport`、`profileGet`、`profileClear` |
| Values 数据区 | `valueList`、`valueGet`、`valueSet`、`valueRemove`、`valueRename` |
| 受控调试意图 | `quickMock`、`injectFault`、`mapLocal`、`clearIntents` |
| 抓包与 Agent API | `traffic`、`compose`、`replay`、`toCurl`、`captureLink`、`frames`、`export`、`agent`、`agentStatus` |

## 常用意图与参数形状

- `quickMock`: `storage, pattern, body, contentType?, statusCode?, delayMs?, cors?, headers?, name?, append?`（对象 `body` 写入 `warren-mock-*` Value；含空格 `headers` 自动拆成 `.headers.json` Value）。
- `injectFault`: `storage, pattern, delayMs?, reqDelayMs?, speedKbps?, statusCode?, disableCache?, disableEncoding?, append?`。
- `mapLocal`: `storage, pattern, targetPort?, targetHost?, targetUrl?, localDir?, protocol?, append?`。
- `clearIntents`: `storage, groups?: ["mock", "fault", "local"], removeValues?`。

## `traffic` 服务端过滤

实例基于 Whistle `2.10.15` Agent API（2.10.7+）优先走 `/cgi-bin/sessions` 服务端过滤：

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
- 支持头过滤：`reqHeader: {"name":"x-request-id","subValue":"abc"}`、`resHeader: {"name":"content-type","subValue":"json"}`。
- 增量游标：`startId` / `startTime`（兼容 `lastRowId` / `dumpCount`）。
- 每条返回附带 `entryId`、`timings: { dns, connect, ttfb, download, total }`（毫秒）及 `matchedRules: [{ protocol, matcher, raw }]`。

## `replay`、`toCurl`、`captureLink` 与官方 `agent`

```bash
# 从 entries[].entryId 取值传给 reqId
warren plugin run com.warren.whistle replay --input='{
  "storage": "a",
  "reqId": "1784905385300-003",
  "headers": {"x-canary": "1"},
  "times": 1,
  "diff": true
}'

warren plugin run com.warren.whistle toCurl --input='{"storage": "a", "reqId": "1784905385300-003"}'

warren plugin run com.warren.whistle captureLink --env=<envId> --input='{
  "storage": "a",
  "type": "Error",
  "name": "auth-500-trace",
  "open": true
}'
```

- `agent` 同时支持平铺方法名（`isEnabledHTTPS`、`setEnableHTTPS`、`getRootCA`、`createFile`、`getFile`、`createUrl`）与命名空间别名（`https.isEnabled`、`files.create`、`network.createUrl`、`values.remove`、`values.rename` 等）。

## 默认脱敏字段清单

以下请求头、JSON 键与对应敏感 URL query 参数均默认脱敏为 `[REDACTED]`：
- HTTP 头：`Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`、`X-CSRFCode`、`X-CSRF-Token`、`X-Xsrf-Token`、`Saas-Token`、`saas_token`、`X-Api-Key`、`X-Auth-Token`。
- JSON 键：`authorization`、`cookie`、`password`、`passwd`、`secret`、`csrfToken`、`saasToken`、`accessToken`、`refreshToken`、`ticket`、`apiKey`、`token`。
