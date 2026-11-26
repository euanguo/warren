import type { PopoverPlacement, ViewportRect } from '../../shared/types.ts';

export interface PopoverLayoutInput {
  /** 触发锚点在主窗口内容区坐标系下的矩形（CSS 像素）。 */
  anchorRect: ViewportRect;
  /** 主窗口在桌面上的矩形（contentBounds）。 */
  windowBounds: ViewportRect;
  /** 期望的浮卡宽高。 */
  preferredSize: { width: number; height: number };
  /** 弹出方位，默认 `bottom-start`。 */
  placement?: PopoverPlacement;
  /** 允许探出主窗口边界（默认 true，由工作区夹紧）；false 时夹紧在主窗内部。 */
  beyondWindow?: boolean;
  /** 锚点与浮卡之间的间距，默认 6px。 */
  gap?: number;
  /** 目标显示器的可用工作区（不含 Dock / 菜单栏）。 */
  workArea: ViewportRect;
  /** 安全边距，避免贴死屏幕边缘，默认 8px。 */
  margin?: number;
}

/**
 * 纯逻辑计算 Popover 子窗口在桌面坐标系下的位置与宽高。
 *
 * 复刻 Ardia Wave 3B `ac_mac_popover_policy` 的核心原则：
 * 1. 先按 `placement` 摆到锚点下方或上方；
 * 2. 若下方空间不足且上方更宽裕，自动翻转（bottom ↔ top）；
 * 3. 按 `beyondWindow` 决定夹紧边界（显示器 `workArea` 或 `windowBounds`）。
 */
export function computePopoverBounds(input: PopoverLayoutInput): ViewportRect {
  const gap = input.gap ?? 6;
  const margin = input.margin ?? 8;
  const placement = input.placement ?? 'bottom-start';
  const beyondWindow = input.beyondWindow ?? true;

  const limit = beyondWindow ? input.workArea : input.windowBounds;
  const minX = limit.x + margin;
  const minY = limit.y + margin;
  const maxWidth = Math.max(120, limit.width - margin * 2);
  const maxHeight = Math.max(80, limit.height - margin * 2);

  const width = Math.min(Math.max(120, Math.round(input.preferredSize.width)), maxWidth);
  const height = Math.min(Math.max(40, Math.round(input.preferredSize.height)), maxHeight);

  const anchorLeft = input.windowBounds.x + input.anchorRect.x;
  const anchorTop = input.windowBounds.y + input.anchorRect.y;
  const anchorRight = anchorLeft + input.anchorRect.width;
  const anchorBottom = anchorTop + input.anchorRect.height;

  const alignEnd = placement.endsWith('-end');
  let x = alignEnd ? anchorRight - width : anchorLeft;
  x = clamp(x, minX, Math.max(minX, limit.x + limit.width - margin - width));

  const prefersTop = placement.startsWith('top');
  const belowY = anchorBottom + gap;
  const aboveY = anchorTop - gap - height;
  const fitsBelow = belowY + height <= limit.y + limit.height - margin;
  const fitsAbove = aboveY >= minY;

  let y: number;
  if (prefersTop) {
    y = fitsAbove || !fitsBelow ? aboveY : belowY;
  } else {
    y = fitsBelow || !fitsAbove ? belowY : aboveY;
  }
  y = clamp(y, minY, Math.max(minY, limit.y + limit.height - margin - height));

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
