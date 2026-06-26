import { type PaletteColor, type PaletteSize, serializePalette, deserializePalette, medianCutQuantize } from "./palette";
import { type GlyphFeature, buildGlyphTable, ALL_GLYPHS } from "./glyphs";
import { type AtvToken, type DeltaEntry, type MotionBlock, estimateMotion, applyMotionPrediction, computeDelta, applyDelta } from "./motion";
import {
  rleEncode, rleDecode, buildHuffmanTable, buildDecodeTable,
  huffmanEncode, huffmanDecode, computeFrequencies,
  serializeHuffmanTable, deserializeHuffmanTable,
  BitWriter, BitReader
} from "./entropy";
import { gzip, gunzip } from "../format";

export const ATV_MAGIC = "ATV1";
export const ATV_VERSION = 1;

export interface AtvHeader {
  magic: string;
  version: number;
  cols: number;
  rows: number;
  fps: number;
  paletteSize: PaletteSize;
  colorMode: boolean;
  glyphSet: string;
  frameCount: number;
  durationMs: number;
}

export interface AtvKeyFrame {
  type: "key";
  tokens: AtvToken[][];
}

export interface AtvDeltaFrame {
  type: "delta";
  motionBlocks: MotionBlock[];
  deltas: DeltaEntry[];
}

export type AtvFrameData = AtvKeyFrame | AtvDeltaFrame;

export interface AtvStream {
  header: AtvHeader;
  palette: PaletteColor[];
  glyphs: GlyphFeature[];
  glyphTable: HuffmanTableSerialized;
  colorTable: HuffmanTableSerialized;
  frames: EncodedFrameBlock[];
}

interface HuffmanTableSerialized {
  data: Uint8Array;
}

export interface EncodedFrameBlock {
  isKey: boolean;
  data: Uint8Array;
}

function writeUint32(buf: number[], v: number) {
  buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function writeUint16(buf: number[], v: number) {
  buf.push((v >> 8) & 0xff, v & 0xff);
}

function writeString(buf: number[], s: string) {
  const b = new TextEncoder().encode(s);
  writeUint16(buf, b.length);
  b.forEach(x => buf.push(x));
}

function readUint32(data: Uint8Array, p: number): [number, number] {
  return [((data[p] << 24) | (data[p+1] << 16) | (data[p+2] << 8) | data[p+3]) >>> 0, p + 4];
}

function readUint16(data: Uint8Array, p: number): [number, number] {
  return [(data[p] << 8) | data[p+1], p + 2];
}

function readString(data: Uint8Array, p: number): [string, number] {
  const [len, p2] = readUint16(data, p);
  const s = new TextDecoder().decode(data.slice(p2, p2 + len));
  return [s, p2 + len];
}

export function encodeKeyFrame(
  tokens: AtvToken[][],
  rows: number,
  cols: number,
  glyphHuffman: Map<number, { bits: number; len: number }>,
  colorHuffman: Map<number, { bits: number; len: number }>,
  hasColor: boolean
): Uint8Array {
  const glyphVals: number[] = [];
  const colorVals: number[] = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = tokens[y]?.[x] ?? { glyphId: 0, colorId: 0 };
      glyphVals.push(t.glyphId);
      if (hasColor) colorVals.push(t.colorId);
    }
  }

  const glyphRle = rleEncode(glyphVals);
  const rleFlat: number[] = [];
  for (const run of glyphRle) {
    rleFlat.push(run.value);
    rleFlat.push(run.count > 255 ? 255 : run.count);
  }

  const glyphEncoded = huffmanEncode(rleFlat, glyphHuffman);
  const colorEncoded = hasColor ? huffmanEncode(colorVals, colorHuffman) : new Uint8Array(0);

  const buf: number[] = [];
  buf.push(0x4b);
  writeUint32(buf, glyphRle.length);
  writeUint32(buf, glyphEncoded.length);
  glyphEncoded.forEach(b => buf.push(b));
  if (hasColor) {
    writeUint32(buf, colorEncoded.length);
    colorEncoded.forEach(b => buf.push(b));
  }
  return new Uint8Array(buf);
}

