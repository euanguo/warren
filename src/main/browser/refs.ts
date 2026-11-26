/**
 * snapshot ref 表：`@1..@N` -> backendNodeId + gen + per-frame loaderId + 自愈元数据。
 *
 * 两套入口：
 * - `register(backendIds)`：保留传统整表重排语义（单测与简单调用方直接依赖）；
 * - `registerStable(entries, frameLoaders)`：跨快照复用稳定 `@N`、按 frame `loaderId` 精确失效、
 *   并在 React 局部重绘导致 `backendNodeId` 更换时支持按 `(frameId, role, name)` 唯一匹配自愈。
 *
 * 纯内存结构，零 Electron 依赖，可单测。
 */
import type { AxNode } from '../../shared/types.ts';

export interface RefEntry {
  ref: string;
  backendId: number;
  gen: number;
  frameId?: string;
  loaderId?: string;
  sessionId?: string;
  role?: string;
  name?: string;
}

export interface StableRefInput {
  backendId?: number;
  frameId?: string;
  loaderId?: string;
  sessionId?: string;
  role?: string;
  name?: string;
}

const MAX_RETAINED_REFS = 2000;

function normalizeRefKey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('@')) return trimmed;
  if (trimmed.startsWith('ref=')) return `@${trimmed.slice(4)}`;
  return `@${trimmed}`;
}

export class RefTable {
  #map = new Map<string, RefEntry>();
  /** `(frameId::backendId)` -> `@N`，用于在同文档内跨快照稳定复用编号。 */
  #reverse = new Map<string, string>();
  /** 当前各 frame 最新 `loaderId`，子 iframe 独立导航时仅失效该 frame 的旧 ref。 */
  #frameLoaders = new Map<string, string>();
  #gen = 1;
  #nextNum = 1;

  get gen(): number {
    return this.#gen;
  }

  /** 整页导航后调用，老 ref 全部失效，序号重置。 */
  bump(): void {
    this.#gen += 1;
    this.#reverse.clear();
    this.#frameLoaders.clear();
    this.#nextNum = 1;
  }

