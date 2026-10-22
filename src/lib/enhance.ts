// Receiver-side sharpen/contrast/saturation for the Color/Pixel call modes (see CallTab.tsx's paintCanvas). Tuned to stay
// cheap enough to run every frame on a phone CPU.
//
// Priority 1 pass:
//   1/5/6: one luminance pass, reused for both sharpening AND the contrast/saturation gray point (no second reweighted sum)
//   2:     luma + out buffers are module-level and reused across calls, resized only when the frame's dimensions change
//   3:     contrast and saturation are both precomputed (a LUT, and a fixed-point multiplier) instead of recomputed per pixel
//   4/9/10: the unsharp-mask diff doubles as a noise gate — below NOISE_FLOOR it falls off quadratically instead of
//           linearly, so sensor noise in flat regions isn't amplified the same as a real edge is
//   7:     same exported signature and default look as before — this is strictly a faster execution of the same effect
//   8:     dimensions are checked once up front, not discovered via a thrown exception on the hot path
//
// Priority 2 pass (items 11/12/13/16):
//   11: contrast now adapts to the frame's own luminance variance — a low-contrast scene (small stddev) gets pushed
//       toward CONTRAST_MAX, an already-contrasty scene gets pulled back toward CONTRAST_MIN, computed from sum/sumSq
//       accumulated in the SAME luminance pass above (no extra traversal).
//   12: an optional mild gamma can be folded into the same LUT (ENABLE_GAMMA toggle) — off by default since the existing
//       look was tuned without it; left wired up and bench-verified so it's a one-line flip if wanted later.
//   13: gamma + contrast are combined into ONE 256-entry LUT, rebuilt only when the smoothed contrast actually drifted
//       past LUT_EPS — not every frame, so the "precomputed" benefit from Priority 1 is preserved.
//   16: the contrast target is EMA-smoothed frame to frame (same x += (target-x)*alpha idiom as governor.ts/denoise.ts)
//       so panning across a scene with a different luminance spread doesn't visibly snap the contrast, only drift it.
//
// Item 15 (skip the enhancement pass entirely on a near-static frame) was prototyped and bench-tested but NOT shipped:
// with realistic per-pixel sensor noise the skip essentially never triggers (the frame-to-frame luma diff rarely drops
// below a safe threshold), so the extra diff bookkeeping it needs was pure overhead with no payoff — confirmed slower
// than the baseline at 320x180 and 480x270 in testing. Revisit only with real device/camera measurements, not synthetic
// frames. Item 14 (pre-quantization edge preservation) is sender-side (binary.ts's ColorQuantizer, runs on every outgoing
// frame on every call) and is deliberately left for the Priority 3 transmission-pipeline pass rather than bundled in here.

const SHARPEN = 0.85;
const HALO_LIMIT = 28;
const SATURATION = 1.2;
const NOISE_FLOOR = 4; // luma units (0-255); |unsharp diff| below this is treated as noise, not a real edge

// Fixed-point saturation multiplier (>>12 = /4096) — avoids a float multiply on all 3 channels of every pixel. Contrast
// (and gamma, when enabled) are already folded into a single LUT applied to luma, so the same gray point works whether
// or not gamma is on, without a second weighted-sum multiply-add.
const SAT_FP = Math.round(SATURATION * 4096);

// Adaptive contrast (item 11): contrastTarget = CONTRAST_BASE * (REF_STD / frameStdDev), clamped to [MIN, MAX]. A flat,
// low-contrast frame (small stddev) pushes the ratio above 1, boosting contrast toward CONTRAST_MAX; an already-punchy
// frame pulls it back toward CONTRAST_MIN. REF_STD is a "typical" webcam-scene luma stddev, not derived from any one
// capture — the clamp keeps the effect subtle regardless.
const CONTRAST_BASE = 1.15;
const CONTRAST_MIN = 1.05;
const CONTRAST_MAX = 1.25;
const REF_STD = 50;
const CONTRAST_ALPHA = 0.06; // EMA smoothing (item 16) — ~1-2s to settle at 30fps, same idiom as governor.ts/denoise.ts
const LUT_EPS = 0.01; // only rebuild the LUT once the smoothed contrast actually drifted this far

const ENABLE_GAMMA = false; // off by default — the shipped look was tuned without it; flip on if a gamma lift is wanted
const GAMMA = 0.92;

let combinedLut = new Uint8ClampedArray(256);
let smoothedContrast = CONTRAST_BASE;
let lutContrast = NaN; // NaN forces a build on the very first frame
let haveContrast = false;

function buildLut(contrast: number) {
  for (let i = 0; i < 256; i++) {
    const v = ENABLE_GAMMA ? Math.pow(i / 255, GAMMA) * 255 : i;
    combinedLut[i] = (v - 128) * contrast + 128;
  }
  lutContrast = contrast;
}

let luma = new Uint8ClampedArray(0);
let out: ImageData | null = null;

export function enhance(src: Uint8ClampedArray, w: number, h: number): ImageData | null {
  if (w <= 0 || h <= 0 || src.length < w * h * 4) return null; // checked once, not discovered via a thrown exception
  try { return run(src, w, h); } catch { return null; } // still a defensive net for anything truly unexpected
}

/** Contrast + saturation only, no sharpening — used for the border pixels (no full 3x3 neighborhood) and non-sharpened rows. */
function writePixel(src: Uint8ClampedArray, dst: Uint8ClampedArray, lumaArr: Uint8ClampedArray, rowBase: number, x: number) {
  const i = rowBase + x, p = i * 4;
  const r = combinedLut[src[p]], g = combinedLut[src[p + 1]], bl = combinedLut[src[p + 2]];
  const gray = combinedLut[lumaArr[i]];
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

  // Single luminance pass — also accumulates sum/sumSq for the adaptive-contrast variance estimate (item 11), so this
  // doesn't cost a second traversal over the frame.
  let sum = 0, sumSq = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const l = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
    luma[i] = l;
    sum += l; sumSq += l * l;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const stdDev = Math.sqrt(variance);
  const ratio = Math.min(1.3, Math.max(0.9, REF_STD / Math.max(stdDev, 1)));
  const contrastTarget = Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, CONTRAST_BASE * ratio));
  if (!haveContrast) { smoothedContrast = contrastTarget; haveContrast = true; } // first frame: jump straight there
  else smoothedContrast += (contrastTarget - smoothedContrast) * CONTRAST_ALPHA;
  if (!Number.isFinite(lutContrast) || Math.abs(smoothedContrast - lutContrast) > LUT_EPS) buildLut(smoothedContrast);

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

      const r = combinedLut[src[p]], g = combinedLut[src[p + 1]], bl = combinedLut[src[p + 2]];
      const gray = combinedLut[luma[i]];
      dst[p]     = gray + (((r - gray) * SAT_FP) >> 12) + d;
      dst[p + 1] = gray + (((g - gray) * SAT_FP) >> 12) + d;
      dst[p + 2] = gray + (((bl - gray) * SAT_FP) >> 12) + d;
      dst[p + 3] = 255;
    }

    writePixel(src, dst, luma, rowBase, w - 1); // right border column
  }
  return out;
}
