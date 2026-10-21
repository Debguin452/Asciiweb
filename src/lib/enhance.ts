const SHARPEN = 0.7;
const HALO_LIMIT = 28;
const CONTRAST = 1.08;
const SATURATION = 1.15;

const contrastLut = new Uint8ClampedArray(256);
for (let i = 0; i < 256; i++) contrastLut[i] = (i - 128) * CONTRAST + 128;

let luma = new Uint8ClampedArray(0);
let out: ImageData | null = null;

export function enhance(src: Uint8ClampedArray, w: number, h: number): ImageData {
  const n = w * h;
  if (!out || out.width !== w || out.height !== h) out = new ImageData(w, h);
  if (luma.length !== n) luma = new Uint8ClampedArray(n);
  const dst = out.data;

  for (let i = 0, p = 0; i < n; i++, p += 4) luma[i] = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;

  for (let y = 0; y < h; y++) {
    const innerRow = y > 0 && y < h - 1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      let d = 0;
      if (innerRow && x > 0 && x < w - 1) {
        const a = i - w, b = i + w;
        const blur = (luma[a - 1] + 2 * luma[a] + luma[a + 1] + 2 * luma[i - 1] + 4 * luma[i] + 2 * luma[i + 1] + luma[b - 1] + 2 * luma[b] + luma[b + 1]) >> 4;
        d = (luma[i] - blur) * SHARPEN;
        d = d > HALO_LIMIT ? HALO_LIMIT : d < -HALO_LIMIT ? -HALO_LIMIT : d;
      }
      const r = contrastLut[src[p]], g = contrastLut[src[p + 1]], bl = contrastLut[src[p + 2]];
      const gray = (r * 77 + g * 150 + bl * 29) >> 8;
      dst[p] = gray + (r - gray) * SATURATION + d;
      dst[p + 1] = gray + (g - gray) * SATURATION + d;
      dst[p + 2] = gray + (bl - gray) * SATURATION + d;
      dst[p + 3] = 255;
    }
  }
  return out;
}
