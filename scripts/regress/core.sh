#!/bin/bash
cd "$(cd "$(dirname "$0")/../.." && pwd)"
W="node bin/warren.mjs"
# 审批策略是持久化的；前面的 UI 用例可能把它改成 agent-created / auto。
# 1.11 的前提是默认 ask（人持权时 agent 不能抢），先重置，避免测试互相污染。
$W call debug.rendererEval '{"script":"(async()=>{await window.envApi.setSettings({controlPolicy:\"ask\",pluginPolicy:\"ask\"});return \"ok\";})()"}' > /dev/null 2>&1
jq1() { node -e 'const fs=require("fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){console.log("BADJSON");return}const f=eval(process.argv[1]);console.log(f(j))})' "$1"; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1 | $3"; else echo "FAIL $1 | 期望[$2] 实际[$3]"; fi; }
layout() { $W call debug.layout | jq1 "(j) => j.$1"; }
envs() { $W env list --json; }
person_tabs() { jq1 '(j) => JSON.stringify(j.find(e=>e.id==="regr")?.spaces.find(s=>s.id==="person")?.tabs ?? [])'; }

echo "===== 1. 环境生命周期 / 租约 / 遮罩 ====="
$W env remove regr > /dev/null 2>&1
$W env create regr --start-url=http://127.0.0.1:8899/login.html > /dev/null
check "1.1 create 后是 stopped" "stopped" "$(envs | jq1 '(j) => j.find(e=>e.id==="regr")?.status')"
$W env start regr > /dev/null
check "1.2 start 后 running" "running" "$(envs | jq1 '(j) => j.find(e=>e.id==="regr")?.status')"
check "1.3 start 会选中它" "regr" "$(layout selected)"
check "1.4 无 lease 时 owner=none" "none" "$(layout owner)"
check "1.5 无 lease 时无遮罩" "false" "$(layout shieldAttached)"
check "1.6 页面视图挂在窗口上" '["regr"]' "$(node -e 'const o=JSON.parse(require("child_process").execFileSync("node",["bin/warren.mjs","call","debug.layout"],{encoding:"utf8"}));console.log(JSON.stringify(o.showing))')"
$W env acquire regr > /dev/null
check "1.7 agent 持权 owner=agent" "agent" "$(layout owner)"
$W call debug.rendererEval '{"script":"window.envApi.spaceSelect(\"regr\",\"agent\")"}' > /dev/null
check "1.8 agent 持权遮罩盖上" "true" "$(layout shieldAttached)"
$W env takeover regr > /dev/null
check "1.9 人接管 owner=human" "human" "$(layout owner)"
check "1.10 人接管撤掉遮罩" "false" "$(layout shieldAttached)"
$W env acquire regr > /dev/null 2>&1
check "1.11 人持权时 agent 抢权被拒" "1" "$?"
$W env release regr --lease="$(envs | jq1 '(j) => j.find(e=>e.id==="regr").leaseId')" > /dev/null
check "1.12 释放后 owner=none" "none" "$(layout owner)"

echo "===== 2. 标签 ====="
$W call debug.rendererEval '{"script":"(async()=>{await window.envApi.tabCreate(\"regr\",\"person\",\"http://127.0.0.1:8899/cap/form.html\");return true;})()"}' > /dev/null
check "2.1 新建标签后 2 个" "2" "$(envs | person_tabs | jq1 '(j) => j.length')"
check "2.2 新标签是激活的" "2" "$(envs | person_tabs | jq1 '(j) => j.findIndex(t=>t.active)+1')"
$W call debug.rendererEval '{"script":"(async()=>{await window.envApi.tabSelect(\"regr\",\"person\",1);return true;})()"}' > /dev/null
check "2.3 切回 1 号" "1" "$(envs | person_tabs | jq1 '(j) => j.findIndex(t=>t.active)+1')"
$W call debug.rendererEval '{"script":"(async()=>{await window.envApi.tabClose(\"regr\",\"person\",2);return true;})()"}' > /dev/null
check "2.4 关掉一个剩 1 个" "1" "$(envs | person_tabs | jq1 '(j) => j.length')"
# ⌘⇧T：关掉的那个能重新打开（地址跟着回来）
$W call debug.rendererEval '{"script":"(async()=>{await window.envApi.tabReopen(\"regr\",\"person\");return true;})()"}' > /dev/null
sleep 1
check "2.4b 重新打开关掉的标签" "2" "$(envs | person_tabs | jq1 '(j) => j.length')"
check "2.4c 重开的是刚才那个地址" "http://127.0.0.1:8899/cap/form.html" "$(envs | person_tabs | jq1 '(j) => j[j.length-1].url')"
# 2.6/2.7 标签持久化：停环境再起来，那一组标签（含激活位）要原样回来
$W call debug.rendererEval '{"script":"(async()=>{await window.envApi.tabCreate(\"regr\",\"person\",\"http://127.0.0.1:8899/cap/net.html\");return true;})()"}' > /dev/null
sleep 1
$W env stop regr > /dev/null
$W env start regr > /dev/null
sleep 2
check "2.6 停再起：标签组回来" "3" "$(envs | person_tabs | jq1 '(j) => j.length')"
check "2.7 激活位也回来" "3" "$(envs | person_tabs | jq1 '(j) => j.findIndex(t=>t.active)+1')"
for ref in 3 2 1; do
  $W call debug.rendererEval "{\"script\":\"(async()=>{await window.envApi.tabClose(\\\"regr\\\",\\\"person\\\",$ref);return true;})()\"}" > /dev/null
done
check "2.5 关掉最后一个 → 环境停" "stopped" "$(envs | jq1 '(j) => j.find(e=>e.id==="regr")?.status')"

echo "===== 3. 分组 ====="
$W env start regr > /dev/null
GID=$($W group create 回归组 --json | jq1 '(j) => j.id')
$W env move regr --group="$GID" > /dev/null
check "3.1 环境进分组" "$GID" "$(envs | jq1 '(j) => j.find(e=>e.id==="regr")?.groupId')"
$W group collapse "$GID" > /dev/null
check "3.2 分组可收起" "true" "$($W group list --json | jq1 "(j) => j.find(g=>g.id==='$GID').collapsed")"
$W group rename "$GID" 回归组2 > /dev/null
check "3.3 分组可改名" "回归组2" "$($W group list --json | jq1 "(j) => j.find(g=>g.id==='$GID').name")"
$W env move regr --group=none > /dev/null
check "3.4 移出分组" "undefined" "$(envs | jq1 '(j) => j.find(e=>e.id==="regr")?.groupId')"
check "3.5 删组保留环境" "0" "$($W group remove "$GID" --json | jq1 '(j) => j.detached')"

echo "===== 4. 遥测（console / network）====="
$W exec regr > /dev/null 2>&1 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/form.html');
await page.evaluate("console.warn('regr-console-probe')");
await page.waitForTimeout(300);
return 'ok';
JS
check "4.1 console 抓到 warn" "warn" "$($W browser console regr --json | jq1 '(j) => (j.find(e=>e.message.includes("regr-console-probe"))||{}).level')"
check "4.2 network 抓到 200" "1" "$($W browser network regr --json | jq1 '(j) => j.filter(e=>e.url.includes("/cap/form.html") && e.status===200).length > 0 ? 1 : 0')"

echo "===== 5. Vault（细项见 regr-vault.sh）====="
$W vault list --json > /tmp/regr-vault.json
check "5.1 清单里没有明文密码" "0" "$(node -e 'const s=require("fs").readFileSync("/tmp/regr-vault.json","utf8");console.log(/fixture-secret|"password":|"username":/.test(s)?1:0)')"
check "5.2 每条凭据都带 available 标记" "1" "$(node -e 'const j=require("/tmp/regr-vault.json");console.log(j.credentials.every(c=>typeof c.available==="boolean")?1:0)')"

echo "===== 6. CLI 面 ====="
check "6.1 无参数打帮助" "1" "$($W 2>&1 | grep -c 'warren —— Warren 的 Agent 接口')"
check "6.2 未知 RPC 方法报 METHOD_NOT_FOUND" "1" "$($W call net.nope 2>&1 | grep -c METHOD_NOT_FOUND)"
check "6.3 未知环境报 ENV_NOT_FOUND" "1" "$($W env start 不存在的环境 2>&1 | grep -c ENV_NOT_FOUND)"
# 批次 0（docs/EXECUTION-PLAN-2026-10-17.md）：打错的组名以前静默吐 help 并退出 0
check "6.4 未知命令组退出 1" "1" "$($W nope > /dev/null 2>&1; echo $?)"
check "6.5 未知命令组不往 stdout 写" "0" "$($W nope 2> /dev/null | wc -l | tr -d ' ')"
check "6.6 help 覆盖全部子命令" "0" "$(node scripts/verify/batch0-cli.mjs > /dev/null 2>&1; echo $?)"

echo "===== 清理 ====="
$W env stop regr > /dev/null 2>&1
$W env remove regr > /dev/null 2>&1
envs | jq1 '(j) => "剩余环境: " + j.map(e=>e.id).join(",")'
