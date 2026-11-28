/**
 * 原生 tooltip 请求的校验与裁剪。
 *
 * tooltip 走的是主窗 → 主进程 → overlay 渲染层的链路，同样过信任边界：
 * 文本一律裁剪到上限，坐标必须是有限数（NaN 会把浮层钉在视口外）。
 */
import type { OverlayTooltipRequest, OverlayTooltipSide } from './types/ui.ts';

export const TOOLTIP_LIMITS = { label: 120, description: 240, shortcut: 16 } as const;

const SIDES: readonly OverlayTooltipSide[] = ['top', 'right', 'bottom', 'left'];

function bad(message: string): never {
  throw Object.assign(new Error(message), { code: 'OVERLAY_TOOLTIP_INVALID' });
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') bad(`${name} 必须是字符串`);
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) bad(`${name} 必须是有限数`);
  return value;
}

export function normalizeTooltipRequest(input: unknown): OverlayTooltipRequest {
  if (!input || typeof input !== 'object') bad('请求必须是对象');
  const raw = input as Record<string, unknown>;
  const label = optionalText(raw.label, 'label', TOOLTIP_LIMITS.label);
  if (!label) bad('label 不能为空');

  const anchor = raw.anchor;
  if (!anchor || typeof anchor !== 'object') bad('anchor 必须是对象');
  const rect = anchor as Record<string, unknown>;

  const side = raw.side === undefined ? 'bottom' : raw.side;
  if (!SIDES.includes(side as OverlayTooltipSide)) bad('side 不合法');

  return {
    anchor: {
      x: finite(rect.x, 'anchor.x'),
      y: finite(rect.y, 'anchor.y'),
      width: Math.max(0, finite(rect.width, 'anchor.width')),
      height: Math.max(0, finite(rect.height, 'anchor.height')),
    },
    side: side as OverlayTooltipSide,
    label,
    description: optionalText(raw.description, 'description', TOOLTIP_LIMITS.description),
    shortcut: optionalText(raw.shortcut, 'shortcut', TOOLTIP_LIMITS.shortcut),
  };
}
