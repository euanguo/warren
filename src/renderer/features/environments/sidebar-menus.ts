import type { MouseEvent } from 'react';
import { toast } from 'sonner';
import { statusLabel } from '@/lib/labels';
import type { PluginEnvAction } from '@/lib/plugin-runtime';
import type { Environment, Group, NativeMenuItem } from '@shared/types';

export interface EnvMenuActions {
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRemove: (id: string) => void;
  onTakeover: (id: string) => void;
  onRelease: (id: string) => void;
  onMoveToGroup: (envId: string, groupId: string | undefined) => void;
  onRunPluginAction?: (pluginId: string, command: string, envId: string) => void;
}

export interface GroupMenuActions {
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRemoveGroup: (id: string) => void;
  onToggleGroup: (id: string, collapsed: boolean) => void;
}

function copyText(text: string, notice: string): void {
  void navigator.clipboard.writeText(text);
  toast.success(notice, { duration: 1800 });
}

/** 弹出环境行右键原生菜单并分派用户所选操作。 */
export async function openEnvironmentContextMenu(
  event: MouseEvent,
  env: Environment,
  groups: Group[],
  pluginActions: PluginEnvAction[],
  actions: EnvMenuActions,
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();

  const moveSubmenu: NativeMenuItem[] =
    groups.length === 0
      ? [{ label: '还没有分组', enabled: false }]
      : groups.map((target) => ({
          id: `move:${target.id}`,
          label: target.name,
          enabled: env.groupId !== target.id,
        }));
  if (env.groupId) {
    if (moveSubmenu.length > 0) moveSubmenu.push({ type: 'separator' });
    moveSubmenu.push({ id: 'move:__ungrouped__', label: '移出分组' });
  }

  const items: NativeMenuItem[] = [
    { label: `${env.name} (${statusLabel[env.status] ?? env.status})`, enabled: false },
    { type: 'separator' },
    env.status === 'running' ? { id: 'stop', label: '停止' } : { id: 'start', label: '启动' },
    { type: 'separator' },
    { id: 'takeover', label: '接管 Agent Space', enabled: env.owner !== 'human' },
    { id: 'release', label: '交还 Agent Space', enabled: env.owner === 'human' },
    { type: 'separator' },
    { id: 'copy:cli', label: '复制 CLI 寻址' },
    { id: 'copy:url', label: '复制当前 URL', enabled: Boolean(env.currentUrl) },
    { id: 'open:external', label: '在外部浏览器打开', enabled: Boolean(env.currentUrl) },
    { type: 'separator' },
    { id: 'edit', label: '编辑…' },
    { label: '移动到分组', type: 'submenu', submenu: moveSubmenu },
  ];

  if (pluginActions.length > 0) {
    items.push({ type: 'separator' });
    for (const action of pluginActions) {
      items.push({
        id: `plugin:${action.pluginId}:${action.id}`,
        label: action.title,
      });
    }
  }

  items.push({ type: 'separator' }, { id: 'remove', label: '删除环境…' });

  const picked = await window.envApi.popupMenu(items, {
    x: Math.round(event.clientX),
    y: Math.round(event.clientY),
  });
  if (!picked) return;

  if (picked === 'start') actions.onStart(env.id);
  else if (picked === 'stop') actions.onStop(env.id);
  else if (picked === 'takeover') actions.onTakeover(env.id);
  else if (picked === 'release') actions.onRelease(env.id);
  else if (picked === 'copy:cli') copyText(`warren exec ${env.id}`, '已复制 CLI 寻址');
  else if (picked === 'copy:url' && env.currentUrl) copyText(env.currentUrl, '已复制当前 URL');
  else if (picked === 'open:external' && env.currentUrl) window.open(env.currentUrl, '_blank');
  else if (picked === 'edit') {
    void window.envApi.openOverlay({ kind: 'edit-env', environment: env });
  } else if (picked.startsWith('move:')) {
    const targetId = picked.slice(5);
    actions.onMoveToGroup(env.id, targetId === '__ungrouped__' ? undefined : targetId);
  } else if (picked.startsWith('plugin:')) {
    const rest = picked.slice(7);
    const sep = rest.indexOf(':');
    const pluginId = rest.slice(0, sep);
    const actionId = rest.slice(sep + 1);
    const action = pluginActions.find((item) => item.pluginId === pluginId && item.id === actionId);
    if (action) actions.onRunPluginAction?.(action.pluginId, action.command, env.id);
  } else if (picked === 'remove') {
    const confirmed = await window.envApi.openOverlay<boolean>({
      kind: 'confirm',
      title: `删除环境「${env.name}」？`,
      description: '该环境的独立浏览器存储（Cookie、登录态）会一并删除，无法撤销。',
      confirmLabel: '删除',
      destructive: true,
    });
    if (confirmed) actions.onRemove(env.id);
  }
}

/** 弹出分组标题右键原生菜单并分派用户所选操作。 */
export async function openGroupContextMenu(
  event: MouseEvent,
  group: Group,
  groupEnvs: Environment[],
  actions: GroupMenuActions,
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();

  const items: NativeMenuItem[] = [
    { label: group.name, enabled: false },
    { type: 'separator' },
    { id: 'create-env', label: '新建环境…' },
    { id: 'rename', label: '重命名分组…' },
    { id: 'toggle', label: group.collapsed ? '展开' : '折叠' },
    { type: 'separator' },
    { id: 'start-all', label: '启动组内全部' },
    { id: 'stop-all', label: '停止组内全部' },
    { id: 'copy-cli', label: '复制组内 CLI 寻址' },
    { type: 'separator' },
    { id: 'remove', label: '删除分组（环境保留）' },
  ];

  const picked = await window.envApi.popupMenu(items, {
    x: Math.round(event.clientX),
    y: Math.round(event.clientY),
  });
  if (!picked) return;

  if (picked === 'create-env') {
    void window.envApi.openOverlay({ kind: 'create-env', initialGroupId: group.id });
  } else if (picked === 'rename') {
    const next = await window.envApi.openOverlay<string>({
      kind: 'rename',
      title: '重命名分组',
      label: '分组名',
      initialValue: group.name,
    });
    if (next) actions.onRenameGroup(group.id, next);
  } else if (picked === 'toggle') {
    actions.onToggleGroup(group.id, !group.collapsed);
  } else if (picked === 'start-all') {
    groupEnvs.forEach((env) => actions.onStart(env.id));
  } else if (picked === 'stop-all') {
    groupEnvs.forEach((env) => actions.onStop(env.id));
  } else if (picked === 'copy-cli') {
    copyText(
      groupEnvs.map((env) => `warren exec ${env.id}`).join('\n'),
      `已复制 ${groupEnvs.length} 个环境的 CLI 寻址`,
    );
  } else if (picked === 'remove') {
    const confirmed = await window.envApi.openOverlay<boolean>({
      kind: 'confirm',
      title: `删除分组「${group.name}」？`,
      description: '组内环境会保留并移出分组，不会被删除。',
      confirmLabel: '删除',
      destructive: true,
    });
    if (confirmed) actions.onRemoveGroup(group.id);
  }
}
