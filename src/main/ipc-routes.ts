/**
 * Electron 主进程 IPC 路由表与发送方鉴权。
 */
import { app, dialog, ipcMain, nativeTheme, shell, type BrowserWindow, type WebContents } from 'electron';
import os from 'node:os';
import type { Permission } from '../shared/permissions.ts';
import type {
  AppSettings,
  ApprovalMode,
  DevToolsDockMode,
  NativeMenuItem,
  NavigationAction,
  OverlayRequest,
  PopoverActionEvent,
  PopoverId,
  PopoverOpenOptions,
  PopoverUpdateOptions,
  SpaceId,
  TabRef,
  ViewportPresetId,
  ViewportRect,
} from '../shared/types.ts';
import { installSkill, refreshSkills, skillStatus } from './agent-integration.ts';
import { makeEvent } from './domain/environment.ts';
import type { EnvironmentManager } from './environments.ts';
import type { MemoryMonitor } from './memory-monitor.ts';
import type { PluginHost } from './plugins/host.ts';
import { RUNTIME_FILE, SOCKET_PATH } from './rpc.ts';
import type { Store } from './store.ts';
import { collectSystemDiagnostics } from './system-doctor.ts';
import { popupNativeMenu } from './ui/native-menu.ts';
import type { OverlayHost } from './ui/overlay-host.ts';
import type { PopoverHost } from './ui/popover-host.ts';

export interface IpcRoutesDeps {
  getWindow: () => BrowserWindow | undefined;
  getOverlayHost: () => OverlayHost | undefined;
  getPopoverHost: () => PopoverHost | undefined;
  getManager: () => EnvironmentManager;
  getPlugins: () => PluginHost;
  getMemoryMonitor?: () => MemoryMonitor | undefined;
  store: Store;
  homeDir: string;
  coreDir: string;
  skillSourceDir: () => string;
  broadcastEnvDelta: (reason?: string) => void;
  broadcastPluginChanged: (reason?: string) => void;
}

export function isAuthorizedShellSender(
  sender: WebContents,
  window: BrowserWindow | undefined,
  overlayHost: OverlayHost | undefined,
  popoverHost: PopoverHost | undefined,
): boolean {
  if (sender === window?.webContents) return true;
  if (overlayHost?.webContents && sender === overlayHost.webContents) return true;
  if (popoverHost?.isOwnedWebContents(sender)) return true;
  return false;
}

