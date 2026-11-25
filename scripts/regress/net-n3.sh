#!/bin/bash
cd "$(cd "$(dirname "$0")/../.." && pwd)"
W="node bin/warren.mjs"
HAR=/tmp/warren-cap.har
$W env select cap > /dev/null 2>&1
ids() { $W net rules cap --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).rules.map(r=>r.id).join(' ')))"; }
clear_rules() { for i in $(ids); do $W net rule remove cap "$i" > /dev/null; done; }
# 跑一段脚本，取最后一行输出（脚本里 return 的值）
val() { $W exec cap 2>&1 | tail -1; }
ok() { if [ "$2" = "1" ]; then echo "PASS $1"; else echo "FAIL $1"; fi; }

clear_rules
$W net replay stop cap > /dev/null 2>&1
node -e "require('fs').rmSync('$HAR',{force:true})"

echo "== 1. 录 HAR =="
$W net record start cap > /dev/null
OUT=$(val <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const a = await page.evaluate("fetch('/cap/api/counter').then(r => r.json())");
const b = await page.evaluate("fetch('/cap/api/counter').then(r => r.json())");
return a.n + ' ' + b.n;
JS
)
A=$(echo "$OUT" | cut -d' ' -f1); B=$(echo "$OUT" | cut -d' ' -f2)
echo "  录制期间 counter: $A → $B"
$W net record stop cap --output="$HAR" | tail -3
node -e "const h=JSON.parse(require('fs').readFileSync('$HAR','utf8'));console.log('  HAR entries='+h.log.entries.length+' 带响应体='+h.log.entries.filter(e=>e.response.content.text!==undefined).length);console.log('  urls='+JSON.stringify(h.log.entries.map(e=>e.request.url.replace('http://localhost:8899',''))))"

echo "== V22 回放：同一请求不再走真实网络（counter 不涨）=="
$W net replay start cap "$HAR" > /dev/null
R=$(val <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const a = await page.evaluate("fetch('/cap/api/counter').then(r => r.json())");
const b = await page.evaluate("fetch('/cap/api/counter').then(r => r.json())");
return a.n + ' ' + b.n;
JS
)
echo "  回放两次拿到: $R; 录制时是 $A $B"
# 同一 (method,url) 只回放第一条录到的响应（har.ts 的 shortcut 注释）
[ "$R" = "$A $A" ] && echo "PASS V22 | 回放内容来自 HAR，未走真实网络" || echo "FAIL V22 | 回放 $R，期望 $A $A"

echo "== V22-反例：停止回放后必须恢复直连（counter 继续涨）=="
$W net replay stop cap > /dev/null
C=$(val <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
return String((await page.evaluate("fetch('/cap/api/counter').then(r => r.json())")).n);
JS
)
echo "  停止回放后 counter=$C, 期望=$((B + 1))"
[ "$C" = "$((B + 1))" ] && echo "PASS V22-反例 | 恢复直连，counter 继续涨" || echo "FAIL V22-反例 | 得到 $C，期望 $((B + 1))"

echo "== V22b offline：没录到的请求也不放行 =="
$W net replay start cap "$HAR" --offline > /dev/null
O=$(val <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const mocked = await page.evaluate("fetch('/cap/api/counter').then(r => 'mock:' + r.status).catch(e => 'ERR:' + e.message)");
const unmocked = await page.evaluate("fetch('/cap/api/user').then(r => 'passed:' + r.status).catch(e => 'blocked:' + e.message)");
return mocked + ' / ' + unmocked;
JS
)
echo "  已录 / 未录: $O"
case "$O" in
  "mock:200 / passed:403") echo "PASS V22b | 已录走 mock、未录被拦" ;;
  *) echo "FAIL V22b | $O" ;;
esac

echo "== 清理 =="
$W net replay stop cap
clear_rules
$W net rules cap
