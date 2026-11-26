/**
 * Agent 产物落盘：截图、HAR、证据包共用。
 *
 * 这些文件都写在 `WARREN_HOME/artifacts` 下，按环境分目录，并由核心统一返回
 * 绝对路径、字节数和 SHA-256。默认不把 base64 带回 CLI，避免一次截图把上下文打爆。
 */
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { warrenHome } from './paths.ts';
import { guardSavePath } from './browser/policy.ts';

export interface ArtifactMeta {
  path: string;
  bytes: number;
  sha256: string;
}

function safeSegment(value: string): string {
  return String(value || 'artifact')
    .replace(/[^\w.-]+/g, '-')
    .slice(0, 80);
}

export function artifactRoot(environmentId?: string): string {
  const root = path.join(warrenHome(), 'artifacts');
  return environmentId ? path.join(root, safeSegment(environmentId)) : root;
}

export function defaultScreenshotPath(environmentId: string, format: 'png' | 'jpeg', now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(artifactRoot(environmentId), `screenshot-${stamp}.${format}`);
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 截图目标路径护栏。
 *
 * 内部产物目录（artifacts / evidence）必须允许写入，其余路径沿用 `guardSavePath`
 * 的系统目录 / 数据目录 / 绝对路径约束。
 */
export function guardScreenshotPath(input: string): string {
  const absolute = path.resolve(input);
  const roots = [path.join(warrenHome(), 'artifacts'), path.join(warrenHome(), 'evidence')];
  if (roots.some((root) => absolute === root || absolute.startsWith(root + path.sep))) return absolute;
  return guardSavePath(absolute);
}

/** 从 PNG/JPEG 字节头读取尺寸，零图像依赖。读不出来时返回 undefined，不猜。 */
export function imageSize(buffer: Buffer, format: 'png' | 'jpeg'): { width: number; height: number } | undefined {
  if (format === 'png') {
    if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return undefined;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return undefined;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return undefined;
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && offset + 7 <= buffer.length) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

export async function writeArtifact(filePath: string, data: Buffer | string): Promise<ArtifactMeta> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  await writeFile(absolute, buffer);
  const info = await stat(absolute);
  return { path: absolute, bytes: info.size, sha256: sha256Buffer(buffer) };
}

export async function artifactMeta(filePath: string, buffer: Buffer): Promise<ArtifactMeta> {
  const info = await stat(filePath);
  return { path: path.resolve(filePath), bytes: info.size, sha256: sha256Buffer(buffer) };
}
