let wasm;

/**
* @param {number} pixel_count
* @param {number} breakeven_ratio
* @returns {number}
*/
export function delta_color_indices(pixel_count, breakeven_ratio) {
    const ret = wasm.delta_color_indices(pixel_count, breakeven_ratio);
    return ret >>> 0;
}

/**
* Fills the palette scratch buffer with the same 8x8x4 RGB palette used by
* map_to_palette, so encode-side and decode-side always agree.
*/
export function generate_palette() {
    wasm.generate_palette();
}

let cachedInt32Memory0 = null;

function getInt32Memory0() {
    if (cachedInt32Memory0 === null || cachedInt32Memory0.byteLength === 0) {
        cachedInt32Memory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32Memory0;
}

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

let cachedUint8Memory0 = null;

function getUint8Memory0() {
    if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {
        cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8Memory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
}
/**
* @returns {string}
*/
export function greet() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.greet(retptr);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
* @param {number} pixel_count
* @param {number} bits_per_char
* @returns {number}
*/
export function pack_char_indices(pixel_count, bits_per_char) {
    const ret = wasm.pack_char_indices(pixel_count, bits_per_char);
    return ret >>> 0;
}

/**
* Pointer to the start of the RGBA pixel scratch buffer. JS should get a
* Uint8Array view via `new Uint8Array(memory.buffer, ptr, width*height*4)`
* and write the canvas pixel data directly into it — no copy function call
* needed on the way in.
* @returns {number}
*/
export function pixels_ptr() {
    const ret = wasm.pixels_ptr();
    return ret >>> 0;
}

/**
* Call after a frame has actually been sent, so the next delta call
* compares against what the *receiver* actually has. Skipping this call
* (e.g. because the send was dropped/throttled) intentionally keeps
* diffing against the older committed frame.
* @param {number} pixel_count
*/
export function commit_color_frame(pixel_count) {
    wasm.commit_color_frame(pixel_count);
}

/**
* @param {number} width
* @param {number} height
*/
export function map_to_palette(width, height) {
    wasm.map_to_palette(width, height);
}

/**
* @returns {number}
*/
export function delta_ptr() {
    const ret = wasm.delta_ptr();
    return ret >>> 0;
}

/**
* @param {number} pixel_count
* @param {number} nchars
* @param {number} threshold
* @param {boolean} invert
*/
export function quantize_to_char_indices(pixel_count, nchars, threshold, invert) {
    wasm.quantize_to_char_indices(pixel_count, nchars, threshold, invert);
}

/**
* @param {number} width
* @param {number} height
* @param {number} brightness
* @param {number} contrast
* @param {number} gamma
* @param {boolean} apply_sobel
*/
export function process_pipeline(width, height, brightness, contrast, gamma, apply_sobel) {
    wasm.process_pipeline(width, height, brightness, contrast, gamma, apply_sobel);
}

/**
* Clears delta history so the next frame from either stream is forced to
* be treated as "everything changed" (i.e. a keyframe upstream). Call this
* on reconnect, since the remote side's "previous frame" memory is gone.
*/
export function reset_delta_history() {
    wasm.reset_delta_history();
}

/**
* @returns {number}
*/
export function gray_ptr() {
    const ret = wasm.gray_ptr();
    return ret >>> 0;
}

/**
* @returns {number}
*/
export function palette_ptr() {
    const ret = wasm.palette_ptr();
    return ret >>> 0;
}

/**
* @returns {number}
*/
export function color_idx_ptr() {
    const ret = wasm.color_idx_ptr();
    return ret >>> 0;
}

/**
* @param {number} pixel_count
*/
export function commit_char_frame(pixel_count) {
    wasm.commit_char_frame(pixel_count);
}

/**
* Call once after init with the largest pixel count (width*height) you'll
* ever process. Safe to call again later with a bigger size if needed —
* smaller sizes are no-ops, buffers never shrink.
* @param {number} max_pixels
*/
export function alloc_buffers(max_pixels) {
    wasm.alloc_buffers(max_pixels);
}

/**
* Same as delta_color_indices but for char/grayscale indices, comparing
* against whatever was last committed via commit_char_frame.
* @param {number} pixel_count
* @param {number} breakeven_ratio
* @returns {number}
*/
export function delta_char_indices(pixel_count, breakeven_ratio) {
    const ret = wasm.delta_char_indices(pixel_count, breakeven_ratio);
    return ret >>> 0;
}

/**
* @returns {number}
*/
export function packed_ptr() {
    const ret = wasm.packed_ptr();
    return ret >>> 0;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};

    return imports;
}

function __wbg_init_memory(imports, maybe_memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedInt32Memory0 = null;
    cachedUint8Memory0 = null;


    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(input) {
    if (wasm !== undefined) return wasm;

    if (typeof input === 'undefined') {
        input = new URL('asciiweb_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof input === 'string' || (typeof Request === 'function' && input instanceof Request) || (typeof URL === 'function' && input instanceof URL)) {
        input = fetch(input);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await input, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync }
export default __wbg_init;
