/**
 * 主进程滚动文件日志器：写入 `<logsDir>/main.log`，单文件达 2 MB 时轮转为 `main.1.log`。
 * 零 Electron 依赖，便于在 `node --test` 中直接验证轮转与容错行为。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export type MainLogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface MainLogger {
  log: (level: MainLogLevel, scope: string, message: string, detail?: unknown) => void;
  info: (scope: string, message: string, detail?: unknown) => void;
  warn: (scope: string, message: string, detail?: unknown) => void;
  error: (scope: string, message: string, detail?: unknown) => void;
  readonly filePath: string;
}

function serializeDetail(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) {
    return ` | ${detail.stack || detail.message}`;
  }
  if (typeof detail === 'string') return ` | ${detail}`;
  try {
    return ` | ${JSON.stringify(detail)}`;
  } catch {
    return ` | ${String(detail)}`;
  }
}

export function createMainLogger(logsDir: string, options: { maxBytes?: number } = {}): MainLogger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const filePath = path.join(logsDir, 'main.log');
  const backupPath = path.join(logsDir, 'main.1.log');

  const rotateIfNeeded = (): void => {
    try {
      const size = statSync(filePath).size;
      if (size >= maxBytes) {
        renameSync(filePath, backupPath);
      }
    } catch {
      // 文件尚未存在或无法 stat 时跳过轮转
    }
  };

  const log = (level: MainLogLevel, scope: string, message: string, detail?: unknown): void => {
    const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}${serializeDetail(detail)}\n`;
    try {
      mkdirSync(logsDir, { recursive: true });
      rotateIfNeeded();
      appendFileSync(filePath, line, 'utf8');
    } catch {
      // 日志落盘失败绝不拖垮主进程
    }
  };

  return {
    filePath,
    log,
    info: (scope, message, detail) => log('INFO', scope, message, detail),
    warn: (scope, message, detail) => log('WARN', scope, message, detail),
    error: (scope, message, detail) => log('ERROR', scope, message, detail),
  };
}
