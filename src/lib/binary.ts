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
const FLAG_V2          = 0x20; // varint gap-coded deltas; palette only when flagged


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

// ───────────────────────── adaptive palette ─────────────────────────

/** Median-cut over a 5-5-5 histogram. Cheap (a few ms for ~10k cells) and far better than a fixed grid. */
export function buildAdaptivePalette(rgba: ArrayLike<number>, n: number): Bytes {
  const hist = new Uint32Array(32768);
  for (let i = 0, o = 0; i < n; i++, o += 4) hist[((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3)]++;
  const keys: number[] = [];
  for (let k = 0; k < 32768; k++) if (hist[k]) keys.push(k);
  const chan = (k: number, c: number) => c === 0 ? (k >> 10) & 31 : c === 1 ? (k >> 5) & 31 : k & 31;
  const W = [2, 4, 3]; // perceptual channel weights (R, G, B)
  const boxes: { lo: number; hi: number; pop: number }[] = [{ lo: 0, hi: keys.length, pop: n }];
  while (boxes.length < 256) {
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.hi - b.lo > 1 && b.pop > best) { best = b.pop; bi = i; }
    }
    if (bi < 0) break;
    const b = boxes[bi];
    const mn = [31, 31, 31], mx = [0, 0, 0];
    for (let j = b.lo; j < b.hi; j++) for (let c = 0; c < 3; c++) {
      const v = chan(keys[j], c);
      if (v < mn[c]) mn[c] = v;
      if (v > mx[c]) mx[c] = v;
    }
    let ch = 0, bestRange = -1;
    for (let c = 0; c < 3; c++) { const r = (mx[c] - mn[c]) * W[c]; if (r > bestRange) { bestRange = r; ch = c; } }
    const sub = keys.slice(b.lo, b.hi).sort((x, y) => chan(x, ch) - chan(y, ch));
    for (let j = 0; j < sub.length; j++) keys[b.lo + j] = sub[j];
    let acc = 0, mid = b.lo + 1;
    const half = b.pop / 2;
    for (let j = b.lo; j < b.hi - 1; j++) { acc += hist[keys[j]]; mid = j + 1; if (acc >= half) break; }
    boxes.splice(bi, 1, { lo: b.lo, hi: mid, pop: acc }, { lo: mid, hi: b.hi, pop: b.pop - acc });
  }
  const pal = new Uint8Array(768);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    let r = 0, g = 0, bl = 0, pop = 0;
    for (let j = b.lo; j < b.hi; j++) {
      const k = keys[j], c = hist[k];
      r += ((k >> 10) & 31) * c; g += ((k >> 5) & 31) * c; bl += (k & 31) * c; pop += c;
    }
    pop = pop || 1;
    pal[i * 3]     = Math.min(255, Math.round(r / pop) * 8 + 4);
    pal[i * 3 + 1] = Math.min(255, Math.round(g / pop) * 8 + 4);
    pal[i * 3 + 2] = Math.min(255, Math.round(bl / pop) * 8 + 4);
  }
  return pal;
}

/** Palette lookup with a lazily-filled 5-5-5 LUT and temporal hysteresis (keeps last frame's index when the pixel barely changed → no sensor-noise flicker, much smaller deltas). */
export class PaletteMapper {
  palette: Bytes = new Uint8Array(768);
  ready = false;
  private lut = new Int16Array(32768).fill(-1);
  /** RMS weighted error of the last map() call, for deciding when the palette has gone stale. */
  lastRms = 0;

  setPalette(p: Bytes) { this.palette = p; this.lut.fill(-1); this.ready = true; }

  private nearest(r: number, g: number, b: number): number {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = this.lut[key];
    if (hit >= 0) return hit;
    const cr = (key >> 10 & 31) * 8 + 4, cg = (key >> 5 & 31) * 8 + 4, cb = (key & 31) * 8 + 4;
    const pal = this.palette;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = pal[i * 3] - cr, dg = pal[i * 3 + 1] - cg, db = pal[i * 3 + 2] - cb;
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    this.lut[key] = best;
    return best;
  }

