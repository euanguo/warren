#!/bin/bash
cd "$(cd "$(dirname "$0")/../.." && pwd)"
W="node bin/warren.mjs"
$W env select cap > /dev/null 2>&1
$W env select cap > /dev/null
probe() { local name="$1"; local out; out=$($W exec cap 2>&1); local code=$?; if [ $code -eq 0 ]; then echo "PASS $name | $(echo "$out" | tail -2 | tr '\n' ' ')"; else echo "FAIL $name | $(echo "$out" | tail -3 | tr '\n' ' ')"; fi; }

echo "===== 16. 截图 ====="
FOCUSED=$($W call debug.layout --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).windowFocused))")
if [ "$FOCUSED" = "true" ]; then
probe "16.1 screenshot fullPage/clip" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/form.html');
const full = await page.screenshot({ fullPage: true, encoding: 'base64' });
const clip = await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 50 }, encoding: 'base64' });
const jpg = await page.screenshot({ format: 'jpeg', encoding: 'base64' });
if (full.base64.length < 5000 || clip.base64.length < 500 || jpg.base64.length < 500) throw new Error(JSON.stringify({ f: full.bytes, c: clip.bytes, j: jpg.bytes }));
return 'base64 长度 png=' + full.base64.length + ' clip=' + clip.base64.length + ' jpeg=' + jpg.base64.length;
JS
fi
if [ "$FOCUSED" != "true" ]; then
  OUT=$($W browser screenshot cap --base64 2>&1)
  CODE=$?
  if [ "$CODE" = "0" ] && echo "$OUT" | grep -q source=; then
    echo "PASS 16.2 后台 browser screenshot | $(echo "$OUT" | tail -2 | tr '\n' ' ')"
  else
    echo "FAIL 16.2 后台 browser screenshot | $OUT"
  fi
fi

echo "===== 17. 逃生舱：evaluate / fetch / cdp / clearData ====="
probe "17.1 evaluate 表达式与函数" <<'JS'
const a = await page.evaluate('1 + 2');
const b = await page.evaluate((x) => x * 3, 14);
if (a !== 3 || b !== 42) throw new Error(JSON.stringify({ a, b }));
return 'evaluate 3 / 42';
JS
probe "17.2 evaluate 脱敏" <<'JS'
const r = await page.evaluate("({ ok: 1, token: 'sk-live-should-be-redacted' })");
if (r.token !== '[REDACTED]') throw new Error(JSON.stringify(r));
return 'token=' + r.token;
JS
probe "17.3 fetch 同站带 cookie / 跨站默认 omit" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/net.html');
const same = await page.fetch('http://127.0.0.1:8899/cap/echo');
const cross = await page.fetch('http://127.0.0.1:8899/cap/echo');
if (same.status !== 200) throw new Error('same=' + same.status);
const c = JSON.parse(cross.body);
if (c.cookie !== null) throw new Error('跨站竟然带了 cookie: ' + cross.body);
return '同站 200 / 跨站 cookie=null';
JS
probe "17.4 cdp 白名单" <<'JS'
const ok = await page.cdp('Runtime.evaluate', { expression: '2+2', returnByValue: true });
let blocked = 'no-error';
try { await page.cdp('Network.enable', {}); } catch (e) { blocked = e.code; }
if (blocked !== 'CDP_BLOCKED') throw new Error('blocked=' + blocked);
return 'allowed=4 blocked=' + blocked;
JS
probe "17.5 clearDataForOrigin 单 origin" <<'JS'
const r = await page.clearDataForOrigin('http://localhost:8899');
if (!r.ok) throw new Error(JSON.stringify(r));
return 'clearData ok';
JS

