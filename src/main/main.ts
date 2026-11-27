import {
  app,
  BrowserWindow,
  crashReporter,
  Menu,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  protocol,
  session,
  Tray,
} from 'electron';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshSkills } from './agent-integration';
import { APP_PROTOCOL_SCHEME, appShellUrl, registerAppProtocol } from './app-protocol.ts';
import { BROWSER_MENU_SHORTCUTS, browserShortcut } from './browser-shortcuts';
import { closeDatabases } from './db';
import { makeEvent } from './domain/environment';
import { EnvironmentManager } from './environments';
import { isOpenableExternalUrl } from './external-url';
import { registerIpcRoutes } from './ipc-routes.ts';
import { createMainLogger } from './logger.ts';
import { MemoryMonitor } from './memory-monitor.ts';
import { warrenPaths } from './paths.ts';
import { registerPluginProtocol } from './plugin-protocol.ts';
import { PluginHost } from './plugins/host';
import { RpcServer } from './rpc';
import { Store } from './store';
import { WindowLayerManager } from './ui/layer-manager.ts';
import { OverlayHost } from './ui/overlay-host.ts';
import { PopoverHost } from './ui/popover-host.ts';
import { DEFAULT_SKIN_ID, resolveSkinPalette } from '../shared/skin.ts';
import type { AppSettings } from '../shared/types.ts';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// 必须在 app.setPath('userData') 之前设置应用名，避免 macOS 菜单栏显示 Electron
app.setName('Warren');

const paths = warrenPaths();
for (const dir of [paths.app, paths.core, paths.logs, paths.crashDumps]) {
  mkdirSync(dir, { recursive: true });
}
app.setPath('userData', paths.app);
app.setPath('sessionData', paths.app);
app.setPath('logs', paths.logs);
app.setPath('crashDumps', paths.crashDumps);

const logger = createMainLogger(paths.logs);
try {
  crashReporter.start({ uploadToServer: false });
} catch (error) {
  logger.warn('crash-reporter', '启动本地崩溃转储失败', error);
}

process.on('uncaughtException', (error) => {
  logger.error('process', 'uncaughtException', error);
  console.error('[main] uncaughtException:', error);
});
process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', reason);
  console.error('[main] unhandledRejection:', reason);
});
app.on('render-process-gone', (_event, wc, details) => {
  logger.error('renderer', `render-process-gone (reason=${details.reason}, exitCode=${details.exitCode})`, {
    url: wc.isDestroyed() ? '' : wc.getURL(),
  });
});
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit') return;
  logger.error('child-process', `child-process-gone (type=${details.type}, reason=${details.reason})`, details);
});

// 单实例互斥锁（按 userData 目录隔离，隔离 WARREN_HOME 的冒烟/测试实例互不冲突）
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

const coreDir = paths.core;

function skillSourceDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(__dirname, '../../skills');
}

function assetPath(...segments: string[]): string {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '../../assets');
  return path.join(base, ...segments);
}

// 必须在 app ready 之前注册特权协议，否则跨源模块脚本会被 CORS/CSP 直接拦截
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'warren-plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'warren',
    privileges: { standard: true, secure: true },
  },
]);

const store = new Store(coreDir);

let manager: EnvironmentManager;
let plugins: PluginHost;
let rpc: RpcServer;
let window: BrowserWindow | undefined;
let layers: WindowLayerManager | undefined;
let overlayHost: OverlayHost | undefined;
let popoverHost: PopoverHost | undefined;
let memoryMonitor: MemoryMonitor | undefined;
let tray: Tray | undefined;
let quitting = false;
let suspensionBlocker: number | undefined;

function broadcast(channel: string, payload?: unknown): void {
  if (payload === undefined) {
    window?.webContents.send(channel);
    overlayHost?.webContents?.send(channel);
    popoverHost?.broadcast(channel);
  } else {
    window?.webContents.send(channel, payload);
    overlayHost?.webContents?.send(channel, payload);
    popoverHost?.broadcast(channel, payload);
  }
}

let envDeltaTimer: ReturnType<typeof setTimeout> | undefined;
let pendingEnvDeltaReason: string | undefined;
let envDeltaHasPending = false;

function flushEnvDelta(): void {
  if (!envDeltaHasPending) return;
  const reason = pendingEnvDeltaReason;
  pendingEnvDeltaReason = undefined;
  envDeltaHasPending = false;
  broadcast('env:delta', reason ? { reason } : {});
}

/** 合并 50ms 内的密集状态通知，避免多标签/下载进度触发渲染层 IPC 风暴。 */
const broadcastEnvDelta = (reason?: string): void => {
  if (!envDeltaHasPending) {
    envDeltaHasPending = true;
    pendingEnvDeltaReason = reason;
    envDeltaTimer = setTimeout(() => {
      envDeltaTimer = undefined;
      flushEnvDelta();
    }, 50);
    envDeltaTimer.unref?.();
    return;
  }
  if (pendingEnvDeltaReason && pendingEnvDeltaReason !== reason) {
    pendingEnvDeltaReason = undefined;
  }
};
const broadcastPluginChanged = (reason?: string): void => broadcast('plugin:changed', reason ? { reason } : {});

