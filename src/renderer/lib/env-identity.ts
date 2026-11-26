/**
 * 隔离环境身份色标（基于 theme-tokens.css 预埋的 8 组 `--glyph-hue-1..8`）。
 *
 * 目的：把「这是哪个隔离环境」与「它是否在运行」视觉解耦，
 * 用克制的微彩首字母芯片让多环境列表与顶栏胶囊一眼可区分。
 */
export const ENV_IDENTITY_HUES = [210, 160, 35, 280, 10, 320, 190, 55] as const;

export interface EnvIdentity {
  hue: number;
  initial: string;
}

/** 稳定哈希（FNV-1a 32-bit），保证同一环境 ID 跨会话始终映射到同一身份色。 */
export function envIdentityHue(envId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < envId.length; i += 1) {
    hash ^= envId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const index = Math.abs(hash) % ENV_IDENTITY_HUES.length;
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
