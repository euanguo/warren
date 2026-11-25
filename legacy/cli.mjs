#!/usr/bin/env node
// 薄客户端。真正的状态在 server.mjs 里。
//   node cli.mjs ls | up <name> | down <name> | open
const [, , cmd, name] = process.argv;
const PORT = process.env.WP_PORT ?? 8787;
const base = `http://127.0.0.1:${PORT}`;

async function call(path) {
  const r = await fetch(base + path, { method: "POST" });
  return r.json();
}

try {
  if (cmd === "ls" || !cmd) {
    const s = await (await fetch(base + "/api/state")).json();
    for (const p of s.profiles) {
      const flag = p.running ? "●" : "○";
      const where = p.proxy ? `代理 ${p.proxy}` : "直连";
      console.log(`${flag} ${p.name.padEnd(24)} ${where.padEnd(34)} ${p.url || "—"}`);
    }
  } else if (cmd === "up" || cmd === "down") {
    console.log(JSON.stringify(await call(`/api/${cmd}?name=${encodeURIComponent(name)}`)));
  } else if (cmd === "open") {
    const { execFile } = await import("node:child_process");
    execFile("open", [base]);
  } else {
    console.log("用法: node cli.mjs [ls | up <name> | down <name> | open]");
  }
} catch (e) {
  console.error(`连不上管理器 (${base}) —— 先跑 node server.mjs`);
  process.exit(1);
}
