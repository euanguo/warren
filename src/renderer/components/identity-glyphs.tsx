import type { CSSProperties } from 'react';
import { Icon, isIconName, type IconName } from '@/components/icons';
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
          className={cn('absolute -right-0.5 -bottom-0.5', dotSizeClass, ringClassName ?? 'ring-surface-elevated')}
        />
      )}
    </span>
  );
}

/**
 * 统一的插件品牌图标/底牌，共用同一套色相计算与 fallback 图标规则。
 */
export function PluginBrandGlyph({
  pluginId,
  icon,
  variant = 'icon',
  fallback = 'Plug',
  className,
  iconClassName,
}: {
  pluginId: string;
  icon?: string;
  variant?: 'icon' | 'chip';
  fallback?: IconName;
  className?: string;
  iconClassName?: string;
}) {
  const brand = getPluginBrand(pluginId, icon);
  const name: IconName = isIconName(brand.icon) ? brand.icon : fallback;
  if (variant === 'chip') {
    return (
      <span
        aria-hidden
        style={{ '--brand-hue': brand.hue } as CSSProperties}
        className={cn(
          'plugin-brand-chip flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)]',
          className,
        )}
      >
        <Icon name={name} className={cn('size-4', iconClassName)} />
      </span>
    );
  }
  return (
    <Icon
      name={name}
      style={{ '--brand-hue': brand.hue } as CSSProperties}
      className={cn('plugin-brand-icon size-3.5 shrink-0', className)}
    />
  );
}
