/**
 * 能不能交给系统打开。
 *
 * `shell.openExternal` 会把 URL 交给 macOS 的「打开方式」，那是个**任意协议处理器**：
 * `file://` 打开本地文件、`smb://` 挂载网络共享、`vscode://` 唤起别的应用。
 * 而 URL 的来源是页面自己的 `currentUrl`——一个诱导页面可以先把自己导航到
 * 那种地址，再等人点一下「在外部浏览器打开」。
 *
 * 所以只放行网页协议。这不是"功能阉割"，是产品定义：这个功能叫"在外部浏览器打开"，
 * 浏览器本来就只处理 http/https。
 */
export function isOpenableExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
