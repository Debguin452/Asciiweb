import { analyzeFrame, frameToTokens, tokensToFrame, type FrameAnalysis } from "./analysis";
import { medianCutQuantize, type PaletteColor, type PaletteSize } from "./palette";
import { buildGlyphTable, ALL_GLYPHS, ASCII_GLYPHS, BLOCK_GLYPHS, type GlyphFeature } from "./glyphs";
import { encodeAtv, initAtvDecoder, decodeAtvFrame, type EncodeAtvOptions, type AtvDecoder, type AtvEncodeProgress } from "./codec";
import type { AtvToken } from "./motion";

export type { AtvDecoder, AtvEncodeProgress, EncodeAtvOptions };
export type { PaletteColor, PaletteSize };
export type { GlyphFeature };
export type { FrameAnalysis };
export { ALL_GLYPHS, ASCII_GLYPHS, BLOCK_GLYPHS };
export { tokensToFrame };
export { initAtvDecoder, decodeAtvFrame };

export interface AtvEncodeSource {
  frames: Array<{
    source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
    timestamp?: number;
  }>;
  offscreen?: HTMLCanvasElement;
  targetW?: number;
  targetH?: number;
}

export interface AtvBuildResult {
  data: Uint8Array;
  cols: number;
  rows: number;
  frameCount: number;
  palette: PaletteColor[];
  glyphs: GlyphFeature[];
  compressedSize: number;
  rawPixelEquivalent: number;
  compressionRatio: number;
}

export async function buildAtvFromSources(
  src: AtvEncodeSource,
  opts: EncodeAtvOptions = {},
  onProgress?: (p: AtvEncodeProgress) => void
): Promise<AtvBuildResult> {
  const {
    colorMode = true,
    paletteSize = 256,
    glyphSet = ALL_GLYPHS,
    fps = 15,
  } = opts;

  const offscreen = src.offscreen ?? document.createElement("canvas");
  const targetW = src.targetW ?? 160;
  const targetH = src.targetH ?? 90;

  onProgress?.({ phase: "Analyzing frames", progress: 0, total: src.frames.length });

  const analyses: FrameAnalysis[] = [];
  for (let i = 0; i < src.frames.length; i++) {
    const f = src.frames[i];
    const analysis = analyzeFrame(f.source, offscreen, targetW, targetH, false);
    if (analysis) analyses.push(analysis);
    if (i % 10 === 0) onProgress?.({ phase: "Analyzing frames", progress: i, total: src.frames.length });
  }

  if (!analyses.length) throw new Error("No valid frames to encode");

  onProgress?.({ phase: "Building palette", progress: 0, total: 1 });

  const samplePixels: Uint8Array[] = analyses.slice(0, Math.min(30, analyses.length))
    .map(a => {
      const arr = new Uint8Array(a.width * a.height * 4);
      for (let i = 0; i < a.width * a.height; i++) {
        arr[i * 4] = a.rArr[i];
        arr[i * 4 + 1] = a.gArr[i];
        arr[i * 4 + 2] = a.bArr[i];
        arr[i * 4 + 3] = 255;
      }
      return arr;
    });

  const combinedLen = samplePixels.reduce((s, p) => s + p.length, 0);
  const combined = new Uint8Array(combinedLen);
  let off = 0;
  for (const p of samplePixels) { combined.set(p, off); off += p.length; }

  const palette = colorMode
    ? medianCutQuantize(combined, paletteSize, 8)
    : [{ r: 255, g: 255, b: 255, id: 0 }];

  const glyphs = buildGlyphTable(glyphSet);
  if (!colorMode) palette[0] = { r: 255, g: 255, b: 255, id: 0 };

  onProgress?.({ phase: "Tokenizing frames", progress: 0, total: analyses.length });

  const tokenFrames: Array<{ analysis: FrameAnalysis; tokens: AtvToken[][] }> = [];
  const rows = analyses[0].height;
  const cols = analyses[0].width;

  for (let i = 0; i < analyses.length; i++) {
    const tokens = frameToTokens(analyses[i], glyphs, palette, colorMode);
    tokenFrames.push({ analysis: analyses[i], tokens });
    if (i % 10 === 0) onProgress?.({ phase: "Tokenizing frames", progress: i, total: analyses.length });
  }

  const data = await encodeAtv(tokenFrames, palette, glyphs, opts, onProgress);

  const rawPixelEquivalent = rows * cols * 3 * analyses.length;
  const compressionRatio = rawPixelEquivalent / data.length;

  return {
    data, cols, rows,
    frameCount: analyses.length,
    palette, glyphs,
    compressedSize: data.length,
    rawPixelEquivalent,
    compressionRatio,
  };
}

export interface AtvLiveEncoderOptions {
  targetW?: number;
  targetH?: number;
  fps?: number;
  paletteSize?: PaletteSize;
  colorMode?: boolean;
  glyphSet?: string;
  keyFrameInterval?: number;
}

export class AtvLiveEncoder {
  private offscreen = document.createElement("canvas");
  private glyphs: GlyphFeature[];
  private palette: PaletteColor[] = [];
  private paletteReady = false;
  private paletteBuffer: Uint8Array[] = [];
  private frameCount = 0;
  private opts: Required<AtvLiveEncoderOptions>;

  constructor(opts: AtvLiveEncoderOptions = {}) {
    this.opts = {
      targetW: opts.targetW ?? 120,
      targetH: opts.targetH ?? 68,
      fps: opts.fps ?? 15,
      paletteSize: opts.paletteSize ?? 128,
      colorMode: opts.colorMode ?? true,
      glyphSet: opts.glyphSet ?? ALL_GLYPHS,
      keyFrameInterval: opts.keyFrameInterval ?? 30,
    };
    this.glyphs = buildGlyphTable(this.opts.glyphSet);
  }

  feedPaletteSample(source: HTMLVideoElement | HTMLCanvasElement): void {
    if (this.paletteReady) return;
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source, 0, 0, 32, 32);
    const px = ctx.getImageData(0, 0, 32, 32).data;
    this.paletteBuffer.push(new Uint8Array(px.buffer));
    if (this.paletteBuffer.length >= 10) this.buildPalette();
  }

  buildPalette(): void {
    const combined = this.paletteBuffer.reduce((acc, p) => {
      const n = new Uint8Array(acc.length + p.length);
      n.set(acc); n.set(p, acc.length);
      return n;
    }, new Uint8Array(0));
    this.palette = medianCutQuantize(combined, this.opts.paletteSize, 4);
    this.paletteReady = true;
    this.paletteBuffer = [];
  }

  encodeFrame(source: HTMLVideoElement | HTMLCanvasElement): {
    tokens: AtvToken[][];
    chars: string[][];
    colors: [number, number, number][][];
    width: number;
    height: number;
  } | null {
    if (!this.paletteReady) {
      this.feedPaletteSample(source);
      if (!this.paletteReady) return null;
    }

    const analysis = analyzeFrame(source, this.offscreen, this.opts.targetW, this.opts.targetH, false);
    if (!analysis) return null;

    const tokens = frameToTokens(analysis, this.glyphs, this.palette, this.opts.colorMode);
    const { chars, colors } = tokensToFrame(tokens, this.glyphs, this.palette, this.opts.colorMode);
    this.frameCount++;
    return { tokens, chars, colors, width: analysis.width, height: analysis.height };
  }

  get isReady(): boolean { return this.paletteReady; }
  get encodedFrames(): number { return this.frameCount; }
  get glyphList(): GlyphFeature[] { return this.glyphs; }
  get paletteColors(): PaletteColor[] { return this.palette; }
}
