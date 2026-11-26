import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerSaveBlocker,
  protocol,
  session,
  shell,
  Tray,
} from 'electron';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { warrenPaths } from './paths.ts';
import { EnvironmentManager } from './environments';
import { closeDatabases } from './db';
import { PluginHost } from './plugins/host';
import type { Permission } from './plugins/package.ts';
import { RpcServer } from './rpc';
import { Store } from './store';
import { makeEvent } from './domain/environment';
import { SafeStorageEncryptor } from './vault/electron-encryptor';
import { VaultStore } from './vault/store';
import { loadCredentials, saveCredentials } from './vault/persistence';
import type {
  AppSettings,
  ApprovalMode,
  DevToolsDockMode,
  NativeMenuItem,
  NavigationAction,
  OverlayRequest,
  PopoverActionEvent,
  PopoverOpenOptions,
  SpaceId,
  TabRef,
  ViewportPresetId,
  ViewportRect,
} from '../shared/types';
import { BROWSER_MENU_SHORTCUTS, browserShortcut } from './browser-shortcuts';
import { isOpenableExternalUrl } from './external-url';
import { installSkill, skillStatus } from './agent-integration';
import { WindowLayerManager } from './ui/layer-manager.ts';
import { OverlayHost } from './ui/overlay-host.ts';
import { PopoverHost } from './ui/popover-host.ts';
import { popupNativeMenu } from './ui/native-menu.ts';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

/*
 * 应用名。
 *
 * 开发态跑的是 `Electron.app`，`app.name` 会取到 Electron 自己的名字 —— 菜单栏第一项
 * （`role: 'appMenu'` 的 label）就显示成 "Electron"，关于面板、通知里也是。
 * 必须在 **`app.setPath('userData')` 之前**调：userData 默认是
 * `~/Library/Application Support/<app name>`，先改名会挪一次目录（我们紧接着就显式
 * setPath 到数据根，所以这里只是别让它在中间多建一个目录）。
 */
app.setName('Warren');

/*
 * 数据根：应用产生的一切都在 `<root>/` 下（见 src/main/paths.ts）。
 *
 * 这一段必须在**模块顶层**跑完 —— Electron 的 `app.setPath` 要求「ready 之前」，
 * 而且目标目录必须已经存在（不存在会直接抛）。`whenReady()` 在文件后半段。
 */
const paths = warrenPaths();
for (const dir of [paths.app, paths.core, paths.logs, paths.crashDumps]) {
  mkdirSync(dir, { recursive: true });
}
app.setPath('userData', paths.app);
// 渲染层的 cookie / 缓存跟着 sessionData 走，不显式设的话它不跟着 userData
app.setPath('sessionData', paths.app);
app.setPath('logs', paths.logs);
app.setPath('crashDumps', paths.crashDumps);

const coreDir = paths.core;

/**
 * 自带 Skill（`skills/warren/SKILL.md`）的源目录。
 *
 * 开发时在仓库根下；打包后由 `forge.config.cjs` 的 `extraResource` 带到
 * `Contents/Resources/skills`。**唯一真相是仓库里那个文件**，这里只是解析路径。
 */
function skillSourceDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(__dirname, '../../skills');
}

