#!/bin/bash
# Warren 全量回归。跑之前需要：
#   1) 按 AGENTS「已知问题」第 4 条清理后 npm start（在能常驻的终端里）
#   2) node scripts/serve-fixture.mjs 8899
#
# **其余前置（cap 环境、示例插件、探针文件、UI 要的那几个环境）本脚本自己会补**，
# 缺什么补什么、跑完清理。唯一补不了的是「Warren 窗口在前台」——输入类检查靠它，
# 所以下面会先检查，不满足就直接退出并说明原因（不然会看到一大片假 FAIL）。
# 结果同时落在 $OUT（默认 /tmp/warren-regress.txt），末尾给 PASS/FAIL 汇总。
#
# 预期**全绿**：唯一非 PASS 是 vault 的 5.7 SKIP（「这个 vault 里没有解不开的凭据」）。
# 跨源 iframe（OOPIF，原 V5b）2026-10-16 已经打通，不再是预期缺口。
# 要确定性的话用 `WARREN_RESTORE=0 npm start`：默认会把上次被 kill 时在跑的环境自动拉起来
# （正常退出不会——`shutdown()` 会把 running.json 写成空的）。
set -u
cd "$(cd "$(dirname "$0")/../.." && pwd)"
R="scripts/regress"
OUT="${OUT:-/tmp/warren-regress.txt}"
: > "$OUT"
W="node bin/warren.mjs"
mkdir -p /tmp/regr

# 别烦我守卫：系统前台 / Warren 窗口状态累计变化 3 次就终止本轮回归。
# 用户正在用电脑时，任何反复切前台或搬窗口都该立刻停，不要跑满一分钟。
# `WARREN_REGRESS_GUARD=0` 可关掉（CI 里没有真实用户前台，建议关）。
if [ "${WARREN_REGRESS_GUARD:-1}" != "0" ]; then
  bash "$R/front-guard.sh" "$$" "${WARREN_REGRESS_GUARD_MAX:-3}" &
  GUARD_PID=$!
  trap 'kill "$GUARD_PID" 2>/dev/null || true' EXIT
fi

echo "########## 前置检查 ##########"
jq1() { node -e 'const fs=require("fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){console.log("BADJSON");return}console.log(eval(process.argv[1])(j))})' "$1"; }

# 1) fixture（假 FAIL 的第一大来源：它挂了会让全线「失败」）
FIXTURE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8899/cap/form.html)
[ "$FIXTURE" = "200" ] || { echo "fixture 不可用（HTTP $FIXTURE）：先起 node scripts/serve-fixture.mjs 8899"; exit 1; }
echo "fixture: $FIXTURE"

# 2) 应用在跑。窗口焦点**不再是硬前置** ——
# 2026-10-17 实测：窗口失焦时 CDP 输入照样落地，坐标也和前台一致
# （scripts/verify/batch1-focus.mjs）。以前这里因为 WINDOW_NOT_FOCUSED 直接退出，
# 那是守卫自己拦的，守卫已经删了。现在只把状态打出来，方便排查。
#
# 2026-11-03 起默认**完全不碰窗口**：`WARREN_REGRESS_WINDOW=0`（默认）跳过
# background.sh + batch1/batch2 里所有 `debug.backgroundWindow` / `debug.showWindow`
# / `debug.focusWindow` 调用（它们会把窗口移出屏幕再搬回来、Dock 反复隐藏显示，
# 用户正在用电脑时干扰很大）。CDP 输入不依赖这些，跳过是安全的。
# 需要专门验「离屏 / 托盘恢复」时再显式 `WARREN_REGRESS_WINDOW=1`。
export WARREN_REGRESS_WINDOW="${WARREN_REGRESS_WINDOW:-0}"
LAYOUT=$($W call debug.layout --json 2>/dev/null) || { echo "应用没起来：先 npm start"; exit 1; }
echo "windowFocused: $(echo "$LAYOUT" | jq1 '(j) => j.windowFocused')（只作观测，不影响结果）"

# 3) cap 环境（套件的地基）
$W env list --json | grep -q '"id": *"cap"' || $W env create cap --start-url=http://127.0.0.1:8899/cap/form.html > /dev/null
$W env start cap > /dev/null 2>&1
$W env select cap > /dev/null 2>&1

# 4) 示例插件：装了就不重装（重装会把 enabled 状态清掉），该跑的确保在跑
have() { $W plugin list --json | jq1 "(j) => j.some(p=>p.id==='$1')"; }
for spec in "com.example.notes:plugins/example-notes" "com.example.hosty:plugins/example-host" "com.warren.accounts:plugins/account-manager" "com.example.broken:fixtures/plugins/broken"; do
  id="${spec%%:*}"; dir="${spec#*:}"
  [ "$(have "$id")" = "true" ] || $W plugin install "path:$dir" > /dev/null
