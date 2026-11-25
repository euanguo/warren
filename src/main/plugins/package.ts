export const PLUGIN_API_VERSION = '4' as const;

// 权限清单与三层分级是跨进程共享的单一来源，见 src/shared/permissions.ts。
// 这里只做转出，方便主进程内部按老路径引用。
//
// 注意：这两行是**运行时**导入（不是 import type），Node 的 ESM 解析要求显式
// 扩展名——`node --test` 会直接加载本文件，缺扩展名会 ERR_MODULE_NOT_FOUND。
export { PERMISSIONS, isPermission, tierOf, PERMISSION_TIERS } from '../../shared/permissions.ts';
export type { Permission, PermissionTier } from '../../shared/permissions.ts';

import { isPermission, tierOf } from '../../shared/permissions.ts';
import type { Permission } from '../../shared/permissions.ts';
import type {
  PluginCommandDecl,
  PluginContributes,
  PluginRuntime,
  PluginSettingDescriptor,
  PluginSurfaceDecl,
  PluginSurfaceKind,
} from '../../shared/types.ts';

/**
 * 插件包契约。
 *
 * 顶层 package.json 提供 npm 身份与版本；`warren` 字段提供 Warren 运行时契约。
 * 不再读取独立的 manifest.json。
 */
export interface PluginPackage {
  id: string;
  /** npm 包名（package.json#name） */
  packageName: string;
  name: string;
  version: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  runtime: PluginRuntime;
  description?: string;
  /** runtime=sandbox 的后端入口 */
  server?: string;
  /** runtime=host 的子进程入口 */
  host?: string;
  /** 插件前端 ESM */
  app?: string;
  icon?: string;
  engines?: { warren?: string };
  permissions: Permission[];
  contributes: PluginContributes;
}

export interface PackageValidation {
  ok: boolean;
  errors: string[];
  package?: PluginPackage;
  /** 声明里被静默降级的能力，必须显示给用户 */
  downgraded: Permission[];
}

const SURFACE_KINDS: PluginSurfaceKind[] = ['railPage', 'settingsSection', 'envAction', 'inspectorTab', 'envBadge'];
const SETTING_TYPES = ['string', 'number', 'boolean', 'select', 'secret'];
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
/** 命令名就是插件导出的函数名，允许 camelCase */
const COMMAND_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const RPC_METHOD_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

/** 插件目录内的相对路径：不许绝对路径、不许 `..`、不许盘符。 */
export function isSafeRelativePath(entry: string): boolean {
  if (!entry || entry.startsWith('/') || entry.startsWith('\\')) return false;
  if (entry.includes('..')) return false;
  if (/^[a-zA-Z]:/.test(entry)) return false;
  return true;
}

/**
 * `engines.warren` 只支持 `>=x.y.z` / `*` 两种写法。
 * shortcut: 不做完整 semver 区间，插件生态起来之前够用。
 */
export function satisfiesEngines(range: string | undefined, version: string): boolean {
  if (!range || range === '*') return true;
  const match = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range.trim());
  if (!match) return false;
  const want = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const have = version.split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    const a = have[index] ?? 0;
    const b = want[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function objectAt(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function normalizeCommands(raw: unknown, errors: string[]): PluginCommandDecl[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('warren.contributes.commands 必须是数组');
    return [];
  }
  const commands: PluginCommandDecl[] = [];
  for (const item of raw) {
    const value = objectAt(item);
    if (!value) {
      errors.push('命令声明必须是 { name, summary } 对象');
      continue;
    }
    const name = typeof value.name === 'string' ? value.name : '';
    if (!COMMAND_RE.test(name)) {
      errors.push(`命令名非法: ${JSON.stringify(name)}`);
      continue;
    }
    const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
    if (!summary) errors.push(`命令 ${name} 缺少 summary`);
    commands.push({ name, summary: summary || name });
  }
  return commands;
}

function normalizeSettings(raw: unknown, errors: string[]): PluginSettingDescriptor[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('warren.contributes.settings 必须是数组');
    return [];
  }
  const settings: PluginSettingDescriptor[] = [];
  for (const item of raw) {
    const value = objectAt(item);
    if (!value) {
      errors.push('设置声明非法');
      continue;
    }
    const key = typeof value.key === 'string' ? value.key : '';
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) {
      errors.push(`设置 key 非法: ${JSON.stringify(key)}`);
      continue;
    }
    const type = typeof value.type === 'string' ? value.type : '';
    if (!SETTING_TYPES.includes(type)) {
      errors.push(`设置 ${key} 的 type 非法: ${JSON.stringify(type)}`);
      continue;
    }
    const label = typeof value.label === 'string' ? value.label.trim() : '';
    if (!label) errors.push(`设置 ${key} 缺少 label`);
    const options = Array.isArray(value.options)
      ? value.options.filter((option): option is string => typeof option === 'string')
      : undefined;
    if (type === 'select' && (!options || !options.length)) errors.push(`设置 ${key} 是 select 但没有 options`);
    const fallback = value.default;
    if (fallback !== undefined && !['string', 'number', 'boolean'].includes(typeof fallback)) {
      errors.push(`设置 ${key} 的 default 类型非法`);
      continue;
    }
    settings.push({
      key,
      type: type as PluginSettingDescriptor['type'],
      label: label || key,
      description: typeof value.description === 'string' ? value.description : undefined,
      default: fallback as string | number | boolean | undefined,
      options,
    });
  }
  return settings;
}