/** 代理认证挑战从对应环境的代理 URL 凭据段解析；未配置凭据则拒绝，禁止静默放行裸奔。 */
function resolveProxyCredential(host: string, port?: number): { username: string; password: string } | null {
  for (const env of store.list()) {
    if (!env.proxy) continue;
    try {
      const parsed = new URL(env.proxy);
      if (parsed.hostname !== host) continue;
      if (port && parsed.port && Number(parsed.port) !== port) continue;
      if (!parsed.username || !parsed.password) continue;
      return {
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      };
    } catch {
      // 忽略非法代理 URL
    }
  }
  return null;
}

function resolveNativeScheme(theme: AppSettings['theme']): 'dark' | 'light' {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function resolveMainFrameBackground(settings: AppSettings): string {
  const scheme = resolveNativeScheme(settings.theme);
  return resolveSkinPalette(settings.skin ?? DEFAULT_SKIN_ID, scheme, settings.skinOverrides).frame;
}

/** 仅创建主窗对象与原生事件监听，暂不加载渲染层；待 IPC 路由就绪后再调用 `loadMainWindow`。 */
function createMainWindow(initialSettings: AppSettings): BrowserWindow {
  const startBackground = process.env.WARREN_BACKGROUND === '1';
  const startInactive = startBackground || process.env.WARREN_START_INACTIVE === '1';
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: !startInactive,
    backgroundColor: resolveMainFrameBackground(initialSettings),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    icon: assetPath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  if (startInactive) {
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      if (startBackground) manager?.hideWindow();
      else win.showInactive();
    });
  }

  win.webContents.on('before-input-event', (event, input) => {
    const shortcut = browserShortcut(input);
    if (!shortcut) return;
    event.preventDefault();
    win.webContents.send('browser:shortcut', shortcut);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOpenableExternalUrl(url)) void import('electron').then(({ shell }) => shell.openExternal(url));
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    logger.error('renderer', `主窗口加载失败 (${errorCode} ${errorDescription})`, { validatedURL });
    console.error('[main] renderer did-fail-load:', errorCode, errorDescription, validatedURL);
  });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    popoverHost?.close(undefined, 'host');
    manager?.hideWindow();
  });

  win.on('resize', () => {
    overlayHost?.syncBounds();
  });

  return win;
}

