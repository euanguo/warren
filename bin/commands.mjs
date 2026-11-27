/**
 * 各命令组的子命令清单、统一 Flag 解析器与声明式帮助文本 —— **唯一来源**。
 *
 * `help`、`default:` 用法提示、`tests/cli-help.test.ts`、`tests/skill-contract.test.ts`
 * 以及 `remedy` 自愈命令防漂移测试全部从这里取。
 */
export const SUBS = {
  env: [
    'list',
    'create',
    'start',
    'stop',
    'hibernate',
    'wake',
    'remove',
    'update',
    'select',
    'acquire',
    'renew',
    'release',
    'finish',
    'takeover',
    'egress',
    'doctor',
    'move',
    'reorder',
    'clear-cache',
  ],
  group: ['list', 'create', 'rename', 'remove', 'collapse'],
  tab: ['list', 'new', 'select', 'close', 'reopen'],
  browser: [
    'open',
    'back',
    'forward',
    'reload',
    'snapshot',
    'read',
    'find',
    'get',
    'is',
    'diff',
    'click',
    'dblclick',
    'fill',
    'type',
    'press',
    'hover',
    'focus',
    'check',
    'uncheck',
    'select',
    'drag',
    'drop',
    'scroll',
    'scrollintoview',
    'upload',
    'download',
    'wait',
    'dialog',
    'eval',
    'frame',
    'pdf',
    'set',
    'webmcp',
    'vitals',
    'a11y',
    'react',
    'info',
    'events',
    'console',
    'network',
    'screenshot',
    'highlight',
    'detect-login',
  ],
  net: ['rules', 'rule', 'hits', 'body', 'passthrough', 'record', 'replay'],
  extension: ['list', 'add', 'remove'],
  shot: ['diff'],
  notes: ['get', 'set', 'append', 'list', 'rm'],
  flow: ['steps', 'save', 'run', 'list', 'show', 'rm'],
  skills: ['install', 'status', 'refresh', 'plugin'],
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
    'skill',
    'skill-exposure',
    'rpc',
    'run',
  ],
  system: ['memory', 'reclaim'],
};

/** 不在任何组里的顶层命令（`help` 必须也覆盖它们）。 */
export const TOP_LEVEL = ['exec', 'events', 'evidence', 'call', 'batch', 'methods', 'help'];

/**
 * 明确不含空格分隔值参数的布尔/可选等号 flag，防止后续位置参数被吞：
 * 如 `--wait`（轮询等待传 `--wait=5000`）、`--headed=false`、`--clear=false`、`--links`、`-h`。
 */
export const BOOLEAN_FLAGS = new Set([
  'json',
  'bail',
  'data',
  'scroll',
  'interactive',
  'compact',
  'full',
  'base-only',
  'follow',
  'skill',
  'capabilities',
  'help',
  'h',
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
  'urls',
  'boxes',
  'cursor',
  'annotate',
  'outline',
  'read',
  'submit',
  'humanize',
  'new-tab',
  'no-changes',
  'no-text',
  'no-fold',
  'viewport',
  'reset-state',
  'no-tail-state',
  'detailed',
  'list',
  'stdin',
  'pin-tab',
  'agent-only',
  'no-wait',
  'content-boundaries',
  'mobile',
  'landscape',
  'no-background',
  'wait',
  'headed',
  'clear',
  'links',
  'idle',
]);

/** 各组 `default:` 的用法提示，从 SUBS 生成，格式统一成 `[a|b|c]`。 */
export const usageOf = (group, tail = '') => `用法: warren ${group} [${SUBS[group].join('|')}]${tail}`;