function normalizeSurfaces(raw: unknown, errors: string[]): PluginSurfaceDecl[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('warren.contributes.surfaces 必须是数组');
    return [];
  }
  const surfaces: PluginSurfaceDecl[] = [];
  for (const item of raw) {
    const value = objectAt(item);
    if (!value) {
      errors.push('面声明非法');
      continue;
    }
    const kind = typeof value.kind === 'string' ? (value.kind as PluginSurfaceKind) : ('' as PluginSurfaceKind);
    if (!SURFACE_KINDS.includes(kind)) {
      errors.push(`未知的挂载类型: ${JSON.stringify(value.kind)}`);
      continue;
    }
    const id = typeof value.id === 'string' ? value.id : '';
    if (!NAME_RE.test(id)) {
      errors.push(`面 id 非法: ${JSON.stringify(id)}`);
      continue;
    }
    const title = typeof value.title === 'string' ? value.title.trim() : '';
    if (!title) errors.push(`面 ${kind}/${id} 缺少 title`);
    if (kind === 'envAction' && typeof value.command !== 'string') {
      errors.push(`envAction ${id} 必须声明 command`);
    }
    surfaces.push({
      kind,
      id,
      title: title || id,
      description: typeof value.description === 'string' ? value.description : undefined,
      icon: typeof value.icon === 'string' ? value.icon : undefined,
      command: typeof value.command === 'string' ? value.command : undefined,
      path: typeof value.path === 'string' ? value.path : undefined,
    });
  }
  return surfaces;
}

function normalizeRpc(raw: unknown, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('warren.contributes.rpc 必须是数组');
    return [];
  }
  const methods: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !RPC_METHOD_RE.test(item)) {
      errors.push(`rpc 方法名非法: ${JSON.stringify(item)}`);
      continue;
    }
    methods.push(item);
  }
  return methods;
}

