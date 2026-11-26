/**
 * 隔离环境身份色标（12 组预调谐高区分度色相）。
 *
 * 目的：把「这是哪个隔离环境」与「它是否在运行」视觉解耦，
 * 用克制的微彩首字母芯片让多环境列表与顶栏胶囊一眼可区分。
 */
export const ENV_IDENTITY_HUES = [215, 162, 34, 282, 12, 332, 192, 52, 248, 138, 22, 305] as const;

export interface EnvIdentity {
  hue: number;
  initial: string;
}

/** 稳定哈希（FNV-1a + Murmur3 雪崩终结），消除模 2^n 低位撞桶，保证常见环境名分布均匀。 */
export function envIdentityHue(envId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < envId.length; i += 1) {
    hash ^= envId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  const index = (hash >>> 0) % ENV_IDENTITY_HUES.length;
  return ENV_IDENTITY_HUES[index] ?? ENV_IDENTITY_HUES[0];
}

export function envIdentityInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const first = Array.from(trimmed)[0] ?? '?';
  return /^[a-z]$/i.test(first) ? first.toUpperCase() : first;
}

export function getEnvIdentity(envId: string, name: string): EnvIdentity {
  return {
    hue: envIdentityHue(envId),
    initial: envIdentityInitial(name),
  };
}
