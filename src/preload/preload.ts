import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  ApprovalMode,
  BrowserShortcut,
  DevToolsDockMode,
  FindInPageResult,
  NativeMenuItem,
  NavigationAction,
  OverlayRequest,
  PopoverActionEvent,
  PopoverOpenOptions,
  SpaceId,
  ViewportPresetId,
  ViewportRect,
} from '../shared/types';

const api = {
  platform: process.platform,
  list: () => ipcRenderer.invoke('env:list'),
  create: (input: { id: string; proxy?: string; startUrl?: string; headed?: boolean }) =>
    ipcRenderer.invoke('env:create', input),
  start: (id: string) => ipcRenderer.invoke('env:start', id),
  stop: (id: string) => ipcRenderer.invoke('env:stop', id),
  remove: (id: string) => ipcRenderer.invoke('env:remove', id),
  update: (
    id: string,
    patch: { name?: string; proxy?: string; startUrl?: string; headed?: boolean; approval?: ApprovalMode | null },
  ) => ipcRenderer.invoke('env:update', id, patch),
  // 审批策略：写只有这一条（界面的）。RPC 那边只有 settings.get。
  settings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:set', patch),
  moveToGroup: (id: string, groupId?: string) => ipcRenderer.invoke('env:moveToGroup', id, groupId),
  groups: () => ipcRenderer.invoke('group:list'),
  groupCreate: (name: string) => ipcRenderer.invoke('group:create', name),
  groupRename: (id: string, name: string) => ipcRenderer.invoke('group:rename', id, name),
  groupRemove: (id: string) => ipcRenderer.invoke('group:remove', id),
  groupCollapse: (id: string, collapsed: boolean) => ipcRenderer.invoke('group:collapse', id, collapsed),
  select: (id: string) => ipcRenderer.invoke('env:select', id),
  spaceSelect: (id: string, space: SpaceId) => ipcRenderer.invoke('env:selectSpace', id, space),
  selected: () => ipcRenderer.invoke('env:selected'),
  tabCreate: (id: string, space: SpaceId, url?: string, activate?: boolean) =>
    ipcRenderer.invoke('tab:create', id, space, url, activate),
  tabSelect: (id: string, space: SpaceId, ref: number | string) => ipcRenderer.invoke('tab:select', id, space, ref),
  tabClose: (id: string, space: SpaceId, ref: number | string) => ipcRenderer.invoke('tab:close', id, space, ref),
  tabCloseOthers: (id: string, space: SpaceId, ref: number | string) =>
    ipcRenderer.invoke('tab:closeOthers', id, space, ref),
  tabCloseRight: (id: string, space: SpaceId, ref: number | string) =>
    ipcRenderer.invoke('tab:closeRight', id, space, ref),
  tabReorder: (id: string, space: SpaceId, from: number, to: number) =>
    ipcRenderer.invoke('tab:reorder', id, space, from, to),
  tabReopen: (id: string, space: SpaceId) => ipcRenderer.invoke('tab:reopen', id, space),
  tabMute: (id: string, space: SpaceId, ref: number | string, muted: boolean) =>
    ipcRenderer.invoke('tab:mute', id, space, ref, muted),
  takeover: (id: string, space: SpaceId = 'agent') => ipcRenderer.invoke('env:takeover', id, space),
  release: (id: string, space: SpaceId = 'agent') => ipcRenderer.invoke('env:release', id, space),
  events: (id?: string) => ipcRenderer.invoke('events:list', id),
  snapshot: (id: string, space: SpaceId) => ipcRenderer.invoke('browser:snapshot', id, space),
  console: (id: string) => ipcRenderer.invoke('browser:console', id),
  network: (id: string) => ipcRenderer.invoke('browser:network', id),
  cookies: (id: string) => ipcRenderer.invoke('browser:cookies', id),
  netRules: (id: string) => ipcRenderer.invoke('net:rules', id),
  netHits: (id: string, limit?: number) => ipcRenderer.invoke('net:hits', id, limit),
  netRuleSet: (id: string, ruleId: string, enabled: boolean) => ipcRenderer.invoke('net:ruleSet', id, ruleId, enabled),
  netRuleRemove: (id: string, ruleId: string) => ipcRenderer.invoke('net:ruleRemove', id, ruleId),
  navState: (id: string, space: SpaceId) => ipcRenderer.invoke('browser:navState', id, space),
  humanNavigate: (id: string, space: SpaceId, action: NavigationAction) =>
    ipcRenderer.invoke('browser:humanNavigate', id, space, action),
  historySuggest: (query: string, limit?: number) => ipcRenderer.invoke('history:suggest', query, limit),
  openDevTools: (id: string, space: SpaceId, dock?: DevToolsDockMode) =>
    ipcRenderer.invoke('browser:openDevTools', id, space, dock),
  closeDevTools: (id: string, space: SpaceId) => ipcRenderer.invoke('browser:closeDevTools', id, space),
  setDevToolsDock: (dock: DevToolsDockMode, size?: number) => ipcRenderer.invoke('browser:setDevToolsDock', dock, size),
  getDevToolsState: () => ipcRenderer.invoke('browser:getDevToolsState'),
  findInPage: (id: string, space: SpaceId, text: string, options?: { forward?: boolean; findNext?: boolean }) =>
    ipcRenderer.invoke('browser:findInPage', id, space, text, options),
  stopFindInPage: (id: string, space: SpaceId) => ipcRenderer.invoke('browser:stopFindInPage', id, space),
  onFindResult: (callback: (result: FindInPageResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: FindInPageResult) => callback(result);
    ipcRenderer.on('browser:findResult', listener);
    return () => ipcRenderer.removeListener('browser:findResult', listener);
  },
  setZoom: (id: string, space: SpaceId, mode: 'in' | 'out' | 'reset' | number) =>
    ipcRenderer.invoke('browser:setZoom', id, space, mode),
  getZoom: (id: string, space: SpaceId) => ipcRenderer.invoke('browser:getZoom', id, space),
  setViewportPreset: (id: string, space: SpaceId, preset: ViewportPresetId) =>
    ipcRenderer.invoke('browser:setViewportPreset', id, space, preset),
  getViewportPreset: (id: string, space: SpaceId) => ipcRenderer.invoke('browser:getViewportPreset', id, space),
  onTargetUrl: (callback: (payload: { envId: string; url: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { envId: string; url: string }) => callback(payload);
    ipcRenderer.on('browser:targetUrl', listener);
    return () => ipcRenderer.removeListener('browser:targetUrl', listener);
  },
  downloads: (id?: string) => ipcRenderer.invoke('browser:downloads', id),
  revealDownload: (downloadId: string) => ipcRenderer.invoke('browser:revealDownload', downloadId),
  printPage: (id: string, space: SpaceId) => ipcRenderer.invoke('browser:printPage', id, space),
  savePage: (id: string, space: SpaceId) => ipcRenderer.invoke('browser:savePage', id, space),
  popupMenu: (items: NativeMenuItem[], position?: { x: number; y: number }) =>
    ipcRenderer.invoke('ui:popupMenu', items, position),
  openOverlay: <T = unknown>(request: OverlayRequest) =>
    ipcRenderer.invoke('overlay:open', request) as Promise<T | null>,
  getOverlayState: () => ipcRenderer.invoke('overlay:current'),
  resolveOverlay: (result: unknown) => ipcRenderer.invoke('overlay:resolve', result),
  onOverlayState: (callback: (request: OverlayRequest | null) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: OverlayRequest | null) => callback(request);
    ipcRenderer.on('overlay:state', listener);
    return () => ipcRenderer.removeListener('overlay:state', listener);
  },
  openPopover: (options: PopoverOpenOptions) => ipcRenderer.invoke('popover:open', options),
  updatePopover: (id: string, options: Partial<PopoverOpenOptions>) =>
    ipcRenderer.invoke('popover:update', id, options),
  closePopover: (id?: string) => ipcRenderer.invoke('popover:close', id),
  getPopoverState: () => ipcRenderer.invoke('popover:current'),
  dispatchPopoverAction: (event: PopoverActionEvent) => ipcRenderer.invoke('popover:action', event),
  onPopoverState: (callback: (payload: { id: string; props: Record<string, unknown> } | null) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { id: string; props: Record<string, unknown> } | null,
    ) => callback(payload);
    ipcRenderer.on('popover:state', listener);
    return () => ipcRenderer.removeListener('popover:state', listener);
  },
  onPopoverAction: (callback: (event: PopoverActionEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: PopoverActionEvent) => callback(event);
    ipcRenderer.on('popover:action', listener);
    return () => ipcRenderer.removeListener('popover:action', listener);
  },
  onPopoverDismissed: (callback: (payload: { id: string; reason: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; reason: string }) => callback(payload);
    ipcRenderer.on('popover:dismissed', listener);
    return () => ipcRenderer.removeListener('popover:dismissed', listener);
  },
  onBrowserShortcut: (callback: (shortcut: BrowserShortcut) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, shortcut: BrowserShortcut) => callback(shortcut);
    ipcRenderer.on('browser:shortcut', listener);
    return () => ipcRenderer.removeListener('browser:shortcut', listener);
  },
  vault: () => ipcRenderer.invoke('vault:list'),
  vaultAdd: (input: { provider: string; label: string; username?: string; password?: string; token?: string }) =>
    ipcRenderer.invoke('vault:add', input),
  vaultRemove: (ref: string) => ipcRenderer.invoke('vault:remove', ref),
  domainPrefs: (envId?: string) => ipcRenderer.invoke('browser:domainPrefs', envId),
  clearDomainPref: (envId: string, origin: string) => ipcRenderer.invoke('browser:clearDomainPref', envId, origin),
  clearUrlHistory: () => ipcRenderer.invoke('system:clearUrlHistory'),
  systemDoctor: () => ipcRenderer.invoke('system:doctor'),
  openDataDir: () => ipcRenderer.invoke('system:openDataDir'),
  agentSkills: () => ipcRenderer.invoke('agent:skills'),
  agentInstallSkill: (targetId: string) => ipcRenderer.invoke('agent:installSkill', targetId),
  agentRefreshSkills: () => ipcRenderer.invoke('agent:refreshSkills'),
  plugins: () => ipcRenderer.invoke('plugin:list'),
  pluginEnable: (id: string) => ipcRenderer.invoke('plugin:enable', id),
  pluginDisable: (id: string) => ipcRenderer.invoke('plugin:disable', id),
  pluginGrant: (id: string, permissions: string[]) => ipcRenderer.invoke('plugin:grant', id, permissions),
  pluginInstall: (source?: string) =>
    source ? ipcRenderer.invoke('plugin:installSource', source) : ipcRenderer.invoke('plugin:installFromDialog'),
  pluginReload: (id: string) => ipcRenderer.invoke('plugin:reload', id),
  pluginLogs: (id: string, limit?: number) => ipcRenderer.invoke('plugin:logs', id, limit),
  pluginConfigSet: (id: string, key: string, value: string) => ipcRenderer.invoke('plugin:configSet', id, key, value),
  pluginSetSkillExposed: (id: string, exposed: boolean) => ipcRenderer.invoke('plugin:setSkillExposed', id, exposed),
  pluginReadSkill: (id: string) => ipcRenderer.invoke('plugin:readSkill', id),
  pluginRpc: (id: string, method: string, input?: unknown) => ipcRenderer.invoke('plugin:rpc', id, method, input),
  pluginHostRead: (id: string, method: string, environmentId?: string, args?: unknown[]) =>
    ipcRenderer.invoke('plugin:hostRead', id, method, environmentId, args),
  pluginRun: (id: string, command: string, environmentId: string) =>
    ipcRenderer.invoke('plugin:run', id, command, environmentId),
  onPluginSignal: (callback: (signal: { pluginId: string; channel: string; payload: unknown }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      signal: { pluginId: string; channel: string; payload: unknown },
    ) => callback(signal);
    ipcRenderer.on('plugin:signal', listener);
    return () => ipcRenderer.removeListener('plugin:signal', listener);
  },
  setViewport: (viewport: ViewportRect) => ipcRenderer.invoke('layout:viewport', viewport),
  setViewVisible: (visible: boolean) => ipcRenderer.invoke('layout:viewVisible', visible),
  pageSnapshot: () => ipcRenderer.invoke('layout:pageSnapshot'),
  onStateChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
  onEnvDelta: (callback: (payload: { reason?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { reason?: string }) => callback(payload ?? {});
    ipcRenderer.on('env:delta', listener);
    return () => ipcRenderer.removeListener('env:delta', listener);
  },
  onPluginChanged: (callback: (payload: { reason?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { reason?: string }) => callback(payload ?? {});
    ipcRenderer.on('plugin:changed', listener);
    return () => ipcRenderer.removeListener('plugin:changed', listener);
  },
};

contextBridge.exposeInMainWorld('envApi', api);

export type EnvApi = typeof api;
