// WASM Wrapper with proper loading and detection

let wasmModule: any = null;
let wasmAvailable = false;
let wasmInitPromise: Promise<void> | null = null;
let wasmInitError: string | null = null;

export async function initWasm(): Promise<void> {
  if (wasmInitPromise) return wasmInitPromise;
  
  console.log('[WASM] Initializing...');
  
  wasmInitPromise = (async () => {
    try {
      // Try to load WASM module
      const wasmPath = './wasm-pkg/asciiweb_wasm.js';
      console.log('[WASM] Attempting to load from:', wasmPath);
      
      const wasm = await import(/* @vite-ignore */ wasmPath);
      
      // Initialize the WASM module
      if (wasm.default) {
        await wasm.default();
        console.log('[WASM] Module initialized successfully');
      }
      
      wasmModule = wasm;
      wasmAvailable = true;
      wasmInitError = null;
      
      console.log('[WASM] ✅ Ready! Available functions:', Object.keys(wasm).filter(k => typeof wasm[k] === 'function'));
      
    } catch (err) {
      console.error('[WASM] ❌ Failed to load:', err);
      wasmInitError = err instanceof Error ? err.message : 'Unknown error';
      wasmAvailable = false;
      wasmModule = null;
    }
  })();
  
  return wasmInitPromise;
}

export function isWasmAvailable(): boolean {
  return wasmAvailable && wasmModule !== null;
}

export function getWasmModule(): any {
  if (!wasmAvailable || !wasmModule) {
    throw new Error('WASM module not initialized. Call initWasm() first.');
  }
  return wasmModule;
}

export function getWasmStatus(): { available: boolean; error: string | null } {
  return {
    available: wasmAvailable,
    error: wasmInitError
  };
}

// Auto-initialize on import
initWasm().catch(err => {
  console.warn('[WASM] Auto-init failed:', err);
});
