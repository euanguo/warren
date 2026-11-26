/**
 * 站点记忆（notes）、只读参数化 GET Flow（flow）与凭据金库（vault）CLI 命令组。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { usageOf } from '../commands.mjs';
import {
  formatFlowLine,
  formatFlowStepLine,
  formatNoteLine,
  parseJsonArg,
  parseKvFlags,
  print,
} from '../formatters.mjs';
import { toCsv } from '../output-guard.mjs';

export async function runNotesCommand({ args, asJson, callerLabel, call, readStdin }) {
  switch (args[1]) {
    case 'list':
      print(await call('notes.list'), asJson, formatNoteLine);
      return 0;
    case 'get':
      print(await call('notes.get', { site: args[2] }), asJson);
      return 0;
    case 'set':
      print(
        await call('notes.set', {
          site: args[2],
          content: args.slice(3).join(' ') || (await readStdin()),
          updatedBy: callerLabel,
        }),
        asJson,
      );
      return 0;
    case 'append':
      print(
        await call('notes.append', {
          site: args[2],
          text: args.slice(3).join(' ') || (await readStdin()),
          updatedBy: callerLabel,
        }),
        asJson,
      );
      return 0;
    case 'rm':
      print(await call('notes.rm', { site: args[2] }), asJson);
      return 0;
    default:
      console.error(usageOf('notes', ' <site> [content]'));
      return 1;
  }
}

export async function runFlowCommand({ args, flags, asJson, callerLabel, call }) {
  switch (args[1]) {
    case 'steps': {
      const envId = args[2] ?? process.env.WARREN_ENV;
      if (!envId) {
        console.error('用法: warren flow steps <env>');
        return 1;
      }
      print(await call('flow.steps', { id: envId }), asJson, formatFlowStepLine);
      return 0;
    }
    case 'list':
      print(await call('flow.list'), asJson, formatFlowLine);
      return 0;
    case 'show':
      if (!args[2]) {
        console.error('用法: warren flow show <name>');
        return 1;
      }
      print(await call('flow.show', { name: args[2] }), asJson);
      return 0;
    case 'save': {
      const name = args[2];
      const urlTemplate = args[3];
      if (!name || !urlTemplate) {
        console.error(
          '用法: warren flow save <name> <urlTemplate> [--extract=data.items] [--fields=a,b] [--desc=说明]',
        );
        return 1;
      }
      const fields =
        typeof flags.fields === 'string'
          ? flags.fields
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
      print(
        await call('flow.save', {
          name,
          spec: {
            method: 'GET',
            urlTemplate,
            ...(typeof flags.extract === 'string' ? { extractPath: flags.extract } : {}),
            ...(fields?.length ? { fields } : {}),
            ...(typeof flags.desc === 'string' ? { description: flags.desc } : {}),
          },
          updatedBy: callerLabel,
        }),
        asJson,
      );
      return 0;
    }
    case 'rm':
      if (!args[2]) {
        console.error('用法: warren flow rm <name>');
        return 1;
      }
      print(await call('flow.rm', { name: args[2] }), asJson);
      return 0;
    case 'run': {
      const envId = args[2];
      const name = args[3];
      if (!envId || !name) {
        console.error(
          '用法: warren flow run <env> <name> [--param=k=v] [--fields=a,b] [--where=k=v] [--limit=N] [--out=file.csv]',
        );
        return 1;
      }
      const fields =
        typeof flags.fields === 'string'
          ? flags.fields
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
      const res = await call('flow.run', {
        id: envId,
        name,
        params: parseKvFlags(flags.param),
        where: parseKvFlags(flags.where),
        fields,
        limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
      });
      if (typeof flags.out === 'string' && flags.out.trim()) {
        const dest = path.resolve(flags.out.trim());
        mkdirSync(path.dirname(dest), { recursive: true });
        const body = dest.endsWith('.csv') && Array.isArray(res.rows) ? toCsv(res.rows) : JSON.stringify(res, null, 2);
        writeFileSync(dest, body + '\n', 'utf8');
        print(
          {
            out: dest,
            count: res.count,
            flow: res.flow,
            ...(res.schemaDrift ? { schemaDrift: res.schemaDrift } : {}),
          },
          asJson,
        );
      } else {
        print(res, asJson);
      }
      return 0;
    }
    default:
      console.error(usageOf('flow', ' ...'));
      return 1;
  }
}

export async function runVaultCommand({ args, flags, call, readStdin, withLease }) {
  switch (args[1]) {
    case 'list':
      print(await call('vault.list'), true);
      return 0;
    case 'add': {
      const raw = await readStdin();
      if (!raw.trim()) {
        console.error(
          '用法: echo \'{"username":"a@b.com","password":"..."}\' | warren vault add <provider> --label=<name>',
        );
        return 1;
      }
      print(
        await call('vault.add', {
          provider: args[2],
          label: typeof flags.label === 'string' ? flags.label : '',
          secret: parseJsonArg(raw, 'vault secret'),
        }),
        true,
      );
      return 0;
    }
    case 'remove':
      print(await call('vault.remove', { ref: args[2] }), true);
      return 0;
    case 'fill': {
      const environmentId = typeof flags.env === 'string' ? flags.env : '';
      const target = flags.target
        ? parseJsonArg(flags.target, '--target')
        : { kind: 'selector', selector: 'input[type=password]' };
      const allowedDomains =
        typeof flags.domains === 'string'
          ? flags.domains
              .split(',')
              .map((d) => d.trim())
              .filter(Boolean)
          : undefined;
      print(
        await withLease(environmentId, flags, 'warren vault fill', (leaseId) =>
          call('vault.fill', {
            id: environmentId,
            leaseId,
            ref: args[2],
            field: typeof flags.field === 'string' ? flags.field : 'password',
            target,
            allowedDomains,
          }),
        ),
        true,
      );
      return 0;
    }
    default:
      console.error(usageOf('vault'));
      return 1;
  }
}