/** 校验一个完整 package.json。 */
export function validatePluginPackage(raw: unknown): PackageValidation {
  const errors: string[] = [];
  const pkg = objectAt(raw);
  if (!pkg) return { ok: false, errors: ['package.json 不是对象'], downgraded: [] };

  const packageName = typeof pkg.name === 'string' ? pkg.name.trim() : '';
  if (!PACKAGE_NAME_RE.test(packageName)) {
    errors.push(`package.json#name 非法: ${JSON.stringify(packageName)}`);
  }

  const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
    errors.push(`package.json#version 非法: ${JSON.stringify(version)}`);
  }

  const warren = objectAt(pkg.warren);
  if (!warren) return { ok: false, errors: [...errors, '缺少 package.json#warren'], downgraded: [] };

  const str = (key: string): string => (typeof warren[key] === 'string' ? (warren[key] as string) : '');
  const id = str('id');
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) errors.push(`warren.id 非法: ${JSON.stringify(id)}`);

  const apiVersion = str('apiVersion');
  if (apiVersion !== PLUGIN_API_VERSION) {
    errors.push(`warren.apiVersion 必须是 ${PLUGIN_API_VERSION}，收到 ${JSON.stringify(apiVersion)}`);
  }

  const name = str('name');
  if (!name) errors.push('warren.name 不能为空');

  const runtimeRaw = warren.runtime;
  const runtime: PluginRuntime | undefined = runtimeRaw === 'sandbox' || runtimeRaw === 'host' ? runtimeRaw : undefined;
  if (!runtime) errors.push(`warren.runtime 只能是 sandbox 或 host，收到 ${JSON.stringify(runtimeRaw)}`);

  const server = str('server');
  const host = str('host');
  if (runtime === 'sandbox' && !isSafeRelativePath(server)) {
    errors.push(`runtime=sandbox 时 warren.server 必须是包内相对路径: ${JSON.stringify(server)}`);
  }
  if (runtime === 'host' && !isSafeRelativePath(host)) {
    errors.push(`runtime=host 时 warren.host 必须是包内相对路径: ${JSON.stringify(host)}`);
  }
  if (runtime === 'sandbox' && host) errors.push('runtime=sandbox 不应声明 warren.host');
  if (runtime === 'host' && server) errors.push('runtime=host 不应声明 warren.server');

  const app = str('app');
  if (app && !isSafeRelativePath(app)) errors.push(`warren.app 必须是包内相对路径: ${JSON.stringify(app)}`);

  const icon = str('icon');
  if (icon && !isSafeRelativePath(icon)) errors.push(`warren.icon 必须是包内相对路径: ${JSON.stringify(icon)}`);

  const enginesRaw = warren.engines;
  let engines: { warren?: string } | undefined;
  if (enginesRaw !== undefined) {
    const value = objectAt(enginesRaw);
    if (!value) {
      errors.push('warren.engines 必须是对象');
    } else if (value.warren !== undefined && typeof value.warren !== 'string') {
      errors.push('warren.engines.warren 必须是字符串');
    } else {
      engines = typeof value.warren === 'string' ? { warren: value.warren } : undefined;
    }
  }

  const declared = Array.isArray(warren.permissions) ? warren.permissions : [];
  const permissions: Permission[] = [];
  const downgraded: Permission[] = [];
  for (const item of declared) {
    if (typeof item !== 'string' || !isPermission(item)) {
      errors.push(`未知权限: ${JSON.stringify(item)}`);
      continue;
    }
    if (tierOf(item) === 'denied') {
      downgraded.push(item);
      continue;
    }
    permissions.push(item);
  }

  const contributesRaw = objectAt(warren.contributes) ?? {};
  const contributes: PluginContributes = {
    commands: normalizeCommands(contributesRaw.commands, errors),
    settings: normalizeSettings(contributesRaw.settings, errors),
    surfaces: normalizeSurfaces(contributesRaw.surfaces, errors),
    rpc: normalizeRpc(contributesRaw.rpc, errors),
  };

  if (contributes.surfaces.length && !permissions.includes('ui.mount')) {
    errors.push('声明了 surfaces 就必须声明 ui.mount 权限');
  }
  if (contributes.rpc.length && !permissions.includes('rpc.serve')) {
    errors.push('声明了 rpc 就必须声明 rpc.serve 权限');
  }
  if (contributes.settings.length && !permissions.includes('storage.write')) {
    errors.push('声明了 settings 就必须声明 storage.write 权限');
  }

  if (errors.length || !runtime) return { ok: false, errors, downgraded };

  return {
    ok: true,
    errors: [],
    downgraded,
    package: {
      id,
      packageName,
      name,
      version,
      apiVersion: PLUGIN_API_VERSION,
      runtime,
      description: typeof pkg.description === 'string' && pkg.description.trim() ? pkg.description.trim() : undefined,
      server: runtime === 'sandbox' ? server : undefined,
      host: runtime === 'host' ? host : undefined,
      app: app || undefined,
      icon: icon || undefined,
      engines,
      permissions,
      contributes,
    },
  };
}

/** 升级时比较权限，新增的 confirm/denied 能力必须让用户重新确认 */
export function diffPermissions(
  before: Permission[],
  after: Permission[],
): { added: Permission[]; removed: Permission[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((permission) => !beforeSet.has(permission)),
    removed: before.filter((permission) => !afterSet.has(permission)),
  };
}

export function needsUserConfirmation(permissions: Permission[]): Permission[] {
  return permissions.filter((permission) => tierOf(permission) === 'confirm');
}
