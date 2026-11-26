#!/usr/bin/env node
import { usageOf } from './commands.mjs';
import { createEmitResult, createExecSandbox, createPageApi, describeCapabilities } from './exec-runtime.mjs';
// warren —— Agent 的操作入口。形态参考 ego-browser：一次调用可以跑一整段脚本。
//
//   warren env list
//   warren env create alpha --proxy http://127.0.0.1:9001
//   warren env acquire alpha
//   warren exec alpha <<'JS'
//     await page.goto('https://example.com');
//     console.log(await page.title());
//   JS
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';

/*
 * 数据根：唯一来源是 `src/main/paths.ts` 的 `warrenHome()`，这里是它的**副本**。
 * 两边算不出同一个根，症状是「应用明明在跑却报没在跑」——所以改一处必须改两处。
 * 没做成共享模块是因为 CLI 要能独立拷贝出去用（打包后它旁边没有 src/）。
 */
const WARREN_HOME = process.env.WARREN_HOME
  ? path.resolve(process.env.WARREN_HOME)
  : path.join(os.homedir(), '.warren');
const RUNTIME_FILE = path.join(WARREN_HOME, 'runtime', 'runtime.json');

function readRuntime() {
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'));
  } catch {
    throw Object.assign(new Error('找不到运行中的核心。请先启动桌面端：npm start'), { code: 'CORE_NOT_RUNNING' });
  }
}

/*
 * **懒加载**：以前在模块顶层就读，于是 `warren help` 也要求应用在跑 ——
 * 干净机器上（CI 的静态门）`npm test` 里的 cli-help 用例必然全红。
 * 只有真要发 RPC 时才需要它。
 */
let runtime;
const runtimeInfo = () => (runtime ??= readRuntime());
let seq = 0;

const CALL_TIMEOUT_MS = Number(process.env.WARREN_TIMEOUT_MS ?? 60_000);

/**
 * 未处理的 Promise 拒绝。
 *
 * agent 脚本里 `const p = page.waitForEvent('download'); await page.click('#link'); await p;`
 * 是很自然的写法（HANDOFF 里的 fileChooser 例子就是这个形状）。如果事件在 click 期间就超时，
 * `p` 的拒绝发生在**还没人 await 它**的那一刻，Node 默认把进程连同一串 `file://` 裸栈打死，
 * agent 看到的是堆栈而不是错误码。
 * 这里统一成和别的错误一样的 `CODE: message`（代价是「先拒绝、后 catch」的脚本会提前退出，
 * 但 Node 默认行为本来也是退出，只是没有可读信息）。
 */
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(`${error.code ?? 'ERROR'}: ${error.message}`);
  process.exit(1);
});

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    let info;
    try {
      info = runtimeInfo();
    } catch (error) {
      reject(error);
      return;
    }
    const socket = net.connect(info.socketPath);
    let buffer = '';
    const id = String(++seq);
    // 没有超时的话，一个卡住的页面调用会把 agent 永久挂死
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`RPC 超时 ${CALL_TIMEOUT_MS}ms: ${method}`), { code: 'TIMEOUT' }));
    }, CALL_TIMEOUT_MS);
    const done = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };
    socket.on('connect', () => socket.write(JSON.stringify({ id, token: info.token, method, params }) + '\n'));
    socket.on(
      'data',
      done((chunk) => {
        buffer += chunk.toString('utf8');
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        let message;
        try {
          message = JSON.parse(buffer.slice(0, index));
        } catch {
          // 守护进程给了半截或坏掉的响应：当成协议错误，别让 CLI 崩在解析上
          socket.end();
          reject(Object.assign(new Error('RPC 响应不是合法 JSON'), { code: 'BAD_RESPONSE' }));
          return;
        }
        socket.end();
        if (message.ok) resolve(message.result);
        else
          reject(
            Object.assign(new Error(message.error.message), {
              code: message.error.code,
              // lease 类错误的原因（expired / never_leased / superseded / user_takeover / wrong_space）
              reason: message.error.reason,
              expiredAt: message.error.expiredAt,
            }),
          );
      }),
    );
    socket.on('error', done(reject));
  });
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      // 只按**第一个** `=` 切：值里带 `=` 很常见（`--response-header=a=b`、JSON 值）
      const eq = arg.indexOf('=');
      const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq < 0 ? undefined : arg.slice(eq + 1);
      const value = inline !== undefined ? inline : args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      // 同一个 flag 出现多次时收成数组（网络规则要一次给多个头）
      if (key in flags) flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
      else flags[key] = value;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 打印结果。
 *
 * `format` 必须由调用方显式给出——不同命令的数组元素形状完全不同
 * （环境 / 事件 / 插件），给一个通用 formatter 会让所有数组都套上环境的字段，
 * 输出看着有内容其实全是 undefined。没给 formatter 就逐条打 JSON，
 * 宁可难看也不能撒谎。
 */
