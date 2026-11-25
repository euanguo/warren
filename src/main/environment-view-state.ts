/**
 * 切换选中环境时，窗口里的页面视图该怎么处理。
 *
 * 这是纯函数，因为它表达的是一条**不变量**，不变量就该能被单测：
 * 任意时刻窗口里最多只有一个页面视图，且它一定属于 selected 的环境。
 *
 * 违反过两次真实 bug，都出在「目标环境没有视图」这条分支上：
 * 界面写着「未选择环境」，屏幕上还留着上一个环境的页面；更糟的是
 * selected 为空之后 setViewport 直接 return，原生视图永久钉在旧坐标。
 */
export interface ViewTransition {
  /** 要把上一个环境的视图从窗口摘掉吗 */
  detachCurrent: boolean;
  /** 要把目标环境的视图挂进窗口吗（false = 目标没跑，窗口应该空着） */
  attachTarget: boolean;
}

export function nextViewTransition(input: {
  currentSelected?: string;
  targetId: string;
  /** 目标环境当前有没有可挂载的视图（= 有没有运行中的 TabManager） */
  targetHasView: boolean;
}): ViewTransition {
  const switching = Boolean(input.currentSelected) && input.currentSelected !== input.targetId;
  return {
    detachCurrent: switching,
    attachTarget: input.targetHasView,
  };
}
