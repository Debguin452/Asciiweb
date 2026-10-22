const SHARPEN = 0.85;
const HALO_LIMIT = 28;
const CONTRAST = 1.15;
const SATURATION = 1.15;
const NOISE_FLOOR = 4; // luma units (0-255); |unsharp diff| below this is treated as noise, not a real edge

const contrastLut = new Uint8ClampedArray(256);
for (let i = 0; i < 256; i++) contrastLut[i] = (i - 128) * CONTRAST + 128;

// Fixed-point saturation multiplier (>>12 = /4096) — avoids a float multiply on all 3 channels of every pixel. Contrast is
// already a linear map (ax+b), so applying it to the per-pixel luminance (contrastLut[luma[i]]) gives the same gray point
// as re-deriving it from the three already-contrasted channels, without the second weighted-sum multiply-add.
const SAT_FP = Math.round(SATURATION * 4096);

let luma = new Uint8ClampedArray(0);
let out: ImageData | null = null;

export function enhance(src: Uint8ClampedArray, w: number, h: number): ImageData | null {
  if (w <= 0 || h <= 0 || src.length < w * h * 4) return null; // checked once, not discovered via a thrown exception
  try { return run(src, w, h); } catch { return null; } // still a defensive net for anything truly unexpected
}

/** Contrast + saturation only, no sharpening — used for the border pixels (no full 3x3 neighborhood) and non-sharpened rows. */
function writePixel(src: Uint8ClampedArray, dst: Uint8ClampedArray, lumaArr: Uint8ClampedArray, rowBase: number, x: number) {
  const i = rowBase + x, p = i * 4;
  const r = contrastLut[src[p]], g = contrastLut[src[p + 1]], bl = contrastLut[src[p + 2]];
  const gray = contrastLut[lumaArr[i]];
  dst[p]     = gray + (((r - gray) * SAT_FP) >> 12);
  dst[p + 1] = gray + (((g - gray) * SAT_FP) >> 12);
  dst[p + 2] = gray + (((bl - gray) * SAT_FP) >> 12);
  dst[p + 3] = 255;
}

function writeFlatRow(src: Uint8ClampedArray, dst: Uint8ClampedArray, lumaArr: Uint8ClampedArray, y: number, w: number) {
  const rowBase = y * w;
  for (let x = 0; x < w; x++) writePixel(src, dst, lumaArr, rowBase, x);
}

function run(src: Uint8ClampedArray, w: number, h: number): ImageData {
  const n = w * h;
  if (!out || out.width !== w || out.height !== h) out = new ImageData(w, h);
  if (luma.length !== n) luma = new Uint8ClampedArray(n);
  const dst = out.data;

  for (let i = 0, p = 0; i < n; i++, p += 4) luma[i] = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;

  // Top/bottom rows have no 3x3 neighborhood — skip the sharpen branch entirely instead of re-checking it per pixel.
  writeFlatRow(src, dst, luma, 0, w);
  if (h > 1) writeFlatRow(src, dst, luma, h - 1, w);

  for (let y = 1; y < h - 1; y++) {
    const rowBase = y * w;
    writePixel(src, dst, luma, rowBase, 0); // left border column: no horizontal neighbor either

    for (let x = 1; x < w - 1; x++) {
      const i = rowBase + x, p = i * 4;
      const a = i - w, b = i + w;
      const blur = (luma[a - 1] + 2 * luma[a] + luma[a + 1] + 2 * luma[i - 1] + 4 * luma[i] + 2 * luma[i + 1] + luma[b - 1] + 2 * luma[b] + luma[b + 1]) >> 4;
      const diff = luma[i] - blur;
      const ad = diff < 0 ? -diff : diff;
      // Soft noise gate: full sharpening once the local edge is clearly above the noise floor; below it, the contribution
      // falls off quadratically (not a hard cutoff, which would show as a visible threshold) rather than passing sensor
      // noise straight through at full SHARPEN strength the way a plain unsharp mask does.
      const gate = ad >= NOISE_FLOOR ? 1 : (ad * ad) / (NOISE_FLOOR * NOISE_FLOOR);
      let d = diff * SHARPEN * gate;
      d = d > HALO_LIMIT ? HALO_LIMIT : d < -HALO_LIMIT ? -HALO_LIMIT : d;

      const r = contrastLut[src[p]], g = contrastLut[src[p + 1]], bl = contrastLut[src[p + 2]];
      const gray = contrastLut[luma[i]];
      dst[p]     = gray + (((r - gray) * SAT_FP) >> 12) + d;
      dst[p + 1] = gray + (((g - gray) * SAT_FP) >> 12) + d;
      dst[p + 2] = gray + (((bl - gray) * SAT_FP) >> 12) + d;
      dst[p + 3] = 255;
    }

    writePixel(src, dst, luma, rowBase, w - 1); // right border column
  }
  return out;
}
