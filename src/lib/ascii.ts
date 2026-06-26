import { initWasm, getWasmModule, isWasmAvailable } from './wasm-wrapper';

// Initialize WASM on module load
initWasm().catch(() => {});

export const DEFAULT_CHARSET = " .:-=+*#%@";

export interface AsciiCell {
  char: string;
  charIdx: number;
  r: number;
  g: number;
  b: number;
}

export type AsciiFrame = AsciiCell[][];

export interface AsciiOptions {
  charset: string;
  invert: boolean;
  brightness: number;
  contrast: number;
  gamma: number;
  threshold: number;
  noiseReduction: boolean;
  histEq: boolean;
  localContrast: boolean;
  edges: boolean;
  gradientDirs: boolean;
  dither: boolean;
  ditherMode: 'floyd' | 'bayer';
  color: boolean;
  colorMode: 'grayscale' | 'ansi256' | 'truecolor';
  asciiW?: number;
  asciiH?: number;
  temporalSmoothing?: boolean;
}

export const DEFAULT_OPTIONS: AsciiOptions = {
  charset: DEFAULT_CHARSET,
  invert: false,
  brightness: 0,
  contrast: 1,
  gamma: 1,
  threshold: 0,
  noiseReduction: false,
  histEq: false,
  localContrast: false,
  edges: false,
  gradientDirs: false,
  dither: false,
  ditherMode: 'floyd',
  color: false,
  colorMode: 'grayscale'
};

let prevFrame: Uint16Array | null = null;

export function resetTemporalSmoothing() {
  prevFrame = null;
}

export function sortCharsetByDensity(charset: string): string {
  return charset.split('').sort((a, b) => {
    const map: Record<string, number> = { ' ': 0, '.': 1, ':': 2, '-': 3, '=': 4, '+': 5, '*': 6, '#': 7, '%': 8, '@': 9 };
    return (map[a] ?? 0) - (map[b] ?? 0);
  }).join('');
}

export function getPoolCharIdx(): Uint16Array {
  return new Uint16Array(0);
}

export function getPoolDims(): { w: number; h: number } {
  return { w: 0, h: 0 };
}

export function processFrame(
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  offscreen: HTMLCanvasElement,
  opts: AsciiOptions,
  mirror: boolean = false
): AsciiFrame | null {
  try {
    let sw = 0, sh = 0;
    
    if (source instanceof HTMLVideoElement) {
      sw = source.videoWidth;
      sh = source.videoHeight;
    } else if (source instanceof HTMLImageElement) {
      sw = source.naturalWidth || source.width;
      sh = source.naturalHeight || source.height;
    } else {
      sw = source.width;
      sh = source.height;
    }
    
    if (!sw || !sh || sw <= 0 || sh <= 0) {
      return null;
    }
    
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    
    offscreen.width = sw;
    offscreen.height = sh;
    
    ctx.save();
    if (mirror) {
      ctx.translate(sw, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, 0, 0, sw, sh);
    ctx.restore();
    
    const imgData = ctx.getImageData(0, 0, sw, sh);
    const px = imgData.data;
    const N = sw * sh;
    
    const gray = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      gray[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
    }
    
    const charIdx = new Uint16Array(N);
    const nchars = opts.charset.length;
    
    for (let i = 0; i < N; i++) {
      let val = gray[i] + opts.brightness;
      val = ((val - 128) * opts.contrast) + 128;
      if (opts.gamma !== 1) {
        val = 255 * Math.pow(Math.max(0, val) / 255, 1 / opts.gamma);
      }
      val = Math.max(0, Math.min(255, val));
      
      let idx = Math.round((val / 255) * (nchars - 1));
      if (opts.invert) idx = (nchars - 1) - idx;
      charIdx[i] = Math.max(0, Math.min(nchars - 1, idx));
    }
    
    const asciiW = opts.asciiW || Math.min(sw, 120);
    const asciiH = opts.asciiH || Math.min(sh, 68);
    const scaleX = sw / asciiW;
    const scaleY = sh / asciiH;
    
    const frame: AsciiFrame = [];
    for (let ay = 0; ay < asciiH; ay++) {
      const row: AsciiCell[] = [];
      for (let ax = 0; ax < asciiW; ax++) {
        const sx = Math.min(Math.floor(ax * scaleX), sw - 1);
        const sy = Math.min(Math.floor(ay * scaleY), sh - 1);
        const idx = sy * sw + sx;
        const charIndex = charIdx[idx];
        const char = opts.charset[charIndex] || ' ';
        
        let r = 255, g = 255, b = 255;
        if (opts.color) {
          r = px[idx * 4];
          g = px[idx * 4 + 1];
          b = px[idx * 4 + 2];
        }
        
        row.push({ char, charIdx: charIndex, r, g, b });
      }
      frame.push(row);
    }
    
    return frame;
  } catch (err) {
    console.error('[ASCII] processFrame error:', err);
    return null;
  }
}

export function renderToString(
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  offscreen: HTMLCanvasElement,
  opts: AsciiOptions,
  mirror: boolean = false,
  format: 'text' | 'html' = 'text'
): { html: string; isColor: boolean } | null {
  try {
    const frame = processFrame(source, offscreen, opts, mirror);
    
    if (!frame || !Array.isArray(frame) || frame.length === 0) {
      return null;
    }
    
    if (!Array.isArray(frame[0])) {
      return null;
    }
    
    if (format === 'html' && opts.color) {
      let html = '';
      for (let i = 0; i < frame.length; i++) {
        const row = frame[i];
        for (let j = 0; j < row.length; j++) {
          const cell = row[j];
          html += `<span style="color:rgb(${cell.r},${cell.g},${cell.b})">${escapeHtml(cell.char)}</span>`;
        }
        html += '\n';
      }
      return { html, isColor: true };
    } else {
      const lines: string[] = [];
      for (let i = 0; i < frame.length; i++) {
        const row = frame[i];
        let line = '';
        for (let j = 0; j < row.length; j++) {
          line += row[j].char;
        }
        lines.push(line);
      }
      return { html: lines.join('\n'), isColor: false };
    }
  } catch (err) {
    console.error('[ASCII] renderToString error:', err);
    return null;
  }
}

export function frameToHtml(
  frame: AsciiFrame,
  opts: { color: boolean; fontSize?: number; fontFamily?: string }
): string {
  const fontSize = opts.fontSize || 12;
  const fontFamily = opts.fontFamily || 'monospace';
  let html = `<pre style="font-family: ${fontFamily}; font-size: ${fontSize}px; line-height: 1; margin: 0;">`;
  
  for (const row of frame) {
    if (opts.color) {
      for (const cell of row) {
        html += `<span style="color: rgb(${cell.r},${cell.g},${cell.b})">${escapeHtml(cell.char)}</span>`;
      }
    } else {
      for (const cell of row) {
        html += escapeHtml(cell.char);
      }
    }
    html += '\n';
  }
  
  html += '</pre>';
  return html;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function createOffscreenCanvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}

export function getAsciiDimensions(sourceW: number, sourceH: number, targetW: number, targetH: number) {
  const aspect = sourceW / sourceH;
  let asciiW = targetW;
  let asciiH = Math.round(targetW / aspect / 2);
  if (asciiH > targetH) {
    asciiH = targetH;
    asciiW = Math.round(targetH * aspect * 2);
  }
  return { asciiW, asciiH };
}
