/**
 * 插件专属双色/微彩品牌映射。
 *
 * 遵循「工具静，身份彩」原则：高频浏览器工具图标保持单色，
 * 拥有独立生态身份的插件使用柔和双色微标，破除「全屏灰拼图」同质化。
 */
export interface PluginBrand {
  icon: string;
  hue: number;
}

const KNOWN_PLUGIN_BRANDS: Readonly<Record<string, PluginBrand>> = {
  'com.warren.whistle': { icon: 'Globe', hue: 199 },
  'com.warren.accounts': { icon: 'User', hue: 36 },
  'com.example.notes': { icon: 'List', hue: 263 },
  'com.example.login': { icon: 'Key', hue: 158 },
  'com.example.cookies': { icon: 'Cookie', hue: 217 },
  'com.example.host': { icon: 'Terminal', hue: 332 },
  'com.example.hosty': { icon: 'Terminal', hue: 332 },
  'com.example.broken': { icon: 'Bug', hue: 14 },
};

const FALLBACK_HUES = [215, 165, 36, 274, 192, 332, 14, 52] as const;

function hashHue(pluginId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < pluginId.length; i += 1) {
    hash ^= pluginId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return FALLBACK_HUES[Math.abs(hash) % FALLBACK_HUES.length] ?? 215;
}

export function getPluginBrand(pluginId: string, preferredIcon?: string): PluginBrand {
  const known = KNOWN_PLUGIN_BRANDS[pluginId];
  if (known) {
    return {
      icon: preferredIcon && preferredIcon !== 'Plug' ? preferredIcon : known.icon,
      hue: known.hue,
    };
  }
  return {
    icon: preferredIcon || 'Plug',
    hue: hashHue(pluginId),
  };
}
