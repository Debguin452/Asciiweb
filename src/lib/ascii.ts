import { initWasm, getWasmModule, isWasmAvailable } from './wasm-wrapper';

export const DEFAULT_CHARSET = " .:-=+*#%@";

export interface AsciiOptions {
  asciiW: number;
  asciiH: number;
  brightness: number;
  contrast: number;
  threshold: number;
  gamma: number;
  invert: boolean;
  color: boolean;
  edges: boolean;
  gradientDirs: boolean;
  dither: boolean;
  ditherMode: "floyd" | "bayer";
  noiseReduction: boolean;
  localContrast: boolean;
  histEq: boolean;
  charset: string;
  brailleMode: boolean;
  blockMode: boolean;
  temporalSmoothing: boolean;
  charDensitySort: boolean;
}

export const DEFAULT_OPTIONS: AsciiOptions = {
  asciiW: 140, asciiH: 80, brightness: 0, contrast: 120, threshold: 0, gamma: 1.0,
  invert: false, color: false, edges: false, gradientDirs: false, dither: false,
  ditherMode: "floyd", noiseReduction: false, localContrast: false, histEq: false,
  charset: DEFAULT_CHARSET, brailleMode: false, blockMode: false,
  temporalSmoothing: false, charDensitySort: true,
};

export interface AsciiCell { char: string; charIdx: number; r: number; g: number; b: number; }
export type AsciiFrame = AsciiCell[][];
export type AsciiSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

function clamp(v: number, lo = 0, hi = 255): number { return v < lo ? lo : v > hi ? hi : v; }

function getSourceDimensions(source: AsciiSource): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight };
  if (source instanceof HTMLCanvasElement) return { w: source.width, h: source.height };
  return { w: source.naturalWidth, h: source.naturalHeight };
}

class ScratchPool {
  n = 0;
  gray = new Float32Array(0); grayB = new Float32Array(0); grayC = new Float32Array(0);
  mag = new Float32Array(0); dir = new Float32Array(0);
  r = new Uint8Array(0); g = new Uint8Array(0); b = new Uint8Array(0);
  charIdx = new Uint16Array(0);
  hist = new Uint32Array(256); cdf = new Float32Array(256);
  smoothed: Float32Array | null = null;
  lastW = 0; lastH = 0;

  ensure(n: number) {
    if (this.n === n) return;
    this.n = n;
    this.gray = new Float32Array(n); this.grayB = new Float32Array(n);
    this.grayC = new Float32Array(n); this.mag = new Float32Array(n);
    this.dir = new Float32Array(n); this.r = new Uint8Array(n);
    this.g = new Uint8Array(n); this.b = new Uint8Array(n);
    this.charIdx = new Uint16Array(n);
    this.smoothed = null;
  }
}

const pool = new ScratchPool();
export function resetTemporalSmoothing(): void { pool.smoothed = null; }
export function getPoolCharIdx(): Uint16Array { return pool.charIdx; }
export function getPoolColors(): { r: Uint8Array; g: Uint8Array; b: Uint8Array } { return { r: pool.r, g: pool.g, b: pool.b }; }
export function getPoolDims(): { w: number; h: number } { return { w: pool.lastW, h: pool.lastH }; }

function gaussianBlur3(src: Float32Array, dst: Float32Array, w: number, h: number) {
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0, y1 = y, y2 = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0, x1 = x, x2 = x < w - 1 ? x + 1 : w - 1;
      dst[y * w + x] = (src[y0 * w + x0] + src[y0 * w + x1] * 2 + src[y0 * w + x2] + src[y1 * w + x0] * 2 + src[y1 * w + x1] * 4 + src[y1 * w + x2] * 2 + src[y2 * w + x0] + src[y2 * w + x1] * 2 + src[y2 * w + x2]) / 16;
    }
  }
}

function sobelEdges(gray: Float32Array, w: number, h: number) {
  const mag = pool.mag, dir = pool.dir;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[(y - 1) * w + (x - 1)] + gray[(y - 1) * w + (x + 1)] - 2 * gray[y * w + (x - 1)] + 2 * gray[y * w + (x + 1)] - gray[(y + 1) * w + (x - 1)] + gray[(y + 1) * w + (x + 1)];
      const gy = -gray[(y - 1) * w + (x - 1)] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + (x + 1)] + gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + (x + 1)];
      mag[i] = Math.sqrt(gx * gx + gy * gy);
      dir[i] = Math.atan2(gy, gx);
    }
  }
}