/** 基于 SUBS 与 TOP_LEVEL 单源声明生成命令参考卡片，消除手写 help 漂移。 */
const GROUP_DETAIL_LINES = {
  env: [
    'warren env list',
    'warren env create <name> [--proxy=URL] [--start-url=URL] [--headed=false]',
    'warren env start|stop|hibernate|wake|remove|select <name>   # hibernate --idle 一键休眠全部后台环境',
    'warren env clear-cache [name]            # 清理 HTTP 磁盘缓存（保留登录态）',
    'warren env update <name> [--name=新名字] [--proxy=URL] [--trusted-ca=PEM|none] [--start-url=URL] [--headed=false]',
    'warren env acquire <name> [--wait=5000]   # 取控制权（--wait=ms 轮询）',
    'warren env renew|release <name> --lease=<leaseId>',
    'warren env finish <name>                  # 结束 Agent 空间托管操作态并撤除蒙层',
    'warren env takeover|egress <name>         # 人工接管 / 当前出口与页面状态',
    'warren env doctor <name> [--ports=8323,8322]   # 代理 / 登录 / 规则 / 本地端口预检',
    'warren env move <name> --group=<分组ID|none>',
    'warren env reorder --group=<分组ID|none> <env-id...>',
  ],
  tab: [
    'warren tab list <env>                                    # 该环境的标签（● 当前激活，含稳定短引用 t1/t2 与来源标记）',
    'warren tab new <env> [url] [--background]                # 新建标签',
    'warren tab select|close <env> <序号|t1|tabId> [--agent-only]   # 切换/关闭标签，--agent-only 仅清理 Agent/Popup 标签',
    'warren tab reopen <env>                                  # 重新打开最近关掉的标签（⌘⇧T）',
  ],
  group: [
    'warren group list|create <name>',
    'warren group rename <分组ID> <name>',
    'warren group remove <分组ID>                 # 环境保留，只移出分组',
    'warren group collapse <分组ID> [--expand]',
  ],
  browser: [
    'warren browser open <env> <url> [--wait-until=load|networkidle] [--read] [--no-changes]',
    'warren browser back|forward|reload <env> [--no-changes]',
    'warren browser click|dblclick|hover|focus <env> <target> [--new-tab] [--humanize] [--no-changes] [--no-text] [--auto-dialog=accept|dismiss]',
    'warren browser fill|type <env> <target> <value> [--submit] [--clear=false] [--no-changes]',
    'warren browser press <env> [target] <chord> [--no-changes]',
    'warren browser check|uncheck <env> <target> [--no-changes]',
    'warren browser select <env> <target> <value...> [--by=auto|value|label|index] [--no-changes]',
    'warren browser drag|drop <env> <targetOrSrc> <destOrFiles...> [--placement=center|before|after] [--no-changes]',
    'warren browser scroll|scrollintoview <env> <dirOrTarget> [px]',
    'warren browser upload <env> <target> <file...> [--no-changes]',
    'warren browser download <env> <status|save|cancel> <downloadId> [destPath]',
    'warren browser wait <env> <ms|selector> [--text=...] [--url=...] [--load=networkidle] [--event=download]',
    'warren browser dialog <env> <accept|dismiss|policy> [promptOrPolicy] [--no-changes]',
    'warren browser eval <env> <jsExpr>',
    'warren browser frame <env> <list|main|index|frameId>',
    'warren browser pdf <env> <output.pdf> [--landscape] [--scale=1]',
    'warren browser set <env> <viewport|device|geo|offline|headers|media|tz|locale|reset> ...',
    "warren browser webmcp <env> <list|call> [tool] [--args='{}']",
    'warren browser vitals|a11y|react <env>',
    'warren browser snapshot <env> [-i] [-u] [--viewport|--full-page] [--no-fold] [-d=<N>] [--filter=...] [--max-tokens=N] [--boxes] [--content-boundaries] [--json]',
    'warren browser read <env> [url...] [--stdin] [--concurrency=4] [-s <sel>] [--outline] [--filter=...] [--data] [--block=...] [--fields=...] [--where=k=v] [--limit=N] [--links[=pat]] [--list] [--scroll] [--match=...] [--llms=index|full] [--out=<file>]',
    'warren browser find <env> <by> <spec> <action> [val]',
    'warren browser get <env> <url|title|text|html|value|attr|box> [target]',
    'warren browser is <env> <visible|enabled|checked> <target>',
    'warren browser diff <env> <snapshot|screenshot|urls> [a] [b] [--threshold=0.05] [--output=diff.png]',
    'warren browser screenshot <env> [--output=<path>] [--full-page] [--annotate] [--format=png|jpeg] [--base64]',
    'warren browser highlight <env> [选择器]',
    'warren browser detect-login <env>',
    'warren browser info|events|console|network <env>',
  ],
  notes: ['warren notes get|set|append|list|rm [site] [text]   # 站点记忆（每会话首访自动注入 snapshot/read）'],
  flow: [
    'warren flow steps <env>                                  # 关联录制轨迹与只读 GET API 候选（含 s3r1 引用）',
    'warren flow save <name> <urlTemplate> | --env=<env> --output=s3r1 [--param=k=v] [--extract=...] [--fields=a,b]',
    'warren flow run <env> <name> [--param=k=v] [--where=k=v] [--fields=a,b] [--limit=N] [--out=file.csv]',
    'warren flow list|show|rm [name]',
  ],
  skills: ['warren skills install|status|refresh|plugin [target|pluginId]'],
  net: [
    'warren net rules <env>',
    "warren net rule add <env> --match='*/api/*' (--mock='{\"id\":1}' | --block | --redirect=/new | --delay=2000 | --request-header=k=v | --response-header=k=v)",
    'warren net rule enable|disable|remove <env> <ruleId>',
    'warren net hits <env> [--limit=50]',
    'warren net body <env> <序号>',
    'warren net passthrough <env> <匹配串> [--for=30s] [--regex] [--method=GET]',
    'warren net record start|stop <env> [--output=/abs/a.har]',
    'warren net replay start|stop <env> [file.har] [--offline]',
  ],
  extension: [
    'warren extension list <env>',
    'warren extension add <env> <解包目录> [--name=<目录名>]',
    'warren extension remove <env> <目录名>',
  ],
  shot: ['warren shot diff <a.png> <b.png>'],
  plugin: [
    'warren plugin list',
    'warren plugin commands',
    'warren plugin create <id> [--dir=路径] [--name=显示名]',
    'warren plugin install <path:|npm:|git:>',
    'warren plugin update|enable|disable|uninstall|reload <id>',
    'warren plugin status [id]',
    'warren plugin logs <id> [--n=50]',
    'warren plugin config <id> [set <key> <value>]',
    'warren plugin skill <id>',
    'warren plugin skill-exposure <id> <on|off>',
    'warren plugin grant <id> <perm...>',
    'warren plugin run <id> <command> [--env=<env>] [--input=\'{"k":1}\'] [--lease=<leaseId>]',
    'warren plugin rpc <id> <method> [--input=\'{"k":1}\'] [--lease=<leaseId>]',
  ],
  system: [
    'warren system memory [--json]               # 查看按 PID 去重后的进程内存归因与压力水位',
    'warren system reclaim [--json]              # 主动回收空闲隐藏的预热浮层进程',
  ],
};

