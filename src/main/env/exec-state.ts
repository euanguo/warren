/**
 * `warren exec` 持久化内存状态库 + 显式受控原子 Checkpoint 落盘。
 *
 * 生命周期（用户已锁定）：
 * - `state` 存储在主进程按 `<envId>:<space>:<session>` 隔离的内存 Map 中；
 * - 跨多次 `warren exec` 调用自动保留（含脚本超时/异常中止场景）；
 * - 随 `env.stop` / `env.remove` 自动清空，不污染全局磁盘；
 * - 需要跨会话落盘时由脚本显式调用 `checkpoint(name, value)` 原子写入 `$WARREN_HOME/checkpoints/<env>/<name>.json`。
 *
 * 安全红线：拒绝写入明显包含密码、TOTP、私钥或 Cookie 明文的字段，守住 Vault 隔离边界。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_STATE_KEYS = 1000;
const MAX_CHECKPOINT_BYTES = 5 * 1024 * 1024;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SECRET_KEY_RE =
  /(?:^|[_-])(?:password|passwd|pwd|totp|otp|secret|private[_-]?key|cookie|set-cookie|authorization)(?:$|[_-])/i;
const SECRET_VALUE_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/;

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function assertNoSecretContent(value: unknown, trail = '', depth = 0): void {
  if (depth > 24) throw err('BAD_REQUEST', 'state/checkpoint 嵌套层级超过 24 层');
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value)) {
      throw err('SECRET_REJECTED', `拒绝持久化疑似私钥/凭据令牌（路径 ${trail || 'root'}）`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoSecretContent(value[i], `${trail}[${i}]`, depth + 1);
    }
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k) && v !== null && v !== undefined && v !== '') {
      throw err('SECRET_REJECTED', `拒绝持久化敏感字段 "${k}"，凭据请改用账号管理插件`);
    }
    assertNoSecretContent(v, trail ? `${trail}.${k}` : k, depth + 1);
  }
}

function normalizeStateObject(raw: unknown): { normalized: Record<string, unknown>; bytes: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw err('BAD_REQUEST', 'exec state 必须是普通 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length > MAX_STATE_KEYS) {
    throw err('STATE_TOO_LARGE', `exec state 键数量超过上限 ${MAX_STATE_KEYS}`);
  }
  assertNoSecretContent(obj);
  let json: string;
  try {
    json = JSON.stringify(obj);
  } catch {
    throw err('BAD_REQUEST', 'exec state 包含不可序列化的值（如循环引用或 BigInt）');
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_STATE_BYTES) {
    throw err(
      'STATE_TOO_LARGE',
      `exec state 体积 ${bytes}B 超出 2MB 上限，请改用 await checkpoint(name, data) 落盘大结果`,
    );
  }
  return { normalized: JSON.parse(json) as Record<string, unknown>, bytes };
}

export class ExecStateStore {
  #buckets = new Map<string, { data: Record<string, unknown>; bytes: number; updatedAt: string }>();

  get(scopeKey: string): { state: Record<string, unknown>; bytes: number; updatedAt?: string } {
    const hit = this.#buckets.get(scopeKey);
    if (!hit) return { state: {}, bytes: 2 };
    return {
      state: JSON.parse(JSON.stringify(hit.data)) as Record<string, unknown>,
      bytes: hit.bytes,
      updatedAt: hit.updatedAt,
    };
  }

  set(scopeKey: string, rawState: unknown): { ok: true; bytes: number; keys: number; updatedAt: string } {
    const { normalized, bytes } = normalizeStateObject(rawState);
    const updatedAt = new Date().toISOString();
    this.#buckets.set(scopeKey, { data: normalized, bytes, updatedAt });
    return { ok: true, bytes, keys: Object.keys(normalized).length, updatedAt };
  }

  clear(scopeKey: string): { ok: true; cleared: boolean } {
    return { ok: true, cleared: this.#buckets.delete(scopeKey) };
  }

  clearEnv(envId: string): number {
    const prefix = `${envId}:`;
    let count = 0;
    for (const key of [...this.#buckets.keys()]) {
      if (key.startsWith(prefix)) {
        this.#buckets.delete(key);
        count += 1;
      }
    }
    return count;
  }
}

export function resolveWarrenHome(customHome?: string): string {
  if (customHome && customHome.trim()) return path.resolve(customHome.trim());
  if (process.env.WARREN_HOME && process.env.WARREN_HOME.trim()) return path.resolve(process.env.WARREN_HOME.trim());
  return path.join(os.homedir(), '.warren');
}

/**
 * 将 checkpoint 数据原子写入 `$WARREN_HOME/checkpoints/<safeEnv>/<safeName>.json`。
 * 严格禁止任何路径穿越与敏感字段写入。
 */
export function writeExecCheckpoint(
  envId: string,
  name: string,
  value: unknown,
  options: { warrenHome?: string } = {},
): { path: string; bytes: number; name: string; savedAt: string } {
  const safeEnv = String(envId ?? '').trim();
  const safeName = String(name ?? '')
    .trim()
    .replace(/\.json$/i, '');
  if (!SAFE_SEGMENT_RE.test(safeEnv)) {
    throw err('PATH_DENIED', `非法环境标识，无法写入 checkpoint: ${envId}`);
  }
  if (!SAFE_SEGMENT_RE.test(safeName)) {
    throw err('PATH_DENIED', `checkpoint 名称仅允许字母/数字/._-（1-80 字符）: ${name}`);
  }
  assertNoSecretContent(value);

  const savedAt = new Date().toISOString();
  const envelope = {
    envId: safeEnv,
    name: safeName,
    savedAt,
    value: value === undefined ? null : value,
  };
  let text: string;
  try {
    text = JSON.stringify(envelope, null, 2) + '\n';
  } catch {
    throw err('BAD_REQUEST', 'checkpoint 值不可 JSON 序列化');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_CHECKPOINT_BYTES) {
    throw err('STATE_TOO_LARGE', `checkpoint 体积 ${bytes}B 超出 5MB 上限`);
  }

  const root = path.resolve(resolveWarrenHome(options.warrenHome), 'checkpoints');
  const dir = path.resolve(root, safeEnv);
  const dest = path.resolve(dir, `${safeName}.json`);
  if (!dest.startsWith(`${root}${path.sep}`)) {
    throw err('PATH_DENIED', 'checkpoint 路径越界');
  }

  mkdirSync(dir, { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, dest);
  return { path: dest, bytes, name: safeName, savedAt };
}

export const execStateStore = new ExecStateStore();