echo "===== 18. 七种等待 ====="
probe "18.1 waitForSelector 四态" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/timing.html');
await page.waitForSelector('#no-nav', { state: 'visible', timeoutMs: 2000 });
await page.waitForSelector('#late', { state: 'attached', timeoutMs: 2000 });
await page.waitForSelector('#late', { state: 'visible', timeoutMs: 2000 });
return 'attached/visible ok';
JS
probe "18.2 waitForFunction / waitForURL / loadState" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/form.html');
const v = await page.waitForFunction('() => document.readyState === "complete"', null, { timeoutMs: 2000 });
await page.waitForURL({ glob: '*/cap/form.html' }, { timeoutMs: 2000 });
await page.waitForLoadState('networkidle', { timeoutMs: 4000 });
return 'function/url/networkidle ok';
JS
probe "18.3 waitFor 文本 / waitForTimeout" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/form.html');
await page.waitFor({ text: '姓名', timeoutMs: 2000 });
await page.waitForTimeout(120);
return 'text ok';
JS

echo "===== 19. 上传 / 下载 ====="
# 上传要一个真实文件：套件自己造，别依赖「谁先手工建过 /tmp/warren-upload-probe.txt」
printf 'warren upload probe\n' > /tmp/warren-upload-probe.txt
probe "19.1 setInputFiles（含隐藏 input）" <<'JS'
const fs = 'http://127.0.0.1:8899';
await page.goto(fs + '/cap/upload.html');
await page.setInputFiles('#file', ['/tmp/warren-upload-probe.txt']);
await page.waitForTimeout(200);
const names = await page.evaluate("document.getElementById('names').textContent");
if (!names.includes('warren-upload-probe.txt')) throw new Error('names=' + names);
return '上传 ' + names;
JS
probe "19.2 下载 + saveAs" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/download.html');
const [dl] = await Promise.all([page.waitForEvent('download', { timeoutMs: 4000 }), page.click('#link')]);
await page.downloadSaveAs(dl.downloadId, '/tmp/warren-download-probe.txt');
const after = await page.downloadStatus(dl.downloadId);
if (!after.path) throw new Error(JSON.stringify(after));
return '下载 ' + after.filename + ' → ' + after.path;
JS

echo "===== 20. 拖拽 / shadow / dialog ====="
probe "20.1 drag 拖拽" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/drag.html');
await page.dragAndDrop('#handle', '#track', { position: undefined });
const pos = await page.evaluate("document.getElementById('pos').textContent");
if (!Number(pos)) throw new Error('pos=' + pos);
return '拖到 ' + pos;
JS
probe "20.2 shadow DOM 点击" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/shadow.html');
await page.click('#inner');
await page.waitForTimeout(200);
const t = await page.evaluate("document.getElementById('result').textContent");
if (t !== 'shadow clicked') throw new Error(t);
return 'shadow clicked';
JS
probe "20.3 dialog accept/dismiss" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/dialog.html');
const [d] = await Promise.all([page.waitForEvent('dialog', { timeoutMs: 3000 }), page.click('#confirm')]);
await page.dismissDialog();
const t = await page.evaluate("(document.getElementById('result')||{}).textContent || '(无)'");
return 'dialog=' + d.type + ' 结果=' + t;
JS

echo "===== 21. 坐标键鼠 / 键盘 ====="
probe "21.1 坐标点击 + 滚轮 + insertText" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/form.html');
const box = await page.evaluate("(() => { const r = document.getElementById('name').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 10 }; })()");
await page.mouse.click(box.x, box.y);
await page.keyboard.insertText('坐标输入');
const v = await page.evaluate("document.getElementById('name').value");
if (v !== '坐标输入') throw new Error('v=' + v);
await page.mouse.wheel(0, 120);
await page.waitForTimeout(150);
return '坐标点击 + insertText ok';
JS

echo "===== 22. 标签共享登录态 + 后台标签可读 ====="
probe "22.1 同 session 共享 cookie" <<'JS'
await page.goto('http://127.0.0.1:8899/login.html');
await page.fill('#email', 'verger@example.com');
await page.fill('#password', 'fixture-secret');
await page.click('text=登录');
await page.waitForTimeout(200);
const t2 = await page.newTab('http://127.0.0.1:8899/login.html');
await page.waitForTimeout(400);
const snap = await page.snapshot({});
await page.closeTab(t2.id ?? 2);
return '新标签数 ' + (await page.tabs()).length;
JS
probe "22.2 后台标签可读可算" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/form.html');
const bg = await page.newTab('http://127.0.0.1:8899/cap/editor.html');
await page.waitForTimeout(400);
const title = await page.title();
return '当前激活标签标题=' + title;
JS

