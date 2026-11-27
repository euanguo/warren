import type { ViewportRect } from '../../shared/types.ts';

/** 一块物理显示器：`bounds` 含菜单栏和 Dock，`workArea` 是可摆窗口的区域。 */
export interface DisplayFrame {
  bounds: ViewportRect;
  workArea: ViewportRect;
}

function intersects(a: ViewportRect, b: ViewportRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function distanceSquared(px: number, py: number, rect: ViewportRect): number {
  const dx = px < rect.x ? rect.x - px : px > rect.x + rect.width ? px - (rect.x + rect.width) : 0;
  const dy = py < rect.y ? rect.y - py : py > rect.y + rect.height ? py - (rect.y + rect.height) : 0;
  return dx * dx + dy * dy;
}

/**
 * 窗口还落在某一块屏的工作区里就保持原位。
 * 完全离开所有显示器（例如外接屏被物理拔掉后留下的失效坐标）时，
 * 放到离窗口中心最近的那块屏的工作区中央。没有显示器信息时不改。
 */
export function placeWindowOnItsDisplay(bounds: ViewportRect, displays: readonly DisplayFrame[]): ViewportRect {
  if (displays.length === 0) return bounds;
  if (displays.some((display) => intersects(bounds, display.workArea))) return bounds;

  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  let nearest = displays[0];
  let nearestDistance = distanceSquared(cx, cy, nearest.bounds);
  for (const display of displays.slice(1)) {
    const distance = distanceSquared(cx, cy, display.bounds);
    if (distance < nearestDistance) {
      nearest = display;
      nearestDistance = distance;
    }
  }

  const area = nearest.workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: area.x + Math.max(0, Math.round((area.width - width) / 2)),
    y: area.y + Math.max(0, Math.round((area.height - height) / 2)),
    width,
    height,
  };
}

/**
 * 判断该目标视图当前是否应通过 CDP `Emulation.setFocusEmulationEnabled`
 * 维持焦点仿真与后台渲染帧率，而不是调用会抢占前台的原生 `wc.focus()`。
 *
 * 主窗口隐藏（`win.hide()`）、失焦、或目标属于非当前激活的后台环境/Space 时一律走仿真。
 */
export function shouldEmulateRenderFocus(ctx: {
  windowVisible: boolean;
  windowFocused: boolean;
  isSelected: boolean;
  isActiveSpace: boolean;
  /** 目标视图当前挂在永久隐藏宿主窗（BackgroundHostWindow）时，一律走焦点仿真，绝不抢主窗口焦点。 */
  mountedInHiddenHost?: boolean;
}): boolean {
  return (
    Boolean(ctx.mountedInHiddenHost) ||
    !ctx.windowVisible ||
    !ctx.windowFocused ||
    !ctx.isSelected ||
    !ctx.isActiveSpace
  );
}
