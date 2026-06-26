export interface PaletteColor {
  r: number;
  g: number;
  b: number;
  id: number;
}

export type PaletteSize = 32 | 64 | 128 | 256 | 512 | 1024;

interface ColorBucket {
  colors: [number, number, number][];
  rMin: number; rMax: number;
  gMin: number; gMax: number;
  bMin: number; bMax: number;
}

function bucketRange(b: ColorBucket): [number, number] {
  const dr = b.rMax - b.rMin;
  const dg = b.gMax - b.gMin;
  const db = b.bMax - b.bMin;
  const max = Math.max(dr, dg, db);
  const ch = max === dr ? 0 : max === dg ? 1 : 2;
  return [ch, max];
}

function makeBucket(colors: [number, number, number][]): ColorBucket {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (const [r, g, b] of colors) {
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
  }
  return { colors, rMin, rMax, gMin, gMax, bMin, bMax };
}

function splitBucket(b: ColorBucket): [ColorBucket, ColorBucket] {
  const [ch] = bucketRange(b);
  const sorted = [...b.colors].sort((a, z) => a[ch] - z[ch]);
  const mid = Math.floor(sorted.length / 2);
  return [makeBucket(sorted.slice(0, mid)), makeBucket(sorted.slice(mid))];
}

function avgBucket(b: ColorBucket): [number, number, number] {
  let r = 0, g = 0, bv = 0;
  for (const [cr, cg, cb] of b.colors) { r += cr; g += cg; bv += cb; }
  const n = b.colors.length || 1;
  return [Math.round(r / n), Math.round(g / n), Math.round(bv / n)];
}

export function medianCutQuantize(
  pixels: Uint8ClampedArray | Uint8Array,
  paletteSize: PaletteSize,
  sampleRate = 4
): PaletteColor[] {
  const colors: [number, number, number][] = [];
  for (let i = 0; i < pixels.length; i += 4 * sampleRate) {
    colors.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  }
  if (!colors.length) return [{ r: 0, g: 0, b: 0, id: 0 }];

  let buckets: ColorBucket[] = [makeBucket(colors)];

  while (buckets.length < paletteSize) {
    let maxRange = -1, splitIdx = 0;
    for (let i = 0; i < buckets.length; i++) {
      const [, range] = bucketRange(buckets[i]);
      if (range > maxRange && buckets[i].colors.length > 1) {
        maxRange = range; splitIdx = i;
      }
    }
    if (maxRange <= 0) break;
    const [a, b] = splitBucket(buckets[splitIdx]);
    buckets.splice(splitIdx, 1, a, b);
  }

  return buckets.map((b, id) => {
    const [r, g, bv] = avgBucket(b);
    return { r, g, b: bv, id };
  });
}

export function buildPaletteLookup(palette: PaletteColor[]): (r: number, g: number, b: number) => number {
  const cache = new Map<number, number>();

  return (r: number, g: number, b: number): number => {
    const key = (r << 16) | (g << 8) | b;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let best = 0, bestDist = Infinity;
    for (const p of palette) {
      const dr = r - p.r, dg = g - p.g, db = b - p.b;
      const dist = dr * dr + dg * dg * 1.5 + db * db * 0.8;
      if (dist < bestDist) { bestDist = dist; best = p.id; }
    }
    if (cache.size < 65536) cache.set(key, best);
    return best;
  };
}

export function serializePalette(palette: PaletteColor[]): Uint8Array {
  const out = new Uint8Array(2 + palette.length * 3);
  out[0] = (palette.length >> 8) & 0xff;
  out[1] = palette.length & 0xff;
  for (let i = 0; i < palette.length; i++) {
    out[2 + i * 3] = palette[i].r;
    out[2 + i * 3 + 1] = palette[i].g;
    out[2 + i * 3 + 2] = palette[i].b;
  }
  return out;
}

export function deserializePalette(data: Uint8Array, offset = 0): { palette: PaletteColor[]; bytesRead: number } {
  const count = (data[offset] << 8) | data[offset + 1];
  const palette: PaletteColor[] = [];
  for (let i = 0; i < count; i++) {
    const base = offset + 2 + i * 3;
    palette.push({ r: data[base], g: data[base + 1], b: data[base + 2], id: i });
  }
  return { palette, bytesRead: 2 + count * 3 };
}