const TOP_LEVEL_LINES = {
  batch: "  warren batch <env> [--bail] [--no-changes] [--auto-dialog=accept|dismiss] [--json] <<'EOF'",
  exec: "  warren exec <env> <<'JS'   # VM 全局：page/state/checkpoint/help/sleep/emitResult/console/setTimeout/clearTimeout；warren exec --capabilities",
  events: '  warren events [env] [--follow]',
  evidence: '  warren evidence capture <env> [--name=<标签>] [--no-screenshot]',
  methods: '  warren methods [name] [--json]',
  call: '  warren call <method> [jsonParams]',
  help: '  warren help',
};

/** 从命令注册表与子命令清单自动合成 help 正文（对 SUBS 漏项自动兜底补齐）。 */
export function buildHelpText() {
  const sections = ['warren —— Warren 的 Agent 接口\n'];
  for (const [group, subs] of Object.entries(SUBS)) {
    const lines = GROUP_DETAIL_LINES[group] ?? [];
    const covered = new Set();
    for (const line of lines) {
      sections.push(`  ${line}`);
      for (const m of line.matchAll(new RegExp(`warren ${group} ([a-z0-9|-]+)`, 'g'))) {
        for (const s of m[1].split('|')) covered.add(s);
      }
    }
    const missing = subs.filter((s) => !covered.has(s));
    if (missing.length > 0) sections.push(`  warren ${group} ${missing.join('|')}`);
    sections.push('');
  }
  for (const cmd of TOP_LEVEL) {
    sections.push(TOP_LEVEL_LINES[cmd] ?? `  warren ${cmd}`);
  }
  sections.push('  warren --skill [--full|--base-only|--plugin=<id>]');
  return sections.join('\n') + '\n';
}

/**
 * 统一命令行 flag 解析：
 * - 支持 `--flag=val`、`--flag val`、纯布尔 flag；
 * - 支持短参 `-i` (`interactive`)、`-u` (`urls`)、`-d <N>` (`depth`)、`-s <selector>` (`selector`)、`-h` (`help`)；
 * - 支持 POSIX `--` 终止符：`--` 之后所有参数按原样作为位置参数（避免 `fill @1 -- "--dashed"` 被误解析为 flag）。
 */
export function parseCliFlags(args) {
  const flags = {};
  const rest = [];
  const pushFlag = (key, value) => {
    if (key in flags) flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
    else flags[key] = value;
  };

  let literalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (literalOnly) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      literalOnly = true;
      continue;
    }
    if (arg === '-i') {
      pushFlag('interactive', true);
      continue;
    }
    if (arg === '-u') {
      pushFlag('urls', true);
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
      const eq = arg.indexOf('=');
      const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq < 0 ? undefined : arg.slice(eq + 1);
      let value;
      if (inline !== undefined) {
        value = inline;
      } else if (BOOLEAN_FLAGS.has(key)) {
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

/** 校验一条 CLI 参数向量是否命中合法命令组与子命令（供文档与 Remedy 防漂移测试使用）。 */
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
