#!/bin/bash
# Warren 全量回归。跑之前需要：
#   1) 按 AGENTS「已知问题」第 4 条清理后 npm start（在能常驻的终端里）
#   2) node scripts/serve-fixture.mjs 8899
#
# 日常局部改动请走无头检查（npm run check:changed / npm run test:ui），
# 仅跨多域重大改造或发版前显式传 `--allow-full` 运行。
set -u
cd "$(cd "$(dirname "$0")/../.." && pwd)"

ALLOW_FULL="${WARREN_ALLOW_FULL_REGRESS:-0}"
for arg in "$@"; do
  if [ "$arg" = "--allow-full" ]; then
    ALLOW_FULL="1"
  fi
done

if [ "$ALLOW_FULL" != "1" ]; then
  cat <<'EOF'
[已禁用] 默认全量真机 GUI 回归脚本已禁用，避免日常小改动耗时过长并抢占桌面窗口。

日常改动请使用无头测试框架（不启动 Electron）：
  - 定向验证本次改动：npm run test:changed
  - 仅跑无头 UI 套件：npm run test:ui
  - 仅跑指定单测文件：node --test tests/<file>.test.ts

仅在跨多域重大改造或发版前需要全量真机回归时，显式执行：
  bash scripts/regress/run-all.sh --allow-full
或：
  WARREN_ALLOW_FULL_REGRESS=1 bash scripts/regress/run-all.sh
EOF
  exit 2
fi

R="scripts/regress"
# shellcheck source=scripts/regress/lib.sh
source "$R/lib.sh"

OUT="${OUT:-/tmp/warren-regress.txt}"
: > "$OUT"
REGR_TMP=$(mktemp -d "${TMPDIR:-/tmp}/warren-regr.XXXXXX")
export REGR_TMP

GUARD_PID=""
cleanup() {
  if [ -n "$GUARD_PID" ]; then
    kill "$GUARD_PID" 2>/dev/null || true
  fi
  rm -rf "$REGR_TMP"
}
trap cleanup EXIT

# 别烦我守卫：系统前台 / Warren 窗口状态累计变化 3 次就终止本轮回归。
if [ "${WARREN_REGRESS_GUARD:-1}" != "0" ]; then
  bash "$R/front-guard.sh" "$$" "${WARREN_REGRESS_GUARD_MAX:-3}" &
  GUARD_PID=$!
fi

echo "########## 前置检查 ##########"

# 1) fixture
FIXTURE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8899/cap/form.html)
[ "$FIXTURE" = "200" ] || { echo "fixture 不可用（HTTP $FIXTURE）：先起 node scripts/serve-fixture.mjs 8899"; exit 1; }
echo "fixture: $FIXTURE"

# 2) 应用在跑
export WARREN_REGRESS_WINDOW="${WARREN_REGRESS_WINDOW:-0}"
LAYOUT=$($W call debug.layout --json 2>/dev/null) || { echo "应用没起来：先 npm start"; exit 1; }
echo "windowFocused: $(echo "$LAYOUT" | jq1 '(j) => j.windowFocused')（只作观测，不影响结果）"

# 3) cap 环境
$W env list --json | grep -q '"id": *"cap"' || $W env create cap --start-url=http://127.0.0.1:8899/cap/form.html > /dev/null
$W env start cap > /dev/null 2>&1
$W env select cap > /dev/null 2>&1

# 4) 示例插件
have() { $W plugin list --json | jq1 "(j) => j.some(p=>p.id==='$1')"; }
for spec in "com.example.notes:plugins/example-notes" "com.example.hosty:plugins/example-host" "com.warren.accounts:plugins/account-manager" "com.example.broken:fixtures/plugins/broken"; do
  id="${spec%%:*}"; dir="${spec#*:}"
  [ "$(have "$id")" = "true" ] || $W plugin install "path:$dir" > /dev/null
done
for id in com.example.notes com.example.hosty com.warren.accounts; do
  [ "$($W plugin list --json | jq1 "(j) => j.find(p=>p.id==='$id').status")" = "running" ] || $W plugin enable "$id" > /dev/null
done
echo "cap + 示例插件就绪"

