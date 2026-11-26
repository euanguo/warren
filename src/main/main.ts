import {
  app,
  BrowserWindow,
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
import { BROWSER_MENU_SHORTCUTS, browserShortcut } from './browser-shortcuts';
import { closeDatabases } from './db';
import { makeEvent } from './domain/environment';
import { EnvironmentManager } from './environments';
import { isOpenableExternalUrl } from './external-url';
import { registerIpcRoutes } from './ipc-routes.ts';
import { warrenPaths } from './paths.ts';
import { registerPluginProtocol } from './plugin-protocol.ts';
import { PluginHost } from './plugins/host';
import { RpcServer } from './rpc';
import { Store } from './store';
import { WindowLayerManager } from './ui/layer-manager.ts';
import { OverlayHost } from './ui/overlay-host.ts';
import { PopoverHost } from './ui/popover-host.ts';
import { SafeStorageEncryptor } from './vault/electron-encryptor';
import { loadCredentials, saveCredentials } from './vault/persistence';
import { VaultStore } from './vault/store';

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

function broadcast(channel: string, payload?: unknown): void {
  if (payload === undefined) {
    window?.webContents.send(channel);
    overlayHost?.webContents.send(channel);
    popoverHost?.broadcast(channel);
  } else {
    window?.webContents.send(channel, payload);
    overlayHost?.webContents.send(channel, payload);
    popoverHost?.broadcast(channel, payload);
  }
}

const broadcastEnvDelta = (reason?: string): void => broadcast('env:delta', reason ? { reason } : {});
const broadcastPluginChanged = (reason?: string): void => broadcast('plugin:changed', reason ? { reason } : {});

async function loadVault(): Promise<void> {
  vault.load(await loadCredentials(store.database, coreDir));
}

async function saveVault(): Promise<void> {
  saveCredentials(store.database, vault.serialize());
}

/** 代理认证挑战没有匹配凭据时拒绝，禁止静默放行裸奔。 */
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
  const startBackground = process.env.WARREN_BACKGROUND === '1';
  const startInactive = startBackground || process.env.WARREN_START_INACTIVE === '1';
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: !startInactive,
    backgroundColor: '#1c1c1c',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
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
      if (startBackground) manager?.backgroundWindow();
      else win.showInactive();
    });
  }

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
    if (isOpenableExternalUrl(url)) void import('electron').then(({ shell }) => shell.openExternal(url));
    return { action: 'deny' };
  });

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
    const resolved = resolveProxyCredential(authInfo.host);
    if (!resolved) return;
    event.preventDefault();
    callback(resolved.username, resolved.password);
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
  });

  await store.load();
  await loadVault();
  if (!vault.available) {
    store.record(makeEvent('vault.unavailable', '系统密钥存储不可用，Vault 已禁用', 'system'));
  }

  const pluginProtocol = registerPluginProtocol({
    protocol,
    getPlugins: () => plugins,
  });

  const initialSettings = store.appSettings();
  window = createWindow();
  layers = new WindowLayerManager(window, initialSettings.pageBorderRadius === false ? 0 : 8);
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
    vault,
    store,
    db: store.database,
    saveVault,
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
  await plugins.load();
  pluginProtocol.invalidate();
  scheduleSkillSync();

  rpc = new RpcServer(manager, store, {
    vault,
    saveVault,
    plugins,
    skillSourceDir: skillSourceDir(),
    homeDir: os.homedir(),
  });
  await rpc.listen();
  registerIpcRoutes({
    getWindow: () => window,
    getOverlayHost: () => overlayHost,
    getPopoverHost: () => popoverHost,
    getManager: () => manager,
    getPlugins: () => plugins,
    store,
    vault,
    saveVault,
    homeDir: paths.home,
    coreDir,
    skillSourceDir,
    broadcastEnvDelta,
    broadcastPluginChanged,
  });
  syncPowerSaveBlocker();

  store.record(makeEvent('core.ready', `core ready on pid ${process.pid}`));
  manager.setShieldTheme(
    initialSettings.theme === 'light'
      ? 'light'
      : initialSettings.theme === 'system' && !nativeTheme.shouldUseDarkColors
        ? 'light'
        : 'dark',
  );
  nativeTheme.on('updated', () => {
    if (store.appSettings().theme === 'system') {
      manager?.setShieldTheme(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }
  });
  broadcastPluginChanged('plugins');
  window.webContents.once('did-finish-load', () => {
    broadcastPluginChanged('plugins');
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

app.on('before-quit', () => {
  quitting = true;
  overlayHost?.destroy();
  popoverHost?.destroy();
  void plugins?.dispose();
  manager?.shutdown();
  closeDatabases();
  void rpc?.close();
  tray?.destroy();
  tray = undefined;
  if (suspensionBlocker !== undefined) {
    powerSaveBlocker.stop(suspensionBlocker);
    suspensionBlocker = undefined;
  }
});
