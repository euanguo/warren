/**
 * 插件前端能直连的宿主只读能力白名单。
 *
 * 这里是**单一来源**：主进程按它分发，渲染层按它构造 `app.host`。
 * 注意：插件前端和应用界面同 realm，绕过 `app.host` 直接调 IPC 在技术上做得到；
 * 这张表防的是合作型插件的误用，不是恶意代码。
 */
export const PLUGIN_HOST_READ_METHODS = [
  'environment.list',
  'environment.get',
  'environment.activeContext',
  'browser.info',
] as const;

export type PluginHostReadMethod = (typeof PLUGIN_HOST_READ_METHODS)[number];

export function isPluginHostReadMethod(value: string): value is PluginHostReadMethod {
  return (PLUGIN_HOST_READ_METHODS as readonly string[]).includes(value);
}