export function decodeKeyFrame(
  data: Uint8Array,
  offset: number,
  rows: number,
  cols: number,
  glyphDecodeTable: Map<string, number>,
  colorDecodeTable: Map<string, number>,
  hasColor: boolean
): { tokens: AtvToken[][]; bytesRead: number } {
  let p = offset;
  if (data[p++] !== 0x4b) throw new Error("Expected key frame marker");

  const [rleCount, p2] = readUint32(data, p); p = p2;
  const [glyphLen, p3] = readUint32(data, p); p = p3;
  const glyphData = data.slice(p, p + glyphLen); p += glyphLen;

  const rleFlat = huffmanDecode(glyphData, glyphDecodeTable, rleCount * 2);
  const runs = [];
  for (let i = 0; i < rleFlat.length - 1; i += 2) {
    runs.push({ value: rleFlat[i], count: rleFlat[i + 1] || 1 });
  }
  const glyphVals = rleDecode(runs);

  let colorVals: number[] = [];
  if (hasColor) {
    const [colorLen, p4] = readUint32(data, p); p = p4;
    const colorData = data.slice(p, p + colorLen); p += colorLen;
    colorVals = huffmanDecode(colorData, colorDecodeTable, rows * cols);
  }

  const tokens: AtvToken[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: AtvToken[] = [];
    for (let x = 0; x < cols; x++) {
      const idx = y * cols + x;
      row.push({ glyphId: glyphVals[idx] ?? 0, colorId: colorVals[idx] ?? 0 });
    }
    tokens.push(row);
  }
  return { tokens, bytesRead: p - offset };
}

function encodeDeltaFrame(
  motionBlocks: MotionBlock[],
  deltas: DeltaEntry[],
  glyphHuffman: Map<number, { bits: number; len: number }>,
  colorHuffman: Map<number, { bits: number; len: number }>,
  hasColor: boolean
): Uint8Array {
  const buf: number[] = [];
  buf.push(0x44);

  writeUint16(buf, motionBlocks.length);
  for (const mb of motionBlocks) {
    writeUint16(buf, mb.blockX);
    writeUint16(buf, mb.blockY);
    buf.push((mb.dx + 128) & 0xff);
    buf.push((mb.dy + 128) & 0xff);
  }

  writeUint32(buf, deltas.length);
  const deltaGlyphs: number[] = [];
  const deltaColors: number[] = [];
  const deltaIndices: number[] = [];

  for (const d of deltas) {
    deltaIndices.push(d.cellIndex);
    deltaGlyphs.push(d.token.glyphId);
    if (hasColor) deltaColors.push(d.token.colorId);
  }

  const glyphEncoded = huffmanEncode(deltaGlyphs, glyphHuffman);
  const colorEncoded = hasColor ? huffmanEncode(deltaColors, colorHuffman) : new Uint8Array(0);

  writeUint32(buf, glyphEncoded.length);
  glyphEncoded.forEach(b => buf.push(b));
  if (hasColor) {
    writeUint32(buf, colorEncoded.length);
    colorEncoded.forEach(b => buf.push(b));
  }

  for (const idx of deltaIndices) {
    writeUint32(buf, idx);
  }

  return new Uint8Array(buf);
}

function decodeDeltaFrame(
  data: Uint8Array,
  offset: number,
  glyphDecodeTable: Map<string, number>,
  colorDecodeTable: Map<string, number>,
  hasColor: boolean
): { motionBlocks: MotionBlock[]; deltas: DeltaEntry[]; bytesRead: number } {
  let p = offset;
  if (data[p++] !== 0x44) throw new Error("Expected delta frame marker");

  const [mbCount, p2] = readUint16(data, p); p = p2;
  const motionBlocks: MotionBlock[] = [];
  for (let i = 0; i < mbCount; i++) {
    const [bx, p3] = readUint16(data, p); p = p3;
    const [by, p4] = readUint16(data, p); p = p4;
    const dx = data[p++] - 128;
    const dy = data[p++] - 128;
    motionBlocks.push({ blockX: bx, blockY: by, dx, dy });
  }

  const [deltaCount, p5] = readUint32(data, p); p = p5;
  const [glyphLen, p6] = readUint32(data, p); p = p6;
  const glyphData = data.slice(p, p + glyphLen); p += glyphLen;
  const deltaGlyphs = huffmanDecode(glyphData, glyphDecodeTable, deltaCount);

  let deltaColors: number[] = [];
  if (hasColor) {
    const [colorLen, p7] = readUint32(data, p); p = p7;
    const colorData = data.slice(p, p + colorLen); p += colorLen;
    deltaColors = huffmanDecode(colorData, colorDecodeTable, deltaCount);
  }

  const deltas: DeltaEntry[] = [];
  for (let i = 0; i < deltaCount; i++) {
    const [cellIndex, p8] = readUint32(data, p); p = p8;
    deltas.push({
      cellIndex,
      token: { glyphId: deltaGlyphs[i] ?? 0, colorId: deltaColors[i] ?? 0 }
    });
  }
  return { motionBlocks, deltas, bytesRead: p - offset };
}

