import type { AsciiFrame } from "./ascii";
import type { AsciiOptions } from "./ascii";

const ASV_MAGIC = "ASV1";
const ASP_MAGIC = "ASP1";

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bitsNeeded(n: number): number {
  return n <= 1 ? 1 : Math.ceil(Math.log2(n));
}

function writeUint32(buf: number[], v: number) {
  buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function writeUint16(buf: number[], v: number) {
  buf.push((v >> 8) & 0xff, v & 0xff);
}

function encodeString(buf: number[], s: string) {
  const b = new TextEncoder().encode(s);
  writeUint16(buf, b.length);
  b.forEach(x => buf.push(x));
}

function decodeString(data: Uint8Array, p: number): { s: string; p: number } {
  const len = (data[p++] << 8) | data[p++];
  const s = new TextDecoder().decode(data.slice(p, p + len));
  return { s, p: p + len };
}

interface FormatMetadata {
  charset: string;
  asciiW: number;
  asciiH: number;
  hasColor: boolean;
  fps?: number;
  optsJson?: string;
}

function encodeMetadata(meta: FormatMetadata): Uint8Array {
  const buf: number[] = [];
  encodeString(buf, meta.charset);
  writeUint16(buf, meta.asciiW);
  writeUint16(buf, meta.asciiH);
  buf.push(meta.hasColor ? 1 : 0);
  buf.push(meta.fps ?? 15);
  const json = meta.optsJson ?? "{}";
  encodeString(buf, json);
  return new Uint8Array(buf);
}

function decodeMetadata(data: Uint8Array, p: number): { meta: FormatMetadata; p: number } {
  let res = decodeString(data, p); p = res.p;
  const charset = res.s;
  const asciiW = (data[p++] << 8) | data[p++];
  const asciiH = (data[p++] << 8) | data[p++];
  const hasColor = data[p++] === 1;
  const fps = data[p++];
  res = decodeString(data, p); p = res.p;
  const optsJson = res.s;
  return { meta: { charset, asciiW, asciiH, hasColor, fps, optsJson }, p };
}

function packFrames(
  frames: AsciiFrame[],
  asciiW: number,
  asciiH: number,
  charset: string,
  hasColor: boolean
): Uint8Array {
  const nchars = charset.length;
  const bpc = bitsNeeded(nchars);
  const bitsPerFrame = asciiW * asciiH * bpc;
  const bytesPerIndexFrame = Math.ceil(bitsPerFrame / 8);
  const bytesPerColorFrame = hasColor ? asciiW * asciiH * 3 : 0;
  const total = frames.length * (bytesPerIndexFrame + bytesPerColorFrame);
  const out = new Uint8Array(total);
  let p = 0;

  for (const frame of frames) {
    let bitBuf = 0, bitCount = 0;
    for (let y = 0; y < asciiH; y++) {
      for (let x = 0; x < asciiW; x++) {
        const idx = frame[y]?.[x]?.charIdx ?? 0;
        bitBuf = (bitBuf << bpc) | idx;
        bitCount += bpc;
        while (bitCount >= 8) { bitCount -= 8; out[p++] = (bitBuf >> bitCount) & 0xff; }
      }
    }
    if (bitCount > 0) out[p++] = (bitBuf << (8 - bitCount)) & 0xff;

    if (hasColor) {
      for (let y = 0; y < asciiH; y++) {
        for (let x = 0; x < asciiW; x++) {
          const cell = frame[y]?.[x];
          out[p++] = cell?.r ?? 0;
          out[p++] = cell?.g ?? 0;
          out[p++] = cell?.b ?? 0;
        }
      }
    }
  }
  return out;
}

function unpackFrames(
  data: Uint8Array,
  p: number,
  frameCount: number,
  asciiW: number,
  asciiH: number,
  charset: string,
  hasColor: boolean
): { frames: number[][][]; colorFrames?: number[][][][]; p: number } {
  const nchars = charset.length;
  const bpc = bitsNeeded(nchars);
  const bytesPerIndexFrame = Math.ceil((asciiW * asciiH * bpc) / 8);
  const bytesPerColorFrame = hasColor ? asciiW * asciiH * 3 : 0;
  const mask = (1 << bpc) - 1;

  const frames: number[][][] = [];
  const colorFrames: number[][][][] = [];

  for (let f = 0; f < frameCount; f++) {
    const frame: number[][] = [];
    let bitBuf = 0, bitCount = 0, bytePos = p;
    for (let y = 0; y < asciiH; y++) {
      const row: number[] = [];
      for (let x = 0; x < asciiW; x++) {
        while (bitCount < bpc) { bitBuf = (bitBuf << 8) | data[bytePos++]; bitCount += 8; }
        bitCount -= bpc;
        row.push((bitBuf >> bitCount) & mask);
      }
      frame.push(row);
    }
    frames.push(frame);
    p += bytesPerIndexFrame;

    if (hasColor) {
      const cf: number[][][] = [];
      for (let y = 0; y < asciiH; y++) {
        const row: number[][] = [];
        for (let x = 0; x < asciiW; x++) {
          row.push([data[p++], data[p++], data[p++]]);
        }
        cf.push(row);
      }
      colorFrames.push(cf);
    }
  }
  return { frames, colorFrames: hasColor ? colorFrames : undefined, p };
}

export interface EncodedFile {
  data: Uint8Array;
  ext: string;
  mime: string;
}

export async function encodeAsv(
  frames: AsciiFrame[],
  charset: string,
  asciiW: number,
  asciiH: number,
  hasColor: boolean,
  fps: number,
  opts?: Partial<AsciiOptions>
): Promise<EncodedFile> {
  const buf: number[] = [];
  for (let i = 0; i < 4; i++) buf.push(ASV_MAGIC.charCodeAt(i));

  const meta = encodeMetadata({
    charset, asciiW, asciiH, hasColor, fps,
    optsJson: opts ? JSON.stringify(opts) : "{}",
  });
  writeUint16(buf, meta.length);
  meta.forEach(b => buf.push(b));
  writeUint32(buf, frames.length);

  const packed = packFrames(frames, asciiW, asciiH, charset, hasColor);
  const hdr = new Uint8Array(buf);
  const raw = new Uint8Array(hdr.length + packed.length);
  raw.set(hdr); raw.set(packed, hdr.length);

  const compressed = await gzip(raw);
  return { data: compressed, ext: "asv", mime: "application/octet-stream" };
}

export async function encodeAsp(
  frame: AsciiFrame,
  charset: string,
  asciiW: number,
  asciiH: number,
  hasColor: boolean,
  opts?: Partial<AsciiOptions>
): Promise<EncodedFile> {
  const buf: number[] = [];
  for (let i = 0; i < 4; i++) buf.push(ASP_MAGIC.charCodeAt(i));

  const meta = encodeMetadata({ charset, asciiW, asciiH, hasColor, optsJson: opts ? JSON.stringify(opts) : "{}" });
  writeUint16(buf, meta.length);
  meta.forEach(b => buf.push(b));

  const packed = packFrames([frame], asciiW, asciiH, charset, hasColor);
  const hdr = new Uint8Array(buf);
  const raw = new Uint8Array(hdr.length + packed.length);
  raw.set(hdr); raw.set(packed, hdr.length);

  const compressed = await gzip(raw);
  return { data: compressed, ext: "asp", mime: "application/octet-stream" };
}

export interface DecodedAsv {
  charset: string;
  asciiW: number;
  asciiH: number;
  hasColor: boolean;
  fps: number;
  frameCount: number;
  frames: number[][][];
  colorFrames?: number[][][][];
  opts?: Partial<AsciiOptions>;
  kind: "video" | "image";
}

export async function decodeAsvOrAsp(data: Uint8Array): Promise<DecodedAsv> {
  const raw = await gunzip(data);
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  if (magic !== ASV_MAGIC && magic !== ASP_MAGIC) throw new Error("Invalid file format");
  const kind: "video" | "image" = magic === ASP_MAGIC ? "image" : "video";
  let p = 4;

  const metaLen = (raw[p++] << 8) | raw[p++];
  const { meta, p: p2 } = decodeMetadata(raw, p);
  p = p + metaLen;

  let frameCount = 1;
  if (kind === "video") {
    frameCount = (raw[p++] << 24) | (raw[p++] << 16) | (raw[p++] << 8) | raw[p++];
  }

  const { frames, colorFrames } = unpackFrames(raw, p, frameCount, meta.asciiW, meta.asciiH, meta.charset, meta.hasColor);

  let opts: Partial<AsciiOptions> | undefined;
  try { opts = JSON.parse(meta.optsJson ?? "{}"); } catch { opts = undefined; }

  return {
    charset: meta.charset,
    asciiW: meta.asciiW,
    asciiH: meta.asciiH,
    hasColor: meta.hasColor,
    fps: meta.fps ?? 15,
    frameCount,
    frames,
    colorFrames,
    opts,
    kind,
  };
}

export function encodeFramesToText(
  frames: AsciiFrame[],
  charset: string,
  asciiW: number,
  asciiH: number
): string {
  const lines: string[] = [`ACASCII1 ${asciiW} ${asciiH} ${charset}`];
  for (const frame of frames) {
    for (const row of frame) lines.push(row.map(c => c.char).join(""));
    lines.push("---FRAME---");
  }
  return lines.join("\n");
}

export interface DecodedText {
  charset: string; asciiW: number; asciiH: number; frames: string[][];
}

export function decodeTextFrames(text: string): DecodedText {
  const lines = text.split("\n");
  const h = lines[0].split(" ");
  if (h[0] !== "ACASCII1") throw new Error("Invalid text format");
  const asciiW = parseInt(h[1], 10);
  const asciiH = parseInt(h[2], 10);
  const charset = h.slice(3).join(" ");
  const frames: string[][] = [];
  let cur: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---FRAME---") { if (cur.length) frames.push(cur); cur = []; }
    else if (line.length > 0 || cur.length < asciiH) cur.push(line);
  }
  if (cur.length) frames.push(cur);
  return { charset, asciiW, asciiH, frames };
}

export function textFramesToIndices(decoded: DecodedText): number[][][] {
  const ci = (ch: string) => { const i = decoded.charset.indexOf(ch); return i >= 0 ? i : 0; };
  const pad = decoded.charset[0] ?? " ";
  return decoded.frames.map(grid =>
    grid.map(row => Array.from(row.padEnd(decoded.asciiW, pad)).map(ci))
  );
}

export const loadAsv = decodeAsvOrAsp;
