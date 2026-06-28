use std::cell::RefCell;
use wasm_bindgen::prelude::*;

// ─────────────────────────────────────────────────────────────────────────
// Persistent scratch buffers, allocated once and reused every frame.
//
// The previous version of this module allocated a fresh Vec<u8> on every
// call and wasm-bindgen's glue copied data across the JS/WASM boundary on
// both the way in (passArray8ToWasm0) and the way out (.slice() on the
// returned pointer). At 30-60 calls/sec that's two heap allocations and
// two full-buffer memcpys per frame for no reason — the actual arithmetic
// here is trivial by comparison. Using thread_local scratch buffers and
// exposing raw pointers lets the JS side write pixels directly into WASM
// linear memory and read results directly back out of it, so the only
// copies left are the unavoidable Canvas->TypedArray one on the JS side.
// ─────────────────────────────────────────────────────────────────────────

const MAX_PALETTE: usize = 256;

struct Scratch {
    pixels: Vec<u8>,      // RGBA input, len = capacity * 4
    gray: Vec<u8>,        // luminance output, len = capacity
    prev_gray_idx: Vec<u8>,   // previous frame's char/gray indices, for delta
    color_idx: Vec<u8>,   // palette-mapped color indices, len = capacity
    prev_color_idx: Vec<u8>,
    packed: Vec<u8>,      // bit-packed char index output
    delta: Vec<u8>,       // sparse delta scratch (4-byte count + 5 bytes/change)
    palette: Vec<u8>,     // MAX_PALETTE * 3
    capacity: usize,
}

impl Scratch {
    fn new() -> Self {
        Scratch {
            pixels: Vec::new(),
            gray: Vec::new(),
            prev_gray_idx: Vec::new(),
            color_idx: Vec::new(),
            prev_color_idx: Vec::new(),
            packed: Vec::new(),
            delta: Vec::new(),
            palette: vec![0u8; MAX_PALETTE * 3],
            capacity: 0,
        }
    }

    fn ensure(&mut self, n: usize) {
        if self.capacity >= n {
            return;
        }
        self.capacity = n;
        self.pixels.resize(n * 4, 0);
        self.gray.resize(n, 0);
        self.prev_gray_idx.resize(n, 0);
        self.color_idx.resize(n, 0);
        self.prev_color_idx.resize(n, 0);
        self.packed.resize(n, 0); // worst case 8 bits/cell, never larger than n
        // worst case every cell changed: 4 (count) + n * 5 bytes
        self.delta.resize(4 + n * 5, 0);
    }
}

thread_local! {
    static SCRATCH: RefCell<Scratch> = RefCell::new(Scratch::new());
}

/// Call once after init with the largest pixel count (width*height) you'll
/// ever process. Safe to call again later with a bigger size if needed —
/// smaller sizes are no-ops, buffers never shrink.
#[wasm_bindgen]
pub fn alloc_buffers(max_pixels: u32) {
    SCRATCH.with(|s| s.borrow_mut().ensure(max_pixels as usize));
}

/// Pointer to the start of the RGBA pixel scratch buffer. JS should get a
/// Uint8Array view via `new Uint8Array(memory.buffer, ptr, width*height*4)`
/// and write the canvas pixel data directly into it — no copy function call
/// needed on the way in.
#[wasm_bindgen]
pub fn pixels_ptr() -> *mut u8 {
    SCRATCH.with(|s| s.borrow_mut().pixels.as_mut_ptr())
}

#[wasm_bindgen]
pub fn gray_ptr() -> *const u8 {
    SCRATCH.with(|s| s.borrow().gray.as_ptr())
}

#[wasm_bindgen]
pub fn color_idx_ptr() -> *const u8 {
    SCRATCH.with(|s| s.borrow().color_idx.as_ptr())
}

#[wasm_bindgen]
pub fn packed_ptr() -> *const u8 {
    SCRATCH.with(|s| s.borrow().packed.as_ptr())
}

#[wasm_bindgen]
pub fn delta_ptr() -> *const u8 {
    SCRATCH.with(|s| s.borrow().delta.as_ptr())
}

#[wasm_bindgen]
pub fn palette_ptr() -> *const u8 {
    SCRATCH.with(|s| s.borrow().palette.as_ptr())
}

// ── Grayscale + brightness/contrast/gamma (+ optional Sobel) ───────────────
// Reads from the `pixels` scratch buffer, writes into `gray`. No
// allocation, no return value to copy out — the caller reads `gray_ptr()`
// directly.
#[wasm_bindgen]
pub fn process_pipeline(width: u32, height: u32, brightness: f32, contrast: f32, gamma: f32, apply_sobel: bool) {
    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        let w = width as usize;
        let h = height as usize;
        let n = w * h;
        if s.pixels.len() < n * 4 || s.gray.len() < n {
            return;
        }
        let inv_gamma = 1.0 / gamma;
        let apply_gamma = (gamma - 1.0).abs() > f32::EPSILON;

        let is_default_tone = brightness.abs() < f32::EPSILON
            && (contrast - 1.0).abs() < f32::EPSILON
            && !apply_gamma;

        #[cfg(all(target_arch = "wasm32", feature = "simd"))]
        if is_default_tone && is_simd128_available() {
            let s = &mut *s;
            unsafe { grayscale_simd128(&s.pixels, &mut s.gray, n) };
        } else {
            let s = &mut *s;
            grayscale_scalar(&s.pixels, &mut s.gray, n, brightness, contrast, apply_gamma, inv_gamma);
        }

        #[cfg(not(all(target_arch = "wasm32", feature = "simd")))]
        {
            let _ = is_default_tone;
            let s = &mut *s;
            grayscale_scalar(&s.pixels, &mut s.gray, n, brightness, contrast, apply_gamma, inv_gamma);
        }

        if apply_sobel {
            sobel_in_place(&mut s.gray, w, h);
        }
    });
}

fn grayscale_scalar(pixels: &[u8], gray: &mut [u8], n: usize, brightness: f32, contrast: f32, apply_gamma: bool, inv_gamma: f32) {
    for i in 0..n {
        let o = i * 4;
        let r = pixels[o] as f32;
        let g = pixels[o + 1] as f32;
        let b = pixels[o + 2] as f32;
        let mut lum = 0.299 * r + 0.587 * g + 0.114 * b;
        lum += brightness;
        lum = (lum - 128.0) * contrast + 128.0;
        if apply_gamma {
            lum = 255.0 * (lum.max(0.0) / 255.0).powf(inv_gamma);
        }
        gray[i] = lum.clamp(0.0, 255.0) as u8;
    }
}

// Compile-time gate only — enabled via `--features simd` together with
// RUSTFLAGS="-C target-feature=+simd128" (see .cargo/config.toml / build
// instructions in wasm-module/README.md). Verify output visually before
// relying on this: the byte-shuffle indices below were checked by hand,
// not by an actual compiler+browser run, since this environment had no
// way to build for wasm32.
#[cfg(all(target_arch = "wasm32", feature = "simd"))]
#[inline]
fn is_simd128_available() -> bool {
    cfg!(target_feature = "simd128")
}

// SIMD grayscale using the standard ITU-R BT.601 fixed-point luma weights
// (77, 150, 29) >> 8, which match the 0.299/0.587/0.114 float weights to
// within ±1 on an 8-bit scale — visually identical, and only valid for the
// "no brightness/contrast/gamma adjustment" case, which is checked by the
// caller before reaching here. Processes 4 pixels (16 RGBA bytes) per
// iteration.
//
// Byte layout of 4 RGBA pixels as one v128: indices 0,4,8,12 are R;
// 1,5,9,13 are G; 2,6,10,14 are B; 3,7,11,15 are A (unused). u8x16_shuffle
// takes 16 compile-time lane-index immediates selecting from the 32-byte
// space of {a's 16 bytes, b's 16 bytes} — passing `px` for both lets any
// of its 16 bytes be picked into any output lane. Below, each shuffle
// gathers one channel's 4 bytes into output lanes 0..3 (the rest of the
// output lanes are don't-care padding, never read).
#[cfg(all(target_arch = "wasm32", feature = "simd"))]
#[target_feature(enable = "simd128")]
unsafe fn grayscale_simd128(pixels: &[u8], gray: &mut [u8], n: usize) {
    use core::arch::wasm32::*;

    let chunks = n / 4;
    for c in 0..chunks {
        let base = c * 16;
        let px = v128_load(pixels.as_ptr().add(base) as *const v128);

        // Gather R bytes (source lanes 0,4,8,12) into output lanes 0..3.
        let r_bytes = u8x16_shuffle::<0, 4, 8, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0>(px, px);
        // Gather G bytes (source lanes 1,5,9,13) into output lanes 0..3.
        let g_bytes = u8x16_shuffle::<1, 5, 9, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0>(px, px);
        // Gather B bytes (source lanes 2,6,10,14) into output lanes 0..3.
        let b_bytes = u8x16_shuffle::<2, 6, 10, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0>(px, px);

        // Widen the low 4 bytes (our gathered channel values) to u16 lanes
        // so the multiply-by-weight can't overflow (max 255*150 = 38250).
        let r16 = u16x8_extend_low_u8x16(r_bytes);
        let g16 = u16x8_extend_low_u8x16(g_bytes);
        let b16 = u16x8_extend_low_u8x16(b_bytes);

        let weighted = u16x8_add(
            u16x8_add(u16x8_mul(r16, u16x8_splat(77)), u16x8_mul(g16, u16x8_splat(150))),
            u16x8_mul(b16, u16x8_splat(29)),
        );
        let luma = u16x8_shr(weighted, 8);

        // Only lanes 0..3 hold real data (the 4 gathered channel bytes);
        // lanes 4..7 came from the don't-care padding bytes and are unused.
        let out = c * 4;
        gray[out] = u16x8_extract_lane::<0>(luma) as u8;
        gray[out + 1] = u16x8_extract_lane::<1>(luma) as u8;
        gray[out + 2] = u16x8_extract_lane::<2>(luma) as u8;
        gray[out + 3] = u16x8_extract_lane::<3>(luma) as u8;
    }

    // Scalar tail for the remainder (n not divisible by 4).
    for i in (chunks * 4)..n {
        let o = i * 4;
        let r = pixels[o] as u32;
        let g = pixels[o + 1] as u32;
        let b = pixels[o + 2] as u32;
        gray[i] = ((77 * r + 150 * g + 29 * b) >> 8) as u8;
    }
}