function floydSteinberg(buf: Float32Array, w: number, h: number, levels: number) {
  const step = 255 / (levels - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i];
      const nw = Math.round(old / step) * step;
      buf[i] = nw;
      const err = old - nw;
      if (x + 1 < w) buf[i + 1] += err * 0.4375;
      const nrow = (y + 1) * w;
      if (y + 1 < h) {
        if (x > 0) buf[nrow + x - 1] += err * 0.1875;
        buf[nrow + x] += err * 0.3125;
        if (x + 1 < w) buf[nrow + x + 1] += err * 0.0625;
      }
    }
  }
}

function histogramEqualize(buf: Float32Array, n: number) {
  const hist = pool.hist, cdf = pool.cdf;
  hist.fill(0);
  for (let i = 0; i < n; i++) hist[clamp(Math.round(buf[i]))]++;
  cdf[0] = hist[0];
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
  let cdfMin = 0;
  for (let i = 0; i < 256; i++) if (cdf[i] > 0) { cdfMin = cdf[i]; break; }
  const denom = n - cdfMin || 1;
  for (let i = 0; i < n; i++) buf[i] = ((cdf[clamp(Math.round(buf[i]))] - cdfMin) / denom) * 255;
}

const densityCache = new Map<string, string>();
export function sortCharsetByDensity(charset: string): string {
  if (densityCache.has(charset)) return densityCache.get(charset)!;
  try {
    const canvas = document.createElement("canvas"); canvas.width = 10; canvas.height = 14;
    const ctx = canvas.getContext("2d")!; ctx.font = "10px monospace"; ctx.fillStyle = "white";
    const measured = Array.from(new Set(charset)).map(ch => {
      ctx.clearRect(0, 0, 10, 14); ctx.fillText(ch, 0, 11);
      const data = ctx.getImageData(0, 0, 10, 14).data;
      let sum = 0; for (let i = 0; i < data.length; i += 4) sum += data[i];
      return { ch, density: sum };
    });
    measured.sort((a, b) => a.density - b.density);
    const sorted = measured.map(m => m.ch).join("");
    densityCache.set(charset, sorted); return sorted;
  } catch { densityCache.set(charset, charset); return charset; }
}

interface CoreResult { w: number; h: number; chars: string; nchars: number; brailleMode: boolean; blockMode: boolean; gradientDirs: boolean; color: boolean; threshold: number; invert: boolean; }

