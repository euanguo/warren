/**
 * Skill 分发管理、RPC 元数据反射、原始 call 逃生舱与 VM exec 执行环境 CLI 命令组。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { usageOf } from '../commands.mjs';
import {
  createEmitResult,
  createExecSandbox,
  createHelp,
  createPageApi,
  createSleep,
  describeCapabilities,
} from '../exec-runtime.mjs';
import { formatMemorySnapshot, formatMethodLine, formatSkillLine, parseJsonArg, print } from '../formatters.mjs';
import { createOutputBuffer, formatHardStopMessage, isHardStopError } from '../output-buffer.mjs';
import { toCsv } from '../output-guard.mjs';

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

/** 从 VM 错误堆栈中定位 `warren-exec.js:line:col`，渲染前后 2 行源码上下文。 */
export function formatExecErrorSnippet(code, error) {
  const stack = String(error?.stack ?? '');
  const match = stack.match(/warren-exec\.js:(\d+)(?::(\d+))?/);
  if (!match) return '';
  const lineNo = Number(match[1]);
  const colNo = match[2] ? Number(match[2]) : undefined;
  const lines = String(code ?? '').split(/\r?\n/);
  if (!Number.isFinite(lineNo) || lineNo < 1 || lineNo > lines.length) return '';
  const start = Math.max(1, lineNo - 2);
  const end = Math.min(lines.length, lineNo + 2);
  const rendered = [`[exec-source] warren-exec.js:${lineNo}${colNo ? `:${colNo}` : ''}`];
  for (let i = start; i <= end; i += 1) {
    const marker = i === lineNo ? '>' : ' ';
    rendered.push(`${marker} ${String(i).padStart(3, ' ')} | ${lines[i - 1] ?? ''}`);
    if (i === lineNo && colNo && colNo > 0) {
      rendered.push(`      | ${' '.repeat(Math.min(colNo - 1, 120))}^`);
    }
  }
  return rendered.join('\n');
}

/** 将 `warren exec --out=<path>` 结果原子落盘为 `.json` / `.jsonl` / `.csv` 并返回紧凑摘要。 */
export function writeExecOutputFile(destPath, payload) {
  const dest = path.resolve(destPath);
  mkdirSync(path.dirname(dest), { recursive: true });
  const ext = path.extname(dest).toLowerCase();
  let body;
  let rows;
  if (ext === '.jsonl') {
    const list = Array.isArray(payload) ? payload : [payload];
    rows = list.length;
    body = list.map((item) => JSON.stringify(item)).join('\n') + '\n';
  } else if (ext === '.csv') {
    const list = Array.isArray(payload)
      ? payload.map((item) => (item && typeof item === 'object' ? item : { value: item }))
      : [payload && typeof payload === 'object' ? payload : { value: payload }];
    rows = list.length;
    body = toCsv(list) + '\n';
  } else {
    rows = Array.isArray(payload) ? payload.length : undefined;
    body = JSON.stringify(payload === undefined ? null : payload, null, 2) + '\n';
  }
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, dest);
  return { out: dest, bytes: Buffer.byteLength(body, 'utf8'), ...(rows !== undefined ? { rows } : {}) };
}

