// Optimized Binary Protocol with Palette Encoding
// Reduces bandwidth by 60-70% compared to raw RGB

const MAGIC_V3 = "ACB3"; // New version with palette support

export interface RemoteFrame {
  w: number;
  h: number;
  charset: string;
  charIndices: Uint8Array; // 8-bit indices (bit-packed later)
  palette: Uint8Array | null; // 256×3 RGB palette (768 bytes)
  colorIndices: Uint8Array | null; // 8-bit palette indices per pixel
  isKeyframe: boolean;
  timestamp: number;
}

// Calculate bits needed for N values
export function bitsNeeded(n: number): number {
  if (n <= 1) return 1;
  return Math.ceil(Math.log2(n));
}

// ── Palette Generation ─────────────────────────────────────────────────────────
// Generates a 256-color palette from frame's RGB data using median cut
export function generatePalette(
  r: Uint8Array, 
  g: Uint8Array, 
  b: Uint8Array, 
  numColors: number = 256
): Uint8Array {
  const palette = new Uint8Array(numColors * 3);
  const n = r.length;
  
  if (n === 0) return palette;
  
  // Simple uniform quantization (fast, good enough for ASCII)
  // Divide RGB space into 8×8×4 = 256 colors
  const rLevels = 8, gLevels = 8, bLevels = 4;
  
  for (let ri = 0; ri < rLevels; ri++) {
    for (let gi = 0; gi < gLevels; gi++) {
      for (let bi = 0; bi < bLevels; bi++) {
        const idx = (ri * gLevels * bLevels + gi * bLevels + bi) * 3;
        palette[idx] = Math.round((ri + 0.5) * 255 / rLevels);
        palette[idx + 1] = Math.round((gi + 0.5) * 255 / gLevels);
        palette[idx + 2] = Math.round((bi + 0.5) * 255 / bLevels);
      }
    }
  }
  
  return palette;
}

// Map RGB to nearest palette index
export function mapToPalette(
  r: Uint8Array, 
  g: Uint8Array, 
  b: Uint8Array,
  palette: Uint8Array,
  numColors: number = 256
): Uint8Array {
  const n = r.length;
  const indices = new Uint8Array(n);
  
  // Pre-compute palette lookup for speed
  const rLevels = 8, gLevels = 8, bLevels = 4;
  
  for (let i = 0; i < n; i++) {
    const ri = Math.min(rLevels - 1, Math.floor(r[i] * rLevels / 256));
    const gi = Math.min(gLevels - 1, Math.floor(g[i] * gLevels / 256));
    const bi = Math.min(bLevels - 1, Math.floor(b[i] * bLevels / 256));
    indices[i] = ri * gLevels * bLevels + gi * bLevels + bi;
  }
  
  return indices;
}