function runCore(source: AsciiSource, offscreen: HTMLCanvasElement, opts: AsciiOptions, mirror: boolean, crop?: { x: number; y: number; w: number; h: number }): CoreResult | null {
  const { w: sw, h: sh } = getSourceDimensions(source); if (!sw || !sh) return null;
  const { asciiW, asciiH, brightness, contrast, threshold, gamma, invert, color, edges, gradientDirs, dither, ditherMode, noiseReduction, localContrast, histEq, charset, brailleMode, blockMode, temporalSmoothing, charDensitySort } = opts;
  const srcX = crop?.x ?? 0, srcY = crop?.y ?? 0, srcW = crop?.w ?? sw, srcH = crop?.h ?? sh;
  const aspect = srcW / srcH, charAspect = 0.5;
  let drawW = asciiW, drawH = Math.round(asciiW / aspect * charAspect);
  if (drawH > asciiH) { drawH = asciiH; drawW = Math.round(asciiH * aspect / charAspect); }
  drawW = Math.max(1, drawW); drawH = Math.max(1, drawH);
  if (offscreen.width !== drawW) offscreen.width = drawW;
  if (offscreen.height !== drawH) offscreen.height = drawH;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true })!;
  ctx.save();
  if (mirror) { ctx.scale(-1, 1); ctx.drawImage(source, srcX, srcY, srcW, srcH, -drawW, 0, drawW, drawH); }
  else ctx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, drawW, drawH);
  ctx.restore();
  const imgData = ctx.getImageData(0, 0, drawW, drawH), px = imgData.data, N = drawW * drawH;
  pool.ensure(N); pool.lastW = drawW; pool.lastH = drawH;
  const { gray, r: rArr, g: gArr, b: bArr } = pool;
  const invGamma = 1 / gamma;

  let wasmUsed = false;
  const canUseWasm = isWasmAvailable() && !noiseReduction && !histEq && !localContrast && !dither && !brailleMode;

  if (canUseWasm) {
    try {
      const wasm = getWasmModule();
      const wasmResult = wasm.process_full_pipeline(
        px, drawW, drawH,
        brightness, contrast / 100, gamma,
        edges
      );
      for (let i = 0; i < N; i++) {
        gray[i] = wasmResult[i];
        rArr[i] = px[i * 4];
        gArr[i] = px[i * 4 + 1];
        bArr[i] = px[i * 4 + 2];
      }
      wasmUsed = true;
    } catch (err) {
}
  }

  if (!wasmUsed) {
    const applyGamma = gamma !== 1.0, applyContrast = contrast !== 100;
    if (applyGamma && applyContrast) {
      for (let i = 0; i < N; i++) { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; rArr[i] = r; gArr[i] = g; bArr[i] = b; let lum = 0.299 * r + 0.587 * g + 0.114 * b; lum = ((lum - 128) * (contrast / 100)) + 128 + brightness; gray[i] = clamp(255 * Math.pow(clamp(lum) / 255, invGamma)); }
    } else if (applyContrast) {
      for (let i = 0; i < N; i++) { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; rArr[i] = r; gArr[i] = g; bArr[i] = b; let lum = 0.299 * r + 0.587 * g + 0.114 * b; gray[i] = clamp(((lum - 128) * (contrast / 100)) + 128 + brightness); }
    } else if (applyGamma) {
      for (let i = 0; i < N; i++) { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; rArr[i] = r; gArr[i] = g; bArr[i] = b; let lum = 0.299 * r + 0.587 * g + 0.114 * b + brightness; gray[i] = clamp(255 * Math.pow(clamp(lum) / 255, invGamma)); }
    } else {
      for (let i = 0; i < N; i++) { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; rArr[i] = r; gArr[i] = g; bArr[i] = b; gray[i] = clamp(0.299 * r + 0.587 * g + 0.114 * b + brightness); }
    }
    if (noiseReduction) { gaussianBlur3(gray, pool.grayB, drawW, drawH); gray.set(pool.grayB); }
    if (histEq) histogramEqualize(gray, N);
    if (localContrast) { gaussianBlur3(gray, pool.grayB, drawW, drawH); for (let i = 0; i < N; i++) gray[i] = clamp(gray[i] * 1.2 - pool.grayB[i] * 0.2 + 25); }
    if (edges) sobelEdges(gray, drawW, drawH);
  }

  let chars = charset;
  if (charDensitySort) chars = sortCharsetByDensity(chars);
  const nchars = chars.length, denom = nchars - 1;
  const charIdx = pool.charIdx;
  if (dither) {
    const buf = pool.grayC; buf.set(gray);
    if (ditherMode === "floyd") floydSteinberg(buf, drawW, drawH, nchars);
    else { const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]; for (let y = 0; y < drawH; y++) for (let x = 0; x < drawW; x++) { const i = y * drawW + x; const th = (bayer[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * (255 / nchars); buf[i] = clamp(buf[i] + th); } }
    for (let i = 0; i < N; i++) { const lum = buf[i]; let idx; if (threshold > 0) { const isLight = lum >= threshold; idx = invert ? (isLight ? 0 : denom) : (isLight ? denom : 0); } else { idx = invert ? Math.floor((1 - lum / 255) * denom) : Math.floor(lum / 255 * denom); if (idx < 0) idx = 0; else if (idx > denom) idx = denom; } charIdx[i] = idx; }
  } else {
    for (let i = 0; i < N; i++) { const lum = gray[i]; let idx; if (threshold > 0) { const isLight = lum >= threshold; idx = invert ? (isLight ? 0 : denom) : (isLight ? denom : 0); } else { idx = invert ? Math.floor((1 - lum / 255) * denom) : Math.floor(lum / 255 * denom); if (idx < 0) idx = 0; else if (idx > denom) idx = denom; } charIdx[i] = idx; }
  }
  if (temporalSmoothing) { if (!pool.smoothed) pool.smoothed = new Float32Array(N); const sm = pool.smoothed; for (let i = 0; i < N; i++) sm[i] = sm[i] * 0.6 + charIdx[i] * 0.4; for (let i = 0; i < N; i++) charIdx[i] = Math.round(sm[i]); }
  if (gradientDirs) { for (let i = 0; i < N; i++) { if (pool.mag[i] > 40) { const deg = ((dir[i] * 180 / Math.PI) + 180) % 180; const li = deg < 22.5 || deg >= 157.5 ? 0 : deg < 67.5 ? 1 : deg < 112.5 ? 2 : 3; charIdx[i] = 0x4000 | li; } } }
  return { w: drawW, h: drawH, chars, nchars, brailleMode: false, blockMode: false, gradientDirs, color, threshold, invert };
}

