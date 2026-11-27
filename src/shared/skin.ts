/**
 * 可抽离、可配置的配色皮肤契约与派生引擎（纯配色层）。
 *
 * 架构边界：
 * - 皮肤**只允许**定义和覆盖色板（`SKIN_COLOR_KEYS` 中的 12 个 Hex 颜色）。
 * - 所有结构性基础 Token（字号、控件高度阶梯、圆角、间距、动效曲线、布局尺寸、层级）
 *   锁定在 `src/renderer/theme/theme-tokens.css` 的 Foundation 层，皮肤不可改写。
 * - 纯 TypeScript、零 Electron / DOM 依赖，可被主进程、渲染层与 `node:test` 直接导入。
 */

export const SKIN_COLOR_KEYS = [
  'canvas',
  'frame',
  'sidebar',
  'surface',
  'text',
  'textMuted',
  'border',
  'accent',
  'accentForeground',
  'success',
  'warning',
  'danger',
] as const;

export type SkinColorKey = (typeof SKIN_COLOR_KEYS)[number];
export type SkinScheme = 'dark' | 'light';
export type SkinColorPalette = Record<SkinColorKey, string>;

export interface SkinColorOverrides {
  dark?: Partial<SkinColorPalette>;
  light?: Partial<SkinColorPalette>;
}

export interface SkinDefinition {
  id: string;
  name: string;
  description: string;
  dark: SkinColorPalette;
  light: SkinColorPalette;
}

export interface SkinColorFieldMeta {
  key: SkinColorKey;
  label: string;
  group: 'surface' | 'text' | 'brand' | 'status';
  description: string;
}

export const SKIN_COLOR_META: readonly SkinColorFieldMeta[] = [
  { key: 'frame', label: '外框底色', group: 'surface', description: '标题栏与窗口外缘底色' },
  { key: 'canvas', label: '主画布', group: 'surface', description: '主工作区圆角卡片底色' },
  { key: 'sidebar', label: '侧边栏', group: 'surface', description: '左侧环境栏底色' },
  { key: 'surface', label: '控件表面', group: 'surface', description: '卡片、菜单、输入框与浮层表面' },
  { key: 'border', label: '边框基色', group: 'surface', description: '细边框、分隔线与弹窗描边基准色' },
  { key: 'text', label: '主文字', group: 'text', description: '主要正文与高对比动作色' },
  { key: 'textMuted', label: '次文字', group: 'text', description: '辅助说明、次级标签与图标色' },
  { key: 'accent', label: '强调色', group: 'brand', description: '品牌强调、链接、激活标记与焦点色' },
  { key: 'accentForeground', label: '强调前景色', group: 'brand', description: '强调色底上的文字/图标色' },
  { key: 'success', label: '成功色', group: 'status', description: '运行中、正常与成功状态' },
  { key: 'warning', label: '警告色', group: 'status', description: '等待确认、休眠与提醒状态' },
  { key: 'danger', label: '危险色', group: 'status', description: '错误、报错与破坏性操作' },
] as const;

export const DEFAULT_SKIN_ID = 'neutral' as const;

/**
 * 内置预设皮肤库（纯数据，可抽离/替换，不携带任何非颜色 Token）。
 * 默认 `neutral` 严格遵循零色偏中性碳黑 / 柔白阶梯。
 */
