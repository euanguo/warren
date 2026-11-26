/**
 * 快照与截图差分：
 * 1. `diffSnapshots`：结构化节点增删改 + 剥离 `[ref=@N]` 后的行级统一 Diff（LCS/Myers 思想，消除插入移位误报）；
 * 2. `diffScreenshots`：零外部依赖纯 JS PNG 逐像素 RGBA 差分（基于 Node 原生 `node:zlib` 还原 PNG 5 种行滤镜），
 *    计算真实 `differentPixels` / `mismatchPercentage`，可选输出红/灰高亮差异 PNG；
 *    对不完整头或 JPEG 自动降级为 SHA-256 + 尺寸对比。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AxNode, SnapshotResult } from '../../../shared/types.ts';
import { guardScreenshotPath, imageSize, sha256Buffer } from '../../artifacts.ts';
import { decodePngRgba, encodePngRgba } from '../png-codec.ts';
import { formatCompactSnapshot } from './snapshot-compact.ts';

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
  /** 去除了 `[ref=@N]` 噪音的行级统一 diff（3 行上下文）。 */
  unifiedDiff: string;
  summary: string;
}

export interface ScreenshotDiffResult {
  match: boolean;
  a: { path: string; bytes: number; sha256: string; width?: number; height?: number };
  b: { path: string; bytes: number; sha256: string; width?: number; height?: number };
  pixelCompared: boolean;
  totalPixels?: number;
  differentPixels?: number;
  mismatchPercentage?: number;
  diffPath?: string;
  summary: string;
}

const MAX_CACHED_SNAPSHOTS = 32;
const lastSnapshots = new Map<string, SnapshotResult>();

export function rememberSnapshot(scopeKey: string, snapshot: SnapshotResult): void {
  if (lastSnapshots.has(scopeKey)) lastSnapshots.delete(scopeKey);
  else if (lastSnapshots.size >= MAX_CACHED_SNAPSHOTS) {
    const oldest = lastSnapshots.keys().next().value;
    if (oldest !== undefined) lastSnapshots.delete(oldest);
  }
  lastSnapshots.set(scopeKey, snapshot);
}

export function getLastSnapshot(scopeKey: string): SnapshotResult | undefined {
  const cached = lastSnapshots.get(scopeKey);
  if (cached !== undefined) {
    lastSnapshots.delete(scopeKey);
    lastSnapshots.set(scopeKey, cached);
  }
  return cached;
}

/** 清理已删除环境的缓存快照，避免常驻实例内存持续膨胀。 */
export function clearCachedSnapshots(envId?: string): void {
  if (!envId) {
    lastSnapshots.clear();
    return;
  }
  for (const key of [...lastSnapshots.keys()]) {
    if (key === envId || key.startsWith(`${envId}:`)) lastSnapshots.delete(key);
  }
}

/** 剥离快照行中易变的 `ref=@N` 和 `new` 标记，供稳定的语义 Diff 使用。 */
export function stripVolatileRefTokens(line: string): string {
  return line
    .replace(/,\s*ref=@\d+/g, '')
    .replace(/ref=@\d+,\s*/g, '')
    .replace(/\s*\[ref=@\d+\]/g, '')
    .replace(/,\s*new(?=[,\]])/g, '')
    .replace(/\[new,\s*/g, '[')
    .replace(/\s*\[new\]/g, '');
}

/** 行级 LCS 统一 Diff（3 行上下文，限制计算矩阵规模防止极端大页内存暴涨）。 */
export function computeUnifiedLineDiff(prevText: string, nextText: string, contextLines = 3): string {
  const a = prevText.split(/\r?\n/).map(stripVolatileRefTokens);
  const b = nextText.split(/\r?\n/).map(stripVolatileRefTokens);
  if (a.length === b.length && a.every((l, i) => l === b[i])) return '';

  // 裁剪首尾完全相同的行以减小 DP 规模
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  type Op = { kind: ' ' | '-' | '+'; line: string };
  const ops: Op[] = [];
  for (let i = 0; i < prefix; i++) ops.push({ kind: ' ', line: a[i]! });

  if (midA.length * midB.length <= 250_000) {
    const m = midA.length;
    const n = midB.length;
    const dp = new Uint32Array((m + 1) * (n + 1));
    const stride = n + 1;
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)]! + 1;
        else dp[i * stride + j] = Math.max(dp[(i + 1) * stride + j]!, dp[i * stride + (j + 1)]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: ' ', line: midA[i]! });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + (j + 1)]!) {
        ops.push({ kind: '-', line: midA[i]! });
        i += 1;
      } else {
        ops.push({ kind: '+', line: midB[j]! });
        j += 1;
      }
    }
    while (i < m) ops.push({ kind: '-', line: midA[i++]! });
    while (j < n) ops.push({ kind: '+', line: midB[j++]! });
  } else {
    for (const line of midA) ops.push({ kind: '-', line });
    for (const line of midB) ops.push({ kind: '+', line });
  }

  for (let i = a.length - suffix; i < a.length; i++) ops.push({ kind: ' ', line: a[i]! });

  // 按 contextLines 切出变更 hunk
  const keep = new Uint8Array(ops.length);
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx]!.kind !== ' ') {
      const start = Math.max(0, idx - contextLines);
      const end = Math.min(ops.length - 1, idx + contextLines);
      for (let k = start; k <= end; k++) keep[k] = 1;
    }
  }
  const out: string[] = [];
  let skipping = false;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!keep[idx]) {
      if (!skipping && out.length > 0) out.push('...');
      skipping = true;
      continue;
    }
    skipping = false;
    const op = ops[idx]!;
    out.push(`${op.kind} ${op.line}`);
  }
  return out.slice(0, 200).join('\n');
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

