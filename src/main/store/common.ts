/**
 * Store 子域仓储共享的类型、行映射、校验、遗留 JSON 迁移与诊断告警助手。
 */
import path from 'node:path';
import type { Creator, EnvironmentConfig, EventRecord, Group, SpaceId, UrlHistoryEntry } from '../../shared/types';
import { isApprovalMode } from '../domain/approval.ts';

export interface StoreShape {
  environments: EnvironmentConfig[];
  groups: Group[];
}

export interface RunningSnapshot {
  running: string[];
  selected?: string;
  /** 休眠中的环境；崩溃恢复不当成 running 拉起，被用到时透明唤醒。 */
  dormant?: string[];
}

export interface RememberedTab {
  space: SpaceId;
  url: string;
  active: boolean;
}

export const EVENT_LIMIT = 5000;
export const URL_HISTORY_LIMIT = 5000;

const SECRET_NOTE_PATTERNS: RegExp[] = [
  /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{4,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
];

export type Row = Record<string, unknown>;

export function warnStore(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[store:${scope}] ${message}`);
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** 规范化站点记忆键：支持完整 URL 或域名（可选路径前缀），统一小写并去尾斜杠。 */
export function normalizeSiteKey(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw Object.assign(new Error('site is required'), { code: 'BAD_REQUEST' });
  let normalized = trimmed;
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw Object.assign(new Error(`仅支持 http/https 站点或域名：${raw}`), { code: 'BAD_REQUEST' });
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    normalized = `${parsed.host.toLowerCase()}${cleanPath}`;
  } else {
    normalized = trimmed.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  }
  if (!normalized || normalized.length > 256 || /\s/.test(normalized)) {
    throw Object.assign(new Error(`无效的站点键：${raw}`), { code: 'BAD_REQUEST' });
  }
  return normalized;
}

export function assertNoteSafe(content: string): string {
  const cleaned = String(content ?? '').trim();
  if (!cleaned) throw Object.assign(new Error('note content is empty'), { code: 'BAD_REQUEST' });
  if (cleaned.length > 8192) {
    throw Object.assign(new Error('note content exceeds 8192 characters'), { code: 'BAD_REQUEST' });
  }
  if (SECRET_NOTE_PATTERNS.some((re) => re.test(cleaned))) {
    throw Object.assign(new Error('site_notes 严禁存放密码或令牌明文，请使用账号管理插件（com.warren.accounts）'), {
      code: 'BAD_REQUEST',
    });
  }
  return cleaned;
}

export function rowToConfig(row: Row): EnvironmentConfig {
  return {
    id: String(row.id),
    name: String(row.name),
    storagePath: String(row.storage_path),
    proxy: optionalText(row.proxy),
    trustedCa: optionalText(row.trusted_ca),
    createdBy: (row.created_by === 'agent' ? 'agent' : 'human') as Creator,
    approval: isApprovalMode(row.approval) ? row.approval : undefined,
    startUrl: optionalText(row.start_url),
    headed: row.headed === 1 || row.headed === true,
    groupId: optionalText(row.group_id),
    order: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function rowToGroup(row: Row): Group {
  return {
    id: String(row.id),
    name: String(row.name),
    order: Number(row.sort_order ?? 0),
    collapsed: row.collapsed === 1 || row.collapsed === true,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function rowToEvent(row: Row): EventRecord {
  return {
    id: String(row.id),
    environmentId: optionalText(row.environment_id),
    type: String(row.type),
    actor: String(row.actor) as EventRecord['actor'],
    message: String(row.message),
    createdAt: String(row.created_at),
  };
}

export function rowToUrlHistory(row: Row): UrlHistoryEntry {
  return {
    url: String(row.url),
    visitCount: Number(row.visit_count ?? 1),
    lastVisitedAt: String(row.last_visited_at),
  };
}

export function migrateLegacyShape(raw: unknown, dir: string): StoreShape {
  const shape = (raw ?? {}) as Partial<StoreShape>;
  const environments = Array.isArray(shape.environments) ? shape.environments : [];
  const groups = Array.isArray(shape.groups) ? shape.groups : [];

  const sessionsRoot = path.join(dir, 'sessions');
  const normalized = environments.map((config, index) => {
    const order = typeof config.order === 'number' ? config.order : index;
    const inPlace =
      typeof config.storagePath === 'string' &&
      (config.storagePath === path.join(sessionsRoot, config.id) ||
        config.storagePath.startsWith(sessionsRoot + path.sep));
    return {
      ...config,
      order,
      groupId: config.groupId ?? undefined,
      createdBy: config.createdBy ?? 'human',
      storagePath: inPlace ? config.storagePath : path.join(sessionsRoot, config.id),
    } satisfies EnvironmentConfig;
  });

  const groupIds = new Set(groups.map((group) => group.id));
  for (const config of normalized) {
    if (config.groupId && !groupIds.has(config.groupId)) config.groupId = undefined;
  }

  return {
    environments: normalized,
    groups: groups.map((group, index) => ({
      ...group,
      order: typeof group.order === 'number' ? group.order : index,
      collapsed: Boolean(group.collapsed),
    })),
  };
}

export function normalizeRunning(raw: unknown): RunningSnapshot {
  const shape = (raw ?? {}) as Partial<RunningSnapshot>;
  const running = Array.isArray(shape.running)
    ? shape.running.filter((id): id is string => typeof id === 'string' && Boolean(id))
    : [];
  return {
    running,
    selected: typeof shape.selected === 'string' ? shape.selected : undefined,
    dormant: Array.isArray(shape.dormant)
      ? shape.dormant.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : [],
  };
}
