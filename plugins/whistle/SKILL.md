---
name: whistle
description: 管理 Warren 环境的独立 whistle@2.10.15 代理，用于 HTTPS 抓包分析、Rules/Values/Presets 编排、受控 Mock/故障注入/本地映射及改参重放 diff；简单内置单条拦截请用 warren net。
---

# Whistle 代理插件（`com.warren.whistle`）

为每个 Warren 环境托管隔离的 `whistle@2.10.15` 实例（独立 `storage` 与端口、共用根证书）。操作全量通过 `warren plugin run com.warren.whistle <cmd>`（或对应 RPC）执行，**不回落到全局 `127.0.0.1:8899`**。

## 排障闭环（Golden Path）

1. **定位或建立绑定实例**：运行 `list` 检查已有实例（以 `storage` 字段标识）；无可用实例时 `fork` 新建（或对 `alive:false` 执行 `start`），未绑定当前环境时执行 `bind --env=<envId>`（自动写入 proxy、信任根证书并重启运行中环境）。
2. **先体检再配规则**：执行 `doctor --input='{"storage":"<id>"}'`，确认 `alive`、`httpsCapture`、`allowMultipleChoice`、`rootCa` 全部为 `true` 后再操作规则。
3. **验证规则与清理缓存**：改动规则前或规则疑未命中时，用 `ruleTest` 诊断具体 URL；改过 hosts / 映射后调 `clearDnsCache`。
4. **服务端过滤抓包**：优先带 `subUrl`、`type`、`statusCode`、`latest` 与 `count` 调 `traffic`，禁止全量拉取撑爆上下文。
5. **定位重放与清理收口**：从 `traffic` 返回条目读取 `entries[].entryId`，作为 `reqId` 传给 `replay`（设 `diff: true` 对比改参差异）、`toCurl` 或 `captureLink`；临时调试结束后执行 `clearIntents` 清空受控组，确认无关主规则未受影响。

```bash
warren plugin run com.warren.whistle list
warren plugin run com.warren.whistle bind --env=<envId> --input='{"storage":"feat-a"}'
warren plugin run com.warren.whistle doctor --input='{"storage":"feat-a"}'
warren plugin run com.warren.whistle quickMock --input='{"storage":"feat-a","pattern":"https://api.example.com/v1/user","body":{"ok":true},"statusCode":200,"cors":true}'
warren plugin run com.warren.whistle traffic --input='{"storage":"feat-a","subUrl":"/api/","latest":true,"count":20}'
warren plugin run com.warren.whistle clearIntents --input='{"storage":"feat-a","groups":["mock","fault","local"],"removeValues":true}'
```

## 高层意图原语与规则选型

- 临时 Mock、延迟/限速故障与本地端口目录映射，统一用 **`quickMock` (`warren-mock`)**、**`injectFault` (`warren-fault`)**、**`mapLocal` (`warren-local`)**；同 `pattern` 幂等替换，绝不污染用户 `Default` 或业务规则组。
- 直接编辑持久化规则组或预设时（`ruleSet` / `presetApply`），必须先读取最新正文 `hash` 并传 `expectedHash` 防覆盖；写入后插件会自动校验正文 hash 与 `selected: true`，失败时回滚旧规则。

## 安全脱敏边界与导出限制

- `traffic` 条目默认不返回 `requestBodyRaw` / `responseBodyRaw`；`valueList` 默认 `includeValues: false`（仅返回摘要与 120 字符 `preview`）。
- `traffic`、`compose`、`replay`、`toCurl`、`agent`、`export` 在 **Agent 通道强制脱敏**（即便传入 `"includeSensitive": true` 也会被宿主收口为 `false`），敏感请求头、敏感 JSON 键与敏感 URL query 参数统一替换为 `[REDACTED]`；`replay` 在服务端从原始抓包合并改写项发出。若排查确需未脱敏 Cookie / HAR，只能由用户在 Warren 桌面端 Whistle 界面手动查看或导出。
- `export` 写入文件路径受限于受管目录（`~/.warren/artifacts/` 或系统临时目录），禁止写入其它任意磁盘路径。

## 按需查阅详细参数与全量命令

- 需要 `traffic` 全部过滤字段与 17 种 `type`、`replay` / `toCurl` / `captureLink` 示例、`agent` 平铺与命名空间别名、完整脱敏键名表或 46 条命令全量速查时，读取 [`references/commands-and-api.md`](references/commands-and-api.md) 或执行 `warren plugin run com.warren.whistle --help`。
