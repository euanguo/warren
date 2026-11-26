#!/bin/bash
# Shared helpers for scripts/regress/*.sh suites.
W="${W:-node bin/warren.mjs}"

jq1() {
  node -e 'const fs=require("fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){console.log("BADJSON");return}const f=eval(process.argv[1]);console.log(f(j))})' "$1"
}

ok() {
  if [ "$2" = "$3" ]; then
    echo "PASS $1 | $3"
  else
    echo "FAIL $1 | 期望[$2] 实际[$3]"
  fi
}

check() {
  ok "$@"
}

rule_ids() {
  local env="${1:-cap}"
  $W net rules "$env" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).rules.map(r=>r.id).join(' ')))"
}

clear_rules() {
  local env="${1:-cap}"
  for i in $(rule_ids "$env"); do
    $W net rule remove "$env" "$i" > /dev/null 2>&1
  done
}

evalr() {
  node -e '
    const { execFileSync } = require("child_process");
    const out = execFileSync("node", ["bin/warren.mjs","call","debug.rendererEval", JSON.stringify({ script: process.argv[1] })], { encoding: "utf8" });
    const j = JSON.parse(out);
    console.log(typeof j.value === "string" ? j.value : JSON.stringify(j.value));
  ' "$1"
}
