/**
 * 插件前端运行时。
 *
 * 插件产物是一个普通 ESM bundle，由主进程通过 `warren-plugin://<id>/app.js` 供给。
 * 这里做三件事：
 * 1. 把宿主 React / rpc / 信号钩子注入传给 `register(app)`（插件不打包第二份 React）；
 * 2. `import()` 插件的 bundle，调它的 `register(app)`；
 * 3. 收集它注册的「面」，**只接受清单里声明过的**（fail closed）。
 *
 * 面本身由 warren 自己的组件渲染，插件只提供组件与数据。
 */
import { useEffect, useRef } from 'react';
import * as React from 'react';
import { toast } from 'sonner';
import {
  openPluginPage,
  openSettings,
  requestPluginInspector,
  requestPluginPopover,
  type BuiltinSettingsSection,
} from '@/state/navigation-store';
import {
  beginPluginLoad,
  clearPluginBadgeSurface,
  prunePluginBadges,
  registerPluginBadgeSurface,
  setPluginEnvBadge,
  type PluginEnvBadge,
} from '@/lib/plugin-badges';
import { emptyRegistry, type PluginAppApi, type PluginRegistry } from '@/lib/plugin-sdk-types';
import { PLUGIN_UI } from '@/lib/plugin-ui';
import type { InstalledPlugin, OverlayFormValues, PluginSignal } from '@shared/types';

function isPopoverWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('surface') === 'popover';
}

const ALLOWED_PLUGIN_SETTINGS_SECTIONS: ReadonlySet<BuiltinSettingsSection> = new Set([
  'general',
  'browser',
  'memory',
  'agent',
  'plugins',
  'diagnostics',
]);

export function isAllowedPluginSettingsSection(section: string): section is BuiltinSettingsSection {
  return ALLOWED_PLUGIN_SETTINGS_SECTIONS.has(section as BuiltinSettingsSection);
}

/** 订阅插件后端推来的信号。插件组件里直接调它。 */
export function usePluginSignal(pluginId: string, channel: string, handler: (payload: unknown) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(
    () =>
      window.envApi.onPluginSignal((signal: PluginSignal) => {
        if (signal.pluginId === pluginId && signal.channel === channel) ref.current(signal.payload);
      }),
    [pluginId, channel],
  );
}

async function callPluginRpc<T>(pluginId: string, method: string, input?: unknown): Promise<T> {
  const response = await window.envApi.pluginRpc(pluginId, method, input);
  if (!response.ok) {
    throw Object.assign(new Error(response.message ?? '插件调用失败'), { code: response.code });
  }
  return response.result as T;
}

async function callHostRead<T>(pluginId: string, method: string, environmentId?: string, args?: unknown[]): Promise<T> {
  const response = await window.envApi.pluginHostRead(pluginId, method, environmentId, args);
  if (!response.ok) {
    throw Object.assign(new Error(response.message ?? '宿主只读调用失败'), { code: response.code });
  }
  return response.result as T;
}

