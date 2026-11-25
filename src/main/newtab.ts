/**
 * `warren://newtab` 的页面内容。
 *
 * 是一张**静态页**：没有脚本、没有外部资源，所以这个 scheme 不需要任何 CSP 例外，
 * 也不需要给被控页面开什么口子。环境名由主进程按 `?env=<id>` 现查现填。
 */

/** 环境名是用户输入，插进 HTML 之前必须转义。 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function newTabPage(environment?: { id: string; name: string; proxy?: string }): string {
  const name = escapeHtml(environment?.name ?? '未知环境');
  const id = escapeHtml(environment?.id ?? '—');
  const egress = environment?.proxy ? escapeHtml(environment.proxy) : '直连（没有配代理）';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>新标签页</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-content: center;
    background: #181818; color: #f2f2f2;
    font: 14px/1.6 -apple-system, "Helvetica Neue", "PingFang SC", sans-serif;
  }
  main { width: 26rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; letter-spacing: -.01em; }
  .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; opacity: .55; }
  dl { margin: 1.5rem 0 0; display: grid; grid-template-columns: 4.5rem 1fr; gap: .375rem .75rem; }
  dt { opacity: .5; }
  dd { margin: 0; overflow-wrap: anywhere; }
  footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #ffffff1a; opacity: .6; font-size: .8125rem; }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <div class="id">${id}</div>
  <dl>
    <dt>出口</dt><dd>${egress}</dd>
    <dt>登录态</dt><dd>只属于这个环境，和其它环境互不可见</dd>
  </dl>
  <footer>在地址栏输入地址，或者让 agent 用 <code>warren exec ${id}</code> 操作这个环境。</footer>
</main>
</body>
</html>
`;
}
