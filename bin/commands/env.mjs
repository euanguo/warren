/**
 * 环境、分组、事件、扩展、截图哈希与证据包 CLI 命令组。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { usageOf } from '../commands.mjs';
import {
  formatDoctorLine,
  formatEnvLine,
  formatEventLine,
  formatEvidenceLine,
  formatExtensionLine,
  formatGroupLine,
  formatShotDiffLine,
  print,
} from '../formatters.mjs';

export async function runEnvCommand({ args, flags, asJson, call, acquire }) {
  const sub = args[1];
  const id = args[2];
  switch (sub) {
    case 'list':
      print(await call('env.list'), asJson, formatEnvLine);
      return 0;
    case 'create':
      print(
        await call('env.create', {
          id: id ?? flags.id,
          proxy: typeof flags.proxy === 'string' ? flags.proxy : undefined,
          startUrl: typeof flags['start-url'] === 'string' ? flags['start-url'] : undefined,
          headed: flags.headed === undefined ? undefined : flags.headed !== 'false',
        }),
        asJson,
      );
      return 0;
    case 'start':
      print(await call('env.start', { id }), asJson);
      return 0;
    case 'stop':
      print(await call('env.stop', { id }), asJson);
      return 0;
    case 'hibernate':
      print(await call('env.hibernate', { id }), asJson);
      return 0;
    case 'wake':
      print(await call('env.wake', { id }), asJson);
      return 0;
    case 'remove':
      print(await call('env.remove', { id }), asJson);
      return 0;
    case 'update': {
      const patch = {
        name: typeof flags.name === 'string' ? flags.name : undefined,
        proxy: typeof flags.proxy === 'string' ? flags.proxy : undefined,
        trustedCa:
          flags['trusted-ca'] === undefined ? undefined : flags['trusted-ca'] === 'none' ? null : flags['trusted-ca'],
        startUrl: typeof flags['start-url'] === 'string' ? flags['start-url'] : undefined,
        headed: flags.headed === undefined ? undefined : flags.headed !== 'false',
      };
      if (Object.values(patch).every((v) => v === undefined)) {
        console.error(
          '用法: warren env update <env> [--name=<新名字>] [--proxy=<url|none>] [--trusted-ca=<pem路径|none>] [--start-url=<url>] [--headed=false]',
        );
        return 1;
      }
      print(await call('env.update', { id, ...patch }), asJson);
      return 0;
    }
    case 'select':
      print(await call('env.select', { id }), asJson);
      return 0;
    case 'acquire':
      print(await acquire(id, flags), asJson);
      return 0;
    case 'renew':
      print(await call('env.renew', { id, leaseId: flags.lease }), asJson);
      return 0;
    case 'release':
      print(await call('env.release', { id, leaseId: flags.lease }), asJson);
      return 0;
    case 'takeover':
      print(await call('env.takeover', { id }), asJson);
      return 0;
    case 'egress':
      print(await call('env.egress', { id }), asJson);
      return 0;
    case 'doctor':
      print(
        await call('env.doctor', {
          id,
          localPorts: typeof flags.ports === 'string' ? flags.ports.split(',').map(Number) : undefined,
        }),
        asJson,
        formatDoctorLine,
      );
      return 0;
    case 'move':
      if (typeof flags.group !== 'string') {
        console.error('用法: warren env move <env> --group=<分组ID|none>');
        return 1;
      }
      print(
        await call('env.moveToGroup', {
          id,
          groupId: flags.group === 'none' ? undefined : flags.group,
        }),
        asJson,
      );
      return 0;
    case 'reorder': {
      const ids = args.slice(3);
      if (ids.length === 0) {
        console.error('用法: warren env reorder --group=<分组ID|none> <env-id...>');
        return 1;
      }
      print(
        await call('env.reorder', {
          groupId: flags.group === 'none' || flags.group === undefined ? undefined : flags.group,
          ids,
        }),
        asJson,
      );
      return 0;
    }
    default:
      console.error(usageOf('env'));
      return 1;
  }
}

export async function runGroupCommand({ args, flags, asJson, call }) {
  switch (args[1]) {
    case 'list':
      print(await call('group.list'), asJson, formatGroupLine);
      return 0;
    case 'create':
      print(await call('group.create', { name: args.slice(2).join(' ') }), asJson);
      return 0;
    case 'rename':
      print(await call('group.rename', { id: args[2], name: args.slice(3).join(' ') }), asJson);
      return 0;
    case 'remove':
      print(await call('group.remove', { id: args[2] }), asJson);
      return 0;
    case 'collapse':
      print(await call('group.collapse', { id: args[2], collapsed: !flags.expand }), asJson);
      return 0;
    default:
      console.error(usageOf('group'));
      return 1;
  }
}

export async function runEventsCommand({ args, flags, asJson, call }) {
  const envId = args[1];
  if (!flags.follow) {
    print(await call('events.list', { environmentId: envId }), asJson, formatEventLine);
    return 0;
  }
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
  });
  process.on('SIGTERM', () => {
    stopped = true;
  });
  const initial = await call('events.list', { environmentId: envId });
  let lastId = initial.at(-1)?.id;
  for (const item of initial.slice(-10)) {
    console.log(asJson ? JSON.stringify(item) : formatEventLine(item));
  }
  while (!stopped) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (stopped) break;
    const next = await call('events.since', { environmentId: envId, afterId: lastId });
    for (const item of next) {
      lastId = item.id;
      console.log(asJson ? JSON.stringify(item) : formatEventLine(item));
    }
  }
  return 0;
}

export async function runShotCommand({ args, asJson }) {
  if (args[1] !== 'diff') {
    console.error(usageOf('shot'));
    return 1;
  }
  const [a, b] = [args[2], args[3]];
  if (!a || !b) {
    console.error('用法: warren shot diff <a.png> <b.png>');
    return 1;
  }
  const stat = (p) => {
    const abs = path.resolve(p);
    if (!existsSync(abs)) {
      throw Object.assign(new Error(`文件不存在: ${abs}`), { code: 'NOT_FOUND' });
    }
    const bytes = readFileSync(abs);
    return { path: abs, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const [ra, rb] = [stat(a), stat(b)];
  print({ same: ra.sha256 === rb.sha256, a: ra, b: rb }, asJson, formatShotDiffLine);
  return ra.sha256 === rb.sha256 ? 0 : 1;
}

export async function runExtensionCommand({ args, flags, asJson, call }) {
  switch (args[1]) {
    case 'list':
      print(await call('extension.list', { id: args[2] }), asJson, formatExtensionLine);
      return 0;
    case 'add': {
      const id = args[2];
      const dir = args[3] && path.resolve(args[3]);
      if (!id || !dir) {
        console.error('用法: warren extension add <env> <解包目录> [--name=<目录名>]');
        return 1;
      }
      print(
        await call('extension.add', { id, dir, name: typeof flags.name === 'string' ? flags.name : undefined }),
        asJson,
      );
      return 0;
    }
    case 'remove':
      print(await call('extension.remove', { id: args[2], name: args[3] }), asJson);
      return 0;
    default:
      console.error(usageOf('extension', ' <env> [解包目录|目录名]'));
      return 1;
  }
}

export async function runEvidenceCommand({ args, flags, asJson, call }) {
  if (args[1] !== 'capture' || !args[2]) {
    console.error('用法: warren evidence capture <env> [--name=<标签>] [--no-screenshot]');
    return 1;
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
  return 0;
}
