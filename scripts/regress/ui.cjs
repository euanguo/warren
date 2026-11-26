// UI 回归：用 debug.rendererEval 读 DOM + 驱动交互，逐项断言并打印 PASS/FAIL
const { execFileSync } = require('node:child_process');

function call(method, params = {}) {
  const out = execFileSync('node', ['bin/warren.mjs', 'call', method, JSON.stringify(params)], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}
const evalr = (script) => call('debug.rendererEval', { script }).value;
const layout = () => call('debug.layout');
const PROBES = {
  'ui-shell.js':
    "(() => {\n  const switcher = document.querySelector('[data-slot=\"space-switcher\"]');\n  const header = document.querySelector('[data-slot=\"app-header\"]');\n  const sw = switcher?.getBoundingClientRect();\n  const row = header?.getBoundingClientRect();\n  return {\n    rows: [...document.querySelectorAll('[data-slot=\"list-row\"]')].map((e) => e.textContent.trim().slice(0, 30)),\n    groups: [...document.querySelectorAll('[data-slot=\"sidebar-group-label\"]')].map((e) => e.textContent.trim()),\n    headerButtons: [...document.querySelectorAll('[data-slot=\"app-header\"] button[aria-label]')].map((e) => e.getAttribute('aria-label')),\n    envCapsule: (document.querySelector('[data-slot=\"env-capsule\"]')?.textContent || '').trim().slice(0, 40),\n    controlPillInPerson: !!document.querySelector('[data-slot=\"control-pill\"]'),\n    stage: !!document.querySelector('[data-slot=\"stage-placeholder\"]'),\n    spaces: [...document.querySelectorAll('[data-slot=\"space-switcher\"] [data-space]')].map((e) => ({ id: e.getAttribute('data-space'), active: e.getAttribute('data-active') })),\n    spaceSpacing: sw && row ? { top: sw.top - row.top, bottom: row.bottom - sw.bottom, height: sw.height } : null,\n  };\n})()\n",
  'ui-tabs.js':
    "(async () => {\n  const toggle = document.querySelector('[data-slot=\"inspector-toggle\"]');\n  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {\n    toggle.click();\n    await new Promise((r) => setTimeout(r, 350));\n  }\n  const out = {};\n  for (const name of ['事件', '快照', '控制台', '网络', '规则']) {\n    const t = [...document.querySelectorAll('[data-slot=\"tabs-trigger\"]')].find((e) => e.textContent.trim().startsWith(name));\n    if (!t) { out[name] = 'NO_TAB'; continue; }\n    t.click();\n    await new Promise((r) => setTimeout(r, 250));\n    const panel = [...document.querySelectorAll('[data-slot=\"tabs-content\"]')].find((e) => !e.hasAttribute('hidden'));\n    out[name] = (panel?.textContent || '').trim().slice(0, 50) || '(空)';\n  }\n  if (toggle && toggle.getAttribute('aria-expanded') === 'true') {\n    toggle.click();\n    await new Promise((r) => setTimeout(r, 250));\n  }\n  return out;\n})()\n",
  'ui-settings.js':
    "(async () => {\n  const btn = document.querySelector('[data-slot=\"settings-trigger\"]');\n  if (!btn) return 'NO_SETTINGS_BUTTON';\n  btn.click();\n  await new Promise((r) => setTimeout(r, 400));\n  const page = document.querySelector('[data-slot=\"settings-page\"]');\n  if (!page) return 'NO_SETTINGS_PAGE';\n  const sidebarKeptMounted = document.querySelectorAll('[data-slot=\"list-row\"]').length > 0;\n  const sections = [...page.querySelectorAll('[role=\"tab\"]')].map((e) => e.textContent.trim());\n  const out = { sections, sidebarKeptMounted, content: {} };\n  for (const name of sections) {\n    const t = [...page.querySelectorAll('[role=\"tab\"]')].find((e) => e.textContent.trim() === name);\n    t.click();\n    await new Promise((r) => setTimeout(r, 250));\n    const panel = [...page.querySelectorAll('[role=\"tabpanel\"]')].find((e) => !e.hasAttribute('hidden'));\n    out.content[name] = (panel?.textContent || '').trim().slice(0, 60) || '(空)';\n  }\n  document.querySelector('[data-slot=\"settings-back\"]')?.click();\n  await new Promise((r) => setTimeout(r, 300));\n  out.closed = !document.querySelector('[data-slot=\"settings-page\"]');\n  return out;\n})()\n",
  'ui-spaces.js':
    "(async () => {\n  const agent = document.querySelector('[data-slot=\"space-switcher\"] [data-space=\"agent\"]');\n  if (!agent) return 'NO_SWITCHER';\n  await window.envApi.tabCreate('cap', 'agent', 'http://127.0.0.1:8899/cap/form.html');\n  agent.click();\n  await new Promise((r) => setTimeout(r, 500));\n  return {\n    active: document.querySelector('[data-slot=\"space-switcher\"] [data-space=\"agent\"]')?.getAttribute('data-active'),\n    tabs: document.querySelectorAll('[data-slot=\"surface-tab\"]').length,\n    controlPill: (document.querySelector('[data-slot=\"control-pill\"]')?.textContent || '').trim(),\n  };\n})()\n",
  'ui-plugin.js':
    "(async () => {\n  const out = {};\n  document.querySelector('[data-slot=\"settings-trigger\"]')?.click();\n  await new Promise((r) => setTimeout(r, 350));\n  const navBtn = (label) => [...document.querySelectorAll('[data-slot=\"global-nav\"] button[aria-label]')].find((e) => e.getAttribute('aria-label') === label);\n  const notes = navBtn('记忆');\n  if (notes) {\n    notes.click();\n    await new Promise((r) => setTimeout(r, 450));\n    out.notesPage = !!document.querySelector('[data-slot=\"notes-page\"]');\n    out.notesText = (document.querySelector('[data-slot=\"notes-page\"]')?.textContent || '').trim().slice(0, 60);\n  } else out.notesPage = 'NO_NAV_ENTRY';\n  const accounts = navBtn('账号');\n  if (accounts) {\n    accounts.click();\n    await new Promise((r) => setTimeout(r, 450));\n    out.accountsPage = !!document.querySelector('[data-slot=\"account-manager-page\"]');\n    out.accountsWarning = !!document.querySelector('[data-slot=\"account-plaintext-warning\"]');\n  } else {\n    out.accountsPage = 'NO_NAV_ENTRY';\n    out.accountsWarning = false;\n  }\n  const broken = navBtn('坏插件');\n  if (broken) {\n    broken.click();\n    await new Promise((r) => setTimeout(r, 450));\n    out.brokenError = !!document.querySelector('[data-slot=\"plugin-surface-error\"]');\n    out.navStillThere = document.querySelectorAll('[data-slot=\"global-nav\"] button[aria-label]').length;\n  } else out.brokenError = 'NO_NAV_ENTRY';\n  document.querySelector('[data-slot=\"settings-back\"]')?.click();\n  await new Promise((r) => setTimeout(r, 300));\n  return out;\n})()\n",
};
const read = (f) => PROBES[f];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0,
  fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`PASS ${name} | ${detail}`);
  } else {
    fail++;
    console.log(`FAIL ${name} | ${detail}`);
  }
};