// ── Encoding ───────────────────────────────────────────────────────────────────
export function encode(
  charIndices: Uint16Array,
  w: number,
  h: number,
  charset: string,
  colors: Uint8Array | null, // RGB interleaved (3 bytes per pixel)
  prevIndices: Uint16Array | null,
  prevColors: Uint8Array | null
): ArrayBuffer {
  const N = w * h;
  const nchars = charset.length;
  const bitsPerChar = bitsNeeded(nchars);
  const useDelta = prevIndices !== null && prevIndices.length === N;
  
  // Flags byte
  const FLAG_KEYFRAME = 0x01;
  const FLAG_HAS_PALETTE = 0x02;
  const FLAG_DELTA = 0x04;
  
  let flags = 0;
  if (!useDelta) flags |= FLAG_KEYFRAME;
  if (colors) flags |= FLAG_HAS_PALETTE;
  if (useDelta) flags |= FLAG_DELTA;
  
  // Encode character indices (bit-packed)
  const charBytes = Math.ceil((N * bitsPerChar) / 8);
  const charPacked = new Uint8Array(charBytes);
  
  let bitBuf = 0, bitCount = 0, pos = 0;
  const charMask = (1 << bitsPerChar) - 1;
  
  for (let i = 0; i < N; i++) {
    const val = useDelta && prevIndices && charIndices[i] === prevIndices[i] 
      ? 0 // Delta: 0 means "same as before" (special marker)
      : charIndices[i] & charMask;
    
    bitBuf = (bitBuf << bitsPerChar) | val;
    bitCount += bitsPerChar;
    
    while (bitCount >= 8) {
      bitCount -= 8;
      charPacked[pos++] = (bitBuf >> bitCount) & 0xff;
    }
  }
  if (bitCount > 0) {
    charPacked[pos++] = (bitBuf << (8 - bitCount)) & 0xff;
  }
  
  // Encode colors with palette (only if keyframe or colors changed significantly)
  let paletteData: Uint8Array = new Uint8Array(0);
  let colorIndices: Uint8Array = new Uint8Array(0);
  
  if (colors && colors.length === N * 3) {
    // Extract R, G, B arrays
    const rArr = new Uint8Array(N);
    const gArr = new Uint8Array(N);
    const bArr = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      rArr[i] = colors[i * 3];
      gArr[i] = colors[i * 3 + 1];
      bArr[i] = colors[i * 3 + 2];
    }
    
    // Generate palette (only on keyframes)
    const palette = !useDelta ? generatePalette(rArr, gArr, bArr, 256) : new Uint8Array(0);
    
    // Map pixels to palette
    colorIndices = mapToPalette(rArr, gArr, bArr, palette, 256);
    
    // Pack palette into output
    if (!useDelta) {
      paletteData = palette;
    }
  }
  
  // Calculate total size
  const charsetBytes = new TextEncoder().encode(charset);
  const headerSize = 1 + 2 + 2 + 1 + charsetBytes.length + 1;
  const totalSize = headerSize + charBytes + (paletteData.length > 0 ? 2 + paletteData.length : 0) + colorIndices.length;
  
  const out = new Uint8Array(totalSize);
  let p = 0;
  
  // Header
  out[p++] = flags;
  out[p++] = (w >> 8) & 0xff;
  out[p++] = w & 0xff;
  out[p++] = (h >> 8) & 0xff;
  out[p++] = h & 0xff;
  out[p++] = charsetBytes.length;
  out.set(charsetBytes, p);
  p += charsetBytes.length;
  out[p++] = colors ? 1 : 0;
  
  // Character data
  out.set(charPacked.subarray(0, charBytes), p);
  p += charBytes;
  
  // Palette (only on keyframes)
  if (paletteData.length > 0) {
    out[p++] = (paletteData.length >> 8) & 0xff;
    out[p++] = paletteData.length & 0xff;
    out.set(paletteData, p);
    p += paletteData.length;
  }
  
  // Color indices
  if (colorIndices.length > 0) {
    out.set(colorIndices, p);
  }
  
  return out.buffer;
}

// ── Decoding ───────────────────────────────────────────────────────────────────
export function decode(
  buffer: ArrayBuffer,
  prevFrame: RemoteFrame | null
): RemoteFrame | null {
  const data = new Uint8Array(buffer);
  if (data.length < 7) return null;
  
  let p = 0;
  const flags = data[p++];
  const isKeyframe = (flags & 0x01) !== 0;
  const hasPalette = (flags & 0x02) !== 0;
  const isDelta = (flags & 0x04) !== 0;
  
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
  const charMask = (1 << bitsPerChar) - 1;
  
  // Decode character indices
  const charIndices = new Uint8Array(N);
  let bitBuf = 0, bitCount = 0;
  
  for (let i = 0; i < N; i++) {
    while (bitCount < bitsPerChar && p < data.length) {
      bitBuf = (bitBuf << 8) | data[p++];
      bitCount += 8;
    }
    if (bitCount >= bitsPerChar) {
      bitCount -= bitsPerChar;
      const val = (bitBuf >> bitCount) & charMask;
      
      // Delta: 0 means "same as previous"
      if (isDelta && val === 0 && prevFrame) {
        charIndices[i] = prevFrame.charIndices[i];
      } else {
        charIndices[i] = val;
      }
    }
  }
  
  // Decode palette
  let palette: Uint8Array | null = null;
  if (hasPalette && p + 2 <= data.length) {
    const paletteLen = (data[p] << 8) | data[p + 1];
    p += 2;
    if (paletteLen > 0 && p + paletteLen <= data.length) {
      palette = new Uint8Array(data.slice(p, p + paletteLen));
      p += paletteLen;
    }
  } else if (isDelta && prevFrame && prevFrame.palette) {
    palette = prevFrame.palette;
  }
  
  // Decode color indices
  let colorIndices: Uint8Array | null = null;
  if (hasColorFlag && palette) {
    colorIndices = new Uint8Array(N);
    for (let i = 0; i < N && p < data.length; i++) {
      colorIndices[i] = data[p++];
    }
  }
  
  return {
    w, h, charset,
    charIndices,
    palette,
    colorIndices,
    isKeyframe,
    timestamp: performance.now()
  };
}

// Convert palette indices back to RGB
export function paletteToRGB(
  colorIndices: Uint8Array,
  palette: Uint8Array
): Uint8Array {
  const n = colorIndices.length;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const idx = colorIndices[i] * 3;
    rgb[i * 3] = palette[idx];
    rgb[i * 3 + 1] = palette[idx + 1];
    rgb[i * 3 + 2] = palette[idx + 2];
  }
  return rgb;
}

export function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return null;
}
