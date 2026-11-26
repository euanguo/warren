const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

/**
 * 发布链路。
 *
 * **签名 / 公证只在有凭据时启用**：环境变量没给就当没这回事，本地 `npm run make` 照样出产物
 * （未签名，自己机器上跑没问题）。给了就签 + 公证：
 *
 * ```bash
 * APPLE_ID=you@example.com \
 * APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx \
 * APPLE_TEAM_ID=XXXXXXXXXX \
 * npm run make
 * ```
 *
 * 凭据**只从环境变量读**，不落进仓库、也不落进配置（`APPLE_ID_PASSWORD` 走的是 App 专用密码，
 * 不是账号密码）。
 */
const shouldSign = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID,
);

module.exports = {
  packagerConfig: {
    asar: true,
    // 打包时**必须显式给**：不给就是 Electron 默认的 `com.github.Electron`
    // （实测——公证也会因为这个 id 认不出应用是谁的）
    appBundleId: 'com.euanguo.warren',
    appCopyright: 'Copyright © 2026 euanguo',
    // macOS 认 icon.icns，Windows/Linux 认 icon.png（assets/ 下两份都在）
    icon: './assets/icon',
    // 自带 Skill 与桌面图标等静态资产跟着 app 走：主进程从 Resources 读取
    extraResource: ['./skills', './assets'],
    // 公证要用 hardened runtime + entitlements；不签名时不传，免得本地跑不起来
    ...(shouldSign
      ? {
          osxSign: {},
          osxNotarize: {
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID,
          },
        }
      : {}),
  },
  rebuildConfig: {},
  makers: [
    // zip：不依赖额外系统工具，拿来发给自己 / 内测最省事
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux', 'win32'] },
    // dmg：macOS 上给人装的常规形状（需要系统里的 hdiutil，macOS 自带）
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'], config: { format: 'ULFO' } },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          { entry: 'src/main/main.ts', config: 'vite.main.config.mjs' },
          { entry: 'src/preload/preload.ts', config: 'vite.preload.config.mjs' },
          // 环境页（WebContentsView）的 preload，见 src/preload/page-preload.ts
          { entry: 'src/preload/page-preload.ts', config: 'vite.preload.config.mjs' },
        ],
        renderer: [{ name: 'main_window', config: 'vite.renderer.config.mjs' }],
      },
    },
    {
      name: '@electron-forge/plugin-fuses',
      config: {
        version: FuseVersion.V1,
        [FusesPlugin]: {
          [FuseV1Options.RunAsNode]: false,
          [FuseV1Options.EnableCookieEncryption]: true,
          [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
          [FuseV1Options.EnableNodeCliInspectArguments]: false,
          [FuseV1Options.OnlyLoadAppFromAsar]: true,
          [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        },
      },
    },
  ],
};