export const BUILTIN_SKINS: readonly SkinDefinition[] = [
  {
    id: 'neutral',
    name: '纯中性',
    description: '零色偏碳黑与柔白阶梯，克制低噪的工作台默认配色',
    dark: {
      frame: '#0d0d0d',
      canvas: '#1a1a1a',
      sidebar: '#1a1a1a',
      surface: '#212121',
      text: '#ffffff',
      textMuted: '#979797',
      border: '#38383a',
      accent: '#007cf7',
      accentForeground: '#ffffff',
      success: '#31cf76',
      warning: '#ff9412',
      danger: '#fd2f3b',
    },
    light: {
      frame: '#e8e8eb',
      canvas: '#f5f5f6',
      sidebar: '#f5f5f6',
      surface: '#ffffff',
      text: '#141414',
      textMuted: '#6b6b70',
      border: '#c7c7cc',
      accent: '#007cf7',
      accentForeground: '#ffffff',
      success: '#1fa85a',
      warning: '#f08a00',
      danger: '#e8222d',
    },
  },
  {
    id: 'graphite',
    name: '冷调石墨',
    description: '微冷石板灰与银雾画布，强化信息层级与代码阅读感',
    dark: {
      frame: '#0b0d11',
      canvas: '#15181f',
      sidebar: '#15181f',
      surface: '#1d212b',
      text: '#f5f7fb',
      textMuted: '#8f99ad',
      border: '#343b4a',
      accent: '#3b82f6',
      accentForeground: '#ffffff',
      success: '#34d399',
      warning: '#f59e0b',
      danger: '#f87171',
    },
    light: {
      frame: '#e3e7ef',
      canvas: '#f2f4f8',
      sidebar: '#f2f4f8',
      surface: '#ffffff',
      text: '#111621',
      textMuted: '#5b6578',
      border: '#c2cada',
      accent: '#2563eb',
      accentForeground: '#ffffff',
      success: '#059669',
      warning: '#d97706',
      danger: '#dc2626',
    },
  },
  {
    id: 'paper',
    name: '暖墨宣纸',
    description: '低眩光暖炭与温润米白，适合长时间浏览与批注',
    dark: {
      frame: '#100f0d',
      canvas: '#1c1a17',
      sidebar: '#1c1a17',
      surface: '#26231f',
      text: '#f7f3ec',
      textMuted: '#a0988b',
      border: '#3f3a32',
      accent: '#e08b2c',
      accentForeground: '#14120f',
      success: '#46c881',
      warning: '#f0a22e',
      danger: '#ef5350',
    },
    light: {
      frame: '#e8e3da',
      canvas: '#f6f3ed',
      sidebar: '#f6f3ed',
      surface: '#fffdfa',
      text: '#1d1a15',
      textMuted: '#6f675b',
      border: '#cec6b9',
      accent: '#c26d15',
      accentForeground: '#ffffff',
      success: '#1d8f52',
      warning: '#c77708',
      danger: '#cc2929',
    },
  },
  {
    id: 'obsidian',
    name: '极夜纯黑',
    description: '高对比 OLED 极黑与明锐纯白，突出边界与数据密度',
    dark: {
      frame: '#050505',
      canvas: '#101010',
      sidebar: '#101010',
      surface: '#191919',
      text: '#ffffff',
      textMuted: '#8e8e93',
      border: '#323236',
      accent: '#0a84ff',
      accentForeground: '#ffffff',
      success: '#30d158',
      warning: '#ff9f0a',
      danger: '#ff453a',
    },
    light: {
      frame: '#e4e4e7',
      canvas: '#fafafa',
      sidebar: '#fafafa',
      surface: '#ffffff',
      text: '#09090b',
      textMuted: '#63636c',
      border: '#c4c4cc',
      accent: '#0066e6',
      accentForeground: '#ffffff',
      success: '#16a34a',
      warning: '#ea8c00',
      danger: '#dc2626',
    },
  },
] as const;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SKIN_COLOR_KEY_SET = new Set<string>(SKIN_COLOR_KEYS);
const BUILTIN_SKIN_MAP = new Map<string, SkinDefinition>(BUILTIN_SKINS.map((skin) => [skin.id, skin]));

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.trim());
}

export function isSkinId(value: unknown): value is string {
  return typeof value === 'string' && BUILTIN_SKIN_MAP.has(value);
}

export function resolveSkinDefinition(skinId?: string): SkinDefinition {
  if (skinId && BUILTIN_SKIN_MAP.has(skinId)) {
    return BUILTIN_SKIN_MAP.get(skinId)!;
  }
  return BUILTIN_SKIN_MAP.get(DEFAULT_SKIN_ID)!;
}

/**
 * 清洗单套配色补丁：严格只保留 `SKIN_COLOR_KEYS` 中且符合 `#rrggbb` 格式的颜色字段。
 * 任何圆角、字号、间距、阴影、高度等非颜色键都会被丢弃，防止皮肤越界破坏基础规范。
 */
export function sanitizeSkinColorPatch(input: unknown): Partial<SkinColorPalette> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: Partial<SkinColorPalette> = {};
  for (const [key, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (!SKIN_COLOR_KEY_SET.has(key)) continue;
    if (!isHexColor(rawValue)) continue;
    result[key as SkinColorKey] = rawValue.trim().toLowerCase();
  }
  return result;
}