done
for id in com.example.notes com.example.hosty com.warren.accounts; do
  [ "$($W plugin list --json | jq1 "(j) => j.find(p=>p.id==='$id').status")" = "running" ] || $W plugin enable "$id" > /dev/null
done
echo "cap + 示例插件就绪"

# 5) 把界面切回「环境」页。后面的套件都假设侧栏和舞台在——而 rail 上点进插件页
#    （代理 / 记忆）或设置页时，`sidebarVisible = !stageReplaced` 会把侧栏整个卸掉，
#    于是 UI / n4 那些用例全变成 NO_TAB、0 行（实测踩过：手工点过插件页再跑，11 个假 FAIL）。
$W call debug.rendererEval \
  '{"script":"document.querySelector(\"[data-slot=app-rail] button[aria-label=\\\"环境\\\"]\")?.click()"}' > /dev/null 2>&1
sleep 1

echo "########## G0 静态门 ##########" | tee -a "$OUT"
npx tsc --noEmit 2>&1 | tail -2 | tee -a "$OUT"; echo "tsc exit=$?" | tee -a "$OUT"
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" | tee -a "$OUT"
node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs 2>&1 | tail -1 | tee -a "$OUT"

run_suite() { echo "########## $1 ##########" | tee -a "$OUT"; bash "$2" 2>&1 | grep -E "^(PASS|FAIL|SKIP)" | tee -a "$OUT"; }

run_suite "浏览器能力 V1–V15" "$R/capability.sh"
for s in n1 n2 n3 n4 n5; do run_suite "网络拦截 $s" "$R/net-$s.sh"; done
run_suite "核心域（环境/租约/遮罩/标签/分组/遥测/CLI）" "$R/core.sh"
run_suite "Vault 端到端" "$R/vault.sh"
run_suite "插件" "$R/plugin.sh"
if [ "$WARREN_REGRESS_WINDOW" = "1" ]; then
  run_suite "后台常驻" "$R/background.sh"
else
  echo "########## 后台常驻（跳过：WARREN_REGRESS_WINDOW=0，不碰窗口）##########" | tee -a "$OUT"
  echo "SKIP 后台常驻（WARREN_REGRESS_WINDOW=0，不碰窗口）" | tee -a "$OUT"
fi
run_suite "浏览器能力补充（截图/逃生舱/等待/上传下载/拖拽/shadow/dialog/键鼠/标签）" "$R/browser.sh"

# 批次验收脚本（docs/EXECUTION-PLAN-2026-10-17.md）。它们各自起/清自己的环境，
# 不改窗口焦点，所以放最后跑。每条自己打 BATCHn PASS/FAIL。
echo "########## 批次验收 ##########" | tee -a "$OUT"
for v in scripts/verify/batch0-cli.mjs scripts/verify/batch1-focus.mjs scripts/verify/batch2-guard-ci.mjs scripts/verify/batch3-extension.mjs scripts/verify/batch4-netops.mjs scripts/verify/batch5-body.mjs scripts/verify/batch6-path-shot.mjs; do
  if [ "$WARREN_REGRESS_WINDOW" != "1" ] && { [ "$v" = "scripts/verify/batch1-focus.mjs" ] || [ "$v" = "scripts/verify/batch2-guard-ci.mjs" ]; }; then
    echo "SKIP BATCH $(basename "$v" .mjs)（WARREN_REGRESS_WINDOW=0，不碰窗口）" | tee -a "$OUT"
    continue
  fi
  [ -f "$v" ] || continue
  node "$v" 2>&1 | tail -1 | sed 's/^BATCH/PASS BATCH/;s/ FAIL/ FAIL/' | tee -a "$OUT"
done
echo "########## UI ##########" | tee -a "$OUT"
node "$R/ui.cjs" 2>&1 | grep -E "^(PASS|FAIL)" | tee -a "$OUT"

# 收尾：回归会开一堆标签，而标签是**持久化**的（env_tabs），不清掉的话下次 env start
# 会把它们全恢复回来（实测跑完留下 5 个同名 form fixture，界面上完全分不清）。
# 每次关第 2 个，直到只剩一个；关不动就停（别把套件自己卡住）。
for space in person agent; do
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    $W tab close cap --space=$space 2 > /dev/null 2>&1 || break
  done
done

echo | tee -a "$OUT"
echo "===== 汇总 =====" | tee -a "$OUT"
grep -c "^PASS" "$OUT" | sed 's/^/PASS 总数: /' | tee -a "$OUT"
grep -c "^FAIL" "$OUT" | sed 's/^/FAIL 总数: /' | tee -a "$OUT"
grep -c "^SKIP" "$OUT" | sed 's/^/SKIP 总数: /' | tee -a "$OUT"
grep "^FAIL" "$OUT" | tee -a "$OUT"
