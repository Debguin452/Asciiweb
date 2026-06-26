let wasmModule: any = null;
let wasmAvailable = false;
let wasmReady = false;
let wasmInitPromise: Promise<void> | null = null;
let wasmError: string | null = null;

export async function initWasm(): Promise<void> {
  if (wasmInitPromise) return wasmInitPromise;
  console.log('[WASM] 🚀 Starting initialization...');
  wasmInitPromise = (async () => {
    try {
      const wasmPath = '/wasm/asciiweb_wasm.js';
      console.log('[WASM] 📦 Loading from:', wasmPath);
      const wasm = await import(/* @vite-ignore */ wasmPath);
      if (wasm.default && typeof wasm.default === 'function') {
        await wasm.default('/wasm/asciiweb_wasm_bg.wasm');
      }
      wasmModule = wasm;
      wasmAvailable = true;
      wasmReady = true;
      const functions = Object.keys(wasm).filter(k => typeof wasm[k] === 'function');
      console.log('[WASM] ✅ Ready! Functions:', functions);
    } catch (err) {
      console.error('[WASM] ❌ Failed to load:', err);
      wasmError = err instanceof Error ? err.message : String(err);
      wasmAvailable = false;
    }
  })();
  return wasmInitPromise;
}

export function isWasmAvailable(): boolean { return wasmReady && wasmAvailable && wasmModule !== null; }
export function isWasmLoading(): boolean { return wasmInitPromise !== null && !wasmReady; }
export function getWasmModule(): any {
  if (!wasmReady || !wasmModule) throw new Error('WASM not ready');
  return wasmModule;
}
export function getWasmStatus() {
  return {
    available: wasmAvailable, ready: wasmReady, loading: isWasmLoading(),
    error: wasmError,
    functions: wasmModule ? Object.keys(wasmModule).filter(k => typeof wasmModule[k] === 'function') : []
  };
}
initWasm().catch(err => console.error('[WASM] Auto-init failed:', err));
