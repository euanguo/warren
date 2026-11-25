import * as React from 'react';

const MOBILE_BREAKPOINT = 768;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/**
 * `matchMedia` 是标准意义上的外部数据源，`useSyncExternalStore` 才是它的正解：
 * effect + setState 那版首帧必然先返回 false 再纠正一次（多一轮渲染）。
 */
function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, () => window.innerWidth < MOBILE_BREAKPOINT);
}
