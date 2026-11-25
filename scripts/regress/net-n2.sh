#!/bin/bash
cd "$(cd "$(dirname "$0")/../.." && pwd)"
W="node bin/warren.mjs"
$W env select cap > /dev/null 2>&1
ids() { $W net rules cap --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).rules.map(r=>r.id).join(' '))})"; }
clear_rules() { for i in $(ids); do $W net rule remove cap "$i" > /dev/null; done; }
run() { local name="$1"; local out; out=$($W exec cap 2>&1); local code=$?; if [ $code -eq 0 ]; then echo "PASS $name | $(echo "$out" | tail -2 | tr '\n' ' ')"; else echo "FAIL $name | $(echo "$out" | tail -3 | tr '\n' ' ')"; fi; }

clear_rules
echo "== V18 RED：一条规则都没有（handler 不挂）→ 跨源请求被 CORS 拦 =="
run "V18-RED" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
return await page.evaluate("fetch('http://127.0.0.1:8899/cap/api/cors').then(r => 'OK:' + r.status).catch(e => 'CORS_ERR:' + e.message)");
JS

echo "== 加 response-header 规则 =="
$W net rule add cap --match='*/cap/api/cors' --response-header='access-control-allow-origin=*'
run "V18" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const r = await page.evaluate("fetch('http://127.0.0.1:8899/cap/api/cors').then(async r => 'OK:' + r.status + ' acao=' + r.headers.get('access-control-allow-origin') + ' body=' + (await r.text()).slice(0,20)).catch(e => 'CORS_ERR:' + e.message)");
if (!String(r).includes("acao=*")) throw new Error('V18 失败: ' + r);
return 'V18 ok ' + r;
JS

echo "== V18-反例：未命中规则的请求头 / 响应头必须原样 =="
$W net rule add cap --match='*tag=hit*' --request-header='x-warren=1' --request-header='x-other=2'
run "V18-反例" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const hit = await page.evaluate("fetch('/cap/api/headers?tag=hit', { headers: { 'x-probe': 'keep-me' } }).then(r => r.json())");
const miss = await page.evaluate("fetch('/cap/api/headers?tag=miss', { headers: { 'x-probe': 'keep-me' } }).then(r => r.json())");
if (hit.headers['x-warren'] !== '1' || hit.headers['x-other'] !== '2') throw new Error('V18-反例 失败（命中却没改头）: ' + JSON.stringify(hit.headers));
if (miss.headers['x-warren'] !== undefined) throw new Error('V18-反例 失败（没命中也被改头）: ' + JSON.stringify(miss.headers));
if (miss.headers['x-probe'] !== 'keep-me') throw new Error('V18-反例 失败（原头丢了）: ' + JSON.stringify(miss.headers));
return 'V18-反例 ok 命中=' + JSON.stringify({ w: hit.headers['x-warren'], p: hit.headers['x-probe'] }) + ' 未命中=' + JSON.stringify({ w: miss.headers['x-warren'] ?? null, p: miss.headers['x-probe'] });
JS

echo "== V19 block：图片失败但页面仍可用 =="
$W net rule add cap --match='*/cap/pixel.png' --block
run "V19" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
await page.waitForTimeout(400);
const img = await page.evaluate("(() => { const el = document.getElementById('pic'); return { complete: el.complete, w: el.naturalWidth }; })()");
await page.click('#btn');
const t = await page.evaluate("document.getElementById('result').textContent");
if (img.w !== 0) throw new Error('V19 失败（图片居然加载成功）: ' + JSON.stringify(img));
if (t !== 'alive clicked') throw new Error('V19 失败（页面不可用）: ' + t);
return 'V19 ok 图片失败 ' + JSON.stringify(img) + ' 页面仍可用: ' + t;
JS

echo "== V20 delay：耗时 ≥ 800ms =="
$W net rule add cap --match='*/cap/api/user' --delay=800
run "V20" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const ms = await page.evaluate("(async () => { const t = performance.now(); await fetch('/cap/api/user').then(r => r.json()); return Math.round(performance.now() - t); })()");
if (Number(ms) < 800) throw new Error('V20 失败（没延迟）: ' + ms);
return 'V20 ok 耗时 ' + ms + 'ms';
JS

echo "== V21 流式 / 大响应不退化（在 response-header 规则下，响应被重新包了一层）=="
$W net rule add cap --match='*/cap/api/*' --response-header='x-warren=1'
run "V21" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const big = await page.evaluate(`(async () => { const r = await fetch('/cap/api/big'); const b = await r.arrayBuffer(); return { bytes: b.byteLength, header: r.headers.get('x-warren'), ct: r.headers.get('content-type') }; })()`);
if (big.bytes !== 5242880) throw new Error('V21 失败（大响应不完整）: ' + JSON.stringify(big));
const sse = await page.evaluate(`(async () => { const t0 = performance.now(); const r = await fetch('/cap/api/sse'); const rd = r.body.getReader(); const first = await rd.read(); const ms = Math.round(performance.now() - t0); let text = new TextDecoder().decode(first.value); for (;;) { const { done, value } = await rd.read(); if (done) break; text += new TextDecoder().decode(value); } return { ms, chunks: text.trim().split('\\n\\n').length, header: r.headers.get('x-warren') }; })()`);
if (sse.chunks < 6) throw new Error('V21 失败（流不完整）: ' + JSON.stringify(sse));
return 'V21 ok 大响应 ' + JSON.stringify(big) + ' 流式 ' + JSON.stringify(sse);
JS

echo "== 清理 =="
clear_rules
$W net rules cap
