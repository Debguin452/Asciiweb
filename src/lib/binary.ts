import type { AsciiFrame } from "./ascii";

const MAGIC = "ACB1";
const MAGIC2 = "ACB2";

const FLAG_KEYFRAME   = 0x01;
const FLAG_HAS_COLOR  = 0x02;
const FLAG_DELTA      = 0x04;

export interface RemoteFrame {
  w: number;
  h: number;
  charset: string;
  charIndices: Uint16Array;
  colors: Uint8Array | null;
  isKeyframe: boolean;
  timestamp: number;
}

function bitsNeeded(n: number): number {
  if (n <= 1) return 1;
  return Math.ceil(Math.log2(n));
}

function rleEncode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  
  const runs: Array<{ value: number; count: number }> = [];
  let cur = data[0];
  let count = 1;
  
  for (let i = 1; i < data.length; i++) {
    if (data[i] === cur && count < 255) {
      count++;
    } else {
      runs.push({ value: cur, count });
      cur = data[i];
      count = 1;
    }
  }
  runs.push({ value: cur, count });
  
  const out = new Uint8Array(runs.length * 2);
  for (let i = 0; i < runs.length; i++) {
    out[i * 2] = runs[i].count;
    out[i * 2 + 1] = runs[i].value;
  }
  return out;
}

function rleDecode(data: Uint8Array, expectedLen: number): Uint8Array {
  const out = new Uint8Array(expectedLen);
  let pos = 0;
  let outPos = 0;
  
  while (pos < data.length && outPos < expectedLen) {
    const count = data[pos++];
    const value = data[pos++];
    for (let i = 0; i < count && outPos < expectedLen; i++) {
      out[outPos++] = value;
    }
  }
  
  return out;
}

function encodeDelta(
  curr: Uint16Array, 
  prev: Uint16Array,
  bitsPerChar: number
): Uint8Array {
  const changes: number[] = [];
  const mask = (1 << bitsPerChar) - 1;
  
  for (let i = 0; i < curr.length; i++) {
    if (curr[i] !== prev[i]) {
      changes.push(i);
      changes.push(curr[i] & mask);
    }
  }
  
  const out = new Uint8Array(2 + changes.length * 2);
  out[0] = (changes.length / 2) >> 8;
  out[1] = (changes.length / 2) & 0xff;
  for (let i = 0; i < changes.length; i++) {
    out[2 + i] = changes[i] & 0xff;
  }
  
  return out;
}

function decodeDelta(
  data: Uint8Array,
  prev: Uint16Array,
  offset: number
): { indices: Uint16Array; bytesRead: number } {
  const changeCount = (data[offset] << 8) | data[offset + 1];
  const indices = new Uint16Array(prev);
  let pos = offset + 2;
  
  for (let i = 0; i < changeCount && pos + 1 < data.length; i++) {
    const idx = data[pos++];
    const val = data[pos++];
    if (idx < indices.length) {
      indices[idx] = val;
    }
  }
  
  return { indices, bytesRead: pos - offset };
}