function print(value, asJson, format) {
  if (asJson) return console.log(JSON.stringify(value, null, 2));
  if (Array.isArray(value)) {
    if (value.length === 0) return console.log('(空)');
    for (const item of value) console.log(format ? format(item) : JSON.stringify(item));
    return;
  }
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function formatEnvLine(env) {
  // 页面加载失败的环境仍然是 running（视图、标签都在），用 ! 把它和健康的 ● 分开
  const flag = env.error ? '!' : env.status === 'running' ? '●' : '○';
  const owner = env.owner === 'none' ? '' : `  [${env.owner}]`;
  const err = env.error ? `  页面加载失败: ${env.error}` : '';
  return `${flag} ${String(env.id).padEnd(20)} ${String(env.proxy || '直连').padEnd(30)} ${env.title || env.currentUrl || '—'}${owner}${err}`;
}

function formatEventLine(event) {
  const at = String(event.createdAt ?? '').slice(11, 19);
  const env = event.environmentId ? ` ${String(event.environmentId).padEnd(14)}` : ` ${''.padEnd(14)}`;
  return `${at}  ${String(event.actor ?? '?').padEnd(6)}${env} ${event.message}`;
}

function formatPluginLine(plugin) {
  const flag = plugin.enabled ? '●' : '○';
  const pending = plugin.needsConfirmation?.length ? `  待确认: ${plugin.needsConfirmation.join(', ')}` : '';
  const runtime = plugin.runtime === 'host' ? 'host' : 'sandbox';
  const status = plugin.status ? ` [${plugin.status}]` : '';
  const surfaces = plugin.contributes?.surfaces?.length
    ? `  界面: ${plugin.contributes.surfaces.map((s) => s.kind + '/' + s.id).join(', ')}`
    : '';
  const source = plugin.source
    ? `\n  ${plugin.packageName} · ${plugin.source}${plugin.resolved ? ` · ${plugin.resolved}` : ''}`
    : '';
  return `${flag} ${String(plugin.id).padEnd(24)} v${String(plugin.version).padEnd(8)} ${runtime.padEnd(8)}${status.padEnd(20)} ${plugin.name}${pending}${surfaces}${source}`;
}

function formatPluginLogLine(entry) {
  return `${entry.at}  ${String(entry.level).toUpperCase().padEnd(5)} ${entry.message}`;
}

/**
 * 跨插件列命令用的一行。
 *
 * 为什么要有它：`plugin run <id> --help` 只看得见**一个**插件的命令，
 * agent 得先知道插件 id 才问得出来。这一条把「有哪些插件、各自有什么命令」
 * 一次摊平，agent 不用先猜再问。
 */
function formatPluginCommandLine(entry) {
  return `${String(entry.pluginId).padEnd(24)} ${String(entry.name).padEnd(20)} ${entry.summary ?? ''}`;
}

/**
 * 生成一个能跑的最小插件包：`package.json` + `server.js`。
 *
 * **只生成这两个** —— 前端 bundle（`app`）和 host 运行时都是可选的，
 * 骨架里带上只会让人以为必须写。命令名 `hello` 是留给人改的。
 */
function scaffoldPlugin(id, name) {
  const packageName = `warren-plugin-${String(id).split('.').at(-1)}`;
  const pkg = {
    name: packageName,
    version: '0.1.0',
    description: `${name} 插件`,
    warren: {
      id,
      name,
      apiVersion: '4',
      runtime: 'sandbox',
      server: 'server.js',
      engines: { warren: '>=0.1.0' },
      permissions: ['environment.read'],
      contributes: {
        commands: [{ name: 'hello', summary: '示例命令：回显当前环境' }],
      },
    },
  };
  const server = `/**
 * ${name} 插件。
 *
 * \`ctx.host\` 上是 host API（受 package.json#warren.permissions 门控），
 * \`ctx.input\` 是 CLI 传进来的 --input，\`ctx.environmentId\` 是当前环境。
 * 完整能力面看 warren 的 docs/PLUGIN-CAPABILITY-DESIGN.md。
 */
module.exports = {
  async activate(ctx) {
    await ctx.host.log.info('${id} activated');
  },

  async hello(ctx) {
    const environments = await ctx.host.environment.list();
    await ctx.host.log.info(\`看到 \${environments.length} 个环境\`);
    return { environmentId: ctx.environmentId ?? null, input: ctx.input ?? null, environments: environments.length };
  },
};
`;
  return { packageJson: JSON.stringify(pkg, null, 2) + '\n', server };
}

function formatGroupLine(group) {
  const flag = group.collapsed ? '▸' : '▾';
  return `${flag} ${String(group.id).padEnd(20)} ${String(group.name).padEnd(16)} order=${group.order}`;
}

function formatTabLine(tab) {
  const flag = tab.active ? '●' : '○';
  const loading = tab.loading ? '↻' : ' ';
  return `${flag}${loading} ${String(tab.index + 1).padStart(2)}  ${String(tab.title || '—')
    .slice(0, 36)
    .padEnd(36)} ${tab.url}`;
}

function formatNetActionLine(action) {
  switch (action.type) {
    case 'mock':
      return `mock ${action.status} ${action.contentType ?? 'application/json'} ${action.body.length}B`;
    case 'block':
      return 'block';
    case 'redirect':
      return `redirect ${action.to}`;
    case 'delay':
      return `delay ${action.ms}ms`;
    case 'setRequestHeaders':
      return `req-headers ${Object.keys(action.headers).join(',')}`;
    case 'setResponseHeaders':
      return `res-headers ${Object.keys(action.headers).join(',')}`;
    case 'passthrough':
      return 'passthrough（放行）';
    default:
      return String(action.type);
  }
}

function formatNetRuleLine(rule) {
  const flag = rule.enabled ? '●' : '○';
  const method = rule.match.method ?? '*';
  const pattern = `${rule.match.url}${rule.match.isRegex ? ' (regex)' : ''}`;
  const ttl = rule.expiresAt ? ` (剩 ${Math.max(0, Math.round((rule.expiresAt - Date.now()) / 1000))}s)` : '';
  return `${flag} ${String(rule.id).padEnd(36)} prio=${String(rule.priority ?? 0).padEnd(4)} ${method.padEnd(6)} ${pattern}  → ${formatNetActionLine(rule.action)}${ttl}`;
}

/**
 * `--input='{"k":1}'` 的解析。坏 JSON 直接报错退出——静默当 undefined 会让插件收到
 * 一个"没有参数"的调用，报的错跟参数没关系，最难查。
 */
function parseInputFlag(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error(`--input 不是合法 JSON: ${error.message}`);
    process.exit(1);
  }
}

/**
 * `--for=30s` 的解析。
 *
 * 认不出来就报错退出，**不静默退回默认值**——「我说放行 30 分钟，结果只放了 30 秒」
 * 是最难查的那类偏差。
 */
function parseDuration(value) {
  if (value === undefined) return 30_000;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value).trim());
  if (!match) {
    console.error(`--for 认不出来: ${value}（要 30s / 5m / 5000ms）`);
    process.exit(1);
  }
  const scale = match[2] === 'ms' ? 1 : match[2] === 'm' ? 60_000 : 1000;
  return Math.round(Number(match[1]) * scale);
}

function formatNetHitLine(hit) {
  const at = String(hit.at ?? '').slice(11, 19);
  const rule = hit.ruleId ? ` [${String(hit.ruleId).slice(0, 8)}]` : '';
  const note = hit.note ? `  (${hit.note})` : '';
  return `${at}  ${String(hit.status).padEnd(4)} ${String(hit.method).padEnd(6)} ${String(hit.action).padEnd(18)}${rule} ${hit.url}${note}`;
}

/**
 * `net rule add` 的动作：从 flag 推出来。
 * 一个动作 flag 都不给（或给了多个）就报错——静默建一条什么都不做的规则，比报错难查得多。
 */
function headerFlags(value) {
  const list = Array.isArray(value) ? value : [value];
  const headers = {};
  for (const item of list) {
    const text = String(item);
    const at = text.indexOf('=');
    if (at <= 0) throw Object.assign(new Error(`头要写成 k=v：${text}`), { code: 'BAD_REQUEST' });
    headers[text.slice(0, at).trim()] = text.slice(at + 1).trim();
  }
  return headers;
}

function netActionFromFlags(flags) {
  const actions = [];
  if (typeof flags.mock === 'string') {
    actions.push({
      type: 'mock',
      status: flags.status === undefined ? 200 : Number(flags.status),
      body: flags.mock,
      contentType: typeof flags['content-type'] === 'string' ? flags['content-type'] : undefined,
    });
  }
  if (flags.block) actions.push({ type: 'block' });
  if (typeof flags.redirect === 'string') actions.push({ type: 'redirect', to: flags.redirect });
  if (typeof flags.delay === 'string') actions.push({ type: 'delay', ms: Number(flags.delay) });
  if (flags['request-header'] !== undefined) {
    actions.push({ type: 'setRequestHeaders', headers: headerFlags(flags['request-header']) });
  }
  if (flags['response-header'] !== undefined) {
    actions.push({ type: 'setResponseHeaders', headers: headerFlags(flags['response-header']) });
  }
  if (actions.length === 0) {
    throw Object.assign(
      new Error(
        '要给一个动作：--mock=\'{"id":1}\' | --block | --redirect=/new | --delay=2000 | --request-header=k=v | --response-header=k=v',
      ),
      { code: 'BAD_REQUEST' },
    );
  }
  if (actions.length > 1) {
    throw Object.assign(new Error(`一条规则只能有一个动作，给了 ${actions.map((a) => a.type).join(', ')}`), {
      code: 'BAD_REQUEST',
    });
  }
  return actions[0];
}

