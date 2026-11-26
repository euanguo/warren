/**
 * CLI 行格式器、JSON/时长/键值统一解析及网页不可信内容净化输出。
 */
import { applyOutputBudget, stripTerminalEscapes, wrapUntrustedContent } from './output-guard.mjs';

export function print(value, asJson, format) {
  if (asJson) return console.log(JSON.stringify(value, null, 2));
  if (Array.isArray(value)) {
    if (value.length === 0) return console.log('(空)');
    for (const item of value) console.log(format ? format(item) : JSON.stringify(item));
    return;
  }
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

export function formatCliError(error, asJson) {
  const err = error instanceof Error ? error : new Error(String(error));
  const reason = err.reason
    ? ` [reason=${err.reason}${err.expiredAt === undefined ? '' : ` expiredAt=${new Date(err.expiredAt).toISOString()}`}]`
    : '';
  const details = err.details;
  const payload = {
    ok: false,
    error: {
      code: err.code ?? 'ERROR',
      message: stripTerminalEscapes(String(err.message ?? err)),
      ...(err.reason ? { reason: err.reason } : {}),
      ...(err.expiredAt === undefined ? {} : { expiredAt: err.expiredAt }),
      ...(details ? { details } : {}),
    },
  };
  if (asJson) {
    console.error(JSON.stringify(payload));
    return;
  }
  console.error(`${payload.error.code}: ${payload.error.message}${reason}`);
  if (details?.hint) console.error(`  提示: ${stripTerminalEscapes(details.hint)}`);
  if (details?.remedy) console.error(`  建议: ${stripTerminalEscapes(details.remedy)}`);
  if (details?.data?.availableOptions && Array.isArray(details.data.availableOptions)) {
    const opts = details.data.availableOptions
      .slice(0, 10)
      .map((o) => `${o.label || o.value}${o.disabled ? '(disabled)' : ''}`)
      .join(', ');
    if (opts) console.error(`  可用选项: ${opts}`);
  }
}

export function parseJsonArg(raw, label = '参数') {
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    throw Object.assign(new Error(`${label} 不是合法 JSON: ${error.message}`), { code: 'BAD_REQUEST' });
  }
}

export function parseDuration(value) {
  if (value === undefined) return 30_000;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value).trim());
  if (!match) {
    throw Object.assign(new Error(`--for 认不出来: ${value}（要 30s / 5m / 5000ms）`), { code: 'BAD_REQUEST' });
  }
  const scale = match[2] === 'ms' ? 1 : match[2] === 'm' ? 60_000 : 1000;
  return Math.round(Number(match[1]) * scale);
}