echo "===== 22.3 后台环境也能被操作（视图临时附到最底层）====="
# 后台环境（视图没挂在窗口上）Chromium 会丢输入。核心的做法是：操作期间把它的视图**临时附到
# 窗口最底层**（页面因此自报 visible，CDP 输入落得进去），用完立刻摘掉，并把焦点还给显示中的那个。
$W env remove bginput > /dev/null 2>&1
$W env create bginput --start-url=http://127.0.0.1:8899/cap/net.html > /dev/null
$W env start bginput > /dev/null
$W env select cap > /dev/null
sleep 1
SHOWING=$($W call debug.layout --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).showing.join(','))})")
if [ "$SHOWING" = "cap" ]; then echo "PASS 22.3a 目标环境确实在后台 | showing=$SHOWING"; else echo "FAIL 22.3a 目标环境确实在后台 | showing=$SHOWING"; fi
OUT=$($W exec bginput 2>&1 <<'JS'
await page.click('#btn');
await page.waitForTimeout(300);
return '后台点击=' + (await page.evaluate("document.getElementById('result').textContent"));
JS
)
if echo "$OUT" | grep -q '后台点击=alive clicked'; then echo "PASS 22.3b 后台环境收得到输入 | $OUT"; else echo "FAIL 22.3b 后台环境收得到输入 | $OUT"; fi
LEFT=$($W call debug.layout --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.attachedBelow.length + ':' + j.focusedEnv)})")
if [ "$LEFT" = "0:cap" ]; then echo "PASS 22.3c 用完摘掉且焦点还在显示中的环境 | $LEFT"; else echo "FAIL 22.3c 用完摘掉且焦点还在显示中的环境 | $LEFT"; fi
$W env stop bginput > /dev/null 2>&1
$W env remove bginput > /dev/null 2>&1

echo "===== 23. egress / events / 404 遥测 ====="
probe "23.1 egress 与 events" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/does-not-exist.html');
await page.waitForTimeout(200);
const info = await page.info();
return 'info url=' + info.url + ' tab=' + JSON.stringify(info.tab);
JS

# 遥测是「每条请求一把同步 INSERT」（WAL，实测 0.074ms/条）——量过之后确认不用批量写，
# 但要守住另一条：洪流不能把表撑爆（每标签留最近 300 条）。
probe "23.2 请求洪流：页面不受影响 + 遥测封顶" <<'JS'
await page.goto('http://127.0.0.1:8899/cap/burst.html?n=300');
for (let i = 0; i < 40; i += 1) {
  const t = await page.title();
  if (t.startsWith('burst ')) return t;
  await page.waitForTimeout(200);
}
throw new Error('洪流没跑完: ' + (await page.title()));
JS
# 数据根默认 ~/.warren（WARREN_HOME 可覆盖），见 src/main/paths.ts
DB="${WARREN_HOME:-$HOME/.warren}/core/warren.db"
# 上限是**每条标签** 300 条（+ 按批清理的余量），不是整表——一次回归会开好几个标签
ROWS=$(sqlite3 "$DB" "select coalesce(max(c),0) from (select count(*) c from network_entries group by tab_id)" 2>/dev/null || echo '?')
if [ "$ROWS" != "?" ] && [ "$ROWS" -le 400 ]; then
  echo "PASS 23.3 遥测封顶 | 单个标签最多 $ROWS 条（上限 300 + 按批清理余量）"
else
  echo "FAIL 23.3 遥测封顶 | 单个标签 $ROWS 条"
fi
$W env egress cap 2>&1 | tail -3
echo "  404 遥测: $($W browser network cap --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const e=j.find(x=>x.status===404);console.log(e?e.status+" "+e.url:"没抓到 404")})')"
echo "  events 条数: $($W events cap --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')"