export function encode(
  charIndices: Uint16Array,
  w: number,
  h: number,
  charset: string,
  colors: Uint8Array | null,
  prevIndices: Uint16Array | null,
  prevColors: Uint8Array | null
): ArrayBuffer {
  const nchars = charset.length;
  const bitsPerChar = bitsNeeded(nchars);
  const N = w * h;
  
  const useDelta = prevIndices !== null && 
                   prevIndices.length === N &&
                   charIndices.length === N;
  
  let flags = FLAG_KEYFRAME;
  if (colors) flags |= FLAG_HAS_COLOR;
  if (useDelta) {
    flags &= ~FLAG_KEYFRAME;
    flags |= FLAG_DELTA;
  }
  
  const charsetBytes = new TextEncoder().encode(charset);
  
  let payloadSize: number;
  let payload: Uint8Array;
  
  if (useDelta && prevIndices) {
    const deltaData = encodeDelta(charIndices, prevIndices, bitsPerChar);
    
    let colorDelta: Uint8Array | null = null;
    if (colors && prevColors && colors.length === prevColors.length) {
      const colorDiff = new Uint8Array(colors.length);
      let hasChanges = false;
      for (let i = 0; i < colors.length; i++) {
        colorDiff[i] = colors[i] ^ prevColors[i];
        if (colorDiff[i] !== 0) hasChanges = true;
      }
      colorDelta = hasChanges ? rleEncode(colorDiff) : new Uint8Array(0);
    }
    
    const colorSize = colorDelta ? 2 + colorDelta.length : 0;
    payload = new Uint8Array(deltaData.length + colorSize);
    payload.set(deltaData, 0);
    if (colorDelta) {
      payload[deltaData.length] = (colorDelta.length >> 8) & 0xff;
      payload[deltaData.length + 1] = colorDelta.length & 0xff;
      payload.set(colorDelta, deltaData.length + 2);
    }
    payloadSize = payload.length;
  } else {
    const bytesForIndices = Math.ceil((N * bitsPerChar) / 8);
    const bytesForColors = colors ? N * 3 : 0;
    payloadSize = bytesForIndices + bytesForColors;
    payload = new Uint8Array(payloadSize);
    
    let bitBuf = 0;
    let bitCount = 0;
    let pos = 0;
    
    for (let i = 0; i < N; i++) {
      const idx = charIndices[i] & ((1 << bitsPerChar) - 1);
      bitBuf = (bitBuf << bitsPerChar) | idx;
      bitCount += bitsPerChar;
      
      while (bitCount >= 8) {
        bitCount -= 8;
        payload[pos++] = (bitBuf >> bitCount) & 0xff;
      }
    }
    
    if (bitCount > 0) {
      payload[pos++] = (bitBuf << (8 - bitCount)) & 0xff;
    }
    
    if (colors) {
      payload.set(colors.subarray(0, N * 3), pos);
    }
  }
  
  const headerSize = 1 + 2 + 2 + 1 + charsetBytes.length + 1;
  const totalSize = headerSize + payloadSize;
  const out = new Uint8Array(totalSize);
  let p = 0;
  
  out[p++] = flags;
  out[p++] = (w >> 8) & 0xff;
  out[p++] = w & 0xff;
  out[p++] = (h >> 8) & 0xff;
  out[p++] = h & 0xff;
  out[p++] = charsetBytes.length;
  out.set(charsetBytes, p);
  p += charsetBytes.length;
  out[p++] = colors ? 1 : 0;
  out.set(payload, p);
  
  return out.buffer;
}

export function decode(
  buffer: ArrayBuffer,
  prevFrame: RemoteFrame | null
): RemoteFrame | null {
  const data = new Uint8Array(buffer);
  if (data.length < 7) return null;
  
  let p = 0;
  const flags = data[p++];
  const isKeyframe = (flags & FLAG_KEYFRAME) !== 0;
  const hasColor = (flags & FLAG_HAS_COLOR) !== 0;
  const isDelta = (flags & FLAG_DELTA) !== 0;
  
  const w = (data[p++] << 8) | data[p++];
  const h = (data[p++] << 8) | data[p++];
  const N = w * h;
  
  const charsetLen = data[p++];
  if (p + charsetLen > data.length) return null;
  const charset = new TextDecoder().decode(data.slice(p, p + charsetLen));
  p += charsetLen;
  
  const hasColorFlag = data[p++];
  const nchars = charset.length;
  const bitsPerChar = bitsNeeded(nchars);
  
  let charIndices: Uint16Array;
  let colors: Uint8Array | null = null;
  
  if (isDelta && prevFrame && !isKeyframe) {
    if (prevFrame.w !== w || prevFrame.h !== h) {
      return null;
    }
    
    const { indices, bytesRead } = decodeDelta(data, prevFrame.charIndices, p);
    charIndices = indices;
    p += bytesRead;
    
    if (hasColorFlag && prevFrame.colors) {
      if (p + 2 <= data.length) {
        const colorDeltaLen = (data[p] << 8) | data[p + 1];
        p += 2;
        
        if (colorDeltaLen > 0 && p + colorDeltaLen <= data.length) {
          const colorDelta = data.slice(p, p + colorDeltaLen);
          const decoded = rleDecode(colorDelta, prevFrame.colors.length);
          
          colors = new Uint8Array(prevFrame.colors.length);
          for (let i = 0; i < colors.length; i++) {
            colors[i] = prevFrame.colors[i] ^ decoded[i];
          }
        } else {
          colors = new Uint8Array(prevFrame.colors);
        }
      } else {
        colors = new Uint8Array(prevFrame.colors);
      }
    } else if (hasColorFlag) {
      colors = null;
    }
  } else {
    charIndices = new Uint16Array(N);
    const mask = (1 << bitsPerChar) - 1;
    
    let bitBuf = 0;
    let bitCount = 0;
    
    for (let i = 0; i < N; i++) {
      while (bitCount < bitsPerChar && p < data.length) {
        bitBuf = (bitBuf << 8) | data[p++];
        bitCount += 8;
      }
      
      if (bitCount >= bitsPerChar) {
        bitCount -= bitsPerChar;
        charIndices[i] = (bitBuf >> bitCount) & mask;
      }
    }
    
    if (hasColorFlag && hasColor) {
      const colorBytes = N * 3;
      if (p + colorBytes <= data.length) {
        colors = new Uint8Array(data.slice(p, p + colorBytes));
        p += colorBytes;
      }
    }
  }
  
  return {
    w,
    h,
    charset,
    charIndices,
    colors,
    isKeyframe,
    timestamp: performance.now(),
  };
}