function formatConsoleArgs(args) {
  return args
    .map((item) => {
      if (typeof item === 'string') return item;
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join(' ');
}

export async function runExecCommand({ args, flags, asJson, call, readStdin, startLeaseRenewer, defaultTimeoutMs }) {
  if (flags.capabilities) {
    const probe = createPageApi(() => {
      throw new Error('capabilities 不执行 RPC');
    });
    print(describeCapabilities(probe, { detailed: Boolean(flags.detailed) }), true);
    return 0;
  }
  const environmentId = args[1];
  if (!environmentId) {
    console.error(
      '用法: warren exec <env> [--lease=<leaseId>] [--expires=<epoch-ms>] [--session=<name>] [--reset-state] [--out=<path>] [--no-tail-state] < script.js\n' +
        '      warren exec --capabilities [--detailed]   # 打印 VM 全局与 page/locator/mouse/keyboard 能力清单',
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

  const session = typeof flags.session === 'string' && flags.session.trim() ? flags.session.trim() : undefined;
  let state = {};
  let initialStateJson = '{}';
  let mutatedWithoutObserve = false;
  let lastEmitted;
  let hasEmitted = false;
  let code = '';

  const outBuf = createOutputBuffer({
    hardStopOnly: true,
    onWriteStdout: (text) => process.stdout.write(text),
    onWriteStderr: (text) => process.stderr.write(text),
  });

  try {
    if (flags['reset-state']) {
      await call('exec.state.clear', { id: environmentId, leaseId, ...(session ? { session } : {}) }).catch(() => {});
    } else {
      const loaded = await call('exec.state.get', { id: environmentId, ...(session ? { session } : {}) }).catch(
        () => null,
      );
      if (loaded?.state && typeof loaded.state === 'object' && !Array.isArray(loaded.state)) {
        state = loaded.state;
        try {
          initialStateJson = JSON.stringify(state);
        } catch {
          initialStateJson = '{}';
        }
      }
    }

    code = await readStdin();
    const tabRef = typeof flags.tab === 'string' ? flags.tab : undefined;
    const page = createPageApi(call, {
      environmentId,
      leaseId,
      tabRef,
      onMutate: () => {
        mutatedWithoutObserve = true;
      },
      onObserve: (method) => {
        if (method === 'browser.snapshot' || method === 'browser.read' || method === 'browser.readBatch') {
          mutatedWithoutObserve = false;
        }
      },
    });
    const emitResult = createEmitResult((line) => outBuf.writeStdout(`${line}\n`));
    const wrappedEmitResult = (payload) => {
      hasEmitted = true;
      lastEmitted = payload;
      return emitResult(payload);
    };
    const execConsole = {
      log: (...items) => outBuf.writeStdout(`${formatConsoleArgs(items)}\n`),
      info: (...items) => outBuf.writeStdout(`${formatConsoleArgs(items)}\n`),
      warn: (...items) => outBuf.writeStderr(`${formatConsoleArgs(items)}\n`),
      error: (...items) => outBuf.writeStderr(`${formatConsoleArgs(items)}\n`),
    };
    const checkpoint = (name, value) =>
      call('exec.checkpoint', { id: environmentId, leaseId, name: String(name ?? ''), value });
    const help = createHelp();
    const sleep = createSleep();

    const sandbox = createExecSandbox({
      page,
      console: execConsole,
      setTimeout,
      clearTimeout,
      emitResult: wrappedEmitResult,
      state,
      checkpoint,
      help,
      sleep,
    });
    const context = vm.createContext(sandbox);
    const execTimeoutMs =
      typeof flags.timeout === 'string' && Number.isFinite(Number(flags.timeout))
        ? Number(flags.timeout)
        : defaultTimeoutMs;
    const script = new vm.Script(`(async () => {\n${code}\n})()`, {
      filename: 'warren-exec.js',
      lineOffset: -1,
    });

    // vm.Script.runInContext 的 timeout 仅限制同步代码段；async IIFE 挂起 Promise 时必须叠加 Promise 竞态超时
    let execTimer;
    const timeoutPromise = new Promise((_, reject) => {
      execTimer = setTimeout(
        () =>
          reject(
            Object.assign(new Error(`exec 脚本超时 ${execTimeoutMs}ms（已自动保存 state 进度）`), { code: 'TIMEOUT' }),
          ),
        execTimeoutMs,
      );
      execTimer.unref?.();
    });
    const result = await Promise.race([
      script.runInContext(context, { timeout: execTimeoutMs }),
      timeoutPromise,
    ]).finally(() => clearTimeout(execTimer));

    outBuf.flush();
    if (typeof flags.out === 'string' && flags.out.trim()) {
      const payload = result !== undefined ? result : hasEmitted ? lastEmitted : state;
      print(writeExecOutputFile(flags.out.trim(), payload), asJson);
    } else if (result !== undefined) {
      print(result, asJson);
    }

    if (!flags['no-tail-state'] && !asJson && mutatedWithoutObserve) {
      const info = await call('browser.info', {
        id: environmentId,
        ...(tabRef !== undefined ? { tabId: tabRef } : {}),
      }).catch(() => null);
      if (info) {
        const dialogNote = info.dialog ? ` | [dialog: ${info.dialog.type}] ${JSON.stringify(info.dialog.message)}` : '';
        process.stdout.write(`[tail] url=${info.url} title=${JSON.stringify(info.title || '')}${dialogNote}\n`);
      }
    }
    return 0;
  } catch (error) {
    if (isHardStopError(error)) {
      outBuf.discard();
      process.stderr.write(`${formatHardStopMessage(error)}\n`);
      throw error;
    }
    outBuf.flush();
    const snippet = formatExecErrorSnippet(code, error);
    if (snippet && !asJson) process.stderr.write(`${snippet}\n`);
    if (!flags['no-tail-state'] && !asJson) {
      const info = await call('browser.info', { id: environmentId }).catch(() => null);
      if (info) {
        const dialogNote = info.dialog ? ` | [dialog: ${info.dialog.type}] ${JSON.stringify(info.dialog.message)}` : '';
        process.stderr.write(`[tail-on-error] url=${info.url}${dialogNote}\n`);
      }
    }
    throw error;
  } finally {
    // 无论成功、失败或超时，只要 state 有变化即自动回写至环境内存态，支持下轮续跑
    try {
      const nextStateJson = JSON.stringify(state);
      if (nextStateJson !== initialStateJson) {
        await call('exec.state.set', {
          id: environmentId,
          leaseId,
          ...(session ? { session } : {}),
          state,
        });
      }
    } catch (saveErr) {
      if (!asJson) {
        process.stderr.write(`[state-save-warning] ${saveErr?.message ?? String(saveErr)}\n`);
      }
    }
    stopRenewer();
    if (autoLease) await call('env.release', { id: environmentId, leaseId }).catch(() => {});
  }
}