/**
 * 插件前端 bundle 的协议。必须在 app ready **之前**注册特权，
 * 否则渲染层 `import()` 会被当成不透明来源拒绝（`secure` 也决定模块脚本能不能跑）。
 *
 * 注意：这个 scheme 同时要写进渲染层的 CSP（`src/renderer/index.html`），
 * 少了那一条插件页面永远白屏。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'warren-plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // 渲染层在 http://localhost:5173（开发）或 file://（打包），到 warren-plugin:// 是跨源。
      // 不开 corsEnabled 的话请求在 CORS 层就被拦掉，连协议处理器都不会被调用
      // ——症状是「Failed to fetch dynamically imported module」，且主进程一条日志都没有。
      corsEnabled: true,
    },
  },
  {
    // 内置页面（新标签页）。同样必须在 app ready 之前注册特权，
    // `standard: true` 才会给 `warren://newtab/` 一个正常的 origin 和相对路径语义。
    scheme: 'warren',
    privileges: { standard: true, secure: true },
  },
]);

const store = new Store(coreDir);
const encryptor = new SafeStorageEncryptor();
const vault = new VaultStore(encryptor);

let manager: EnvironmentManager;
let plugins: PluginHost;
let rpc: RpcServer;
let window: BrowserWindow | undefined;
let layers: WindowLayerManager | undefined;
let overlayHost: OverlayHost | undefined;
let popoverHost: PopoverHost | undefined;
let tray: Tray | undefined;
let quitting = false;
let suspensionBlocker: number | undefined;

function broadcastStateChanged(): void {
  window?.webContents.send('state:changed');
  overlayHost?.webContents.send('state:changed');
  popoverHost?.broadcast('state:changed');
}

async function loadVault(): Promise<void> {
  // 凭据落在 warren.db 的 vault 表（只存密文）；老的 vault.json 在第一次打开空表时导入
  vault.load(await loadCredentials(store.database, coreDir));
}

async function saveVault(): Promise<void> {
  saveCredentials(store.database, vault.serialize());
}

/**
 * 代理认证挑战。凭据从 Vault 取，密码只在这一层短暂出现，不进入页面。
 * 没有匹配的凭据就拒绝——静默放行会让流量裸奔。
 */
function resolveProxyCredential(host: string): { username: string; password: string } | null {
  const match = vault.list().find((item) => item.provider === 'proxy' && item.label === host);
  if (!match) return null;
  try {
    const secret = vault.reveal(match.ref);
    if (!secret.username || !secret.password) return null;
    return { username: secret.username, password: secret.password };
  } catch {
    return null;
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    // 渲染层首帧之前的窗口底色。取外壳色，避免启动时闪一圈黑。
    backgroundColor: '#1c1c1c',
    titleBarStyle: 'hiddenInset',
    // macOS 的窗口/Dock 图标由 app bundle 决定，这个参数只有 Windows/Linux 认
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  win.webContents.on('before-input-event', (event, input) => {
    const shortcut = browserShortcut(input);
    if (!shortcut) return;
    event.preventDefault();
    win.webContents.send('browser:shortcut', shortcut);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 只放 http/https：`openExternal` 是任意协议处理器，`file://` / `smb://` 会被系统照单全收
    if (isOpenableExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关闭窗口 = 隐藏到托盘，不销毁 WebContentsView。真正退出走菜单「退出」。
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    popoverHost?.close(undefined, 'host');
    manager?.backgroundWindow();
  });

  win.on('resize', () => {
    overlayHost?.syncBounds();
  });

  return win;
}

/**
 * 应用菜单。
 *
 * 三处和默认菜单不同，都是有原因的：
 *
 * 1. **默认的 View 组要换掉**：`⌥⌘I` 是 Toggle Developer Tools，作用在**窗口自己的
 *    webContents**（也就是 app 界面），会开出我们不需要的 devtools。这两个键要留给
 *    「当前浏览器的页面」，所以那一组不放 devtools 项，改由页面的 `before-input-event`
 *    识别后转给渲染层（`browser-shortcuts.ts`）。
 * 2. **默认的 `reload` / `close` 要撤掉**：它们分别是 ⌘R / ⌘W，在 macOS 上菜单加速键
 *    先于页面拿到按键，留着的话 ⌘R 会重载整个应用界面、⌘W 会关掉整个窗口。这两个键
 *    归「当前页面 / 当前标签」，所以由下面的「浏览器」组承载。
 * 3. 「窗口」组自己拼，不含 `close` —— ⌘W 已经给「关闭标签」了。
 */
function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      /*
       * 应用菜单手写而不是用 `role: 'appMenu'`：role 的 label 取 `app.name`，
       * 开发态那个值是 "Electron"（见文件顶部的 app.setName）。手写才能保证菜单栏
       * 第一项就是我们自己的名字。
       */
      {
        label: app.name,
        submenu: [
          { role: 'about', label: `关于 ${app.name}` },
          { type: 'separator' },
          { role: 'services', label: '服务' },
          { type: 'separator' },
          { role: 'hide', label: `隐藏 ${app.name}` },
          { role: 'hideOthers', label: '隐藏其他' },
          { role: 'unhide', label: '全部显示' },
          { type: 'separator' },
          { role: 'quit', label: `退出 ${app.name}` },
        ],
      },
      /*
       * 编辑 / 显示两栏也手写：role 只给了**顶层** label（"Edit" / "View"），
       * 底下那一串（Undo / Copy / Zoom…）是 Electron 内置的英文，没法用 role 改。
       * 这里只把顶层改成中文，和旁边的「浏览器」「窗口」对齐 —— 里面仍然是 role 的英文项。
       */
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: '浏览器',
        submenu: BROWSER_MENU_SHORTCUTS.map(({ shortcut, accelerator, label }) => ({
          label,
          accelerator,
          // 加速键本身不在主进程执行：渲染层才知道当前选中的环境、标签和地址栏。
          click: () => window?.webContents.send('browser:shortcut', shortcut),
        })),
      },
      {
        label: '显示',
        submenu: [{ role: 'togglefullscreen' }],
      },
      {
        label: '窗口',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
      },
    ]),
  );
}