export function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data instanceof Uint16Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data instanceof Uint32Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data instanceof Int8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data instanceof Int16Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data instanceof Int32Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data instanceof Float32Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data instanceof Float64Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data instanceof DataView) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (typeof data === "object" && data !== null && "buffer" in data) {
    const buf = (data as { buffer: ArrayBuffer }).buffer;
    if (buf instanceof ArrayBuffer) return buf;
  }
  return null;
}

export function bitsNeededForExport(n: number): number {
  if (n <= 1) return 1;
  return Math.ceil(Math.log2(n));
}

export function encodeFramesToBinary(
  frames: AsciiFrame[],
  charset: string,
  asciiW: number,
  asciiH: number,
  includeColor = false
): Uint8Array {
  const charsetBytes = new TextEncoder().encode(charset);
  const bitsPerChar = bitsNeededForExport(charset.length);
  const bytesPerIndexFrame = Math.ceil((asciiW * asciiH * bitsPerChar) / 8);
  const bytesPerColorFrame = includeColor ? asciiW * asciiH * 3 : 0;
  const bytesPerFrame = bytesPerIndexFrame + bytesPerColorFrame;

  const headerLen = 4 + 1 + charsetBytes.length + 2 + 2 + 4 + 1 + 1;
  const total = headerLen + bytesPerFrame * frames.length;
  const out = new Uint8Array(total);
  let p = 0;

  const magic = includeColor ? MAGIC2 : MAGIC;
  for (let i = 0; i < 4; i++) out[p++] = magic.charCodeAt(i);
  out[p++] = charsetBytes.length;
  out.set(charsetBytes, p);
  p += charsetBytes.length;
  out[p++] = (asciiW >> 8) & 0xff;
  out[p++] = asciiW & 0xff;
  out[p++] = (asciiH >> 8) & 0xff;
  out[p++] = asciiH & 0xff;
  out[p++] = (frames.length >>> 24) & 0xff;
  out[p++] = (frames.length >>> 16) & 0xff;
  out[p++] = (frames.length >>> 8) & 0xff;
  out[p++] = frames.length & 0xff;
  out[p++] = bitsPerChar;
  out[p++] = includeColor ? 1 : 0;

  for (const frame of frames) {
    let bitBuf = 0;
    let bitCount = 0;
    for (let y = 0; y < asciiH; y++) {
      for (let x = 0; x < asciiW; x++) {
        const idx = frame[y][x].charIdx;
        bitBuf = (bitBuf << bitsPerChar) | idx;
        bitCount += bitsPerChar;
        while (bitCount >= 8) {
          bitCount -= 8;
          out[p++] = (bitBuf >> bitCount) & 0xff;
        }
      }
    }
    if (bitCount > 0) {
      out[p++] = (bitBuf << (8 - bitCount)) & 0xff;
    }

    if (includeColor) {
      for (let y = 0; y < asciiH; y++) {
        for (let x = 0; x < asciiW; x++) {
          const cell = frame[y][x];
          out[p++] = cell.r;
          out[p++] = cell.g;
          out[p++] = cell.b;
        }
      }
    }
  }

  return out;
}