const LINE_CHARS = ["-", "/", "|", "\\"];
const _rgbCache = new Map<number, string>();
function rgbStr(r: number, g: number, b: number): string { const k = (r << 16) | (g << 8) | b; let s = _rgbCache.get(k); if (!s) { s = `rgb(${r},${g},${b})`; if (_rgbCache.size < 32768) _rgbCache.set(k, s); } return s; }
function escChar(s: string): string { return s === "&" ? "&" : s === "<" ? "<" : s === ">" ? ">" : s; }

export function renderToString(source: AsciiSource, offscreen: HTMLCanvasElement, opts: AsciiOptions, mirror: boolean, mode: "html" | "text", crop?: { x: number; y: number; w: number; h: number }): { html: string; isColor: boolean } | null {
  const core = runCore(source, offscreen, opts, mirror, crop);
  if (!core) return null;
  if (core.brailleMode) return { html: buildBrailleString(core, mode), isColor: mode === "html" && core.color };
  const { w, h, chars, color } = core;
  const charIdx = pool.charIdx, rArr = pool.r, gArr = pool.g, bArr = pool.b;
  const lines: string[] = new Array(h);
  if (mode === "text") { for (let y = 0; y < h; y++) { let line = ""; for (let x = 0; x < w; x++) { const idx = charIdx[y * w + x]; line += idx & 0x4000 ? LINE_CHARS[idx & 3] : chars[idx] || " "; } lines[y] = line; } return { html: lines.join("\n"), isColor: false }; }
  if (!color) { for (let y = 0; y < h; y++) { let line = ""; for (let x = 0; x < w; x++) { const idx = charIdx[y * w + x]; line += escChar(idx & 0x4000 ? LINE_CHARS[idx & 3] : chars[idx] || " "); } lines[y] = line; } return { html: lines.join("\n"), isColor: false }; }
  for (let y = 0; y < h; y++) { const parts: string[] = []; let runR = -1, runG = -1, runB = -1, runText = ""; for (let x = 0; x < w; x++) { const i = y * w + x, idx = charIdx[i]; const cr = rArr[i], cg = gArr[i], cb = bArr[i]; const disp = escChar(idx & 0x4000 ? LINE_CHARS[idx & 3] : chars[idx] || " "); if (cr === runR && cg === runG && cb === runB) runText += disp; else { if (runText) parts.push(`<span style="color:${rgbStr(runR, runG, runB)}">${runText}</span>`); runR = cr; runG = cg; runB = cb; runText = disp; } } if (runText) parts.push(`<span style="color:${rgbStr(runR, runG, runB)}">${runText}</span>`); lines[y] = parts.join(""); }
  return { html: lines.join("\n"), isColor: true };
}