  /** 更新已知各 frame 的当前 `loaderId`。 */
  updateFrameLoaders(loaders: ReadonlyMap<string, string> | Record<string, string>): void {
    const entries = loaders instanceof Map ? [...loaders.entries()] : Object.entries(loaders);
    for (const [frameId, loaderId] of entries) {
      if (!frameId || !loaderId) continue;
      const prev = this.#frameLoaders.get(frameId);
      if (prev && prev !== loaderId) {
        // 仅清理已导航的这个 frame 的反查缓存，主文档或其他 iframe 的 ref 不受影响
        for (const [revKey, ref] of [...this.#reverse.entries()]) {
          const item = this.#map.get(ref);
          if (item?.frameId === frameId) this.#reverse.delete(revKey);
        }
      }
      this.#frameLoaders.set(frameId, loaderId);
    }
  }

  /** 传统整表注册（保留兼容语义）：清空旧表并顺序分配 `@1..@N`。 */
  register(backendIds: Array<number | undefined>): string[] {
    this.#map.clear();
    this.#reverse.clear();
    const refs: string[] = [];
    let n = 1;
    for (const id of backendIds) {
      if (typeof id !== 'number') continue;
      const ref = `@${n++}`;
      this.#map.set(ref, { ref, backendId: id, gen: this.#gen });
      this.#reverse.set(`::${id}`, ref);
      refs.push(ref);
    }
    this.#nextNum = n;
    return refs;
  }

  /**
   * 跨快照稳定注册：
   * - 同文档中仍存活的 `backendId` 复原它原本的 `@N`（`isNew: false`）；
   * - 新出现的元素分配单调递增的新 `@N`（`isNew: true`）；
   * - 发生过局部 iframe 导航的 frame 自动按新 `loaderId` 失效旧 ref。
   */
  registerStable(
    items: Array<StableRefInput | undefined>,
    frameLoaders?: ReadonlyMap<string, string> | Record<string, string>,
  ): Array<{ ref: string; isNew: boolean } | undefined> {
    if (frameLoaders) this.updateFrameLoaders(frameLoaders);

    // 清理已被导航失效的旧条目，防止内存增长
    for (const [ref, entry] of [...this.#map.entries()]) {
      if (entry.gen !== this.#gen) {
        this.#map.delete(ref);
        continue;
      }
      if (entry.frameId && entry.loaderId) {
        const liveLoader = this.#frameLoaders.get(entry.frameId);
        if (liveLoader && liveLoader !== entry.loaderId) {
          this.#map.delete(ref);
          this.#reverse.delete(`${entry.frameId}::${entry.backendId}`);
        }
      }
    }

    const assigned: Array<{ ref: string; isNew: boolean } | undefined> = [];
    const touched = new Set<string>();
    const hasPreviousInGen = this.#map.size > 0;

    for (const item of items) {
      if (!item || typeof item.backendId !== 'number') {
        assigned.push(undefined);
        continue;
      }
      const frameKey = item.frameId ?? '';
      const revKey = `${frameKey}::${item.backendId}`;
      const existingRef = this.#reverse.get(revKey);
      const existing = existingRef ? this.#map.get(existingRef) : undefined;
      const loaderMatches = !existing?.loaderId || !item.loaderId || existing.loaderId === item.loaderId;

      if (existing && existing.gen === this.#gen && loaderMatches && !touched.has(existing.ref)) {
        existing.role = item.role ?? existing.role;
        existing.name = item.name ?? existing.name;
        existing.sessionId = item.sessionId ?? existing.sessionId;
        existing.loaderId = item.loaderId ?? existing.loaderId;
        touched.add(existing.ref);
        assigned.push({ ref: existing.ref, isNew: false });
      } else {
        const ref = `@${this.#nextNum++}`;
        const entry: RefEntry = {
          ref,
          backendId: item.backendId,
          gen: this.#gen,
          frameId: item.frameId,
          loaderId: item.loaderId,
          sessionId: item.sessionId,
          role: item.role,
          name: item.name,
        };
        this.#map.set(ref, entry);
        this.#reverse.set(revKey, ref);
        touched.add(ref);
        assigned.push({ ref, isNew: hasPreviousInGen });
      }
    }

    // 防止超长会话累积过多历史 ref
    if (this.#map.size > MAX_RETAINED_REFS) {
      for (const [ref, entry] of [...this.#map.entries()]) {
        if (this.#map.size <= MAX_RETAINED_REFS) break;
        if (!touched.has(ref)) {
          this.#map.delete(ref);
          this.#reverse.delete(`${entry.frameId ?? ''}::${entry.backendId}`);
        }
      }
    }

    return assigned;
  }

  /** 解析 `@21` / `ref=21` / `21` 三种写法；整页或所属 frame 导航后均报 `TARGET_STALE`。 */
  resolve(input: string): { backendId: number; stale: boolean; entry?: RefEntry } {
    const ref = normalizeRefKey(input);
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
    if (entry.frameId && entry.loaderId) {
      const currentLoader = this.#frameLoaders.get(entry.frameId);
      if (currentLoader && currentLoader !== entry.loaderId) {
        throw Object.assign(new Error(`stale ref: ${input}（子 frame 已重载，请重拍 snapshot）`), {
          code: 'TARGET_STALE',
        });
      }
    }
    return { backendId: entry.backendId, stale: false, entry };
  }

  /** 读取 ref 元数据（不抛错）。 */
  getMeta(input: string): RefEntry | undefined {
    const entry = this.#map.get(normalizeRefKey(input));
    if (!entry || entry.gen !== this.#gen) return undefined;
    return entry;
  }

  /**
   * 重绘自愈：当原 `backendId` 因 React/Vue 局部重渲染脱离 DOM，
   * 若在当前新节点列表中 `(frameId, role, name)` **唯一命中** 1 个节点，则原地自愈该 ref。
   * 多匹配或无匹配一律返回 null，绝不盲猜点错。
   */
  tryHeal(input: string, currentNodes: readonly AxNode[]): { backendId: number; healed: true } | null {
    const ref = normalizeRefKey(input);
    const entry = this.#map.get(ref);
    if (!entry || entry.gen !== this.#gen) return null;
    if (entry.frameId && entry.loaderId) {
      const liveLoader = this.#frameLoaders.get(entry.frameId);
      if (liveLoader && liveLoader !== entry.loaderId) return null;
    }
    if (!entry.role || !entry.name) return null;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const targetRole = entry.role.toLowerCase();
    const targetName = norm(entry.name);

    const candidates = currentNodes.filter((n) => {
      if (typeof n.backendNodeId !== 'number') return false;
      if (entry.frameId && n.frameId && n.frameId !== entry.frameId) return false;
      return n.role.toLowerCase() === targetRole && norm(n.name) === targetName;
    });
    if (candidates.length !== 1) return null;

    const healedId = candidates[0]!.backendNodeId!;
    this.#reverse.delete(`${entry.frameId ?? ''}::${entry.backendId}`);
    entry.backendId = healedId;
    this.#reverse.set(`${entry.frameId ?? ''}::${healedId}`, ref);
    return { backendId: healedId, healed: true };
  }

  has(input: string): boolean {
    const entry = this.#map.get(normalizeRefKey(input));
    if (!entry || entry.gen !== this.#gen) return false;
    if (entry.frameId && entry.loaderId) {
      const currentLoader = this.#frameLoaders.get(entry.frameId);
      if (currentLoader && currentLoader !== entry.loaderId) return false;
    }
    return true;
  }
}
