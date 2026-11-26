import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { Environment, EventRecord, Group, NavigationAction, SpaceId, TabRef } from '@shared/types';

export interface EnvironmentSnapshot {
  environments: Environment[];
  groups: Group[];
  events: EventRecord[];
  selected?: string;
  ready: boolean;
}

let state: EnvironmentSnapshot = {
  environments: [],
  groups: [],
  events: [],
  selected: undefined,
  ready: false,
};

let started = false;
let refreshing = false;
let pendingRefresh = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  ensureEnvironmentStoreStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function refreshEnvironments(): Promise<void> {
  if (typeof window === 'undefined' || !window.envApi) return;
  if (refreshing) {
    pendingRefresh = true;
    return;
  }
  refreshing = true;
  try {
    const [environments, groups, selectedId, events] = await Promise.all([
      window.envApi.list(),
      window.envApi.groups(),
      window.envApi.selected(),
      window.envApi.events(),
    ]);
    const nextSelected = selectedId ?? environments[0]?.id;
    state = {
      environments,
      groups,
      events,
      selected: nextSelected,
      ready: true,
    };
    emit();
  } finally {
    refreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      void refreshEnvironments();
    }
  }
}

export function ensureEnvironmentStoreStarted(): void {
  if (started || typeof window === 'undefined' || !window.envApi) return;
  started = true;
  void refreshEnvironments();
  window.envApi.onEnvDelta(() => {
    void refreshEnvironments();
  });
}

export function getEnvironmentSnapshot(): EnvironmentSnapshot {
  return state;
}

export function useEnvironmentState(): EnvironmentSnapshot {
  return useSyncExternalStore(subscribe, getEnvironmentSnapshot, getEnvironmentSnapshot);
}

async function runAction(action: () => Promise<unknown>, failureMessage: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    toast.error(failureMessage, {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

export const environmentActions = {
  select: (id: string) => runAction(() => window.envApi.select(id), '切换环境失败'),
  selectSpace: (id: string, space: SpaceId) => runAction(() => window.envApi.spaceSelect(id, space), '切换空间失败'),
  start: (id: string) => runAction(() => window.envApi.start(id), '启动失败'),
  stop: (id: string) => runAction(() => window.envApi.stop(id), '停止失败'),
  remove: (id: string) => runAction(() => window.envApi.remove(id), '删除失败'),
  takeover: (id: string, space: SpaceId = 'agent') => runAction(() => window.envApi.takeover(id, space), '接管失败'),
  release: (id: string, space: SpaceId = 'agent') => runAction(() => window.envApi.release(id, space), '交还失败'),
  renameGroup: (id: string, name: string) => runAction(() => window.envApi.groupRename(id, name), '重命名分组失败'),
  removeGroup: (id: string) => runAction(() => window.envApi.groupRemove(id), '删除分组失败'),
  toggleGroup: (id: string, collapsed: boolean) =>
    runAction(() => window.envApi.groupCollapse(id, collapsed), '切换分组失败'),
  moveToGroup: (id: string, groupId: string | undefined) =>
    runAction(() => window.envApi.moveToGroup(id, groupId), '移动分组失败'),
  tabCreate: (id: string, space: SpaceId, url?: string, activate = true) =>
    runAction(() => window.envApi.tabCreate(id, space, url, activate), '新建标签失败'),
  tabSelect: (id: string, space: SpaceId, ref: TabRef) =>
    runAction(() => window.envApi.tabSelect(id, space, ref), '切换标签失败'),
  tabClose: (id: string, space: SpaceId, ref: TabRef) =>
    runAction(() => window.envApi.tabClose(id, space, ref), '关闭标签失败'),
  tabCloseOthers: (id: string, space: SpaceId, ref: TabRef) =>
    runAction(() => window.envApi.tabCloseOthers(id, space, ref), '关闭其他标签失败'),
  tabCloseRight: (id: string, space: SpaceId, ref: TabRef) =>
    runAction(() => window.envApi.tabCloseRight(id, space, ref), '关闭右侧标签失败'),
  tabReorder: (id: string, space: SpaceId, from: number, to: number) =>
    runAction(() => window.envApi.tabReorder(id, space, from, to), '调整标签顺序失败'),
  tabReopen: (id: string, space: SpaceId) => runAction(() => window.envApi.tabReopen(id, space), '恢复关闭标签失败'),
  tabMute: (id: string, space: SpaceId, ref: TabRef, muted: boolean) =>
    runAction(() => window.envApi.tabMute(id, space, ref, muted), '切换静音失败'),
  navigate: (id: string, space: SpaceId, action: NavigationAction) =>
    runAction(() => window.envApi.humanNavigate(id, space, action), '导航失败'),
};