export function parseKvFlags(raw) {
  if (!raw) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const out = {};
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    out[item.slice(0, eq).trim()] = item.slice(eq + 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function emitUntrustedText(rawText, flags, meta = {}) {
  const maxOutput = typeof flags['max-output'] === 'string' ? Number(flags['max-output']) : undefined;
  const guarded = applyOutputBudget(rawText, {
    maxChars: Number.isFinite(maxOutput) ? maxOutput : undefined,
    full: Boolean(flags.full),
    label: meta.source ?? 'page',
  });
  const finalText = flags['content-boundaries']
    ? wrapUntrustedContent(guarded.text, { source: meta.source, url: meta.url })
    : guarded.text;
  console.log(finalText);
}

export function formatEnvLine(env) {
  const flag = env.error ? '!' : env.status === 'running' ? '●' : '○';
  const owner = env.owner === 'none' ? '' : `  [${env.owner}]`;
  const err = env.error ? `  页面加载失败: ${env.error}` : '';
  return `${flag} ${String(env.id).padEnd(20)} ${String(env.proxy || '直连').padEnd(30)} ${env.title || env.currentUrl || '—'}${owner}${err}`;
}

export function formatEventLine(event) {
  const at = String(event.createdAt ?? '').slice(11, 19);
  const env = event.environmentId ? ` ${String(event.environmentId).padEnd(14)}` : ` ${''.padEnd(14)}`;
  return `${at}  ${String(event.actor ?? '?').padEnd(6)}${env} ${event.message}`;
}

export function formatPluginLine(plugin) {
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

export const formatPluginLogLine = (entry) =>
  `${entry.at}  ${String(entry.level).toUpperCase().padEnd(5)} ${entry.message}`;

export const formatPluginCommandLine = (entry) =>
  `${String(entry.pluginId).padEnd(24)} ${String(entry.name).padEnd(20)} ${entry.summary ?? ''}`;

export const formatGroupLine = (group) =>
  `${group.collapsed ? '▸' : '▾'} ${String(group.id).padEnd(20)} ${String(group.name).padEnd(16)} order=${group.order}`;

export function formatTabLine(tab) {
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

export function formatNetRuleLine(rule) {
  const flag = rule.enabled ? '●' : '○';
  const method = rule.match.method ?? '*';
  const pattern = `${rule.match.url}${rule.match.isRegex ? ' (regex)' : ''}`;
  const ttl = rule.expiresAt ? ` (剩 ${Math.max(0, Math.round((rule.expiresAt - Date.now()) / 1000))}s)` : '';
  return `${flag} ${String(rule.id).padEnd(36)} prio=${String(rule.priority ?? 0).padEnd(4)} ${method.padEnd(6)} ${pattern}  → ${formatNetActionLine(rule.action)}${ttl}`;
}

export function formatNetHitLine(hit) {
  const at = String(hit.at ?? '').slice(11, 19);
  const rule = hit.ruleId ? ` [${String(hit.ruleId).slice(0, 8)}]` : '';
  const note = hit.note ? `  (${hit.note})` : '';
  return `${at}  ${String(hit.status).padEnd(4)} ${String(hit.method).padEnd(6)} ${String(hit.action).padEnd(18)}${rule} ${hit.url}${note}`;
}

export const formatShotDiffLine = (item) =>
  [
    item.same ? '两张图**完全相同**' : '两张图**不同**',
    `  a: ${item.a.bytes} 字节 sha256=${item.a.sha256.slice(0, 16)}  ${item.a.path}`,
    `  b: ${item.b.bytes} 字节 sha256=${item.b.sha256.slice(0, 16)}  ${item.b.path}`,
  ].join('\n');

export const formatScreenshotLine = (item) =>
  [
    `${item.format} ${item.bytes} 字节 sha256=${String(item.sha256).slice(0, 16)}${item.source ? ` source=${item.source}` : ''}`,
    item.path ? `  ${item.path}` : '  （未落盘；显式 --base64 时返回内容）',
  ].join('\n');

export const formatNetRecordLine = (item) =>
  item.recording
    ? `录制中 · 已录 ${item.entries} 条`
    : [
        `录制结束 · ${item.entries} 条`,
        item.path ? `  ${item.bytes} 字节 sha256=${String(item.sha256).slice(0, 16)}` : '',
        item.path ? `  ${item.path}` : '',
      ]
        .filter(Boolean)
        .join('\n');

export const formatEvidenceLine = (item) =>
  [`证据包 · ${item.files.length} 个文件`, `  ${item.dir}`, ...item.files.map((file) => `  ${file.path}`)].join('\n');

export const formatDoctorLine = (item) => {
  const checks = Array.isArray(item.checks) ? item.checks : [];
  return [
    `预检 ${item.ok ? '通过' : '有阻断'} · ${item.environmentId}`,
    ...checks.map((check) => {
      const mark = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '×';
      return `  ${mark} ${check.id}: ${check.message}${check.hint ? ` → ${check.hint}` : ''}`;
    }),
  ].join('\n');
};

export const formatNetBodyLine = (item) =>
  [
    `${item.status} ${item.contentType ?? ''} ${item.url}`.trim(),
    item.redacted ? '（已按敏感词脱敏）' : '（**未脱敏**：响应不是 JSON，没法按 key 脱敏，自己看仔细）',
    item.body,
  ].join('\n');

export const formatExtensionLine = (item) => `${item.id}  ${item.dir}`;
export const formatMethodLine = (item) =>
  `${String(item.kind).padEnd(7)} ${String(item.name).padEnd(24)} ${item.summary}`;
export const formatNoteLine = (item) =>
  `[${item.site}] (${item.updatedBy}, ${String(item.updatedAt ?? '').slice(0, 19)})\n  ${item.content.replace(/\n/g, '\n  ')}`;
export const formatSkillLine = (item) => {
  const pluginsCount = Array.isArray(item.enabledPlugins) ? `  插件Skill:${item.enabledPlugins.length}` : '';
  return `${item.installed ? (item.upToDate ? '✓' : '!') : '○'} ${item.id.padEnd(8)} ${item.label.padEnd(24)}${pluginsCount}  ${item.path}`;
};
export const formatFlowLine = (item) =>
  `${String(item.name).padEnd(22)} ${String(item.site).padEnd(26)} ${item.spec?.urlTemplate ?? ''}`;
export const formatFlowStepLine = (item) => `GET ${String(item.status).padEnd(4)} ${item.suggestedTemplate}`;
export const formatFrameLine = (item) =>
  `${item.active ? '●' : '○'} [${item.index}] ${item.frameId}${item.crossOrigin ? ' [OOPIF]' : ''}  ${item.url}`;
