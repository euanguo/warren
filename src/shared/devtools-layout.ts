import type { DevToolsDockMode, ViewportRect } from './types.ts';

export const DEVTOOLS_DOCK_GAP = 6;
export const DEVTOOLS_SPLITTER_OVERLAP = 2;
export const DEVTOOLS_MAX_RATIO = 0.7;

export const DEVTOOLS_RIGHT_SIZE = {
  default: 420,
  min: 240,
  maxConfig: 2400,
  minPage: 200,
} as const;

export const DEVTOOLS_BOTTOM_SIZE = {
  default: 320,
  min: 180,
  maxConfig: 2000,
  minPage: 160,
} as const;

export type DockedDevToolsMode = Exclude<DevToolsDockMode, 'detach'>;

export interface DevToolsSplitBounds {
  page: ViewportRect;
  devtools?: ViewportRect;
  gap?: ViewportRect;
  splitter?: ViewportRect;
  lineOffset?: number;
}

export function isDockedDevToolsMode(mode: DevToolsDockMode): mode is DockedDevToolsMode {
  return mode === 'right' || mode === 'bottom';
}

export function defaultDevToolsSize(mode: DockedDevToolsMode): number {
  return mode === 'right' ? DEVTOOLS_RIGHT_SIZE.default : DEVTOOLS_BOTTOM_SIZE.default;
}

export function minDevToolsSize(mode: DockedDevToolsMode): number {
  return mode === 'right' ? DEVTOOLS_RIGHT_SIZE.min : DEVTOOLS_BOTTOM_SIZE.min;
}

export function clampConfiguredDevToolsSize(mode: DockedDevToolsMode, size: number): number {
  const spec = mode === 'right' ? DEVTOOLS_RIGHT_SIZE : DEVTOOLS_BOTTOM_SIZE;
  if (!Number.isFinite(size)) return spec.default;
  return Math.max(spec.min, Math.min(spec.maxConfig, Math.round(size)));
}

export function maxDevToolsSize(mode: DockedDevToolsMode, viewport: ViewportRect): number {
  const spec = mode === 'right' ? DEVTOOLS_RIGHT_SIZE : DEVTOOLS_BOTTOM_SIZE;
  const span = mode === 'right' ? viewport.width : viewport.height;
  if (!Number.isFinite(span) || span <= 0) return spec.default;
  const maxByRatio = Math.floor(span * DEVTOOLS_MAX_RATIO);
  const maxByPage = span - spec.minPage - DEVTOOLS_DOCK_GAP;
  return Math.max(spec.min, Math.min(maxByRatio, maxByPage));
}

export function clampDevToolsSize(mode: DockedDevToolsMode, size: number, viewport: ViewportRect): number {
  const spec = mode === 'right' ? DEVTOOLS_RIGHT_SIZE : DEVTOOLS_BOTTOM_SIZE;
  if (!Number.isFinite(size)) return spec.default;
  const max = maxDevToolsSize(mode, viewport);
  return Math.max(spec.min, Math.min(max, Math.round(size)));
}

/**
 * 计算停靠式 DevTools 分栏下的 `'page'` / `'devtools'` / `'splitter'` 矩形及缝隙坐标。
 * 主进程 `DevToolsHost` 与渲染层 `EnvironmentStage` 共享同一份纯几何计算，确保零漂移。
 */
export function computeDevToolsSplitBounds(input: {
  viewport: ViewportRect;
  mode: DevToolsDockMode;
  size: number;
  docked: boolean;
  dragging?: boolean;
}): DevToolsSplitBounds {
  const { viewport, mode, size, docked, dragging = false } = input;
  if (!docked || !isDockedDevToolsMode(mode)) {
    return { page: viewport };
  }
  const { x, y, width, height } = viewport;
  if (mode === 'right') {
    const splitW = clampDevToolsSize('right', size, viewport);
    const pageW = Math.max(DEVTOOLS_RIGHT_SIZE.minPage, width - splitW - DEVTOOLS_DOCK_GAP);
    const dtX = x + pageW + DEVTOOLS_DOCK_GAP;
    const gap: ViewportRect = { x: x + pageW, y, width: DEVTOOLS_DOCK_GAP, height };
    const hitLeft = Math.max(x, gap.x - DEVTOOLS_SPLITTER_OVERLAP);
    const hitRight = Math.min(x + width, dtX + DEVTOOLS_SPLITTER_OVERLAP);
    const idleSplitter: ViewportRect = {
      x: hitLeft,
      y,
      width: Math.max(DEVTOOLS_DOCK_GAP, hitRight - hitLeft),
      height,
    };
    return {
      page: { x, y, width: pageW, height },
      devtools: { x: dtX, y, width: Math.max(120, x + width - dtX), height },
      gap,
      splitter: dragging ? { ...viewport } : idleSplitter,
      lineOffset: pageW + DEVTOOLS_DOCK_GAP / 2,
    };
  }
  const splitH = clampDevToolsSize('bottom', size, viewport);
  const pageH = Math.max(DEVTOOLS_BOTTOM_SIZE.minPage, height - splitH - DEVTOOLS_DOCK_GAP);
  const dtY = y + pageH + DEVTOOLS_DOCK_GAP;
  const gap: ViewportRect = { x, y: y + pageH, width, height: DEVTOOLS_DOCK_GAP };
  const hitTop = Math.max(y, gap.y - DEVTOOLS_SPLITTER_OVERLAP);
  const hitBottom = Math.min(y + height, dtY + DEVTOOLS_SPLITTER_OVERLAP);
  const idleSplitter: ViewportRect = {
    x,
    y: hitTop,
    width,
    height: Math.max(DEVTOOLS_DOCK_GAP, hitBottom - hitTop),
  };
  return {
    page: { x, y, width, height: pageH },
    devtools: { x, y: dtY, width, height: Math.max(120, y + height - dtY) },
    gap,
    splitter: dragging ? { ...viewport } : idleSplitter,
    lineOffset: pageH + DEVTOOLS_DOCK_GAP / 2,
  };
}
