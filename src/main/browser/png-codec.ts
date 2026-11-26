/**
 * 零外部依赖纯 JS PNG 编解码器（8-bit Gray / GrayAlpha / RGB / RGBA，非交错）。
 * 基于 Node 原生 `node:zlib` 实现 5 种标准 PNG 行滤镜（None / Sub / Up / Average / Paeth）还原与 CRC32 分块封装。
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePngRgba(buf: Buffer): DecodedPng | null {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) return null;
    if (type === 'IHDR' && length >= 13) {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8]!;
      colorType = buf[dataStart + 9]!;
      interlace = buf[dataStart + 12]!;
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // 跳过 CRC
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0 || idatChunks.length === 0) return null;
  // colorType: 0=Gray(1), 2=RGB(3), 4=GrayA(2), 6=RGBA(4)
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (bpp === 0) return null;

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: 64 * 1024 * 1024 });
  } catch {
    return null;
  }

  const rowBytes = width * bpp;
  if (inflated.length < height * (rowBytes + 1)) return null;

  const raw = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (rowBytes + 1)]!;
    const srcOff = y * (rowBytes + 1) + 1;
    const dstOff = y * rowBytes;
    const prevOff = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const byte = inflated[srcOff + x]!;
      const left = x >= bpp ? raw[dstOff + x - bpp]! : 0;
      const up = y > 0 ? raw[prevOff + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? raw[prevOff + x - bpp]! : 0;
      let val = byte;
      if (filter === 1) val = (byte + left) & 0xff;
      else if (filter === 2) val = (byte + up) & 0xff;
      else if (filter === 3) val = (byte + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) val = (byte + paethPredictor(left, up, upLeft)) & 0xff;
      raw[dstOff + x] = val;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  if (colorType === 6) {
    rgba.set(raw);
  } else if (colorType === 2) {
    for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
      rgba[j] = raw[i]!;
      rgba[j + 1] = raw[i + 1]!;
      rgba[j + 2] = raw[i + 2]!;
      rgba[j + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, j = 0; i < raw.length; i += 2, j += 4) {
      const g = raw[i]!;
      rgba[j] = g;
      rgba[j + 1] = g;
      rgba[j + 2] = g;
      rgba[j + 3] = raw[i + 1]!;
    }
  } else {
    for (let i = 0, j = 0; i < raw.length; i += 1, j += 4) {
      const g = raw[i]!;
      rgba[j] = g;
      rgba[j + 1] = g;
      rgba[j + 2] = g;
      rgba[j + 3] = 255;
    }
  }

  return { width, height, rgba };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = width * 4;
  const raw = Buffer.alloc(height * (rowStride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (rowStride + 1)] = 0; // filter None
    raw.set(rgba.subarray(y * rowStride, (y + 1) * rowStride), y * (rowStride + 1) + 1);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
