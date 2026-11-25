#!/bin/bash
cd "$(cd "$(dirname "$0")/../.." && pwd)"
W="node bin/warren.mjs"
evalr() { node -e '
const { execFileSync } = require("child_process");
const out = execFileSync("node", ["bin/warren.mjs","call","debug.rendererEval", JSON.stringify({ script: process.argv[1] })], { encoding: "utf8" });
const j = JSON.parse(out);
console.log(typeof j.value === "string" ? j.value : JSON.stringify(j.value));
' "$1"; }
ids() { $W net rules cap --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).rules.map(r=>r.id).join(' ')))"; }
clear_rules() { for i in $(ids); do $W net rule remove cap "$i" > /dev/null; done; }

clear_rules
$W env select cap > /dev/null
$W net rule add cap --match='*/cap/api/user' --mock='{"source":"mock"}'
RID=$(ids); echo "ruleId=$RID"
sleep 2

echo "== V23-1 面板能列出规则与命中数 =="
OUT=$(evalr "(async () => { const t=[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.trim().startsWith('规则')); if(!t) return 'NO TAB'; t.click(); await new Promise(r=>setTimeout(r,400)); return [...document.querySelectorAll('[data-slot=\"net-rule\"]')].map(e=>e.textContent.trim()); })()")
echo "  规则行: $OUT"
case "$OUT" in *"/cap/api/user"*"mock 200"*"命中"*) echo "PASS V23-1 | 面板列出了规则 / 动作 / 命中数" ;; *) echo "FAIL V23-1 | $OUT" ;; esac

echo "== V23-2 人在界面上关掉规则（点开关）=="
evalr "(() => { const sw=document.querySelector('[data-slot=\"net-rule\"] [data-slot=\"switch\"]'); if(!sw) return 'NO SWITCH'; const before=sw.getAttribute('aria-checked'); sw.click(); return 'switch ' + before + ' → 已点击'; })()"
sleep 1.5
EN=$($W net rules cap --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).rules[0];console.log(r?r.enabled:'none')})")
echo "  agent 侧读到 enabled=$EN"
[ "$EN" = "false" ] && echo "PASS V23-2 | 人关掉后 agent 侧立刻看到 disabled" || echo "FAIL V23-2 | enabled=$EN"

echo "== V23-3 关掉之后 agent 侧立即不生效（走真实网络）=="
OUT=$($W exec cap 2>&1 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const r = await page.evaluate("fetch('/cap/api/user').then(r => r.json())");
if (r.source !== 'real') throw new Error('V23-3 失败（规则关了还在拦）: ' + JSON.stringify(r));
return '走真实网络 ' + JSON.stringify(r);
JS
)
echo "  $(echo "$OUT" | tail -1)"
case "$OUT" in *"走真实网络"*) echo "PASS V23-3" ;; *) echo "FAIL V23-3 | $OUT" ;; esac

echo "== V23-4 界面改规则也是写操作：agent 持权时必须被拒 =="
( $W exec cap <<'JS' > /tmp/n4-hold.log 2>&1
await page.waitForTimeout(6000);
return 'held';
JS
) &
HOLD=$!
sleep 2
OUT=$(evalr "(async () => { try { await window.envApi.netRuleSet('cap', '$RID', true); return 'UNEXPECTED_OK'; } catch (e) { return 'ERR: ' + e.message; } })()")
echo "  $OUT"
case "$OUT" in *ENV_BUSY*) echo "PASS V23-4 | agent 持权时界面改规则被拒" ;; *) echo "FAIL V23-4 | $OUT" ;; esac
wait $HOLD 2>/dev/null

echo "== 清理 =="
clear_rules
$W net rules cap