/** 对比两次快照，同时产出结构化节点增删改与去 ref 行级统一 Diff。 */
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

  const prevCompact = formatCompactSnapshot({ url: prev.url, title: prev.title, nodes: prev.nodes });
  const nextCompact = formatCompactSnapshot({ url: next.url, title: next.title, nodes: next.nodes });
  const unifiedDiff = computeUnifiedLineDiff(prevCompact, nextCompact, 3);

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
    unifiedDiff,
    summary: parts.join(' · '),
  };
}

function detectFormat(filePath: string, buf: Buffer): 'png' | 'jpeg' {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (/\.jpe?g$/i.test(filePath) || (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8)) return 'jpeg';
  return 'png';
}

export interface DiffScreenshotsOptions {
  /** 通道容差阈值（0–1 比例，默认 0.05，约 13/255 抗锯齿抖动宽容）。 */
  threshold?: number;
  /** 若提供路径且存在像素差异，生成红/灰差异高亮 PNG 到该绝对路径。 */
  outputPath?: string;
}

export async function diffScreenshots(
  pathA: string,
  pathB: string,
  opts: DiffScreenshotsOptions = {},
): Promise<ScreenshotDiffResult> {
  const [bufA, bufB] = await Promise.all([readFile(pathA), readFile(pathB)]);
  const shaA = sha256Buffer(bufA);
  const shaB = sha256Buffer(bufB);
  const dimA = imageSize(bufA, detectFormat(pathA, bufA));
  const dimB = imageSize(bufB, detectFormat(pathB, bufB));

  if (shaA === shaB) {
    return {
      match: true,
      a: { path: pathA, bytes: bufA.length, sha256: shaA, ...dimA },
      b: { path: pathB, bytes: bufB.length, sha256: shaB, ...dimB },
      pixelCompared: false,
      differentPixels: 0,
      mismatchPercentage: 0,
      summary: `一致（sha256=${shaA.slice(0, 12)}）`,
    };
  }

  const decA = decodePngRgba(bufA);
  const decB = decodePngRgba(bufB);
  if (decA && decB) {
    const width = Math.max(decA.width, decB.width);
    const height = Math.max(decA.height, decB.height);
    const totalPixels = width * height;
    const channelTol = Math.round(Math.max(0, Math.min(1, opts.threshold ?? 0.05)) * 255);
    const outRgba = opts.outputPath ? new Uint8Array(width * height * 4) : null;
    let differentPixels = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inA = x < decA.width && y < decA.height;
        const inB = x < decB.width && y < decB.height;
        const oi = (y * width + x) * 4;
        if (!inA || !inB) {
          differentPixels += 1;
          if (outRgba) {
            outRgba[oi] = 239;
            outRgba[oi + 1] = 68;
            outRgba[oi + 2] = 68;
            outRgba[oi + 3] = 255;
          }
          continue;
        }
        const ai = (y * decA.width + x) * 4;
        const bi = (y * decB.width + x) * 4;
        const dr = Math.abs(decA.rgba[ai]! - decB.rgba[bi]!);
        const dg = Math.abs(decA.rgba[ai + 1]! - decB.rgba[bi + 1]!);
        const db = Math.abs(decA.rgba[ai + 2]! - decB.rgba[bi + 2]!);
        const da = Math.abs(decA.rgba[ai + 3]! - decB.rgba[bi + 3]!);
        const diff = dr > channelTol || dg > channelTol || db > channelTol || da > channelTol;
        if (diff) {
          differentPixels += 1;
          if (outRgba) {
            outRgba[oi] = 239;
            outRgba[oi + 1] = 68;
            outRgba[oi + 2] = 68;
            outRgba[oi + 3] = 255;
          }
        } else if (outRgba) {
          // 相同像素转为淡灰底图，突出红色差异区域
          const gray = Math.round(decB.rgba[bi]! * 0.299 + decB.rgba[bi + 1]! * 0.587 + decB.rgba[bi + 2]! * 0.114);
          const muted = Math.round(gray * 0.45 + 140);
          outRgba[oi] = muted;
          outRgba[oi + 1] = muted;
          outRgba[oi + 2] = muted;
          outRgba[oi + 3] = 255;
        }
      }
    }

    const mismatchPercentage = totalPixels > 0 ? Math.round((differentPixels / totalPixels) * 10_000) / 100 : 0;
    const match = differentPixels === 0;
    let diffPath: string | undefined;
    if (opts.outputPath && outRgba && !match) {
      const safeOutput = guardScreenshotPath(opts.outputPath);
      await mkdir(path.dirname(safeOutput), { recursive: true });
      await writeFile(safeOutput, encodePngRgba(width, height, outRgba));
      diffPath = safeOutput;
    }

    return {
      match,
      a: { path: pathA, bytes: bufA.length, sha256: shaA, ...dimA },
      b: { path: pathB, bytes: bufB.length, sha256: shaB, ...dimB },
      pixelCompared: true,
      totalPixels,
      differentPixels,
      mismatchPercentage,
      ...(diffPath ? { diffPath } : {}),
      summary: match
        ? `像素完全一致（${width}x${height}）`
        : `像素差异 ${differentPixels}/${totalPixels} (${mismatchPercentage}%)${diffPath ? ` · 差异图：${diffPath}` : ''}`,
    };
  }

  return {
    match: false,
    a: { path: pathA, bytes: bufA.length, sha256: shaA, ...dimA },
    b: { path: pathB, bytes: bufB.length, sha256: shaB, ...dimB },
    pixelCompared: false,
    summary: `存在差异（${bufA.length} B vs ${bufB.length} B）`,
  };
}
