/**
 * 双 Space 标签管理 CLI 命令组。
 */
import { usageOf } from '../commands.mjs';
import { formatTabLine, print } from '../formatters.mjs';

export async function runTabCommand({ args, flags, asJson, call, withLease }) {
  const sub = args[1];
  const environmentId = args[2];
  if (!environmentId) {
    console.error(usageOf('tab', ' <env> [序号|tabId] [url]'));
    return 1;
  }
  const space = flags.space === 'person' ? 'person' : 'agent';
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
      return 0;
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
      return 0;
    case 'select':
      print(
        await withTabWrite((leaseId) => call('tab.select', { id: environmentId, leaseId, space, ref: args[3] })),
        asJson,
      );
      return 0;
    case 'close':
      print(
        await withTabWrite((leaseId) => call('tab.close', { id: environmentId, leaseId, space, ref: args[3] })),
        asJson,
      );
      return 0;
    case 'reopen':
      print(await withTabWrite((leaseId) => call('tab.reopen', { id: environmentId, leaseId, space })), asJson);
      return 0;
    default:
      console.error(usageOf('tab', ' <env> [序号|tabId] [url]'));
      return 1;
  }
}