# 5) 把界面切回「环境」页
$W call debug.rendererEval \
  '{"script":"document.querySelector(\"[data-slot=settings-back]\")?.click()"}' > /dev/null 2>&1
sleep 1

echo "########## G0 静态门 ##########" | tee -a "$OUT"
run_g0() {
  local name="$1"; shift
  local log="$REGR_TMP/g0-$name.log"
  "$@" > "$log" 2>&1
  local rc=$?
  tail -2 "$log" | tee -a "$OUT"
  if [ "$rc" -eq 0 ]; then
    echo "PASS G0-$name | exit=0" | tee -a "$OUT"
  else
    echo "FAIL G0-$name | exit=$rc" | tee -a "$OUT"
  fi
}

run_g0 tsc npx tsc --noEmit
run_g0 unit npm test
run_g0 vite node node_modules/vite/bin/vite.js build --config vite.renderer.config.mjs

run_suite() {
  local name="$1"; local script="$2"
  local log="$REGR_TMP/suite-$(basename "$script").log"
  echo "########## $name ##########" | tee -a "$OUT"
  bash "$script" > "$log" 2>&1
  local rc=$?
  grep -E "^(PASS|FAIL|SKIP)" "$log" | tee -a "$OUT" || true
  if [ "$rc" -ne 0 ] && ! grep -q "^FAIL" "$log"; then
    echo "FAIL $name | 脚本异常退出 exit=$rc" | tee -a "$OUT"
  fi
}

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

echo "########## 批次验收 ##########" | tee -a "$OUT"
for v in scripts/verify/batch0-cli.mjs scripts/verify/batch1-focus.mjs scripts/verify/batch2-guard-ci.mjs scripts/verify/batch3-extension.mjs scripts/verify/batch4-netops.mjs scripts/verify/batch5-body.mjs scripts/verify/batch6-path-shot.mjs; do
  if [ "$WARREN_REGRESS_WINDOW" != "1" ] && { [ "$v" = "scripts/verify/batch1-focus.mjs" ] || [ "$v" = "scripts/verify/batch2-guard-ci.mjs" ]; }; then
    echo "SKIP BATCH $(basename "$v" .mjs)（WARREN_REGRESS_WINDOW=0，不碰窗口）" | tee -a "$OUT"
    continue
  fi
  [ -f "$v" ] || continue
  log="$REGR_TMP/$(basename "$v").log"
  node "$v" > "$log" 2>&1
  rc=$?
  last=$(tail -1 "$log")
  if [ "$rc" -eq 0 ] && ! echo "$last" | grep -q "FAIL"; then
    echo "PASS $last" | tee -a "$OUT"
  else
    echo "FAIL $(basename "$v" .mjs) (exit=$rc) | $last" | tee -a "$OUT"
  fi
done

echo "########## UI ##########" | tee -a "$OUT"
ui_log="$REGR_TMP/ui.log"
node "$R/ui.cjs" > "$ui_log" 2>&1
ui_rc=$?
grep -E "^(PASS|FAIL)" "$ui_log" | tee -a "$OUT" || true
if [ "$ui_rc" -ne 0 ] && ! grep -q "^FAIL" "$ui_log"; then
  echo "FAIL UI 回归 | exit=$ui_rc" | tee -a "$OUT"
fi

# 清理回归过程中新开的持久化 tab
for space in person agent; do
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    $W tab close cap --space=$space 2 > /dev/null 2>&1 || break
  done
done

echo | tee -a "$OUT"
echo "===== 汇总 =====" | tee -a "$OUT"
PASS_COUNT=$(grep -c "^PASS" "$OUT" || true)
FAIL_COUNT=$(grep -c "^FAIL" "$OUT" || true)
SKIP_COUNT=$(grep -c "^SKIP" "$OUT" || true)
echo "PASS 总数: $PASS_COUNT" | tee -a "$OUT"
echo "FAIL 总数: $FAIL_COUNT" | tee -a "$OUT"
echo "SKIP 总数: $SKIP_COUNT" | tee -a "$OUT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  grep "^FAIL" "$OUT" | tee -a "$OUT" || true
  exit 1
fi
exit 0
