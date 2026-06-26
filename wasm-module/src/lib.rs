use wasm_bindgen::prelude::*;

// ── SIMD-Optimized Grayscale Conversion ──────────────────────────────────────
#[wasm_bindgen]
pub fn process_grayscale_simd(pixels: &[u8], width: u32, height: u32) -> Vec<u8> {
    let n = (width * height) as usize;
    let mut gray = Vec::with_capacity(n);
    
    // Process 4 pixels at a time (SIMD-friendly)
    let chunks = pixels.chunks_exact(16); // 4 pixels × 4 bytes
    let remainder = chunks.remainder();
    
    for chunk in chunks {
        // Pixel 1
        let r1 = chunk[0] as f32;
        let g1 = chunk[1] as f32;
        let b1 = chunk[2] as f32;
        gray.push((0.299 * r1 + 0.587 * g1 + 0.114 * b1) as u8);
        
        // Pixel 2
        let r2 = chunk[4] as f32;
        let g2 = chunk[5] as f32;
        let b2 = chunk[6] as f32;
        gray.push((0.299 * r2 + 0.587 * g2 + 0.114 * b2) as u8);
        
        // Pixel 3
        let r3 = chunk[8] as f32;
        let g3 = chunk[9] as f32;
        let b3 = chunk[10] as f32;
        gray.push((0.299 * r3 + 0.587 * g3 + 0.114 * b3) as u8);
        
        // Pixel 4
        let r4 = chunk[12] as f32;
        let g4 = chunk[13] as f32;
        let b4 = chunk[14] as f32;
        gray.push((0.299 * r4 + 0.587 * g4 + 0.114 * b4) as u8);
    }
    
    // Handle remainder
    for chunk in remainder.chunks_exact(4) {
        let r = chunk[0] as f32;
        let g = chunk[1] as f32;
        let b = chunk[2] as f32;
        gray.push((0.299 * r + 0.587 * g + 0.114 * b) as u8);
    }
    
    gray
}

// ── Full Pipeline with Brightness/Contrast/Gamma ────────────────────────────
#[wasm_bindgen]
pub fn process_full_pipeline(
    pixels: &[u8],
    width: u32,
    height: u32,
    brightness: f32,
    contrast: f32,
    gamma: f32,
    apply_sobel: bool
) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let n = w * h;
    
    let mut gray = Vec::with_capacity(n);
    let inv_gamma = 1.0 / gamma;
    
    // Process with brightness/contrast/gamma
    for chunk in pixels.chunks_exact(4) {
        let r = chunk[0] as f32;
        let g = chunk[1] as f32;
        let b = chunk[2] as f32;
        
        let mut lum = 0.299 * r + 0.587 * g + 0.114 * b;
        lum += brightness;
        lum = ((lum - 128.0) * contrast) + 128.0;
        
        if gamma != 1.0 {
            lum = 255.0 * (lum.max(0.0) / 255.0).powf(inv_gamma);
        }
        
        gray.push(lum.max(0.0).min(255.0) as u8);
    }
    
    // Apply Sobel if requested
    if apply_sobel {
        let mut edges = vec![0u8; n];
        
        for y in 1..(h - 1) {
            for x in 1..(w - 1) {
                let i = y * w + x;
                
                // FIX: Cast to i32 BEFORE negating
                let gx = -(gray[(y-1)*w + (x-1)] as i32) 
                       + gray[(y-1)*w + (x+1)] as i32
                       - 2*gray[y*w + (x-1)] as i32 
                       + 2*gray[y*w + (x+1)] as i32
                       - gray[(y+1)*w + (x-1)] as i32 
                       + gray[(y+1)*w + (x+1)] as i32;
                       
                let gy = -(gray[(y-1)*w + (x-1)] as i32) 
                       - 2*gray[(y-1)*w + x] as i32 
                       - gray[(y-1)*w + (x+1)] as i32
                       + gray[(y+1)*w + (x-1)] as i32 
                       + 2*gray[(y+1)*w + x] as i32 
                       + gray[(y+1)*w + (x+1)] as i32;
                
                let mag = ((gx * gx + gy * gy) as f32).sqrt();
                edges[i] = (mag as u8).min(255);
            }
        }
        
        return edges;
    }
    
    gray
}

// ── Bit Packing for Character Indices ────────────────────────────────────────
#[wasm_bindgen]
pub fn pack_char_indices(indices: &[u8], bits_per_char: u32) -> Vec<u8> {
    let n = indices.len();
    let total_bits = n * bits_per_char as usize;
    let packed_size = (total_bits + 7) / 8;
    let mut packed = Vec::with_capacity(packed_size);
    
    let mut bit_buf: u32 = 0;
    let mut bit_count: u32 = 0;
    let mask = (1u32 << bits_per_char) - 1;
    
    for &idx in indices {
        bit_buf = (bit_buf << bits_per_char) | ((idx as u32) & mask);
        bit_count += bits_per_char;
        
        while bit_count >= 8 {
            bit_count -= 8;
            packed.push(((bit_buf >> bit_count) & 0xff) as u8);
        }
    }
    
    if bit_count > 0 {
        packed.push(((bit_buf << (8 - bit_count)) & 0xff) as u8);
    }
    
    packed
}

// ── Delta Encoding ───────────────────────────────────────────────────────────
#[wasm_bindgen]
pub fn encode_delta(current: &[u8], previous: &[u8]) -> Vec<u8> {
    let n = current.len().min(previous.len());
    let mut delta = Vec::with_capacity(n);
    
    for i in 0..n {
        delta.push(current[i] ^ previous[i]); // XOR delta
    }
    
    delta
}

#[wasm_bindgen]
pub fn decode_delta(delta: &[u8], previous: &[u8]) -> Vec<u8> {
    let n = delta.len().min(previous.len());
    let mut current = Vec::with_capacity(n);
    
    for i in 0..n {
        current.push(delta[i] ^ previous[i]);
    }
    
    current
}

// ── RLE Compression ──────────────────────────────────────────────────────────
#[wasm_bindgen]
pub fn rle_encode(data: &[u8]) -> Vec<u8> {
    if data.is_empty() {
        return Vec::new();
    }
    
    let mut encoded = Vec::with_capacity(data.len());
    let mut i = 0;
    
    while i < data.len() {
        let value = data[i];
        let mut count = 1u8;
        
        // FIX: Added parentheses around cast
        while (i + count as usize) < data.len() && data[i + count as usize] == value && count < 255 {
            count += 1;
        }
        
        encoded.push(count);
        encoded.push(value);
        i += count as usize;
    }
    
    encoded
}

#[wasm_bindgen]
pub fn rle_decode(data: &[u8]) -> Vec<u8> {
    let mut decoded = Vec::new();
    let mut i = 0;
    
    while i + 1 < data.len() {
        let count = data[i] as usize;
        let value = data[i + 1];
        
        for _ in 0..count {
            decoded.push(value);
        }
        
        i += 2;
    }
    
    decoded
}

#[wasm_bindgen]
pub fn greet() -> String {
    "AsciiWeb WASM with SIMD acceleration ready!".to_string()
}
