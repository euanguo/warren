/**
 * 把 Electron 的默认 UA 改写成真 Chrome 的形状。纯函数，可单测。
 *
 * Electron 默认 UA 的产品段会插入**应用名和 Electron 版本**（实测 Warren 里是
 * `Warren/0.1.0 Chrome/152.0.7977.130 Electron/44.7.0`），而真 Chrome 的产品段只有
 * `Chrome/<major>.0.0.0` —— Chrome 从 101 起把 UA 里的版本冻结成 `<major>.0.0.0`。
 * 对照实测见 `docs/CHROME-SHELL-PLAN.md` §2.7。
 *
 * **只保留平台段、产品段整个重建**：不要去逐个删 token。第一版只删了 `Electron/x.y.z`，
 * 漏掉 `Warren/0.1.0`，实测才发现 —— Electron 插几个 token 是会变的。
 */
export function chromeUserAgent(defaultUa: string): string {
  const platform = defaultUa.match(/^Mozilla\/5\.0 \(([^)]*)\)/)?.[1];
  const major = defaultUa.match(/Chrome\/(\d+)/)?.[1];
  // 形状不认识就原样返回，宁可留着 Electron 字样也不要吐一个坏 UA
  if (!platform || !major) return defaultUa;
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
