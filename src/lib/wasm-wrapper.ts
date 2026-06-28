interface WasmExports {
  memory: WebAssembly.Memory;
  alloc_buffers: (maxPixels: number) => void;
  pixels_ptr: () => number;
  gray_ptr: () => number;
  color_idx_ptr: () => number;
  packed_ptr: () => number;
  delta_ptr: () => number;
  palette_ptr: () => number;
  process_pipeline: (w: number, h: number, brightness: number, contrast: number, gamma: number, applySobel: boolean) => void;
  quantize_to_char_indices: (n: number, nchars: number, threshold: number, invert: boolean) => void;
  map_to_palette: (w: number, h: number) => void;
  generate_palette: () => void;
  delta_color_indices: (n: number, breakevenRatio: number) => number;
  delta_char_indices: (n: number, breakevenRatio: number) => number;
  commit_color_frame: (n: number) => void;
  commit_char_frame: (n: number) => void;
  reset_delta_history: () => void;
  pack_char_indices: (n: number, bitsPerChar: number) => number;
  greet: () => string;
}

let wasmModule: WasmExports | null = null;
let wasmAvailable = false;
let wasmReady = false;
let wasmInitPromise: Promise<void> | null = null;
let wasmError: string | null = null;
let allocatedCapacity = 0;

const MAX_FRAME_PIXELS = 200 * 140; // generous ceiling for any call/preview resolution this app uses

export async function initWasm(): Promise<void> {
  if (wasmInitPromise) return wasmInitPromise;
  wasmInitPromise = (async () => {
    try {
      const wasmPath = '/wasm/asciiweb_wasm.js';
      const wasm = await import(/* @vite-ignore */ wasmPath);
      if (wasm.default && typeof wasm.default === 'function') {
        await wasm.default('/wasm/asciiweb_wasm_bg.wasm');
      }
      wasmModule = wasm as WasmExports;
      wasmModule.alloc_buffers(MAX_FRAME_PIXELS); // throws + falls back cleanly if this is a pre-rewrite .wasm binary
      allocatedCapacity = MAX_FRAME_PIXELS;
      wasmAvailable = true;
      wasmReady = true;
    } catch (err) {
      wasmError = err instanceof Error ? err.message : String(err);
      wasmAvailable = false;
      if (wasmError.includes('is not a function')) {
        console.warn('[asciiweb] Loaded .wasm binary is missing expected exports — rebuild wasm-module/ to enable WASM acceleration. Falling back to JS.');
      }
    }
  })();
  return wasmInitPromise;
}

export function isWasmAvailable(): boolean { return wasmReady && wasmAvailable && wasmModule !== null; }
export function isWasmLoading(): boolean { return wasmInitPromise !== null && !wasmReady; }

function requireWasm(): WasmExports {
  if (!wasmReady || !wasmModule) throw new Error('WASM not ready');
  return wasmModule;
}

export function getWasmStatus() {
  return {
    available: wasmAvailable, ready: wasmReady, loading: isWasmLoading(),
    error: wasmError,
    functions: wasmModule ? Object.keys(wasmModule).filter(k => typeof (wasmModule as unknown as Record<string, unknown>)[k] === 'function') : []
  };
}

/** Ensures the WASM-side scratch buffers can hold at least `n` pixels. */
export function ensureWasmCapacity(n: number): boolean {
  const wasm = requireWasm();
  if (n > allocatedCapacity) {
    wasm.alloc_buffers(n);
    allocatedCapacity = n;
  }
  return true;
}

/**
 * Writes RGBA pixel data directly into WASM linear memory — no JS-side
 * array gets passed across the call boundary, so there's no
 * malloc+copy-in on every frame the way the old process_full_pipeline(px,
 * ...) call used to do.
 */
export function writePixelsToWasm(px: Uint8ClampedArray | Uint8Array, n: number): void {
  const wasm = requireWasm();
  ensureWasmCapacity(n);
  const ptr = wasm.pixels_ptr();
  const view = new Uint8Array(wasm.memory.buffer, ptr, n * 4);
  view.set(px.subarray(0, n * 4));
}

/** Runs the grayscale/brightness/contrast/gamma(/sobel) pipeline in place. */
export function wasmProcessPipeline(w: number, h: number, brightness: number, contrast: number, gamma: number, applySobel: boolean): void {
  requireWasm().process_pipeline(w, h, brightness, contrast, gamma, applySobel);
}

/** Reads the grayscale result directly out of WASM memory (no copy-out call needed; caller decides if/how to copy onward). */
export function readWasmGray(n: number): Uint8Array {
  const wasm = requireWasm();
  const ptr = wasm.gray_ptr();
  return new Uint8Array(wasm.memory.buffer, ptr, n);
}

export function wasmQuantizeToCharIndices(n: number, nchars: number, threshold: number, invert: boolean): void {
  requireWasm().quantize_to_char_indices(n, nchars, threshold, invert);
}

export function wasmMapToPalette(w: number, h: number): void {
  requireWasm().map_to_palette(w, h);
}

export function readWasmColorIndices(n: number): Uint8Array {
  const wasm = requireWasm();
  return new Uint8Array(wasm.memory.buffer, wasm.color_idx_ptr(), n);
}

export function wasmGeneratePalette(): void {
  requireWasm().generate_palette();
}

export function readWasmPalette(): Uint8Array {
  const wasm = requireWasm();
  return new Uint8Array(wasm.memory.buffer, wasm.palette_ptr(), 256 * 3).slice();
}

/** Returns the delta byte length, or null if a keyframe should be sent instead. */
export function wasmDeltaColorIndices(n: number, breakevenRatio: number): Uint8Array | null {
  const wasm = requireWasm();
  const len = wasm.delta_color_indices(n, breakevenRatio);
  if (len === 0xFFFFFFFF) return null;
  return new Uint8Array(wasm.memory.buffer, wasm.delta_ptr(), len).slice();
}

export function wasmDeltaCharIndices(n: number, breakevenRatio: number): Uint8Array | null {
  const wasm = requireWasm();
  const len = wasm.delta_char_indices(n, breakevenRatio);
  if (len === 0xFFFFFFFF) return null;
  return new Uint8Array(wasm.memory.buffer, wasm.delta_ptr(), len).slice();
}

export function wasmCommitColorFrame(n: number): void { requireWasm().commit_color_frame(n); }
export function wasmCommitCharFrame(n: number): void { requireWasm().commit_char_frame(n); }
export function wasmResetDeltaHistory(): void { requireWasm().reset_delta_history(); }

/** Packs the (already-quantized) char indices currently sitting in the gray buffer. Returns the packed bytes. */
export function wasmPackCharIndices(n: number, bitsPerChar: number): Uint8Array {
  const wasm = requireWasm();
  const len = wasm.pack_char_indices(n, bitsPerChar);
  return new Uint8Array(wasm.memory.buffer, wasm.packed_ptr(), len).slice();
}

initWasm().catch(() => { /* handled via getWasmStatus().error */ });
