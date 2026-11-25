/**
 * 各命令组的子命令清单 —— **唯一来源**。
 *
 * `help` 与各组 `default:` 的用法提示都从这里取。以前这两处各抄一份，实测已经漂移：
 * help 漏了 `call` 和 4 个 plugin 子命令；plugin 的报错漏了 `create` / `commands`；
 * env 的报错漏了 `update`；net 的报错漏了 `passthrough`。
 *
 * **加子命令只改这里** —— `tests/cli-help.test.ts` 会跑 `warren help` 和每一组的
 * 报错提示，盯着有没有漏。
 *
 * 单独成文件是为了能测：`bin/warren.mjs` 一被 import 就会执行整个 CLI。
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
  browser: ['open', 'back', 'forward', 'snapshot', 'info', 'events', 'console', 'network', 'screenshot', 'highlight'],
  net: ['rules', 'rule', 'hits', 'body', 'passthrough', 'record', 'replay'],
  vault: ['list', 'add', 'remove', 'fill'],
  extension: ['list', 'add', 'remove'],
  shot: ['diff'],
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
export const TOP_LEVEL = ['exec', 'events', 'evidence', 'call', 'help'];

/** 各组 `default:` 的用法提示，从 SUBS 生成，格式统一成 `[a|b|c]`。 */
export const usageOf = (group, tail = '') => `用法: warren ${group} [${SUBS[group].join('|')}]${tail}`;
