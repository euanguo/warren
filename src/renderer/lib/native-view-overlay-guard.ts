/**
 * 原生视图让位。
 *
 * 页面是 `WebContentsView`——操作系统层级的子视图，**永远画在渲染层 DOM 之上**。
 * 所以任何 DOM 浮层（右键菜单、下拉、对话框）只要压到页面区域，就会被页面盖住，
 * 连点都点不到。这里盯着「有没有打开的浮层」+「它压没压到页面区域」，
 * 压到了就让主进程把原生视图藏起来，关掉再放回去。
 *
 * 两个刻意的取舍：
 * - **只认菜单 / 对话框 / 列表框，不认 tooltip**。tooltip 跟着鼠标走，为它藏页面
 *   会一直闪；而且 tooltip 一般压在侧栏里，不至于挡住页面。
 * - **只在真的重叠时才藏**。菜单完全落在侧栏里的时候藏掉整页，比被盖住更难受。
 *
 * 让开之前先截一帧垫在占位区：原生视图一藏，露出来的就是应用底色，整块页面会
 * 突然变黑。先铺上页面自己的画面，用户看到的是「页面停住了」而不是「页面没了」。
 */

/** 打开的浮层。base-ui 用 `data-open` / `data-closed` 切换，关掉的那些不算。 */
const OPEN_OVERLAY_SELECTOR = [
  '[data-open][role="menu"]',
  '[data-open][role="dialog"]',
  '[data-open][role="alertdialog"]',
  '[data-open][role="listbox"]',
  '[data-open][role="combobox"]',
].join(',');

/** 页面占位区。原生视图就贴在这个矩形上（见 App.tsx 的 stageRef）。 */
const STAGE_SELECTOR = '[data-slot="stage-placeholder"]';

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * 有没有**任何一个**打开的浮层压到页面区域。
 *
 * 只看第一个命中的浮层是不够的：侧栏里开着一个菜单、页面区域又弹出一个，
 * 先命中的那个不重叠时，后一个就会被页面盖住而且谁也点不到。
 */
function anyOverlayOverlaps(stage: HTMLElement): boolean {
  const rect = stage.getBoundingClientRect();
  return [...document.querySelectorAll(OPEN_OVERLAY_SELECTOR)].some((overlay) =>
    overlaps(overlay.getBoundingClientRect(), rect),
  );
}

/**
 * 装上观察器，返回卸载函数。用法：`useEffect(() => createNativeViewOverlayGuard(), [])`。
 */
export function createNativeViewOverlayGuard(): () => void {
  let hidden = false;
  /** 上一帧已经看到重叠、还在等定位完成。 */
  let pending = false;
  let frame: number | null = null;
  /** 冻结请求的代号。浮层关掉就作废，免得迟到的截图糊在已经收回的页面上。 */
  let freezeToken = 0;

  const stageNode = () => document.querySelector<HTMLElement>(STAGE_SELECTOR);

  const clearFrozenFrame = (stage: HTMLElement | null) => {
    if (!stage) return;
    stage.style.backgroundImage = '';
    stage.style.backgroundSize = '';
  };

  /**
   * 先铺帧、再让开。顺序不能反：视图先藏的话，铺帧之前那几十毫秒就是黑的。
   */
  const hide = async (stage: HTMLElement) => {
    const token = ++freezeToken;
    // 窗口被别的窗口盖住、不在出帧时，capturePage 会直接报 UnknownVizError。
    // 那种情况退回老行为（只让位、不铺帧）——菜单能用比画面好看重要。
    const shot = await window.envApi.pageSnapshot().catch(() => null);
    // 等截图这一下浮层可能已经关了：不必再藏，也别把过期的一帧糊上去
    if (token !== freezeToken) return;
    if (shot) {
      stage.style.backgroundImage = `url("${shot}")`;
      stage.style.backgroundSize = '100% 100%';
    }
    await window.envApi.setViewVisible(false);
  };

  const sync = () => {
    frame = null;
    const stage = stageNode();
    const next = Boolean(stage && anyOverlayOverlaps(stage));
    if (next === hidden) {
      pending = false;
      return;
    }
    // 浮层插入后还要再定位一帧（Floating UI 改 style，不触发 MutationObserver）。
    // 只重叠一帧不算数：否则定位中间态会把页面藏掉，而之后没有事件再让它恢复。
    if (next && !pending) {
      pending = true;
      schedule();
      return;
    }
    pending = false;
    hidden = next;
    if (next && stage) {
      void hide(stage);
      return;
    }
    freezeToken += 1;
    clearFrozenFrame(stage);
    void window.envApi.setViewVisible(true);
  };

  // 浮层是先插进 DOM、再由 layout effect 定位的，所以等下一帧再量。
  const schedule = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(sync);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-open', 'data-closed'],
  });
  sync();

  return () => {
    observer.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
    freezeToken += 1;
    clearFrozenFrame(stageNode());
    if (hidden) void window.envApi.setViewVisible(true);
  };
}
