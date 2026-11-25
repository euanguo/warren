// 临时静态服务：把截图目录挂出去，方便在远程 bb 里直接看。
//   node scripts/serve-shots.mjs [port]
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] ?? 8898);
const DIR = path.join(import.meta.dirname, '..', 'shots');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = path.basename(url.pathname);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.png')).sort();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>Warren 截图</title><style>
body{margin:0;background:#0b0d10;color:#c9d1d9;font:13px -apple-system,sans-serif;padding:20px}
img{max-width:100%;display:block;margin:16px 0;border:1px solid #30363d;border-radius:8px}
h1{font-size:15px;font-weight:600}
a{color:#58a6ff}
</style></head><body><h1>Warren · 桌面端截图</h1>
${files.map((f) => `<img src="/${f}" alt="${f}">`).join('\n')}
</body></html>`);
    return;
  }

  const file = path.join(DIR, name);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`shots → http://127.0.0.1:${port}/`);
});