fn sobel_in_place(gray: &mut [u8], w: usize, h: usize) {
    if w < 3 || h < 3 {
        return;
    }
    let src = gray.to_vec(); // small fixed-size copy (one frame's worth); needed since Sobel reads neighbors while writing
    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let i = y * w + x;
            let gx = -(src[(y - 1) * w + (x - 1)] as i32)
                + src[(y - 1) * w + (x + 1)] as i32
                - 2 * src[y * w + (x - 1)] as i32
                + 2 * src[y * w + (x + 1)] as i32
                - src[(y + 1) * w + (x - 1)] as i32
                + src[(y + 1) * w + (x + 1)] as i32;
            let gy = -(src[(y - 1) * w + (x - 1)] as i32)
                - 2 * src[(y - 1) * w + x] as i32
                - src[(y - 1) * w + (x + 1)] as i32
                + src[(y + 1) * w + (x - 1)] as i32
                + 2 * src[(y + 1) * w + x] as i32
                + src[(y + 1) * w + (x + 1)] as i32;
            let mag = ((gx * gx + gy * gy) as f32).sqrt();
            gray[i] = mag.min(255.0) as u8;
        }
    }
}

// ── RGB → palette index mapping (8x8x4 levels = 256 colors) ────────────────
// Reads RGB straight from the `pixels` scratch buffer (so the caller never
// needs to split it into separate r/g/b arrays), writes into `color_idx`.
#[wasm_bindgen]
pub fn map_to_palette(width: u32, height: u32) {
    const R_LEVELS: u32 = 8;
    const G_LEVELS: u32 = 8;
    const B_LEVELS: u32 = 4;

    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        let n = (width * height) as usize;
        if s.pixels.len() < n * 4 || s.color_idx.len() < n {
            return;
        }
        for i in 0..n {
            let o = i * 4;
            let r = s.pixels[o] as u32;
            let g = s.pixels[o + 1] as u32;
            let b = s.pixels[o + 2] as u32;
            let ri = (r * R_LEVELS / 256).min(R_LEVELS - 1);
            let gi = (g * G_LEVELS / 256).min(G_LEVELS - 1);
            let bi = (b * B_LEVELS / 256).min(B_LEVELS - 1);
            s.color_idx[i] = (ri * G_LEVELS * B_LEVELS + gi * B_LEVELS + bi) as u8;
        }
    });
}

/// Fills the palette scratch buffer with the same 8x8x4 RGB palette used by
/// map_to_palette, so encode-side and decode-side always agree.
#[wasm_bindgen]
pub fn generate_palette() {
    const R_LEVELS: u32 = 8;
    const G_LEVELS: u32 = 8;
    const B_LEVELS: u32 = 4;

    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        for ri in 0..R_LEVELS {
            for gi in 0..G_LEVELS {
                for bi in 0..B_LEVELS {
                    let idx = ((ri * G_LEVELS * B_LEVELS + gi * B_LEVELS + bi) * 3) as usize;
                    if idx + 2 < s.palette.len() {
                        s.palette[idx] = ((ri as f32 + 0.5) * 255.0 / R_LEVELS as f32).round() as u8;
                        s.palette[idx + 1] = ((gi as f32 + 0.5) * 255.0 / G_LEVELS as f32).round() as u8;
                        s.palette[idx + 2] = ((bi as f32 + 0.5) * 255.0 / B_LEVELS as f32).round() as u8;
                    }
                }
            }
        }
    });
}

// ── Sparse delta against the previous frame's color indices ────────────────
// Compares `color_idx` (this frame, already computed by map_to_palette)
// against the buffer's own memory of the last frame it was asked to diff,
// writes a (count:u32 BE, then (pos:u32 BE, value:u8) per change) record
// into `delta`, and returns the byte length actually written (0 means
// "identical to last frame"). Returns u32::MAX if too much changed for a
// delta to be worth it (caller should send a keyframe instead).
//
// "Previous" here means whatever was passed to commit_color_frame last —
// the caller decides when to commit (only after a successful send) so a
// dropped/throttled frame doesn't desync the two sides.
#[wasm_bindgen]
pub fn delta_color_indices(pixel_count: u32, breakeven_ratio: f32) -> u32 {
    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        let n = pixel_count as usize;
        if s.color_idx.len() < n || s.prev_color_idx.len() < n {
            return u32::MAX;
        }

        let mut changed = 0usize;
        for i in 0..n {
            if s.color_idx[i] != s.prev_color_idx[i] {
                changed += 1;
            }
        }
        if changed == 0 {
            s.delta[0..4].copy_from_slice(&0u32.to_be_bytes());
            return 4;
        }
        if (changed as f32 / n as f32) > breakeven_ratio {
            return u32::MAX;
        }

        let needed = 4 + changed * 5;
        if s.delta.len() < needed {
            return u32::MAX;
        }

        s.delta[0..4].copy_from_slice(&(changed as u32).to_be_bytes());
        let mut p = 4usize;
        for i in 0..n {
            if s.color_idx[i] != s.prev_color_idx[i] {
                s.delta[p..p + 4].copy_from_slice(&(i as u32).to_be_bytes());
                s.delta[p + 4] = s.color_idx[i];
                p += 5;
            }
        }
        p as u32
    })
}

/// Same as delta_color_indices but for char/grayscale indices, comparing
/// against whatever was last committed via commit_char_frame.
#[wasm_bindgen]
pub fn delta_char_indices(pixel_count: u32, breakeven_ratio: f32) -> u32 {
    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        let n = pixel_count as usize;
        if s.gray.len() < n || s.prev_gray_idx.len() < n {
            return u32::MAX;
        }

        let mut changed = 0usize;
        for i in 0..n {
            if s.gray[i] != s.prev_gray_idx[i] {
                changed += 1;
            }
        }
        if changed == 0 {
            s.delta[0..4].copy_from_slice(&0u32.to_be_bytes());
            return 4;
        }
        if (changed as f32 / n as f32) > breakeven_ratio {
            return u32::MAX;
        }

        let needed = 4 + changed * 5;
        if s.delta.len() < needed {
            return u32::MAX;
        }

        s.delta[0..4].copy_from_slice(&(changed as u32).to_be_bytes());
        let mut p = 4usize;
        for i in 0..n {
            if s.gray[i] != s.prev_gray_idx[i] {
                s.delta[p..p + 4].copy_from_slice(&(i as u32).to_be_bytes());
                s.delta[p + 4] = s.gray[i];
                p += 5;
            }
        }
        p as u32
    })
}

/// Call after a frame has actually been sent, so the next delta call
/// compares against what the *receiver* actually has. Skipping this call
/// (e.g. because the send was dropped/throttled) intentionally keeps
/// diffing against the older committed frame.
#[wasm_bindgen]
pub fn commit_color_frame(pixel_count: u32) {
    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        let n = (pixel_count as usize).min(s.color_idx.len()).min(s.prev_color_idx.len());
        for i in 0..n {
            s.prev_color_idx[i] = s.color_idx[i];
        }
    });
}

#[wasm_bindgen]
pub fn commit_char_frame(pixel_count: u32) {
    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        let n = (pixel_count as usize).min(s.gray.len()).min(s.prev_gray_idx.len());
        for i in 0..n {
            s.prev_gray_idx[i] = s.gray[i];
        }
    });
}

/// Clears delta history so the next frame from either stream is forced to
/// be treated as "everything changed" (i.e. a keyframe upstream). Call this
/// on reconnect, since the remote side's "previous frame" memory is gone.
#[wasm_bindgen]
pub fn reset_delta_history() {
    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        for v in s.prev_color_idx.iter_mut() {
            *v = 0xFF;
        }
        for v in s.prev_gray_idx.iter_mut() {
            *v = 0xFF;
        }
    });
}

// ── Luminance → character index quantization ───────────────────────────────
// Converts the `gray` buffer (0-255 luminance, written by process_pipeline)
// in place into character indices (0..nchars-1), matching the non-dither
// quantization the JS side already uses. Threshold mode (binary light/dark)
// is selected by passing threshold > 0.
#[wasm_bindgen]
pub fn quantize_to_char_indices(pixel_count: u32, nchars: u32, threshold: f32, invert: bool) {
    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        let n = pixel_count as usize;
        if s.gray.len() < n || nchars == 0 {
            return;
        }
        let denom = (nchars - 1) as f32;
        let denom_u = (nchars - 1) as u32;
        for i in 0..n {
            let lum = s.gray[i] as f32;
            let idx = if threshold > 0.0 {
                let is_light = lum >= threshold;
                let light_idx = if invert { 0 } else { denom_u };
                let dark_idx = if invert { denom_u } else { 0 };
                if is_light { light_idx } else { dark_idx }
            } else {
                let raw = if invert { (1.0 - lum / 255.0) * denom } else { (lum / 255.0) * denom };
                (raw.floor() as i32).clamp(0, denom as i32) as u32
            };
            s.gray[i] = idx as u8;
        }
    });
}

// ── Bit packing for character indices ───────────────────────────────────────
// Packs `gray` — expected to already hold character indices in
// 0..nchars-1, e.g. via quantize_to_char_indices — into `packed` at
// `bits_per_char` bits each. Returns byte length written.
#[wasm_bindgen]
pub fn pack_char_indices(pixel_count: u32, bits_per_char: u32) -> u32 {
    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        let n = pixel_count as usize;
        if s.gray.len() < n {
            return 0;
        }
        let mask: u32 = (1u32 << bits_per_char) - 1;
        let mut bit_buf: u32 = 0;
        let mut bit_count: u32 = 0;
        let mut pos = 0usize;

        for i in 0..n {
            bit_buf = (bit_buf << bits_per_char) | (s.gray[i] as u32 & mask);
            bit_count += bits_per_char;
            while bit_count >= 8 {
                bit_count -= 8;
                if pos < s.packed.len() {
                    s.packed[pos] = ((bit_buf >> bit_count) & 0xff) as u8;
                    pos += 1;
                }
            }
        }
        if bit_count > 0 && pos < s.packed.len() {
            s.packed[pos] = ((bit_buf << (8 - bit_count)) & 0xff) as u8;
            pos += 1;
        }
        pos as u32
    })
}

