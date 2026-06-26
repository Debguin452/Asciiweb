/* tslint:disable */
/* eslint-disable */

export function decode_delta(delta: Uint8Array, previous: Uint8Array): Uint8Array;

export function encode_delta(current: Uint8Array, previous: Uint8Array): Uint8Array;

export function greet(): string;

export function pack_char_indices(indices: Uint8Array, bits_per_char: number): Uint8Array;

export function process_full_pipeline(pixels: Uint8Array, width: number, height: number, brightness: number, contrast: number, gamma: number, apply_sobel: boolean): Uint8Array;

export function process_grayscale_simd(pixels: Uint8Array, width: number, height: number): Uint8Array;

export function rle_decode(data: Uint8Array): Uint8Array;

export function rle_encode(data: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly decode_delta: (a: number, b: number, c: number, d: number) => [number, number];
    readonly greet: () => [number, number];
    readonly pack_char_indices: (a: number, b: number, c: number) => [number, number];
    readonly process_full_pipeline: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly process_grayscale_simd: (a: number, b: number, c: number, d: number) => [number, number];
    readonly rle_decode: (a: number, b: number) => [number, number];
    readonly rle_encode: (a: number, b: number) => [number, number];
    readonly encode_delta: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
