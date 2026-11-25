import type { EnvironmentConfig, Group } from '../../shared/types';

/**
 * 分组的纯领域逻辑。
 *
 * 分组只决定侧栏里怎么组织，**不影响运行时**——环境与代理的隔离关系
 * 不因分组改变。所以这里没有权限、没有 lease、没有生命周期。
 */

export const GROUP_NAME_MAX = 40;

/** 分组 ID 由名字派生：小写、连字符。中文名保留原样（用于 ID 会不合法，故回退到随机串） */
export function groupIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]/g, '');
  return slug || `g-${crypto.randomUUID().slice(0, 8)}`;
}

export function validateGroupName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return '分组名不能为空';
  if (trimmed.length > GROUP_NAME_MAX) return `分组名不能超过 ${GROUP_NAME_MAX} 个字符`;
  return undefined;
}

export function createGroup(input: { id?: string; name: string; order?: number; now?: string }): Group {
  const error = validateGroupName(input.name);
  if (error) throw Object.assign(new Error(error), { code: 'BAD_REQUEST' });
  const now = input.now ?? new Date().toISOString();
  const name = input.name.trim();
  return {
    id: input.id ?? groupIdFromName(name),
    name,
    order: input.order ?? 0,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function renameGroup(group: Group, name: string, now = new Date().toISOString()): Group {
  const error = validateGroupName(name);
  if (error) throw Object.assign(new Error(error), { code: 'BAD_REQUEST' });
  return { ...group, name: name.trim(), updatedAt: now };
}

export function setGroupCollapsed(group: Group, collapsed: boolean, now = new Date().toISOString()): Group {
  return { ...group, collapsed, updatedAt: now };
}

/** 同级末尾的排序值。空集合返回 0。 */
export function nextOrder(items: Array<{ order: number }>): number {
  if (items.length === 0) return 0;
  return Math.max(...items.map((item) => item.order)) + 1;
}

/**
 * 把环境移到分组并排到组内末尾。
 *
 * `groupId === undefined` 表示移出分组（回到「未分组」）。
 * 目标分组不存在时抛 GROUP_NOT_FOUND —— 静默放进一个不存在的组会让它在 UI 里消失。
 */
export function moveToGroup(
  config: EnvironmentConfig,
  groupId: string | undefined,
  groups: Group[],
  siblings: EnvironmentConfig[],
  now = new Date().toISOString(),
): EnvironmentConfig {
  if (groupId !== undefined && !groups.some((group) => group.id === groupId)) {
    throw Object.assign(new Error(`unknown group ${groupId}`), { code: 'GROUP_NOT_FOUND' });
  }
  const inTarget = siblings.filter((item) => item.id !== config.id && item.groupId === groupId);
  return { ...config, groupId, order: nextOrder(inTarget), updatedAt: now };
}

/**
 * 按给定的 id 顺序重排，只影响列出的那些（未列出的保持相对次序排在后面）。
 * 传入的 id 里若有不属于该集合的，直接忽略——不抛错，避免一次拖拽失败把整个列表搞乱。
 */
export function reorderBy<T extends { id: string; order: number }>(items: T[], orderedIds: string[]): T[] {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.order - b.order;
  });
}

/**
 * 删除分组时环境去哪。
 * 默认**保留环境并移出分组**——删组顺手删环境是数据丢失，不能做默认行为。
 */
export function detachGroupEnvironments(
  environments: EnvironmentConfig[],
  groupId: string,
  now = new Date().toISOString(),
): EnvironmentConfig[] {
  const orphans = environments.filter((item) => item.groupId === groupId);
  const reordered = orphans.map((item, index) => ({
    ...item,
    groupId: undefined,
    order: index,
    updatedAt: now,
  }));
  const byId = new Map(reordered.map((item) => [item.id, item]));
  return environments.map((item) => byId.get(item.id) ?? item);
}