/**
 * 校验外部导入的配色 JSON（用于配置导入或设置面板）：
 * 返回有效颜色与被拦截的非配色/非法字段清单。
 */
export function validateSkinOverridesInput(input: unknown):
  | {
      ok: true;
      overrides: SkinColorOverrides;
      ignoredKeys: string[];
    }
  | { ok: false; error: string } {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { ok: true, overrides: {}, ignoredKeys: [] };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: '皮肤配置不是合法的 JSON 格式' };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '皮肤配置必须是 JSON 对象（仅支持 dark / light 或 12 个配色键）' };
  }

  const record = parsed as Record<string, unknown>;
  const ignoredKeys: string[] = [];
  const overrides: SkinColorOverrides = {};

  const hasSchemeBuckets = 'dark' in record || 'light' in record;
  if (hasSchemeBuckets) {
    for (const [bucketKey, bucketValue] of Object.entries(record)) {
      if (bucketKey !== 'dark' && bucketKey !== 'light') {
        ignoredKeys.push(bucketKey);
        continue;
      }
      if (!bucketValue || typeof bucketValue !== 'object' || Array.isArray(bucketValue)) {
        ignoredKeys.push(bucketKey);
        continue;
      }
      const clean: Partial<SkinColorPalette> = {};
      for (const [k, v] of Object.entries(bucketValue as Record<string, unknown>)) {
        if (!SKIN_COLOR_KEY_SET.has(k) || !isHexColor(v)) {
          ignoredKeys.push(`${bucketKey}.${k}`);
          continue;
        }
        clean[k as SkinColorKey] = v.trim().toLowerCase();
      }
      if (Object.keys(clean).length > 0) {
        overrides[bucketKey] = clean;
      }
    }
    return { ok: true, overrides, ignoredKeys };
  }

  // 允许单层简写 `{ "accent": "#ff5500" }` —— 自动忽略所有非配色键
  const flatClean: Partial<SkinColorPalette> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!SKIN_COLOR_KEY_SET.has(k) || !isHexColor(v)) {
      ignoredKeys.push(k);
      continue;
    }
    flatClean[k as SkinColorKey] = v.trim().toLowerCase();
  }
  if (Object.keys(flatClean).length > 0) {
    overrides.dark = { ...flatClean };
    overrides.light = { ...flatClean };
  }
  return { ok: true, overrides, ignoredKeys };
}

/** 从存储字符串或对象安全解析 `AppSettings.skinOverrides`，保证永不抛出且零越界键。 */
export function sanitizeSkinOverrides(input: unknown): SkinColorOverrides {
  const checked = validateSkinOverridesInput(input);
  return checked.ok ? checked.overrides : {};
}

export function hasSkinOverrides(overrides?: SkinColorOverrides): boolean {
  if (!overrides) return false;
  return (
    (overrides.dark !== undefined && Object.keys(overrides.dark).length > 0) ||
    (overrides.light !== undefined && Object.keys(overrides.light).length > 0)
  );
}

/** 合并基础皮肤与配色覆写，输出当前明暗模式下的完整 12 色板。 */
export function resolveSkinPalette(
  skinId: string | undefined,
  scheme: SkinScheme,
  overrides?: SkinColorOverrides,
): SkinColorPalette {
  const base = resolveSkinDefinition(skinId)[scheme];
  const patch = overrides?.[scheme] ? sanitizeSkinColorPatch(overrides[scheme]) : {};
  return { ...base, ...patch };
}

