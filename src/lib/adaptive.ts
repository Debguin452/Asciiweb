/**
 * Adaptive-detail video codec for the call's Color and Pixel modes.
 *
 * The frame is a square-pixel grid cut into 8×8 root blocks. Each root is a quadtree: a block is split into four
 * only where it actually contains detail (edges, eyes, hair…), otherwise it is sent as ONE flat colour. A byte
 * budget decides how fine the splitting gets — flat walls/shirts cost a few bytes, faces get the resolution.
 *
 * Temporal behaviour: the encoder tracks exactly what the receiver has (`recon`). A root block is re-sent only when
 * the source differs from that reconstruction by more than the current detail threshold, so a static scene costs
 * almost nothing, and when bandwidth frees up the threshold drops and blocks refine themselves progressively.
 *
 * Leaf colour formats (chosen per packet, the best one that fits the budget at full detail):
 *   1  RGB888   3 bytes — true colour, used whenever the connection allows it
 *   0  RGB565   2 bytes — used when bytes are tight, with error spreading: each leaf's rounding error is folded into the
 *               next one, so the 8-level steps of 5-bit channels turn into fine alternation (which the receiver's
 *               smoothing then averages out) instead of visible bands. (YCbCr 8-4-4 was tried and measured worse: the
 *               4-bit chroma costs far more picture error than the extra luma precision saves.)
 * Roots remember the format they were last sent in, so they upgrade themselves when the connection improves.
 *
 * Packet:  [0x80 | pixel<<3 | fmt<<1 | key] [w:u16] [h:u16] [root-changed bits] [structLen:u16] [split bits] [leaf colours]
 * The split bits and leaves are in pre-order, roots in raster order. Lossless transport is assumed (reliable data
 * channel); any decode failure makes the receiver ask for a keyframe, which re-sends every root.
 *
 * Receiver: the decoder keeps the exact decoded blocks and shows an edge-preserving smoothed copy, so big flat blocks in
 * gradients (walls, skin) blend into each other while real edges stay sharp. Pixel-art packets skip the smoothing.
 */

export const ADAPTIVE_FLAG = 0x80;

// 8×8 roots; levels: 8, 4, 2, 1
const MAX_LEVEL  = 3;
export const ADAPTIVE_MIN_T = 18;     // ≈ 4 levels of per-channel noise: finer than this just chases sensor noise
export const PIXEL_MIN_T = 4;         // pixel art keeps nearly every cell
const T_MAX = 9000;
const WR = 0.30, WG = 0.55, WB = 0.15; // perceptual channel weights (error is dominated by green, least by blue)

const FMT_565 = 0, FMT_888 = 1;
/** Quantisation error each format leaves behind (weighted, per pixel). Added to the re-send threshold so a freshly sent root isn't re-sent just for its own rounding error. */
const FMT_FLOOR = [12, 1];
const leafBytes = (fmt: number) => (fmt === FMT_888 ? 3 : 2);
const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export interface AdaptiveEncodeOpts { pixel?: boolean; minT?: number }

type Px = Uint8ClampedArray | Uint8Array;

export class AdaptiveEncoder {
  private w = 0;
  private h = 0;
  private haveRecon = false;
  private recon = new Uint8ClampedArray(0);
  private recon32 = new Uint32Array(0);
  private iR = new Float64Array(0); private iG = new Float64Array(0); private iB = new Float64Array(0);
  private qR = new Float64Array(0); private qG = new Float64Array(0); private qB = new Float64Array(0);
  private errs: Float32Array[] = [];
  private bw: number[] = [];
  private rootDiff = new Float32Array(0);
  private rootFmt = new Uint8Array(0);   // format each root was last sent in
  private fmt = FMT_888;                 // format of the packet being built
  private carryR = 0; private carryG = 0; private carryB = 0; // error spreading along leaf order (reset per root)
  private cBits = 0;
  private cLeaves = 0;