export interface DecodedBinary {
  charset: string;
  asciiW: number;
  asciiH: number;
  frameCount: number;
  bitsPerChar: number;
  hasColor: boolean;
  frames: number[][][];
  colorFrames?: Uint8Array[];
}

export function decodeBinaryFrames(data: Uint8Array): DecodedBinary {
  let p = 0;
  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (magic !== MAGIC && magic !== MAGIC2) throw new Error("Invalid file: bad magic header");
  const hasColor = magic === MAGIC2;
  p += 4;

  const charsetLen = data[p++];
  const charset = new TextDecoder().decode(data.slice(p, p + charsetLen));
  p += charsetLen;

  const asciiW = (data[p++] << 8) | data[p++];
  const asciiH = (data[p++] << 8) | data[p++];
  const frameCount =
    (data[p++] << 24) | (data[p++] << 16) | (data[p++] << 8) | data[p++];
  const bitsPerChar = data[p++];
  const colorFlag = data[p++];
  const fileHasColor = hasColor && colorFlag === 1;

  const bytesPerIndexFrame = Math.ceil((asciiW * asciiH * bitsPerChar) / 8);
  const bytesPerColorFrame = fileHasColor ? asciiW * asciiH * 3 : 0;
  const mask = (1 << bitsPerChar) - 1;

  const frames: number[][][] = [];
  const colorFrames: Uint8Array[] = [];

  for (let f = 0; f < frameCount; f++) {
    const frame: number[][] = [];
    let bitBuf = 0;
    let bitCount = 0;
    let bytePos = p;
    for (let y = 0; y < asciiH; y++) {
      const row: number[] = [];
      for (let x = 0; x < asciiW; x++) {
        while (bitCount < bitsPerChar) {
          bitBuf = (bitBuf << 8) | data[bytePos++];
          bitCount += 8;
        }
        bitCount -= bitsPerChar;
        const idx = (bitBuf >> bitCount) & mask;
        row.push(idx);
      }
      frame.push(row);
    }
    frames.push(frame);
    p += bytesPerIndexFrame;

    if (fileHasColor) {
      colorFrames.push(data.slice(p, p + bytesPerColorFrame));
      p += bytesPerColorFrame;
    }
  }

  return {
    charset, asciiW, asciiH, frameCount, bitsPerChar,
    hasColor: fileHasColor,
    frames,
    colorFrames: fileHasColor ? colorFrames : undefined,
  };
}

export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export function encodeFramesToText(
  frames: AsciiFrame[],
  charset: string,
  asciiW: number,
  asciiH: number
): string {
  const lines: string[] = [`ACASCII1 ${asciiW} ${asciiH} ${charset}`];
  for (const frame of frames) {
    for (const row of frame) {
      lines.push(row.map(c => c.char).join(""));
    }
    lines.push("---FRAME---");
  }
  return lines.join("\n");
}

export interface DecodedText {
  charset: string;
  asciiW: number;
  asciiH: number;
  frames: string[][];
}

export function decodeTextFrames(text: string): DecodedText {
  const lines = text.split("\n");
  const header = lines[0].split(" ");
  if (header[0] !== "ACASCII1") throw new Error("Invalid file: bad text header");
  const asciiW = parseInt(header[1], 10);
  const asciiH = parseInt(header[2], 10);
  const charset = header.slice(3).join(" ");

  const frames: string[][] = [];
  let current: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---FRAME---") {
      if (current.length > 0) frames.push(current);
      current = [];
    } else if (line.length > 0 || current.length < asciiH) {
      current.push(line);
    }
  }
  if (current.length > 0) frames.push(current);

  return { charset, asciiW, asciiH, frames };
}

export function textFramesToIndices(decoded: DecodedText): number[][][] {
  const charIdx = (ch: string) => {
    const idx = decoded.charset.indexOf(ch);
    return idx >= 0 ? idx : 0;
  };
  const pad = decoded.charset[0] ?? " ";
  return decoded.frames.map(grid =>
    grid.map(row => Array.from(row.padEnd(decoded.asciiW, pad)).map(charIdx))
  );
}
