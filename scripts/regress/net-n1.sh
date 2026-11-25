#!/bin/bash
cd "$(cd "$(dirname "$0")/../.." && pwd)"
W="node bin/warren.mjs"
$W env select cap > /dev/null 2>&1
first_rule() { $W net rules cap --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.rules[0]?j.rules[0].id:'')})"; }
run() { local name="$1"; shift; local out; out=$($W exec cap 2>&1); local code=$?; if [ $code -eq 0 ]; then echo "PASS $name | $(echo "$out" | tail -2 | tr '\n' ' ')"; else echo "FAIL $name | $(echo "$out" | tail -3 | tr '\n' ' ')"; fi; }
ok() { if [ "$2" = "$3" ]; then echo "PASS $1 | $3"; else echo "FAIL $1 | 期望[$2] 实际[$3]"; fi; }

echo "== 0. 规则表初始 =="
$W net rules cap

echo "== V16-RED 前基线：没有规则时走真实网络 =="
run "V16-baseline-real" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const r = await page.evaluate("fetch('/cap/api/user').then(r => r.json())");
return 'real ' + JSON.stringify(r);
JS

echo "== 加 mock 规则 =="
$W net rule add cap --match='*/cap/api/user' --mock='{"source":"mock","name":"MOCK"}'
RID=$(first_rule); echo "ruleId=$RID"

echo "== V16 mock 命中 =="
run "V16" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const r = await page.evaluate("fetch('/cap/api/user').then(r => r.json())");
if (r.source !== 'mock') throw new Error('V16 失败: ' + JSON.stringify(r));
return 'V16 ok ' + JSON.stringify(r);
JS

echo "== V16-反例：关闭规则后必须走真实网络 =="
$W net rule disable cap "$RID" > /dev/null
run "V16-反例" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const r = await page.evaluate("fetch('/cap/api/user').then(r => r.json())");
if (r.source !== 'real') throw new Error('V16-反例 失败（规则关了还在拦）: ' + JSON.stringify(r));
return 'V16-反例 ok 走真实网络 ' + JSON.stringify(r);
JS

echo "== V26 临时放行：压过 mock，重复调用只留一条，到点自己消失 =="
$W net passthrough cap '*/cap/api/user' --for=60s > /dev/null
run "V26-1 放行走真实网络" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const r = await page.evaluate("fetch('/cap/api/user').then(r => r.json())");
if (r.source !== 'real') throw new Error('放行没生效: ' + JSON.stringify(r));
return 'V26-1 ok 真数据';
JS
$W net passthrough cap '*/cap/api/user' --for=60s > /dev/null
COUNT=$($W net rules cap --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.rules.filter(r=>r.action.type==='passthrough').length)})")
ok "V26-2 同模式只留一条" "1" "$COUNT"
$W net passthrough cap '*/cap/api/user' --for=2s > /dev/null
sleep 3
GONE=$($W net rules cap --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.rules.filter(r=>r.action.type==='passthrough').length)})")
ok "V26-3 过期自动摘掉" "0" "$GONE"

echo "== 删除 mock 规则，加 --method=GET 规则 =="
$W net rule remove cap "$RID" > /dev/null
$W net rule add cap --match='*/cap/api/user' --method=GET --mock='{"source":"mock-get"}'
RID2=$(first_rule); echo "ruleId=$RID2"

echo "== V17 method 过滤：GET 命中 / POST 不命中 =="
run "V17" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const get = await page.evaluate("fetch('/cap/api/user').then(r => r.json())");
const post = await page.evaluate("fetch('/cap/api/user', { method: 'POST' }).then(r => r.json())");
if (get.source !== 'mock-get') throw new Error('V17 失败（GET 没命中）: ' + JSON.stringify(get));
if (post.source !== 'real') throw new Error('V17 失败（POST 被拦了）: ' + JSON.stringify(post));
return 'V17 ok GET=' + JSON.stringify(get) + ' POST=' + JSON.stringify(post);
JS

echo "== 命中记录 =="
$W net hits cap --limit=5

echo "== 清理 =="
$W net rule remove cap "$RID2" > /dev/null
$W net rules cap