  // emission state
  private src: Px = new Uint8Array(0);
  private out = new Uint8Array(0);
  private structPos = 0;   // bit position within the struct area
  private structBase = 0;
  private colorPos = 0;
  private curT = 0;

  /** Forget what the receiver has — the next encode() will be a full keyframe. */
  reset() { this.haveRecon = false; }

  /** Test/debug: what the receiver should currently show (RGBA). */
  get reconstruction(): Uint8ClampedArray { return this.recon; }

  private alloc(w: number, h: number) {
    this.w = w; this.h = h; this.haveRecon = false;
    const s = (w + 1) * (h + 1);
    this.iR = new Float64Array(s); this.iG = new Float64Array(s); this.iB = new Float64Array(s);
    this.qR = new Float64Array(s); this.qG = new Float64Array(s); this.qB = new Float64Array(s);
    this.recon = new Uint8ClampedArray(w * h * 4);
    this.recon32 = new Uint32Array(this.recon.buffer);
    this.bw = []; this.errs = [];
    for (let l = 0; l < MAX_LEVEL; l++) {
      const size = 8 >> l;
      this.bw.push(w / size);
      this.errs.push(new Float32Array((w / size) * (h / size)));
    }
    this.rootDiff = new Float32Array((w >> 3) * (h >> 3));
    this.rootFmt = new Uint8Array((w >> 3) * (h >> 3)).fill(FMT_888);
  }

  private buildIntegrals(src: Px, w: number, h: number) {
    const s1 = w + 1;
    const { iR, iG, iB, qR, qG, qB } = this;
    for (let y = 0; y < h; y++) {
      let rr = 0, rg = 0, rb = 0, sr = 0, sg = 0, sb = 0;
      let p = y * w * 4;
      const up = y * s1, cur = (y + 1) * s1;
      for (let x = 0; x < w; x++, p += 4) {
        const r = src[p], g = src[p + 1], b = src[p + 2];
        rr += r; rg += g; rb += b; sr += r * r; sg += g * g; sb += b * b;
        const i = cur + x + 1, j = up + x + 1;
        iR[i] = iR[j] + rr; iG[i] = iG[j] + rg; iB[i] = iB[j] + rb;
        qR[i] = qR[j] + sr; qG[i] = qG[j] + sg; qB[i] = qB[j] + sb;
      }
    }
  }

  /** Weighted per-pixel variance of the block at pixel (x,y) of the given size. */
  private blockErr(x: number, y: number, size: number): number {
    const s1 = this.w + 1;
    const a = y * s1 + x, b = a + size, c = a + size * s1, d = c + size;
    const n = size * size;
    const sR = this.iR[d] - this.iR[b] - this.iR[c] + this.iR[a];
    const sG = this.iG[d] - this.iG[b] - this.iG[c] + this.iG[a];
    const sB = this.iB[d] - this.iB[b] - this.iB[c] + this.iB[a];
    const tR = this.qR[d] - this.qR[b] - this.qR[c] + this.qR[a];
    const tG = this.qG[d] - this.qG[b] - this.qG[c] + this.qG[a];
    const tB = this.qB[d] - this.qB[b] - this.qB[c] + this.qB[a];
    return (WR * (tR - sR * sR / n) + WG * (tG - sG * sG / n) + WB * (tB - sB * sB / n)) / n;
  }

  private cnt(level: number, bx: number, by: number, T: number) {
    if (level < MAX_LEVEL) {
      this.cBits++;
      if (this.errs[level][by * this.bw[level] + bx] > T) {
        const nx = bx * 2, ny = by * 2, l = level + 1;
        this.cnt(l, nx, ny, T); this.cnt(l, nx + 1, ny, T); this.cnt(l, nx, ny + 1, T); this.cnt(l, nx + 1, ny + 1, T);
        return;
      }
    }
    this.cLeaves++;
  }

