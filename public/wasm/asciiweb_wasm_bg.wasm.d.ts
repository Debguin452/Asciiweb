/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export function alloc_buffers(a: number): void;
export function color_idx_ptr(): number;
export function commit_char_frame(a: number): void;
export function commit_color_frame(a: number): void;
export function delta_char_indices(a: number, b: number): number;
export function delta_color_indices(a: number, b: number): number;
export function delta_ptr(): number;
export function generate_palette(): void;
export function gray_ptr(): number;
export function greet(a: number): void;
export function map_to_palette(a: number, b: number): void;
export function pack_char_indices(a: number, b: number): number;
export function packed_ptr(): number;
export function palette_ptr(): number;
export function pixels_ptr(): number;
export function process_pipeline(a: number, b: number, c: number, d: number, e: number, f: number): void;
export function quantize_to_char_indices(a: number, b: number, c: number, d: number): void;
export function reset_delta_history(): void;
export function __wbindgen_add_to_stack_pointer(a: number): number;
export function __wbindgen_free(a: number, b: number, c: number): void;
