export interface RemoteFrame {
  w: number;
  h: number;
  charset: string;
  charIndices: Bytes;
  palette: Bytes | null;
  colorIndices: Bytes | null;
  isKeyframe: boolean;
  isBlockColor: boolean;
  timestamp: number;
}

// TS 5.7+ made Uint8Array generic over its backing buffer, and methods like
// .slice()/.subarray() infer ArrayBufferLike (which includes SharedArrayBuffer)
// instead of plain ArrayBuffer. Every array in this module is a normal
// heap-allocated Uint8Array, so we pin the generic here once instead of
// fighting the inference at every call site.
type Bytes = Uint8Array<ArrayBufferLike>;

const FLAG_KEYFRAME    = 0x01;
const FLAG_DELTA       = 0x02;
const FLAG_BLOCK_COLOR = 0x04;
const FLAG_HAS_PALETTE = 0x08;
const FLAG_ASCII_COLOR = 0x10;

const DELTA_BREAKEVEN_RATIO = 0.4;

export function bitsNeeded(n: number): number {
  if (n <= 1) return 1;
  return Math.ceil(Math.log2(n));
}

export function generatePalette(numColors = 256): Bytes {
  const palette = new Uint8Array(numColors * 3);
  const rLevels = 8, gLevels = 8, bLevels = 4;
  for (let ri = 0; ri < rLevels; ri++) {
    for (let gi = 0; gi < gLevels; gi++) {
      for (let bi = 0; bi < bLevels; bi++) {
        const idx = (ri * gLevels * bLevels + gi * bLevels + bi) * 3;
        if (idx + 2 < palette.length) {
          palette[idx]     = Math.round((ri + 0.5) * 255 / rLevels);
          palette[idx + 1] = Math.round((gi + 0.5) * 255 / gLevels);
          palette[idx + 2] = Math.round((bi + 0.5) * 255 / bLevels);
        }
      }
    }
  }
  return palette;
}

export function mapToPalette(r: Bytes, g: Bytes, b: Bytes): Bytes {
  const n = r.length;
  const indices = new Uint8Array(n);
  const rLevels = 8, gLevels = 8, bLevels = 4;
  for (let i = 0; i < n; i++) {
    const ri = Math.min(rLevels - 1, Math.floor(r[i] * rLevels / 256));
    const gi = Math.min(gLevels - 1, Math.floor(g[i] * gLevels / 256));
    const bi = Math.min(bLevels - 1, Math.floor(b[i] * bLevels / 256));
    indices[i] = ri * gLevels * bLevels + gi * bLevels + bi;
  }
  return indices;
}

export function paletteToRgb(palette: Bytes, colorIndices: Bytes): Bytes {
  const N = colorIndices.length;
  const colors = new Uint8Array(N * 3);
  for (let i = 0; i < N; i++) {
    const pi = colorIndices[i] * 3;
    colors[i * 3]     = palette[pi];
    colors[i * 3 + 1] = palette[pi + 1];
    colors[i * 3 + 2] = palette[pi + 2];
  }
  return colors;
}

/** Builds a sparse (position, value) change list. Returns null if too much changed to be worth it. */
function buildSparseDelta(curr: Bytes, prev: Bytes): { positions: Uint32Array; values: Bytes } | null {
  const N = curr.length;
  let changed = 0;
  for (let i = 0; i < N; i++) if (curr[i] !== prev[i]) changed++;
  if (changed === 0) return { positions: new Uint32Array(0), values: new Uint8Array(0) };
  if (changed / N > DELTA_BREAKEVEN_RATIO) return null;

  const positions = new Uint32Array(changed);
  const values = new Uint8Array(changed);
  let j = 0;
  for (let i = 0; i < N; i++) {
    if (curr[i] !== prev[i]) { positions[j] = i; values[j] = curr[i]; j++; }
  }
  return { positions, values };
}

function writeSparseDelta(out: Bytes, p: number, positions: Uint32Array, values: Bytes): number {
  const count = positions.length;
  out[p++] = (count >>> 24) & 0xff;
  out[p++] = (count >>> 16) & 0xff;
  out[p++] = (count >>> 8) & 0xff;
  out[p++] = count & 0xff;
  for (let i = 0; i < count; i++) {
    const pos = positions[i];
    out[p++] = (pos >>> 24) & 0xff;
    out[p++] = (pos >>> 16) & 0xff;
    out[p++] = (pos >>> 8) & 0xff;
    out[p++] = pos & 0xff;
    out[p++] = values[i];
  }
  return p;
}

