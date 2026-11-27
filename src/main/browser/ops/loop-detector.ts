/**
 * 轻型死循环探测器（ActionLoopDetector）：
 * - 对标 browser-use 的运行时防卡死机制，但零额外 LLM 调用成本；
 * - 维护每个会话最近 12 步动作指纹，检测：
 *   1. 连续 3 次对同一目标在同一 URL 执行同类写动作且页面无任何可观测变化；
 *   2. 最近 6 步在 2 个 URL 之间无进展反复横跳（典型重定向死循环）。
 */

export interface LoopProbeEntry {
  action: string;
  targetKey: string;
  urlBefore: string;
  urlAfter: string;
  changed: boolean;
}

const MAX_WINDOW = 12;

export class ActionLoopDetector {
  #windows = new Map<string, LoopProbeEntry[]>();

  record(scopeKey: string, entry: LoopProbeEntry): string | undefined {
    let list = this.#windows.get(scopeKey);
    if (!list) {
      list = [];
      this.#windows.set(scopeKey, list);
    }
    list.push(entry);
    while (list.length > MAX_WINDOW) list.shift();

    // 规则 1：连续 3 次相同动作+目标且均无变化
    if (list.length >= 3) {
      const tail3 = list.slice(-3);
      const sameTarget = tail3.every(
        (e) =>
          !e.changed && e.action === entry.action && e.targetKey === entry.targetKey && e.urlBefore === entry.urlBefore,
      );
      if (sameTarget) {
        return `已连续 3 次对 ${entry.targetKey || '当前页面'} 执行 ${entry.action} 且页面无变化，请勿重复盲试；建议检查遮挡/滚动位置，或用 screenshot --annotate / browser eval 排查`;
      }
    }

    // 规则 2：最近 6 步在 2 个不同 URL 之间交替横跳（A->B, B->A, A->B ...）
    if (list.length >= 6) {
      const tail6 = list.slice(-6);
      const navs = tail6.filter((e) => e.urlBefore && e.urlAfter && e.urlBefore !== e.urlAfter);
      if (navs.length === 6) {
        const distinct = new Set<string>();
        for (const n of navs) {
          distinct.add(n.urlBefore);
          distinct.add(n.urlAfter);
        }
        if (distinct.size === 2) {
          const [u1, u2] = [...distinct];
          return `检测到页面在 ${u1} 与 ${u2} 之间连续往复重定向，可能存在登录态失效或路由守卫拦截；请先用 browser info / network 排查`;
        }
      }
    }

    if (this.#windows.size > 300) {
      const oldest = this.#windows.keys().next().value;
      if (oldest !== undefined) this.#windows.delete(oldest);
    }
    return undefined;
  }

  reset(scopeKey?: string): void {
    if (scopeKey) this.#windows.delete(scopeKey);
    else this.#windows.clear();
  }

  resetByPrefix(prefix: string): void {
    for (const key of [...this.#windows.keys()]) {
      if (key.startsWith(prefix)) this.#windows.delete(key);
    }
  }
}

export const actionLoopDetector = new ActionLoopDetector();