  /** Does root r need (re)sending at threshold T in format fmt? */
  private needSend(r: number, key: boolean, T: number, fmt: number): boolean {
    if (key) return true;
    const floor = Math.min(FMT_FLOOR[this.rootFmt[r]], FMT_FLOOR[fmt]); // a root sent in a worse format may upgrade up to the new format's floor
    return this.rootDiff[r] > T * 1.25 + 6 + floor;
  }

  private bytesFor(T: number, key: boolean, rootsX: number, R: number, fmt: number): number {
    this.cBits = 0; this.cLeaves = 0;
    for (let r = 0; r < R; r++) {
      if (this.needSend(r, key, T, fmt)) this.cnt(0, r % rootsX, (r / rootsX) | 0, T);
    }
    return 5 + ((R + 7) >> 3) + 2 + ((this.cBits + 7) >> 3) + leafBytes(fmt) * this.cLeaves;
  }

  private putBit(v: boolean) {
    if (v) this.out[this.structBase + (this.structPos >> 3)] |= 1 << (this.structPos & 7);
    this.structPos++;
  }

  private putLeaf(x: number, y: number, size: number) {
    const w = this.w;
    let r: number, g: number, b: number;
    if (size === 1) {
      const p = (y * w + x) * 4;
      r = this.src[p]; g = this.src[p + 1]; b = this.src[p + 2];
    } else {
      const s1 = w + 1, a = y * s1 + x, bb = a + size, c = a + size * s1, d = c + size, n = size * size;
      r = (this.iR[d] - this.iR[bb] - this.iR[c] + this.iR[a]) / n;
      g = (this.iG[d] - this.iG[bb] - this.iG[c] + this.iG[a]) / n;
      b = (this.iB[d] - this.iB[bb] - this.iB[c] + this.iB[a]) / n;
    }
    let px: number;
    if (this.fmt === FMT_888) {
      const R8 = clamp8((r + 0.5) | 0), G8 = clamp8((g + 0.5) | 0), B8 = clamp8((b + 0.5) | 0);
      this.out[this.colorPos++] = R8; this.out[this.colorPos++] = G8; this.out[this.colorPos++] = B8;
      px = (0xff000000 | (B8 << 16) | (G8 << 8) | R8) >>> 0;
    } else {
      // error spreading: fold the previous leaf's rounding error into this one so banding becomes fine alternation
      const vr = clamp8(r + this.carryR), vg = clamp8(g + this.carryG), vb = clamp8(b + this.carryB);
      const r5 = Math.min(31, (vr * 31 / 255 + 0.5) | 0);
      const g6 = Math.min(63, (vg * 63 / 255 + 0.5) | 0);
      const b5 = Math.min(31, (vb * 31 / 255 + 0.5) | 0);
      const c16 = (r5 << 11) | (g6 << 5) | b5;
      this.out[this.colorPos++] = c16 >> 8;
      this.out[this.colorPos++] = c16 & 0xff;
      const R8 = (r5 << 3) | (r5 >> 2), G8 = (g6 << 2) | (g6 >> 4), B8 = (b5 << 3) | (b5 >> 2);
      px = (0xff000000 | (B8 << 16) | (G8 << 8) | R8) >>> 0;
      const lim = 24;
      this.carryR = Math.max(-lim, Math.min(lim, (vr - R8) * 0.6));
      this.carryG = Math.max(-lim, Math.min(lim, (vg - G8) * 0.6));
      this.carryB = Math.max(-lim, Math.min(lim, (vb - B8) * 0.6));
    }
    // mirror exactly what the decoder will paint
    for (let yy = 0; yy < size; yy++) this.recon32.fill(px, (y + yy) * w + x, (y + yy) * w + x + size);
  }

  private emit(level: number, x: number, y: number) {
    const size = 8 >> level;
    if (level < MAX_LEVEL) {
      const sh = 3 - level;
      const split = this.errs[level][(y >> sh) * this.bw[level] + (x >> sh)] > this.curT;
      this.putBit(split);
      if (split) {
        const half = size >> 1;
        this.emit(level + 1, x, y); this.emit(level + 1, x + half, y);
        this.emit(level + 1, x, y + half); this.emit(level + 1, x + half, y + half);
        return;
      }
    }
    this.putLeaf(x, y, size);
  }

