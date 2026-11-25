#!/bin/bash
set -euo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
W="node bin/warren.mjs"
jq1() {
  node -e 'const fs=require("fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){console.log("BADJSON");return}console.log(eval(process.argv[1])(j))})' "$1"
}
ok() {
  if [ "$2" = "$3" ]; then echo "PASS $1 | $3"; else echo "FAIL $1 | 期望[$2] 实际[$3]"; fi
}

echo "===== 24. 后台常驻：隐藏窗口仍能操作 ====="
# 单独跑本脚本时也守同一个开关：默认不碰窗口（移出屏幕 / 搬回来 / Dock 隐藏显示）。
# 只有显式 `WARREN_REGRESS_WINDOW=1 bash scripts/regress/background.sh` 才做窗口态验收。
if [ "${WARREN_REGRESS_WINDOW:-0}" != "1" ]; then
  echo "SKIP 24 后台常驻 | WARREN_REGRESS_WINDOW=0（不碰窗口）"
  exit 0
fi
$W env start cap >/dev/null 2>&1 || true
$W env select cap >/dev/null
$W call debug.rendererEval '{"script":"window.envApi.spaceSelect(\"cap\",\"person\")"}' >/dev/null
$W tab new cap --space=agent http://127.0.0.1:8899/cap/form.html >/dev/null
$W call debug.backgroundWindow >/dev/null
HIDDEN=$($W call debug.layout --json)
ok "24.1 窗口不可见但进程仍在" "1" "$(echo "$HIDDEN" | jq1 '(j) => (j.windowOpacity === 0 && j.windowBounds.x < 0 ? 1 : 0)')"
RESULT=$($W exec cap --json <<'JS'
await page.goto('http://127.0.0.1:8899/cap/form.html');
await page.click('#submit');
return await page.evaluate("document.querySelector('#result').textContent");
JS
)
ok "24.2 隐藏状态下 CDP 点击仍落地" "1" "$(echo "$RESULT" | jq1 '(j) => (j === "未提交" ? 0 : 1)')"
SHOT=$($W browser screenshot cap --base64 2>&1)
SHOT_CODE=$?
if [ "$SHOT_CODE" = "0" ] && echo "$SHOT" | grep -q 'source='; then SHOT_OK=1; else SHOT_OK=0; fi
ok "24.2b 隐藏状态下截图仍成功" "1" "$SHOT_OK"
AFTER=$($W call debug.layout --json)
ok "24.3 后台操作仍显示 Person Space" "person" "$(echo "$AFTER" | jq1 '(j) => j.activeSpace')"
ok "24.4 窗口没有被后台操作强制拉回" "1" "$(echo "$AFTER" | jq1 '(j) => (j.windowOpacity === 0 && j.windowBounds.x < 0 ? 1 : 0)')"
$W call debug.showWindow >/dev/null
SHOWN=$($W call debug.layout --json)
ok "24.5 托盘恢复后窗口可见" "true" "$(echo "$SHOWN" | jq1 '(j) => j.windowVisible')"
