/**
 * 插件权限的单一来源。
 *
 * 主进程（manifest 校验、PluginHost 门控）和渲染层（插件授权 UI）都从这里取，
 * 不允许任何一侧再抄一份表——抄一份就必然漂移，UI 会显示错的权限层级。
 */

export const PERMISSIONS = [
  'environment.read',
  'environment.write',
  'browser.dom.read',
  'browser.screenshot',
  'browser.navigate',
  'browser.input',
  'browser.evaluate',
  'storage.cookie.read',
  'storage.cookie.write',
  'storage.cookie.port',
  'vault.fill',
  'network.observe',
  'network.fetch',
  'ui.mount',
  'storage.write',
  'rpc.serve',
  'process.spawn',
  'filesystem.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionTier = 'granted' | 'confirm' | 'denied';

/**
 * 默认授予 / 需要用户确认 / 禁止。
 * denied 里的能力一律不开放，即使插件声明了也不会生效——
 * 「声明了就给」等于把 manifest 当成提权手段。
 */
const TIERS: Record<Permission, PermissionTier> = {
  'environment.read': 'granted',
  /*
   * 改环境配置：换代理出口、让某个环境信任一张自定义 CA、启停环境。
   * 前两条都会改变「这个环境的流量去哪、信谁」，是实打实的安全边界，
   * 所以和 browser.navigate 一样放 confirm 层。
   */
  'environment.write': 'confirm',
  'browser.dom.read': 'granted',
  'browser.screenshot': 'granted',
  'browser.navigate': 'confirm',
  'browser.input': 'confirm',
  'vault.fill': 'confirm',
  'network.observe': 'confirm',
  'network.fetch': 'confirm',
  /*
   * Cookie 受控通道（**只搬运不返回**）：值只在主进程内部流动，插件只拿到
   * 名字 / 域 / 过期 / 标志和计数。设计见 docs/PLUGIN-CAPABILITY-DESIGN.md §9。
   * 上面那两个 read / write 是「拿原始 sessionData」的宽形状，**永远留在 denied**。
   */
  'storage.cookie.port': 'confirm',
  // 挂界面 / 写自己的库 / 给自己的前端提供方法：本身不危险，但要在安装对话框里列出来
  'ui.mount': 'granted',
  'storage.write': 'granted',
  'rpc.serve': 'granted',
  'browser.evaluate': 'denied',
  'storage.cookie.read': 'denied',
  'storage.cookie.write': 'denied',
  'process.spawn': 'denied',
  'filesystem.read': 'denied',
};

export function tierOf(permission: string): PermissionTier {
  return TIERS[permission as Permission] ?? 'denied';
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** 权限的完整分层表，供 UI 展示（只读） */
export const PERMISSION_TIERS: Readonly<Record<string, PermissionTier>> = TIERS;