function buildBrailleString(core: CoreResult, mode: "html" | "text"): string {
  const { w: srcW, h: srcH, threshold, invert, color } = core;
  const gray = pool.gray, rArr = pool.r, gArr = pool.g, bArr = pool.b;
  const th = threshold > 0 ? threshold : 128, bW = Math.floor(srcW / 2), bH = Math.floor(srcH / 4);
  const lines: string[] = new Array(bH);
  const BRAILLE_BASE = 0x2800;
  const BRAILLE_DOTS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
  for (let cy = 0; cy < bH; cy++) { let line = ""; for (let cx = 0; cx < bW; cx++) { let bits = 0, tr = 0, tg = 0, tb = 0; for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) { const i = (cy * 4 + dy) * srcW + (cx * 2 + dx); if ((gray[i] >= th) !== invert) bits |= BRAILLE_DOTS[dy * 2 + dx]; tr += rArr[i] ?? 0; tg += gArr[i] ?? 0; tb += bArr[i] ?? 0; } const ch = String.fromCodePoint(BRAILLE_BASE | bits); if (mode === "text" || !color) line += ch; else line += `<span style="color:${rgbStr(Math.round(tr / 8), Math.round(tg / 8), Math.round(tb / 8))}">${ch}</span>`; } lines[cy] = line; }
  return lines.join("\n");
}

export function processFrame(source: AsciiSource, offscreen: HTMLCanvasElement, opts: AsciiOptions, mirror = true, crop?: { x: number; y: number; w: number; h: number }): AsciiFrame | null {
  const core = runCore(source, offscreen, opts, mirror, crop);
  if (!core) return null;
  if (core.brailleMode) return brailleCore(core);
  const { w, h, chars, color } = core;
  const charIdx = pool.charIdx, rArr = pool.r, gArr = pool.g, bArr = pool.b;
  const frame: AsciiFrame = new Array(h);
  for (let y = 0; y < h; y++) { const row: AsciiCell[] = new Array(w); for (let x = 0; x < w; x++) { const i = y * w + x, idx = charIdx[i]; const ch = idx & 0x4000 ? LINE_CHARS[idx & 3] : chars[idx] || " "; row[x] = { char: ch, charIdx: idx, r: color ? rArr[i] : 0, g: color ? gArr[i] : 0, b: color ? bArr[i] : 0 }; } frame[y] = row; }
  return frame;
}

function brailleCore(core: CoreResult): AsciiFrame {
  const { w: srcW, h: srcH, threshold, invert, color } = core;
  const gray = pool.gray, rArr = pool.r, gArr = pool.g, bArr = pool.b;
  const th = threshold > 0 ? threshold : 128, bW = Math.floor(srcW / 2), bH = Math.floor(srcH / 4);
  const frame: AsciiFrame = [];
  const BRAILLE_BASE = 0x2800;
  const BRAILLE_DOTS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
  for (let cy = 0; cy < bH; cy++) { const row: AsciiCell[] = []; for (let cx = 0; cx < bW; cx++) { let bits = 0, tr = 0, tg = 0, tb = 0; for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) { const i = (cy * 4 + dy) * srcW + (cx * 2 + dx); if ((gray[i] >= th) !== invert) bits |= BRAILLE_DOTS[dy * 2 + dx]; tr += rArr[i] ?? 0; tg += gArr[i] ?? 0; tb += bArr[i] ?? 0; } row.push({ char: String.fromCodePoint(BRAILLE_BASE | bits), charIdx: bits, r: color ? Math.round(tr / 8) : 0, g: color ? Math.round(tg / 8) : 0, b: color ? Math.round(tb / 8) : 0 }); } frame.push(row); }
  return frame;
}

export function frameToHtml(frame: AsciiFrame, color: boolean): string {
  if (!color) return frame.map(row => row.map(c => c.char === " " ? "\u00a0" : escChar(c.char)).join("")).join("\n");
  return frame.map(row => { const parts: string[] = []; let runR = -1, runG = -1, runB = -1, runText = ""; for (const c of row) { const disp = c.char === " " ? "\u00a0" : escChar(c.char); if (c.r === runR && c.g === runG && c.b === runB) runText += disp; else { if (runText) parts.push(`<span style="color:${rgbStr(runR, runG, runB)}">${runText}</span>`); runR = c.r; runG = c.g; runB = c.b; runText = disp; } } if (runText) parts.push(`<span style="color:${rgbStr(runR, runG, runB)}">${runText}</span>`); return parts.join(""); }).join("\n");
}

export function frameToText(frame: AsciiFrame): string { return frame.map(row => row.map(c => c.char).join("")).join("\n"); }
