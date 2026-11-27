/**
 * Popover 原生透明子窗口四边阴影缓冲（px）。
 * 关闭系统原生 `hasShadow` / `vibrancy`（避免浅色模式下出现 macOS 暗色窗框黑边与浓重黑影）后，
 * 由子窗口向四周外扩该缓冲区承载 CSS 1px 发丝描边与柔和主题阴影，同时保持卡片相对锚点的视觉位置 0 偏移。
 */
export const POPOVER_WINDOW_PAD = 16;

/** 地址栏联想浮层的动态高度上下限（低于上限紧贴内容零空块，高于上限启用滚动）。 */
export const ADDRESS_SUGGEST_MIN_HEIGHT = 60;
export const ADDRESS_SUGGEST_MAX_HEIGHT = 320;

/**
 * 首次弹出地址栏联想时的近似高度估算，减少弹出后首次 ResizeObserver 校准的跳变。
 * 行高 28px + 2px 间距 + 顶标签 26px + 外层 10px 内边距与描边。
 */
export function estimateAddressSuggestHeight(entryCount: number): number {
  if (entryCount <= 0) return ADDRESS_SUGGEST_MIN_HEIGHT;
  const raw = 10 + 26 + entryCount * 28 + entryCount * 2;
  return clampPopoverHeight(raw, ADDRESS_SUGGEST_MIN_HEIGHT, ADDRESS_SUGGEST_MAX_HEIGHT);
}

/** 将实测内容高度夹紧在 [minHeight, maxHeight]。 */
export function clampPopoverHeight(
  contentHeight: number,
  minHeight = ADDRESS_SUGGEST_MIN_HEIGHT,
  maxHeight = ADDRESS_SUGGEST_MAX_HEIGHT,
): number {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return minHeight;
  return Math.min(maxHeight, Math.max(minHeight, Math.ceil(contentHeight)));
}
