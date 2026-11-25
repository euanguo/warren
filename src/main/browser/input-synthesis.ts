/**
 * 鼠标路径合成。纯函数，可单测。
 *
 * 为什么要它：真人的鼠标是**一串中间坐标**，Warren 以前是一步从 A 跳到 B。
 * 差别在真实站点上看得见 —— `mousemove` 的节流 / 去抖、canvas 绘制、拖拽路径、
 * 地图与 3D 控件、`pointermove` 上做的命中检测，都吃「有没有中间点」。
 *
 * **只合成移动，不碰按下的那一下**：按下/抬起仍然由 `actions.ts` 直接发，
 * 免得把 actionability 那套（等元素可用、被遮挡判定）绕过去。
 */

export interface Point {
  x: number;
  y: number;
}

/** 路径太长会拖慢每次点击；太短又和一步跳过去没区别。 */
const MIN_STEPS = 3;
const MAX_STEPS = 16;
/** 每约 40 CSS 像素加一个中间点。 */
const PX_PER_STEP = 40;
/** 两个中间点之间的间隔。整体开销 = steps × 这个值（最坏 ~130ms）。 */
export const STEP_DELAY_MS = 8;

/**
 * 从 `from` 到 `to` 的中间点（**含终点，不含起点**）。
 *
 * 走一条轻微外凸的二次贝塞尔，而不是直线 —— 真人的手不是尺子。控制点偏移量随距离缩放，
 * 所以近处几乎就是直线，远处才看得出弧。
 *
 * 距离为 0（原地点击）时返回 `[to]`，退化成原来的行为。
 */
export function mousePath(from: Point, to: Point, steps?: number): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [to];

  const n = steps ?? Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.round(dist / PX_PER_STEP)));
  // 垂直方向上的轻微外凸：幅度取距离的 6%，上限 24px（别让点在附近元素上飘过去）
  const bow = Math.min(24, dist * 0.06) * (dx + dy >= 0 ? 1 : -1);
  const len = dist || 1;
  const cx = (from.x + to.x) / 2 + (-dy / len) * bow;
  const cy = (from.y + to.y) / 2 + (dx / len) * bow;

  const out: Point[] = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: Math.round(u * u * from.x + 2 * u * t * cx + t * t * to.x),
      y: Math.round(u * u * from.y + 2 * u * t * cy + t * t * to.y),
    });
  }
  // 终点必须精确落在目标上：贝塞尔在 t=1 处已经是 to，但上面取过整，这里兜一道
  out[out.length - 1] = { x: to.x, y: to.y };
  return out;
}

/**
 * 路径合成开着没。默认开；`WARREN_INPUT_PATH=0` 关掉（点击会快 ~100ms，
 * 但 `mousemove` 相关的页面行为就不真实了）。和 `WARREN_TIMEOUT_MS` 一样走环境变量。
 */
export function inputPathEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WARREN_INPUT_PATH !== '0';
}
