/* tslint:disable */
/* eslint-disable */
/**
* @param {number} pixel_count
* @param {number} breakeven_ratio
* @returns {number}
*/
export function delta_color_indices(pixel_count: number, breakeven_ratio: number): number;
/**
* Fills the palette scratch buffer with the same 8x8x4 RGB palette used by
* map_to_palette, so encode-side and decode-side always agree.
*/
export function generate_palette(): void;
/**
* @returns {string}
*/
export function greet(): string;
/**
* @param {number} pixel_count
* @param {number} bits_per_char
* @returns {number}
*/
export function pack_char_indices(pixel_count: number, bits_per_char: number): number;
/**
* Pointer to the start of the RGBA pixel scratch buffer. JS should get a
* Uint8Array view via `new Uint8Array(memory.buffer, ptr, width*height*4)`
* and write the canvas pixel data directly into it — no copy function call
* needed on the way in.
* @returns {number}
*/
export function pixels_ptr(): number;
/**
* Call after a frame has actually been sent, so the next delta call
* compares against what the *receiver* actually has. Skipping this call
* (e.g. because the send was dropped/throttled) intentionally keeps
* diffing against the older committed frame.
* @param {number} pixel_count
*/
export function commit_color_frame(pixel_count: number): void;
/**
* @param {number} width
* @param {number} height
*/
export function map_to_palette(width: number, height: number): void;
/**
* @returns {number}
*/
export function delta_ptr(): number;
/**
* @param {number} pixel_count
* @param {number} nchars
* @param {number} threshold
* @param {boolean} invert
*/
export function quantize_to_char_indices(pixel_count: number, nchars: number, threshold: number, invert: boolean): void;
/**
* @param {number} width
* @param {number} height
* @param {number} brightness
* @param {number} contrast
* @param {number} gamma
* @param {boolean} apply_sobel
*/
export function process_pipeline(width: number, height: number, brightness: number, contrast: number, gamma: number, apply_sobel: boolean): void;
/**
* Clears delta history so the next frame from either stream is forced to
* be treated as "everything changed" (i.e. a keyframe upstream). Call this
* on reconnect, since the remote side's "previous frame" memory is gone.
*/
export function reset_delta_history(): void;
/**
* @returns {number}
*/
export function gray_ptr(): number;
/**
* @returns {number}
*/
export function palette_ptr(): number;
/**
* @returns {number}
*/
export function color_idx_ptr(): number;
/**
* @param {number} pixel_count
*/
export function commit_char_frame(pixel_count: number): void;
/**
* Call once after init with the largest pixel count (width*height) you'll
* ever process. Safe to call again later with a bigger size if needed —
* smaller sizes are no-ops, buffers never shrink.
* @param {number} max_pixels
*/
export function alloc_buffers(max_pixels: number): void;
/**
* Same as delta_color_indices but for char/grayscale indices, comparing
* against whatever was last committed via commit_char_frame.
* @param {number} pixel_count
* @param {number} breakeven_ratio
* @returns {number}
*/
export function delta_char_indices(pixel_count: number, breakeven_ratio: number): number;
/**
* @returns {number}
*/
export function packed_ptr(): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly alloc_buffers: (a: number) => void;
  readonly color_idx_ptr: () => number;
  readonly commit_char_frame: (a: number) => void;
  readonly commit_color_frame: (a: number) => void;
  readonly delta_char_indices: (a: number, b: number) => number;
  readonly delta_color_indices: (a: number, b: number) => number;
  readonly delta_ptr: () => number;
  readonly generate_palette: () => void;
  readonly gray_ptr: () => number;
  readonly greet: (a: number) => void;
  readonly map_to_palette: (a: number, b: number) => void;
  readonly pack_char_indices: (a: number, b: number) => number;
  readonly packed_ptr: () => number;
  readonly palette_ptr: () => number;
  readonly pixels_ptr: () => number;
  readonly process_pipeline: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly quantize_to_char_indices: (a: number, b: number, c: number, d: number) => void;
  readonly reset_delta_history: () => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {SyncInitInput} module
*
* @returns {InitOutput}
*/
export function initSync(module: SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;
