#!/bin/bash
cd "$(cd "$(dirname "$0")/../.." && pwd)"
W="node bin/warren.mjs"
probe() {
  local name="$1"
  local out; out=$($W exec cap 2>&1); local code=$?
  if [ $code -eq 0 ]; then echo "PASS $name | $(echo "$out" | tail -3 | tr '\n' ' ')";
  else echo "FAIL $name | $(echo "$out" | tail -4 | tr '\n' ' ')"; fi
}
$W env stop cap > /dev/null 2>&1
$W env start cap > /dev/null
$W env select cap > /dev/null
sleep 1

probe V1 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/timing.html');
await page.click('#late');
const t = await page.evaluate(() => document.getElementById('result').textContent);
if (t !== 'late clicked') throw new Error('result=' + t);
return 'V1 ok';
JS

probe V2 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/timing.html');
await page.waitForTimeout(400);
await page.click('#rerender');
const t = await page.evaluate(() => document.getElementById('result').textContent);
if (t !== 'rerender clicked') throw new Error('result=' + t);
return 'V2 ok';
JS

probe V3 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/actionability.html');
await page.click('#moving');
const t = await page.evaluate(() => document.getElementById('result').textContent);
const m = /moving clicked at (\d+)/.exec(t);
if (!m || Number(m[1]) < 195) throw new Error('动画未停就点了: ' + t);
return 'V3 ok ' + t;
JS

probe V3b <<'JS'
await page.goto('http://127.0.0.1:8899/cap/actionability.html');
try { await page.click('#jitter', { timeoutMs: 1500 }); }
catch (e) { return 'V3b ok ' + e.code; }
throw new Error('V3b 没报错（静默失败）');
JS

probe V4 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/actionability.html');
const results = {};
for (const [name, sel, want] of [['covered','#covered','遮挡'], ['disabled','#disabled','disabled'], ['hidden','#hidden','不可见']]) {
  try { await page.click(sel, { timeoutMs: 1200 }); results[name] = 'SILENT_SUCCESS'; }
  catch (e) {
    const msg = String(e.message || '');
    results[name] = msg.includes(want) ? 'ok:' + e.code : 'WRONG:' + e.code + ':' + msg.split('\n').slice(0,2).join(' ');
  }
}
for (const k of ['covered','disabled','hidden']) if (!String(results[k]).startsWith('ok:')) throw new Error(k + '=' + results[k]);
return 'V4 ok ' + JSON.stringify(results);
JS

probe V5a <<'JS'
await page.goto('http://127.0.0.1:8899/cap/oopif.html');
const r = await page.evaluate(() => {
  const f = document.getElementById('frame');
  try {
    // 跨源时 contentDocument 是 null；同源才是 Document
    return f.contentDocument === null;
  } catch {
    return true;
  }
});
if (!r) throw new Error('不是跨源，V5 验收条件不成立');
return 'V5a ok 跨源';
JS

probe V5b <<'JS'
await page.goto('http://127.0.0.1:8899/cap/oopif.html');
for (let i = 0; i < 20; i++) {
  const snap = await page.snapshot({ scope: 'full_page' });
  if ((snap.nodes || []).some((n) => n.name === '内层按钮')) break;
  await page.waitForTimeout(200);
}
await page.click('text=内层按钮');
await page.waitForTimeout(400);
const snap = await page.snapshot({ scope: 'full_page' });
const hit = (snap.nodes || []).some((n) => n.name && n.name.includes('inner clicked'));
if (!hit) throw new Error('内层未收到点击');
return 'V5b ok';
JS

probe V5c <<'JS'
await page.goto('http://127.0.0.1:8899/cap/iframe.html');
await page.click('#inner');
await page.waitForTimeout(300);
const t = await page.evaluate(() => document.getElementById('frame').contentDocument.getElementById('inner-result').textContent);
if (t !== 'inner clicked') throw new Error(t);
return 'V5c ok 同源 iframe';
JS

