// 本地登录 fixture。插件开发用，不接任何真实平台。
//   node scripts/serve-fixture.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] ?? 8899);
const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'login');
const CAPABILITY = path.join(import.meta.dirname, '..', 'fixtures', 'capability');

/** 单调递增的请求计数：HAR 回放验收用它证明「这次没走真实网络」（n 不涨）。 */
let counter = 0;

/**
 * 把每个请求都包起来。
 *
 * 这个进程是**所有实机验收的地基**：它一崩，表现是「全线回归失败」，非常容易误判成产品问题
 * （AGENTS「已知问题」第 4 条同款假象）。所以任何 handler 抛错都只回 500，绝不冒泡成
 * unhandled rejection 把进程带走。
 */
const onRequest = (req, res) => {
  void handle(req, res).catch((error) => {
    console.error('[fixture] handler 抛错:', req.method, req.url, error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('fixture error');
  });
};
const server = createServer(onRequest);

async function handle(req, res) {
  // 能力验收页：/cap/<name>.html，另有 /cap/sample.txt（下载）与 /cap/echo（fetch）
  if (req.url?.startsWith('/cap/')) {
    const name = req.url.slice(5).split('?')[0];
    if (name === 'sample.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('warren download fixture\n');
      return;
    }
    if (name === 'echo') {
      // 跨源测试要能过 CORS：`*` 只对 credentials=omit 放行，正好用来验证跨站默认不带 cookie
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({ ok: true, cookie: req.headers.cookie ?? null, at: Date.now() }));
      return;
    }
    // 永不响应的端点：用来验证导航超时错误带 committed/url/readyState
    if (name === 'slow') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<!doctype html><title>slow</title><h1>loading…');
      return;
    }
    // 网络拦截验收用的 API（docs/NET-INTERCEPT-PLAN.md 的 V16–V25）
    if (name.startsWith('api/')) {
      const api = name.slice(4);
      if (api === 'user') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ source: 'real', method: req.method, name: '真实用户' }));
        return;
      }
      if (api === 'headers') {
        // 回显收到的请求头：用来验证「未命中规则的请求头原样」
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ headers: req.headers }));
        return;
      }
      if (api === 'cors') {
        // **故意不带 access-control-allow-origin**：只有规则补上这个头，跨源才拿得到 body
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': '*',
            'access-control-allow-methods': 'GET,POST,OPTIONS',
          });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ source: 'real', cors: false }));
        return;
      }
      if (api === 'cookie') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'warren_session=super-secret-value; Path=/',
        });
        res.end(JSON.stringify({ ok: true, gotAuthorization: req.headers.authorization ?? null }));
        return;
      }
      if (api === 'counter') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ n: ++counter }));
        return;
      }
      if (api === 'big') {
        // 5MB：验证全量接管后大响应不退化（R9）
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(chunk.length * 80),
        });
        for (let i = 0; i < 80; i++) res.write(chunk);
        res.end();
        return;
      }
      if (api === 'sse') {
        // 流式：验证首块不被缓冲（R9）
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let i = 0;
        const timer = setInterval(() => {
          res.write(`data: ${i++}\n\n`);
          if (i > 5) {
            clearInterval(timer);
            res.end();
          }
        }, 100);
        return;
      }
    }
    if (name === 'pixel.png') {
      // 1x1 透明 PNG：阻断验收用（V19）
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      return;
    }
    if (/^[\w.-]+\.html$/.test(name)) {
      // 先读文件再写头：反过来（先 writeHead(200) 再 readFile）在文件不存在时
      // catch 里会二次 writeHead → ERR_HTTP_HEADERS_SENT 直接打死整个 fixture 进程（实测踩过）
      try {
        const body = await readFile(path.join(CAPABILITY, name), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
      return;
    }
  }
  if (req.url === '/login.html' || req.url === '/') {
    const body = await readFile(path.join(FIXTURES, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/console.html') {
    const body = await readFile(path.join(FIXTURES, 'console.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/ping') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404);
  res.end('not found');
}

server.listen(port, '127.0.0.1', () => {
  console.log(`fixture 已启动 → http://127.0.0.1:${port}/login.html`);
});
