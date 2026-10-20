/**
 * Low-light assist for the call's Color / Pixel capture.
 *
 * In a dim room camera sensor noise flickers every pixel from frame to frame. The video codec then spends bytes
 * refreshing noise (and drops quality steps because of it). This averages each pixel with its previous value — but only
 * (a) when the measured noise says it is worth it and (b) only where the pixel hasn't really moved, so good light costs
 * nothing and moving faces don't smear.
 *
 * Noise is measured as the MEDIAN frame-to-frame difference: motion only affects the upper part of the distribution, so
 * the median stays a clean noise reading even while someone is waving a hand.
 */

const ON_BELOW = 3.2;   // median diff under this = clean picture: filter fully off
const FULL_AT  = 6.5;   // …and fully on from here up
const BINS = 64, BIN_W = 0.25; // histogram of weighted diffs, 0..16

export class LowLightAssist {
  private w = 0; private h = 0;
  private prevRaw = new Uint8ClampedArray(0);   // last raw (unfiltered) frame, for the noise estimate
  private acc = new Float32Array(0);            // running temporal average (the filtered picture)
  private hist = new Uint32Array(BINS);
  private noise = 0;                            // smoothed median diff
  private have = false;
  /** 0 (off) … 1 (full strength) — exposed for UI/debug. */
  strength = 0;

  reset() { this.have = false; this.noise = 0; this.strength = 0; }

  /** Filters `rgba` (w×h) in place. */
  process(rgba: Uint8ClampedArray, w: number, h: number) {
    const n = w * h;
    if (w !== this.w || h !== this.h || !this.have) {
      this.w = w; this.h = h;
      this.prevRaw = new Uint8ClampedArray(rgba);
      this.acc = new Float32Array(n * 4);
      for (let i = 0; i < n * 4; i++) this.acc[i] = rgba[i];
      this.hist.fill(0); this.have = true; this.noise = 0; this.strength = 0;
      return;
    }

    const s = this.strength;                       // decided from previous frames
    const active = s > 0.02;
    const aMin = 1 - 0.8 * s;                      // blend weight for a perfectly still pixel (0.2 at full strength)
    const lo = 1.2 * this.noise + 1, hi = 3 * this.noise + 5; // below lo = noise, above hi = real motion
    const prev = this.prevRaw, acc = this.acc, hist = this.hist;
    hist.fill(0);
    const stride = active ? 1 : 3;                 // when idle, a sparse sample is enough to notice the room getting dark

    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      const d = 0.3 * Math.abs(r - prev[p]) + 0.55 * Math.abs(g - prev[p + 1]) + 0.15 * Math.abs(b - prev[p + 2]);
      if (i % stride === 0) { const bi = (d / BIN_W) | 0; hist[bi < BINS ? bi : BINS - 1]++; }
      prev[p] = r; prev[p + 1] = g; prev[p + 2] = b;
      if (active) {
        const a = d <= lo ? aMin : d >= hi ? 1 : aMin + (1 - aMin) * (d - lo) / (hi - lo);
        acc[p]     += a * (r - acc[p]);
        acc[p + 1] += a * (g - acc[p + 1]);
        acc[p + 2] += a * (b - acc[p + 2]);
        rgba[p] = acc[p] + 0.5; rgba[p + 1] = acc[p + 1] + 0.5; rgba[p + 2] = acc[p + 2] + 0.5;
      } else { acc[p] = r; acc[p + 1] = g; acc[p + 2] = b; } // keep the average in step so switching on is seamless
    }

    // median of this frame's diffs → noise reading
    let total = 0; for (let k = 0; k < BINS; k++) total += hist[k];
    let cum = 0, med = BINS - 1;
    for (let k = 0; k < BINS; k++) { cum += hist[k]; if (cum * 2 >= total) { med = k; break; } }
    const m = (med + 0.5) * BIN_W;
    this.noise += (m - this.noise) * 0.1;
    const t = (this.noise - ON_BELOW) / (FULL_AT - ON_BELOW);
    const target = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    this.strength += (target - this.strength) * 0.15; // fade in/out instead of popping
  }
}
