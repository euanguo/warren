/**
 * Skill 分发管理、RPC 元数据反射、原始 call 逃生舱与 VM exec 执行环境 CLI 命令组。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { usageOf } from '../commands.mjs';
import { createEmitResult, createExecSandbox, createPageApi, describeCapabilities } from '../exec-runtime.mjs';
import { formatMemorySnapshot, formatMethodLine, formatSkillLine, parseJsonArg, print } from '../formatters.mjs';

const SKILL_TARGET_DIRS = [
  { id: 'agents', label: '通用（~/.agents）', skillsDir: '.agents/skills' },
  { id: 'claude', label: 'Claude Code（~/.claude）', skillsDir: '.claude/skills' },
  { id: 'codex', label: 'Codex（~/.codex）', skillsDir: '.codex/skills' },
  { id: 'cursor', label: 'Cursor（~/.cursor）', skillsDir: '.cursor/skills' },
];

function resolveBundledSkillPath() {
  const candidates = [
    path.join(import.meta.dirname, '..', '..', 'skills', 'warren', 'SKILL.md'),
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'skills', 'warren', 'SKILL.md')] : []),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw Object.assign(new Error('找不到内置 skills/warren/SKILL.md'), { code: 'SKILL_MISSING' });
}

const skillSha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function getLocalSkillStatuses() {
  const sourceText = readFileSync(resolveBundledSkillPath(), 'utf8');
  const sourceSha = skillSha256(sourceText);
  return SKILL_TARGET_DIRS.map((t) => {
    const file = path.join(os.homedir(), t.skillsDir, 'warren', 'SKILL.md');
    const installed = existsSync(file);
    let upToDate = false;
    let sha256;
    if (installed) {
      try {
        sha256 = skillSha256(readFileSync(file, 'utf8'));
        upToDate = sha256 === sourceSha;
      } catch {
        upToDate = false;
      }
    }
    return { id: t.id, label: t.label, path: file, installed, upToDate, ...(sha256 ? { sha256 } : {}) };
  });
}

function installLocalSkill(targetId) {
  const markdown = readFileSync(resolveBundledSkillPath(), 'utf8');
  const sha256 = skillSha256(markdown);
  const targets = targetId === 'all' ? SKILL_TARGET_DIRS : SKILL_TARGET_DIRS.filter((item) => item.id === targetId);
  if (targets.length === 0) {
    throw Object.assign(new Error(`未知 Skill 目标：${targetId}（可选 agents | claude | codex | cursor | all）`), {
      code: 'BAD_REQUEST',
    });
  }
  const written = [];
  for (const target of targets) {
    const file = path.join(os.homedir(), target.skillsDir, 'warren', 'SKILL.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, markdown, 'utf8');
    written.push({ id: target.id, path: file, sha256 });
  }
  return written;
}

export async function runSkillFlag({ flags, asJson, call }) {
  const pluginId = typeof flags.plugin === 'string' ? flags.plugin : undefined;
  if (pluginId) {
    const doc = await call('skills.plugin', { id: pluginId });
    process.stdout.write(asJson ? JSON.stringify(doc, null, 2) + '\n' : doc.markdown);
    return 0;
  }
  if (flags['base-only']) {
    process.stdout.write(readFileSync(resolveBundledSkillPath(), 'utf8'));
    return 0;
  }
  const mode = flags.full ? 'full' : 'index';
  try {
    const composed = await call('skills.compose', { mode });
    process.stdout.write(asJson ? JSON.stringify(composed, null, 2) + '\n' : composed.markdown);
  } catch {
    process.stdout.write(readFileSync(resolveBundledSkillPath(), 'utf8'));
  }
  return 0;
}

export async function runSkillsCommand({ args, asJson, call }) {
  switch (args[1]) {
    case 'status': {
      const statuses = await call('skills.status').catch(() => getLocalSkillStatuses());
      print(statuses, asJson, formatSkillLine);
      return 0;
    }
    case 'install': {
      const target = args[2] ?? 'all';
      const written = await call('skills.install', { target }).catch(() => installLocalSkill(target));
      print(written, asJson, (w) => `✓ 已安装 ${w.id} → ${w.path}`);
      return 0;
    }
    case 'refresh': {
      const refreshed = await call('skills.refresh').catch(() =>
        getLocalSkillStatuses()
          .filter((item) => item.installed && !item.upToDate)
          .flatMap((item) => installLocalSkill(item.id)),
      );
      print(refreshed, asJson, (w) => `✓ 已更新 ${w.id} → ${w.path}`);
      return 0;
    }
    case 'plugin': {
      const id = args[2];
      if (!id) {
        console.error('用法: warren skills plugin <pluginId> [--json]');
        return 1;
      }
      const doc = await call('skills.plugin', { id });
      if (asJson) print(doc, true);
      else process.stdout.write(doc.markdown);
      return 0;
    }
    default:
      console.error(usageOf('skills', ' [target|all|pluginId]'));
      return 1;
  }
}

export async function runMethodsCommand({ args, asJson, call }) {
  print(await call('rpc.methods', { name: args[1] }), asJson, formatMethodLine);
  return 0;
}

export async function runCallCommand({ args, call }) {
  const method = args[1];
  if (!method) {
    console.error('用法: warren call <method> [jsonParams]');
    return 1;
  }
  print(await call(method, args[2] ? parseJsonArg(args[2], 'jsonParams') : {}), true);
  return 0;
}

export async function runSystemCommand({ args, asJson, call }) {
  switch (args[1]) {
    case 'memory': {
      const snapshot = await call('system.memory');
      print(snapshot, asJson, formatMemorySnapshot);
      return 0;
    }
    case 'reclaim': {
      print(await call('system.reclaimShell'), asJson);
      return 0;
    }
    default:
      console.error(usageOf('system'));
      return 1;
  }
}

export async function runExecCommand({ args, flags, asJson, call, readStdin, startLeaseRenewer, defaultTimeoutMs }) {
  if (flags.capabilities) {
    const probe = createPageApi(() => {
      throw new Error('capabilities 不执行 RPC');
    });
    print(describeCapabilities(probe));
    return 0;
  }
  const environmentId = args[1];
  if (!environmentId) {
    console.error(
      '用法: warren exec <env> [--lease=<leaseId>] [--expires=<epoch-ms>] < script.js\n' +
        '      warren exec --capabilities   # 打印 VM 全局与 page/locator/mouse/keyboard 方法名',
    );
    return 1;
  }
  let leaseId = typeof flags.lease === 'string' ? flags.lease : undefined;
  const autoLease = !leaseId;
  let stopRenewer = () => {};
  if (autoLease) {
    const lease = await call('env.acquire', { id: environmentId, label: 'warren exec' });
    leaseId = lease.leaseId;
    stopRenewer = startLeaseRenewer(environmentId, lease.leaseExpiresAt);
  } else {
    stopRenewer = startLeaseRenewer(
      environmentId,
      typeof flags.expires === 'string' ? Number(flags.expires) : undefined,
    );
  }
  try {
    const code = await readStdin();
    const tabRef = typeof flags.tab === 'string' ? flags.tab : undefined;
    const page = createPageApi(call, { environmentId, leaseId, tabRef });
    const sandbox = createExecSandbox({ page, console, setTimeout, clearTimeout, emitResult: createEmitResult() });
    const context = vm.createContext(sandbox);
    const execTimeoutMs =
      typeof flags.timeout === 'string' && Number.isFinite(Number(flags.timeout))
        ? Number(flags.timeout)
        : defaultTimeoutMs;
    // vm.runInContext 的 timeout 仅限制同步代码段；async IIFE 挂起 Promise 时必须叠加 Promise 竞态超时
    let execTimer;
    const timeoutPromise = new Promise((_, reject) => {
      execTimer = setTimeout(
        () => reject(Object.assign(new Error(`exec 脚本超时 ${execTimeoutMs}ms`), { code: 'TIMEOUT' })),
        execTimeoutMs,
      );
      execTimer.unref?.();
    });
    const result = await Promise.race([
      vm.runInContext(`(async () => {\n${code}\n})()`, context, { timeout: execTimeoutMs }),
      timeoutPromise,
    ]).finally(() => clearTimeout(execTimer));
    if (result !== undefined) print(result, asJson);
    return 0;
  } finally {
    stopRenewer();
    if (autoLease) await call('env.release', { id: environmentId, leaseId }).catch(() => {});
  }
}