  map(rgba: ArrayLike<number>, n: number, prev: Bytes | null, hysteresis: number, out: Bytes): Bytes {
    const pal = this.palette;
    let sumSq = 0;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      let idx = -1;
      if (prev) {
        const pi = prev[i], pr = r - pal[pi * 3], pg = g - pal[pi * 3 + 1], pb = b - pal[pi * 3 + 2];
        if (2 * pr * pr + 4 * pg * pg + 3 * pb * pb <= hysteresis) idx = pi;
      }
      if (idx < 0) idx = this.nearest(r, g, b);
      out[i] = idx;
      const er = r - pal[idx * 3], eg = g - pal[idx * 3 + 1], eb = b - pal[idx * 3 + 2];
      sumSq += 2 * er * er + 4 * eg * eg + 3 * eb * eb;
    }
    this.lastRms = Math.sqrt(sumSq / Math.max(1, n));
    return out;
  }
}

// ───────────────────────── varint gap-coded deltas (v2) ─────────────────────────

function buildDeltaV2(curr: ArrayLike<number>, prev: ArrayLike<number>, n: number): Bytes {
  let changed = 0;
  for (let i = 0; i < n; i++) if (curr[i] !== prev[i]) changed++;
  const out = new Uint8Array(5 + changed * 4);
  let p = 0;
  let v = changed;
  while (v >= 128) { out[p++] = (v & 127) | 128; v >>>= 7; }
  out[p++] = v;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (curr[i] === prev[i]) continue;
    let gap = i - last - 1;
    while (gap >= 128) { out[p++] = (gap & 127) | 128; gap >>>= 7; }
    out[p++] = gap;
    out[p++] = curr[i] & 0xff;
    last = i;
  }
  return out.subarray(0, p);
}

/** Returns the new read offset, or -1 if the data is truncated/corrupt. */
function readDeltaV2(data: Bytes, p: number, base: Bytes): number {
  let count = 0, shift = 0, b: number;
  do { if (p >= data.length) return -1; b = data[p++]; count |= (b & 127) << shift; shift += 7; } while (b & 128);
  let last = -1;
  for (let i = 0; i < count; i++) {
    let gap = 0; shift = 0;
    do { if (p >= data.length) return -1; b = data[p++]; gap |= (b & 127) << shift; shift += 7; } while (b & 128);
    if (p >= data.length) return -1;
    const pos = last + 1 + gap;
    if (pos >= base.length) return -1;
    base[pos] = data[p++];
    last = pos;
  }
  return p;
}

export interface EncodeOpts {
  charIndices: Bytes | null;
  w: number;
  h: number;
  charset: string;
  colorIndices: Bytes | null;  // palette-mapped, 0-255
  palette: Bytes | null;       // 256*3 RGB — embedded only when sendPalette is true
  sendPalette: boolean;        // true on first frame / palette rebuild / keyframe requests
  blockColorMode: boolean;     // true = pure color blocks, no char data sent
  prevCharIndices: Bytes | null;
  prevColorIndices: Bytes | null;
  forceKeyframe: boolean;
}

export function encodeFrame(opts: EncodeOpts): ArrayBuffer {
  const { w, h, charset, colorIndices, palette, blockColorMode, prevCharIndices, prevColorIndices, forceKeyframe } = opts;
  const charIndices = opts.charIndices;
  const N = w * h;
  const charsetBytes = blockColorMode ? new Uint8Array(0) : new TextEncoder().encode(charset);
  const bitsPerChar = blockColorMode ? 0 : bitsNeeded(charset.length);

  let charDelta: Bytes | null = null;
  let colorDelta: Bytes | null = null;
  let isKeyframe = forceKeyframe || opts.sendPalette;

  if (!isKeyframe) {
    const needChars = !blockColorMode && !!charIndices;
    const needColor = !!colorIndices;
    if ((needChars && (!prevCharIndices || prevCharIndices.length !== N)) || (needColor && (!prevColorIndices || prevColorIndices.length !== N))) {
      isKeyframe = true;
    } else {
      if (needChars) {
        charDelta = buildDeltaV2(charIndices!, prevCharIndices!, N);
        if (charDelta.length >= Math.ceil(N * bitsPerChar / 8) * 0.85) isKeyframe = true;
      }
      if (needColor && !isKeyframe) {
        colorDelta = buildDeltaV2(colorIndices!, prevColorIndices!, N);
        if (colorDelta.length >= N * 0.85) isKeyframe = true;
      }
    }
  }
  if (isKeyframe) { charDelta = null; colorDelta = null; }

  const embedPalette = !!palette && !!(blockColorMode || colorIndices) && (opts.sendPalette || (isKeyframe && forceKeyframe));
  let flags = FLAG_V2 | (isKeyframe ? FLAG_KEYFRAME : FLAG_DELTA);
  if (blockColorMode) flags |= FLAG_BLOCK_COLOR; else if (colorIndices) flags |= FLAG_ASCII_COLOR;
  if (embedPalette) flags |= FLAG_HAS_PALETTE;

  let charSection: Bytes = new Uint8Array(0);
  if (!blockColorMode && charIndices) charSection = charDelta ?? packBits(charIndices, bitsPerChar);
  const colorSection: Bytes = colorIndices ? (colorDelta ?? colorIndices) : new Uint8Array(0);

  const paletteLen = embedPalette ? palette!.length : 0;
  const total = 6 + charsetBytes.length + charSection.length + (paletteLen ? 2 + paletteLen : 0) + colorSection.length;
  const out = new Uint8Array(total);
  let p = 0;
  out[p++] = flags;
  out[p++] = (w >> 8) & 0xff; out[p++] = w & 0xff;
  out[p++] = (h >> 8) & 0xff; out[p++] = h & 0xff;
  out[p++] = charsetBytes.length;
  out.set(charsetBytes, p); p += charsetBytes.length;
  out.set(charSection, p); p += charSection.length;
  if (paletteLen) {
    out[p++] = (paletteLen >> 8) & 0xff; out[p++] = paletteLen & 0xff;
    out.set(palette!, p); p += paletteLen;
  }
  out.set(colorSection, p);
  return out.buffer;
}

