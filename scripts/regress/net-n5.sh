#!/bin/bash
cd "$(cd "$(dirname "$0")/../.." && pwd)"
W="node bin/warren.mjs"
$W env select cap > /dev/null 2>&1
ids() { $W net rules cap --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).rules.map(r=>r.id).join(' ')))"; }
clear_rules() { for i in $(ids); do $W net rule remove cap "$i" > /dev/null 2>&1; done; }

clear_rules

echo "== V24 人持 lease 时 agent 改规则必须 ENV_BUSY =="
$W env takeover cap
echo "  env list 里的 owner：" ; $W env list | grep cap
OUT=$($W net rule add cap --match='*/cap/api/user' --block 2>&1 | tail -1)
echo "  net rule add → $OUT"
case "$OUT" in *ENV_BUSY*) echo "PASS V24 | 人持权时 agent 改规则被拒" ;; *) echo "FAIL V24 | $OUT" ;; esac
OUT=$($W net record start cap 2>&1 | tail -1)
echo "  net record start → $OUT"
case "$OUT" in *ENV_BUSY*) echo "PASS V24b | 人持权时 agent 录 HAR 也被拒" ;; *) echo "FAIL V24b | $OUT" ;; esac
# 反向：没人持 lease 时裸调 RPC（不带 leaseId）必须 ENV_NOT_LEASED
$W env release cap --lease="$($W env list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).find(x=>x.id==='cap');console.log(e.leaseId)})")" > /dev/null
OUT=$($W call net.rule.add '{"id":"cap","rule":{"match":{"url":"*/cap/api/user"},"action":{"type":"block"}}}' 2>&1 | tail -1)
echo "  裸 RPC net.rule.add（无 lease）→ $OUT"
case "$OUT" in *ENV_NOT_LEASED*) echo "PASS V24c | 不带 lease 的裸 RPC 被拒" ;; *) echo "FAIL V24c | $OUT" ;; esac

echo "== V25 命中记录里的 authorization / set-cookie 必须是 [REDACTED] =="
$W net rule add cap --match='*/cap/api/cookie' --response-header='x-warren=1'
$W exec cap <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
return await page.evaluate("fetch('/cap/api/cookie', { headers: { authorization: 'Bearer super-secret-token' } }).then(r => r.json()).then(j => '服务器收到 authorization=' + j.gotAuthorization)");
JS
$W net hits cap --json > /tmp/n5-hits.json
node -e '
const fs = require("fs");
const hits = JSON.parse(fs.readFileSync("/tmp/n5-hits.json", "utf8"));
const raw = fs.readFileSync("/tmp/n5-hits.json", "utf8");
const hit = hits.find((h) => h.url.includes("/cap/api/cookie"));
if (!hit) { console.log("FAIL V25 | 没有命中记录"); process.exit(0); }
const auth = hit.requestHeaders?.authorization;
const cookie = hit.responseHeaders?.["set-cookie"];
console.log("  命中记录: status=" + hit.status + " action=" + hit.action);
console.log("  requestHeaders.authorization = " + JSON.stringify(auth));
console.log("  responseHeaders[set-cookie]  = " + JSON.stringify(cookie));
console.log("  原始秘密是否出现在输出里: token=" + raw.includes("super-secret-token") + " value=" + raw.includes("super-secret-value"));
const ok = auth === "[REDACTED]" && cookie === "[REDACTED]" && !raw.includes("super-secret-token") && !raw.includes("super-secret-value");
console.log((ok ? "PASS" : "FAIL") + " V25 | authorization/set-cookie 已脱敏，且原始秘密不在输出里");
'

echo "== 清理 =="
clear_rules
$W net rules cap
