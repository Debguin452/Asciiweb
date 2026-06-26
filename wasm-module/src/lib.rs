use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn greet() -> String {
    "Hello from Rust WASM! AsciiWeb is accelerated.".to_string()
}

// Complete pipeline with color extraction - returns flat array: [gray...][r...][g...][b...]
#[wasm_bindgen]
pub fn process_full_pipeline_with_color(
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
    
    // Use separate vectors to avoid borrow checker issues
    let mut gray = Vec::with_capacity(n);
    let mut r_out = Vec::with_capacity(n);
    let mut g_out = Vec::with_capacity(n);
    let mut b_out = Vec::with_capacity(n);
    
    let inv_gamma = 1.0 / gamma;
    
    // Process all pixels
    for i in (0..pixels.len()).step_by(4) {
        let r = pixels[i] as f32;
        let g = pixels[i + 1] as f32;
        let b = pixels[i + 2] as f32;
        
        // Store color
        r_out.push(pixels[i]);
        g_out.push(pixels[i + 1]);
        b_out.push(pixels[i + 2]);
        
        // Luminance with brightness/contrast/gamma
        let mut lum = 0.299 * r + 0.587 * g + 0.114 * b;
        lum += brightness;
        lum = ((lum - 128.0) * contrast) + 128.0;
        
        if gamma != 1.0 {
            lum = 255.0 * (lum.max(0.0) / 255.0).powf(inv_gamma);
        }
        
        gray.push((lum.max(0.0).min(255.0)) as u8);
    }
    
    // Apply Sobel edge detection if requested
    if apply_sobel {
        let mut edges = vec![0u8; n];
        
        for y in 1..(h - 1) {
            for x in 1..(w - 1) {
                let i = y * w + x;
                
                let gx = -(gray[(y-1)*w + (x-1)] as i32) + (gray[(y-1)*w + (x+1)] as i32)
                       - 2 * (gray[y*w + (x-1)] as i32) + 2 * (gray[y*w + (x+1)] as i32)
                       - (gray[(y+1)*w + (x-1)] as i32) + (gray[(y+1)*w + (x+1)] as i32);
                       
                let gy = -(gray[(y-1)*w + (x-1)] as i32) - 2 * (gray[(y-1)*w + x] as i32) - (gray[(y-1)*w + (x+1)] as i32)
                       + (gray[(y+1)*w + (x-1)] as i32) + 2 * (gray[(y+1)*w + x] as i32) + (gray[(y+1)*w + (x+1)] as i32);
                
                let mag = ((gx * gx + gy * gy) as f32).sqrt();
                edges[i] = (mag as u8).min(255);
            }
        }
        
        gray = edges;
    }
    
    // Concatenate all results: [gray][r][g][b]
    let mut output = Vec::with_capacity(n * 4);
    output.extend_from_slice(&gray);
    output.extend_from_slice(&r_out);
    output.extend_from_slice(&g_out);
    output.extend_from_slice(&b_out);
    
    output
}

// Fast grayscale only (no color)
#[wasm_bindgen]
pub fn process_grayscale(
    pixels: &[u8],
    width: u32,
    height: u32,
    brightness: f32,
    contrast: f32,
    gamma: f32
) -> Vec<u8> {
    let n = (width * height) as usize;
    let mut gray = Vec::with_capacity(n);
    let inv_gamma = 1.0 / gamma;
    
    for i in (0..pixels.len()).step_by(4) {
        let r = pixels[i] as f32;
        let g = pixels[i + 1] as f32;
        let b = pixels[i + 2] as f32;
        
        let mut lum = 0.299 * r + 0.587 * g + 0.114 * b;
        lum += brightness;
        lum = ((lum - 128.0) * contrast) + 128.0;
        
        if gamma != 1.0 {
            lum = 255.0 * (lum.max(0.0) / 255.0).powf(inv_gamma);
        }
        
        gray.push((lum.max(0.0).min(255.0)) as u8);
    }
    
    gray
}

// Fast Sobel edge detection
#[wasm_bindgen]
pub fn sobel_edge(gray: &[u8], width: u32, height: u32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let mut edges = vec![0u8; w * h];

    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let i = y * w + x;
            
            let gx = -(gray[(y-1)*w + (x-1)] as i32) + (gray[(y-1)*w + (x+1)] as i32)
                   - 2 * (gray[y*w + (x-1)] as i32) + 2 * (gray[y*w + (x+1)] as i32)
                   - (gray[(y+1)*w + (x-1)] as i32) + (gray[(y+1)*w + (x+1)] as i32);
                   
            let gy = -(gray[(y-1)*w + (x-1)] as i32) - 2 * (gray[(y-1)*w + x] as i32) - (gray[(y-1)*w + (x+1)] as i32)
                   + (gray[(y+1)*w + (x-1)] as i32) + 2 * (gray[(y+1)*w + x] as i32) + (gray[(y+1)*w + (x+1)] as i32);
            
            let mag = ((gx * gx + gy * gy) as f32).sqrt();
            edges[i] = (mag as u8).min(255);
        }
    }
    edges
}