/** Returns null when the frame can't be decoded against `prevFrame` (missing/mismatched base, truncated data) — the caller should request a keyframe. */
export function decode(buffer: ArrayBuffer, prevFrame: RemoteFrame | null): RemoteFrame | null {
  const data: Bytes = new Uint8Array(buffer);
  if (data.length < 6) return null;

  let p = 0;
  const flags        = data[p++];
  const isKeyframe   = (flags & FLAG_KEYFRAME) !== 0;
  const isDelta      = (flags & FLAG_DELTA) !== 0;
  const isBlockColor = (flags & FLAG_BLOCK_COLOR) !== 0;
  const hasPalette   = (flags & FLAG_HAS_PALETTE) !== 0;
  const hasAsciiColor = (flags & FLAG_ASCII_COLOR) !== 0;
  const isV2         = (flags & FLAG_V2) !== 0;

  const w = (data[p++] << 8) | data[p++];
  const h = (data[p++] << 8) | data[p++];
  const N = w * h;
  if (!N || N > 1 << 20) return null;

  const charsetLen = data[p++];
  if (p + charsetLen > data.length) return null;
  const charset = isBlockColor ? "" : new TextDecoder().decode(data.subarray(p, p + charsetLen));
  p += charsetLen;

  const baseOk = !!prevFrame && prevFrame.w === w && prevFrame.h === h;
  if (isDelta && !baseOk) return null;

  let charIndices: Bytes;
  if (isBlockColor) {
    charIndices = baseOk ? prevFrame!.charIndices : new Uint8Array(N);
  } else if (isDelta) {
    charIndices = new Uint8Array(prevFrame!.charIndices);
    if (isV2) { p = readDeltaV2(data, p, charIndices); if (p < 0) return null; }
    else p = readSparseDelta(data, p, charIndices);
  } else {
    const { values, bytesRead } = unpackBits(data, p, N, bitsNeeded(charset.length));
    charIndices = values;
    p += bytesRead;
  }

  let palette: Bytes | null = null;
  if (hasPalette) {
    if (p + 2 > data.length) return null;
    const paletteLen = (data[p] << 8) | data[p + 1];
    p += 2;
    if (paletteLen === 0 || p + paletteLen > data.length) return null;
    palette = new Uint8Array(data.slice(p, p + paletteLen));
    p += paletteLen;
  } else if ((isBlockColor || hasAsciiColor) && prevFrame?.palette) {
    palette = prevFrame.palette;
  }

  let colorIndices: Bytes | null = null;
  if (isBlockColor || hasAsciiColor) {
    if (!palette) return null;
    if (isDelta && isV2) {
      if (!prevFrame!.colorIndices) return null;
      colorIndices = new Uint8Array(prevFrame!.colorIndices);
      if (readDeltaV2(data, p, colorIndices) < 0) return null;
    } else if (isDelta) {
      if (!prevFrame!.colorIndices) return null;
      colorIndices = new Uint8Array(prevFrame!.colorIndices);
      readSparseDelta(data, p, colorIndices);
    } else {
      if (p + N > data.length) return null;
      colorIndices = data.slice(p, p + N);
    }
  }

  return { w, h, charset, charIndices, palette, colorIndices, isKeyframe, isBlockColor, timestamp: performance.now() };
}

export function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  return null;
}