function isAuthorizedShellSender(sender: Electron.WebContents): boolean {
  if (sender === window?.webContents) return true;
  if (sender === overlayHost?.webContents) return true;
  if (popoverHost?.isOwnedWebContents(sender)) return true;
  return false;
}

function registerIpc(): void {
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== window?.webContents) throw new Error('unauthorized sender');
      return fn(...(args as A));
    });
  };
  const handleShell = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isAuthorizedShellSender(event.sender)) throw new Error('unauthorized sender');
      return fn(...(args as A));
    });
  };

  handleShell('env:list', () => manager.list());
  handleShell('env:create', (input: { id: string; proxy?: string; startUrl?: string; headed?: boolean }) =>
    // 走界面的一定是人。走 RPC 的是 agent —— 审批策略按这个判（计划 §3.3）
    manager.create({ ...input, createdBy: 'human' }),
  );
  handleShell('env:start', (id: string) => manager.start(id));
  handleShell('env:stop', (id: string) => manager.stop(id));
  handleShell('env:remove', (id: string) => manager.remove(id));
  handleShell(
    'env:update',
    (
      id: string,
      patch: { name?: string; proxy?: string; startUrl?: string; headed?: boolean; approval?: ApprovalMode | null },
    ) => manager.update(id, patch),
  );

  /*
   * 审批策略：**只有界面能写**。RPC 那边只有 `settings.get`（读），没有写 ——
   * agent 能给自己放行的话这道门就等于不存在。见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3.4。
   */
  handleShell('settings:get', () => store.appSettings());
  handle('settings:set', (patch: Partial<AppSettings>) => {
    const next = store.setAppSettings(patch);
    store.record(makeEvent('settings.updated', `审批策略更新: ${JSON.stringify(patch)}`, 'human'));
    broadcastStateChanged();
    return next;
  });
  handleShell('env:moveToGroup', (id: string, groupId?: string) => manager.moveToGroup(id, groupId));

  // 分组只影响侧栏组织方式，不碰运行时
  handleShell('group:list', () => manager.listGroups());
  handleShell('group:create', (name: string) => manager.createGroup({ name }));
  handleShell('group:rename', (id: string, name: string) => manager.renameGroup(id, name));
  handleShell('group:remove', (id: string) => manager.removeGroup(id));
  handleShell('group:collapse', (id: string, collapsed: boolean) => manager.setGroupCollapsed(id, collapsed));
  handleShell('env:select', (id: string) => manager.select(id));
  handleShell('env:selectSpace', (id: string, space: SpaceId) => manager.selectSpace(id, space));
  // 选中的环境以主进程为准；渲染层不自己记一份，避免两份真相源
  handleShell('env:selected', () => manager.selectedId() ?? null);
  handle('env:takeover', (id: string, space: SpaceId = 'agent') => manager.takeover(id, 'human', space));
  handle('env:release', (id: string, _space: SpaceId = 'agent') => {
    const env = manager.get(id);
    if (env?.leaseId) manager.release(id, env.leaseId, 'human');
  });
  handle('events:list', (id?: string) => store.events(id));
  // 标签：都在 Environment 内部，共用它的 session / 代理 / 登录态
  handleShell('tab:create', (id: string, space: SpaceId, url?: string, activate?: boolean) =>
    manager.newTab(id, url, { activate }, space),
  );
  handle('tab:select', (id: string, space: SpaceId, ref: TabRef) => manager.selectTab(id, space, ref));
  handle('tab:close', (id: string, space: SpaceId, ref: TabRef) => manager.closeTab(id, space, ref));
  handle('tab:closeOthers', (id: string, space: SpaceId, ref: TabRef) => manager.closeTabs(id, space, ref, 'others'));
  handle('tab:closeRight', (id: string, space: SpaceId, ref: TabRef) => manager.closeTabs(id, space, ref, 'right'));
  handle('tab:reorder', (id: string, space: SpaceId, from: number, to: number) =>
    manager.reorderTab(id, space, from, to),
  );
  handle('tab:reopen', (id: string, space: SpaceId) => manager.reopenTab(id, space));
  handle('tab:mute', (id: string, space: SpaceId, ref: TabRef, muted: boolean) =>
    manager.muteTab(id, space, ref, muted),
  );
  handle('browser:snapshot', async (id: string, space: SpaceId) => {
    const controller = manager.controllerFor(id, undefined, space);
    return {
      url: controller.currentUrl(),
      title: await controller.title(),
      nodes: await controller.snapshot(),
    };
  });
  handle('browser:console', (id: string) => manager.consoleEntries(id));
  handle('browser:network', (id: string) => manager.networkEntries(id));
  // cookie 元数据（没有值）：检查器的「存储」页
  handle('browser:cookies', (id: string) => manager.cookieNames(id));

  /**
   * 网络规则：读随便读；**改规则是写操作**——agent 正在持权时拒绝，
   * 界面不抢 agent 的活（和「人导航」同一条规矩）。
   */
  const humanNetWrite = <T>(id: string, fn: () => T): T => {
    if (manager.get(id)?.owner === 'agent') {
      throw new Error('ENV_BUSY: agent 正在控制该环境，等它交还后再改网络规则');
    }
    return fn();
  };
  handle('net:rules', (id: string) => manager.netRules(id));
  handle('net:hits', (id: string, limit?: number) => manager.netHits(id, limit));
  handle('net:ruleSet', (id: string, ruleId: string, enabled: boolean) =>
    humanNetWrite(id, () => manager.netSetRuleEnabled(id, ruleId, enabled, 'human')),
  );
  handle('net:ruleRemove', (id: string, ruleId: string) =>
    humanNetWrite(id, () => ({ removed: manager.netRemoveRule(id, ruleId, 'human') })),
  );
  // 导航状态是读；实际导航是写，主进程会校验人是否持控制权
  handle('browser:navState', (id: string, space: SpaceId) => manager.navState(id, space) ?? null);
  handleShell('browser:humanNavigate', (id: string, space: SpaceId, action: NavigationAction) =>
    manager.humanNavigate(id, action, space),
  );
  handleShell('history:suggest', (query: string, limit?: number) => store.searchUrlHistory(query, limit));
  handle('layout:viewport', (viewport: ViewportRect) => {
    manager.setViewport(viewport);
  });
  // 让开原生视图之前先取页面当前画面：渲染层把它垫在占位区，页面就不会整块消失
  handle('layout:pageSnapshot', () => manager.capturePage());
  // 只应在全屏切换（设置页/插件页）时把原生视图让开；普通浮层已由 OverlayHost / PopoverHost 承载
  handle('layout:viewVisible', (visible: boolean) => {
    manager.setViewVisible(visible);
  });
  handleShell('browser:openDevTools', (id: string, space: SpaceId, dock?: DevToolsDockMode) =>
    manager.openDevTools(id, space, dock),
  );
  handleShell('browser:closeDevTools', (id: string, space: SpaceId) => manager.closeDevTools(id, space));
  handleShell('browser:setDevToolsDock', (dock: DevToolsDockMode, size?: number) =>
    manager.setDevToolsDock(dock, size),
  );
  handleShell('browser:getDevToolsState', () => manager.getDevToolsState());
  handleShell(
    'browser:findInPage',
    (id: string, space: SpaceId, text: string, options?: { forward?: boolean; findNext?: boolean }) =>
      manager.findInPage(id, space, text, options),
  );
  handleShell('browser:stopFindInPage', (id: string, space: SpaceId) => manager.stopFindInPage(id, space));
  handleShell('browser:setZoom', (id: string, space: SpaceId, mode: 'in' | 'out' | 'reset' | number) =>
    manager.setZoom(id, space, mode),
  );
  handleShell('browser:getZoom', (id: string, space: SpaceId) => manager.getZoom(id, space));
  handleShell('browser:setViewportPreset', (id: string, space: SpaceId, preset: ViewportPresetId) =>
    manager.setViewportPreset(id, space, preset),
  );
  handleShell('browser:getViewportPreset', (id: string, space: SpaceId) => manager.getViewportPreset(id, space));
  handleShell('browser:downloads', (id?: string) => manager.downloads(id));
  handleShell('browser:revealDownload', (downloadId: string) => manager.revealDownload(downloadId));
  handleShell('browser:printPage', (id: string, space: SpaceId) => manager.printPage(id, space));
  handleShell('browser:savePage', (id: string, space: SpaceId) => manager.savePageAs(id, space));

  handle('ui:popupMenu', (items: NativeMenuItem[], position?: { x: number; y: number }) => {
    if (!window) return null;
    return popupNativeMenu(window, items, position);
  });
  handle('overlay:open', (request: OverlayRequest) => {
    if (!overlayHost) return null;
    return overlayHost.open(request);
  });
  handleShell('overlay:current', () => overlayHost?.currentState() ?? null);
  handleShell('overlay:resolve', (result: unknown) => {
    overlayHost?.resolve(result);
  });
  handle('popover:open', (options: PopoverOpenOptions) => popoverHost?.open(options));
  handle('popover:update', (id: string, options: Partial<PopoverOpenOptions>) => popoverHost?.update(id, options));
  handleShell('popover:close', (id?: string) => {
    popoverHost?.close(id);
  });
  handleShell('popover:current', () => popoverHost?.currentState() ?? null);
  handleShell('popover:action', (event: PopoverActionEvent) => {
    popoverHost?.emitAction(event);
  });

  // Vault 只暴露「有哪些凭据」和「填进页面」；没有 reveal 通道
  handle('vault:list', () => ({ available: vault.available, credentials: vault.list() }));

  // 自带 Skill 的安装（见 src/main/agent-integration.ts）
  handle('agent:skills', () => skillStatus(os.homedir(), skillSourceDir()));
  handle('agent:installSkill', (targetId: string) => installSkill(os.homedir(), skillSourceDir(), targetId));
  handle('vault:remove', async (ref: string) => {
    const removed = vault.remove(ref);
    await saveVault();
    return { removed };
  });

  // 插件的启停 / 重载会改变 rail 与设置分节，动完必须让渲染层重新取一遍
  const pluginsChanged = async <T>(action: () => Promise<T>): Promise<T> => {
    const result = await action();
    broadcastStateChanged();
    return result;
  };

  handleShell('plugin:list', () => plugins.list());
  handle('plugin:enable', (id: string) => pluginsChanged(() => plugins.enable(id)));
  handle('plugin:disable', (id: string) => pluginsChanged(() => plugins.disable(id)));
  handle('plugin:reload', (id: string) => pluginsChanged(() => plugins.reload(id)));
  handle('plugin:grant', (id: string, permissions: Permission[]) => plugins.grant(id, permissions));
  handle('plugin:logs', (id: string, limit?: number) => plugins.logs(id, limit));
  handle('plugin:configSet', (id: string, key: string, value: string) =>
    pluginsChanged(() => plugins.setSetting(id, key, value)),
  );
  // 这条 IPC 只有渲染层（插件自己的 UI）用：caller=ui 才允许走「只给人看」的通道（如账号 reveal）
  handle('plugin:rpc', (id: string, method: string, input?: unknown) =>
    plugins.rpc(id, method, input, { caller: 'ui' }),
  );
  handle('plugin:hostRead', (id: string, method: string, environmentId?: string, args?: unknown[]) =>
    plugins.hostRead(id, method, environmentId, args ?? []),
  );
  handleShell('plugin:run', (id: string, command: string, environmentId: string) =>
    pluginsChanged(() => plugins.run(id, command, { environmentId })),
  );
  handle('plugin:installSource', async (source: string) => {
    const plugin = await pluginsChanged(() => plugins.install(source));
    return { cancelled: false, plugin };
  });
  handle('plugin:installFromDialog', async () => {
    if (!window) return { cancelled: true };
    const result = await dialog.showOpenDialog(window, {
      title: '选择插件包目录（含 package.json）',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    const plugin = await pluginsChanged(() => plugins.install(`path:${result.filePaths[0]!}`));
    return { cancelled: false, plugin };
  });
}

function showMainWindow(): void {
  if (!window || window.isDestroyed()) return;
  if (manager) {
    manager.showWindow(true);
    return;
  }
  if (process.platform === 'darwin') app.dock?.show();
  window.show();
  window.focus();
}

function syncPowerSaveBlocker(): void {
  const active = Boolean(manager?.hasRunningEnvironments() || manager?.hasActiveAgentLease());
  if (active && suspensionBlocker === undefined) {
    suspensionBlocker = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!active && suspensionBlocker !== undefined) {
    powerSaveBlocker.stop(suspensionBlocker);
    suspensionBlocker = undefined;
  }
}

function installTray(): void {
  if (tray) return;
  // 托盘必须用透明底单色模板图（tray-icon.png + @2x）；直接拿填充 Squircle 的 icon.png
  // 调 setTemplateImage(true) 会把整张图标压成一坨纯色方块。不调 resize 以保留 @2x Retina 清晰度。
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'tray-icon.png'));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Warren');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 Warren', click: showMainWindow },
      { type: 'separator' },
      {
        label: '退出 Warren',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showMainWindow);
}

