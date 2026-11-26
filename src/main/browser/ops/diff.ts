import { readFile } from 'node:fs/promises';
import type { AxNode, SnapshotResult } from '../../../shared/types.ts';
import { imageSize, sha256Buffer } from '../../artifacts.ts';

export interface SnapshotDiffEntry {
  role: string;
  name: string;
  value?: string;
  ref?: string;
}

export interface SnapshotChangedEntry {
  role: string;
  name: string;
  before: { value?: string; checked?: boolean | 'mixed'; disabled?: boolean; selected?: boolean };
  after: { value?: string; checked?: boolean | 'mixed'; disabled?: boolean; selected?: boolean };
  ref?: string;
}

export interface SnapshotDiffResult {
  urlChanged: boolean;
  titleChanged: boolean;
  prevUrl: string;
  url: string;
  prevTitle: string;
  title: string;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  added: SnapshotDiffEntry[];
  removed: SnapshotDiffEntry[];
  changed: SnapshotChangedEntry[];
  summary: string;
}

export interface ScreenshotDiffResult {
  match: boolean;
  a: { path: string; bytes: number; sha256: string; width?: number; height?: number };
  b: { path: string; bytes: number; sha256: string; width?: number; height?: number };
  summary: string;
}

const lastSnapshots = new Map<string, SnapshotResult>();

export function rememberSnapshot(scopeKey: string, snapshot: SnapshotResult): void {
  lastSnapshots.set(scopeKey, snapshot);
}

export function getLastSnapshot(scopeKey: string): SnapshotResult | undefined {
  return lastSnapshots.get(scopeKey);
}

function signatureOf(node: AxNode, indexInBucket: number): string {
  return `${node.role}::${node.name}::${node.frameId ?? ''}::${indexInBucket}`;
}

function indexNodes(nodes: AxNode[]): Map<string, AxNode> {
  const counts = new Map<string, number>();
  const map = new Map<string, AxNode>();
  for (const node of nodes) {
    const base = `${node.role}::${node.name}::${node.frameId ?? ''}`;
    const idx = counts.get(base) ?? 0;
    counts.set(base, idx + 1);
    map.set(signatureOf(node, idx), node);
  }
  return map;
}

function nodeChanged(a: AxNode, b: AxNode): boolean {
  return (
    (a.value ?? '') !== (b.value ?? '') ||
    a.checked !== b.checked ||
    Boolean(a.disabled) !== Boolean(b.disabled) ||
    Boolean(a.selected) !== Boolean(b.selected)
  );
}

/** 纯函数对比两次快照，给出 URL/Title 与交互节点增删改摘要。 */
export function diffSnapshots(prev: SnapshotResult, next: SnapshotResult): SnapshotDiffResult {
  const prevMap = indexNodes(prev.nodes);
  const nextMap = indexNodes(next.nodes);

  const added: SnapshotDiffEntry[] = [];
  const removed: SnapshotDiffEntry[] = [];
  const changed: SnapshotChangedEntry[] = [];

  for (const [sig, node] of nextMap) {
    const old = prevMap.get(sig);
    if (!old) {
      added.push({ role: node.role, name: node.name, ...(node.value ? { value: node.value } : {}), ref: node.ref });
    } else if (nodeChanged(old, node)) {
      changed.push({
        role: node.role,
        name: node.name,
        before: { value: old.value, checked: old.checked, disabled: old.disabled, selected: old.selected },
        after: { value: node.value, checked: node.checked, disabled: node.disabled, selected: node.selected },
        ref: node.ref,
      });
    }
  }
  for (const [sig, old] of prevMap) {
    if (!nextMap.has(sig)) {
      removed.push({ role: old.role, name: old.name, ...(old.value ? { value: old.value } : {}) });
    }
  }

  const urlChanged = prev.url !== next.url;
  const titleChanged = prev.title !== next.title;
  const parts = [];
  if (urlChanged) parts.push(`URL 变化: ${prev.url} -> ${next.url}`);
  if (titleChanged) parts.push(`标题变化: ${prev.title} -> ${next.title}`);
  parts.push(`新增 ${added.length} / 移除 ${removed.length} / 变更 ${changed.length}`);

  return {
    urlChanged,
    titleChanged,
    prevUrl: prev.url,
    url: next.url,
    prevTitle: prev.title,
    title: next.title,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    added: added.slice(0, 60),
    removed: removed.slice(0, 60),
    changed: changed.slice(0, 60),
    summary: parts.join(' · '),
  };
}

function detectFormat(filePath: string, buf: Buffer): 'png' | 'jpeg' {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (/\.jpe?g$/i.test(filePath) || (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8)) return 'jpeg';
  return 'png';
}

export async function diffScreenshots(pathA: string, pathB: string): Promise<ScreenshotDiffResult> {
  const [bufA, bufB] = await Promise.all([readFile(pathA), readFile(pathB)]);
  const shaA = sha256Buffer(bufA);
  const shaB = sha256Buffer(bufB);
  const dimA = imageSize(bufA, detectFormat(pathA, bufA));
  const dimB = imageSize(bufB, detectFormat(pathB, bufB));
  const match = shaA === shaB;
  return {
    match,
    a: { path: pathA, bytes: bufA.length, sha256: shaA, ...dimA },
    b: { path: pathB, bytes: bufB.length, sha256: shaB, ...dimB },
    summary: match ? `一致（sha256=${shaA.slice(0, 12)}）` : `存在差异（${bufA.length} B vs ${bufB.length} B）`,
  };
}
