#!/bin/bash
cd "$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=scripts/regress/lib.sh
source "scripts/regress/lib.sh"

REGR_TMP=$(mktemp -d "${TMPDIR:-/tmp}/warren-plugin-regr.XXXXXX")
trap 'rm -rf "$REGR_TMP"' EXIT

echo "===== 12. 插件：命令 / 存储 / 日志 / 设置 ====="
N1=$($W plugin run com.example.notes list --env cap 2>&1 | jq1 '(j) => j.result.items.length')
$W plugin run com.example.notes addNote --env cap > /dev/null
N2=$($W plugin run com.example.notes list --env cap 2>&1 | jq1 '(j) => j.result.items.length')
ok "12.1 插件命令写库（count $N1 → $N2）" "$((N1 + 1))" "$N2"
$W plugin rpc com.example.notes stats '{}' > "$REGR_TMP/rpc.json" 2>&1
# stats 现在回 total（全部条目）+ todos + facts；以前那个 count 就是 total
ok "12.2 plugin rpc 返回 total" "$((N2))" "$(jq1 '(j) => (j.result||j).total' < "$REGR_TMP/rpc.json")"
$W plugin logs com.example.notes --n=3 > "$REGR_TMP/logs.txt" 2>&1
ok "12.3 插件日志可读" "1" "$(grep -c . "$REGR_TMP/logs.txt" | awk '{print ($1>0)?1:0}')"
$W plugin config com.example.notes set title 回归标题 > /dev/null
ok "12.4 设置可写并回读" "回归标题" "$($W plugin list --json | jq1 '(j) => j.find(p=>p.id==="com.example.notes").settings.find(s=>s.key==="title").value')"
$W plugin reload com.example.notes > /dev/null
ok "12.5 reload 后 running" "running" "$($W plugin list --json | jq1 '(j) => j.find(p=>p.id==="com.example.notes").status')"

echo "===== 13. host 运行时 ====="
OUT=$($W plugin run com.example.hosty probe --env cap 2>&1 | jq1 '(j) => j.result.node + " / pid " + j.result.pid + " / git " + j.result.gitHead')
echo "  probe → $OUT"
ok "13.1 host 插件跑在独立进程里" "1" "$(echo "$OUT" | grep -c '^24\.')"

echo "===== 14. 插件只读命令不抢控制权 ====="
$W env takeover cap > /dev/null
$W plugin run com.example.notes list --env cap > /dev/null 2>&1
ok "14.1 人持权时插件只读命令仍可用" "human" "$($W env list --json | jq1 '(j) => j.find(e=>e.id==="cap").owner')"
$W env release cap --lease="$($W env list --json | jq1 '(j) => j.find(e=>e.id==="cap").leaseId')" > /dev/null
ok "14.2 释放后 owner=none" "none" "$($W env list --json | jq1 '(j) => j.find(e=>e.id==="cap").owner')"

echo "===== 15. 插件启停 ====="
$W plugin disable com.example.notes > /dev/null
ok "15.1 disable 后 disabled" "disabled" "$($W plugin list --json | jq1 '(j) => j.find(p=>p.id==="com.example.notes").status')"
$W plugin enable com.example.notes > /dev/null
ok "15.2 enable 后 running" "running" "$($W plugin list --json | jq1 '(j) => j.find(p=>p.id==="com.example.notes").status')"

echo "===== 16. Cookie 受控通道（只搬运不返回，见 PLUGIN-CAPABILITY-DESIGN §9）====="
$W plugin install path:plugins/example-cookies > /dev/null 2>&1
$W plugin enable com.example.cookies > /dev/null 2>&1
$W plugin grant com.example.cookies storage.cookie.port > /dev/null 2>&1
$W env remove ckcopy > /dev/null 2>&1
$W env create ckcopy --start-url=http://127.0.0.1:8899/cap/net.html > /dev/null
$W env start ckcopy > /dev/null
# 在 cap 里种一个 cookie：fixture 的 /cap/api/cookie 会 set-cookie
$W exec cap > /dev/null 2>&1 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
await page.evaluate("fetch('/cap/api/cookie').then(r => r.status)");
await page.waitForTimeout(300);
return 'ok';
JS
NAMES=$($W plugin run com.example.cookies report --env cap 2>&1)
ok "16.1 names 回元数据（有这个名字）" "1" "$(echo "$NAMES" | grep -c 'warren_session')"
ok "16.2 names 里没有值" "0" "$(echo "$NAMES" | grep -c 'super-secret-value')"
COPY=$($W plugin run com.example.cookies copyFrom --env ckcopy --input='{"from":"cap"}' 2>&1)
ok "16.3 copy 只回计数与名字" "0" "$(echo "$COPY" | grep -c 'super-secret-value')"
ok "16.4 目标环境确实拿到了（看元数据）" "1" "$($W plugin run com.example.cookies report --env ckcopy 2>&1 | grep -c 'warren_session')"
$W plugin run com.example.cookies clear --env ckcopy > /dev/null 2>&1
ok "16.5 clear 之后元数据为空" "0" "$($W plugin run com.example.cookies report --env ckcopy 2>&1 | grep -c 'warren_session')"
$W plugin run com.example.cookies clear --env cap > /dev/null 2>&1
$W env stop ckcopy > /dev/null 2>&1
$W env remove ckcopy > /dev/null 2>&1

echo "===== 17. 账号管理插件（明文存储）====="
INITIAL_ACCOUNTS=$($W plugin run com.warren.accounts list --json 2>&1 | jq1 '(j) => j.result.accounts.length')
CREATED=$($W plugin run com.warren.accounts create \
  --input='{"name":"回归账号","username":"tester","password":"[REDACTED]","note":"回归备注","tags":"regress"}' 2>&1)
ok "17.1 新增后列表 +1" "$((INITIAL_ACCOUNTS + 1))" "$(echo "$CREATED" | jq1 '(j) => j.result.accounts.length')"
ok "17.2 备注明文回读" "回归备注" "$(echo "$CREATED" | jq1 '(j) => j.result.accounts[0].note')"
# 2026-11-05 起 list 不回明文：只给 hasPassword，password 字段不存在（agent 通道永不返回明文）
ok "17.3 不回密码、只给 hasPassword" "true / true" \
  "$(echo "$CREATED" | jq1 '(j) => j.result.accounts[0].hasPassword + " / " + (j.result.accounts[0].password === undefined)')"
ACCOUNT_ID=$(echo "$CREATED" | jq1 '(j) => j.result.accounts[0].id')
UPDATED=$($W plugin run com.warren.accounts update \
  --input="{\"id\":$ACCOUNT_ID,\"note\":\"备注已更新\"}" 2>&1)
ok "17.4 备注可更新" "备注已更新" "$(echo "$UPDATED" | jq1 '(j) => j.result.accounts[0].note')"
$W plugin run com.warren.accounts remove --input="{\"id\":$ACCOUNT_ID}" > /dev/null
ok "17.5 删除后恢复原数量" "$INITIAL_ACCOUNTS" "$($W plugin run com.warren.accounts list --json 2>&1 | jq1 '(j) => j.result.accounts.length')"