/**
 * 续租。主进程的 lease TTL 是 60s，而一段脚本可能跑几分钟——不续租的话，
 * 从第 60 秒起每个写操作都会报 ENV_NOT_LEASED。
 * 返回停止函数（用完必须调，否则定时器会拖着进程不退出）。
 */
function startLeaseRenewer(environmentId, expiresAt) {
  let stopped = false;
  let timer;
  const schedule = (until) => {
    // TTL 过半时续一次；`unref` 让定时器不阻止进程退出
    const delay = Math.max(1000, Math.floor((until - Date.now()) / 2));
    timer = setTimeout(() => {
      void call('env.acquire', { id: environmentId, label: 'warren renew' })
        .then((lease) => {
          if (!stopped) schedule(lease.leaseExpiresAt ?? Date.now() + 60_000);
        })
        .catch((error) => {
          /*
           * 续租失败以前是**静默**的，症状是脚本跑到第 60 秒开始每个写操作都报 ENV_NOT_LEASED，
           * 看起来像「Warren 随机丢租约」。这里至少打一次原因：过期 / 被顶掉 / 被人接管各不一样。
           */
          stopped = true;
          const reason = error?.reason ? `（reason=${error.reason}）` : '';
          console.error(
            `续租失败${reason}：${error?.code ?? 'ERROR'}: ${error?.message ?? error}；` +
              `脚本可以继续跑，但写操作会失败，先重新取控制权：warren env acquire ${environmentId}`,
          );
        });
    }, delay);
    timer.unref?.();
  };
  schedule(expiresAt ?? Date.now() + 60_000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * 带 lease 跑一段操作：没给 --lease 就自己取一个，完事还回去。
 * 标签的增删改和页面导航一样是写操作，不能在人持控制权时偷做。
 */
async function withLease(environmentId, flags, label, fn) {
  let leaseId = typeof flags.lease === 'string' ? flags.lease : undefined;
  const auto = !leaseId;
  let stopRenewer = () => {};
  if (auto) {
    const lease = await call('env.acquire', { id: environmentId, label });
    leaseId = lease.leaseId;
    stopRenewer = startLeaseRenewer(environmentId, lease.leaseExpiresAt);
  }
  try {
    return await fn(leaseId);
  } finally {
    stopRenewer();
    // 必须 await：process.on('exit') 里发不出异步请求，会漏 lease
    if (auto) await call('env.release', { id: environmentId, leaseId }).catch(() => {});
  }
}

/**
 * 取控制权。`--wait=ms` 时轮询到拿到为止——人正持着控制权时，
 * agent 不该直接失败退出，而是原地等（对应 Ego 的 `waitForControl`）。
 */
async function acquire(environmentId, flags) {
  // `--wait=5000` 是等 5 秒；裸写 `--wait` 给一个默认值，不然会被当成「不等」静默失败
  const waitMs = typeof flags.wait === 'string' ? Number(flags.wait) : flags.wait === true ? 30_000 : 0;
  const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : 0);
  for (;;) {
    try {
      return await call('env.acquire', { id: environmentId, label: flags.label });
    } catch (error) {
      const retryable = error.code === 'ENV_BUSY' && Date.now() < deadline;
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * 给 Agent 的 page 对象。所有写操作都带环境 ID 和 lease。
 *
 * `tabRef` 缺省时后端作用于该环境**当前激活的标签** —— 人和 agent 看的是
 * 同一个页面实例（PRD 第一条），所以大多数时候不需要指定。
 *
 * 形状定义在 `bin/exec-runtime.mjs`：**exec 里有什么只有那一份**，
 * `warren exec --capabilities` 也是从同一份实例反射出来的。
 */
function makePage(environmentId, leaseId, tabRef) {
  return createPageApi(call, { environmentId, leaseId, tabRef });
}

const [, , ...argvRest] = process.argv;
const { flags, rest: args } = parseFlags(argvRest);
/**
 * `shot diff` 的行格式。
 *
 * 只比 SHA-256，**不逐像素** —— 实测同一页面连截三次字节完全相同（见
 * docs/EXECUTION-PLAN-2026-10-17.md 批次 6），所以哈希足够回答「改了 CSS 之后页面变了吗」。
 * 真要逐像素再说，那要引图像库，先不加。
 */
const formatShotDiffLine = (item) =>
  [
    item.same ? '两张图**完全相同**' : '两张图**不同**',
    `  a: ${item.a.bytes} 字节 sha256=${item.a.sha256.slice(0, 16)}  ${item.a.path}`,
    `  b: ${item.b.bytes} 字节 sha256=${item.b.sha256.slice(0, 16)}  ${item.b.path}`,
  ].join('\n');

const formatScreenshotLine = (item) =>
  [
    `${item.format} ${item.bytes} 字节 sha256=${String(item.sha256).slice(0, 16)}${item.source ? ` source=${item.source}` : ''}`,
    item.path ? `  ${item.path}` : '  （未落盘；显式 --base64 时返回内容）',
  ].join('\n');

const formatNetRecordLine = (item) =>
  item.recording
    ? `录制中 · 已录 ${item.entries} 条`
    : [
        `录制结束 · ${item.entries} 条`,
        item.path ? `  ${item.bytes} 字节 sha256=${String(item.sha256).slice(0, 16)}` : '',
        item.path ? `  ${item.path}` : '',
      ]
        .filter(Boolean)
        .join('\n');

const formatEvidenceLine = (item) =>
  [`证据包 · ${item.files.length} 个文件`, `  ${item.dir}`, ...item.files.map((file) => `  ${file.path}`)].join('\n');

const formatDoctorLine = (item) => {
  const checks = Array.isArray(item.checks) ? item.checks : [];
  return [
    `预检 ${item.ok ? '通过' : '有阻断'} · ${item.environmentId}`,
    ...checks.map((check) => {
      const mark = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '×';
      return `  ${mark} ${check.id}: ${check.message}${check.hint ? ` → ${check.hint}` : ''}`;
    }),
  ].join('\n');
};

/** `net body` 的行格式：给人看时正文单独成段，别挤成一行 JSON。 */
const formatNetBodyLine = (item) =>
  [
    `${item.status} ${item.contentType ?? ''} ${item.url}`.trim(),
    item.redacted ? '（已按敏感词脱敏）' : '（**未脱敏**：响应不是 JSON，没法按 key 脱敏，自己看仔细）',
    item.body,
  ].join('\n');

/** `extension list` 的行格式。**每个返回数组的命令都要有自己的 formatter**（见 AGENTS 已知问题 1）。 */
const formatExtensionLine = (item) => `${item.id}  ${item.dir}`;

const group = args[0];
const sub = args[1];
const asJson = Boolean(flags.json);

try {
  if (group === 'env') {
    const id = args[2];
    switch (sub) {
      case 'list':
        print(await call('env.list'), asJson, formatEnvLine);
        break;
      case 'create':
        print(
          await call('env.create', {
            id: id ?? flags.id,
            proxy: typeof flags.proxy === 'string' ? flags.proxy : undefined,
            startUrl: typeof flags['start-url'] === 'string' ? flags['start-url'] : undefined,
            // `--headed=false` = 启动后不把界面切过去（批量拉起环境时用）
            headed: flags.headed === undefined ? undefined : flags.headed !== 'false',
          }),
          asJson,
        );
        break;
      case 'start':
        print(await call('env.start', { id }), asJson);
        break;
      case 'stop':
        print(await call('env.stop', { id }), asJson);
        break;
      case 'hibernate':
        print(await call('env.hibernate', { id }), asJson);
        break;
      case 'wake':
        print(await call('env.wake', { id }), asJson);
        break;
      case 'remove':
        print(await call('env.remove', { id }), asJson);
        break;
      case 'update': {
        // 改名 / 换代理 / 换启动 URL。RPC 早就有（界面改名走它），CLI 一直没暴露
        // ——PRD §8.1 里写着 `env update`，对不上就是文档在撒谎
        const patch = {
          name: typeof flags.name === 'string' ? flags.name : undefined,
          proxy: typeof flags.proxy === 'string' ? flags.proxy : undefined,
          // `--trusted-ca=none` 解绑：null 是「清掉」，undefined 才是「不改」
          trustedCa:
            flags['trusted-ca'] === undefined ? undefined : flags['trusted-ca'] === 'none' ? null : flags['trusted-ca'],
          startUrl: typeof flags['start-url'] === 'string' ? flags['start-url'] : undefined,
          headed: flags.headed === undefined ? undefined : flags.headed !== 'false',
        };
        if (Object.values(patch).every((v) => v === undefined)) {
          console.error(
            '用法: warren env update <env> [--name=<新名字>] [--proxy=<url|none>] [--trusted-ca=<pem路径|none>] [--start-url=<url>] [--headed=false]',
          );
          process.exit(1);
        }
        print(await call('env.update', { id, ...patch }), asJson);
        break;
      }
      case 'select':
        print(await call('env.select', { id }), asJson);
        break;
      case 'acquire':
        print(await acquire(id, flags), asJson);
        break;
      case 'renew':
        print(await call('env.renew', { id, leaseId: flags.lease }), asJson);
        break;
      case 'release':
        print(await call('env.release', { id, leaseId: flags.lease }), asJson);
        break;
      case 'takeover':
        print(await call('env.takeover', { id }), asJson);
        break;
      case 'egress':
        print(await call('env.egress', { id }), asJson);
        break;
      case 'doctor':
        print(
          await call('env.doctor', {
            id,
            localPorts: typeof flags.ports === 'string' ? flags.ports.split(',').map(Number) : undefined,
          }),
          asJson,
          formatDoctorLine,
        );
        break;
      case 'move':
        // --group=none 显式移出分组；不给则报错，避免"以为移了其实没动"
        if (typeof flags.group !== 'string') {
          console.error('用法: warren env move <env> --group=<分组ID|none>');
          process.exit(1);
        }
        print(
          await call('env.moveToGroup', {
            id,
            groupId: flags.group === 'none' ? undefined : flags.group,
          }),
          asJson,
        );
        break;
      case 'reorder': {
        const ids = args.slice(3);
        if (ids.length === 0) {
          console.error('用法: warren env reorder --group=<分组ID|none> <env-id...>');
          process.exit(1);
        }
        print(
          await call('env.reorder', {
            groupId: flags.group === 'none' || flags.group === undefined ? undefined : flags.group,
            ids,
          }),
          asJson,
        );
        break;
      }
      default:
        console.error(usageOf('env'));
        process.exit(1);
    }
  } else if (group === 'group') {
    switch (sub) {
      case 'list':
        print(await call('group.list'), asJson, formatGroupLine);
        break;
      case 'create':
        print(await call('group.create', { name: args.slice(2).join(' ') }), asJson);
        break;
      case 'rename':
        print(await call('group.rename', { id: args[2], name: args.slice(3).join(' ') }), asJson);
        break;
      case 'remove':
        print(await call('group.remove', { id: args[2] }), asJson);
        break;
      case 'collapse':
        print(await call('group.collapse', { id: args[2], collapsed: !flags.expand }), asJson);
        break;
      default:
        console.error(usageOf('group'));
        process.exit(1);
    }
  } else if (group === 'events') {
    print(await call('events.list', { environmentId: args[1] }), asJson, formatEventLine);
  } else if (group === 'vault') {
    switch (sub) {
      case 'list':
        print(await call('vault.list'), true);
        break;
      case 'add': {
        // 秘密从 stdin 读，不走 argv —— 否则会出现在 ps 和 shell history 里
        const raw = await readStdin();
        if (!raw.trim()) {
          console.error(
            '用法: echo \'{"username":"a@b.com","password":"..."}\' | warren vault add <provider> --label=<name>',
          );
          process.exit(1);
        }
        print(
          await call('vault.add', {
            provider: args[2],
            label: typeof flags.label === 'string' ? flags.label : '',
            secret: JSON.parse(raw),
          }),
          true,
        );
        break;
      }
      case 'remove':
        print(await call('vault.remove', { ref: args[2] }), true);
        break;
      case 'fill': {
        const environmentId = typeof flags.env === 'string' ? flags.env : '';
        let leaseId = typeof flags.lease === 'string' ? flags.lease : undefined;
        const autoLease = !leaseId;
        let stopRenewer = () => {};
        if (autoLease) {
          const lease = await call('env.acquire', {
            id: environmentId,
            label: 'warren vault fill',
          });
          leaseId = lease.leaseId;
          stopRenewer = startLeaseRenewer(environmentId, lease.leaseExpiresAt);
        }
        try {
          print(
            await call('vault.fill', {
              id: environmentId,
              leaseId,
              ref: args[2],
              field: typeof flags.field === 'string' ? flags.field : 'password',
              target: flags.target
                ? JSON.parse(String(flags.target))
                : { kind: 'selector', selector: 'input[type=password]' },
              // 域名名单：逗号分隔的裸 host，子域继承；不传 = 不限（老行为）
              allowedDomains:
                typeof flags.domains === 'string'
                  ? flags.domains
                      .split(',')
                      .map((d) => d.trim())
                      .filter(Boolean)
                  : undefined,
            }),
            true,
          );
        } finally {
          stopRenewer();
          if (autoLease) await call('env.release', { id: environmentId, leaseId }).catch(() => {});
        }
        break;
      }
      default:
        console.error(usageOf('vault'));
        process.exit(1);
    }
  } else if (group === 'plugin') {
    switch (sub) {
      case 'list':
        print(await call('plugin.list'), asJson, formatPluginLine);
        break;
      case 'install':
        if (!args[2]) {
          console.error('用法: warren plugin install <path:目录|npm:包名[@版本]|git:仓库#ref>');
          process.exit(1);
        }
        print(await call('plugin.install', { source: args[2] }), asJson);
        break;
      case 'update':
        print(await call('plugin.update', { id: args[2] }), asJson);
        break;
      /*
       * 脚手架。**本地写文件，不走 RPC** —— 目标目录由调用方给，
       * 没必要让应用去碰用户的开发目录。
       */
      case 'create': {
        const id = args[2];
        if (!id || !/^[a-z0-9][a-z0-9.-]*$/.test(id)) {
          console.error('用法: warren plugin create <id> [--dir=路径] [--name=显示名]');
          console.error('  id 只能用小写字母、数字、点、连字符，例如 com.acme.notes');
          process.exit(1);
        }
        const dir = path.resolve(typeof flags.dir === 'string' ? flags.dir : `./${id}`);
        const name = typeof flags.name === 'string' ? flags.name : id;
        if (existsSync(dir)) {
          console.error(`目录已存在，不覆盖: ${dir}`);
          process.exit(1);
        }
        const files = scaffoldPlugin(id, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'package.json'), files.packageJson);
        writeFileSync(path.join(dir, 'server.js'), files.server);
        console.log(`已生成插件骨架: ${dir}`);
        console.log(`  package.json    id=${id} name=${name}`);
        console.log('  server.js       一个 hello 命令，改它');
        console.log(`下一步: warren plugin install path:${dir} && warren plugin enable ${id}`);
        break;
      }
      case 'enable':
        print(await call('plugin.enable', { id: args[2] }), asJson);
        break;
      case 'disable':
        print(await call('plugin.disable', { id: args[2] }), asJson);
        break;
      case 'uninstall':
        print(await call('plugin.uninstall', { id: args[2] }), asJson);
        break;
      case 'grant':
        print(await call('plugin.grant', { id: args[2], permissions: args.slice(3) }), asJson);
        break;
      case 'reload':
        print(await call('plugin.reload', { id: args[2] }), asJson);
        break;
      case 'status': {
        const plugins = await call('plugin.list');
        const wanted = args[2] ? plugins.filter((plugin) => plugin.id === args[2]) : plugins;
        if (!wanted.length) {
          console.error(`没有插件 ${args[2]}`);
          process.exit(1);
        }
        print(wanted, asJson, formatPluginLine);
        break;
      }
      case 'logs':
        print(await call('plugin.logs', { id: args[2], limit: Number(flags.n ?? 50) }), asJson, formatPluginLogLine);
        break;
      /*
       * 跨插件列命令。`plugin run <id> --help` 只看得见一个插件，agent 得先知道 id；
       * 这一条把「装了哪些插件、各自注册了什么命令」一次摊平。
       */
      case 'commands': {
        const plugins = await call('plugin.list');
        const rows = plugins.flatMap((plugin) =>
          (plugin.contributes?.commands ?? []).map((command) => ({
            pluginId: plugin.id,
            plugin: plugin.name,
            enabled: plugin.enabled,
            status: plugin.status,
            name: command.name,
            summary: command.summary,
          })),
        );
        if (!rows.length) {
          console.log('没有插件注册命令。');
          break;
        }
        print(rows, asJson, formatPluginCommandLine);
        break;
      }
      case 'config':
        if (args[3] === 'set') {
          print(await call('plugin.config.set', { id: args[2], key: args[4], value: args[5] }), asJson);
          break;
        }
        print(await call('plugin.list'), asJson, formatPluginLine);
        break;
      case 'run': {
        const id = args[2];
        const command = args[3];
        // `--help` 不是命令参数，别让它漏进 --input 解析或插件入参
        for (let i = args.length - 1; i >= 2; i -= 1) {
          if (args[i] === '--help' || args[i] === '-h') args.splice(i, 1);
        }
        // --help / 没给命令：从清单里的 contributes.commands 生成说明，别让 agent 猜
        if (!id || command === '--help' || command === '-h') {
          // 没连实例时也要能看帮助：报一句「连不上」再退出 0，不要因为探不到插件就退出 1。
          let plugins = [];
          let offline = '';
          try {
            plugins = await call('plugin.list');
          } catch (error) {
            offline = `（当前连不上 Warren 实例，未列出已安装插件：${error?.code ?? error?.message ?? error}）`;
          }
          if (!id) {
            console.log(offline ? '已安装插件的命令：' + offline : '已安装插件的命令：');
            for (const plugin of plugins) {
              const commands = plugin.contributes?.commands?.length
                ? plugin.contributes.commands.map((item) => item.name).join(', ')
                : '（无）';
              console.log(`  ${plugin.id.padEnd(24)} ${plugin.name.padEnd(20)} ${commands}`);
            }
            console.log('');
            console.log(
              '用法: warren plugin run <id> <command> [--env <环境>] [--input=\'{"k":1}\'] [--lease=<leaseId>]',
            );
            process.exit(0);
          }
        }
        // 任意位置出现 --help 都只打印帮助：否则 `plugin run <id> <cmd> --help`
        // 会真的执行那个命令（实测 fork 直接起了一个实例）。
        // 注意 `--help` 会被 parseFlags 收进 flags，`args` 里已经看不到它了。
        const wantsHelp = Boolean(flags.help) || Boolean(flags.h);
        if (!command || command === '--help' || command === '-h' || wantsHelp) {
          let offline = '';
          const plugins = await call('plugin.list').catch((error) => {
            offline = `（当前连不上 Warren 实例，未能读取插件清单：${error?.code ?? error?.message ?? error}）`;
            return [];
          });
          if (offline) {
            if (wantsHelp && command && command !== '--help' && command !== '-h') {
              console.log(`${id} ${command}`);
              console.log(`  ${offline}`);
              console.log('');
              console.log('用法: warren plugin run ' + id + ' ' + command + ' [--env <环境>] [--input=\'{"k":1}\']');
              console.log('');
              console.log('（--help 只打印帮助，不执行命令）');
              process.exit(0);
            }
            console.log(`${id}  ${offline}`);
            console.log(
              '用法: warren plugin run ' + id + ' <command> [--env <环境>] [--input=\'{"k":1}\'] [--lease=<leaseId>]',
            );
            process.exit(command ? 0 : 1);
          }
          const plugin = plugins.find((item) => item.id === id);
          if (!plugin) {
            console.error(`没有插件 ${id}`);
            process.exit(1);
          }
          if (wantsHelp && command && command !== '--help' && command !== '-h') {
            const found = (plugin.contributes?.commands ?? []).find((item) => item.name === command);
            if (!found) {
              console.error(
                `插件 ${id} 没有命令 ${command}；可用：${(plugin.contributes?.commands ?? []).map((c) => c.name).join(', ')}`,
              );
              process.exit(1);
            }
            console.log(`${plugin.id} ${found.name}`);
            console.log(`  ${found.summary ?? ''}`);
            console.log('');
            console.log('用法: warren plugin run ' + id + ' ' + found.name + ' [--env <环境>] [--input=\'{"k":1}\']');
            console.log('');
            console.log('（--help 只打印帮助，不执行命令）');
            process.exit(0);
          }
          const lines = [
            `${plugin.id} v${plugin.version}  (${plugin.runtime}${plugin.status ? `, ${plugin.status}` : ''})`,
            plugin.description ?? '',
            '',
            '命令:',
            ...(plugin.contributes?.commands?.length
              ? plugin.contributes.commands.map((item) => `  ${item.name.padEnd(20)} ${item.summary}`)
              : ['  （这个插件没有声明命令）']),
            '',
            // `--env` 是可选的：跟环境无关的命令（列实例、起实例）不需要它
            '用法: warren plugin run ' + id + ' <command> [--env <环境>] [--input=\'{"k":1}\'] [--lease=<leaseId>]',
          ];
          console.log(lines.filter((line) => line !== undefined).join('\n'));
          process.exit(command ? 0 : 1);
        }
        print(
          await call('plugin.run', {
            id,
            command,
            env: typeof flags.env === 'string' ? flags.env : '',
            // 命令的参数：`--input='{"from":"ck1"}'`。插件侧读 ctx.input。
            input: typeof flags.input === 'string' ? parseInputFlag(flags.input) : undefined,
            leaseId: typeof flags.lease === 'string' ? flags.lease : undefined,
          }),
          asJson,
        );
        break;
      }
      case 'rpc': {
        const id = args[2];
        const method = args[3];
        if (!id || !method) {
          console.error(
            '用法: warren plugin rpc <id> <method> [--input=\'{"k":1}\'] [--lease=<leaseId>] [--env=<环境>]',
          );
          process.exit(1);
        }
        print(
          await call('plugin.rpc', {
            id,
            method,
            input: typeof flags.input === 'string' ? parseInputFlag(flags.input) : undefined,
            leaseId: typeof flags.lease === 'string' ? flags.lease : undefined,
            environmentId: typeof flags.env === 'string' ? flags.env : undefined,
          }),
          asJson,
        );
        break;
      }
      default:
        console.error(usageOf('plugin'));
        process.exit(1);
    }
  } else if (group === 'shot') {
    // 截图对比。不需要环境 —— 比的是两个文件。
    switch (sub) {
      case 'diff': {
        const [a, b] = [args[2], args[3]];
        if (!a || !b) {
          console.error('用法: warren shot diff <a.png> <b.png>');
          process.exit(1);
        }
        const stat = (p) => {
          const abs = path.resolve(p);
          if (!existsSync(abs)) {
            console.error(`文件不存在: ${abs}`);
            process.exit(1);
          }
          const bytes = readFileSync(abs);
          return { path: abs, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        };
        const [ra, rb] = [stat(a), stat(b)];
        print({ same: ra.sha256 === rb.sha256, a: ra, b: rb }, asJson, formatShotDiffLine);
        // 不同就退出 1：让 `&&` / CI 能直接当断言用
        if (ra.sha256 !== rb.sha256) process.exit(1);
        break;
      }
      default:
        console.error(usageOf('shot'));
        process.exit(1);
    }
  } else if (group === 'extension') {
    // 每环境的 Chrome 扩展（解包目录）。装在 <storagePath>/extensions/ 下。
    switch (sub) {
      case 'list':
        print(await call('extension.list', { id: args[2] }), asJson, formatExtensionLine);
        break;
      case 'add': {
        const id = args[2];
        const dir = args[3] && path.resolve(args[3]);
        if (!id || !dir) {
          console.error('用法: warren extension add <env> <解包目录> [--name=<目录名>]');
          process.exit(1);
        }
        print(
          await call('extension.add', { id, dir, name: typeof flags.name === 'string' ? flags.name : undefined }),
          asJson,
        );
        break;
      }
      case 'remove':
        print(await call('extension.remove', { id: args[2], name: args[3] }), asJson);
        break;
      default:
        console.error(usageOf('extension', ' <env> [解包目录|目录名]'));
        process.exit(1);
    }
  } else if (group === 'net') {
    // 网络拦截规则。改规则改变页面行为 = 写操作（withLease）；看规则 / 看命中是读。
    switch (sub) {
      case 'rules': {
        const summary = await call('net.rules', { id: args[2] });
        if (asJson) {
          print(summary, true);
          break;
        }
        const state = [summary.recording ? '录制中' : '', summary.replaying ? '回放中' : '']
          .filter(Boolean)
          .join(' · ');
        console.log(`命中 ${summary.hits} 条${state ? ` · ${state}` : ''}`);
        if (!summary.rules.length) console.log('(没有规则)');
        for (const rule of summary.rules) console.log(formatNetRuleLine(rule));
        break;
      }
      case 'rule': {
        const action = args[2];
        const id = args[3];
        if (action === 'add') {
          if (typeof flags.match !== 'string') {
            console.error(
              "用法: warren net rule add <env> --match='*/api/*' [--method=GET] [--regex] [--priority=N] (--mock='{...}' | --block | --redirect=/new | --delay=2000 | --request-header=k=v | --response-header=k=v)",
            );
            process.exit(1);
          }
          const rule = {
            match: {
              url: flags.match,
              isRegex: Boolean(flags.regex),
              method: typeof flags.method === 'string' ? flags.method : undefined,
            },
            priority: typeof flags.priority === 'string' ? Number(flags.priority) : undefined,
            action: netActionFromFlags(flags),
          };
          print(
            [
              await withLease(id, flags, 'warren net rule add', (leaseId) =>
                call('net.rule.add', { id, leaseId, rule }),
              ),
            ],
            asJson,
            formatNetRuleLine,
          );
          break;
        }
        const ruleId = args[4];
        if (action === 'enable' || action === 'disable') {
          print(
            [
              await withLease(id, flags, `warren net rule ${action}`, (leaseId) =>
                call('net.rule.set', { id, leaseId, ruleId, enabled: action === 'enable' }),
              ),
            ],
            asJson,
            formatNetRuleLine,
          );
          break;
        }
        if (action === 'remove') {
          print(
            await withLease(id, flags, 'warren net rule remove', (leaseId) =>
              call('net.rule.remove', { id, leaseId, ruleId }),
            ),
            asJson,
          );
          break;
        }
        console.error('用法: warren net rule add|enable|disable|remove <env> ...');
        process.exit(1);
      }
      case 'hits':
        print(
          await call('net.hits', {
            id: args[2],
            limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
          }),
          asJson,
          formatNetHitLine,
        );
        break;
      case 'body': {
        // 响应体只在录制期间才有（见 net/ops.ts 的 body()）
        const index = Number(args[3]);
        if (!args[2] || !Number.isInteger(index)) {
          console.error('用法: warren net body <env> <序号>   # 先 net record start');
          process.exit(1);
        }
        print(await call('net.body', { id: args[2], index }), asJson, formatNetBodyLine);
        break;
      }
      case 'passthrough': {
        // 临时放行：在别的规则之上开一个口子，到点自动摘掉。
        const id = args[2];
        const match = args[3];
        if (!id || !match) {
          console.error('用法: warren net passthrough <env> <匹配串> [--for=30s] [--regex] [--method=GET]');
          process.exit(1);
        }
        print(
          [
            await withLease(id, flags, 'warren net passthrough', (leaseId) =>
              call('net.passthrough', {
                id,
                leaseId,
                match,
                isRegex: Boolean(flags.regex),
                method: typeof flags.method === 'string' ? flags.method : undefined,
                forMs: parseDuration(flags.for),
              }),
            ),
          ],
          asJson,
          formatNetRuleLine,
        );
        break;
      }
      case 'record': {
        const action = args[2];
        const id = args[3];
        if (action !== 'start' && action !== 'stop') {
          console.error('用法: warren net record start|stop <env> [--output=/abs/a.har]');
          process.exit(1);
        }
        print(
          await withLease(id, flags, `warren net record ${action}`, (leaseId) =>
            call('net.record', {
              id,
              leaseId,
              action,
              // 护栏只收绝对路径，这里先 resolve，省得每次都手打绝对路径
              output: typeof flags.output === 'string' ? path.resolve(flags.output) : undefined,
            }),
          ),
          asJson,
          formatNetRecordLine,
        );
        break;
      }
      case 'replay': {
        const action = args[2];
        const id = args[3];
        if (action === 'stop') {
          print(
            await withLease(id, flags, 'warren net replay stop', (leaseId) =>
              call('net.replay', { id, leaseId, action: 'stop' }),
            ),
            asJson,
          );
          break;
        }
        if (action !== 'start' || !args[4]) {
          console.error('用法: warren net replay start <env> <file.har> [--offline] | warren net replay stop <env>');
          process.exit(1);
        }
        print(
          await withLease(id, flags, 'warren net replay start', (leaseId) =>
            call('net.replay', {
              id,
              leaseId,
              action: 'start',
              file: path.resolve(args[4]),
              offline: Boolean(flags.offline),
            }),
          ),
          asJson,
        );
        break;
      }
      default:
        console.error(usageOf('net', ' <env> ...'));
        process.exit(1);
    }
  } else if (group === 'call') {
    // 逃生舱：直接调 RPC，方便 Agent 和调试
    const method = args[1];
    if (!method) {
      console.error('用法: warren call <method> [jsonParams]');
      process.exit(1);
    }
    print(await call(method, args[2] ? JSON.parse(args[2]) : {}), true);
  } else if (group === 'evidence') {
    if (sub !== 'capture' || !args[2]) {
      console.error('用法: warren evidence capture <env> [--name=<标签>] [--no-screenshot]');
      process.exit(1);
    }
    print(
      await call('evidence.capture', {
        id: args[2],
        name: typeof flags.name === 'string' ? flags.name : undefined,
        screenshot: !flags['no-screenshot'],
      }),
      asJson,
      formatEvidenceLine,
    );
  } else if (group === 'exec') {
    /*
     * 能力清单不需要环境、不需要 lease，也不会碰任何 RPC：
     * 它是对 `createPageApi()` 的实例做反射，和「连哪个环境」无关。
     * 技能/脚本可以用它在**进浏览器之前**判断某个方法存不存在。
     */
    if (flags.capabilities) {
      // 反射只读属性，不调用方法；给一个一定会抛的 call 防住「反射期间偷偷发 RPC」
      const probe = createPageApi(() => {
        throw new Error('capabilities 不执行 RPC');
      });
      print(describeCapabilities(probe));
      process.exit(0);
    }
    const environmentId = args[1];
    if (!environmentId) {
      console.error(
        '用法: warren exec <env> [--lease=<leaseId>] [--expires=<epoch-ms>] < script.js\n' +
          '      warren exec --capabilities   # 打印 VM 全局与 page/locator/mouse/keyboard 方法名',
      );
      process.exit(1);
    }
    let leaseId = typeof flags.lease === 'string' ? flags.lease : undefined;
    const autoLease = !leaseId;
    let stopRenewer = () => {};
    if (autoLease) {
      const lease = await call('env.acquire', { id: environmentId, label: 'warren exec' });
      leaseId = lease.leaseId;
      stopRenewer = startLeaseRenewer(environmentId, lease.leaseExpiresAt);
    } else {
      // 显式 lease 不会随脚本结束释放，但长脚本期间仍然需要续命。
      stopRenewer = startLeaseRenewer(
        environmentId,
        typeof flags.expires === 'string' ? Number(flags.expires) : undefined,
      );
    }
    try {
      const code = await readStdin();
      const page = makePage(environmentId, leaseId, typeof flags.tab === 'string' ? flags.tab : undefined);
      // 注入什么只有 `bin/exec-runtime.mjs` 说了算（EXEC_GLOBALS）。没有 fs / require / process。
      const sandbox = createExecSandbox({ page, console, setTimeout, clearTimeout, emitResult: createEmitResult() });
      const context = vm.createContext(sandbox);
      // 脚本上限跟着 RPC 超时走：两边不一致时 vm 允许 120s、RPC 60s 就断了，超时数字会误导人
      const result = await vm.runInContext(`(async () => {\n${code}\n})()`, context, {
        timeout: CALL_TIMEOUT_MS,
      });
      if (result !== undefined) print(result, asJson);
    } finally {
      stopRenewer();
      // 必须 await：process.on('exit') 里发不出异步请求，会漏 lease
      if (autoLease) await call('env.release', { id: environmentId, leaseId }).catch(() => {});
    }
  } else if (group === 'tab') {
    const environmentId = args[2];
    if (!environmentId) {
      console.error(usageOf('tab', ' <env> [序号|tabId] [url]'));
      process.exit(1);
    }
    const space = flags.space === 'person' ? 'person' : 'agent';
    // Person Space 始终由人控制，不需要 Agent lease；只有 Agent Space 取写权限。
    const withTabWrite = (fn) =>
      space === 'person' ? fn(undefined) : withLease(environmentId, flags, `warren tab ${sub}`, fn);
    switch (sub) {
      case 'list': {
        const tabs = await call('tab.list', { id: environmentId, space });
        print(
          tabs.map((tab, index) => ({ ...tab, index })),
          asJson,
          formatTabLine,
        );
        break;
      }
      case 'new':
        print(
          await withTabWrite((leaseId) =>
            call('tab.new', {
              id: environmentId,
              leaseId,
              space,
              url: args[3],
              background: Boolean(flags.background),
            }),
          ),
          asJson,
        );
        break;
      case 'select':
        print(
          await withTabWrite((leaseId) => call('tab.select', { id: environmentId, leaseId, space, ref: args[3] })),
          asJson,
        );
        break;
      case 'close':
        print(
          await withTabWrite((leaseId) => call('tab.close', { id: environmentId, leaseId, space, ref: args[3] })),
          asJson,
        );
        break;
      case 'reopen':
        print(await withTabWrite((leaseId) => call('tab.reopen', { id: environmentId, leaseId, space })), asJson);
        break;
      default:
        console.error(usageOf('tab', ' <env> [序号|tabId] [url]'));
        process.exit(1);
    }
  } else if (group === 'browser') {
    const environmentId = args[2];
    switch (sub) {
      case 'open':
        print(
          await withLease(environmentId, flags, 'warren browser open', (leaseId) =>
            call('browser.navigate', {
              id: environmentId,
              leaseId,
              url: args[3],
              waitUntil: typeof flags['wait-until'] === 'string' ? flags['wait-until'] : undefined,
              timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
            }),
          ),
          asJson,
        );
        break;
      case 'back':
        print(
          await withLease(environmentId, flags, 'warren browser back', (leaseId) =>
            call('browser.goBack', { id: environmentId, leaseId }),
          ),
          asJson,
        );
        break;
      case 'forward':
        print(
          await withLease(environmentId, flags, 'warren browser forward', (leaseId) =>
            call('browser.goForward', { id: environmentId, leaseId }),
          ),
          asJson,
        );
        break;
      case 'snapshot':
        print(
          await call('browser.snapshot', {
            id: environmentId,
            scope: typeof flags.scope === 'string' ? flags.scope : undefined,
            limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
            includeActionMarks: Boolean(flags['action-marks']),
            includeStableLocator: Boolean(flags.locator),
            interactiveOnly: Boolean(flags.interactive),
            selector: typeof flags.selector === 'string' ? flags.selector : undefined,
          }),
          asJson,
        );
        break;
      case 'info':
        print(await call('browser.info', { id: environmentId }), asJson);
        break;
      case 'events':
        print(await call('browser.events', { id: environmentId }), asJson);
        break;
      case 'console':
        print(await call('browser.console', { id: environmentId }), asJson);
        break;
      case 'network':
        print(await call('browser.network', { id: environmentId }), asJson);
        break;
      case 'screenshot':
        print(
          await call('browser.screenshot', {
            id: environmentId,
            path: typeof flags.output === 'string' ? path.resolve(flags.output) : undefined,
            format: typeof flags.format === 'string' ? flags.format : undefined,
            fullPage: Boolean(flags['full-page']),
            encoding: flags.base64 === true ? 'base64' : undefined,
          }),
          asJson,
          formatScreenshotLine,
        );
        break;
      case 'highlight': {
        // 不传目标就是清除。返回的矩形是主 frame 视口坐标，可以拿去裁截图。
        const target = args[3] ? { kind: 'selector', selector: args[3] } : undefined;
        print(await call('browser.highlight', { id: environmentId, target }), asJson);
        break;
      }
      default:
        console.error(usageOf('browser'));
        process.exit(1);
    }
  } else if (!group || group === 'help' || group === '-h' || group === '--help') {
    console.log(`warren —— Warren 的 Agent 接口

  warren env list
  warren env create <name> [--proxy=URL] [--start-url=URL] [--headed=false]
  warren env start|stop|remove|select <name>
  warren env hibernate|wake <name>   # 休眠 / 唤醒（休眠保留配置与标签快照）
  warren env update <name> [--name=新名字] [--proxy=URL] [--start-url=URL] [--headed=false]
  warren env acquire <name>          # 取控制权，返回 leaseId
  warren env acquire <name> --wait=5000   # 人持权时轮询等到拿到为止
  warren env renew <name> --lease=<leaseId>   # 显式续租（leaseId 不变）
  warren env release <name> --lease=<leaseId>
  warren env takeover <name>         # 模拟人工接管
  warren env egress <name>           # 当前出口与页面状态
  warren env doctor <name> [--ports=8323,8322]   # 代理 / 登录 / 规则 / 本地端口预检
  warren env move <name> --group=<分组ID|none>
  warren env reorder --group=<分组ID|none> <env-id...>

  warren tab list <env>                        # 该环境的标签（● 是当前激活的）
  warren tab new <env> [url] [--background]     # 新建标签
  warren tab select <env> <序号|tabId>          # 切换标签
  warren tab close <env> <序号|tabId>           # 关闭标签（关最后一个 = 停环境）
  warren tab reopen <env>                      # 重新打开最近关掉的那个标签（⌘⇧T）

  warren group list
  warren group create <name>
  warren group rename <分组ID> <name>
  warren group remove <分组ID>       # 环境保留，只移出分组
  warren group collapse <分组ID> [--expand]

  warren browser open <env> <url>
  warren browser back <env>                 # 后退（写操作）
  warren browser forward <env>              # 前进（写操作）
  warren browser snapshot <env>
  warren browser screenshot <env> [--output=<path>] [--full-page] [--format=png|jpeg] [--base64]
  warren browser highlight <env> [选择器]   # 高亮元素给人看（不传选择器 = 清除）
  warren browser info <env>          # url/title/loading/dialog/标签
  warren browser events <env>        # 读并清空 dialog/popup/download/fileChooser
  warren browser console <env>       # 页面 console 摘要
  warren browser network <env>       # 页面请求摘要

  warren net rules <env>             # 该环境的拦截规则 + 命中数
  warren net rule add <env> --match='*/api/*' --mock='{"id":1}' [--status=200] [--method=GET]
  warren net rule add <env> --match='*/track*' --block
  warren net rule add <env> --match='*/old' --redirect=/new
  warren net rule add <env> --match='*/slow' --delay=2000
  warren net rule add <env> --match='*/api/*' --response-header='access-control-allow-origin=*'
  warren net rule add <env> --match='*/api/*' --request-header='x-warren=1' --request-header='x-other=2'
  warren net rule enable|disable|remove <env> <ruleId>
  warren net passthrough <env> <匹配串> [--for=30s]   # 临时放行（压过所有规则，到点自动摘掉）
  warren net hits <env> [--limit=50]   # 规则命中（不是全部请求；全部请求用 browser network）
  warren net body <env> <序号>         # 读录制期间抓到的响应体（JSON 按敏感词脱敏）
                                       # ⚠️ 只在 net record 期间有；抓 body 会让跨源响应跳过 CORS 检查
  warren net record start|stop <env> [--output=/abs/a.har]   # 录 HAR（stop 时落盘）
  warren net replay start <env> <file.har> [--offline]       # 回放（--offline 连未录到的请求也不放行）
  warren net replay stop <env>                               # 停止回放，恢复直连

  warren exec <env> <<'JS'           # 一次调用跑一整段脚本
    await page.goto('https://example.com');
    console.log(await page.title());
  JS
  # VM 里只有 page / console / setTimeout / clearTimeout / emitResult（没有 fs / require / process）
  warren exec --capabilities          # 打印上面这些全局 + page/locator/mouse/keyboard 的方法名

  warren call <method> [jsonParams]   # 原始 RPC 逃生舱（方法名见 docs/HANDOFF.md 的派发表）
  warren evidence capture <env> [--name=<标签>]   # 截图 + snapshot + 网络/命中摘要 + manifest
  warren help                        # 这份清单

  warren events [env]

  warren shot diff <a.png> <b.png>         # 比两张截图（SHA-256；不同则退出 1，可当断言用）

  warren extension list <env>                   # 该环境装了哪些扩展
  warren extension add <env> <解包目录> [--name=<目录名>]   # 装（Electron 不支持 .crx，要先解包）
  warren extension remove <env> <目录名>         # 卸载（正在跑的会话要重启才真的消失）

  warren vault list
  warren vault add <provider> --label=<name>     # 秘密从 stdin 读，不走 argv
  warren vault remove <ref>
  warren vault fill <ref> --env=<env> --field=password --target='{"kind":"label","text":"密码"}'
  warren vault fill <ref> --env=<env> --domains=example.com   # 限制只能填到这些域

  warren plugin list
  warren plugin commands                        # 所有插件注册的命令（跨插件一览）
  warren plugin create <id> [--dir=路径] [--name=显示名]   # 生成 package.json + server.js
  warren plugin install <path:目录|npm:包名[@版本]|git:仓库#ref>
  warren plugin update <id>                     # 按记录下来的来源重新安装
  warren plugin enable|disable|uninstall <id>
  warren plugin reload <id>                     # 重载已启用的插件
  warren plugin status <id>                     # 插件运行状态（不传 id = 全部）
  warren plugin logs <id> [--n=50]              # 插件日志
  warren plugin config <id> [set <key> <value>] # 读插件设置 / 写一条
  warren plugin grant <id> <permission...>
  warren plugin run <id> <command> --env=<env>
  warren plugin rpc <id> <method> [--input='{"k":1}'] [--lease=<leaseId>]
`);
  } else {
    // 打错的组名**必须报错退出 1**：以前这里静默吐 help 并退出 0，agent 会以为命令成功了
    console.error(`未知命令组: ${group}（\`warren help\` 看全部命令）`);
    process.exit(1);
  }
} catch (error) {
  // 错误里能带「原因」的只有 lease 类：把它单独打出来，别让 agent 去猜是过期还是被人接管
  const reason = error.reason
    ? ` [reason=${error.reason}${error.expiredAt === undefined ? '' : ` expiredAt=${new Date(error.expiredAt).toISOString()}`}]`
    : '';
  const payload = {
    ok: false,
    error: {
      code: error.code ?? 'ERROR',
      message: error.message,
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.expiredAt === undefined ? {} : { expiredAt: error.expiredAt }),
    },
  };
  console.error(asJson ? JSON.stringify(payload) : `${payload.error.code}: ${payload.error.message}${reason}`);
  process.exit(1);
}
