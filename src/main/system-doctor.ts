import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SystemDiagnosticCheck, SystemDiagnosticsReport } from '../shared/types.ts';
import { skillStatus } from './agent-integration.ts';
import type { EnvironmentManager } from './environments.ts';
import type { PluginHost } from './plugins/host.ts';
import type { Store } from './store.ts';

export interface CollectSystemDiagnosticsInput {
  appVersion: string;
  dataDir: string;
  coreDir: string;
  socketPath: string;
  runtimeFile: string;
  skillSourceDir: string;
  db: DatabaseSync;
  store: Pick<Store, 'list' | 'listGroups' | 'events'>;
  manager: Pick<EnvironmentManager, 'list' | 'maxRunning' | 'hasActiveAgentLease'>;
  plugins: Pick<PluginHost, 'list'>;
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 采集全局脱敏系统诊断报告（不包含任何凭据明文、Cookie 值或网页私密内容）。 */
export async function collectSystemDiagnostics(input: CollectSystemDiagnosticsInput): Promise<SystemDiagnosticsReport> {
  const checks: SystemDiagnosticCheck[] = [];

  // 1. SQLite 与 WAL 状态
  const dbPath = path.join(input.coreDir, 'warren.db');
  const walPath = path.join(input.coreDir, 'warren.db-wal');
  const [dbBytes, walBytes] = await Promise.all([fileSize(dbPath), fileSize(walPath)]);
  let journalMode = 'unknown';
  try {
    const row = input.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    if (row?.journal_mode) journalMode = String(row.journal_mode);
  } catch {
    journalMode = 'error';
  }
  checks.push({
    id: 'sqlite',
    label: 'SQLite 存储引擎',
    status: journalMode === 'error' ? 'error' : dbBytes !== null ? 'ok' : 'warn',
    detail:
      journalMode === 'error'
        ? 'SQLite 读取失败'
        : `journal_mode=${journalMode} · 主库 ${dbBytes !== null ? formatBytes(dbBytes) : '内存/未知'}${walBytes !== null ? ` · WAL ${formatBytes(walBytes)}` : ''}`,
  });

  // 2. Agent RPC Socket 与运行时凭证
  const [sockSize, runtimeSize] = await Promise.all([fileSize(input.socketPath), fileSize(input.runtimeFile)]);
  checks.push({
    id: 'rpc',
    label: 'Agent RPC 服务',
    status: sockSize !== null && runtimeSize !== null ? 'ok' : 'warn',
    detail:
      sockSize !== null && runtimeSize !== null
        ? `Socket 已就绪 (${input.socketPath})`
        : 'Socket 或 runtime.json 尚未落盘',
  });

  // 3. 环境池状态（必须读 manager 运行时列表，store.list() 的持久化 status 恒为 stopped）
  const envs = input.manager.list();
  const running = envs.filter((env) => env.status === 'running').length;
  const dormant = envs.filter((env) => env.status === 'dormant').length;
  const erroredEnvs = envs.filter((env) => Boolean(env.error)).length;
  checks.push({
    id: 'environments',
    label: '浏览器环境池',
    status: erroredEnvs > 0 ? 'warn' : 'ok',
    detail: `共 ${envs.length} 个环境 · 运行中 ${running} / 休眠 ${dormant}（上限 ${input.manager.maxRunning || '不限'}）${input.manager.hasActiveAgentLease() ? ' · Agent 持权中' : ''}`,
  });

  // 4. 内置 Skill 同步状态
  const skills = await skillStatus(os.homedir(), input.skillSourceDir).catch(() => []);
  const installedCount = skills.filter((item) => item.installed).length;
  const outdatedCount = skills.filter((item) => item.installed && item.upToDate === false).length;
  checks.push({
    id: 'skills',
    label: 'CLI Skill 接入状态',
    status: installedCount === 0 || outdatedCount > 0 ? 'warn' : 'ok',
    detail:
      skills.length === 0
        ? '未检测到 Skill 目录'
        : `${installedCount}/${skills.length} 个 Agent 目录已安装${outdatedCount > 0 ? `（${outdatedCount} 处待更新）` : ''}`,
  });

  // 6. 插件宿主与运行时边界
  const plugins = await input.plugins.list().catch(() => []);
  const enabledPlugins = plugins.filter((item) => item.enabled).length;
  const erroredPlugins = plugins.filter((item) => item.status === 'error').length;
  const hostPlugins = plugins.filter((item) => item.enabled && item.runtime === 'host').length;
  checks.push({
    id: 'plugins',
    label: '插件工作进程',
    status: erroredPlugins > 0 ? 'warn' : 'ok',
    detail: `已安装 ${plugins.length} 个 · 运行中 ${enabledPlugins}${hostPlugins > 0 ? `（含 ${hostPlugins} 个完整 Node 宿主）` : ''}${erroredPlugins > 0 ? ` · ${erroredPlugins} 个存在异常` : ''}`,
  });

  return {
    generatedAt: new Date().toISOString(),
    appVersion: input.appVersion,
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    platform: `${process.platform} (${process.arch})`,
    dataDir: input.dataDir,
    checks,
  };
}