function clear(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

function mix(color: string, other: string, percent: number): string {
  return `color-mix(in srgb, ${color}, ${other} ${percent}%)`;
}

/**
 * 将 12 色皮肤色板派生为完整的 CSS 颜色变量集合。
 *
 * 严格约束：返回值只允许包含颜色类 CSS Custom Property，
 * 绝不输出圆角、字体、字号、高度、间距、动画时长或 z-index。
 */
export function deriveSkinCssVars(palette: SkinColorPalette, scheme: SkinScheme): Record<string, string> {
  const isLight = scheme === 'light';
  const surface = palette.surface;
  const surfaceRaised = isLight ? mix(palette.canvas, '#ffffff', 75) : mix(surface, palette.text, 3);
  const controlHover = isLight ? mix(palette.canvas, palette.text, 3) : mix(surface, palette.text, 4);
  const controlActive = isLight ? mix(palette.canvas, palette.text, 7) : mix(surface, palette.text, 9);
  const tabsBarBg = isLight ? mix(palette.canvas, palette.frame, 55) : surface;
  const tabsPillBg = isLight ? surface : mix(surface, palette.text, 8);
  const sheetBg = isLight ? surface : mix(palette.frame, palette.canvas, 50);

  const primaryBg = isLight ? mix(palette.text, '#ffffff', 4) : mix(palette.text, palette.canvas, 6);
  const primaryFg = isLight ? '#ffffff' : sheetBg;

  const textSecondary = mix(palette.text, palette.textMuted, isLight ? 30 : 25);
  const textDim = mix(palette.textMuted, palette.canvas, isLight ? 24 : 32);

  const borderSubtle = clear(palette.border, isLight ? 42 : 24);
  const borderStrong = clear(palette.border, isLight ? 60 : 38);
  const borderHeavy = clear(palette.border, isLight ? 80 : 62);
  const dialogRing = clear(palette.border, isLight ? 70 : 65);
  const menuEdge = clear(palette.text, 11);
  const menuHighlight = clear(palette.text, 5);

  const hoverWash = clear(palette.text, isLight ? 5 : 6);
  // OpenBot 光学对齐：暗色选中行直接复用 surface（无多余外框）；浅色在浅灰画布上抬升为纯白 + 极轻发丝边（零阴影）
  const selectedBg = surface;
  const selectedBorder = isLight ? borderSubtle : 'transparent';
  // 检视器 / 面板胶囊标签选中态：暗色对齐 OpenBot side-panel-tab（controlActive），浅色保持纯白不发灰
  const tabSelectedBg = isLight ? surface : controlActive;
  // 菜单 / Popover 内部悬停高亮（OpenBot --ui-menu-item-hover: text 6%），浅色纯白底上不会撞色
  const highlightBg = clear(palette.text, 6);
  const activeWash = clear(palette.text, isLight ? 8.5 : 12);
  const fogWash = clear(palette.text, isLight ? 3.5 : 4.5);

  const accentHover = isLight ? mix(palette.accent, '#000000', 14) : mix(palette.accent, '#ffffff', 14);
  const accentText = isLight ? mix(palette.accent, '#000000', 16) : mix(palette.accent, '#ffffff', 24);
  const dangerHover = mix(palette.danger, palette.text, 15);
  const dangerText = isLight ? mix(palette.danger, '#000000', 16) : mix(palette.danger, '#ffffff', 22);
  const successText = isLight ? mix(palette.success, '#000000', 22) : palette.success;
  const warningText = isLight ? mix(palette.warning, '#000000', 30) : palette.warning;

  // OpenBot Tooltip 与 ActionMenu 共享实色 bg-sheet 表面与正文对比色
  const tooltipBg = sheetBg;
  const tooltipFg = palette.text;

  return {
    // ── 核心皮肤种子 ──
    '--theme-surface': palette.canvas,
    '--theme-surface-under': palette.frame,
    '--theme-ink': palette.text,
    '--theme-accent': palette.accent,

    // ── OpenBot 语义层级表面 ──
    '--bg-frame': palette.frame,
    '--bg-canvas': palette.canvas,
    '--bg-canvas-clear': clear(palette.canvas, 0),
    '--bg-sidebar': palette.sidebar,
    '--bg-sheet': sheetBg,
    '--bg-sheet-inset': isLight ? mix(palette.canvas, palette.frame, 45) : mix(palette.frame, '#000000', 15),
    '--bg-grouped': surface,
    '--bg-surface': surface,
    '--bg-surface-raised': surfaceRaised,
    '--bg-control': surface,
    '--bg-control-hover': controlHover,
    '--bg-control-active': controlActive,
    '--tabs-bar-bg': tabsBarBg,
    '--tabs-pill-bg': tabsPillBg,
    '--bg-overlay': clear(palette.canvas, 92),
    '--dialog-overlay': isLight ? 'rgba(20, 20, 20, 0.14)' : 'rgba(0, 0, 0, 0.36)',
    '--dialog-ring': dialogRing,
    '--hover': hoverWash,

    // ── 边框与焦点（1px 中性细线） ──
    '--border': borderSubtle,
    '--border-light': clear(palette.border, isLight ? 28 : 24),
    '--border-strong': borderStrong,
    '--border-heavy': borderHeavy,
    '--border-grouped': palette.border,
    '--border-focus': palette.textMuted,
    '--menu-border': menuEdge,
    '--menu-edge': menuEdge,
    '--menu-highlight': menuHighlight,
    '--divider': borderSubtle,
    '--focus': palette.textMuted,
    '--ring': palette.textMuted,

    // ── 文字阶梯 ──
    '--ink': palette.text,
    '--foreground': palette.text,
    '--text-secondary': textSecondary,
    '--muted-foreground': palette.textMuted,
    '--subtle-foreground': textDim,
    '--status-idle': textDim,

    // ── 动作与强调色 ──
    '--primary': primaryBg,
    '--primary-foreground': primaryFg,
    '--secondary': hoverWash,
    '--secondary-foreground': palette.text,
    '--muted': fogWash,
    '--accent': hoverWash,
    '--accent-foreground': palette.text,
    '--accent-seed': palette.accent,
    '--accent-hover': accentHover,
    '--accent-text': accentText,
    '--accent-soft': clear(palette.accent, isLight ? 12 : 16),
    '--accent-strong': clear(palette.accent, isLight ? 26 : 34),
    '--text-on-accent': palette.accentForeground,

    // ── 状态语义色 ──
    '--success': palette.success,
    '--success-text': successText,
    '--success-soft': clear(palette.success, isLight ? 12 : 14),
    '--warning': palette.warning,
    '--warning-text': warningText,
    '--warning-soft': clear(palette.warning, isLight ? 14 : 14),
    '--danger': palette.danger,
    '--danger-hover': dangerHover,
    '--danger-text': dangerText,
    '--danger-soft': clear(palette.danger, isLight ? 12 : 16),
    '--danger-soft-hover': clear(palette.danger, isLight ? 20 : 26),
    '--danger-focus': clear(palette.danger, isLight ? 36 : 40),
    '--danger-border': clear(palette.danger, 45),
    '--destructive': dangerText,
    '--info': accentText,
    '--diff-addition': successText,
    '--diff-deletion': dangerText,

    // ── Warren / 插件语义表面兼容映射 ──
    '--background': palette.canvas,
    '--surface': palette.canvas,
    '--surface-under': palette.frame,
    '--surface-elevated': surface,
    '--surface-drawer': palette.sidebar,
    '--surface-recessed': isLight ? mix(palette.canvas, palette.frame, 50) : palette.frame,
    '--card': surface,
    '--card-foreground': palette.text,
    '--popover': sheetBg,
    '--popover-foreground': palette.text,
    '--menu': sheetBg,
    '--menu-foreground': palette.text,
    '--tooltip': tooltipBg,
    '--tooltip-foreground': tooltipFg,
    '--input': borderStrong,
    '--input-fill': surface,
    '--chrome-field-fill': surface,
    '--surface-hover': hoverWash,
    '--surface-active': activeWash,
    '--surface-selected': selectedBg,
    '--surface-selected-border': selectedBorder,
    '--surface-selected-solid': selectedBg,
    '--surface-tab-selected': tabSelectedBg,
    '--surface-highlight': highlightBg,
    '--surface-fog': fogWash,
    '--overlay': isLight ? 'rgba(20, 20, 20, 0.14)' : 'rgba(0, 0, 0, 0.36)',

    // ── Sidebar 兼容映射 ──
    '--sidebar': palette.sidebar,
    '--sidebar-foreground': palette.text,
    '--sidebar-primary': primaryBg,
    '--sidebar-primary-foreground': primaryFg,
    '--sidebar-accent': hoverWash,
    '--sidebar-accent-foreground': palette.text,
    '--sidebar-border': borderSubtle,
    '--sidebar-ring': palette.textMuted,

    // ── Chart 颜色映射 ──
    '--chart-1': palette.accent,
    '--chart-2': palette.success,
    '--chart-3': palette.warning,
    '--chart-4': isLight ? '#7c3aed' : '#a78bfa',
    '--chart-5': palette.danger,
  };
}
