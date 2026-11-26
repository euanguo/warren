import { execFileSync } from 'node:child_process';

const KNOWN_CALLERS = [
  { match: /claude/i, label: 'Claude Code' },
  { match: /codex/i, label: 'Codex' },
  { match: /cursor/i, label: 'Cursor' },
  { match: /antigravity|\bagy\b/i, label: 'Antigravity' },
  { match: /opencode/i, label: 'OpenCode' },
];

/**
 * 轻量识别上级调用方进程名（仅用于桌面端控制胶囊与侧栏展示，绝不作为安全信任凭据）。
 * 单次 `ps` 查询限 50ms，失败或未命中已知 Agent 工具时静默回退 `'warren'`。
 */
export function detectCallerLabel(fallback = 'warren') {
  const explicit = process.env.WARREN_CALLER?.trim();
  if (explicit) return explicit.slice(0, 32);
  if (process.platform === 'win32') return fallback;

  try {
    const raw = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      timeout: 50,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const table = new Map();
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].trim() });
    }
    let pid = process.ppid;
    for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
      const row = table.get(pid);
      if (!row) break;
      for (const candidate of KNOWN_CALLERS) {
        if (candidate.match.test(row.comm)) return candidate.label;
      }
      pid = row.ppid;
    }
  } catch {
    // 识别失败静默降级
  }
  return fallback;
}
