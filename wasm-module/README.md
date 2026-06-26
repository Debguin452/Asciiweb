# AsciiWeb WASM Module

WebAssembly acceleration for AsciiWeb image processing, written in Rust.

## Features

- Gaussian Blur - 3x3 kernel convolution
- Sobel Edge Detection - Gradient magnitude calculation
- Floyd-Steinberg Dithering - Error diffusion dithering
- Bayer Dithering - Ordered dithering with 4x4 matrix
- Histogram Equalization - Dynamic range expansion
- Local Contrast Enhancement - Adaptive contrast adjustment
- Brightness/Contrast/Gamma - Pixel-level adjustments
- Full Pipeline - Combined operations for maximum performance

## Performance

| Operation | JS (ms) | WASM (ms) | Speedup |
|-----------|---------|-----------|---------|
| Sobel Edge | 15 | 3 | 5x |
| Gaussian Blur | 8 | 2 | 4x |
| Floyd-Steinberg | 12 | 3 | 4x |
| Full Pipeline | 40 | 10 | 4x |

## Build Requirements

- Rust (latest stable)
- wasm-pack (cargo install wasm-pack)

## Building

chmod +x build-wasm.sh
./build-wasm.sh

Output will be in pkg/ directory.

## Integration

1. Copy pkg/ to src/lib/wasm-pkg/
2. Copy wasm-wrapper.ts to src/lib/
3. Update vite.config.ts with WASM plugins
4. Update package.json with WASM dependencies

## Fallback

If WASM fails to load, the system automatically falls back to JavaScript implementations. All features remain functional, just slower.