#[wasm_bindgen]
pub fn greet() -> String {
    "AsciiWeb WASM — zero-copy pipeline ready".to_string()
}

// ─────────────────────────────────────────────────────────────────────────
// Tests that run on the host target (`cargo test`, no wasm32 needed) and
// cover everything except the wasm32-only SIMD path, which can only be
// exercised by an actual browser/wasm runtime. Run these before every
// build — they catch most logic regressions for free.
// ─────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    fn with_fresh_scratch<F: FnOnce()>(n: usize, f: F) {
        SCRATCH.with(|s| s.borrow_mut().ensure(n));
        f();
    }

    #[test]
    fn grayscale_matches_float_reference() {
        with_fresh_scratch(4, || {
            SCRATCH.with(|s| {
                let mut s = s.borrow_mut();
                // 4 pixels: black, white, red, a mid-gray-ish blue.
                let px: [[u8; 4]; 4] = [[0, 0, 0, 255], [255, 255, 255, 255], [255, 0, 0, 255], [10, 20, 200, 255]];
                for (i, p) in px.iter().enumerate() {
                    s.pixels[i * 4..i * 4 + 4].copy_from_slice(p);
                }
            });
            process_pipeline(2, 2, 0.0, 1.0, 1.0, false);
            SCRATCH.with(|s| {
                let s = s.borrow();
                assert_eq!(s.gray[0], 0);
                assert_eq!(s.gray[1], 255);
                // r=255 -> 0.299*255 ≈ 76
                assert!((s.gray[2] as i32 - 76).abs() <= 1);
            });
        });
    }

    #[test]
    fn brightness_contrast_path_runs_and_clamps() {
        with_fresh_scratch(1, || {
            SCRATCH.with(|s| s.borrow_mut().pixels[0..4].copy_from_slice(&[200, 200, 200, 255]));
            process_pipeline(1, 1, 100.0, 2.0, 1.0, false);
            SCRATCH.with(|s| assert_eq!(s.borrow().gray[0], 255)); // way over-driven, must clamp not wrap
        });
    }

    #[test]
    fn quantize_threshold_mode() {
        with_fresh_scratch(2, || {
            SCRATCH.with(|s| { s.borrow_mut().gray[0] = 200; s.borrow_mut().gray[1] = 50; });
            quantize_to_char_indices(2, 10, 128.0, false);
            SCRATCH.with(|s| {
                let s = s.borrow();
                assert_eq!(s.gray[0], 9); // light -> max index
                assert_eq!(s.gray[1], 0); // dark -> min index
            });
        });
    }

    #[test]
    fn quantize_linear_mode_matches_js_formula() {
        with_fresh_scratch(1, || {
            SCRATCH.with(|s| s.borrow_mut().gray[0] = 128);
            quantize_to_char_indices(1, 10, 0.0, false);
            // JS: Math.floor(128/255 * 9) = Math.floor(4.5176) = 4
            SCRATCH.with(|s| assert_eq!(s.borrow().gray[0], 4));
        });
    }

    #[test]
    fn pack_unpack_roundtrip() {
        with_fresh_scratch(8, || {
            SCRATCH.with(|s| {
                let mut s = s.borrow_mut();
                let vals = [0u8, 3, 7, 2, 5, 1, 6, 4]; // fits in 3 bits each
                s.gray[..8].copy_from_slice(&vals);
            });
            let written = pack_char_indices(8, 3);
            assert_eq!(written, (8 * 3 + 7) / 8); // ceil(24/8) = 3 bytes

            // Manually unpack and check it matches the input.
            SCRATCH.with(|s| {
                let s = s.borrow();
                let packed = &s.packed[0..written as usize];
                let mut bitbuf = 0u32;
                let mut bitcount = 0u32;
                let mut out = Vec::new();
                for &byte in packed {
                    bitbuf = (bitbuf << 8) | byte as u32;
                    bitcount += 8;
                    while bitcount >= 3 {
                        bitcount -= 3;
                        out.push(((bitbuf >> bitcount) & 0x7) as u8);
                    }
                }
                assert_eq!(&out[..8], &[0u8, 3, 7, 2, 5, 1, 6, 4]);
            });
        });
    }

    #[test]
    fn delta_detects_changes_and_breakeven() {
        with_fresh_scratch(10, || {
            SCRATCH.with(|s| {
                let mut s = s.borrow_mut();
                for i in 0..10 { s.color_idx[i] = 1; s.prev_color_idx[i] = 1; }
            });
            // Identical frames -> 4 bytes written (just the zero count).
            assert_eq!(delta_color_indices(10, 0.4), 4);

            SCRATCH.with(|s| s.borrow_mut().color_idx[3] = 9);
            // One change out of 10 (10%) is under the 40% breakeven.
            let len = delta_color_indices(10, 0.4);
            assert_eq!(len, 4 + 5); // header + one (pos,val) pair

            SCRATCH.with(|s| {
                let mut s = s.borrow_mut();
                for i in 0..10 { s.color_idx[i] = i as u8 + 50; } // ~100% changed
            });
            // Over the 40% breakeven -> caller should send a keyframe instead.
            assert_eq!(delta_color_indices(10, 0.4), u32::MAX);
        });
    }

    #[test]
    fn commit_then_delta_is_zero() {
        with_fresh_scratch(5, || {
            SCRATCH.with(|s| {
                let mut s = s.borrow_mut();
                for i in 0..5 { s.color_idx[i] = (i * 7) as u8; }
            });
            commit_color_frame(5);
            assert_eq!(delta_color_indices(5, 0.4), 4); // nothing changed since commit
        });
    }

    #[test]
    fn palette_matches_js_formula() {
        generate_palette();
        SCRATCH.with(|s| {
            let s = s.borrow();
            // Index 0 (ri=0,gi=0,bi=0): r = round((0+0.5)*255/8) = round(15.9375) = 16
            assert_eq!(s.palette[0], 16);
            assert_eq!(s.palette[1], 16);
            // b uses 4 levels: round((0+0.5)*255/4) = round(31.875) = 32
            assert_eq!(s.palette[2], 32);
        });
    }

    #[test]
    fn map_to_palette_matches_js_reference_values() {
        // Generated from the JS implementation in src/lib/binary.ts —
        // every (r, g, b) triple here must produce the identical palette
        // index in both languages, or a sender on one runtime and a
        // receiver on the other would disagree about pixel color.
        let cases: [(u8, u8, u8, u8); 512] = [
            (0, 0, 0, 0),
            (0, 0, 1, 0),
            (0, 0, 63, 0),
            (0, 0, 64, 1),
            (0, 0, 127, 1),
            (0, 0, 128, 2),
            (0, 0, 254, 3),
            (0, 0, 255, 3),
            (0, 1, 0, 0),
            (0, 1, 1, 0),
            (0, 1, 63, 0),
            (0, 1, 64, 1),
            (0, 1, 127, 1),
            (0, 1, 128, 2),
            (0, 1, 254, 3),
            (0, 1, 255, 3),
            (0, 31, 0, 0),
            (0, 31, 1, 0),
            (0, 31, 63, 0),
            (0, 31, 64, 1),
            (0, 31, 127, 1),
            (0, 31, 128, 2),
            (0, 31, 254, 3),
            (0, 31, 255, 3),
            (0, 32, 0, 4),
            (0, 32, 1, 4),
            (0, 32, 63, 4),
            (0, 32, 64, 5),
            (0, 32, 127, 5),
            (0, 32, 128, 6),
            (0, 32, 254, 7),
            (0, 32, 255, 7),
            (0, 127, 0, 12),
            (0, 127, 1, 12),
            (0, 127, 63, 12),
            (0, 127, 64, 13),
            (0, 127, 127, 13),
            (0, 127, 128, 14),
            (0, 127, 254, 15),
            (0, 127, 255, 15),
            (0, 128, 0, 16),
            (0, 128, 1, 16),
            (0, 128, 63, 16),
            (0, 128, 64, 17),
            (0, 128, 127, 17),
            (0, 128, 128, 18),
            (0, 128, 254, 19),
            (0, 128, 255, 19),
            (0, 254, 0, 28),
            (0, 254, 1, 28),
            (0, 254, 63, 28),
            (0, 254, 64, 29),
            (0, 254, 127, 29),
            (0, 254, 128, 30),
            (0, 254, 254, 31),
            (0, 254, 255, 31),
            (0, 255, 0, 28),
            (0, 255, 1, 28),
            (0, 255, 63, 28),
            (0, 255, 64, 29),
            (0, 255, 127, 29),
            (0, 255, 128, 30),
            (0, 255, 254, 31),
            (0, 255, 255, 31),
            (1, 0, 0, 0),
            (1, 0, 1, 0),
            (1, 0, 63, 0),
            (1, 0, 64, 1),
            (1, 0, 127, 1),
            (1, 0, 128, 2),
            (1, 0, 254, 3),
            (1, 0, 255, 3),
            (1, 1, 0, 0),
            (1, 1, 1, 0),
            (1, 1, 63, 0),
            (1, 1, 64, 1),
            (1, 1, 127, 1),
            (1, 1, 128, 2),
            (1, 1, 254, 3),
            (1, 1, 255, 3),
            (1, 31, 0, 0),
            (1, 31, 1, 0),
            (1, 31, 63, 0),
            (1, 31, 64, 1),
            (1, 31, 127, 1),
            (1, 31, 128, 2),
            (1, 31, 254, 3),
            (1, 31, 255, 3),
            (1, 32, 0, 4),
            (1, 32, 1, 4),
            (1, 32, 63, 4),
            (1, 32, 64, 5),
            (1, 32, 127, 5),
            (1, 32, 128, 6),
            (1, 32, 254, 7),
            (1, 32, 255, 7),
            (1, 127, 0, 12),
            (1, 127, 1, 12),
            (1, 127, 63, 12),
            (1, 127, 64, 13),
            (1, 127, 127, 13),
            (1, 127, 128, 14),
            (1, 127, 254, 15),
            (1, 127, 255, 15),
            (1, 128, 0, 16),
            (1, 128, 1, 16),
            (1, 128, 63, 16),
            (1, 128, 64, 17),
            (1, 128, 127, 17),
            (1, 128, 128, 18),
            (1, 128, 254, 19),
            (1, 128, 255, 19),
            (1, 254, 0, 28),
            (1, 254, 1, 28),
            (1, 254, 63, 28),
            (1, 254, 64, 29),
            (1, 254, 127, 29),
            (1, 254, 128, 30),
            (1, 254, 254, 31),
            (1, 254, 255, 31),
            (1, 255, 0, 28),
            (1, 255, 1, 28),
            (1, 255, 63, 28),
            (1, 255, 64, 29),
            (1, 255, 127, 29),
            (1, 255, 128, 30),
            (1, 255, 254, 31),
            (1, 255, 255, 31),
            (31, 0, 0, 0),
            (31, 0, 1, 0),
            (31, 0, 63, 0),
            (31, 0, 64, 1),
            (31, 0, 127, 1),
            (31, 0, 128, 2),
            (31, 0, 254, 3),
            (31, 0, 255, 3),
            (31, 1, 0, 0),
            (31, 1, 1, 0),
            (31, 1, 63, 0),
            (31, 1, 64, 1),
            (31, 1, 127, 1),
            (31, 1, 128, 2),
            (31, 1, 254, 3),
            (31, 1, 255, 3),
            (31, 31, 0, 0),
            (31, 31, 1, 0),
            (31, 31, 63, 0),
            (31, 31, 64, 1),
            (31, 31, 127, 1),
            (31, 31, 128, 2),
            (31, 31, 254, 3),
            (31, 31, 255, 3),
            (31, 32, 0, 4),
            (31, 32, 1, 4),
            (31, 32, 63, 4),
            (31, 32, 64, 5),
            (31, 32, 127, 5),
            (31, 32, 128, 6),
            (31, 32, 254, 7),
            (31, 32, 255, 7),
            (31, 127, 0, 12),
            (31, 127, 1, 12),
            (31, 127, 63, 12),
            (31, 127, 64, 13),
            (31, 127, 127, 13),
            (31, 127, 128, 14),
            (31, 127, 254, 15),
            (31, 127, 255, 15),
            (31, 128, 0, 16),
            (31, 128, 1, 16),
            (31, 128, 63, 16),
            (31, 128, 64, 17),
            (31, 128, 127, 17),
            (31, 128, 128, 18),
            (31, 128, 254, 19),
            (31, 128, 255, 19),
            (31, 254, 0, 28),
            (31, 254, 1, 28),
            (31, 254, 63, 28),
            (31, 254, 64, 29),
            (31, 254, 127, 29),
            (31, 254, 128, 30),
            (31, 254, 254, 31),
            (31, 254, 255, 31),
            (31, 255, 0, 28),
            (31, 255, 1, 28),
            (31, 255, 63, 28),
            (31, 255, 64, 29),
            (31, 255, 127, 29),
            (31, 255, 128, 30),
            (31, 255, 254, 31),
            (31, 255, 255, 31),
            (32, 0, 0, 32),
            (32, 0, 1, 32),
            (32, 0, 63, 32),
            (32, 0, 64, 33),
            (32, 0, 127, 33),
            (32, 0, 128, 34),
            (32, 0, 254, 35),
            (32, 0, 255, 35),
            (32, 1, 0, 32),
            (32, 1, 1, 32),
            (32, 1, 63, 32),
            (32, 1, 64, 33),
            (32, 1, 127, 33),
            (32, 1, 128, 34),
            (32, 1, 254, 35),
            (32, 1, 255, 35),
            (32, 31, 0, 32),
            (32, 31, 1, 32),
            (32, 31, 63, 32),
            (32, 31, 64, 33),
            (32, 31, 127, 33),
            (32, 31, 128, 34),
            (32, 31, 254, 35),
            (32, 31, 255, 35),
            (32, 32, 0, 36),
            (32, 32, 1, 36),
            (32, 32, 63, 36),
            (32, 32, 64, 37),
            (32, 32, 127, 37),
            (32, 32, 128, 38),
            (32, 32, 254, 39),
            (32, 32, 255, 39),
            (32, 127, 0, 44),
            (32, 127, 1, 44),
            (32, 127, 63, 44),
            (32, 127, 64, 45),
            (32, 127, 127, 45),
            (32, 127, 128, 46),
            (32, 127, 254, 47),
            (32, 127, 255, 47),
            (32, 128, 0, 48),
            (32, 128, 1, 48),
            (32, 128, 63, 48),
            (32, 128, 64, 49),
            (32, 128, 127, 49),
            (32, 128, 128, 50),
            (32, 128, 254, 51),
            (32, 128, 255, 51),
            (32, 254, 0, 60),
            (32, 254, 1, 60),
            (32, 254, 63, 60),
            (32, 254, 64, 61),
            (32, 254, 127, 61),
            (32, 254, 128, 62),
            (32, 254, 254, 63),
            (32, 254, 255, 63),
            (32, 255, 0, 60),
            (32, 255, 1, 60),
            (32, 255, 63, 60),
            (32, 255, 64, 61),
            (32, 255, 127, 61),
            (32, 255, 128, 62),
            (32, 255, 254, 63),
            (32, 255, 255, 63),
            (127, 0, 0, 96),
            (127, 0, 1, 96),
            (127, 0, 63, 96),
            (127, 0, 64, 97),
            (127, 0, 127, 97),
            (127, 0, 128, 98),
            (127, 0, 254, 99),
            (127, 0, 255, 99),
            (127, 1, 0, 96),
            (127, 1, 1, 96),
            (127, 1, 63, 96),
            (127, 1, 64, 97),
            (127, 1, 127, 97),
            (127, 1, 128, 98),
            (127, 1, 254, 99),
            (127, 1, 255, 99),
            (127, 31, 0, 96),
            (127, 31, 1, 96),
            (127, 31, 63, 96),
            (127, 31, 64, 97),
            (127, 31, 127, 97),
            (127, 31, 128, 98),
            (127, 31, 254, 99),
            (127, 31, 255, 99),
            (127, 32, 0, 100),
            (127, 32, 1, 100),
            (127, 32, 63, 100),
            (127, 32, 64, 101),
            (127, 32, 127, 101),
            (127, 32, 128, 102),
            (127, 32, 254, 103),
            (127, 32, 255, 103),
            (127, 127, 0, 108),
            (127, 127, 1, 108),
            (127, 127, 63, 108),
            (127, 127, 64, 109),
            (127, 127, 127, 109),
            (127, 127, 128, 110),
            (127, 127, 254, 111),
            (127, 127, 255, 111),
            (127, 128, 0, 112),
            (127, 128, 1, 112),
            (127, 128, 63, 112),
            (127, 128, 64, 113),
            (127, 128, 127, 113),
            (127, 128, 128, 114),
            (127, 128, 254, 115),
            (127, 128, 255, 115),
            (127, 254, 0, 124),
            (127, 254, 1, 124),
            (127, 254, 63, 124),
            (127, 254, 64, 125),
            (127, 254, 127, 125),
            (127, 254, 128, 126),
            (127, 254, 254, 127),
            (127, 254, 255, 127),
            (127, 255, 0, 124),
            (127, 255, 1, 124),
            (127, 255, 63, 124),
            (127, 255, 64, 125),
            (127, 255, 127, 125),
            (127, 255, 128, 126),
            (127, 255, 254, 127),
            (127, 255, 255, 127),
            (128, 0, 0, 128),
            (128, 0, 1, 128),
            (128, 0, 63, 128),
            (128, 0, 64, 129),
            (128, 0, 127, 129),
            (128, 0, 128, 130),
            (128, 0, 254, 131),
            (128, 0, 255, 131),
            (128, 1, 0, 128),
            (128, 1, 1, 128),
            (128, 1, 63, 128),
            (128, 1, 64, 129),
            (128, 1, 127, 129),
            (128, 1, 128, 130),
            (128, 1, 254, 131),
            (128, 1, 255, 131),
            (128, 31, 0, 128),
            (128, 31, 1, 128),
            (128, 31, 63, 128),
            (128, 31, 64, 129),
            (128, 31, 127, 129),
            (128, 31, 128, 130),
            (128, 31, 254, 131),
            (128, 31, 255, 131),
            (128, 32, 0, 132),
            (128, 32, 1, 132),
            (128, 32, 63, 132),
            (128, 32, 64, 133),
            (128, 32, 127, 133),
            (128, 32, 128, 134),
            (128, 32, 254, 135),
            (128, 32, 255, 135),
            (128, 127, 0, 140),
            (128, 127, 1, 140),
            (128, 127, 63, 140),
            (128, 127, 64, 141),
            (128, 127, 127, 141),
            (128, 127, 128, 142),
            (128, 127, 254, 143),
            (128, 127, 255, 143),
            (128, 128, 0, 144),
            (128, 128, 1, 144),
            (128, 128, 63, 144),
            (128, 128, 64, 145),
            (128, 128, 127, 145),
            (128, 128, 128, 146),
            (128, 128, 254, 147),
            (128, 128, 255, 147),
            (128, 254, 0, 156),
            (128, 254, 1, 156),
            (128, 254, 63, 156),
            (128, 254, 64, 157),
            (128, 254, 127, 157),
            (128, 254, 128, 158),
            (128, 254, 254, 159),
            (128, 254, 255, 159),
            (128, 255, 0, 156),
            (128, 255, 1, 156),
            (128, 255, 63, 156),
            (128, 255, 64, 157),
            (128, 255, 127, 157),
            (128, 255, 128, 158),
            (128, 255, 254, 159),
            (128, 255, 255, 159),
            (254, 0, 0, 224),
            (254, 0, 1, 224),
            (254, 0, 63, 224),
            (254, 0, 64, 225),
            (254, 0, 127, 225),
            (254, 0, 128, 226),
            (254, 0, 254, 227),
            (254, 0, 255, 227),
            (254, 1, 0, 224),
            (254, 1, 1, 224),
            (254, 1, 63, 224),
            (254, 1, 64, 225),
            (254, 1, 127, 225),
            (254, 1, 128, 226),
            (254, 1, 254, 227),
            (254, 1, 255, 227),
            (254, 31, 0, 224),
            (254, 31, 1, 224),
            (254, 31, 63, 224),
            (254, 31, 64, 225),
            (254, 31, 127, 225),
            (254, 31, 128, 226),
            (254, 31, 254, 227),
            (254, 31, 255, 227),
            (254, 32, 0, 228),
            (254, 32, 1, 228),
            (254, 32, 63, 228),
            (254, 32, 64, 229),
            (254, 32, 127, 229),
            (254, 32, 128, 230),
            (254, 32, 254, 231),
            (254, 32, 255, 231),
            (254, 127, 0, 236),
            (254, 127, 1, 236),
            (254, 127, 63, 236),
            (254, 127, 64, 237),
            (254, 127, 127, 237),
            (254, 127, 128, 238),
            (254, 127, 254, 239),
            (254, 127, 255, 239),
            (254, 128, 0, 240),
            (254, 128, 1, 240),
            (254, 128, 63, 240),
            (254, 128, 64, 241),
            (254, 128, 127, 241),
            (254, 128, 128, 242),
            (254, 128, 254, 243),
            (254, 128, 255, 243),
            (254, 254, 0, 252),
            (254, 254, 1, 252),
            (254, 254, 63, 252),
            (254, 254, 64, 253),
            (254, 254, 127, 253),
            (254, 254, 128, 254),
            (254, 254, 254, 255),
            (254, 254, 255, 255),
            (254, 255, 0, 252),
            (254, 255, 1, 252),
            (254, 255, 63, 252),
            (254, 255, 64, 253),
            (254, 255, 127, 253),
            (254, 255, 128, 254),
            (254, 255, 254, 255),
            (254, 255, 255, 255),
            (255, 0, 0, 224),
            (255, 0, 1, 224),
            (255, 0, 63, 224),
            (255, 0, 64, 225),
            (255, 0, 127, 225),
            (255, 0, 128, 226),
            (255, 0, 254, 227),
            (255, 0, 255, 227),
            (255, 1, 0, 224),
            (255, 1, 1, 224),
            (255, 1, 63, 224),
            (255, 1, 64, 225),
            (255, 1, 127, 225),
            (255, 1, 128, 226),
            (255, 1, 254, 227),
            (255, 1, 255, 227),
            (255, 31, 0, 224),
            (255, 31, 1, 224),
            (255, 31, 63, 224),
            (255, 31, 64, 225),
            (255, 31, 127, 225),
            (255, 31, 128, 226),
            (255, 31, 254, 227),
            (255, 31, 255, 227),
            (255, 32, 0, 228),
            (255, 32, 1, 228),
            (255, 32, 63, 228),
            (255, 32, 64, 229),
            (255, 32, 127, 229),
            (255, 32, 128, 230),
            (255, 32, 254, 231),
            (255, 32, 255, 231),
            (255, 127, 0, 236),
            (255, 127, 1, 236),
            (255, 127, 63, 236),
            (255, 127, 64, 237),
            (255, 127, 127, 237),
            (255, 127, 128, 238),
            (255, 127, 254, 239),
            (255, 127, 255, 239),
            (255, 128, 0, 240),
            (255, 128, 1, 240),
            (255, 128, 63, 240),
            (255, 128, 64, 241),
            (255, 128, 127, 241),
            (255, 128, 128, 242),
            (255, 128, 254, 243),
            (255, 128, 255, 243),
            (255, 254, 0, 252),
            (255, 254, 1, 252),
            (255, 254, 63, 252),
            (255, 254, 64, 253),
            (255, 254, 127, 253),
            (255, 254, 128, 254),
            (255, 254, 254, 255),
            (255, 254, 255, 255),
            (255, 255, 0, 252),
            (255, 255, 1, 252),
            (255, 255, 63, 252),
            (255, 255, 64, 253),
            (255, 255, 127, 253),
            (255, 255, 128, 254),
            (255, 255, 254, 255),
            (255, 255, 255, 255),
        ];

        with_fresh_scratch(1, || {
            for (r, g, b, expected) in cases {
                SCRATCH.with(|s| {
                    let mut s = s.borrow_mut();
                    s.pixels[0] = r;
                    s.pixels[1] = g;
                    s.pixels[2] = b;
                    s.pixels[3] = 255;
                });
                map_to_palette(1, 1);
                SCRATCH.with(|s| {
                    let s = s.borrow();
                    assert_eq!(s.color_idx[0], expected, "mismatch for rgb({r}, {g}, {b})");
                });
            }
        });
    }

    #[test]
    fn default_grayscale_matches_js_within_one() {
        // Generated from src/lib/ascii.ts default path (no brightness/
        // contrast/gamma adjustment). JS keeps luminance as a float through
        // quantization; this scalar path truncates to u8 immediately, which
        // can shift the result by at most 1 - verified here rather than
        // assumed. A diff > 1 would indicate a real formula mismatch.
        let cases: [(u8, u8, u8, u8); 1000] = [
            (0, 0, 0, 0),
            (0, 0, 1, 0),
            (0, 0, 2, 0),
            (0, 0, 50, 5),
            (0, 0, 51, 5),
            (0, 0, 127, 14),
            (0, 0, 128, 14),
            (0, 0, 200, 22),
            (0, 0, 254, 28),
            (0, 0, 255, 29),
            (0, 1, 0, 0),
            (0, 1, 1, 0),
            (0, 1, 2, 0),
            (0, 1, 50, 6),
            (0, 1, 51, 6),
            (0, 1, 127, 15),
            (0, 1, 128, 15),
            (0, 1, 200, 23),
            (0, 1, 254, 29),
            (0, 1, 255, 29),
            (0, 2, 0, 1),
            (0, 2, 1, 1),
            (0, 2, 2, 1),
            (0, 2, 50, 6),
            (0, 2, 51, 6),
            (0, 2, 127, 15),
            (0, 2, 128, 15),
            (0, 2, 200, 23),
            (0, 2, 254, 30),
            (0, 2, 255, 30),
            (0, 50, 0, 29),
            (0, 50, 1, 29),
            (0, 50, 2, 29),
            (0, 50, 50, 35),
            (0, 50, 51, 35),
            (0, 50, 127, 43),
            (0, 50, 128, 43),
            (0, 50, 200, 52),
            (0, 50, 254, 58),
            (0, 50, 255, 58),
            (0, 51, 0, 29),
            (0, 51, 1, 30),
            (0, 51, 2, 30),
            (0, 51, 50, 35),
            (0, 51, 51, 35),
            (0, 51, 127, 44),
            (0, 51, 128, 44),
            (0, 51, 200, 52),
            (0, 51, 254, 58),
            (0, 51, 255, 59),
            (0, 127, 0, 74),
            (0, 127, 1, 74),
            (0, 127, 2, 74),
            (0, 127, 50, 80),
            (0, 127, 51, 80),
            (0, 127, 127, 89),
            (0, 127, 128, 89),
            (0, 127, 200, 97),
            (0, 127, 254, 103),
            (0, 127, 255, 103),
            (0, 128, 0, 75),
            (0, 128, 1, 75),
            (0, 128, 2, 75),
            (0, 128, 50, 80),
            (0, 128, 51, 80),
            (0, 128, 127, 89),
            (0, 128, 128, 89),
            (0, 128, 200, 97),
            (0, 128, 254, 104),
            (0, 128, 255, 104),
            (0, 200, 0, 117),
            (0, 200, 1, 117),
            (0, 200, 2, 117),
            (0, 200, 50, 123),
            (0, 200, 51, 123),
            (0, 200, 127, 131),
            (0, 200, 128, 131),
            (0, 200, 200, 140),
            (0, 200, 254, 146),
            (0, 200, 255, 146),
            (0, 254, 0, 149),
            (0, 254, 1, 149),
            (0, 254, 2, 149),
            (0, 254, 50, 154),
            (0, 254, 51, 154),
            (0, 254, 127, 163),
            (0, 254, 128, 163),
            (0, 254, 200, 171),
            (0, 254, 254, 178),
            (0, 254, 255, 178),
            (0, 255, 0, 149),
            (0, 255, 1, 149),
            (0, 255, 2, 149),
            (0, 255, 50, 155),
            (0, 255, 51, 155),
            (0, 255, 127, 164),
            (0, 255, 128, 164),
            (0, 255, 200, 172),
            (0, 255, 254, 178),
            (0, 255, 255, 178),
            (1, 0, 0, 0),
            (1, 0, 1, 0),
            (1, 0, 2, 0),
            (1, 0, 50, 5),
            (1, 0, 51, 6),
            (1, 0, 127, 14),
            (1, 0, 128, 14),
            (1, 0, 200, 23),
            (1, 0, 254, 29),
            (1, 0, 255, 29),
            (1, 1, 0, 0),
            (1, 1, 1, 0),
            (1, 1, 2, 1),
            (1, 1, 50, 6),
            (1, 1, 51, 6),
            (1, 1, 127, 15),
            (1, 1, 128, 15),
            (1, 1, 200, 23),
            (1, 1, 254, 29),
            (1, 1, 255, 29),
            (1, 2, 0, 1),
            (1, 2, 1, 1),
            (1, 2, 2, 1),
            (1, 2, 50, 7),
            (1, 2, 51, 7),
            (1, 2, 127, 15),
            (1, 2, 128, 16),
            (1, 2, 200, 24),
            (1, 2, 254, 30),
            (1, 2, 255, 30),
            (1, 50, 0, 29),
            (1, 50, 1, 29),
            (1, 50, 2, 29),
            (1, 50, 50, 35),
            (1, 50, 51, 35),
            (1, 50, 127, 44),
            (1, 50, 128, 44),
            (1, 50, 200, 52),
            (1, 50, 254, 58),
            (1, 50, 255, 58),
            (1, 51, 0, 30),
            (1, 51, 1, 30),
            (1, 51, 2, 30),
            (1, 51, 50, 35),
            (1, 51, 51, 36),
            (1, 51, 127, 44),
            (1, 51, 128, 44),
            (1, 51, 200, 53),
            (1, 51, 254, 59),
            (1, 51, 255, 59),
            (1, 127, 0, 74),
            (1, 127, 1, 74),
            (1, 127, 2, 75),
            (1, 127, 50, 80),
            (1, 127, 51, 80),
            (1, 127, 127, 89),
            (1, 127, 128, 89),
            (1, 127, 200, 97),
            (1, 127, 254, 103),
            (1, 127, 255, 103),
            (1, 128, 0, 75),
            (1, 128, 1, 75),
            (1, 128, 2, 75),
            (1, 128, 50, 81),
            (1, 128, 51, 81),
            (1, 128, 127, 89),
            (1, 128, 128, 90),
            (1, 128, 200, 98),
            (1, 128, 254, 104),
            (1, 128, 255, 104),
            (1, 200, 0, 117),
            (1, 200, 1, 117),
            (1, 200, 2, 117),
            (1, 200, 50, 123),
            (1, 200, 51, 123),
            (1, 200, 127, 132),
            (1, 200, 128, 132),
            (1, 200, 200, 140),
            (1, 200, 254, 146),
            (1, 200, 255, 146),
            (1, 254, 0, 149),
            (1, 254, 1, 149),
            (1, 254, 2, 149),
            (1, 254, 50, 155),
            (1, 254, 51, 155),
            (1, 254, 127, 163),
            (1, 254, 128, 163),
            (1, 254, 200, 172),
            (1, 254, 254, 178),
            (1, 254, 255, 178),
            (1, 255, 0, 149),
            (1, 255, 1, 150),
            (1, 255, 2, 150),
            (1, 255, 50, 155),
            (1, 255, 51, 155),
            (1, 255, 127, 164),
            (1, 255, 128, 164),
            (1, 255, 200, 172),
            (1, 255, 254, 178),
            (1, 255, 255, 179),
            (2, 0, 0, 0),
            (2, 0, 1, 0),
            (2, 0, 2, 0),
            (2, 0, 50, 6),
            (2, 0, 51, 6),
            (2, 0, 127, 15),
            (2, 0, 128, 15),
            (2, 0, 200, 23),
            (2, 0, 254, 29),
            (2, 0, 255, 29),
            (2, 1, 0, 1),
            (2, 1, 1, 1),
            (2, 1, 2, 1),
            (2, 1, 50, 6),
            (2, 1, 51, 6),
            (2, 1, 127, 15),
            (2, 1, 128, 15),
            (2, 1, 200, 23),
            (2, 1, 254, 30),
            (2, 1, 255, 30),
            (2, 2, 0, 1),
            (2, 2, 1, 1),
            (2, 2, 2, 1),
            (2, 2, 50, 7),
            (2, 2, 51, 7),
            (2, 2, 127, 16),
            (2, 2, 128, 16),
            (2, 2, 200, 24),
            (2, 2, 254, 30),
            (2, 2, 255, 30),
            (2, 50, 0, 29),
            (2, 50, 1, 30),
            (2, 50, 2, 30),
            (2, 50, 50, 35),
            (2, 50, 51, 35),
            (2, 50, 127, 44),
            (2, 50, 128, 44),
            (2, 50, 200, 52),
            (2, 50, 254, 58),
            (2, 50, 255, 59),
            (2, 51, 0, 30),
            (2, 51, 1, 30),
            (2, 51, 2, 30),
            (2, 51, 50, 36),
            (2, 51, 51, 36),
            (2, 51, 127, 45),
            (2, 51, 128, 45),
            (2, 51, 200, 53),
            (2, 51, 254, 59),
            (2, 51, 255, 59),
            (2, 127, 0, 75),
            (2, 127, 1, 75),
            (2, 127, 2, 75),
            (2, 127, 50, 80),
            (2, 127, 51, 80),
            (2, 127, 127, 89),
            (2, 127, 128, 89),
            (2, 127, 200, 97),
            (2, 127, 254, 104),
            (2, 127, 255, 104),
            (2, 128, 0, 75),
            (2, 128, 1, 75),
            (2, 128, 2, 75),
            (2, 128, 50, 81),
            (2, 128, 51, 81),
            (2, 128, 127, 90),
            (2, 128, 128, 90),
            (2, 128, 200, 98),
            (2, 128, 254, 104),
            (2, 128, 255, 104),
            (2, 200, 0, 117),
            (2, 200, 1, 118),
            (2, 200, 2, 118),
            (2, 200, 50, 123),
            (2, 200, 51, 123),
            (2, 200, 127, 132),
            (2, 200, 128, 132),
            (2, 200, 200, 140),
            (2, 200, 254, 146),
            (2, 200, 255, 147),
            (2, 254, 0, 149),
            (2, 254, 1, 149),
            (2, 254, 2, 149),
            (2, 254, 50, 155),
            (2, 254, 51, 155),
            (2, 254, 127, 164),
            (2, 254, 128, 164),
            (2, 254, 200, 172),
            (2, 254, 254, 178),
            (2, 254, 255, 178),
            (2, 255, 0, 150),
            (2, 255, 1, 150),
            (2, 255, 2, 150),
            (2, 255, 50, 155),
            (2, 255, 51, 156),
            (2, 255, 127, 164),
            (2, 255, 128, 164),
            (2, 255, 200, 173),
            (2, 255, 254, 179),
            (2, 255, 255, 179),
            (50, 0, 0, 14),
            (50, 0, 1, 15),
            (50, 0, 2, 15),
            (50, 0, 50, 20),
            (50, 0, 51, 20),
            (50, 0, 127, 29),
            (50, 0, 128, 29),
            (50, 0, 200, 37),
            (50, 0, 254, 43),
            (50, 0, 255, 44),
            (50, 1, 0, 15),
            (50, 1, 1, 15),
            (50, 1, 2, 15),
            (50, 1, 50, 21),
            (50, 1, 51, 21),
            (50, 1, 127, 30),
            (50, 1, 128, 30),
            (50, 1, 200, 38),
            (50, 1, 254, 44),
            (50, 1, 255, 44),
            (50, 2, 0, 16),
            (50, 2, 1, 16),
            (50, 2, 2, 16),
            (50, 2, 50, 21),
            (50, 2, 51, 21),
            (50, 2, 127, 30),
            (50, 2, 128, 30),
            (50, 2, 200, 38),
            (50, 2, 254, 45),
            (50, 2, 255, 45),
            (50, 50, 0, 44),
            (50, 50, 1, 44),
            (50, 50, 2, 44),
            (50, 50, 50, 50),
            (50, 50, 51, 50),
            (50, 50, 127, 58),
            (50, 50, 128, 58),
            (50, 50, 200, 67),
            (50, 50, 254, 73),
            (50, 50, 255, 73),
            (50, 51, 0, 44),
            (50, 51, 1, 45),
            (50, 51, 2, 45),
            (50, 51, 50, 50),
            (50, 51, 51, 50),
            (50, 51, 127, 59),
            (50, 51, 128, 59),
            (50, 51, 200, 67),
            (50, 51, 254, 73),
            (50, 51, 255, 73),
            (50, 127, 0, 89),
            (50, 127, 1, 89),
            (50, 127, 2, 89),
            (50, 127, 50, 95),
            (50, 127, 51, 95),
            (50, 127, 127, 103),
            (50, 127, 128, 104),
            (50, 127, 200, 112),
            (50, 127, 254, 118),
            (50, 127, 255, 118),
            (50, 128, 0, 90),
            (50, 128, 1, 90),
            (50, 128, 2, 90),
            (50, 128, 50, 95),
            (50, 128, 51, 95),
            (50, 128, 127, 104),
            (50, 128, 128, 104),
            (50, 128, 200, 112),
            (50, 128, 254, 119),
            (50, 128, 255, 119),
            (50, 200, 0, 132),
            (50, 200, 1, 132),
            (50, 200, 2, 132),
            (50, 200, 50, 138),
            (50, 200, 51, 138),
            (50, 200, 127, 146),
            (50, 200, 128, 146),
            (50, 200, 200, 155),
            (50, 200, 254, 161),
            (50, 200, 255, 161),
            (50, 254, 0, 164),
            (50, 254, 1, 164),
            (50, 254, 2, 164),
            (50, 254, 50, 169),
            (50, 254, 51, 169),
            (50, 254, 127, 178),
            (50, 254, 128, 178),
            (50, 254, 200, 186),
            (50, 254, 254, 193),
            (50, 254, 255, 193),
            (50, 255, 0, 164),
            (50, 255, 1, 164),
            (50, 255, 2, 164),
            (50, 255, 50, 170),
            (50, 255, 51, 170),
            (50, 255, 127, 179),
            (50, 255, 128, 179),
            (50, 255, 200, 187),
            (50, 255, 254, 193),
            (50, 255, 255, 193),
            (51, 0, 0, 15),
            (51, 0, 1, 15),
            (51, 0, 2, 15),
            (51, 0, 50, 20),
            (51, 0, 51, 21),
            (51, 0, 127, 29),
            (51, 0, 128, 29),
            (51, 0, 200, 38),
            (51, 0, 254, 44),
            (51, 0, 255, 44),
            (51, 1, 0, 15),
            (51, 1, 1, 15),
            (51, 1, 2, 16),
            (51, 1, 50, 21),
            (51, 1, 51, 21),
            (51, 1, 127, 30),
            (51, 1, 128, 30),
            (51, 1, 200, 38),
            (51, 1, 254, 44),
            (51, 1, 255, 44),
            (51, 2, 0, 16),
            (51, 2, 1, 16),
            (51, 2, 2, 16),
            (51, 2, 50, 22),
            (51, 2, 51, 22),
            (51, 2, 127, 30),
            (51, 2, 128, 31),
            (51, 2, 200, 39),
            (51, 2, 254, 45),
            (51, 2, 255, 45),
            (51, 50, 0, 44),
            (51, 50, 1, 44),
            (51, 50, 2, 44),
            (51, 50, 50, 50),
            (51, 50, 51, 50),
            (51, 50, 127, 59),
            (51, 50, 128, 59),
            (51, 50, 200, 67),
            (51, 50, 254, 73),
            (51, 50, 255, 73),
            (51, 51, 0, 45),
            (51, 51, 1, 45),
            (51, 51, 2, 45),
            (51, 51, 50, 50),
            (51, 51, 51, 50),
            (51, 51, 127, 59),
            (51, 51, 128, 59),
            (51, 51, 200, 67),
            (51, 51, 254, 74),
            (51, 51, 255, 74),
            (51, 127, 0, 89),
            (51, 127, 1, 89),
            (51, 127, 2, 90),
            (51, 127, 50, 95),
            (51, 127, 51, 95),
            (51, 127, 127, 104),
            (51, 127, 128, 104),
            (51, 127, 200, 112),
            (51, 127, 254, 118),
            (51, 127, 255, 118),
            (51, 128, 0, 90),
            (51, 128, 1, 90),
            (51, 128, 2, 90),
            (51, 128, 50, 96),
            (51, 128, 51, 96),
            (51, 128, 127, 104),
            (51, 128, 128, 104),
            (51, 128, 200, 113),
            (51, 128, 254, 119),
            (51, 128, 255, 119),
            (51, 200, 0, 132),
            (51, 200, 1, 132),
            (51, 200, 2, 132),
            (51, 200, 50, 138),
            (51, 200, 51, 138),
            (51, 200, 127, 147),
            (51, 200, 128, 147),
            (51, 200, 200, 155),
            (51, 200, 254, 161),
            (51, 200, 255, 161),
            (51, 254, 0, 164),
            (51, 254, 1, 164),
            (51, 254, 2, 164),
            (51, 254, 50, 170),
            (51, 254, 51, 170),
            (51, 254, 127, 178),
            (51, 254, 128, 178),
            (51, 254, 200, 187),
            (51, 254, 254, 193),
            (51, 254, 255, 193),
            (51, 255, 0, 164),
            (51, 255, 1, 165),
            (51, 255, 2, 165),
            (51, 255, 50, 170),
            (51, 255, 51, 170),
            (51, 255, 127, 179),
            (51, 255, 128, 179),
            (51, 255, 200, 187),
            (51, 255, 254, 193),
            (51, 255, 255, 194),
            (127, 0, 0, 37),
            (127, 0, 1, 38),
            (127, 0, 2, 38),
            (127, 0, 50, 43),
            (127, 0, 51, 43),
            (127, 0, 127, 52),
            (127, 0, 128, 52),
            (127, 0, 200, 60),
            (127, 0, 254, 66),
            (127, 0, 255, 67),
            (127, 1, 0, 38),
            (127, 1, 1, 38),
            (127, 1, 2, 38),
            (127, 1, 50, 44),
            (127, 1, 51, 44),
            (127, 1, 127, 53),
            (127, 1, 128, 53),
            (127, 1, 200, 61),
            (127, 1, 254, 67),
            (127, 1, 255, 67),
            (127, 2, 0, 39),
            (127, 2, 1, 39),
            (127, 2, 2, 39),
            (127, 2, 50, 44),
            (127, 2, 51, 44),
            (127, 2, 127, 53),
            (127, 2, 128, 53),
            (127, 2, 200, 61),
            (127, 2, 254, 68),
            (127, 2, 255, 68),
            (127, 50, 0, 67),
            (127, 50, 1, 67),
            (127, 50, 2, 67),
            (127, 50, 50, 73),
            (127, 50, 51, 73),
            (127, 50, 127, 81),
            (127, 50, 128, 81),
            (127, 50, 200, 90),
            (127, 50, 254, 96),
            (127, 50, 255, 96),
            (127, 51, 0, 67),
            (127, 51, 1, 68),
            (127, 51, 2, 68),
            (127, 51, 50, 73),
            (127, 51, 51, 73),
            (127, 51, 127, 82),
            (127, 51, 128, 82),
            (127, 51, 200, 90),
            (127, 51, 254, 96),
            (127, 51, 255, 96),
            (127, 127, 0, 112),
            (127, 127, 1, 112),
            (127, 127, 2, 112),
            (127, 127, 50, 118),
            (127, 127, 51, 118),
            (127, 127, 127, 126),
            (127, 127, 128, 127),
            (127, 127, 200, 135),
            (127, 127, 254, 141),
            (127, 127, 255, 141),
            (127, 128, 0, 113),
            (127, 128, 1, 113),
            (127, 128, 2, 113),
            (127, 128, 50, 118),
            (127, 128, 51, 118),
            (127, 128, 127, 127),
            (127, 128, 128, 127),
            (127, 128, 200, 135),
            (127, 128, 254, 142),
            (127, 128, 255, 142),
            (127, 200, 0, 155),
            (127, 200, 1, 155),
            (127, 200, 2, 155),
            (127, 200, 50, 161),
            (127, 200, 51, 161),
            (127, 200, 127, 169),
            (127, 200, 128, 169),
            (127, 200, 200, 178),
            (127, 200, 254, 184),
            (127, 200, 255, 184),
            (127, 254, 0, 187),
            (127, 254, 1, 187),
            (127, 254, 2, 187),
            (127, 254, 50, 192),
            (127, 254, 51, 192),
            (127, 254, 127, 201),
            (127, 254, 128, 201),
            (127, 254, 200, 209),
            (127, 254, 254, 216),
            (127, 254, 255, 216),
            (127, 255, 0, 187),
            (127, 255, 1, 187),
            (127, 255, 2, 187),
            (127, 255, 50, 193),
            (127, 255, 51, 193),
            (127, 255, 127, 202),
            (127, 255, 128, 202),
            (127, 255, 200, 210),
            (127, 255, 254, 216),
            (127, 255, 255, 216),
            (128, 0, 0, 38),
            (128, 0, 1, 38),
            (128, 0, 2, 38),
            (128, 0, 50, 43),
            (128, 0, 51, 44),
            (128, 0, 127, 52),
            (128, 0, 128, 52),
            (128, 0, 200, 61),
            (128, 0, 254, 67),
            (128, 0, 255, 67),
            (128, 1, 0, 38),
            (128, 1, 1, 38),
            (128, 1, 2, 39),
            (128, 1, 50, 44),
            (128, 1, 51, 44),
            (128, 1, 127, 53),
            (128, 1, 128, 53),
            (128, 1, 200, 61),
            (128, 1, 254, 67),
            (128, 1, 255, 67),
            (128, 2, 0, 39),
            (128, 2, 1, 39),
            (128, 2, 2, 39),
            (128, 2, 50, 45),
            (128, 2, 51, 45),
            (128, 2, 127, 53),
            (128, 2, 128, 54),
            (128, 2, 200, 62),
            (128, 2, 254, 68),
            (128, 2, 255, 68),
            (128, 50, 0, 67),
            (128, 50, 1, 67),
            (128, 50, 2, 67),
            (128, 50, 50, 73),
            (128, 50, 51, 73),
            (128, 50, 127, 82),
            (128, 50, 128, 82),
            (128, 50, 200, 90),
            (128, 50, 254, 96),
            (128, 50, 255, 96),
            (128, 51, 0, 68),
            (128, 51, 1, 68),
            (128, 51, 2, 68),
            (128, 51, 50, 73),
            (128, 51, 51, 74),
            (128, 51, 127, 82),
            (128, 51, 128, 82),
            (128, 51, 200, 91),
            (128, 51, 254, 97),
            (128, 51, 255, 97),
            (128, 127, 0, 112),
            (128, 127, 1, 112),
            (128, 127, 2, 113),
            (128, 127, 50, 118),
            (128, 127, 51, 118),
            (128, 127, 127, 127),
            (128, 127, 128, 127),
            (128, 127, 200, 135),
            (128, 127, 254, 141),
            (128, 127, 255, 141),
            (128, 128, 0, 113),
            (128, 128, 1, 113),
            (128, 128, 2, 113),
            (128, 128, 50, 119),
            (128, 128, 51, 119),
            (128, 128, 127, 127),
            (128, 128, 128, 127),
            (128, 128, 200, 136),
            (128, 128, 254, 142),
            (128, 128, 255, 142),
            (128, 200, 0, 155),
            (128, 200, 1, 155),
            (128, 200, 2, 155),
            (128, 200, 50, 161),
            (128, 200, 51, 161),
            (128, 200, 127, 170),
            (128, 200, 128, 170),
            (128, 200, 200, 178),
            (128, 200, 254, 184),
            (128, 200, 255, 184),
            (128, 254, 0, 187),
            (128, 254, 1, 187),
            (128, 254, 2, 187),
            (128, 254, 50, 193),
            (128, 254, 51, 193),
            (128, 254, 127, 201),
            (128, 254, 128, 201),
            (128, 254, 200, 210),
            (128, 254, 254, 216),
            (128, 254, 255, 216),
            (128, 255, 0, 187),
            (128, 255, 1, 188),
            (128, 255, 2, 188),
            (128, 255, 50, 193),
            (128, 255, 51, 193),
            (128, 255, 127, 202),
            (128, 255, 128, 202),
            (128, 255, 200, 210),
            (128, 255, 254, 216),
            (128, 255, 255, 217),
            (200, 0, 0, 59),
            (200, 0, 1, 59),
            (200, 0, 2, 60),
            (200, 0, 50, 65),
            (200, 0, 51, 65),
            (200, 0, 127, 74),
            (200, 0, 128, 74),
            (200, 0, 200, 82),
            (200, 0, 254, 88),
            (200, 0, 255, 88),
            (200, 1, 0, 60),
            (200, 1, 1, 60),
            (200, 1, 2, 60),
            (200, 1, 50, 66),
            (200, 1, 51, 66),
            (200, 1, 127, 74),
            (200, 1, 128, 74),
            (200, 1, 200, 83),
            (200, 1, 254, 89),
            (200, 1, 255, 89),
            (200, 2, 0, 60),
            (200, 2, 1, 61),
            (200, 2, 2, 61),
            (200, 2, 50, 66),
            (200, 2, 51, 66),
            (200, 2, 127, 75),
            (200, 2, 128, 75),
            (200, 2, 200, 83),
            (200, 2, 254, 89),
            (200, 2, 255, 90),
            (200, 50, 0, 89),
            (200, 50, 1, 89),
            (200, 50, 2, 89),
            (200, 50, 50, 94),
            (200, 50, 51, 94),
            (200, 50, 127, 103),
            (200, 50, 128, 103),
            (200, 50, 200, 111),
            (200, 50, 254, 118),
            (200, 50, 255, 118),
            (200, 51, 0, 89),
            (200, 51, 1, 89),
            (200, 51, 2, 89),
            (200, 51, 50, 95),
            (200, 51, 51, 95),
            (200, 51, 127, 104),
            (200, 51, 128, 104),
            (200, 51, 200, 112),
            (200, 51, 254, 118),
            (200, 51, 255, 118),
            (200, 127, 0, 134),
            (200, 127, 1, 134),
            (200, 127, 2, 134),
            (200, 127, 50, 140),
            (200, 127, 51, 140),
            (200, 127, 127, 148),
            (200, 127, 128, 148),
            (200, 127, 200, 157),
            (200, 127, 254, 163),
            (200, 127, 255, 163),
            (200, 128, 0, 134),
            (200, 128, 1, 135),
            (200, 128, 2, 135),
            (200, 128, 50, 140),
            (200, 128, 51, 140),
            (200, 128, 127, 149),
            (200, 128, 128, 149),
            (200, 128, 200, 157),
            (200, 128, 254, 163),
            (200, 128, 255, 164),
            (200, 200, 0, 177),
            (200, 200, 1, 177),
            (200, 200, 2, 177),
            (200, 200, 50, 182),
            (200, 200, 51, 183),
            (200, 200, 127, 191),
            (200, 200, 128, 191),
            (200, 200, 200, 200),
            (200, 200, 254, 206),
            (200, 200, 255, 206),
            (200, 254, 0, 208),
            (200, 254, 1, 209),
            (200, 254, 2, 209),
            (200, 254, 50, 214),
            (200, 254, 51, 214),
            (200, 254, 127, 223),
            (200, 254, 128, 223),
            (200, 254, 200, 231),
            (200, 254, 254, 237),
            (200, 254, 255, 237),
            (200, 255, 0, 209),
            (200, 255, 1, 209),
            (200, 255, 2, 209),
            (200, 255, 50, 215),
            (200, 255, 51, 215),
            (200, 255, 127, 223),
            (200, 255, 128, 224),
            (200, 255, 200, 232),
            (200, 255, 254, 238),
            (200, 255, 255, 238),
            (254, 0, 0, 75),
            (254, 0, 1, 76),
            (254, 0, 2, 76),
            (254, 0, 50, 81),
            (254, 0, 51, 81),
            (254, 0, 127, 90),
            (254, 0, 128, 90),
            (254, 0, 200, 98),
            (254, 0, 254, 104),
            (254, 0, 255, 105),
            (254, 1, 0, 76),
            (254, 1, 1, 76),
            (254, 1, 2, 76),
            (254, 1, 50, 82),
            (254, 1, 51, 82),
            (254, 1, 127, 91),
            (254, 1, 128, 91),
            (254, 1, 200, 99),
            (254, 1, 254, 105),
            (254, 1, 255, 105),
            (254, 2, 0, 77),
            (254, 2, 1, 77),
            (254, 2, 2, 77),
            (254, 2, 50, 82),
            (254, 2, 51, 82),
            (254, 2, 127, 91),
            (254, 2, 128, 91),
            (254, 2, 200, 99),
            (254, 2, 254, 106),
            (254, 2, 255, 106),
            (254, 50, 0, 105),
            (254, 50, 1, 105),
            (254, 50, 2, 105),
            (254, 50, 50, 110),
            (254, 50, 51, 111),
            (254, 50, 127, 119),
            (254, 50, 128, 119),
            (254, 50, 200, 128),
            (254, 50, 254, 134),
            (254, 50, 255, 134),
            (254, 51, 0, 105),
            (254, 51, 1, 105),
            (254, 51, 2, 106),
            (254, 51, 50, 111),
            (254, 51, 51, 111),
            (254, 51, 127, 120),
            (254, 51, 128, 120),
            (254, 51, 200, 128),
            (254, 51, 254, 134),
            (254, 51, 255, 134),
            (254, 127, 0, 150),
            (254, 127, 1, 150),
            (254, 127, 2, 150),
            (254, 127, 50, 156),
            (254, 127, 51, 156),
            (254, 127, 127, 164),
            (254, 127, 128, 165),
            (254, 127, 200, 173),
            (254, 127, 254, 179),
            (254, 127, 255, 179),
            (254, 128, 0, 151),
            (254, 128, 1, 151),
            (254, 128, 2, 151),
            (254, 128, 50, 156),
            (254, 128, 51, 156),
            (254, 128, 127, 165),
            (254, 128, 128, 165),
            (254, 128, 200, 173),
            (254, 128, 254, 180),
            (254, 128, 255, 180),
            (254, 200, 0, 193),
            (254, 200, 1, 193),
            (254, 200, 2, 193),
            (254, 200, 50, 199),
            (254, 200, 51, 199),
            (254, 200, 127, 207),
            (254, 200, 128, 207),
            (254, 200, 200, 216),
            (254, 200, 254, 222),
            (254, 200, 255, 222),
            (254, 254, 0, 225),
            (254, 254, 1, 225),
            (254, 254, 2, 225),
            (254, 254, 50, 230),
            (254, 254, 51, 230),
            (254, 254, 127, 239),
            (254, 254, 128, 239),
            (254, 254, 200, 247),
            (254, 254, 254, 253),
            (254, 254, 255, 254),
            (254, 255, 0, 225),
            (254, 255, 1, 225),
            (254, 255, 2, 225),
            (254, 255, 50, 231),
            (254, 255, 51, 231),
            (254, 255, 127, 240),
            (254, 255, 128, 240),
            (254, 255, 200, 248),
            (254, 255, 254, 254),
            (254, 255, 255, 254),
            (255, 0, 0, 76),
            (255, 0, 1, 76),
            (255, 0, 2, 76),
            (255, 0, 50, 81),
            (255, 0, 51, 82),
            (255, 0, 127, 90),
            (255, 0, 128, 90),
            (255, 0, 200, 99),
            (255, 0, 254, 105),
            (255, 0, 255, 105),
            (255, 1, 0, 76),
            (255, 1, 1, 76),
            (255, 1, 2, 77),
            (255, 1, 50, 82),
            (255, 1, 51, 82),
            (255, 1, 127, 91),
            (255, 1, 128, 91),
            (255, 1, 200, 99),
            (255, 1, 254, 105),
            (255, 1, 255, 105),
            (255, 2, 0, 77),
            (255, 2, 1, 77),
            (255, 2, 2, 77),
            (255, 2, 50, 83),
            (255, 2, 51, 83),
            (255, 2, 127, 91),
            (255, 2, 128, 92),
            (255, 2, 200, 100),
            (255, 2, 254, 106),
            (255, 2, 255, 106),
            (255, 50, 0, 105),
            (255, 50, 1, 105),
            (255, 50, 2, 105),
            (255, 50, 50, 111),
            (255, 50, 51, 111),
            (255, 50, 127, 120),
            (255, 50, 128, 120),
            (255, 50, 200, 128),
            (255, 50, 254, 134),
            (255, 50, 255, 134),
            (255, 51, 0, 106),
            (255, 51, 1, 106),
            (255, 51, 2, 106),
            (255, 51, 50, 111),
            (255, 51, 51, 111),
            (255, 51, 127, 120),
            (255, 51, 128, 120),
            (255, 51, 200, 128),
            (255, 51, 254, 135),
            (255, 51, 255, 135),
            (255, 127, 0, 150),
            (255, 127, 1, 150),
            (255, 127, 2, 151),
            (255, 127, 50, 156),
            (255, 127, 51, 156),
            (255, 127, 127, 165),
            (255, 127, 128, 165),
            (255, 127, 200, 173),
            (255, 127, 254, 179),
            (255, 127, 255, 179),
            (255, 128, 0, 151),
            (255, 128, 1, 151),
            (255, 128, 2, 151),
            (255, 128, 50, 157),
            (255, 128, 51, 157),
            (255, 128, 127, 165),
            (255, 128, 128, 165),
            (255, 128, 200, 174),
            (255, 128, 254, 180),
            (255, 128, 255, 180),
            (255, 200, 0, 193),
            (255, 200, 1, 193),
            (255, 200, 2, 193),
            (255, 200, 50, 199),
            (255, 200, 51, 199),
            (255, 200, 127, 208),
            (255, 200, 128, 208),
            (255, 200, 200, 216),
            (255, 200, 254, 222),
            (255, 200, 255, 222),
            (255, 254, 0, 225),
            (255, 254, 1, 225),
            (255, 254, 2, 225),
            (255, 254, 50, 231),
            (255, 254, 51, 231),
            (255, 254, 127, 239),
            (255, 254, 128, 239),
            (255, 254, 200, 248),
            (255, 254, 254, 254),
            (255, 254, 255, 254),
            (255, 255, 0, 225),
            (255, 255, 1, 226),
            (255, 255, 2, 226),
            (255, 255, 50, 231),
            (255, 255, 51, 231),
            (255, 255, 127, 240),
            (255, 255, 128, 240),
            (255, 255, 200, 248),
            (255, 255, 254, 254),
            (255, 255, 255, 255),
        ];

        with_fresh_scratch(1, || {
            for (r, g, b, expected) in cases {
                SCRATCH.with(|s| {
                    let mut s = s.borrow_mut();
                    s.pixels[0] = r;
                    s.pixels[1] = g;
                    s.pixels[2] = b;
                    s.pixels[3] = 255;
                });
                process_pipeline(1, 1, 0.0, 1.0, 1.0, false);
                SCRATCH.with(|s| {
                    let s = s.borrow();
                    let got = s.gray[0];
                    let diff = (got as i32 - expected as i32).abs();
                    assert!(diff <= 1, "grayscale mismatch for rgb({r}, {g}, {b}): got {got}, js gave {expected}");
                });
            }
        });
    }
}
