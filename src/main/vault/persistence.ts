/**
 * 凭据的持久化：`warren.db` 的 `vault` 表。
 *
 * 表里只有**密文**（safeStorage 加密后的 base64）——明文从不落盘，
 * 对外也没有 reveal 通道（见 `store.ts` 的 `reveal`，只有 Core 内部调得到）。
 *
 * 老的 `vault.json` 一次性导入，导完改名 `.migrated` 留档。
 */
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATED_SUFFIX, tx } from '../db.ts';
import type { CredentialRecord } from './store.ts';

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rowToRecord(row: Row): CredentialRecord {
  return {
    ref: text(row.ref),
    id: text(row.id),
    provider: text(row.provider),
    label: text(row.label),
    usernameHint: text(row.username_hint),
    cipher: text(row.cipher),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

/** 老文件里的记录也要过一遍形状检查：坏记录丢掉，别让一条垃圾把整份凭据带崩。 */
function toRecord(raw: unknown): CredentialRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<CredentialRecord>;
  if (typeof item.ref !== 'string' || !item.ref) return null;
  if (typeof item.cipher !== 'string' || !item.cipher) return null;
  return {
    ref: item.ref,
    id: typeof item.id === 'string' && item.id ? item.id : item.ref.replace(/^vault:\/\//, ''),
    provider: typeof item.provider === 'string' ? item.provider : 'unknown',
    label: typeof item.label === 'string' ? item.label : '',
    usernameHint: typeof item.usernameHint === 'string' ? item.usernameHint : '',
    cipher: item.cipher,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
  };
}

/**
 * 读全部凭据；表是空的就顺手把老的 `vault.json` 导进来（只导一次）。
 *
 * 表里已经有记录时**绝不回头吃老文件**：否则用户删掉的凭据会在下次启动时复活。
 */
export async function loadCredentials(db: DatabaseSync, dir: string): Promise<CredentialRecord[]> {
  const rows = db.prepare('SELECT * FROM vault ORDER BY created_at').all() as Row[];
  if (rows.length > 0) return rows.map(rowToRecord);

  const file = path.join(dir, 'vault.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return []; // 没有老文件（或坏了）：从空开始，不是错误
  }
  const records = (Array.isArray(raw) ? raw : [])
    .map(toRecord)
    .filter((item): item is CredentialRecord => item !== null);
  saveCredentials(db, records);
  try {
    await rename(file, `${file}${MIGRATED_SUFFIX}`);
  } catch {
    // 改名失败不影响已经导进库的数据
  }
  return records;
}

/**
 * 整表重写。
 *
 * 和以前写 `vault.json` 的语义一致（整份覆盖），但现在是**一个事务**：崩在中间
 * 不会留下「一半凭据」的库。凭据是个位数量级，不值得做增量 diff。
 */
export function saveCredentials(db: DatabaseSync, records: CredentialRecord[]): void {
  tx(db, () => {
    db.exec('DELETE FROM vault');
    const insert = db.prepare(
      `INSERT OR REPLACE INTO vault (ref, id, provider, label, username_hint, cipher, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const record of records) {
      insert.run(
        record.ref,
        record.id,
        record.provider,
        record.label,
        record.usernameHint ?? '',
        record.cipher,
        record.createdAt,
        record.updatedAt,
      );
    }
  });
}