app.whenReady().then(async () => {
  // 开发模式下 Dock 是 Electron 默认图标，用打包用的同一份 PNG 顶上
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(path.join(app.getAppPath(), 'assets', 'icon.png'));
  }

  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    const resolved = resolveProxyCredential(authInfo.host);
    if (!resolved) return; // 没有凭据 -> 认证失败，而不是静默放行
    event.preventDefault();
    callback(resolved.username, resolved.password);
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write']);
    callback(allowed.has(permission));
  });

  await store.load();
  await loadVault();
  if (!vault.available) {
    store.record(makeEvent('vault.unavailable', '系统密钥存储不可用，Vault 已禁用', 'system'));
  }

  // 插件前端 bundle：`warren-plugin://<id>/app.js` → `<coreDir>/plugins/<id>/`
  protocol.handle('warren-plugin', async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.hostname;
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const plugin = (await plugins.list()).find((item) => item.id === id);
      if (!plugin || !plugin.enabled) return new Response('plugin not loaded', { status: 404 });
      const root = path.resolve(plugin.dir);
      const target = path.resolve(root, relative || plugin.app || '');
      if (!target.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
      const types: Record<string, string> = {
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.html': 'text/html',
      };
      try {
        const body = await readFile(target);
        return new Response(body, {
          headers: {
            'content-type': types[path.extname(target)] ?? 'application/octet-stream',
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
            // 模块脚本是带 CORS 的请求：开发态渲染层在 http://localhost:5173，
            // 拿 warren-plugin:// 的资源必须显式放行，否则报「Failed to fetch dynamically imported module」
            'access-control-allow-origin': '*',
          },
        });
      } catch {
        return new Response('not found', { status: 404 });
      }
    } catch (error) {
      console.error('[plugin-protocol] failed', request.url, error);
      return new Response(String(error), { status: 500 });
    }
  });

  window = createWindow();
  layers = new WindowLayerManager(window, 8);
  const surfaceLoadUrl = (surface: 'overlay' | 'popover') => {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const devUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      devUrl.searchParams.set('surface', surface);
      return { devUrl: devUrl.toString() };
    }
    return { filePath: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`) };
  };
  overlayHost = new OverlayHost({
    window,
    layers,
    preloadPath: path.join(__dirname, 'preload.cjs'),
    loadUrl: surfaceLoadUrl,
    onResolved: () => {
      if (window && !window.isDestroyed()) manager?.focusDisplayedPage();
    },
  });
  popoverHost = new PopoverHost({
    mainWindow: window,
    preloadPath: path.join(__dirname, 'preload.cjs'),
    loadUrl: surfaceLoadUrl,
    onAction: (event) => {
      window?.webContents.send('popover:action', event);
    },
    onDismissed: (payload) => {
      window?.webContents.send('popover:dismissed', payload);
    },
  });
  popoverHost.warmup();

  installTray();
  installMenu();
  manager = new EnvironmentManager(
    store,
    window,
    () => {
      broadcastStateChanged();
      syncPowerSaveBlocker();
    },
    {
      layers,
      onTargetUrl: (payload) => window?.webContents.send('browser:targetUrl', payload),
      onFindResult: (result) => {
        window?.webContents.send('browser:findResult', result);
        popoverHost?.broadcast('browser:findResult', result);
      },
      onDownloadsChanged: () => broadcastStateChanged(),
      onBusEvent: (event) => plugins?.dispatchEvent(event),
    },
  );

  plugins = new PluginHost({
    root: path.join(coreDir, 'plugins'),
    manager,
    vault,
    store,
    db: store.database,
    saveVault,
    appVersion: app.getVersion(),
    onSignal: (pluginId, channel, payload) => {
      window?.webContents.send('plugin:signal', { pluginId, channel, payload });
    },
    // CLI / agent 改的插件状态也要让界面知道，否则 rail 与设置分节会停在旧清单
    onChange: () => broadcastStateChanged(),
  });
  await plugins.load();

  rpc = new RpcServer(manager, store, { vault, saveVault, plugins });
  await rpc.listen();
  registerIpc();
  syncPowerSaveBlocker();

  store.record(makeEvent('core.ready', `core ready on pid ${process.pid}`));
  window.webContents.send('state:changed');

  // 崩溃恢复放最后、**不 await**：它要真的加载页面（最长 30s），
  // 挡住 RPC 起来的话 CLI 会先报「找不到运行中的核心」。
  void restoreRunningEnvironments();
});

/**
 * 上次是被杀掉 / 崩掉时，把当时在跑的环境拉回来。
 *
 * 正常退出不会触发（`before-quit` → `shutdown()` → 逐个 `stop()` 会把 running.json 写成空的）。
 * `WARREN_RESTORE=0` 关掉它（回归套件用：免得上一次的残留环境被自动拉起）。
 */
async function restoreRunningEnvironments(): Promise<void> {
  if (process.env.WARREN_RESTORE === '0') return;
  const snapshot = store.runningSnapshot();
  if (!snapshot.running.length) return;
  const restored = await manager.restoreRunning(snapshot.running, snapshot.selected);
  if (!restored.length) return;
  store.record(makeEvent('core.recovered', `崩溃恢复：拉起 ${restored.join('、')}`, 'system'));
  window?.webContents.send('state:changed');
}

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.on('activate', () => {
  showMainWindow();
});

app.on('before-quit', () => {
  quitting = true;
  overlayHost?.destroy();
  popoverHost?.destroy();
  void plugins?.dispose();
  manager?.shutdown();
  // 关库顺带 checkpoint WAL：不关的话 -wal 会一直留在盘上。
  // before-quit 是同步钩子，Electron 不等 async 体；同步关库必须放在 await 之前。
  closeDatabases();
  void rpc?.close();
  tray?.destroy();
  tray = undefined;
  if (suspensionBlocker !== undefined) {
    powerSaveBlocker.stop(suspensionBlocker);
    suspensionBlocker = undefined;
  }
});