export interface EncodeAtvOptions {
  fps?: number;
  paletteSize?: PaletteSize;
  colorMode?: boolean;
  glyphSet?: string;
  keyFrameInterval?: number;
}

export interface AtvEncodeProgress {
  phase: string;
  progress: number;
  total: number;
}

export async function encodeAtv(
  frames: Array<{ analysis: import("./analysis").FrameAnalysis; tokens: AtvToken[][] }>,
  palette: PaletteColor[],
  glyphs: GlyphFeature[],
  opts: EncodeAtvOptions = {},
  onProgress?: (p: AtvEncodeProgress) => void
): Promise<Uint8Array> {
  const {
    fps = 15,
    paletteSize = 256,
    colorMode = true,
    glyphSet = ALL_GLYPHS,
    keyFrameInterval = 30,
  } = opts;

  if (!frames.length) throw new Error("No frames to encode");
  const rows = frames[0].tokens.length;
  const cols = frames[0].tokens[0]?.length ?? 0;

  onProgress?.({ phase: "Building frequency tables", progress: 0, total: 1 });

  const allGlyphVals: number[] = [];
  const allColorVals: number[] = [];
  for (const f of frames) {
    for (const row of f.tokens) {
      for (const t of row) {
        allGlyphVals.push(t.glyphId);
        if (colorMode) allColorVals.push(t.colorId);
      }
    }
  }

  const glyphFreqs = computeFrequencies(allGlyphVals);
  const colorFreqs = colorMode ? computeFrequencies(allColorVals) : new Map<number, number>();
  const rleSymFreqs = new Map<number, number>();
  for (const [v, f] of glyphFreqs) rleSymFreqs.set(v, f);
  for (let i = 1; i <= 255; i++) rleSymFreqs.set(i + 10000, (rleSymFreqs.get(i + 10000) ?? 0) + 1);

  const glyphHuffman = buildHuffmanTable(glyphFreqs);
  const colorHuffman = colorMode ? buildHuffmanTable(colorFreqs) : new Map<number, { bits: number; len: number }>();

  const glyphTableSer = serializeHuffmanTable(glyphHuffman);
  const colorTableSer = colorMode ? serializeHuffmanTable(colorHuffman) : new Uint8Array(2);

  const paletteSer = serializePalette(palette);

  const header: number[] = [];
  for (let i = 0; i < 4; i++) header.push(ATV_MAGIC.charCodeAt(i));
  header.push(ATV_VERSION);
  writeUint16(header, cols);
  writeUint16(header, rows);
  header.push(fps & 0xff);
  header.push(colorMode ? 1 : 0);
  writeUint32(header, frames.length);
  writeString(header, glyphSet);

  const hdrArr = new Uint8Array(header);
  const allParts: Uint8Array[] = [hdrArr, paletteSer, glyphTableSer, colorTableSer];

  let prevTokens: AtvToken[][] | null = null;

  for (let fi = 0; fi < frames.length; fi++) {
    onProgress?.({ phase: "Encoding frames", progress: fi, total: frames.length });
    const isKey = fi === 0 || fi % keyFrameInterval === 0;
    const currTokens = frames[fi].tokens;

    let frameData: Uint8Array;
    if (isKey || !prevTokens) {
      frameData = encodeKeyFrame(currTokens, rows, cols, glyphHuffman, colorHuffman, colorMode);
    } else {
      const motionBlocks = estimateMotion(currTokens, prevTokens, rows, cols);
      const predicted = applyMotionPrediction(prevTokens, motionBlocks, rows, cols);
      const deltas = computeDelta(currTokens, predicted, rows, cols);
      const keySize = rows * cols * 2;
      const deltaSize = motionBlocks.length * 8 + deltas.length * 6;
      if (deltaSize >= keySize * 0.85) {
        frameData = encodeKeyFrame(currTokens, rows, cols, glyphHuffman, colorHuffman, colorMode);
      } else {
        frameData = encodeDeltaFrame(motionBlocks, deltas, glyphHuffman, colorHuffman, colorMode);
      }
    }
    allParts.push(frameData);
    prevTokens = currTokens;
  }

  onProgress?.({ phase: "Compressing stream", progress: 0, total: 1 });

  const totalLen = allParts.reduce((s, p) => s + p.length, 0);
  const raw = new Uint8Array(totalLen);
  let off = 0;
  for (const p of allParts) { raw.set(p, off); off += p.length; }

  const compressed = await gzip(raw);
  onProgress?.({ phase: "Done", progress: 1, total: 1 });
  return compressed;
}