function createApi(plugin: InstalledPlugin, registry: PluginRegistry, generation: number): PluginAppApi {
  const declared = new Set(plugin.contributes.surfaces.map((surface) => `${surface.kind}:${surface.id}`));
  const accept = (kind: string, id: string): void => {
    if (!declared.has(`${kind}:${id}`)) {
      // 清单没声明的面一律拒绝加载：安装前看到的和实际挂上的必须是同一份
      throw Object.assign(new Error(`插件注册了清单未声明的面 ${kind}/${id}`), {
        code: 'PLUGIN_SURFACE_UNDECLARED',
      });
    }
  };

  return {
    pluginId: plugin.id,
    React,
    h: React.createElement,
    ui: PLUGIN_UI,
    rpc: { call: (method, input) => callPluginRpc(plugin.id, method, input) },
    host: {
      environment: {
        list: () => callHostRead(plugin.id, 'environment.list'),
        get: (id) => callHostRead(plugin.id, 'environment.get', undefined, [id]),
        activeContext: () => callHostRead(plugin.id, 'environment.activeContext'),
      },
      browser: {
        info: (environmentId, options) =>
          callHostRead(plugin.id, 'browser.info', environmentId, options ? [options] : []),
      },
    },
    shell: {
      closePopover: () => window.envApi.closePopover('plugin-popover'),
      resizePopover: (size) => window.envApi.updatePopover('plugin-popover', { size }),
      openPopover: (surfaceId, options) => {
        requestPluginPopover(plugin.id, surfaceId, options);
      },
      openPage: (surfaceId) => {
        const targetId = surfaceId ?? plugin.contributes.surfaces.find((s) => s.kind === 'railPage')?.id;
        if (!targetId) return;
        if (!declared.has(`railPage:${targetId}`)) {
          console.warn(`[plugin:${plugin.id}] 拒绝跳转未声明的 railPage: ${targetId}`);
          return;
        }
        if (isPopoverWindow()) {
          void window.envApi.dispatchPopoverAction({
            id: 'plugin-popover',
            action: 'openPluginPage',
            payload: { pluginId: plugin.id, surfaceId: targetId },
          });
          void window.envApi.closePopover('plugin-popover');
          return;
        }
        openPluginPage(plugin.id, targetId);
      },
      openSettings: (section?: BuiltinSettingsSection) => {
        if (section && !isAllowedPluginSettingsSection(section)) {
          console.warn(`[plugin:${plugin.id}] 拒绝跳转非法设置分节: ${String(section)}`);
          return;
        }
        if (isPopoverWindow()) {
          void window.envApi.dispatchPopoverAction({
            id: 'plugin-popover',
            action: 'openSettings',
            payload: { section },
          });
          void window.envApi.closePopover('plugin-popover');
          return;
        }
        openSettings(section);
      },
      openInspectorTab: (surfaceId) => {
        const targetId = surfaceId ?? plugin.contributes.surfaces.find((s) => s.kind === 'inspectorTab')?.id;
        if (!targetId) return;
        if (isPopoverWindow()) {
          void window.envApi.dispatchPopoverAction({
            id: 'plugin-popover',
            action: 'openInspectorTab',
            payload: { pluginId: plugin.id, surfaceId: targetId },
          });
          void window.envApi.closePopover('plugin-popover');
          return;
        }
        requestPluginInspector(plugin.id, targetId);
      },
      openTab: async (environmentId, url, space = 'person') => {
        try {
          await window.envApi.tabCreate(environmentId, space, url, true);
        } catch {
          await window.envApi.start(environmentId);
          await window.envApi.tabCreate(environmentId, space, url, true);
        }
      },
      highlight: async (environmentId, selector, space = 'person') => {
        await window.envApi.highlightElement(environmentId, space, selector);
      },
      notify: (kind, title, description) => {
        if (isPopoverWindow()) {
          void window.envApi.dispatchPopoverAction({
            id: 'plugin-popover',
            action: 'toast',
            payload: { kind, title, description },
          });
          return;
        }
        if (kind === 'error') toast.error(title, description ? { description } : undefined);
        else if (kind === 'info') toast.info(title, description ? { description } : undefined);
        else toast.success(title, description ? { description } : undefined);
      },
      openForm: async (request) => {
        // 独立浮窗是独立 BrowserWindow，主窗的浮层会被它自己挡住；那里请用插件自己的内联表单。
        if (isPopoverWindow()) {
          throw Object.assign(new Error('独立浮窗不能用宿主表单'), { code: 'PLUGIN_FORM_UNSUPPORTED_SURFACE' });
        }
        return window.envApi.openOverlay<OverlayFormValues>(request);
      },
    },
    settings: plugin.settings,
    useSettings: () => {
      const [values, setValues] = React.useState(plugin.settings);
      const refresh = React.useCallback(async () => {
        const list = await window.envApi.plugins();
        const own = list.find((item) => item.id === plugin.id);
        if (own) setValues(own.settings);
      }, []);
      return { values, isLoading: false, refresh };
    },
    useSignal: (channel, handler) => usePluginSignal(plugin.id, channel, handler),
    log: (message) => console.info(`[plugin:${plugin.id}] ${message}`),
    surfaces: {
      railPage: (surface) => {
        accept('railPage', surface.id);
        registry.railPages.push({ ...surface, kind: 'railPage', pluginId: plugin.id });
      },
      settingsSection: (surface) => {
        accept('settingsSection', surface.id);
        registry.settingsSections.push({
          ...surface,
          kind: 'settingsSection',
          pluginId: plugin.id,
        });
      },
      inspectorTab: (surface) => {
        accept('inspectorTab', surface.id);
        registry.inspectorTabs.push({ ...surface, kind: 'inspectorTab', pluginId: plugin.id });
      },
      popover: (surface) => {
        accept('popover', surface.id);
        registry.popovers.push({ ...surface, kind: 'popover', pluginId: plugin.id });
      },
      commandBarAction: (surface) => {
        accept('commandBarAction', surface.id);
        registry.commandBarActions.push({ ...surface, kind: 'commandBarAction', pluginId: plugin.id });
      },
      statusBadge: (surface) => {
        accept('statusBadge', surface.id);
        registry.statusBadges.push({ ...surface, kind: 'statusBadge', pluginId: plugin.id });
      },
      envBadge: (surface) => {
        accept('envBadge', surface.id);
        registerPluginBadgeSurface(plugin.id, generation, surface.id);
        return {
          set: (envId, badge: PluginEnvBadge | null) =>
            setPluginEnvBadge(plugin.id, generation, surface.id, envId, badge),
          clear: () => clearPluginBadgeSurface(plugin.id, generation, surface.id),
        };
      },
    },
  };
}