# 跨源 iframe（OOPIF）的读 / 点 / 弹窗：子会话 + 坐标换算 + dialog 归属
probe V5d <<'JS'
await page.goto('http://127.0.0.1:8899/cap/oopif.html');
await page.waitForTimeout(900);
const snap = await page.snapshot({ scope: 'full_page' });
if (!(snap.nodes || []).some((n) => n.name === '内层按钮')) throw new Error('AX 里看不到跨源内容');
const r = await page.click('text=内层按钮');
await page.waitForTimeout(400);
const after = await page.snapshot({ scope: 'full_page' });
if (!(after.nodes || []).some((n) => n.name && n.name.includes('inner clicked'))) {
  throw new Error(`跨源点击没生效 @${Math.round(r.x)},${Math.round(r.y)}`);
}
return `V5d ok 跨源读+点 @${Math.round(r.x)},${Math.round(r.y)}`;
JS

probe V5e <<'JS'
await page.goto('http://127.0.0.1:8899/cap/oopif-dialog.html');
await page.waitForTimeout(900);
await page.getByRole('button', { name: '弹窗' }).click();
const ev = await page.events();
if (!ev.some((e) => e.type === 'alert')) throw new Error('跨源 iframe 里的 alert 没被捕获: ' + JSON.stringify(ev));
await page.acceptDialog();
await page.waitForTimeout(300);
const after = await page.snapshot({ scope: 'full_page' });
if (!(after.nodes || []).some((n) => n.name === '已弹出')) throw new Error('点击没落到跨源按钮上');
return 'V5e ok 跨源 dialog 捕获 + accept';
JS

probe V6 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/editor.html');
await page.fill('#editable', 'abc');
await page.fill('#editable', 'xy');
const v = await page.evaluate(() => document.getElementById('editable').textContent);
await page.fill('#date', '2026-10-15');
const d = await page.evaluate(() => document.getElementById('date').value);
await page.fill('#range', '70');
const r = await page.evaluate(() => document.getElementById('range').value);
if (v !== 'xy' || d !== '2026-10-15' || r !== '70') throw new Error(JSON.stringify({v,d,r}));
return 'V6 ok';
JS

probe V7 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/keys.html');
await page.click('#input');
await page.keyboard.down('Shift');
await page.keyboard.press('a');
await page.keyboard.up('Shift');
await page.keyboard.press('b');
const log = await page.evaluate(() => document.getElementById('log').textContent);
if (!/keydown:A/.test(log)) throw new Error('状态机: ' + log);
if (!/keypress/.test(log)) throw new Error('char 段: ' + log);
return 'V7 ok';
JS

probe V8 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/form.html');
const before = (await page.snapshot({})).nodes || [];
const box = before.find((n) => n.role === 'checkbox');
if (!box) throw new Error('找不到 checkbox');
if (box.checked !== false) throw new Error('checked 缺失/错: ' + JSON.stringify(box));
await page.click('loc=role:checkbox');
const after = (await page.snapshot({})).nodes || [];
const box2 = after.find((n) => n.role === 'checkbox');
if (box2.checked !== true) throw new Error('勾选后 checked=' + JSON.stringify(box2.checked));
const heading = after.find((n) => n.role === 'heading');
if (!heading || heading.level !== 1) throw new Error('heading level 缺失: ' + JSON.stringify(heading));
return 'V8 ok checked/level';
JS

probe V9 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/form.html');
await page.fill('text=姓名', '张三');
const v = await page.evaluate(() => document.getElementById('name').value);
let amb = 'no-error';
try { await page.click('css=input', { timeoutMs: 1500 }); } catch (e) { amb = e.code; }
if (v !== '张三') throw new Error('label=' + JSON.stringify(v));
if (amb !== 'TARGET_AMBIGUOUS') throw new Error('歧义=' + amb);
return 'V9 ok';
JS