export interface DecodedAtvHeader {
  cols: number;
  rows: number;
  fps: number;
  colorMode: boolean;
  frameCount: number;
  glyphSet: string;
}

export interface AtvDecoder {
  header: DecodedAtvHeader;
  palette: PaletteColor[];
  glyphs: GlyphFeature[];
  glyphDecodeTable: Map<string, number>;
  colorDecodeTable: Map<string, number>;
  frameOffsets: number[];
  raw: Uint8Array;
  baseOffset: number;
}

export async function initAtvDecoder(compressed: Uint8Array): Promise<AtvDecoder> {
  const raw = await gunzip(compressed);
  let p = 0;

  const magic = String.fromCharCode(raw[p], raw[p+1], raw[p+2], raw[p+3]); p += 4;
  if (magic !== ATV_MAGIC) throw new Error(`Invalid ATV file: bad magic "${magic}"`);
  const version = raw[p++];
  if (version !== ATV_VERSION) throw new Error(`Unsupported ATV version ${version}`);

  const [cols, p2] = readUint16(raw, p); p = p2;
  const [rows, p3] = readUint16(raw, p); p = p3;
  const fps = raw[p++];
  const colorMode = raw[p++] === 1;
  const [frameCount, p4] = readUint32(raw, p); p = p4;
  const [glyphSet, p5] = readString(raw, p); p = p5;

  const { palette, bytesRead: palBytes } = deserializePalette(raw, p); p += palBytes;

  const { table: glyphHuffman, bytesRead: ghBytes } = deserializeHuffmanTable(raw, p); p += ghBytes;
  const { table: colorHuffman, bytesRead: chBytes } = deserializeHuffmanTable(raw, p); p += chBytes;

  const glyphs = buildGlyphTable(glyphSet);

  const glyphDecodeTable = buildDecodeTable(glyphHuffman);
  const colorDecodeTable = buildDecodeTable(colorHuffman);

  const header: DecodedAtvHeader = { cols, rows, fps, colorMode, frameCount, glyphSet };

  const baseOffset = p;
  const frameOffsets: number[] = [];
  let scanP = p;
  for (let fi = 0; fi < frameCount; fi++) {
    frameOffsets.push(scanP);
    const frameType = raw[scanP];
    if (frameType === 0x4b) {
      const [rleCount, sp2] = readUint32(raw, scanP + 1);
      const [glyphLen, sp3] = readUint32(raw, sp2);
      let fp = sp3 + glyphLen;
      if (colorMode) {
        const [colorLen, sp4] = readUint32(raw, fp);
        fp = sp4 + colorLen;
      }
      scanP = fp;
    } else if (frameType === 0x44) {
      const [mbCount, sp2] = readUint16(raw, scanP + 1);
      let fp = sp2 + mbCount * 6;
      const [, sp3] = readUint32(raw, fp); fp = sp3;
      const [glyphLen, sp4] = readUint32(raw, fp); fp = sp4 + glyphLen;
      if (colorMode) {
        const [colorLen, sp5] = readUint32(raw, fp); fp = sp5 + colorLen;
      }
      const [deltaCount] = readUint32(raw, scanP + 1 + 2 + mbCount * 6);
      fp += deltaCount * 4;
      scanP = fp;
    } else {
      scanP++;
    }
  }

  return { header, palette, glyphs, glyphDecodeTable, colorDecodeTable, frameOffsets, raw, baseOffset };
}

export function decodeAtvFrame(
  decoder: AtvDecoder,
  frameIndex: number,
  prevTokens: AtvToken[][] | null
): AtvToken[][] {
  const { header: { rows, cols, colorMode }, raw, frameOffsets, glyphDecodeTable, colorDecodeTable } = decoder;
  const offset = frameOffsets[frameIndex];
  if (offset === undefined) throw new Error(`Frame ${frameIndex} not found`);

  const frameType = raw[offset];
  if (frameType === 0x4b) {
    const { tokens } = decodeKeyFrame(raw, offset, rows, cols, glyphDecodeTable, colorDecodeTable, colorMode);
    return tokens;
  } else if (frameType === 0x44) {
    if (!prevTokens) throw new Error("Delta frame requires previous frame");
    const { motionBlocks, deltas } = decodeDeltaFrame(raw, offset, glyphDecodeTable, colorDecodeTable, colorMode);
    const predicted = applyMotionPrediction(prevTokens, motionBlocks, rows, cols);
    return applyDelta(predicted, deltas, rows, cols);
  }
  throw new Error(`Unknown frame type: 0x${frameType.toString(16)}`);
}
