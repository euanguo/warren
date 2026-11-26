/**
 * 网络拦截、命中检查、录制与回放 CLI 命令组。
 */
import path from 'node:path';
import { usageOf } from '../commands.mjs';
import {
  formatNetBodyLine,
  formatNetHitLine,
  formatNetRecordLine,
  formatNetRuleLine,
  parseDuration,
  print,
} from '../formatters.mjs';

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

export async function runNetCommand({ args, flags, asJson, call, withLease }) {
  switch (args[1]) {
    case 'rules': {
      const summary = await call('net.rules', { id: args[2] });
      if (asJson) {
        print(summary, true);
        return 0;
      }
      const state = [summary.recording ? '录制中' : '', summary.replaying ? '回放中' : ''].filter(Boolean).join(' · ');
      console.log(`命中 ${summary.hits} 条${state ? ` · ${state}` : ''}`);
      if (!summary.rules.length) console.log('(没有规则)');
      for (const rule of summary.rules) console.log(formatNetRuleLine(rule));
      return 0;
    }
    case 'rule': {
      const action = args[2];
      const id = args[3];
      if (action === 'add') {
        if (typeof flags.match !== 'string') {
          console.error(
            "用法: warren net rule add <env> --match='*/api/*' [--method=GET] [--regex] [--priority=N] (--mock='{...}' | --block | --redirect=/new | --delay=2000 | --request-header=k=v | --response-header=k=v)",
          );
          return 1;
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
          [await withLease(id, flags, 'warren net rule add', (leaseId) => call('net.rule.add', { id, leaseId, rule }))],
          asJson,
          formatNetRuleLine,
        );
        return 0;
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
        return 0;
      }
      if (action === 'remove') {
        print(
          await withLease(id, flags, 'warren net rule remove', (leaseId) =>
            call('net.rule.remove', { id, leaseId, ruleId }),
          ),
          asJson,
        );
        return 0;
      }
      console.error('用法: warren net rule add|enable|disable|remove <env> ...');
      return 1;
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
      return 0;
    case 'body': {
      const index = Number(args[3]);
      if (!args[2] || !Number.isInteger(index)) {
        console.error('用法: warren net body <env> <序号>   # 先 net record start');
        return 1;
      }
      print(await call('net.body', { id: args[2], index }), asJson, formatNetBodyLine);
      return 0;
    }
    case 'passthrough': {
      const id = args[2];
      const match = args[3];
      if (!id || !match) {
        console.error('用法: warren net passthrough <env> <匹配串> [--for=30s] [--regex] [--method=GET]');
        return 1;
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
      return 0;
    }
    case 'record': {
      const action = args[2];
      const id = args[3];
      if (action !== 'start' && action !== 'stop') {
        console.error('用法: warren net record start|stop <env> [--output=/abs/a.har]');
        return 1;
      }
      print(
        await withLease(id, flags, `warren net record ${action}`, (leaseId) =>
          call('net.record', {
            id,
            leaseId,
            action,
            output: typeof flags.output === 'string' ? path.resolve(flags.output) : undefined,
          }),
        ),
        asJson,
        formatNetRecordLine,
      );
      return 0;
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
        return 0;
      }
      if (action !== 'start' || !args[4]) {
        console.error('用法: warren net replay start <env> <file.har> [--offline] | warren net replay stop <env>');
        return 1;
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
      return 0;
    }
    default:
      console.error(usageOf('net', ' <env> ...'));
      return 1;
  }
}