(async () => {
  const pluginCmd = (cmd, id) => execFileSync('node', ['bin/warren.mjs', 'plugin', cmd, id], { encoding: 'utf8' });
  pluginCmd('enable', 'com.example.broken');
  await sleep(800);
  execFileSync('node', ['bin/warren.mjs', 'env', 'start', 'cap'], { encoding: 'utf8', stdio: 'ignore' });
  execFileSync('node', ['bin/warren.mjs', 'env', 'select', 'cap'], { encoding: 'utf8', stdio: 'ignore' });
  await sleep(400);
  await evalr("window.envApi.spaceSelect('cap', 'person')");
  await sleep(500);

  const createdEnvs = [];
  const envCount = () =>
    JSON.parse(execFileSync('node', ['bin/warren.mjs', 'env', 'list', '--json'], { encoding: 'utf8' })).length;
  for (let i = envCount(); i < 7; i += 1) {
    const id = `uisetup${i}`;
    execFileSync('node', ['bin/warren.mjs', 'env', 'create', id], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    createdEnvs.push(id);
  }
  if (createdEnvs.length) await sleep(800);

  // 7 外壳（两层精密浏览器壳）
  const shell = await evalr(read('ui-shell.js'));
  check('7.1 侧栏列出环境行', shell.rows.length >= 7, `${shell.rows.length} 行: ${shell.rows.slice(0, 4).join(' / ')}`);
  check(
    '7.2 分组段头（含未分组）',
    shell.groups.some((g) => g.startsWith('未分组')),
    shell.groups.join(' / '),
  );
  check(
    '7.3 顶栏全局入口（无常驻 AppRail）',
    ['扩展与全局页', '设置'].every((l) => shell.headerButtons.includes(l)),
    shell.headerButtons.join(' / '),
  );
  check(
    '7.4 环境胶囊 + 页面占位区 + 我的空间零接管噪音',
    Boolean(shell.envCapsule) && shell.stage && shell.controlPillInPerson === false,
    `capsule="${shell.envCapsule}" stage=${shell.stage} controlPillInPerson=${shell.controlPillInPerson}`,
  );
  check(
    '7.5 Space 切换器',
    ['person', 'agent'].every((id) => shell.spaces.some((space) => space.id === id)),
    shell.spaces.map((space) => `${space.id}${space.active ? '*' : ''}`).join(' / '),
  );
  check(
    '7.5b Space 切换器上下留白一致',
    shell.spaceSpacing &&
      shell.spaceSpacing.top >= 2 &&
      shell.spaceSpacing.bottom >= 2 &&
      Math.abs(shell.spaceSpacing.top - shell.spaceSpacing.bottom) <= 2,
    JSON.stringify(shell.spaceSpacing),
  );

  const spaceUi = await evalr(read('ui-spaces.js'));
  const lockedAgent = layout();
  check(
    '7.6 切到 Agent Space 会锁定页面并显示上下文控制胶囊',
    spaceUi.active === 'true' &&
      spaceUi.tabs >= 1 &&
      Boolean(spaceUi.controlPill) &&
      lockedAgent.activeSpace === 'agent' &&
      lockedAgent.shieldAttached,
    `active=${spaceUi.active} tabs=${spaceUi.tabs} pill="${spaceUi.controlPill}" shield=${lockedAgent.shieldAttached}`,
  );
  await evalr(
    "(async () => { await window.envApi.takeover('cap', 'agent'); await new Promise((r) => setTimeout(r, 400)); return true; })()",
  );
  const takenAgent = layout();
  check(
    '7.7 接管 Agent Space 后解除锁定',
    takenAgent.activeSpace === 'agent' && takenAgent.owner === 'human' && !takenAgent.shieldAttached,
    `space=${takenAgent.activeSpace} owner=${takenAgent.owner} shield=${takenAgent.shieldAttached}`,
  );
  await evalr(
    "(async () => { await window.envApi.release('cap', 'agent'); await new Promise((r) => setTimeout(r, 400)); return true; })()",
  );
  const releasedAgent = layout();
  check(
    '7.8 交还后回到 Person Space',
    releasedAgent.activeSpace === 'person' && releasedAgent.owner === 'none',
    `space=${releasedAgent.activeSpace} owner=${releasedAgent.owner}`,
  );

  // 7.9 停机环境选中后中央展示启动 CTA
  const stoppedId = createdEnvs[0];
  if (stoppedId) {
    execFileSync('node', ['bin/warren.mjs', 'env', 'select', stoppedId], { encoding: 'utf8', stdio: 'ignore' });
    await sleep(400);
    const hasStartCta = await evalr('Boolean(document.querySelector(\'[data-slot="stage-start-button"]\'))');
    check('7.9 未启动环境中央直接展示启动按钮', hasStartCta === true, `env=${stoppedId} startCta=${hasStartCta}`);
    execFileSync('node', ['bin/warren.mjs', 'env', 'select', 'cap'], { encoding: 'utf8', stdio: 'ignore' });
    await sleep(400);
  }

  // 8 检查器分页
  const tabs = await evalr(read('ui-tabs.js'));
  for (const [name, content] of Object.entries(tabs)) {
    check(`8.${name} 分页有内容`, typeof content === 'string' && content !== 'NO_TAB' && content !== '(空)', content);
  }

  // 10 设置页（全局导航条 + 底层侧栏保活不卸载）
  const settings = await evalr(read('ui-settings.js'));
  check(
    '10.1 设置分节 + 侧栏保活不卸载',
    ['插件', 'Agent', '凭据'].every((s) => settings.sections.some((title) => title.includes(s))) &&
      settings.sidebarKeptMounted === true,
    `${settings.sections.join(' / ')} | sidebarKept=${settings.sidebarKeptMounted}`,
  );
  check(
    '10.2 每个分节都有内容',
    Object.values(settings.content).every((c) => c && c !== '(空)'),
    Object.entries(settings.content)
      .map(([k, v]) => `${k}:${v.slice(0, 12)}`)
      .join(' | '),
  );
  check('10.3 离开设置后换回环境工作台', settings.closed === true, `closed=${settings.closed}`);

  // 11 插件全屏页（经全局导航条切换）
  const plugin = await evalr(read('ui-plugin.js'));
  check('11.1 插件全屏页挂载（记忆）', plugin.notesPage === true, plugin.notesText);
  check(
    '11.2 账号管理页 + 明文警告',
    plugin.accountsPage === true && plugin.accountsWarning === true,
    `page=${plugin.accountsPage} warning=${plugin.accountsWarning}`,
  );
  check(
    '11.3 坏插件被隔离（不白屏）',
    plugin.brokenError === true && plugin.navStillThere >= 3,
    `surface-error=${plugin.brokenError} globalNav=${plugin.navStillThere}`,
  );

  pluginCmd('disable', 'com.example.broken');
  for (const id of createdEnvs) {
    try {
      execFileSync('node', ['bin/warren.mjs', 'env', 'remove', id], {
        encoding: 'utf8',
        stdio: 'ignore',
      });
    } catch {
      /* 已经没了 */
    }
  }
  console.log(`\nUI 小结: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
})();