  /**
   * @param src RGBA pixels, w×h (both multiples of 8)
   * @param budget target packet size in bytes (never exceeded unless even the coarsest picture is larger)
   */
  encode(src: Px, w: number, h: number, budget: number, keyframe: boolean, opts: AdaptiveEncodeOpts = {}): ArrayBuffer {
    if (w < 8 || h < 8 || (w & 7) || (h & 7) || w > 65535 || h > 65535) throw new Error("adaptive: bad size");
    if (w !== this.w || h !== this.h) this.alloc(w, h);
    const key = keyframe || !this.haveRecon;
    this.src = src;
    this.buildIntegrals(src, w, h);
    for (let l = 0; l < MAX_LEVEL; l++) {
      const size = 8 >> l, bw = w / size, bh = h / size, arr = this.errs[l];
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) arr[by * bw + bx] = this.blockErr(bx * size, by * size, size);
    }

    const rootsX = w >> 3, rootsY = h >> 3, R = rootsX * rootsY;
    if (!key) {
      const rc = this.recon;
      for (let ry = 0; ry < rootsY; ry++) for (let rx = 0; rx < rootsX; rx++) {
        let sum = 0;
        for (let yy = 0; yy < 8; yy++) {
          let p = ((ry * 8 + yy) * w + rx * 8) * 4;
          for (let xx = 0; xx < 8; xx++, p += 4) {
            const dr = src[p] - rc[p], dg = src[p + 1] - rc[p + 1], db = src[p + 2] - rc[p + 2];
            sum += WR * dr * dr + WG * dg * dg + WB * db * db;
          }
        }
        this.rootDiff[ry * rootsX + rx] = sum / 64;
      }
    }

    // True colour whenever the finest detail still fits the budget; otherwise RGB565 and shed detail instead.
    const minT = opts.minT ?? (opts.pixel ? PIXEL_MIN_T : ADAPTIVE_MIN_T);
    let fmt = FMT_888, T = minT;
    if (this.bytesFor(T, key, rootsX, R, fmt) > budget) {
      fmt = FMT_565;
      if (this.bytesFor(T, key, rootsX, R, fmt) > budget) {
        let lo = minT, hi = T_MAX;
        for (let i = 0; i < 9; i++) {
          const mid = Math.sqrt(lo * hi);
          if (this.bytesFor(mid, key, rootsX, R, fmt) <= budget) hi = mid; else lo = mid;
        }
        T = hi;
      }
    }
    const total = this.bytesFor(T, key, rootsX, R, fmt); // also leaves cBits/cLeaves for (T, fmt)
    this.curT = T; this.fmt = fmt;

    const skipBytes = (R + 7) >> 3, structBytes = (this.cBits + 7) >> 3;
    const out = new Uint8Array(total);
    this.out = out;
    out[0] = ADAPTIVE_FLAG | (opts.pixel ? 8 : 0) | (fmt << 1) | (key ? 1 : 0);
    out[1] = w >> 8; out[2] = w & 255; out[3] = h >> 8; out[4] = h & 255;
    const skipBase = 5;
    out[skipBase + skipBytes] = structBytes >> 8; out[skipBase + skipBytes + 1] = structBytes & 255;
    this.structBase = skipBase + skipBytes + 2;
    this.structPos = 0;
    this.colorPos = this.structBase + structBytes;

    for (let r = 0; r < R; r++) {
      if (this.needSend(r, key, T, fmt)) {
        out[skipBase + (r >> 3)] |= 1 << (r & 7);
        this.carryR = this.carryG = this.carryB = 0;
        this.rootFmt[r] = fmt;
        this.emit(0, (r % rootsX) * 8, ((r / rootsX) | 0) * 8);
      }
    }
    this.haveRecon = true;
    return out.buffer;
  }
}

