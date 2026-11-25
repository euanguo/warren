#!/bin/bash
# 回归时的「别烦我」守卫：只读地采样系统前台应用 + Warren 窗口状态，
# 累计变化到阈值就**立刻终止整轮回归**，不让它跑满一分钟影响用户操作。
#
# 前台用 System Events 的**只读查询**（绝不 activate），窗口走 debug.layout（纯读）。
# 守卫自己绝不碰窗口/前台，否则它本身就是干扰源。
#
# 用法：front-guard.sh <run-all.sh 的 pid> [阈值，默认 3]
# 状态落在 /tmp/warren-regress-guard.log，终止原因也写进去。
set -u
TARGET="${1:?需要 run-all.sh 的 pid}"
MAX="${2:-3}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="${WARREN_REGRESS_GUARD_STATE:-/tmp/warren-regress-guard.log}"
: > "$STATE"

last=""
front_changed=0
stop() {
  echo "FRONT_GUARD: $1，终止回归 pid=$TARGET" >> "$STATE"
  # 整棵进程树一起停：run-all.sh → bash 套件 → node/CLI，只杀父进程会留一片孤儿。
  descendants() {
    local parent="$1" child
    for child in $(pgrep -P "$parent" 2>/dev/null); do
      descendants "$child"
      echo "$child"
    done
  }
  kill -TERM "$TARGET" 2>/dev/null || true
  for pid in $(descendants "$TARGET"); do kill -TERM "$pid" 2>/dev/null || true; done
  exit 0
}

while kill -0 "$TARGET" 2>/dev/null; do
  front="$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null || echo unknown)"
  layout="$(node "$ROOT/bin/warren.mjs" call debug.layout --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.windowBounds.x+","+j.windowBounds.y+",op="+j.windowOpacity+",f="+j.windowFocused+",vis="+j.windowVisible)}catch(e){console.log("unknown")}})' 2>/dev/null || echo unknown)"
  current="$front|$layout"
  if [ -n "$last" ] && [ "$current" != "$last" ]; then
    last_front="${last%%|*}"
    last_layout="${last#*|}"
    if [ "$layout" != "$last_layout" ]; then
      # 窗口位置/可见性/焦点被改动 = 回归在动用户的电脑，立刻停，不累计。
      echo "$(date +%H:%M:%S) 窗口态变化 front=$front layout=$layout" >> "$STATE"
      stop "Warren 窗口状态被改动"
    fi
    if [ "$front" != "$last_front" ]; then
      front_changed=$((front_changed + 1))
      echo "$(date +%H:%M:%S) 前台变化#$front_changed front=$front" >> "$STATE"
    else
      front_changed=0
    fi
    if [ "$front_changed" -ge "$MAX" ]; then
      stop "系统前台连续变化 $front_changed 次"
    fi
  fi
  last="$current"
  sleep 2
done
