# Whistle 代理

Warren 插件 `com.warren.whistle`。

- 每个环境一个独立 Whistle 实例（独立 `storage` 与端口，不猜全局 `8899`）
- 规则、Values、预设、服务端过滤抓包、意图原语（`quickMock` / `injectFault` / `mapLocal`）、`replay` diff、cURL 导出、排障直达链接（`captureLink`）和环境绑定
- 依赖固定为 `whistle@2.10.15`，始终优先使用插件内置 CLI

`w2Path` 只在插件内置 Whistle 缺失时作为兜底，不会覆盖内置版本。内置 CLI 由桌面端自带的
Node 执行，并把该 Node 通过 `STARTING_EXEC_PATH` 传给 Whistle 的守护进程，因此不依赖机器上
安装的 Node；`/tmp` 里残留或版本不匹配的外部脚本也不会再影响插件启动。
