import { buildGlyphTable, selectGlyph, ALL_GLYPHS, EDGE_GLYPHS, type GlyphFeature, type CellContext } from "./glyphs";
import { type PaletteColor, buildPaletteLookup } from "./palette";
import type { AtvToken } from "./motion";

export interface FrameAnalysis {
  gray: Float32Array;
  rArr: Uint8Array;
  gArr: Uint8Array;
  bArr: Uint8Array;
  edgeMag: Float32Array;
  edgeDir: Float32Array;
  localContrast: Float32Array;
  width: number;
  height: number;
}

function clamp(v: number, lo = 0, hi = 255): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function gaussianBlur(gray: Float32Array, w: number, h: number): Float32Array {
  const k = [1/16,2/16,1/16,2/16,4/16,2/16,1/16,2/16,1/16];
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++)
          s += gray[clamp(y + ky, 0, h - 1) * w + clamp(x + kx, 0, w - 1)] * k[(ky + 1) * 3 + (kx + 1)];
      out[y * w + x] = s;
    }
  }
  return out;
}

export function sobelGradient(gray: Float32Array, w: number, h: number): { mag: Float32Array; dir: Float32Array } {
  const mag = new Float32Array(w * h);
  const dir = new Float32Array(w * h);
  const Gx = [-1,0,1,-2,0,2,-1,0,1];
  const Gy = [-1,-2,-1,0,0,0,1,2,1];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let gx = 0, gy = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++) {
          const p = gray[(y + ky) * w + (x + kx)];
          const ki = (ky + 1) * 3 + (kx + 1);
          gx += Gx[ki] * p; gy += Gy[ki] * p;
        }
      mag[y * w + x] = clamp(Math.sqrt(gx * gx + gy * gy));
      dir[y * w + x] = Math.atan2(gy, gx);
    }
  }
  return { mag, dir };
}

function scharr(gray: Float32Array, w: number, h: number): { mag: Float32Array; dir: Float32Array } {
  const mag = new Float32Array(w * h);
  const dir = new Float32Array(w * h);
  const Gx = [-3,0,3,-10,0,10,-3,0,3];
  const Gy = [-3,-10,-3,0,0,0,3,10,3];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let gx = 0, gy = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++) {
          const p = gray[(y + ky) * w + (x + kx)];
          const ki = (ky + 1) * 3 + (kx + 1);
          gx += Gx[ki] * p; gy += Gy[ki] * p;
        }
      mag[y * w + x] = clamp(Math.hypot(gx, gy) / 16);
      dir[y * w + x] = Math.atan2(gy, gx);
    }
  }
  return { mag, dir };
}

function computeLocalContrast(gray: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let mn = 255, mx = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++) {
          const v = gray[(y + ky) * w + (x + kx)];
          if (v < mn) mn = v; if (v > mx) mx = v;
        }
      out[y * w + x] = mx - mn;
    }
  }
  return out;
}

export function analyzeFrame(
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  offscreen: HTMLCanvasElement,
  targetW: number,
  targetH: number,
  mirror = false
): FrameAnalysis | null {
  let sw: number, sh: number;
  if (source instanceof HTMLVideoElement) { sw = source.videoWidth; sh = source.videoHeight; }
  else if (source instanceof HTMLCanvasElement) { sw = source.width; sh = source.height; }
  else { sw = source.naturalWidth; sh = source.naturalHeight; }
  if (!sw || !sh) return null;

  const aspect = sw / sh;
  const charAspect = 0.52;
  let dw = targetW;
  let dh = Math.round(targetW / aspect * charAspect);
  if (dh > targetH) { dh = targetH; dw = Math.round(targetH * aspect / charAspect); }

  offscreen.width = dw; offscreen.height = dh;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true })!;
  ctx.save();
  if (mirror) { ctx.scale(-1, 1); ctx.drawImage(source, 0, 0, sw, sh, -dw, 0, dw, dh); }
  else ctx.drawImage(source, 0, 0, sw, sh, 0, 0, dw, dh);
  ctx.restore();

  const px = ctx.getImageData(0, 0, dw, dh).data;
  const N = dw * dh;
  const gray = new Float32Array(N);
  const rArr = new Uint8Array(N), gArr = new Uint8Array(N), bArr = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    rArr[i] = r; gArr[i] = g; bArr[i] = b;
  }

  const blurred = gaussianBlur(gray, dw, dh);
  const { mag: edgeMag, dir: edgeDir } = scharr(blurred, dw, dh);
  const localContrast = computeLocalContrast(gray, dw, dh);

  return { gray, rArr, gArr, bArr, edgeMag, edgeDir, localContrast, width: dw, height: dh };
}

export function frameToTokens(
  analysis: FrameAnalysis,
  glyphs: GlyphFeature[],
  palette: PaletteColor[],
  colorMode: boolean
): AtvToken[][] {
  const { gray, rArr, gArr, bArr, edgeMag, edgeDir, localContrast, width, height } = analysis;
  const lookup = buildPaletteLookup(palette);
  const hw = 2, hh = 2;

  const tokens: AtvToken[][] = [];
  for (let y = 0; y < height; y++) {
    const row: AtvToken[] = [];
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let topHalf = 0, bottomHalf = 0, leftHalf = 0, rightHalf = 0;
      let samples = 0;
      for (let dy = -hh; dy <= hh; dy++) {
        for (let dx = -hw; dx <= hw; dx++) {
          const ny = Math.max(0, Math.min(height - 1, y + dy));
          const nx = Math.max(0, Math.min(width - 1, x + dx));
          const v = gray[ny * width + nx];
          if (dy < 0) topHalf += v; else bottomHalf += v;
          if (dx < 0) leftHalf += v; else rightHalf += v;
          samples++;
        }
      }
      const qs = samples / 4;
      const ctx: CellContext = {
        luminance: gray[i],
        edgeMag: edgeMag[i],
        edgeDir: edgeDir[i],
        localContrast: localContrast[i],
        topHalf: topHalf / qs,
        bottomHalf: bottomHalf / qs,
        leftHalf: leftHalf / qs,
        rightHalf: rightHalf / qs,
        textureVar: localContrast[i],
      };

      const glyph = selectGlyph(ctx, glyphs);
      const glyphId = glyphs.findIndex(g => g.char === glyph.char);
      const colorId = colorMode ? lookup(rArr[i], gArr[i], bArr[i]) : 0;
      row.push({ glyphId: Math.max(0, glyphId), colorId });
    }
    tokens.push(row);
  }
  return tokens;
}

export function tokensToFrame(
  tokens: AtvToken[][],
  glyphs: GlyphFeature[],
  palette: PaletteColor[],
  colorMode: boolean
): { chars: string[][]; colors: [number,number,number][][] } {
  const chars: string[][] = [];
  const colors: [number,number,number][][] = [];
  for (const row of tokens) {
    const charRow: string[] = [];
    const colorRow: [number,number,number][] = [];
    for (const tok of row) {
      charRow.push(glyphs[tok.glyphId]?.char ?? " ");
      if (colorMode && palette[tok.colorId]) {
        const p = palette[tok.colorId];
        colorRow.push([p.r, p.g, p.b]);
      } else {
        colorRow.push([0, 0, 0]);
      }
    }
    chars.push(charRow);
    colors.push(colorRow);
  }
  return { chars, colors };
}
