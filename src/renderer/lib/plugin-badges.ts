/**
 * 插件往环境行放的只读状态芯片。
 *
 * 这是 renderer-only 状态：不跨 IPC，不放 shared/types.ts。
 * 生命周期按 `pluginId + digest` 管：
 * - 同一个 digest 重新 register（App 每次 state:changed 都会重跑）不清 badge；
 * - digest 变了、插件停用 / 卸载 → 清掉。
 */
import { useSyncExternalStore } from 'react';

export type PluginEnvBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface PluginEnvBadge {
  icon?: string;
  /** 最多 3 个字符；setter 会截断，避免把环境行撑开。 */
  label: string;
  tone?: PluginEnvBadgeTone;
}

export interface PluginEnvBadgeSurface {
  id: string;
  title: string;
  icon?: string;
  description?: string;
}

export interface PluginEnvBadgeSetter {
  set(envId: string, badge: PluginEnvBadge | null): void;
  clear(): void;
}

export type PluginBadgeSnapshot = Readonly<Record<string, Readonly<Record<string, PluginEnvBadge>>>>;

interface Entry {
  generation: number;
  digest: string;
  /** surface 声明顺序：一个插件多个 badge 面时按这个顺序取第一个有值的。 */
  surfaces: string[];
  envs: Map<string, Map<string, PluginEnvBadge>>;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let snapshot: PluginBadgeSnapshot = {};

function notify(): void {
  for (const listener of listeners) listener();
}

function rebuild(): void {
  const next: Record<string, Record<string, PluginEnvBadge>> = {};
  for (const pluginId of [...entries.keys()].sort()) {
    const entry = entries.get(pluginId)!;
    const envs: Record<string, PluginEnvBadge> = {};
    for (const [envId, bySurface] of entry.envs) {
      for (const surfaceId of entry.surfaces) {
        const badge = bySurface.get(surfaceId);
        if (badge) {
          envs[envId] = badge;
          break;
        }
      }
    }
    if (Object.keys(envs).length > 0) next[pluginId] = envs;
  }
  snapshot = next;
  notify();
}

/** 每次插件前端加载时调用；同 digest 返回同一个 generation，badge 不清。 */
export function beginPluginLoad(pluginId: string, digest: string): number {
  const existing = entries.get(pluginId);
  if (existing && existing.digest === digest) return existing.generation;
  const entry: Entry = {
    generation: (existing?.generation ?? 0) + 1,
    digest,
    surfaces: [],
    envs: new Map(),
  };
  entries.set(pluginId, entry);
  rebuild();
  return entry.generation;
}

export function registerPluginBadgeSurface(pluginId: string, generation: number, surfaceId: string): void {
  const entry = entries.get(pluginId);
  if (!entry || entry.generation !== generation) return;
  if (!entry.surfaces.includes(surfaceId)) {
    entry.surfaces.push(surfaceId);
    rebuild();
  }
}

function normalizeBadge(badge: PluginEnvBadge | null): PluginEnvBadge | null {
  if (!badge) return null;
  const label = Array.from(String(badge.label ?? ''))
    .slice(0, 3)
    .join('');
  if (!label) return null;
  return {
    label,
    ...(badge.icon ? { icon: badge.icon } : {}),
    ...(badge.tone ? { tone: badge.tone } : {}),
  };
}

function sameBadge(a: PluginEnvBadge | undefined, b: PluginEnvBadge | null): boolean {
  if (!a || !b) return !a && !b;
  return a.label === b.label && a.icon === b.icon && a.tone === b.tone;
}

export function setPluginEnvBadge(
  pluginId: string,
  generation: number,
  surfaceId: string,
  envId: string,
  badge: PluginEnvBadge | null,
): void {
  const entry = entries.get(pluginId);
  if (!entry || entry.generation !== generation) return; // stale setter：插件已重载 / 停用
  if (!entry.surfaces.includes(surfaceId)) entry.surfaces.push(surfaceId);
  const normalized = normalizeBadge(badge);
  const bySurface = entry.envs.get(envId) ?? new Map<string, PluginEnvBadge>();
  if (sameBadge(bySurface.get(surfaceId), normalized)) return;
  if (normalized) bySurface.set(surfaceId, normalized);
  else bySurface.delete(surfaceId);
  if (bySurface.size > 0) entry.envs.set(envId, bySurface);
  else entry.envs.delete(envId);
  rebuild();
}

export function clearPluginBadgeSurface(pluginId: string, generation: number, surfaceId: string): void {
  const entry = entries.get(pluginId);
  if (!entry || entry.generation !== generation) return;
  let changed = false;
  for (const [envId, bySurface] of entry.envs) {
    if (bySurface.delete(surfaceId)) changed = true;
    if (bySurface.size === 0) entry.envs.delete(envId);
  }
  if (changed) rebuild();
}

/** 停用 / 卸载后把不再 active 的插件清掉。 */
export function prunePluginBadges(activePluginIds: ReadonlySet<string>): void {
  let changed = false;
  for (const pluginId of [...entries.keys()]) {
    if (!activePluginIds.has(pluginId)) {
      entries.delete(pluginId);
      changed = true;
    }
  }
  if (changed) rebuild();
}

export function subscribePluginBadges(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPluginBadgeSnapshot(): PluginBadgeSnapshot {
  return snapshot;
}

export function usePluginBadges(): PluginBadgeSnapshot {
  return useSyncExternalStore(subscribePluginBadges, getPluginBadgeSnapshot, getPluginBadgeSnapshot);
}
