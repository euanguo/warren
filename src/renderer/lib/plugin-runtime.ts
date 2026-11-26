/**
 * 插件前端运行时。
 *
 * 插件产物是一个普通 ESM bundle，由主进程通过 `warren-plugin://<id>/app.js` 供给。
 * 这里做三件事：
 * 1. 把宿主 React / rpc / 信号钩子挂到 `window.__WARREN__`（插件不打包第二份 React，
 *    自带一份会让 hooks 直接崩）；
 * 2. `import()` 插件的 bundle，调它的 `register(app)`；
 * 3. 收集它注册的「面」，**只接受清单里声明过的**（fail closed）。
 *
 * 面本身由 warren 自己的组件渲染，插件只提供组件与数据。
 */
import { useEffect, useRef, type ComponentType } from 'react';
import * as React from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ListRow,
  ListRowActionButton,
  ListRowActions,
  ListRowLabel,
  ListRowLabelText,
  ListRowMain,
  ListRowMeta,
} from '@/components/ui/list-row';
import { cardSurfaceClass, controlFieldClass } from '@/theme/surface';
import { cn } from '@/lib/utils';
import {
  beginPluginLoad,
  clearPluginBadgeSurface,
  prunePluginBadges,
  registerPluginBadgeSurface,
  setPluginEnvBadge,
  type PluginEnvBadge,
  type PluginEnvBadgeSetter,
  type PluginEnvBadgeSurface,
} from '@/lib/plugin-badges';
import { openPluginPage, openSettings, type BuiltinSettingsSection } from '@/state/navigation-store';
import type { HostEnvironmentSummary, InstalledPlugin, PluginSettingValue, PluginSignal } from '@shared/types';

const ALLOWED_PLUGIN_SETTINGS_SECTIONS: ReadonlySet<BuiltinSettingsSection> = new Set([
  'general',
  'browser',
  'agent',
  'vault',
  'plugins',
  'diagnostics',
]);

export function isAllowedPluginSettingsSection(section: string): section is BuiltinSettingsSection {
  return ALLOWED_PLUGIN_SETTINGS_SECTIONS.has(section as BuiltinSettingsSection);
}

/**
 * 插件能用的宿主 UI —— **单一出口**。
 *
 * 为什么要有它：插件 bundle 是独立的一份 ESM，走 `warren-plugin://` 供给，**import 不到宿主的
 * 模块图**（`@/components/ui/*` 对它是不可见的）。没有这层，插件只能手写 `<div className="rounded-md
 * border border-border">` —— 那等于每个插件自己抄一遍设计契约，token / recipe / 角形状全绕过了。
 *
 * 规矩（和宿主自己的组件用法一致，见 `components/ui/README.md`）：
 * - 用这里的组件，**不要**自己拼 chrome；要特殊布局就用 `cn` 拼 Tailwind 工具类。
 * - 几何 / 颜色只从组件和 recipe（`cardSurfaceClass` / `controlFieldClass`）来，不写死 hex / `h-8`。
 * - 这份清单就是**兼容面**：插件只能拿到这里有的东西，加东西是加法，改/删要走 `apiVersion`。
 *
 * 这是 renderer 与插件之间的边界类型，所以放这儿而不是 `shared/`——它不过 RPC。
 */
export const PLUGIN_UI = {
  // 工具
  cn,
  toast,
  cardSurfaceClass,
  controlFieldClass,
  // 图标（`components/icons.tsx` 是图标单源，插件不引图标包）
  Icon,
  // 基础控件
  Button,
  IconButton,
  Input,
  Textarea,
  Switch,
  Checkbox,
  Badge,
  Separator,
  Spinner,
  // 表单
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  // 对话框
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  // 确认框（破坏性操作用它，别用 Dialog 自己拼）
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
  // 选择器
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
  // 菜单
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  // 提示
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
  // 容器
  ScrollArea,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  // 列表行（插件面板里的行用它，别手写 hover / 选中态）
  ListRow,
  ListRowMain,
  ListRowLabel,
  ListRowLabelText,
  ListRowMeta,
  ListRowActions,
  ListRowActionButton,
} as const;

export type PluginUi = typeof PLUGIN_UI;

export interface PluginSurfaceProps {
  pluginId: string;
  /** inspectorTab / envAction 这类跟环境相关的面会拿到 */
  environmentId?: string;
  /** railPage 的子路径（`warren-plugin://<id>/<path>` 里 path 之后的部分） */
  subPath?: string;
}

export interface PluginRailPage {
  kind: 'railPage';
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  path?: string;
  component: ComponentType<PluginSurfaceProps>;
}

export interface PluginSettingsSection {
  kind: 'settingsSection';
  pluginId: string;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  component: ComponentType<PluginSurfaceProps>;
}

export interface PluginInspectorTab {
  kind: 'inspectorTab';
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  component: ComponentType<PluginSurfaceProps>;
}

/** envAction 是声明式的：界面由 warren 的环境菜单渲染，插件只给「动作 → 命令」。 */
export interface PluginEnvAction {
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  command: string;
}

export interface PluginPopoverSurface {
  kind: 'popover';
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  shortcut?: string;
  component: ComponentType<PluginSurfaceProps>;
}

export interface PluginCommandBarAction {
  kind: 'commandBarAction';
  pluginId: string;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  shortcut?: string;
  command?: string;
  onTrigger?: (environmentId?: string) => Promise<void> | void;
}

export interface PluginStatusBadge {
  kind: 'statusBadge';
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  component?: ComponentType<PluginSurfaceProps>;
}

