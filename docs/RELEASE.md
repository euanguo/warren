# 发布链路

> 目标：**本机不带任何凭据也能出产物**；有 Apple 凭据时才签名 + 公证。
> 配置在 `forge.config.cjs`，凭据**只从环境变量读**（不落仓库、不落配置）。

---

## 1. 出产物（不需要凭据）

```bash
npm run make
# → out/make/zip/darwin/arm64/Warren-darwin-arm64-0.1.0.zip   （121 MB，实测）
# → out/make/dmg/arm64/Warren-0.1.0-arm64.dmg                （121 MB，实测）
```

**实测（2026-10-16）**：两个产物都出得来，签名是 **adhoc（未签名）**——
`codesign -dv out/Warren-darwin-arm64/Warren.app` 显示 `Signature=adhoc`。
自己机器上跑没问题；**发给别人会被 Gatekeeper 拦**（见下一节）。

打包时 `appBundleId` 必须显式给（现在是 `dev.saywhy.warren`）：不给就是 Electron 的默认值
`com.github.Electron`（实测），公证会因为这个 id 认不出应用是谁的。

`npm run make` 会先跑一遍 Vite 构建（主进程 + preload + 渲染层）。**别在 `npm start` 还开着的时候跑**——
两边的 Vite 都往 `.vite/` 写，实测会以 `Can't resolve …` 这种看着像代码错的报错失败。

## 2. 签名 + 公证（需要 Apple 开发者账号）

```bash
APPLE_ID=you@example.com \
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx \
APPLE_TEAM_ID=XXXXXXXXXX \
npm run make
```

三个变量齐了才启用（`shouldSign`）：`osxSign`（hardened runtime + entitlements）+
`osxNotarize`。缺一个都当没凭据处理——**不会**半签半公证地出个四不像的产物。

凭据从哪来：
- `APPLE_ID`：开发者账号邮箱
- `APPLE_APP_SPECIFIC_PASSWORD`：appleid.apple.com → 登录与安全 → App 专用密码（**不是账号密码**）
- `APPLE_TEAM_ID`：developer.apple.com 的 Membership 页

公证过的产物要验证：`spctl -a -vvv -t install out/make/zip/darwin/arm64/*.zip` 应当报 `accepted`。

## 3. 自动更新：**先不做**（配方留在这里）

没做，理由：更新要有一个**发布源**才有意义，而现在还没有 CI / Release；没发布源就没法做端到端验证，
只能塞一段「看起来对但没人验过」的代码——这个仓库不接受那种东西。

要做的时候（估计 2 小时 + 一次真实发布）：

1. `npm i electron-updater`，在 `package.json` 里加 `build.publish = { provider: 'github', owner: 'saywhy-dev', repo: 'warren' }`；
2. 主进程 `app.whenReady()` 里，**只在 `app.isPackaged` 时** `autoUpdater.checkForUpdatesAndNotify()`；
3. 更新源要走 GitHub Releases：`npm run make` 之后把 zip/yml 传到 Release（`electron-builder` 家族的文件格式；
   Forge 的 zip maker 产物形状和它不完全一致，这一条要单独验）；
4. 验证方式：发一个 `0.1.1` 的 Release，装 `0.1.0` 启动，确认它提示并装上了——**没做这一步就等于没做**。

## 4. 还没做的（发布相关）

- **Windows / Linux 产物**：makers 里配了 zip 的 `win32`/`linux`，但没在对应平台上跑过（Forge 的跨平台打包
  要各自的宿主）。要做就在对应平台跑一次 `npm run make`。
- **CI**：没有 workflow；每次发布是手工 `npm run make`。
- **更新签名**：`electron-updater` 在 macOS 上要求产物是签名的（第 2 节），两者要一起做。
