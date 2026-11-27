import type { ViewportPresetId, ViewportRect } from './types.ts';

export interface ViewportPresetSpec {
  id: Exclude<ViewportPresetId, 'auto'>;
  label: string;
  detail: string;
  width: number;
  height: number;
  mobile: boolean;
  deviceScaleFactor: number;
  icon: 'Desktop' | 'Laptop' | 'Mobile';
}

export const VIEWPORT_PRESET_SPECS: Record<Exclude<ViewportPresetId, 'auto'>, ViewportPresetSpec> = {
  'desktop-1440': {
    id: 'desktop-1440',
    label: '桌面标准',
    detail: '1440 × 900 · DPR 1',
    width: 1440,
    height: 900,
    mobile: false,
    deviceScaleFactor: 1,
    icon: 'Desktop',
  },
  'laptop-1280': {
    id: 'laptop-1280',
    label: '笔记本视口',
    detail: '1280 × 800 · DPR 1',
    width: 1280,
    height: 800,
    mobile: false,
    deviceScaleFactor: 1,
    icon: 'Laptop',
  },
  'mobile-390': {
    id: 'mobile-390',
    label: '移动端设备',
    detail: '390 × 844 · Touch / DPR 2',
    width: 390,
    height: 844,
    mobile: true,
    deviceScaleFactor: 2,
    icon: 'Mobile',
  },
};

export const VIEWPORT_PRESET_LIST: ViewportPresetSpec[] = [
  VIEWPORT_PRESET_SPECS['desktop-1440'],
  VIEWPORT_PRESET_SPECS['laptop-1280'],
  VIEWPORT_PRESET_SPECS['mobile-390'],
];

export interface SimulatedPageLayout {
  preset: ViewportPresetId;
  emulated: boolean;
  bounds: ViewportRect;
  logicalWidth: number;
  logicalHeight: number;
  scale: number;
}

/**
 * 计算页面区域的真实原生矩形与等比缩放系数。
 * 非 `auto` 预设时在容器画布内预留居中舞台边距（顶部额外给尺寸标签留空间），
 * 并按剩余空间等比缩小渲染视图尺寸，同时保持 CDP 逻辑宽高不变。
 */
export function computeSimulatedPageBounds(container: ViewportRect, preset: ViewportPresetId): SimulatedPageLayout {
  if (preset === 'auto') {
    return {
      preset: 'auto',
      emulated: false,
      bounds: container,
      logicalWidth: container.width,
      logicalHeight: container.height,
      scale: 1,
    };
  }

  const spec = VIEWPORT_PRESET_SPECS[preset];
  const padX = Math.min(28, Math.max(8, Math.floor(container.width * 0.04)));
  const padBottom = Math.min(44, Math.max(16, Math.floor(container.height * 0.06)));
  const rawPadTop = Math.min(48, Math.max(24, Math.floor(container.height * 0.08)));
  const padTop = container.height < 140 ? Math.min(rawPadTop, Math.floor(container.height * 0.16)) : rawPadTop;

  const availW = Math.max(40, container.width - padX * 2);
  const availH = Math.max(40, container.height - padTop - padBottom);

  const scale = Math.max(0.1, Math.min(1, availW / spec.width, availH / spec.height));
  const width = Math.max(1, Math.min(availW, Math.round(spec.width * scale)));
  const height = Math.max(1, Math.min(availH, Math.round(spec.height * scale)));

  const x = container.x + Math.round((container.width - width) / 2);
  const centerY = container.y + Math.round((container.height - height) / 2);
  const y =
    centerY >= container.y + padTop ? centerY : container.y + padTop + Math.max(0, Math.round((availH - height) / 2));

  return {
    preset,
    emulated: true,
    bounds: { x, y, width, height },
    logicalWidth: spec.width,
    logicalHeight: spec.height,
    scale,
  };
}
