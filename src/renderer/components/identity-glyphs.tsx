import type { CSSProperties } from 'react';
import { KubaiIcon } from 'kubai-icons-react';
import { type IconName } from '@/components/icons';
import { resolvePluginKubaiIconData } from '@/components/plugin-kubai-icons';
import { StatusDot } from '@/components/ui/status-dot';
import { getEnvIdentity } from '@/lib/env-identity';
import { statusTone } from '@/lib/labels';
import { getPluginBrand } from '@/lib/plugin-brand';
import { cn } from '@/lib/utils';
import type { EnvironmentStatus } from '@shared/types';

type EnvAvatarSize = 'xs' | 'sm' | 'md';

const ENV_AVATAR_SIZE_CLASS: Record<EnvAvatarSize, string> = {
  xs: 'size-[18px] rounded-[5px] text-[length:var(--font-size-micro)]',
  sm: 'size-5 rounded-[var(--radius-sm)] text-[length:var(--font-size-micro)]',
  md: 'size-7 rounded-[var(--radius-md)] text-xs',
};

/**
 * 统一的环境头像微章（按环境 id 稳定着色，可选角标状态点）。
 */
export function EnvIdentityAvatar({
  envId,
  name,
  status,
  hasError = false,
  size = 'sm',
  ringClassName,
  className,
}: {
  envId: string;
  name: string;
  status?: EnvironmentStatus;
  hasError?: boolean;
  size?: EnvAvatarSize;
  ringClassName?: string;
  className?: string;
}) {
  const identity = getEnvIdentity(envId, name);
  const dotSizeClass = size === 'md' ? 'size-2 ring-[1.5px]' : 'size-1.5 ring-1';
  return (
    <span
      aria-hidden
      data-slot="env-identity-chip"
      style={{ '--env-hue': identity.hue } as CSSProperties}
      className={cn(
        'env-identity-chip relative flex shrink-0 items-center justify-center font-semibold select-none',
        ENV_AVATAR_SIZE_CLASS[size],
        className,
      )}
    >
      {identity.initial}
      {status !== undefined && (
        <StatusDot
          tone={hasError ? 'error' : statusTone(status)}
          className={cn(
            'absolute -right-0.5 -bottom-0.5',
            dotSizeClass,
            ringClassName ?? 'ring-[var(--avatar-outline,var(--bg-sidebar))]',
          )}
        />
      )}
    </span>
  );
}

/**
 * 统一的插件品牌图标/大徽标（Kubai Icons 方案 1：小入口 Duotone + 大卡片 Layered）：
 * - `variant="icon"`（14–18px 地址栏/顶栏/Tab/命令栏/设置侧栏）：Kubai Duotone 双色实心 + 父级悬停微动效；
 * - `variant="chip"`（24–34px 插件卡片/插件页顶栏）：Kubai Layered 分层微立体 + 柔和渐变 + 父级悬停微动效。
 */
export function PluginBrandGlyph({
  pluginId,
  icon,
  variant = 'icon',
  fallback = 'Plug',
  size,
  className,
  iconClassName,
}: {
  pluginId: string;
  icon?: string;
  variant?: 'icon' | 'chip';
  fallback?: IconName;
  /** 显式像素尺寸（默认 icon=16px，chip=32px）。 */
  size?: number;
  className?: string;
  iconClassName?: string;
}) {
  const brand = getPluginBrand(pluginId, icon);
  const resolvedName = brand.icon || fallback;
  const brandStyle = { '--brand-hue': brand.hue } as CSSProperties;

  if (variant === 'chip') {
    const layeredData = resolvePluginKubaiIconData(resolvedName, 'layered');
    const px = size ?? 32;
    return (
      <span
        aria-hidden
        data-slot="plugin-brand-chip"
        data-plugin-icon={resolvedName}
        data-kubai-style="layered"
        style={brandStyle}
        className={cn(
          'plugin-brand-icon relative inline-flex shrink-0 items-center justify-center overflow-visible select-none',
          size ? undefined : 'size-8',
          className,
        )}
      >
        <KubaiIcon icon={layeredData} size={px} trigger="parent" className={cn('shrink-0', iconClassName)} />
      </span>
    );
  }

  const duotoneData = resolvePluginKubaiIconData(resolvedName, 'duotone');
  const px = size ?? 16;
  return (
    <KubaiIcon
      icon={duotoneData}
      aria-hidden
      data-slot="plugin-brand-icon"
      data-plugin-icon={resolvedName}
      data-kubai-style="duotone"
      size={px}
      trigger="parent"
      style={brandStyle}
      className={cn('plugin-brand-icon shrink-0', className, iconClassName)}
    />
  );
}
