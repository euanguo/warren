# Gates: 执行 EXECUTION-PLAN-2026-10-17（批次 0–6）

OWNS: bin/warren.mjs, src/**, tests/**, scripts/**, .github/workflows/ci.yml, docs/**, GATES.md

Scope: 按 docs/EXECUTION-PLAN-2026-10-17.md 依次执行批次 0–6，每批自验后提交。

- [x] G0: CLI 两处 P0 修好（清单单一来源 + 未知组 exit 1）
  CHECK: node scripts/verify/batch0-cli.mjs
  EXPECT: BATCH0 PASS
  EVIDENCE: 2026-10-17 bash -lc node scripts/verify/batch0-cli.mjs -> exit 0, "BATCH0 PASS (54 个子命令 + 4 个顶层命令全覆盖)"；run-all.sh 140 PASS / 0 FAIL；npm test 186/186

- [x] G1: 焦点矩阵实验跑完并把结论写进 CLI/OPTIMIZATION 文档
  CHECK: node scripts/verify/batch1-focus.mjs
  EXPECT: BATCH1 PASS
  EVIDENCE: 2026-10-17 node scripts/verify/batch1-focus.mjs -> exit 0, "BATCH1 PASS (后台环境有效；失焦后坐标不变；document.hasFocus()=false)"；并修掉 1.4 发现的 focusDisplayedPage bug；run-all.sh 140 PASS / 0 FAIL

- [x] G2: 焦点守卫按实验结果调整 + CI 增加 GUI job + 五道静态门与全量回归全绿
  CHECK: node scripts/verify/batch2-guard-ci.mjs
  EXPECT: BATCH2 PASS
  EVIDENCE: 2026-10-17 node scripts/verify/batch2-guard-ci.mjs -> exit 0, "BATCH2 PASS"；capability.sh V16 PASS；run-all.sh 141 PASS / 0 FAIL；npm test 186/186；五道静态门全过

- [x] G3: 能加载解包扩展（普通扩展可用），并给出 DevTools 扩展的实测结论
  CHECK: node scripts/verify/batch3-extension.mjs
  EXPECT: BATCH3 PASS
  EVIDENCE: 2026-10-17 node scripts/verify/batch3-extension.mjs -> exit 0, "BATCH3 PASS"；npm test 189/189；run-all.sh 145 PASS / 0 FAIL。DevTools 面板未出现（否定结论，见 EXECUTION-PLAN 批次 3）

- [x] G4: net.* 拆成带注入点的模块 + 新增单测，回归 n1–n5 全绿
  CHECK: node scripts/verify/batch4-netops.mjs
  EXPECT: BATCH4 PASS
  EVIDENCE: 2026-10-17 npm test 197/197（+9 条 net-ops 单测）；run-all.sh 144 PASS / 0 FAIL（n1–n5 全绿）

- [x] G5: 录制期间能按序读 response body，且敏感字段已脱敏
  CHECK: node scripts/verify/batch5-body.mjs
  EXPECT: BATCH5 PASS
  EVIDENCE: 2026-10-17 node scripts/verify/batch5-body.mjs -> exit 0, "BATCH5 PASS"；npm test 201/201（+4）；run-all.sh 145 PASS / 0 FAIL

- [x] G6: 鼠标路径合成生效（mousemove 次数显著增加）+ 截图哈希对比可用
  CHECK: node scripts/verify/batch6-path-shot.mjs
  EXPECT: BATCH6 PASS
  EVIDENCE: 2026-10-17 node scripts/verify/batch6-path-shot.mjs -> exit 0, "BATCH6 PASS（mousemove 8 次；截图确定；shot diff 相同 exit 0 / 不同 exit 1）"；npm test 208/208；run-all.sh 146 PASS / 0 FAIL