// Smoothing taps per leaf size: big flat blocks look across their borders, detailed leaves barely at all.
const TAPS: Record<number, { off: number[]; reach: number }> = {
  8: { off: [-6, -3, 0, 3, 6], reach: 6 },
  4: { off: [-2, 0, 2], reach: 2 },
  2: { off: [-1, 0, 1], reach: 1 },
};
const SMOOTH_TAU = 36; // colour distance at which a neighbour stops contributing (edges survive)

export class AdaptiveDecoder {
  private w = 0;
  private h = 0;
  private have = false;
  private fmt = FMT_888;
  private pixel = false;
  private buf = new Uint8ClampedArray(0);      // exact decoded blocks
  private buf32 = new Uint32Array(0);
  private view = new Uint8ClampedArray(0);     // edge-smoothed copy for display
  private view32 = new Uint32Array(0);
  private sizes = new Uint8Array(0);           // leaf size at each pixel
  private dirty = new Uint8Array(0);           // roots whose smoothed pixels must be recomputed
  private raw: ImageData | null = null;
  private smooth: ImageData | null = null;
  /** Whether the last packet was a pixel-art packet (shown unsmoothed with hard pixel edges). */
  lastPixelated = false;
  // parse state
  private d: Uint8Array = new Uint8Array(0);
  private bitPos = 0;
  private bitEnd = 0;
  private structBase = 0;
  private cp = 0;
  private bad = false;

  reset() { this.have = false; }

  private node(level: number, x: number, y: number) {
    if (this.bad) return;
    const size = 8 >> level;
    if (level < MAX_LEVEL) {
      if (this.bitPos >= this.bitEnd) { this.bad = true; return; }
      const split = (this.d[this.structBase + (this.bitPos >> 3)] >> (this.bitPos & 7)) & 1;
      this.bitPos++;
      if (split) {
        const half = size >> 1;
        this.node(level + 1, x, y); this.node(level + 1, x + half, y);
        this.node(level + 1, x, y + half); this.node(level + 1, x + half, y + half);
        return;
      }
    }
    let px: number;
    if (this.fmt === FMT_888) {
      if (this.cp + 3 > this.d.length) { this.bad = true; return; }
      px = (0xff000000 | (this.d[this.cp + 2] << 16) | (this.d[this.cp + 1] << 8) | this.d[this.cp]) >>> 0;
      this.cp += 3;
    } else {
      if (this.cp + 2 > this.d.length) { this.bad = true; return; }
      const c = (this.d[this.cp] << 8) | this.d[this.cp + 1];
      this.cp += 2;
      const r5 = c >> 11, g6 = (c >> 5) & 63, b5 = c & 31;
      px = (0xff000000 | (((b5 << 3) | (b5 >> 2)) << 16) | (((g6 << 2) | (g6 >> 4)) << 8) | ((r5 << 3) | (r5 >> 2))) >>> 0;
    }
    const w = this.w;
    for (let yy = 0; yy < size; yy++) {
      const o = (y + yy) * w + x;
      this.buf32.fill(px, o, o + size);
      this.sizes.fill(size, o, o + size);
    }
  }