function readSparseDelta(data: Bytes, p: number, base: Bytes): number {
  const count = (data[p] << 24 | data[p + 1] << 16 | data[p + 2] << 8 | data[p + 3]) >>> 0;
  p += 4;
  for (let i = 0; i < count; i++) {
    const pos = (data[p] << 24 | data[p + 1] << 16 | data[p + 2] << 8 | data[p + 3]) >>> 0;
    p += 4;
    const val = data[p++];
    if (pos < base.length) base[pos] = val;
  }
  return p;
}

function packBits(values: Bytes, bitsPerVal: number): Bytes {
  const N = values.length;
  const bytes = Math.ceil((N * bitsPerVal) / 8);
  const out = new Uint8Array(bytes);
  const mask = (1 << bitsPerVal) - 1;
  let bitBuf = 0, bitCount = 0, pos = 0;
  for (let i = 0; i < N; i++) {
    bitBuf = (bitBuf << bitsPerVal) | (values[i] & mask);
    bitCount += bitsPerVal;
    while (bitCount >= 8) {
      bitCount -= 8;
      out[pos++] = (bitBuf >> bitCount) & 0xff;
    }
  }
  if (bitCount > 0) out[pos++] = (bitBuf << (8 - bitCount)) & 0xff;
  return out;
}

function unpackBits(data: Bytes, offset: number, count: number, bitsPerVal: number): { values: Bytes; bytesRead: number } {
  const values = new Uint8Array(count);
  const mask = (1 << bitsPerVal) - 1;
  let bitBuf = 0, bitCount = 0, p = offset;
  for (let i = 0; i < count; i++) {
    while (bitCount < bitsPerVal && p < data.length) {
      bitBuf = (bitBuf << 8) | data[p++];
      bitCount += 8;
    }
    if (bitCount >= bitsPerVal) {
      bitCount -= bitsPerVal;
      values[i] = (bitBuf >> bitCount) & mask;
    }
  }
  return { values, bytesRead: p - offset };
}

export interface EncodeOpts {
  charIndices: Bytes | null;
  w: number;
  h: number;
  charset: string;
  colorIndices: Bytes | null;  // already palette-mapped, 0-255 indices
  palette: Bytes | null;       // 256*3 RGB, only needed on keyframes
  blockColorMode: boolean;     // true = pure color blocks, no char data sent
  prevCharIndices: Bytes | null;
  prevColorIndices: Bytes | null;
  forceKeyframe: boolean;
}

export function encodeFrame(opts: EncodeOpts): ArrayBuffer {
  const {
    w, h, charset, colorIndices, palette, blockColorMode,
    prevCharIndices, prevColorIndices, forceKeyframe,
  } = opts;
  const charIndices = opts.charIndices;
  const N = w * h;

  let flags = 0;
  if (blockColorMode) flags |= FLAG_BLOCK_COLOR;
  else if (colorIndices) flags |= FLAG_ASCII_COLOR;

  let charDelta: { positions: Uint32Array; values: Uint8Array } | null = null;
  let colorDelta: { positions: Uint32Array; values: Uint8Array } | null = null;
  let isKeyframe = forceKeyframe;

  if (!blockColorMode && charIndices && !forceKeyframe && prevCharIndices && prevCharIndices.length === N) {
    charDelta = buildSparseDelta(charIndices, prevCharIndices);
    if (!charDelta) isKeyframe = true;
  } else if (!blockColorMode) {
    isKeyframe = true;
  }

  if (blockColorMode && colorIndices && !forceKeyframe && prevColorIndices && prevColorIndices.length === N) {
    colorDelta = buildSparseDelta(colorIndices, prevColorIndices);
    if (!colorDelta) isKeyframe = true;
  } else if (blockColorMode) {
    isKeyframe = true;
  }

  if (isKeyframe) { flags |= FLAG_KEYFRAME; charDelta = null; colorDelta = null; }
  else flags |= FLAG_DELTA;

  const needsPalette = (blockColorMode || colorIndices) && isKeyframe;
  if (needsPalette) flags |= FLAG_HAS_PALETTE;

  const charsetBytes = blockColorMode ? new Uint8Array(0) : new TextEncoder().encode(charset);
  const bitsPerChar = blockColorMode ? 0 : bitsNeeded(charset.length);

  let charSection: Bytes = new Uint8Array(0);
  if (!blockColorMode && charIndices) {
    if (charDelta) {
      const section = new Uint8Array(4 + charDelta.positions.length * 5);
      writeSparseDelta(section, 0, charDelta.positions, charDelta.values);
      charSection = section;
    } else {
      charSection = packBits(charIndices, bitsPerChar);
    }
  }

  let paletteSection: Bytes = new Uint8Array(0);
  if (needsPalette && palette) paletteSection = palette;

  let colorSection: Bytes = new Uint8Array(0);
  if (colorIndices) {
    if (blockColorMode && colorDelta) {
      const section = new Uint8Array(4 + colorDelta.positions.length * 5);
      writeSparseDelta(section, 0, colorDelta.positions, colorDelta.values);
      colorSection = section;
    } else {
      colorSection = colorIndices;
    }
  }

  const fixedHeader = 1 /*flags*/ + 2 /*w*/ + 2 /*h*/ + 1 /*charsetLen*/ + charsetBytes.length;
  const paletteHeader = paletteSection.length > 0 ? 2 : 0;

  const totalSize = fixedHeader + charSection.length + paletteHeader + paletteSection.length + colorSection.length;
  const out = new Uint8Array(totalSize);
  let p = 0;

  out[p++] = flags;
  out[p++] = (w >> 8) & 0xff;
  out[p++] = w & 0xff;
  out[p++] = (h >> 8) & 0xff;
  out[p++] = h & 0xff;
  out[p++] = charsetBytes.length;
  out.set(charsetBytes, p); p += charsetBytes.length;

  out.set(charSection, p); p += charSection.length;

  if (paletteSection.length > 0) {
    out[p++] = (paletteSection.length >> 8) & 0xff;
    out[p++] = paletteSection.length & 0xff;
    out.set(paletteSection, p); p += paletteSection.length;
  }

  out.set(colorSection, p);

  return out.buffer;
}

