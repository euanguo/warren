/**
 * snapshot ref 表：`@1..@N` -> backendNodeId + gen。
 *
 * 整页导航后 gen+1，老 ref 读到报 TARGET_STALE（提示重拍）；页内导航 gen 不变。
 * 纯内存结构，可单测。
 */
export class RefTable {
  #map = new Map<string, { backendId: number; gen: number }>();
  #gen = 1;

  get gen(): number {
    return this.#gen;
  }

  /** 整页导航后调用，老 ref 全部失效。 */
  bump(): void {
    this.#gen += 1;
  }

  /** 一次 snapshot 注册一批 backendId，返回分配的 ref（`@1..@N`）。 */
  register(backendIds: Array<number | undefined>): string[] {
    this.#map.clear();
    const refs: string[] = [];
    let n = 1;
    for (const id of backendIds) {
      if (typeof id !== 'number') continue;
      const ref = `@${n++}`;
      this.#map.set(ref, { backendId: id, gen: this.#gen });
      refs.push(ref);
    }
    return refs;
  }

  /** 解析 `@21` / `ref=21` / `21` 三种写法，导航后返回 stale。 */
  resolve(input: string): { backendId: number; stale: boolean } {
    const ref = input.startsWith('@') ? input : input.startsWith('ref=') ? `@${input.slice(4)}` : `@${input}`;
    const entry = this.#map.get(ref);
    if (!entry) {
      throw Object.assign(new Error(`unknown ref: ${input}（snapshot 已过期请重拍）`), {
        code: 'TARGET_STALE',
      });
    }
    if (entry.gen !== this.#gen) {
      throw Object.assign(new Error(`stale ref: ${input}（页面已导航请重拍）`), {
        code: 'TARGET_STALE',
      });
    }
    return { backendId: entry.backendId, stale: false };
  }

  has(input: string): boolean {
    const ref = input.startsWith('@') ? input : `@${input.replace(/^ref=/, '')}`;
    const entry = this.#map.get(ref);
    return Boolean(entry && entry.gen === this.#gen);
  }
}
