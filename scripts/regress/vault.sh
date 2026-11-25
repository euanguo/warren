#!/bin/bash
cd "$(cd "$(dirname "$0")/../.." && pwd)"
W="node bin/warren.mjs"
jq1() { node -e 'const fs=require("fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){console.log("BADJSON");return}console.log(eval(process.argv[1])(j))})' "$1"; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1 | $3"; else echo "FAIL $1 | 期望[$2] 实际[$3]"; fi; }

$W env remove regr > /dev/null 2>&1
$W env create regr --start-url=http://127.0.0.1:8899/login.html > /dev/null
$W env start regr > /dev/null
$W tab new regr --space=agent http://127.0.0.1:8899/login.html > /dev/null
sleep 1
# 自建一条可用凭据：vault 里那条 example/fixture 是旧密钥写的，本来就解不开（见 5.7）
echo '{"username":"verger@example.com","password":"fixture-secret"}' | $W vault add example --label regr-vault > /dev/null
REF=$($W vault list --json | jq1 '(j) => j.credentials.find(c=>c.label==="regr-vault").ref')
echo "用凭据 $REF"

echo "--- 5.2 域名名单外 ---"
OUT=$($W vault fill "$REF" --env=regr --domains=example.com --field=password 2>&1)
echo "  输出: $OUT"
if echo "$OUT" | grep -q PATH_DENIED; then echo "PASS 5.2 | 名单外被拒"; else echo "FAIL 5.2 | $(echo "$OUT" | head -1)"; fi

echo "--- 5.3 名单内（127.0.0.1）---"
OUT=$($W vault fill "$REF" --env=regr --domains=127.0.0.1 --field=password 2>&1)
echo "  输出: $OUT"
if echo "$OUT" | grep -q '"filled": true'; then echo "PASS 5.3 | 名单内放行"; else echo "FAIL 5.3 | $OUT"; fi

echo "--- 5.4 值真的进了页面字段（不重新导航）---"
OUT=$($W exec regr 2>&1 <<'JS' | tail -1
return String(await page.evaluate("document.getElementById('password').value.length"));
JS
)
echo "  页面 password 字段长度: $OUT"
if [ "$OUT" != "0" ] && [ -n "$OUT" ]; then echo "PASS 5.4 | 字段被填了（长度 $OUT）"; else echo "FAIL 5.4 | 长度 $OUT"; fi

echo "--- 5.5 提交表单确实用填进去的值登录（端到端）---"
$W vault fill "$REF" --env=regr --domains=127.0.0.1 --field=username --target='{"kind":"selector","selector":"#email"}' > /dev/null
OUT=$($W exec regr 2>&1 <<'JS' | tail -1
await page.click('text=登录');
await page.waitForTimeout(300);
const t = await page.evaluate("document.title");
return t;
JS
)
echo "  提交后标题: $OUT"
if [ "$OUT" = "已登录" ]; then echo "PASS 5.5 | 凭据可用于真实登录流程"; else echo "FAIL 5.5 | 标题 $OUT（说明填进去的不是这套凭据）"; fi

echo "--- 5.7 解不开的旧凭据被标成不可用 + 报错给出下一步 ---"
OLD=$($W vault list --json | jq1 '(j) => (j.credentials.find(c=>c.available===false)||{}).ref')
if [ -n "$OLD" ] && [ "$OLD" != "undefined" ]; then
  OUT=$($W vault fill "$OLD" --env=regr --domains=127.0.0.1 --field=password 2>&1 | tail -1)
  if echo "$OUT" | grep -q "vault remove"; then echo "PASS 5.7 | 旧凭据标了不可用，报错带下一步"; else echo "FAIL 5.7 | $OUT"; fi
else echo "SKIP 5.7 | 这个 vault 里没有解不开的凭据"; fi

echo "--- 5.6 事件流里没有明文密码 ---"
$W events regr > /tmp/regr-events.txt
if grep -qE 'fixture-secret|"password"' /tmp/regr-events.txt; then echo "FAIL 5.6 | 事件里出现明文"; else echo "PASS 5.6 | 事件流无明文"; fi

$W vault remove "$REF" > /dev/null 2>&1
$W env stop regr > /dev/null 2>&1
$W env remove regr > /dev/null 2>&1
