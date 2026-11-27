/**
 * Warren CLI 调度器：可独立导入测试的纯函数入口，不直接调用 `process.exit`。
 */
import { detectCallerLabel } from './caller.mjs';
import { buildHelpText, parseCliFlags } from './commands.mjs';
import { runBatchCommand, runBrowserCommand } from './commands/browser.mjs';
import { runFlowCommand, runNotesCommand } from './commands/data.mjs';
import {
  runEnvCommand,
  runEventsCommand,
  runEvidenceCommand,
  runExtensionCommand,
  runGroupCommand,
  runShotCommand,
} from './commands/env.mjs';
import { runNetCommand } from './commands/net.mjs';
import { runPluginCommand } from './commands/plugin.mjs';
import {
  runCallCommand,
  runExecCommand,
  runMethodsCommand,
  runSkillFlag,
  runSkillsCommand,
  runSystemCommand,
} from './commands/system.mjs';
import { runTabCommand } from './commands/tab.mjs';
import { createRpcClient } from './rpc-client.mjs';

async function defaultReadStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const GROUP_HANDLERS = {
  skills: runSkillsCommand,
  methods: runMethodsCommand,
  notes: runNotesCommand,
  flow: runFlowCommand,
  batch: runBatchCommand,
  env: runEnvCommand,
  group: runGroupCommand,
  events: runEventsCommand,
  plugin: runPluginCommand,
  shot: runShotCommand,
  extension: runExtensionCommand,
  net: runNetCommand,
  call: runCallCommand,
  evidence: runEvidenceCommand,
  exec: runExecCommand,
  tab: runTabCommand,
  browser: runBrowserCommand,
  system: runSystemCommand,
};

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const { flags, rest: args } = parseCliFlags(argv);
  const callerLabel = deps.callerLabel ?? detectCallerLabel();
  const rpc = deps.rpc ?? createRpcClient({ callerLabel });
  const readStdin = deps.readStdin ?? defaultReadStdin;
  const asJson = Boolean(flags.json);
  const explicitTab = typeof flags.tab === 'string' && flags.tab.trim() ? flags.tab.trim() : undefined;
  let pinnedTabId = explicitTab;
  const wrappedCall = async (method, params = {}) => {
    if (
      method.startsWith('browser.') &&
      params &&
      typeof params === 'object' &&
      params.tabId === undefined &&
      (pinnedTabId !== undefined || flags['pin-tab'])
    ) {
      if (pinnedTabId === undefined && flags['pin-tab'] && typeof params.id === 'string') {
        const tabs = await rpc.call('tab.list', {
          id: params.id,
          space: params.space === 'person' ? 'person' : 'agent',
        });
        const active = Array.isArray(tabs) ? tabs.find((t) => t.active) : undefined;
        if (active) pinnedTabId = active.shortRef || active.id;
      }
      if (pinnedTabId !== undefined) {
        return rpc.call(method, { ...params, tabId: pinnedTabId });
      }
    }
    return rpc.call(method, params);
  };
  const ctx = {
    args,
    flags,
    asJson,
    callerLabel,
    call: wrappedCall,
    withLease: rpc.withLease,
    acquire: rpc.acquire,
    startLeaseRenewer: rpc.startLeaseRenewer,
    defaultTimeoutMs: rpc.defaultTimeoutMs,
    readStdin,
  };

  if (flags.skill) return runSkillFlag(ctx);
  const group = args[0];
  if (!group || group === 'help' || group === '-h' || group === '--help') {
    process.stdout.write(buildHelpText());
    return 0;
  }
  const handler = GROUP_HANDLERS[group];
  if (!handler) {
    console.error(`未知命令组: ${group}（\`warren help\` 看全部命令）`);
    return 1;
  }
  return handler(ctx);
}
