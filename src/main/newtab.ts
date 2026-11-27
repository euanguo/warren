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
  const egress = environment?.proxy ? escapeHtml(environment.proxy) : '直连（未配置代理）';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>新标签页 · ${name}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #14171c;
    --surface: #1b1f27;
    --fg: #eef1f6;
    --muted: #9aa3b2;
    --border: rgba(255, 255, 255, 0.08);
    --code-bg: rgba(255, 255, 255, 0.06);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fb;
      --surface: #ffffff;
      --fg: #181c23;
      --muted: #5d6778;
      --border: rgba(15, 23, 42, 0.1);
      --code-bg: rgba(15, 23, 42, 0.05);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-content: center;
    padding: 2rem; background: var(--bg); color: var(--fg);
    font: 14px/1.6 -apple-system, "Helvetica Neue", "PingFang SC", sans-serif;
  }
  main {
    width: min(30rem, 100%); padding: 1.75rem 2rem; border-radius: 14px;
    background: var(--surface); border: 1px solid var(--border);
  }
  h1 { margin: 0 0 .25rem; font-size: 1.375rem; font-weight: 600; letter-spacing: -.015em; }
  .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; color: var(--muted); }
  dl { margin: 1.25rem 0 0; display: grid; grid-template-columns: 4.5rem 1fr; gap: .5rem .75rem; font-size: .875rem; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .tips {
    margin: 1.5rem 0 0; padding: 1rem 0 0; list-style: none;
    border-top: 1px solid var(--border); display: grid; gap: .5rem;
    color: var(--muted); font-size: .8125rem;
  }
  code, kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .75rem;
    padding: .125rem .375rem; border-radius: 5px; background: var(--code-bg); color: var(--fg);
  }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <div class="id">${id}</div>
  <dl>
    <dt>出口</dt><dd>${egress}</dd>
    <dt>隔离</dt><dd>独立 Cookie、缓存与扩展目录，不与其它环境共享</dd>
  </dl>
  <ul class="tips">
    <li><kbd>⌘L</kbd> 聚焦地址栏导航 · <kbd>⌘K</kbd> 打开快捷命令栏</li>
    <li>CLI 自动化：<code>warren browser open ${id} https://...</code> 或 <code>warren exec ${id}</code></li>
  </ul>
</main>
</body>
</html>
`;
}