/** 声明式视图节点描述（供轻量插件无需手写 JS bundle 直接由宿主渲染，组件实现在 app/plugin-surfaces.tsx） */
export type DeclarativeViewNode =
  | { type: 'text'; value: string; muted?: boolean }
  | { type: 'keyValue'; items: Array<{ label: string; value: string }> }
  | { type: 'button'; label: string; rpcMethod?: string; command?: string; input?: unknown };

export async function runDeclarativeButtonAction(
  pluginId: string,
  node: Extract<DeclarativeViewNode, { type: 'button' }>,
  environmentId?: string,
): Promise<void> {
  if (node.rpcMethod) {
    await callPluginRpc(pluginId, node.rpcMethod, node.input);
    toast.success('操作已执行');
  } else if (node.command && environmentId) {
    await window.envApi.pluginRun(pluginId, node.command, environmentId);
    toast.success('命令已执行');
  }
}

export interface PluginRegistry {
  railPages: PluginRailPage[];
  settingsSections: PluginSettingsSection[];
  inspectorTabs: PluginInspectorTab[];
  envActions: PluginEnvAction[];
  popovers: PluginPopoverSurface[];
  commandBarActions: PluginCommandBarAction[];
  statusBadges: PluginStatusBadge[];
  errors: Array<{ pluginId: string; message: string }>;
}

/** 插件前端能直连的宿主只读能力（白名单见 shared/plugin-host-api.ts）。 */
export interface PluginHostApi {
  environment: {
    list(): Promise<HostEnvironmentSummary[]>;
    get(id: string): Promise<HostEnvironmentSummary | null>;
  };
  browser: {
    info(environmentId: string): Promise<{ url: string; title: string }>;
  };
}

export interface PluginSettingsHook {
  values: PluginSettingValue[];
  isLoading: boolean;
  refresh(): Promise<void>;
}

export function emptyRegistry(): PluginRegistry {
  return {
    railPages: [],
    settingsSections: [],
    inspectorTabs: [],
    envActions: [],
    popovers: [],
    commandBarActions: [],
    statusBadges: [],
    errors: [],
  };
}

export interface PluginAppApi {
  pluginId: string;
  React: typeof React;
  /** `React.createElement` 的短名——插件 bundle 没有构建步骤，用 h(...) 写界面 */
  h: typeof React.createElement;
  /** 宿主的通用组件库（见 `PLUGIN_UI` 的注释）。插件界面用它，不要手写 chrome。 */
  ui: PluginUi;
  rpc: { call<T = unknown>(method: string, input?: unknown): Promise<T> };
  /** 只读宿主能力；写操作和插件自己的数据走 `rpc`。 */
  host: PluginHostApi;
  /** 受控宿主导航：仅允许跳往当前插件清单已声明的 railPage 或白名单设置分节。 */
  navigation: {
    openPage(surfaceId: string): void;
    openSettings(section?: BuiltinSettingsSection): void;
  };
  /** 当前插件自己的设置快照；secret 只有 configured，没有 value。 */
  settings: PluginSettingValue[];
  /** 便利 hook：返回 settings 快照，并可走现有 `plugins()` 刷新。 */
  useSettings(): PluginSettingsHook;
  useSignal(channel: string, handler: (payload: unknown) => void): void;
  log(message: string): void;
  surfaces: {
    railPage(surface: Omit<PluginRailPage, 'kind' | 'pluginId'>): void;
    settingsSection(surface: Omit<PluginSettingsSection, 'kind' | 'pluginId'>): void;
    inspectorTab(surface: Omit<PluginInspectorTab, 'kind' | 'pluginId'>): void;
    popover(surface: Omit<PluginPopoverSurface, 'kind' | 'pluginId'>): void;
    commandBarAction(surface: Omit<PluginCommandBarAction, 'kind' | 'pluginId'>): void;
    statusBadge(surface: Omit<PluginStatusBadge, 'kind' | 'pluginId'>): void;
    /** 环境行状态芯片：清单声明 + 返回 setter；宿主只负责一个槽的渲染。 */
    envBadge(surface: PluginEnvBadgeSurface): PluginEnvBadgeSetter;
  };
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
      },
      browser: {
        info: (environmentId) => callHostRead(plugin.id, 'browser.info', environmentId),
      },
    },
    navigation: {
      openPage: (surfaceId: string) => {
        if (!declared.has(`railPage:${surfaceId}`)) {
          console.warn(`[plugin:${plugin.id}] 拒绝跳转未声明的 railPage: ${surfaceId}`);
          return;
        }
        openPluginPage(plugin.id, surfaceId);
      },
      openSettings: (section?: BuiltinSettingsSection) => {
        if (!section) {
          openSettings();
          return;
        }
        if (!isAllowedPluginSettingsSection(section)) {
          console.warn(`[plugin:${plugin.id}] 拒绝跳转非法设置分节: ${String(section)}`);
          return;
        }
        openSettings(section);
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
    try {
      const generation = beginPluginLoad(plugin.id, plugin.digest || plugin.version);
      activeBadgePlugins.add(plugin.id);
      const bundle = await loadBundle(plugin);
      bundle.register(createApi(plugin, registry, generation));
    } catch (error) {
      activeBadgePlugins.delete(plugin.id);
      registry.errors.push({ pluginId: plugin.id, message: (error as Error).message });
    }
  }

  // 停用 / 卸载 / 加载失败的插件，badge 立刻消失。
  prunePluginBadges(activeBadgePlugins);
  return registry;
}

/** 插件 bundle 里也可以直接从这里拿宿主能力（等价于 register 的入参）。 */
declare global {
  interface Window {
    __WARREN__?: { React: typeof React; h: typeof React.createElement; ui: PluginUi };
  }
}

window.__WARREN__ = { React, h: React.createElement, ui: PLUGIN_UI };
