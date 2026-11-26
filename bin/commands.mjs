/**
 * 各命令组的子命令清单与统一 Flag 解析器 —— **唯一来源**。
 *
 * `help`、`default:` 用法提示以及 `tests/skill-contract.test.ts` 的文档防漂移校验都从这里取。
 */
export const SUBS = {
  env: [
    'list',
    'create',
    'start',
    'stop',
    'remove',
    'update',
    'select',
    'acquire',
    'renew',
    'release',
    'takeover',
    'egress',
    'doctor',
    'move',
    'reorder',
  ],
  group: ['list', 'create', 'rename', 'remove', 'collapse'],
  tab: ['list', 'new', 'select', 'close', 'reopen'],
  browser: [
    'open',
    'back',
    'forward',
    'snapshot',
    'read',
    'find',
    'get',
    'is',
    'diff',
    'info',
    'events',
    'console',
    'network',
    'screenshot',
    'highlight',
  ],
  net: ['rules', 'rule', 'hits', 'body', 'passthrough', 'record', 'replay'],
  vault: ['list', 'add', 'remove', 'fill'],
  extension: ['list', 'add', 'remove'],
  shot: ['diff'],
  notes: ['get', 'set', 'append', 'list', 'rm'],
  skills: ['install', 'status', 'refresh'],
  plugin: [
    'list',
    'install',
    'create',
    'update',
    'enable',
    'disable',
    'uninstall',
    'grant',
    'reload',
    'status',
    'logs',
    'commands',
    'config',
    'rpc',
    'run',
  ],
};

/** 不在任何组里的顶层命令（`help` 必须也覆盖它们）。 */
export const TOP_LEVEL = ['exec', 'events', 'evidence', 'call', 'batch', 'methods', 'help'];

/** 明确不含参数的布尔 flag，防止 `warren batch --bail dev` 或 `--data dev` 误吞位置参数。 */
export const BOOLEAN_FLAGS = new Set([
  'json',
  'bail',
  'data',
  'scroll',
  'interactive',
  'full',
  'follow',
  'skill',
  'capabilities',
  'help',
  'expand',
  'background',
  'offline',
  'block',
  'action-marks',
  'locator',
  'full-page',
  'base64',
  'no-screenshot',
  'regex',
  'silent',
]);

/** 各组 `default:` 的用法提示，从 SUBS 生成，格式统一成 `[a|b|c]`。 */
export const usageOf = (group, tail = '') => `用法: warren ${group} [${SUBS[group].join('|')}]${tail}`;

/**
 * 统一命令行 flag 解析：支持 `--flag=val`、`--flag val`、纯布尔 flag、
 * 以及短参 `-i` (`interactive`)、`-d <N>` (`depth`)、`-s <selector>` (`selector`)、`-h` (`help`)。
 */
export function parseCliFlags(args) {
  const flags = {};
  const rest = [];
  const pushFlag = (key, value) => {
    if (key in flags) flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
    else flags[key] = value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-i') {
      pushFlag('interactive', true);
      continue;
    }
    if (arg === '-h') {
      pushFlag('help', true);
      continue;
    }
    if (arg === '-d' || arg.startsWith('-d=')) {
      const val = arg === '-d' ? args[++i] : arg.slice(3);
      pushFlag('depth', val ?? true);
      continue;
    }
    if (arg === '-s' || arg.startsWith('-s=')) {
      const val = arg === '-s' ? args[++i] : arg.slice(3);
      pushFlag('selector', val ?? '');
      continue;
    }
    if (arg.startsWith('--')) {
      // 只按第一个 `=` 切：值里带 `=` 很常见（`--response-header=a=b`、JSON 值）
      const eq = arg.indexOf('=');
      const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq < 0 ? undefined : arg.slice(eq + 1);
      let value;
      if (inline !== undefined) {
        value = inline;
      } else if (BOOLEAN_FLAGS.has(key) || key === 'links') {
        value = true;
      } else if (args[i + 1] && !args[i + 1].startsWith('-')) {
        value = args[++i];
      } else {
        value = true;
      }
      pushFlag(key, value);
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

/** 校验一条 CLI 参数向量是否命中合法命令组与子命令（供文档防漂移测试使用）。 */
export function validateCliInvocation(argv) {
  const { flags, rest } = parseCliFlags(argv);
  if (flags.skill || flags.help || rest.length === 0) return { ok: true, group: flags.skill ? '--skill' : 'help' };
  const [group, sub] = rest;
  if (TOP_LEVEL.includes(group)) return { ok: true, group, sub };
  if (group in SUBS) {
    if (sub && SUBS[group].includes(sub)) return { ok: true, group, sub };
    return { ok: false, reason: `未知子命令: ${group} ${sub ?? '(missing)'}` };
  }
  return { ok: false, reason: `未知命令组: ${group}` };
}
