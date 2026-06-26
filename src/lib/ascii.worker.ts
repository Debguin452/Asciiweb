/**
 * AsciiWeb - Web Worker for ASCII Processing
 * Updated with WASM acceleration support
 */

import { 
  initWasm, 
  isWasmAvailable, 
  processWithWasm,
  toGrayscaleJS,
  gaussianBlurJS,
  mapToCharsetJS,
  type WasmProcessingOptions 
} from './wasm-wrapper';

let wasmReady = false;
let frameCount = 0;
let lastFrameTime = 0;
let processingTime = 0;

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;
  
  switch (type) {
    case 'init':
      await initWasm();
      wasmReady = isWasmAvailable();
      self.postMessage({ 
        type: 'ready', 
        wasmAvailable: wasmReady 
      });
      break;
      
    case 'frame':
      processFrame(data);
      break;
      
    case 'ping':
      self.postMessage({ type: 'pong', timestamp: performance.now() });
      break;
  }
};

interface FrameData {
  pixels: Uint8Array;
  pixW: number;
  pixH: number;
  opts: {
    charset: string;
    brightness: number;
    contrast: number;
    gamma: number;
    invert: boolean;
    threshold: number;
    dither: boolean;
    ditherMode: 'floyd' | 'bayer';
    noiseReduction: boolean;
    histEq: boolean;
    localContrast: boolean;
    edges: boolean;
    gradientDirs: string[];
    colorMode: string;
  };
  timestamp: number;
}

function processFrame(data: FrameData) {
  const startTime = performance.now();
  
  const { pixels, pixW, pixH, opts, timestamp } = data;
  
  let charIdx: Uint16Array;
  let gray: Uint8Array;
  let colors: Uint8Array | null = null;
  
  if (wasmReady && isWasmAvailable()) {
    const wasmOpts: WasmProcessingOptions = {
      brightness: opts.brightness,
      contrast: opts.contrast,
      gamma: opts.gamma,
      invert: opts.invert,
      threshold: opts.threshold,
      blur: opts.noiseReduction,
      histEq: opts.histEq,
      localContrast: opts.localContrast,
      ditherMode: opts.dither ? (opts.ditherMode === 'bayer' ? 2 : 1) : 0,
      edges: opts.edges || (opts.gradientDirs && opts.gradientDirs.length > 0),
    };
    
    const result = processWithWasm(pixels, pixW, pixH, opts.charset.length, wasmOpts);
    
    if (result) {
      charIdx = result.indices;
      gray = result.gray;
      
      if (opts.colorMode !== 'grayscale') {
        colors = extractColors(pixels, pixW, pixH);
      }
    } else {
      const jsResult = processFrameJS(pixels, pixW, pixH, opts);
      charIdx = jsResult.charIdx;
      gray = jsResult.gray;
      colors = jsResult.colors;
    }
  } else {
    const jsResult = processFrameJS(pixels, pixW, pixH, opts);
    charIdx = jsResult.charIdx;
    gray = jsResult.gray;
    colors = jsResult.colors;
  }
  
  processingTime = performance.now() - startTime;
  frameCount++;
  
  self.postMessage({
    type: 'result',
    charIdx,
    gray,
    colors,
    outW: pixW,
    outH: pixH,
    timestamp,
    processingTime,
    frameCount,
    wasmUsed: wasmReady,
  }, [charIdx.buffer, gray.buffer, colors?.buffer].filter(Boolean) as Transferable[]);
}

function processFrameJS(
  pixels: Uint8Array, 
  pixW: number, 
  pixH: number, 
  opts: FrameData['opts']
): { charIdx: Uint16Array; gray: Uint8Array; colors: Uint8Array | null } {
  let gray = toGrayscaleJS(pixels);
  
  if (Math.abs(opts.brightness) > 0.01) {
    const factor = Math.max(0, Math.min(3, opts.brightness + 1));
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.max(0, Math.min(255, Math.round(gray[i] * factor)));
    }
  }
  
  if (Math.abs(opts.contrast) > 0.01) {
    const factor = Math.max(0, Math.min(10, (259 * (opts.contrast * 255 + 255)) / (255 * (259 - opts.contrast * 255))));
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.max(0, Math.min(255, Math.round(factor * (gray[i] - 128) + 128)));
    }
  }
  
  if (Math.abs(opts.gamma - 1) > 0.01) {
    const gammaInv = 1 / Math.max(0.1, Math.min(5, opts.gamma));
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.max(0, Math.min(255, Math.round(255 * Math.pow(gray[i] / 255, gammaInv))));
    }
  }
  
  if (opts.noiseReduction) {
    gray = gaussianBlurJS(gray, pixW, pixH);
  }
  
  const charIdx = mapToCharsetJS(gray, opts.charset.length, opts.invert);
  
  let colors: Uint8Array | null = null;
  if (opts.colorMode !== 'grayscale') {
    colors = extractColors(pixels, pixW, pixH);
  }
  
  return { charIdx, gray, colors };
}

function extractColors(px: Uint8Array, w: number, h: number): Uint8Array {
  const colors = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    colors[i * 3] = px[i * 4];
    colors[i * 3 + 1] = px[i * 4 + 1];
    colors[i * 3 + 2] = px[i * 4 + 2];
  }
  return colors;
}

self.addEventListener('message', (e) => {
  if (e.data.type === 'getStats') {
    self.postMessage({
      type: 'stats',
      frameCount,
      processingTime,
      wasmAvailable: wasmReady,
    });
  }
});
