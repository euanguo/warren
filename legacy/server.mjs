// 多 worktree 浏览器 profile 管理器 —— 一个进程管 N 个独立 Chrome，每个走自己的代理。
// 启动: node server.mjs     打开: http://127.0.0.1:8787
import { spawn, execFile } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { CDP } from "./lib/cdp.mjs";

const execFileP = promisify(execFile);
const ROOT = path.join(os.homedir(), ".worktree-profiles");
const CONFIG = path.join(ROOT, "config.json");
const PROFILE_DIR = path.join(ROOT, "profiles");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Helium.app/Contents/MacOS/Helium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((res) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function loadConfig() {
  await mkdir(PROFILE_DIR, { recursive: true });
  let cfg = { chrome: "", repo: "", port: 8787, profiles: {} };
  if (existsSync(CONFIG)) cfg = { ...cfg, ...JSON.parse(await readFile(CONFIG, "utf8")) };
  if (!cfg.chrome) cfg.chrome = CHROME_CANDIDATES.find(existsSync) ?? "";
  await saveConfig(cfg);
  return cfg;
}

const saveConfig = (cfg) => writeFile(CONFIG, JSON.stringify(cfg, null, 2) + "\n");

/** 把 git worktree 自动变成一个 profile —— 这是现成工具都没有的那一块 */
async function discoverWorktrees(repo) {
  if (!repo) return [];
  try {
    const { stdout } = await execFileP("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    return stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice(9).trim())
      .map((p) => ({ name: path.basename(p), path: p }));
  } catch {
    return [];
  }
}

async function waitForDevTools(port, proc, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`内核已退出 code=${proc.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error("DevTools 端点超时");
}

// ── 运行中的 profile 表 ────────────────────────────────────────────────
const running = new Map(); // name -> { proc, port, wsUrl, cdp, startedAt, worktree }

async function up(name, cfg) {
  if (running.has(name)) return { ok: false, error: "已在运行" };
  const entry = cfg.profiles[name] ?? {};
  const userDataDir = path.join(PROFILE_DIR, name);
  await mkdir(userDataDir, { recursive: true });
  const port = await freePort();

  const args = [
    `--user-data-dir=${userDataDir}`,      // L5 磁盘隔离；Chrome 136+ 对调试端口是硬要求
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    ...(entry.proxy ? [`--proxy-server=${entry.proxy}`] : []),
    entry.url || "about:blank",
  ];

  const proc = spawn(cfg.chrome, args, { stdio: "ignore" });
  proc.on("exit", () => running.delete(name));

  const wsUrl = await waitForDevTools(port, proc, 20000);
  const cdp = await CDP.connect(wsUrl);
  running.set(name, { proc, port, wsUrl, cdp, startedAt: Date.now(), worktree: entry.worktree ?? "" });
  return { ok: true, port };
}

function down(name) {
  const r = running.get(name);
  if (!r) return { ok: false, error: "未运行" };
  r.cdp.close();
  r.proc.kill("SIGTERM");
  running.delete(name);
  return { ok: true };
}

async function snapshot(name) {
  const r = running.get(name);
  if (!r) return { running: false };
  try {
    const st = await r.cdp.status();
    return { running: true, port: r.port, pid: r.proc.pid, startedAt: r.startedAt, ...st };
  } catch (e) {
    return { running: true, port: r.port, pid: r.proc.pid, startedAt: r.startedAt, url: "", title: "", error: String(e.message) };
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────
const cfg = await loadConfig();

if (cfg.repo) {
  for (const wt of await discoverWorktrees(cfg.repo)) {
    if (!cfg.profiles[wt.name]) cfg.profiles[wt.name] = { proxy: "", url: "", worktree: wt.path };
    else cfg.profiles[wt.name].worktree = wt.path;
  }
  await saveConfig(cfg);
}

const server = createHttpServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (o, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };

  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }

    if (url.pathname === "/api/state") {
      const list = await Promise.all(
        Object.entries(cfg.profiles).map(async ([name, e]) => ({
          name,
          proxy: e.proxy ?? "",
          worktree: e.worktree ?? "",
          ...(await snapshot(name)),
        })),
      );
      return json({ chrome: cfg.chrome, repo: cfg.repo, profiles: list });
    }

    if (url.pathname === "/api/up" || url.pathname === "/api/down") {
      const name = url.searchParams.get("name");
      if (!cfg.profiles[name]) return json({ ok: false, error: "未知 profile" }, 404);
      return json(url.pathname === "/api/up" ? await up(name, cfg) : down(name));
    }

    if (url.pathname.startsWith("/shot/")) {
      const name = decodeURIComponent(url.pathname.slice(6));
      const r = running.get(name);
      if (!r) { res.writeHead(404); return res.end(); }
      const png = await r.cdp.thumbnail();
      if (!png) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
      return res.end(png);
    }

    res.writeHead(404);
    res.end();
  } catch (e) {
    json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>worktree profiles</title><style>
:root{color-scheme:dark}
body{margin:0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"SF Mono",monospace;background:#0b0d10;color:#c9d1d9}
header{padding:14px 18px;border-bottom:1px solid #1c2128;display:flex;gap:16px;align-items:baseline}
h1{font-size:14px;margin:0;font-weight:600}
header small{color:#6e7681}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;padding:18px}
.card{background:#11151a;border:1px solid #1c2128;border-radius:8px;overflow:hidden;display:flex;flex-direction:column}
.card.on{border-color:#2ea04355}
.thumb{aspect-ratio:16/10;background:#05070a;display:block;width:100%;object-fit:cover;object-position:top}
.meta{padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.row{display:flex;justify-content:space-between;gap:10px}
.name{font-weight:600;color:#e6edf3}
.dot{width:7px;height:7px;border-radius:50%;background:#484f58;display:inline-block;margin-right:7px}
.dot.on{background:#2ea043;box-shadow:0 0 6px #2ea04399}
.u{color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.t{color:#58a6ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;border-radius:5px;padding:3px 10px;cursor:pointer;font-size:12px}
button:hover{background:#30363d}
.px{font-size:11px;color:#6e7681;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<header><h1>worktree profiles</h1><small id="sum">…</small></header>
<div class="grid" id="g"></div>
<script>
const g=document.getElementById('g'),sum=document.getElementById('sum');
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function tick(){
  let s; try{ s=await (await fetch('/api/state')).json(); }catch{ sum.textContent='管理器没响应'; return; }
  const n=s.profiles.filter(p=>p.running).length;
  sum.textContent=n+' / '+s.profiles.length+' 运行中 · '+s.chrome.split('/').pop();
  g.innerHTML=s.profiles.map(p=>\`
   <div class="card \${p.running?'on':''}">
     \${p.running?\`<img class="thumb" src="/shot/\${encodeURIComponent(p.name)}?t=\${Date.now()}">\`:'<div class="thumb"></div>'}
     <div class="meta">
       <div class="row"><span class="name"><span class="dot \${p.running?'on':''}"></span>\${esc(p.name)}</span>
         <button onclick="act('\${p.running?'down':'up'}','\${esc(p.name)}')">\${p.running?'停止':'启动'}</button></div>
       <div class="t">\${esc(p.title)||'—'}</div>
       <div class="u">\${esc(p.url)||'—'}</div>
       <div class="px">\${p.proxy?'代理 '+esc(p.proxy):'直连'} \${p.port?'· :'+p.port:''}</div>
     </div>
   </div>\`).join('');
}
async function act(a,n){ await fetch('/api/'+a+'?name='+encodeURIComponent(n),{method:'POST'}); tick(); }
tick(); setInterval(tick,3000);
</script></body></html>`;

server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`管理器已启动 → http://127.0.0.1:${cfg.port}`);
  console.log(`内核: ${cfg.chrome || "(未找到，请在 " + CONFIG + " 里填 chrome 路径)"}`);
  console.log(`profile 数: ${Object.keys(cfg.profiles).length}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const name of [...running.keys()]) down(name);
    process.exit(0);
  });
}