interface LoadedBundle {
  key: string;
  register: (app: PluginAppApi) => void;
}

/**
 * 同一个 bundle 只 import 一次。
 *
 * **两层缓存都要按摘要失效**，少一层都会让「改完插件前端却还是旧行为」：
 * 1. 这个 Map —— 按摘要换键；
 * 2. **浏览器的模块表** —— `import()` 的结果按 URL 永久缓存，光换 Map 键没用，
 *    所以 URL 上要带 `?v=<摘要>`（实测：不加的话重装插件后 rail 标题还是旧的）。
 *
 * 摘要变了就重新拉；版本号只用于展示。
 */
const bundleCache = new Map<string, Promise<LoadedBundle>>();

async function loadBundle(plugin: InstalledPlugin): Promise<LoadedBundle> {
  const revision = plugin.digest || plugin.version;
  const key = `${plugin.id}@${revision}`;
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<LoadedBundle> => {
    const url = `warren-plugin://${plugin.id}/${plugin.app}?v=${encodeURIComponent(revision)}`;
    // @vite-ignore：这个 URL 是运行期才知道的，Vite 不能去分析它
    const module = (await import(/* @vite-ignore */ url)) as {
      default?: unknown;
      register?: unknown;
    };
    const register = (module.default ?? module.register) as ((app: PluginAppApi) => void) | undefined;
    if (typeof register !== 'function') {
      throw new Error('插件前端必须 default 导出一个 register(app) 函数');
    }
    return { key, register };
  })();

  bundleCache.set(key, promise);
  promise.catch(() => bundleCache.delete(key));
  return promise;
}

/**
 * 载入所有「启用 + 有前端 + 拿到 ui.mount」的插件。
 *
 * 一个插件加载失败不影响其它插件：错误记进 registry.errors，界面上单独显示。
 */
export async function loadPluginApps(plugins: InstalledPlugin[]): Promise<PluginRegistry> {
  const registry = emptyRegistry();
  const activeBadgePlugins = new Set<string>();
  const targets: InstalledPlugin[] = [];

  for (const plugin of plugins) {
    // 声明式的面不需要前端 bundle，但必须跟 plugin.enabled 一致；
    // 不能要求 plugin.app，否则「启用但没有前端 bundle」的插件会被误删。
    if (plugin.enabled) {
      for (const surface of plugin.contributes.surfaces) {
        if (surface.kind === 'envAction' && surface.command) {
          registry.envActions.push({
            pluginId: plugin.id,
            id: surface.id,
            title: surface.title,
            icon: surface.icon,
            command: surface.command,
          });
        } else if (surface.kind === 'commandBarAction' && surface.command) {
          registry.commandBarActions.push({
            kind: 'commandBarAction',
            pluginId: plugin.id,
            id: surface.id,
            title: surface.title,
            description: surface.description,
            icon: surface.icon,
            shortcut: surface.shortcut,
            command: surface.command,
          });
        }
      }
    }

    if (!plugin.enabled || !plugin.app) continue;
    if (!plugin.granted.includes('ui.mount')) {
      registry.errors.push({ pluginId: plugin.id, message: '没有 ui.mount 权限，界面没有加载' });
      continue;
    }
    targets.push(plugin);
  }

  // 并发拉取各插件前端 ESM bundle，随后按原始清单顺序注册，保持界面顺序确定
  const loaded = await Promise.allSettled(targets.map((plugin) => loadBundle(plugin)));
  for (let index = 0; index < targets.length; index += 1) {
    const plugin = targets[index]!;
    const settled = loaded[index]!;
    if (settled.status === 'rejected') {
      registry.errors.push({ pluginId: plugin.id, message: (settled.reason as Error).message });
      continue;
    }
    try {
      const generation = beginPluginLoad(plugin.id, plugin.digest || plugin.version);
      activeBadgePlugins.add(plugin.id);
      settled.value.register(createApi(plugin, registry, generation));
    } catch (error) {
      activeBadgePlugins.delete(plugin.id);
      registry.errors.push({ pluginId: plugin.id, message: (error as Error).message });
    }
  }

  // 停用 / 卸载 / 加载失败的插件，badge 立刻消失。
  prunePluginBadges(activeBadgePlugins);
  return registry;
}