function loadMainWindow(win: BrowserWindow): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadURL(appShellUrl());
  }
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
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
          click: () => window?.webContents.send('browser:shortcut', shortcut),
        })),
      },
      { label: '显示', submenu: [{ role: 'togglefullscreen' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    ]),
  );
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
  const icon = nativeImage.createFromPath(assetPath('tray-icon.png'));
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
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(assetPath('icon.png'));
  }

  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    const resolved = resolveProxyCredential(authInfo.host, authInfo.port);
    if (!resolved) return;
    event.preventDefault();
    callback(resolved.username, resolved.password);
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
  });

  await store.load();

  registerAppProtocol({
    protocol,
    rootDir: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
  });

  const pluginProtocol = registerPluginProtocol({
    protocol,
    getPlugins: () => plugins,
  });

  const initialSettings = store.appSettings();
  // 同步 Electron nativeTheme，确保 macOS 原生右键菜单、对话框与窗口外观始终跟随应用明暗模式
  nativeTheme.themeSource = initialSettings.theme ?? 'dark';
  window = createMainWindow(initialSettings);
  layers = new WindowLayerManager(window, initialSettings.pageBorderRadius === false ? 0 : 8);
  const surfaceLoadUrl = (surface: 'overlay' | 'popover') => {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const devUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      devUrl.searchParams.set('surface', surface);
      return { devUrl: devUrl.toString() };
    }
    return { devUrl: appShellUrl(surface) };
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

  installTray();
  installMenu();
  manager = new EnvironmentManager(
    store,
    window,
    () => {
      broadcastEnvDelta();
      syncPowerSaveBlocker();
    },
    {
      layers,
      onTargetUrl: (payload) => window?.webContents.send('browser:targetUrl', payload),
      onFindResult: (result) => {
        window?.webContents.send('browser:findResult', result);
        popoverHost?.broadcast('browser:findResult', result);
      },
      onDownloadsChanged: () => {
        broadcastEnvDelta('downloads');
      },
      onBusEvent: (event) => plugins?.dispatchEvent(event),
    },
  );
  manager.applySettings(initialSettings, { respectEnvOverrides: true });
  manager.setShieldTheme(resolveNativeScheme(initialSettings.theme));
  nativeTheme.on('updated', () => {
    const currentSettings = store.appSettings();
    if (currentSettings.theme === 'system') {
      const scheme = resolveNativeScheme('system');
      manager?.setShieldTheme(scheme);
      if (window && !window.isDestroyed()) {
        window.setBackgroundColor(resolveMainFrameBackground(currentSettings));
      }
    }
  });

  let skillSyncTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSkillSync = (): void => {
    if (skillSyncTimer) clearTimeout(skillSyncTimer);
    skillSyncTimer = setTimeout(() => {
      skillSyncTimer = undefined;
      void plugins
        .skillEntries()
        .then((entries) => refreshSkills(os.homedir(), skillSourceDir(), entries))
        .catch(() => undefined);
    }, 300);
    skillSyncTimer.unref();
  };

  plugins = new PluginHost({
    root: path.join(coreDir, 'plugins'),
    manager,
    store,
    db: store.database,
    appVersion: app.getVersion(),
    onSignal: (pluginId, channel, payload) => {
      window?.webContents.send('plugin:signal', { pluginId, channel, payload });
      popoverHost?.broadcast('plugin:signal', { pluginId, channel, payload });
    },
    onChange: () => {
      pluginProtocol.invalidate();
      broadcastPluginChanged();
      scheduleSkillSync();
    },
  });
  // 第一阶段轻加载（仅读注册表并标记 starting），不阻塞主窗加载与 IPC 注册
  await plugins.loadState();
  pluginProtocol.invalidate();

  memoryMonitor = new MemoryMonitor({
    getWindow: () => window,
    getOverlayHost: () => overlayHost,
    getPopoverHost: () => popoverHost,
    getManager: () => manager,
    getPlugins: () => plugins,
    store,
  });
  memoryMonitor.configure({ softLimitMb: initialSettings.memorySoftLimitMb });
  memoryMonitor.start();

  // IPC 路由必须在主窗口 loadURL/loadFile 之前注册，结构性消除冷启动 No handler registered 竞态
  registerIpcRoutes({
    getWindow: () => window,
    getOverlayHost: () => overlayHost,
    getPopoverHost: () => popoverHost,
    getManager: () => manager,
    getPlugins: () => plugins,
    getMemoryMonitor: () => memoryMonitor,
    store,
    homeDir: paths.home,
    coreDir,
    skillSourceDir,
    broadcastEnvDelta,
    broadcastPluginChanged,
  });
  syncPowerSaveBlocker();

  loadMainWindow(window);

  // Overlay / Popover 改为首次触发按需懒创建，避免冷启动常驻 3 个空闲渲染进程占用 ~450MB 内存，
  // 且打开后在空闲 3 分钟由 MemoryMonitor 自动回收。

  rpc = new RpcServer(manager, store, {
    plugins,
    memoryMonitor,
    skillSourceDir: skillSourceDir(),
    homeDir: os.homedir(),
  });
  await rpc.listen();

  store.record(makeEvent('core.ready', `core ready on pid ${process.pid}`));
  scheduleSkillSync();

  // 第二阶段：后台有界并发激活已启用插件，期间任何 plugin:rpc / run 均通过 waitReady 透明衔接
  void plugins
    .activateEnabled({ notify: true })
    .then(() => {
      pluginProtocol.invalidate();
      scheduleSkillSync();
    })
    .catch((error) => {
      console.error('[plugins] 后台激活异常:', error);
    });

  void restoreRunningEnvironments();
});

async function restoreRunningEnvironments(): Promise<void> {
  if (process.env.WARREN_RESTORE === '0') return;
  const snapshot = store.runningSnapshot();
  if (!snapshot.running.length) return;
  const restored = await manager.restoreRunning(snapshot.running, snapshot.selected);
  if (!restored.length) return;
  store.record(makeEvent('core.recovered', `崩溃恢复：拉起 ${restored.join('、')}`, 'system'));
  broadcastEnvDelta();
}

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.on('activate', () => {
  showMainWindow();
});

let cleanedUp = false;
let cleaningUp = false;

async function gracefulShutdown(): Promise<void> {
  quitting = true;
  if (envDeltaTimer) {
    clearTimeout(envDeltaTimer);
    envDeltaTimer = undefined;
  }
  envDeltaHasPending = false;
  pendingEnvDeltaReason = undefined;
  memoryMonitor?.stop();
  memoryMonitor = undefined;
  overlayHost?.destroy();
  popoverHost?.destroy();
  tray?.destroy();
  tray = undefined;
  if (suspensionBlocker !== undefined) {
    powerSaveBlocker.stop(suspensionBlocker);
    suspensionBlocker = undefined;
  }
  try {
    // 严格顺序：等待插件 dispose（停止托管 Whistle 等子进程）→ 关闭环境视图 → 关闭 RPC socket → 关库
    await Promise.race([
      (async () => {
        await plugins?.dispose().catch(() => undefined);
        manager?.shutdown();
        await rpc?.close().catch(() => undefined);
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 4000)),
    ]);
  } finally {
    closeDatabases();
  }
}

app.on('before-quit', (event) => {
  if (cleanedUp) return;
  event.preventDefault();
  if (cleaningUp) return;
  cleaningUp = true;
  void gracefulShutdown().finally(() => {
    cleanedUp = true;
    app.exit(0);
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (cleaningUp || cleanedUp) return;
    app.quit();
  });
}