export function decode(buffer: ArrayBuffer, prevFrame: RemoteFrame | null): RemoteFrame | null {
  const data: Bytes = new Uint8Array(buffer);
  if (data.length < 6) return null;

  let p = 0;
  const flags        = data[p++];
  const isKeyframe    = (flags & FLAG_KEYFRAME) !== 0;
  const isDelta       = (flags & FLAG_DELTA) !== 0;
  const isBlockColor  = (flags & FLAG_BLOCK_COLOR) !== 0;
  const hasPalette    = (flags & FLAG_HAS_PALETTE) !== 0;
  const hasAsciiColor = (flags & FLAG_ASCII_COLOR) !== 0;

  const w = (data[p++] << 8) | data[p++];
  const h = (data[p++] << 8) | data[p++];
  const N = w * h;

  const charsetLen = data[p++];
  if (p + charsetLen > data.length) return null;
  const charset = isBlockColor ? "" : new TextDecoder().decode(data.slice(p, p + charsetLen));
  p += charsetLen;

  let charIndices: Bytes;
  if (isBlockColor) {
    charIndices = prevFrame?.charIndices?.length === N ? new Uint8Array(prevFrame.charIndices) : new Uint8Array(N);
  } else {
    const bitsPerChar = bitsNeeded(charset.length);
    if (isDelta) {
      charIndices = prevFrame?.charIndices?.length === N ? new Uint8Array(prevFrame.charIndices) : new Uint8Array(N);
      p = readSparseDelta(data, p, charIndices);
    } else {
      const { values, bytesRead } = unpackBits(data, p, N, bitsPerChar);
      charIndices = values;
      p += bytesRead;
    }
  }

  let palette: Bytes | null = null;
  if (hasPalette && p + 2 <= data.length) {
    const paletteLen = (data[p] << 8) | data[p + 1];
    p += 2;
    if (paletteLen > 0 && p + paletteLen <= data.length) {
      palette = new Uint8Array(data.slice(p, p + paletteLen));
      p += paletteLen;
    }
  } else if ((isBlockColor || hasAsciiColor) && prevFrame?.palette) {
    palette = prevFrame.palette;
  }

  let colorIndices: Bytes | null = null;
  if (isBlockColor) {
    colorIndices = prevFrame?.colorIndices?.length === N ? new Uint8Array(prevFrame.colorIndices) : new Uint8Array(N);
    if (isDelta) {
      readSparseDelta(data, p, colorIndices);
    } else if (p + N <= data.length) {
      colorIndices.set(data.subarray(p, p + N));
    }
  } else if (hasAsciiColor && palette) {
    colorIndices = new Uint8Array(N);
    for (let i = 0; i < N && p < data.length; i++) colorIndices[i] = data[p++];
  }

  return { w, h, charset, charIndices, palette, colorIndices, isKeyframe, isBlockColor, timestamp: performance.now() };
}

export function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  return null;
}