  /** Edge-preserving blur of one root's pixels (reads only exact blocks, writes only the display copy). */
  private smoothRoot(rx: number, ry: number) {
    const { w, h, buf, view32, buf32, sizes } = this;
    const x0 = rx << 3, y0 = ry << 3;
    for (let y = y0; y < y0 + 8; y++) {
      for (let x = x0; x < x0 + 8; x++) {
        const o = y * w + x, size = sizes[o];
        const t = size >= 2 ? TAPS[size] : undefined;
        if (!t) { view32[o] = buf32[o]; continue; }
        const p = o * 4, cr = buf[p], cg = buf[p + 1], cb = buf[p + 2];
        let sr = cr, sg = cg, sb = cb, sw = 1;
        const reach1 = t.reach + 1;
        for (const dy of t.off) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (const dx of t.off) {
            if ((dx | dy) === 0) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = (yy * w + xx) * 4;
            const d = WR * Math.abs(buf[q] - cr) + WG * Math.abs(buf[q + 1] - cg) + WB * Math.abs(buf[q + 2] - cb);
            if (d >= SMOOTH_TAU) continue;
            const wt = (1 - Math.max(Math.abs(dx), Math.abs(dy)) / reach1) * (1 - d / SMOOTH_TAU);
            sr += buf[q] * wt; sg += buf[q + 1] * wt; sb += buf[q + 2] * wt; sw += wt;
          }
        }
        view32[o] = (0xff000000 | (((sb / sw + 0.5) | 0) << 16) | (((sg / sw + 0.5) | 0) << 8) | ((sr / sw + 0.5) | 0)) >>> 0;
      }
    }
  }

  /** Applies one packet; returns the (shared, always up-to-date) image, or null if it can't be applied (→ ask for a keyframe). */
  decode(d: Uint8Array): ImageData | null {
    if (d.length < 7 || !(d[0] & ADAPTIVE_FLAG)) return null;
    const key = (d[0] & 1) === 1;
    const fmt = (d[0] >> 1) & 3;
    const pixel = (d[0] & 8) !== 0;
    if (fmt > FMT_888) return null; // unknown future format
    const w = (d[1] << 8) | d[2], h = (d[3] << 8) | d[4];
    if (w < 8 || h < 8 || (w & 7) || (h & 7) || w * h > 1 << 20) return null;
    if (!key && (!this.have || w !== this.w || h !== this.h || pixel !== this.pixel)) return null;

    if (w !== this.w || h !== this.h || !this.raw) {
      this.w = w; this.h = h;
      this.buf = new Uint8ClampedArray(w * h * 4);
      this.buf32 = new Uint32Array(this.buf.buffer);
      this.buf32.fill(0xff000000);
      this.view = new Uint8ClampedArray(w * h * 4);
      this.view32 = new Uint32Array(this.view.buffer);
      this.view32.fill(0xff000000);
      this.sizes = new Uint8Array(w * h).fill(8);
      this.dirty = new Uint8Array((w >> 3) * (h >> 3));
      this.raw = new ImageData(this.buf, w, h);
      this.smooth = new ImageData(this.view, w, h);
    }
    this.pixel = pixel;
    this.fmt = fmt;

    const rootsX = w >> 3, rootsY = h >> 3, R = rootsX * rootsY;
    const skipBytes = (R + 7) >> 3;
    const lenPos = 5 + skipBytes;
    if (lenPos + 2 > d.length) return null;
    const structBytes = (d[lenPos] << 8) | d[lenPos + 1];
    this.d = d;
    this.structBase = lenPos + 2;
    this.bitPos = 0; this.bitEnd = structBytes * 8;
    this.cp = this.structBase + structBytes;
    this.bad = this.cp > d.length;

    const dirty = this.dirty;
    dirty.fill(0);
    for (let r = 0; r < R && !this.bad; r++) {
      if ((d[5 + (r >> 3)] >> (r & 7)) & 1) {
        const rx = r % rootsX, ry = (r / rootsX) | 0;
        this.node(0, rx * 8, ry * 8);
        for (let yy = Math.max(0, ry - 1); yy <= Math.min(rootsY - 1, ry + 1); yy++)
          for (let xx = Math.max(0, rx - 1); xx <= Math.min(rootsX - 1, rx + 1); xx++) dirty[yy * rootsX + xx] = 1;
      }
    }
    if (this.bad) { this.have = false; return null; }
    if (key) this.have = true;

    this.lastPixelated = pixel;
    if (pixel) return this.raw; // hard-edged pixel art: show the exact cells
    for (let r = 0; r < R; r++) if (dirty[r]) this.smoothRoot(r % rootsX, (r / rootsX) | 0);
    return this.smooth;
  }
}
