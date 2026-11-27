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
  const ctx = {
    args,
    flags,
    asJson,
    callerLabel,
    call: rpc.call,
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