probe V10 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/form.html');
await page.evaluate(() => {
  window.__seen = { warrenMatches: 0, xpathAttr: 0 };
  new MutationObserver((recs) => { for (const r of recs) if (r.attributeName === 'data-warren-xpath-idx') window.__seen.xpathAttr++; })
    .observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-warren-xpath-idx'] });
  Object.defineProperty(window, '__warrenMatches', { configurable: true,
    get() { window.__seen.warrenMatches++; return undefined; }, set() { window.__seen.warrenMatches++; } });
});
await page.click('xpath=//input[@id="name"]');
await page.click('css=#name');
const seen = await page.evaluate(() => window.__seen);
if (seen.xpathAttr !== 0 || seen.warrenMatches !== 0) throw new Error(JSON.stringify(seen));
return 'V10 ok 页面观察不到注入';
JS

probe V11 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/timing.html');
const r1 = await page.click('#no-nav');
const r2 = await page.click('#to-form2');
if (r1.navigation !== 'none') throw new Error('无关导航: ' + r1.navigation);
if (r2.navigation !== 'navigated') throw new Error('漏报导航: ' + r2.navigation);
return 'V11 ok';
JS

probe V12 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/upload-hidden.html');
const p = page.waitForEvent('fileChooser', { timeoutMs: 3000 });
await page.click('#pick');
const ev = await p;
if (!ev.backendNodeId) throw new Error('没有 backendNodeId: ' + JSON.stringify(ev));
return 'V12 ok ' + JSON.stringify(ev);
JS

probe V13 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/dialog.html');
await page.click('#alert');
try { await page.click('#confirm', { timeoutMs: 1500 }); throw new Error('未拦截'); }
catch (e) {
  if (e.code !== 'DIALOG_OPEN') throw new Error('code=' + e.code);
  if (!/acceptDialog/.test(e.message)) throw new Error('没给下一步: ' + e.message);
  return 'V13 ok';
}
JS

probe CLEANUP <<'JS'
await page.dismissDialog();
return 'cleanup ok';
JS

probe V14 <<'JS'
await page.goto('http://127.0.0.1:8899/cap/actionability.html');
try { await page.click('#never', { timeoutMs: 1200 }); throw new Error('不该成功'); }
catch (e) {
  if (e.code !== 'TIMEOUT') throw new Error('code=' + e.code);
  if (!/#1/.test(e.message)) throw new Error('没有重试历史');
  return 'V14 ok';
}
JS

echo "== V15 元素高亮：能看见、能清除、不动 DOM =="
#
# 不做截图：窗口离屏时 Chromium 的 captureScreenshot 会挂住/没有 surface，而回归必须
# 保持静默、不能为了截图把 Warren 抢到前台。这里直接验证 Overlay 命令拿到的节点几何、
# 高亮路径和清除命令，再确认 DOM 节点数没变——不依赖前台，也不产生视觉回归噪声。
V15=$($W exec cap 2>&1 <<'JS' | tail -1
await page.goto('http://127.0.0.1:8899/cap/net.html');
const before = await page.evaluate("document.querySelectorAll('*').length");
const doc = await page.cdp('DOM.getDocument', { depth: 1 });
const node = await page.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#btn' });
const target = await page.cdp('Overlay.getHighlightObjectForTest', { nodeId: node.nodeId, includeStyle: true });
const lit = await page.highlight('#btn');
await page.cdp('Overlay.hideHighlight');
const cleared = await page.highlight();
const after = await page.evaluate("document.querySelectorAll('*').length");
return JSON.stringify({
  before,
  after,
  lit,
  cleared,
  paths: target.highlight?.paths?.length ?? 0,
  role: target.highlight?.elementInfo?.accessibleRole ?? '',
});
JS
)
V15_OK=$(node -e '
const j = JSON.parse(process.argv[1]);
const r = j.lit?.rect;
const ok = j.lit?.highlighted === true && j.cleared?.highlighted === false &&
  r && r.width > 0 && r.height > 0 && j.paths > 0 && j.role === "button" && j.before === j.after;
console.log(ok ? "1" : "0");
' "$V15")
if [ "$V15_OK" = "1" ]; then
  echo "PASS V15 高亮命令可渲染且可清除 | $V15"
else
  echo "FAIL V15 | $V15"
fi