export function registerIpcRoutes(deps: IpcRoutesDeps): void {
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== deps.getWindow()?.webContents) throw new Error('unauthorized sender');
      return fn(...(args as A));
    });
  };
  const handleCoreShell = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== deps.getWindow()?.webContents && event.sender !== deps.getOverlayHost()?.webContents) {
        throw new Error('unauthorized sender');
      }
      return fn(...(args as A));
    });
  };
  const handleShell = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isAuthorizedShellSender(event.sender, deps.getWindow(), deps.getOverlayHost(), deps.getPopoverHost())) {
        throw new Error('unauthorized sender');
      }
      return fn(...(args as A));
    });
  };

  handleShell('env:list', () => deps.getManager().list());
  handleCoreShell(
    'env:create',
    (input: { id: string; name?: string; proxy?: string; startUrl?: string; headed?: boolean }) =>
      deps.getManager().create({ ...input, createdBy: 'human' }),
  );
  handleShell('env:start', (id: string) => deps.getManager().start(id));
  handleCoreShell('env:stop', (id: string) => deps.getManager().stop(id));
  handleShell('env:hibernate', (id: string) => ({ ok: deps.getManager().hibernate(id, 'manual') }));
  handleShell('env:hibernateBackground', () => {
    const hibernated = deps.getManager().hibernateBackground('manual-batch');
    return { hibernated, count: hibernated.length };
  });
  handleShell('env:wake', (id: string) => ({ ok: deps.getManager().wake(id) }));
  handleShell('env:clearCache', (id: string) => deps.getManager().clearCache(id));
  handleCoreShell('system:clearAllCaches', () => deps.getManager().clearAllCaches());
  handleCoreShell('env:remove', (id: string) => deps.getManager().remove(id));
  handleCoreShell(
    'env:update',
    (
      id: string,
      patch: { name?: string; proxy?: string; startUrl?: string; headed?: boolean; approval?: ApprovalMode | null },
    ) => deps.getManager().update(id, patch),
  );

  // 审批策略只有界面 IPC 能写；RPC 侧故意只暴露只读 settings.get
  handleShell('settings:get', () => deps.store.appSettings());
  handle('settings:set', (patch: Partial<AppSettings>) => {
    const next = deps.store.setAppSettings(patch);
    const mgr = deps.getManager();
    mgr.applySettings(next);
    deps.getMemoryMonitor?.()?.configure({ softLimitMb: next.memorySoftLimitMb });
    mgr.setShieldTheme(
      next.theme === 'light' ? 'light' : next.theme === 'system' && !nativeTheme.shouldUseDarkColors ? 'light' : 'dark',
    );
    deps.store.record(makeEvent('settings.updated', `应用设置更新: ${JSON.stringify(patch)}`, 'human'));
    deps.broadcastEnvDelta('settings');
    deps.broadcastPluginChanged('settings');
    return next;
  });
  handleShell('env:moveToGroup', (id: string, groupId?: string) => deps.getManager().moveToGroup(id, groupId));

  handleShell('group:list', () => deps.getManager().listGroups());
  handleCoreShell('group:create', (name: string) => deps.getManager().createGroup({ name }));
  handleCoreShell('group:rename', (id: string, name: string) => deps.getManager().renameGroup(id, name));
  handleCoreShell('group:remove', (id: string) => deps.getManager().removeGroup(id));
  handleShell('group:collapse', (id: string, collapsed: boolean) => deps.getManager().setGroupCollapsed(id, collapsed));
  handleShell('env:select', (id: string) => deps.getManager().select(id));
  handleShell('env:selectSpace', (id: string, space: SpaceId) => deps.getManager().selectSpace(id, space));
  handleShell('env:selected', () => deps.getManager().selectedId() ?? null);
  handle('env:takeover', (id: string, space: SpaceId = 'agent') => deps.getManager().takeover(id, 'human', space));
  handle('env:release', (id: string, _space: SpaceId = 'agent') => {
    const mgr = deps.getManager();
    const env = mgr.get(id);
    if (env?.leaseId) mgr.release(id, env.leaseId, 'human');
  });
  handle('events:list', (id?: string) => deps.store.events(id));

  handleShell('tab:create', (id: string, space: SpaceId, url?: string, activate?: boolean) =>
    deps.getManager().newTab(id, url, { activate }, space),
  );
  handle('tab:select', (id: string, space: SpaceId, ref: TabRef) => deps.getManager().selectTab(id, space, ref));
  handle('tab:close', (id: string, space: SpaceId, ref: TabRef) => deps.getManager().closeTab(id, space, ref));
  handle('tab:closeOthers', (id: string, space: SpaceId, ref: TabRef) =>
    deps.getManager().closeTabs(id, space, ref, 'others'),
  );
  handle('tab:closeRight', (id: string, space: SpaceId, ref: TabRef) =>
    deps.getManager().closeTabs(id, space, ref, 'right'),
  );
  handle('tab:reorder', (id: string, space: SpaceId, from: number, to: number) =>
    deps.getManager().reorderTab(id, space, from, to),
  );
  handle('tab:reopen', (id: string, space: SpaceId) => deps.getManager().reopenTab(id, space));
  handle('tab:mute', (id: string, space: SpaceId, ref: TabRef, muted: boolean) =>
    deps.getManager().muteTab(id, space, ref, muted),
  );
  handleShell('tab:sleep', (id: string, space: SpaceId, ref: TabRef) => ({
    ok: deps.getManager().sleepTab(id, space, ref),
  }));
  handleShell('tab:sleepIdle', (id?: string) => ({ slept: deps.getManager().sleepIdleTabs(id) }));

  handle('browser:snapshot', async (id: string, space: SpaceId) => {
    const controller = deps.getManager().controllerFor(id, undefined, space);
    return {
      url: controller.currentUrl(),
      title: await controller.title(),
      nodes: await controller.snapshot(),
    };
  });
  handle('browser:console', (id: string) => deps.getManager().consoleEntries(id));
  handle('browser:network', (id: string) => deps.getManager().networkEntries(id));
  handle('browser:cookies', (id: string) => deps.getManager().cookieNames(id));

  const humanNetWrite = <T>(id: string, fn: () => T): T => {
    if (deps.getManager().get(id)?.owner === 'agent') {
      throw new Error('ENV_BUSY: agent 正在控制该环境，等它交还后再改网络规则');
    }
    return fn();
  };
  handle('net:rules', (id: string) => deps.getManager().netRules(id));
  handle('net:hits', (id: string, limit?: number) => deps.getManager().netHits(id, limit));
  handle('net:ruleSet', (id: string, ruleId: string, enabled: boolean) =>
    humanNetWrite(id, () => deps.getManager().netSetRuleEnabled(id, ruleId, enabled, 'human')),
  );
  handle('browser:navState', (id: string, space: SpaceId) => deps.getManager().navState(id, space) ?? null);
  handleShell('browser:humanNavigate', (id: string, space: SpaceId, action: NavigationAction) =>
    deps.getManager().humanNavigate(id, action, space),
  );
  handleShell('history:suggest', (query: string, limit?: number) => deps.store.searchUrlHistory(query, limit));
  handle('layout:viewport', (viewport: ViewportRect) => {
    deps.getManager().setViewport(viewport);
  });
  handle('layout:viewVisible', (visible: boolean) => {
    deps.getManager().setViewVisible(visible);
  });
  handleShell('browser:openDevTools', (id: string, space: SpaceId, dock?: DevToolsDockMode) =>
    deps.getManager().openDevTools(id, space, dock),
  );
  handleShell('browser:closeDevTools', (id: string, space: SpaceId) => deps.getManager().closeDevTools(id, space));
  handleShell('browser:setDevToolsDock', (dock: DevToolsDockMode, size?: number) =>
    deps.getManager().setDevToolsDock(dock, size),
  );
  handleShell('browser:getDevToolsState', () => deps.getManager().getDevToolsState());
  handleShell(
    'browser:findInPage',
    (id: string, space: SpaceId, text: string, options?: { forward?: boolean; findNext?: boolean }) =>
      deps.getManager().findInPage(id, space, text, options),
  );
  handleShell('browser:stopFindInPage', (id: string, space: SpaceId) => deps.getManager().stopFindInPage(id, space));
  handleShell('browser:setZoom', (id: string, space: SpaceId, mode: 'in' | 'out' | 'reset' | number) =>
    deps.getManager().setZoom(id, space, mode),
  );
  handleShell('browser:getZoom', (id: string, space: SpaceId) => deps.getManager().getZoom(id, space));
  handleShell('browser:setViewportPreset', (id: string, space: SpaceId, preset: ViewportPresetId) =>
    deps.getManager().setViewportPreset(id, space, preset),
  );
  handleShell('browser:getViewportPreset', (id: string, space: SpaceId) =>
    deps.getManager().getViewportPreset(id, space),
  );
  handleShell('browser:downloads', (id?: string) => deps.getManager().downloads(id));
  handleShell('browser:revealDownload', (downloadId: string) => deps.getManager().revealDownload(downloadId));
  handleCoreShell('browser:printPage', (id: string, space: SpaceId) => deps.getManager().printPage(id, space));
  handleCoreShell('browser:savePage', (id: string, space: SpaceId) => deps.getManager().savePageAs(id, space));
  handleShell('browser:highlight', async (id: string, space: SpaceId, target?: string) => {
    await deps
      .getManager()
      .controllerFor(id, undefined, space)
      .highlight(target ? { kind: 'selector', selector: target } : undefined);
  });

  handle('ui:popupMenu', (items: NativeMenuItem[], position?: { x: number; y: number }) => {
    const win = deps.getWindow();
    if (!win) return null;
    return popupNativeMenu(win, items, position);
  });

  handle('overlay:open', (request: OverlayRequest) => deps.getOverlayHost()?.open(request) ?? null);
  handleShell('overlay:current', () => deps.getOverlayHost()?.currentState() ?? null);
  handleShell('overlay:resolve', (result: unknown) => {
    deps.getOverlayHost()?.resolve(result);
  });
  handle('popover:open', (options: PopoverOpenOptions) => deps.getPopoverHost()?.open(options));
  handleShell('popover:update', (id: PopoverId, options: PopoverUpdateOptions) =>
    deps.getPopoverHost()?.update(id, options),
  );
  handleShell('popover:close', (id?: PopoverId) => {
    deps.getPopoverHost()?.close(id);
  });
  handleShell('popover:current', () => deps.getPopoverHost()?.currentState() ?? null);
  handleShell('popover:action', (event: PopoverActionEvent) => {
    deps.getPopoverHost()?.emitAction(event);
  });

  handle('browser:domainPrefs', (envId?: string) => deps.store.listDomainPrefs(envId));
  handle('browser:clearDomainPref', (envId: string, origin: string) => {
    const removed = deps.store.removeDomainPref(envId, origin);
    if (removed) {
      deps.broadcastEnvDelta('domainPrefs');
    }
    return { removed };
  });
  handle('system:clearUrlHistory', () => ({ cleared: deps.store.clearUrlHistory() }));
  handle('system:openDataDir', async () => {
    const err = await shell.openPath(deps.homeDir);
    return { opened: err === '' };
  });
  handle('system:doctor', () =>
    collectSystemDiagnostics({
      appVersion: app.getVersion(),
      dataDir: deps.homeDir,
      coreDir: deps.coreDir,
      socketPath: SOCKET_PATH,
      runtimeFile: RUNTIME_FILE,
      skillSourceDir: deps.skillSourceDir(),
      db: deps.store.database,
      store: deps.store,
      manager: deps.getManager(),
      plugins: deps.getPlugins(),
    }),
  );
  handleShell('system:memorySnapshot', async () => {
    const monitor = deps.getMemoryMonitor?.();
    if (!monitor) throw new Error('memory monitor is not initialized');
    return monitor.snapshot();
  });
  handleShell('system:reclaimShell', () => ({
    reclaimed: deps.getMemoryMonitor?.()?.reclaimShellSurfaces(0) ?? 0,
  }));

  handle('agent:skills', async () =>
    skillStatus(os.homedir(), deps.skillSourceDir(), await deps.getPlugins().skillEntries()),
  );
  handle('agent:installSkill', async (targetId: string) =>
    installSkill(os.homedir(), deps.skillSourceDir(), targetId, await deps.getPlugins().skillEntries()),
  );
  handle('agent:refreshSkills', async () =>
    refreshSkills(os.homedir(), deps.skillSourceDir(), await deps.getPlugins().skillEntries()),
  );

  const pluginsChanged = async <T>(action: () => Promise<T>): Promise<T> => {
    const result = await action();
    deps.broadcastPluginChanged('plugins');
    return result;
  };

  handleShell('plugin:list', () => deps.getPlugins().list());
  handle('plugin:enable', (id: string) => pluginsChanged(() => deps.getPlugins().enable(id)));
  handle('plugin:disable', (id: string) => pluginsChanged(() => deps.getPlugins().disable(id)));
  handle('plugin:uninstall', (id: string) => pluginsChanged(() => deps.getPlugins().uninstall(id)));
  handle('plugin:reload', (id: string) => pluginsChanged(() => deps.getPlugins().reload(id)));
  handle('plugin:grant', (id: string, permissions: Permission[]) => deps.getPlugins().grant(id, permissions));
  handle('plugin:logs', (id: string, limit?: number) => deps.getPlugins().logs(id, limit));
  handle('plugin:configSet', (id: string, key: string, value: string) =>
    pluginsChanged(() => deps.getPlugins().setSetting(id, key, value)),
  );
  handle('plugin:setSkillExposed', (id: string, exposed: boolean) =>
    pluginsChanged(() => deps.getPlugins().setSkillExposed(id, exposed)),
  );
  handle('plugin:readSkill', (id: string) => deps.getPlugins().readSkill(id));
  handleShell('plugin:rpc', (id: string, method: string, input?: unknown) =>
    deps.getPlugins().rpc(id, method, input, { caller: 'ui' }),
  );
  handleShell('plugin:hostRead', (id: string, method: string, environmentId?: string, args?: unknown[]) =>
    deps.getPlugins().hostRead(id, method, environmentId, args ?? []),
  );
  handleShell('plugin:run', (id: string, command: string, environmentId?: string) =>
    pluginsChanged(() => deps.getPlugins().run(id, command, { environmentId: environmentId ?? '', caller: 'ui' })),
  );
  handle('plugin:installSource', async (source: string) => {
    const plugin = await pluginsChanged(() => deps.getPlugins().install(source));
    return { cancelled: false, plugin };
  });
  handle('plugin:installFromDialog', async () => {
    const win = deps.getWindow();
    if (!win) return { cancelled: true };
    const result = await dialog.showOpenDialog(win, {
      title: '选择插件包目录（含 package.json）',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    const plugin = await pluginsChanged(() => deps.getPlugins().install(`path:${result.filePaths[0]!}`));
    return { cancelled: false, plugin };
  });
}
