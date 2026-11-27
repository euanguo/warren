import type { TabRef, TabState } from '../../shared/types';

/**
 * 标签集合的纯领域逻辑：顺序、激活指针、关掉之后该选谁。
 *
 * 这里没有 Electron、没有 view、没有 session —— Electron 的部分在 `main/tabs.ts`。
 * 拆开的目的只有一个：「关掉当前标签后选哪个」这类规则必须能单测。
 *
 * 规则对齐 Chrome：
 * - 新标签按 `activate` 决定抢不抢激活；第一个标签无条件激活（否则环境启动了却没有页面在前台）
 * - 关掉当前标签 → 选**右边邻居**，没有就选左边
 * - 关掉非当前标签 → 激活不变
 * - 关掉最后一个 → `empty`，调用方负责停掉整个环境
 */
export class TabList {
  #tabs: TabState[] = [];
  #activeId?: string;

  get list(): readonly TabState[] {
    return this.#tabs;
  }

  get activeId(): string | undefined {
    return this.#activeId;
  }

  get size(): number {
    return this.#tabs.length;
  }

  get(id: string): TabState | undefined {
    return this.#tabs.find((tab) => tab.id === id);
  }

  indexOf(id: string): number {
    return this.#tabs.findIndex((tab) => tab.id === id);
  }

  add(tab: TabState, options: { activate: boolean }): void {
    this.#tabs.push(tab);
    if (options.activate || !this.#activeId) this.#activeId = tab.id;
  }

  remove(id: string): { nextActiveId?: string; empty: boolean } {
    const index = this.indexOf(id);
    if (index < 0) return { nextActiveId: this.#activeId, empty: this.#tabs.length === 0 };

    this.#tabs.splice(index, 1);

    if (this.#tabs.length === 0) {
      this.#activeId = undefined;
      return { empty: true };
    }
    if (this.#activeId !== id) return { nextActiveId: this.#activeId, empty: false };

    const next = this.#tabs[index] ?? this.#tabs[index - 1];
    this.#activeId = next.id;
    return { nextActiveId: this.#activeId, empty: false };
  }

  select(id: string): boolean {
    if (!this.get(id)) return false;
    this.#activeId = id;
    return true;
  }

  /**
   * 拖拽排序：把 from 位置的标签挪到 to 位置。越界返回 false（不改动）。
   *
   * **只动顺序**：激活指针和「关掉之后选谁」都不受影响，所以调用方不需要重新挂视图。
   */
  reorder(from: number, to: number): boolean {
    if (from < 0 || from >= this.#tabs.length || to < 0 || to >= this.#tabs.length) return false;
    if (from === to) return true;
    const [moved] = this.#tabs.splice(from, 1);
    this.#tabs.splice(to, 0, moved);
    return true;
  }

  update(id: string, patch: Partial<Omit<TabState, 'id'>>): boolean {
    const index = this.indexOf(id);
    if (index < 0) return false;
    this.#tabs[index] = { ...this.#tabs[index], ...patch };
    return true;
  }

  /** 把 UI / CLI 给的引用（1-based 序号、稳定短引用 `t1` 或 tabId）解析成 tabId。解析不到返回 undefined，由调用方报错。 */
  resolve(ref: TabRef): string | undefined {
    if (typeof ref === 'number') {
      if (!Number.isInteger(ref) || ref < 1) return undefined;
      return this.#tabs[ref - 1]?.id;
    }
    const trimmed = ref.trim();
    if (/^\d+$/.test(trimmed)) return this.#tabs[Number(trimmed) - 1]?.id;
    if (/^t\d+$/i.test(trimmed)) {
      const lower = trimmed.toLowerCase();
      return this.#tabs.find((tab) => tab.shortRef?.toLowerCase() === lower)?.id;
    }
    return this.get(trimmed) ? trimmed : undefined;
  }
}

/**
 * 「关闭其他 / 关闭右侧」要关掉哪些标签（右键菜单用）。
 *
 * 返回的顺序是**从右往左**：调用方逐个 remove 时下标不会失效，且
 * `TabList.remove` 的「关掉当前 → 选右边邻居」规则能一路算对。
 */
export function closeSet(tabs: readonly TabState[], refId: string, mode: 'others' | 'right'): string[] {
  const index = tabs.findIndex((tab) => tab.id === refId);
  if (index < 0) return [];
  const targets = mode === 'others' ? tabs.filter((tab) => tab.id !== refId) : tabs.slice(index + 1);
  return targets.map((tab) => tab.id).reverse();
}

/**
 * 计算 `tab close --agent-only` 应关闭的标签 ID 列表（从右往左）：
 * 只关 `openedBy === 'agent' | 'popup'`；若全部标签均由 Agent 打开，保留当前激活的最后 1 个避免误停环境。
 */
export function closeAgentOnlySet(tabs: readonly TabState[], activeId?: string): string[] {
  const agentTabs = tabs.filter((t) => t.openedBy === 'agent' || t.openedBy === 'popup');
  if (agentTabs.length === 0) return [];
  if (agentTabs.length === tabs.length && tabs.length > 0) {
    const keepId = activeId && tabs.some((t) => t.id === activeId) ? activeId : tabs[0]!.id;
    return agentTabs
      .filter((t) => t.id !== keepId)
      .map((t) => t.id)
      .reverse();
  }
  return agentTabs.map((t) => t.id).reverse();
}
